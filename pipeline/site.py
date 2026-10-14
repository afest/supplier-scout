"""Шаги 2–4: главная страница → фильтр «поставщик ли это» → до шести страниц → раскладка по полям с цитатами."""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

from .config import CACHE, CACHE_TTL_EXTRACT_DAYS, INN_PAGES, MAX_PAGES, PAGE_HINTS, load_categories
from .extract import SYSTEM, build_prompt, check_answer, supplier_tool
from .fetch import Fetcher, pick_pages
from .kie import BudgetExceeded, KieError

CLASSIFY_OUT = CACHE / "classify.json"
EXTRACT_DIR = CACHE / "extract"

CLASSIFY_TOOL = {
    "name": "classify_sites",
    "description": "Отнести каждый сайт к типу и категориям товаров.",
    "input_schema": {"type": "object", "properties": {"sites": {"type": "array", "items": {
        "type": "object", "properties": {
            "id": {"type": "integer"},
            "kind": {"type": "string", "enum": ["supplier", "aggregator", "retail", "restaurant", "article", "other"],
                     "description": "supplier — производитель, оптовик, дистрибьютор, оптово-розничный магазин, который продаёт юрлицам; aggregator — каталог компаний, маркетплейс, доска объявлений, сравнение цен; retail — магазин только для частных лиц; restaurant — ресторан или доставка готовой еды; article — статья, блог, СМИ; other — прочее, сайт не открылся"},
            "categories": {"type": "array", "items": {"type": "string", "enum": ["packaging", "fish", "dairy", "grocery"]},
                           "description": "packaging — упаковка для доставки еды; fish — рыба и морепродукты; dairy — сыр и молочное; grocery — рис, нори, соусы, азиатская бакалея"},
            "reason": {"type": "string", "description": "до 12 слов"}},
        "required": ["id", "kind", "categories", "reason"]}}},
        "required": ["sites"]},
}

CLASSIFY_PROMPT = """Ниже — сайты из выдачи поиска поставщиков для ресторанов (упаковка для доставки, рыба и морепродукты, сыр и молочное, рис и азиатская бакалея). По заголовку и началу главной страницы определи, кто это. Сомневаешься между supplier и retail, если сайт продаёт оптом или пишет про юрлиц, кафе, HoReCa — supplier.

{sites}

Запиши ответ инструментом classify_sites — по одной записи на каждый id."""


def _snippet(c: dict, home: dict) -> str:
    text = re.sub(r"\s+", " ", home.get("text", ""))[:1500]
    err = f" (не открылся: {home['error']})" if home.get("error") and not text else ""
    return (f"[{c['_id']}] {c['host']}{err}\nВ выдаче: {' | '.join(c['titles'][:2])}\n"
            f"Заголовок: {home.get('title', '')[:150]}\nНачало главной: {text}")


def fetch_homes(fetcher: Fetcher, cands: list[dict], log=print) -> dict[str, dict]:
    homes = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(fetcher.page, c["root"]): c["host"] for c in cands}
        for i, fut in enumerate(as_completed(futs), 1):
            homes[futs[fut]] = fut.result()
            if i % 20 == 0 or i == len(futs):
                log(f"  главные страницы: {i}/{len(futs)}")
    return homes


def classify(kie, cands: list[dict], homes: dict, batch: int = 10, log=print, offline: bool = False) -> dict[str, dict]:
    done = json.loads(CLASSIFY_OUT.read_text(encoding="utf-8")) if CLASSIFY_OUT.exists() else {}
    # сайт, который в прошлый раз не открылся, а теперь открылся, — классифицируем заново
    todo = [c for c in cands if c["host"] not in done or (not done[c["host"]].get("had_text") and homes[c["host"]].get("text"))]
    if offline:
        return done
    for start in range(0, len(todo), batch):
        part = todo[start:start + batch]
        for i, c in enumerate(part, 1):
            c["_id"] = i
        prompt = CLASSIFY_PROMPT.format(sites="\n\n".join(_snippet(c, homes[c["host"]]) for c in part))
        ans = kie.claude_tool(prompt, CLASSIFY_TOOL, label=f"classify:{start // batch + 1}", max_tokens=2048)
        by_id = {s["id"]: s for s in ans.get("sites", [])}
        for c in part:
            s = by_id.get(c["_id"])
            done[c["host"]] = ({"kind": s["kind"], "categories": s["categories"], "reason": s["reason"]} if s
                               else {"kind": "other", "categories": [], "reason": "модель не ответила по этому сайту"})
            done[c["host"]]["had_text"] = bool(homes[c["host"]].get("text"))
            done[c["host"]]["home_error"] = homes[c["host"]].get("error")
        CLASSIFY_OUT.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
        log(f"  фильтр: {min(start + batch, len(todo))}/{len(todo)} сайтов")
    return done


