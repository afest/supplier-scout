"""Один поставщик по сайту или ИНН: python -m pipeline.one --site <адрес> [--inn <ИНН>] [--category id] [--into-set]

Тот же код, что у пакетного `pipeline.run`: страницы сайта → раскладка моделью с цитатами → проверка цитат кодом →
добор ИНН шаблоном → реестры по ИНН → карточка по контракту web/src/types.ts. Поиск кандидатов и фильтр по главной
не нужны: сайт задан явно. Результат — data/live/<хост или ИНН>.json; набор data/suppliers.json не трогается без --into-set.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import time
from datetime import date
from urllib.parse import urlparse

from . import VERSION, build, site
from .config import DATA, load_categories
from .extract import digits, inn_valid
from .fetch import Fetcher, host_of
from .kie import BudgetExceeded, Kie, KieError, spent_rub
from .registries import Registries, company_from_bo, company_from_pb
from .run import pick_category, pick_name

LIVE = DATA / "live"
NO_SITE = "сайт по ИНН не найден: автоматический поиск сайта по названию недоступен"
T0 = time.time()


def log(msg: str):
    el = int(time.time() - T0)
    print(f"[+{el // 60}:{el % 60:02d}] {msg} · потрачено {spent_rub():.2f} ₽", flush=True)


def candidate_from_site(arg: str) -> dict:
    url = arg.strip()
    if "://" not in url:
        url = "https://" + url
    p = urlparse(url)
    host = host_of(url)
    if not host or "." not in host:
        raise SystemExit(f"Не похоже на адрес сайта: {arg!r}")
    root = f"{p.scheme}://{p.netloc}/"
    extra = [url] if p.path.strip("/") else []       # страница, которую дал человек, — первая в очереди после главной
    return {"host": host, "root": root, "urls": extra, "titles": [], "categories": {}, "subcategories": {},
            "queries": [], "sources": ["user"], "blocked": None}


def candidate_from_inn(inn: str) -> dict:
    return {"host": inn, "root": "", "urls": [], "titles": [], "categories": {}, "subcategories": {},
            "queries": [], "sources": ["user"], "blocked": None}


def lookup(regs: Registries, inn: str, cat: dict) -> dict:
    pb = regs.pb(inn)
    return {"pb": pb, "bo": regs.bo(inn) if not pb.get("data") and len(inn) == 10 else None,
            "fsa": regs.fsa(inn), "fedresurs": regs.fedresurs(inn),
            "crpt": regs.crpt(inn) if cat.get("marking_group") else None}


def registry_name(reg: dict, cat: dict) -> str | None:
    info = company_from_pb(reg["pb"], reg.get("fedresurs"), build.OKVED_BY_CAT[cat["id"]])
    if not info and reg.get("bo"):
        info = company_from_bo(reg["bo"], reg.get("fedresurs"), build.OKVED_BY_CAT[cat["id"]], "")
    return info["legal_name"] if info else None


def market_recs(sups: list[dict], fetcher: Fetcher) -> dict[str, dict]:
    """Цены других поставщиков категории — из кэша раскладки: нужны для оценок ◇ новой карточки."""
    out = {}
    for s in sups:
        host = host_of(s["website"]["value"] or "")
        path = site.EXTRACT_DIR / f"{host}.json"
        if host and path.exists():
            out[s["id"]] = {**site.recheck(json.loads(path.read_text(encoding="utf-8")), fetcher), "name": s["name"]}
    return out


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Карточка одного поставщика по сайту или ИНН")
    ap.add_argument("--site", help="адрес сайта: example.ru или https://example.ru/page")
    ap.add_argument("--inn", help="ИНН, 10 или 12 цифр")
    ap.add_argument("--category", choices=[c["id"] for c in load_categories()["categories"]],
                    help="категория; по умолчанию — по подкатегориям из ответа модели, для «только ИНН» обязательна")
    ap.add_argument("--budget-rub", type=float, default=5.0, help="потолок трат на модель за этот запуск, ₽ (по умолчанию 5)")
    ap.add_argument("--into-set", action="store_true", help="дописать карточку в data/suppliers.json как live_only")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    given_inn = digits(args.inn) if args.inn else None
    if not args.site and not given_inn:
        ap.error("нужен --site или --inn")
    if given_inn and not inn_valid(given_inn):
        raise SystemExit(f"ИНН {given_inn}: неверная длина или контрольная сумма")
    if not args.site and not args.category:
        ap.error("для режима «только ИНН» нужен --category: без сайта категорию определить не по чему")

    cats = load_categories()["categories"]
    cat_by_id = {c["id"]: c for c in cats}
    start = spent_rub()
    fetcher = Fetcher()
    regs = Registries()
    log(f"Старт {VERSION}: " + (f"сайт {args.site}" if args.site else "") + (" · " if args.site and given_inn else "")
        + (f"ИНН {given_inn}" if given_inn else ""))

    # ---- сайт: страницы, раскладка, проверка цитат, добор ИНН ----
    if args.site:
        c = candidate_from_site(args.site)
        log(f"1/4 Сайт: открываю {c['root']}")
        home = fetcher.page(c["root"])
        if home.get("error") and not home.get("text"):
            log(f"   главная не открылась: {home['error']}")
        cached = (site.EXTRACT_DIR / f"{c['host']}.json").exists()
        kie = None if cached else Kie(budget_rub=spent_rub() + args.budget_rub)    # потолок — на этот запуск, а не на весь журнал
        log("2/4 Раскладка по полям " + ("— из кэша, модель не вызывается" if cached else "моделью, цитаты проверяет код"))
        try:
            rec = site.extract_one(kie, fetcher, c, home, cats)
        except (BudgetExceeded, KieError) as e:
            raise SystemExit(f"Остановился на раскладке: {e}")
        rec = site.recheck(rec, fetcher)
        rec = site.find_inn(c, rec, fetcher)
        ans = rec.get("answer") or {}
        log(f"   страниц {len(rec['pages'])}, полей {len(rec['facts'])}, отброшено цитатами {len(rec['rejected'])}"
            + (f", ошибка: {rec['error']}" if rec.get("error") else ""))
        if rec.get("answer") and not ans.get("is_supplier", True):
            log(f"   модель решила: это не поставщик — {ans.get('not_supplier_reason') or 'причина не названа'}")
    else:
        c = candidate_from_inn(given_inn)
        rec = {"host": given_inn, "pages": [], "answer": None, "facts": {}, "rejected": [], "error": None, "no_site": NO_SITE}
        log("1/4 Сайт: не задан — поля сайта останутся «не найдено»")

    # ---- ИНН: с сайта и заданный руками ----
    site_inn = digits(rec["facts"]["inn"]["value"]) if rec["facts"].get("inn") else None
    inn_note = None
    if given_inn:
        if site_inn and site_inn != given_inn:
            inn_note = f"ИНН на сайте {site_inn} не совпадает с заданным {given_inn}; карточка собрана по ИНН с сайта"
            log("   ⚠ " + inn_note)
        elif site_inn:
            log(f"   ИНН с сайта совпал с заданным: {given_inn}")
        else:
            rec["facts"]["inn"] = {"value": given_inn, "quote": None, "page": None, "via": "задан при запуске"}
        rec["inn_given"] = True
    inn = digits(rec["facts"]["inn"]["value"]) if rec["facts"].get("inn") else None
    if args.site and not inn:
        log("   ИНН на сайте не найден — реестры пропущены")

    # ---- категория ----
    if args.category:
        cat = cat_by_id[args.category]
    else:
        cat = pick_category(c, rec, {"categories": []}, cats)
        if not cat:
            cat = cats[0]
            log(f"   ⚠ подкатегории из наших не определились — карточка отнесена к «{cat['name']}» формально; "
                "укажите --category, если знаете")
    log(f"   категория: {cat['name']}")

    # ---- реестры ----
    reg = {}
    if inn:
        log(f"3/4 Реестры по ИНН {inn}: ФНС, Росаккредитация, «Честный знак», Федресурс")
        reg = lookup(regs, inn, cat)
        if regs.blocked:
            log(f"   выключены до следующего прогона: {regs.blocked}")
    else:
        log("3/4 Реестры: без ИНН не проверить")

    # ---- карточка ----
    log("4/4 Сборка карточки и оценок ◇")
    rec["name"] = (pick_name(c, rec, fetcher) if args.site else (registry_name(reg, cat) if reg else None) or given_inn)
    s = build.build_supplier(c, rec, reg, cat)
    if not args.site:
        s["website"] = build.F(searched_in=[NO_SITE])
    src = [x for x in s["meta"]["sources"] if x["id"] != "search"]
    src.append({"id": "user", "kind": "user", "url": "#/add",
                "title": "Адрес сайта задан при запуске" if args.site else "ИНН задан при запуске", "fetched_at": build.TODAY})
    s["meta"]["sources"] = src
    if args.site:
        s["website"]["sources"] = ["user"]
    if given_inn and not site_inn and s["company"]["status"] == "found":     # ИНН задан руками и подтверждён реестром
        s["inn"] = build.F(given_inn, "found", s["company"]["sources"][:1])
    if inn_note:
        s["meta"]["inn_conflict"] = inn_note

    full = json.loads((DATA / "suppliers.json").read_text(encoding="utf-8"))
    same_cat = copy.deepcopy([x for x in full["suppliers"] if x["category"] == cat["id"] and not x.get("live_only")])
    group = same_cat + [s]
    build.add_estimates(group, {**market_recs(same_cat, fetcher), s["id"]: {**rec, "name": s["name"]}})

    if args.site:
        key = c["host"]
        s["live_only"] = "site"
    else:
        key = given_inn
        s["live_only"] = "inn"
    out = LIVE / f"{key}.json"
    write_json(out, s)

    # ---- итог ----
    def val(f):
        v = f["value"]
        return "не найдено" if v in (None, [], "unknown") else (", ".join(v) if isinstance(v, list) else str(v)[:70])
    print()
    print(f"Карточка: {s['name']} — {cat['name']}" + (f" · НЕ ПОСТАВЩИК: {s['not_supplier']}" if s.get("not_supplier") else ""))
    for k, label in (("legal_name", "Юрлицо"), ("inn", "ИНН"), ("address", "Адрес"), ("phones", "Телефоны"),
                     ("min_order", "Мин. заказ"), ("delivery", "Доставка"), ("company", "Компания в ФНС")):
        f = s[k]
        shown = f["status"] if f["value"] is None else f"{val(f)} [{f['status']}]"
        if k == "min_order" and f["value"]:
            shown = f"{f['value']['text']} [{f['status']}]"
        if k == "company" and f["value"]:
            shown = f"{f['value']['form']}, {f['value']['status']}, с {f['value']['registered_at']} [{f['status']}]"
        if k == "delivery" and f["value"]:
            shown = f"{'до двери' if f['value']['to_door'] else 'без доставки до двери'} [{f['status']}]"
        print(f"  {label:<16}{shown}")
    print(f"→ {out}")

    if args.into_set:
        if s.get("not_supplier"):
            print("--into-set: не записано — карточка не поставщик")
        else:
            dup = next((x for x in full["suppliers"] if not x.get("live_only") and (
                (s["inn"]["value"] and x["inn"]["value"] == s["inn"]["value"]) or x["id"] == s["id"])), None)
            if dup:
                print(f"--into-set: не записано — в наборе уже есть «{dup['name']}»")
            else:
                full["suppliers"] = [x for x in full["suppliers"] if x["id"] != s["id"]] + [s]
                write_json(DATA / "suppliers.json", full)
                print(f"--into-set: дописано в data/suppliers.json как live_only={s['live_only']}")
    log(f"Готово: расход за запуск {spent_rub() - start:.2f} ₽")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
