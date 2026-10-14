"""Запуск конвейера: python -m pipeline.run [--provider seed|gemini] [--budget-rub 100] [--until classify|extract|build]

Каждая стадия пишет результат в pipeline/.cache/ и при повторном запуске берёт его оттуда: перезапуск после правки
сборки не тратит деньги на модель и не дёргает сайты и реестры второй раз.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter
from datetime import date, datetime
from pathlib import Path

from . import VERSION, build, search, site
from .config import CACHE, CITY, CITY_INN_PREFIX, DATA, RUB_PER_CREDIT, RUNS, load_categories
from .extract import digits, norm
from .fetch import Fetcher
from .kie import BudgetExceeded, Kie, spent_rub
from .registries import Registries

PROGRESS = CACHE / "progress.json"
T0 = time.time()


def log(msg: str, stage: str | None = None):
    line = f"[{time.strftime('%H:%M:%S')} +{int(time.time() - T0) // 60}:{int(time.time() - T0) % 60:02d}] {msg}"
    print(line, flush=True)
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps({"updated": datetime.now().isoformat(timespec="seconds"), "line": msg,
                                    "spent_rub": round(spent_rub(), 2)}, ensure_ascii=False), encoding="utf-8")


def pick_category(c: dict, rec: dict, cls: dict, cats: list[dict]) -> dict | None:
    subs = set((rec.get("answer") or {}).get("subcategories") or [])
    best, best_score = None, 0.0
    for cat in cats:
        n_sub = sum(1 for s in cat["subcategories"] if s["id"] in subs)
        score = 2 * n_sub + (1 if cat["id"] in cls.get("categories", []) else 0) + 0.5 * c["categories"].get(cat["id"], 0)
        if (n_sub or cat["id"] in cls.get("categories", [])) and score > best_score:
            best, best_score = cat, score
    return best


def pick_name(c: dict, rec: dict, fetcher: Fetcher) -> str:
    """Название — как его пишет модель, но только если каждое слово названия есть на страницах сайта."""
    brand = ((rec.get("answer") or {}).get("brand") or "").strip()
    hay = " ".join(norm(fetcher.page(p["url"]).get("title", "") + " " + fetcher.page(p["url"]).get("text", ""))
                   for p in rec.get("pages", []))
    words = [w for w in re.findall(r"[а-яa-z0-9]{2,}", norm(brand))]
    if brand and words and all(w in hay for w in words):
        return brand
    legal = (rec["facts"].get("legal_name") or {}).get("value")
    return legal or c["host"]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=["seed", "gemini"], default="seed")
    ap.add_argument("--seed", default=str(DATA / "seed" / "websearch-2026-10-13.json"))
    ap.add_argument("--budget-rub", type=float, default=100.0)
    ap.add_argument("--until", choices=["candidates", "classify", "extract", "build"], default="build")
    ap.add_argument("--limit", type=int, default=0, help="взять первые N кандидатов — для отладки")
    ap.add_argument("--offline", action="store_true", help="только кэш: модель не вызывается, сайты без раскладки пропускаются")
    ap.add_argument("--live", default="auto", help="хосты для «Добавить по сайту или ИНН»: site_host,inn_host или auto")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    cats = load_categories()["categories"]
    kie = Kie(budget_rub=args.budget_rub)
    start_spent = spent_rub()
    log(f"Старт {VERSION}: город {CITY}, поиск — {args.provider}, потолок {args.budget_rub:.0f} ₽, до этого потрачено {start_spent:.2f} ₽")

    # 1. кандидаты
    log("1/7 Кандидаты")
    cand = search.run(args.provider, Path(args.seed), kie=kie, log=log)
    pool = [c for c in cand["candidates"] if not c["blocked"]]
    if args.limit:
        pool = pool[: args.limit]
    if args.until == "candidates":
        return

    # 2. главные страницы и фильтр
    fetcher = Fetcher()
    log(f"2/7 Фильтр: открываю главные страницы {len(pool)} сайтов")
    homes = site.fetch_homes(fetcher, pool, log=log)
    log("2/7 Фильтр: модель относит сайты к типам пачками по 10")
    try:
        cls = site.classify(kie, pool, homes, log=log, offline=args.offline)
    except BudgetExceeded as e:
        log(f"СТОП на фильтре: {e}")
        return
    kinds = Counter(cls[c["host"]]["kind"] for c in pool)
    log("   типы: " + ", ".join(f"{k} {v}" for k, v in kinds.most_common()))
    pool = [c for c in pool if c["host"] in cls]
    suppliers = [c for c in pool if cls[c["host"]]["kind"] == "supplier" and cls[c["host"]]["categories"]]
    log(f"   поставщиков с товарами наших категорий: {len(suppliers)}")
    if args.until == "classify":
        return

    # 3–4. страницы и поля
    log(f"3–4/7 Сайт и поля: до 6 страниц на сайт, раскладка моделью, проверка цитат кодом — {len(suppliers)} сайтов")
    recs = site.extract_all(kie, fetcher, suppliers, homes, log=log, offline=args.offline)
    if args.until == "extract":
        return
    recs = {h: site.recheck(r, fetcher) for h, r in recs.items()}     # правила проверки цитат — текущей версии
    by_host = {c["host"]: c for c in suppliers}
    before = sum(1 for r in recs.values() if r["facts"].get("inn"))
    recs = {h: site.find_inn(by_host[h], r, fetcher) if h in by_host else r for h, r in recs.items()}
    log(f"   добор ИНН по шаблону на страницах реквизитов, оферты, политики: было {before}, стало "
        f"{sum(1 for r in recs.values() if r['facts'].get('inn'))}")

    # отбор в набор
    regs = Registries()
    picked, dropped = [], []
    for c in suppliers:
        rec = recs.get(c["host"])
        if not rec:
            dropped.append((c["host"], "раскладка не выполнена (потолок бюджета)"))
            continue
        if rec.get("error") and not rec.get("facts"):
            dropped.append((c["host"], rec["error"]))
            continue
        cat = pick_category(c, rec, cls[c["host"]], cats)
        if not cat:
            dropped.append((c["host"], "нет товаров наших подкатегорий"))
            continue
        rec["name"] = pick_name(c, rec, fetcher)
        picked.append((c, rec, cat))

    # 5. реестры
    log(f"5/7 Проверка по ИНН: ФНС, Росаккредитация, «Честный знак», Федресурс")
    reg_by_host = {}
    with_inn = [(c, rec, cat) for c, rec, cat in picked if rec["facts"].get("inn")]
    for i, (c, rec, cat) in enumerate(with_inn, 1):
        inn = digits(rec["facts"]["inn"]["value"])
        pb = regs.pb(inn)
        reg_by_host[c["host"]] = {"pb": pb, "bo": regs.bo(inn) if not pb.get("data") and len(inn) == 10 else None,
                                  "fsa": regs.fsa(inn), "fedresurs": regs.fedresurs(inn),
                                  "crpt": regs.crpt(inn) if cat.get("marking_group") else None}
        if i % 5 == 0 or i == len(with_inn):
            log(f"   реестры: {i}/{len(with_inn)} ИНН" + (f" · выключены до следующего прогона: {regs.blocked}" if regs.blocked else ""))

    # 6–7. сборка, отсев по городу, дубли по ИНН, оценки
    log("6–7/7 Сборка карточек и оценки ◇")
    sups, recs_by_id, seen_inn, seen_id = [], {}, {}, set()
    for c, rec, cat in picked:
        s = build.build_supplier(c, rec, reg_by_host.get(c["host"], {}), cat)
        inn = s["inn"]["value"]
        regions = s["regions_served"]["value"] or []
        local_inn = bool(inn and inn.startswith(CITY_INN_PREFIX))
        if s["presence"]["value"] == "unknown" and not local_inn and not regions:
            dropped.append((c["host"], f"нет признаков работы в городе {CITY}: ни адреса, ни доставки, ни региона ИНН"))
            continue
        if regions and s["presence"]["value"] != "warehouse" and not local_inn and not any(
                r in ("Екатеринбург", "Свердловская область", "Урал", "вся Россия") for r in regions):
            dropped.append((c["host"], f"не работает в городе {CITY}: только {', '.join(regions[:4])}"))
            continue
        if inn and inn in seen_inn:
            dropped.append((c["host"], f"тот же ИНН, что у {seen_inn[inn]} — дубль"))
            continue
        if inn:
            seen_inn[inn] = c["host"]
        while s["id"] in seen_id:
            s["id"] += "-2"
        seen_id.add(s["id"])
        sups.append(s)
        recs_by_id[s["id"]] = {**rec, "name": s["name"]}
    build.add_estimates(sups, recs_by_id)

    # живой сбор: двое реальных поставщиков, собранных тем же конвейером, показываются после «Добавить по сайту или ИНН»
    def score(s):
        known = sum(1 for k in ("legal_name", "inn", "address", "phones", "min_order", "prices", "delivery", "company")
                    if s[k]["status"] in ("found", "claimed"))
        return known
    if args.live != "none":
        if args.live == "auto":
            by_cat = Counter(s["category"] for s in sups)
            rich = [s for s in sups if s["company"]["status"] == "found"]
            big = [cid for cid, _ in by_cat.most_common()]
            site_pick = max((s for s in rich if s["category"] == big[0]), key=score, default=None) if big else None
            inn_pick = max((s for s in rich if len(big) > 1 and s["category"] == big[1]), key=score, default=None)
        else:
            hs, hi = args.live.split(",")
            site_pick = next((s for s in sups if hs in s["website"]["value"]), None)
            inn_pick = next((s for s in sups if hi in s["website"]["value"]), None)
        if site_pick:
            site_pick["live_only"] = "site"
        if inn_pick and inn_pick is not site_pick:
            inn_pick["live_only"] = "inn"

    # итог
    base = [s for s in sups if not s.get("live_only")]
    fixture = json.loads((DATA / "suppliers.json").read_text(encoding="utf-8"))
    dataset = {"meta": {"fixture": False,
                        "note": "Набор собран конвейером pipeline/: кандидаты из веб-поиска, поля — с сайтов поставщиков с цитатами, "
                                "проверка — по ИНН в реестрах ФНС, Росаккредитации, «Честного знака» и Федресурса.",
                        "city": fixture["meta"]["city"], "collected_at": date.today().isoformat(), "pipeline_version": VERSION},
               "categories": cats, "suppliers": sups}
    (DATA / "suppliers.json").write_text(json.dumps(dataset, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    report = run_report(cand, pool, cls, suppliers, recs, picked, dropped, sups, base, start_spent, kie)
    RUNS.mkdir(parents=True, exist_ok=True)
    (RUNS / f"{date.today().isoformat()}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"Готово: в наборе {len(base)} поставщиков + {len(sups) - len(base)} для живого сбора; "
        + ", ".join(f"{c['short']} {sum(1 for s in base if s['category'] == c['id'])}" for c in cats)
        + f"; потрачено за прогон {spent_rub() - start_spent:.2f} ₽, всего {spent_rub():.2f} ₽")


def run_report(cand, pool, cls, suppliers, recs, picked, dropped, sups, base, start_spent, kie) -> dict:
    from .build import F  # noqa: F401 — формат полей описан там
    tracked = [("legal_name", "Юрлицо"), ("inn", "ИНН"), ("products", "Товары"), ("address", "Адрес или склад"),
               ("presence", "Склад в городе"), ("regions_served", "Регион работы"), ("phones", "Телефон"), ("emails", "Email"),
               ("messengers", "Мессенджер"), ("website", "Сайт"), ("works_with_horeca", "Работа с ресторанами"),
               ("min_order", "Минимальный заказ"), ("prices", "Цены"), ("delivery", "Доставка"), ("payment_terms", "Оплата и отсрочка"),
               ("declarations", "Декларации"), ("site_mentions", "Документы на сайте"), ("company", "Компания в ФНС"),
               ("tax_regime", "Налоговый режим")]

    def get(s, k):
        return s["documents"][k] if k in ("declarations", "site_mentions") else s[k]

    fill = []
    for k, label in tracked:
        st = Counter(get(s, k)["status"] for s in base)
        known = sum(1 for s in base if get(s, k)["status"] in ("found", "claimed") and get(s, k)["value"] not in (None, "unknown"))
        fill.append({"field": k, "label": label, "known": known, "of": len(base), "estimated": st.get("estimated", 0),
                     "by_status": dict(st)})
    rejected = Counter()
    rejected_examples = []
    for r in recs.values():
        for x in r.get("rejected", []):
            rejected[x["field"]] += 1
            if len(rejected_examples) < 40:
                rejected_examples.append({"host": r["host"], **x})
    spend = []
    ledger = (CACHE / "spend.jsonl")
    if ledger.exists():
        for l in ledger.read_text(encoding="utf-8").splitlines():
            spend.append(json.loads(l))
    by_kind = Counter()
    for x in spend:
        by_kind[x["kind"] + ":" + x["label"].split(":")[0]] += x.get("credits") or 0
    return {
        "date": date.today().isoformat(), "pipeline_version": VERSION, "city": CITY,
        "search": {"provider": cand["provider"], "seed": cand.get("seed"), "queries": len(cand["queries"]),
                   "links": sum(q["results"] for q in cand["queries"]), "sites": len(cand["candidates"]),
                   "blocked_by_domain": [{"host": c["host"], "why": c["blocked"]} for c in cand["candidates"] if c["blocked"]]},
        "filter": {"checked": len(pool), "kinds": dict(Counter(cls[c["host"]]["kind"] for c in pool)),
                   "not_suppliers": [{"host": c["host"], "kind": cls[c["host"]]["kind"], "why": cls[c["host"]]["reason"]}
                                     for c in pool if cls[c["host"]]["kind"] != "supplier" or not cls[c["host"]]["categories"]]},
        "extract": {"sites": len(suppliers), "values_rejected": dict(rejected), "rejected_examples": rejected_examples,
                    "not_collected": [{"host": h, "why": r["error"]} for h, r in recs.items() if r.get("error")]},
        "set": {"suppliers": len(base), "live_only": len(sups) - len(base),
                "by_category": dict(Counter(s["category"] for s in base)),
                "dropped": [{"host": h, "why": w} for h, w in dropped]},
        "fill_rate": fill,
        "cost": {"run_rub": round(spent_rub() - start_spent, 2), "total_rub": round(spent_rub(), 2),
                 "by_step_rub": {k: round(v * RUB_PER_CREDIT, 2) for k, v in by_kind.items()},
                 "llm_calls": len(spend), "rub_per_credit": RUB_PER_CREDIT},
    }


if __name__ == "__main__":
    main()