def collect_pages(fetcher: Fetcher, c: dict, home: dict) -> list[dict]:
    extra = [u for u in c["urls"] if u.rstrip("/") != c["root"].rstrip("/")]
    urls = pick_pages(home, extra, PAGE_HINTS, MAX_PAGES - 1)
    pages = [home] + [fetcher.page(u) for u in urls]
    return [p for p in pages if p.get("text")]


def extracted_on(rec: dict) -> str:
    """Дата раскладки: поле записи, у старых записей — самая поздняя загрузка страниц."""
    return rec.get("extracted_at") or max((p.get("fetched_at") or "" for p in rec.get("pages", [])), default="") or "1970-01-01"


def cached_extract(host: str) -> dict | None:
    """Раскладка из кэша, если она годна: оплаченный ответ модели не старше срока. Запись-ошибка («сайт не открылся»)
    не годна никогда — временный сбой не должен навсегда оставить поставщика несобранным."""
    path = EXTRACT_DIR / f"{host}.json"
    if not path.exists():
        return None
    rec = json.loads(path.read_text(encoding="utf-8"))
    if not rec.get("answer"):
        return None
    if extracted_on(rec) < (date.today() - timedelta(days=CACHE_TTL_EXTRACT_DAYS)).isoformat():
        return None
    return rec


def extract_one(kie, fetcher: Fetcher, c: dict, home: dict, cats: list[dict]) -> dict:
    path = EXTRACT_DIR / f"{c['host']}.json"
    hit = cached_extract(c["host"])
    if hit:
        return hit
    pages = collect_pages(fetcher, c, home)
    blocked = "robots.txt" in (home.get("error") or "")
    rec = {"host": c["host"], "pages": [{"url": p["final_url"], "title": p.get("title", ""), "via": p.get("via"),
                                         "kind": p.get("kind"), "fetched_at": p["fetched_at"]} for p in pages],
           "answer": None, "facts": {}, "rejected": [], "error": None, "extracted_at": date.today().isoformat()}
    if blocked:
        rec["error"] = f"сбор закрыт: {home['error']}"
    elif not pages:
        rec["error"] = f"сайт не открылся: {home.get('error') or 'пустая страница'}"
    else:
        subs = [s["id"] for cat in cats for s in cat["search_subcategories"]]
        ans = kie.claude_tool(build_prompt(c["host"], pages, cats), supplier_tool(subs),
                              label=f"extract:{c['host']}", system=SYSTEM, max_tokens=4096)
        rec["answer"] = ans
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")   # оплаченный ответ — на диск до проверки
        checked = check_answer(ans, pages)
        rec.update(facts=checked.facts, rejected=checked.rejected)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")   # запись-ошибка — для отчёта, повтор её не возьмёт
    return rec


INN_RX = re.compile(r"ИНН\s*(?:/\s*КПП)?\s*[:№]?\s*(\d{10}|\d{12})(?!\d)", re.I)
INN_HINTS = [("реквизит", 10), ("rekvizit", 10), ("requisit", 10), ("оферт", 8), ("oferta", 8), ("offer", 6), ("договор", 6),
             ("dogovor", 6), ("политик", 5), ("privacy", 5), ("policy", 5), ("politika", 5), ("конфиденц", 5), ("контакт", 4),
             ("contact", 4), ("о компании", 3), ("about", 3), ("company", 2)]


def _scan_inn(pages: list[dict], offset: int = 0):
    """ИНН по шаблону «ИНН 1234567890» с верной контрольной суммой; при нескольких — чаще встречающийся."""
    from .extract import inn_valid
    seen: dict[str, tuple[int, str, int]] = {}
    for i, p in enumerate(pages):
        for m in INN_RX.finditer(p.get("text", "")):
            inn = m.group(1)
            if not inn_valid(inn):
                continue
            n, quote, page = seen.get(inn, (0, "", i + offset))
            snippet = p["text"][max(0, m.start() - 60): m.end() + 5].split("\n")
            seen[inn] = (n + 1, quote or " ".join(s.strip() for s in snippet if s.strip())[-160:], page)
    if not seen:
        return None
    inn, (n, quote, page) = max(seen.items(), key=lambda kv: kv[1][0])
    return {"value": inn, "quote": quote, "page": page, "via": "шаблон «ИНН …» на странице"}


def find_inn(c: dict, rec: dict, fetcher: Fetcher) -> dict:
    """Добор ИНН без модели: по уже загруженным страницам, потом — до трёх страниц реквизитов, оферты, политики."""
    if rec["facts"].get("inn") or not rec.get("pages"):
        return rec
    pages = [Fetcher.cached(p["url"]) or fetcher.page(p["url"]) for p in rec["pages"]]
    hit = _scan_inn(pages)
    if not hit and pages:
        visited = {p["url"].rstrip("/") for p in rec["pages"]}
        extra = [u for u in pick_pages(pages[0], [], INN_HINTS, 6) if u.rstrip("/") not in visited][:INN_PAGES]
        new = [p for p in (fetcher.page(u) for u in extra) if p.get("text")]
        hit = _scan_inn(new, offset=len(pages))
        if hit:
            rec = {**rec, "pages": rec["pages"] + [{"url": p["final_url"], "title": p.get("title", ""), "via": p.get("via"),
                                                    "kind": p.get("kind"), "fetched_at": p["fetched_at"]} for p in new]}
    if hit:
        rec = {**rec, "facts": {**rec["facts"], "inn": hit}}
    return rec


def recheck(rec: dict, fetcher: Fetcher) -> dict:
    """Проверка цитат заново по сохранённому ответу модели и страницам из кэша — правила можно править без новых трат."""
    if not rec.get("answer"):
        return rec
    pages = [Fetcher.cached(p["url"]) or fetcher.page(p["url"]) for p in rec["pages"]]
    checked = check_answer(rec["answer"], pages)
    return {**rec, "facts": checked.facts, "rejected": checked.rejected}


def extract_all(kie, fetcher: Fetcher, cands: list[dict], homes: dict, workers: int = 3, log=print, offline: bool = False) -> dict[str, dict]:
    cats = load_categories()["categories"]
    out: dict[str, dict] = {}
    if offline:             # только то, что уже разложено и лежит в кэше; модель не вызывается
        for c in cands:
            path = EXTRACT_DIR / f"{c['host']}.json"
            if path.exists():
                out[c["host"]] = json.loads(path.read_text(encoding="utf-8"))
        log(f"  из кэша: {len(out)} сайтов из {len(cands)}")
        return out
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(extract_one, kie, fetcher, c, homes[c["host"]], cats): c["host"] for c in cands}
        for i, fut in enumerate(as_completed(futs), 1):
            host = futs[fut]
            try:
                out[host] = fut.result()
            except BudgetExceeded as e:
                log(f"  СТОП: {e}")
                for f in futs:
                    f.cancel()
                break
            except KieError as e:
                out[host] = {"host": host, "error": f"модель: {e}"[:300], "facts": {}, "rejected": [], "pages": []}
            except Exception as e:      # сбой на одном сайте не останавливает сбор — причина уходит в отчёт
                out[host] = {"host": host, "error": f"сбой: {type(e).__name__}: {e}"[:300], "facts": {}, "rejected": [], "pages": []}
            r = out[host]
            log(f"  раскладка {i}/{len(futs)}: {host} — " + (r.get("error") or f"{len(r['facts'])} полей, отброшено {len(r['rejected'])}")
                + f" · потрачено {kie.run_credits * 0.5:.1f} ₽")
    return out
