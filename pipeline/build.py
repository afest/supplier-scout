"""Шаги 6–7. Оценки ◇ по рынку и сборка карточек в контракт web/src/types.ts."""
from __future__ import annotations

import re
import statistics
from datetime import date
from urllib.parse import quote as urlquote

from . import VERSION
from .config import CITY
from .extract import digits, norm
from .registries import company_from_bo, company_from_pb, declarations_from_fsa, marking_from_crpt

TODAY = date.today().isoformat()

# ОКВЭД по профилю категории: оптовая торговля и производство нужной группы
OKVED_BY_CAT = {
    "packaging": ["46.49", "46.76", "46.18", "17.2", "22.2", "46.90", "47.78"],
    "fish": ["46.38", "46.17", "10.2", "03.", "46.39", "46.90"],
    "dairy": ["46.33", "10.5", "46.17", "46.39", "46.90"],
    "grocery": ["46.3", "10.6", "10.8", "46.17", "46.90"],
}

REF_KEYWORDS = [
    ("pizza-box", r"пицц"), ("container", r"контейнер|ланч|бокс|коррекс|лоток|упаковк\w* для (суши|ролл)"),
    ("kraft-bag", r"пакет"), ("salmon", r"лосос|сёмг|семг|форел|нерк|кижуч"), ("shrimp", r"кревет"),
    ("mozzarella", r"моцарел"), ("cream-cheese", r"сливочн|творожн|крем-?чиз|филадельф"),
    ("rice", r"\bрис\b|рис "), ("nori", r"нори"), ("soy-sauce", r"соев"),
]
REF_LABEL = {"container": "контейнер для роллов", "pizza-box": "коробка для пиццы", "kraft-bag": "крафт-пакет",
             "salmon": "лосось, сёмга, форель", "shrimp": "креветки", "mozzarella": "моцарелла",
             "cream-cheese": "сливочный сыр", "rice": "рис для суши", "nori": "нори", "soy-sauce": "соевый соус"}
REF_UNIT = {"container": "шт", "pizza-box": "шт", "kraft-bag": "шт", "salmon": "кг", "shrimp": "кг", "mozzarella": "кг",
            "cream-cheese": "кг", "rice": "кг", "nori": "уп.", "soy-sauce": "л"}
CAT_REFS = {"packaging": ["container", "pizza-box", "kraft-bag"], "fish": ["salmon", "shrimp"],
            "dairy": ["mozzarella", "cream-cheese"], "grocery": ["rice", "nori", "soy-sauce"]}


def F(value=None, status="not_found", sources=None, quote=None, searched_in=None, basis=None, alternatives=None):
    f = {"value": value, "status": status, "sources": sources or [], "quote": quote, "searched_in": searched_in,
         "basis": basis, "collected_at": TODAY}
    if alternatives:
        f["alternatives"] = alternatives
    return f


def slug(text: str) -> str:
    tr = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"]))
    s = "".join(tr.get(ch, ch) for ch in text.lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40] or "supplier"


# ---------- цены: эталонные позиции для оценок ◇ ----------

def ref_of(item: str) -> str | None:
    low = norm(item)
    for ref, pat in REF_KEYWORDS:
        if re.search(pat, low):
            return ref
    return None


def unit_price(price: str, ref: str) -> float | None:
    """Число из цены, если она за единицу эталона: «1 450 ₽/кг», «от 7,5 руб./шт». Цена за упаковку товара — не берём."""
    low = norm(price)
    unit = REF_UNIT[ref]
    per_kg = re.search(r"(/|за|в)\s*кг|руб\.?/кг|₽/кг", low)
    per_pc = re.search(r"(/|за)\s*шт|₽/шт|руб\.?/шт", low)
    per_l = re.search(r"(/|за)\s*л\b", low)
    if unit == "кг" and not per_kg:
        return None
    if unit == "л" and not per_l:
        return None
    if unit == "шт" and (per_kg or per_l):
        return None
    m = re.search(r"(\d[\d\s]*(?:[.,]\d+)?)", low)
    if not m:
        return None
    try:
        return float(m.group(1).replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def market_refs(recs: list[dict]) -> dict[str, list[tuple[float, str]]]:
    """Открытые цены по эталонам: ref → [(цена, поставщик)] — только из проверенных цитатами примеров."""
    out: dict[str, list[tuple[float, str]]] = {}
    for r in recs:
        pr = r["facts"].get("prices")
        if not pr:
            continue
        for ex in pr["value"].get("examples", []):
            ref = ref_of(ex.get("item", ""))
            if not ref:
                continue
            p = unit_price(ex.get("price", ""), ref)
            if p:
                out.setdefault(ref, []).append((p, r["name"]))
    return out


def fmt_rub(x: float) -> str:
    return f"{x:,.0f}".replace(",", " ") if x >= 100 else (f"{x:.1f}".rstrip("0").rstrip(".").replace(".", ","))


# ---------- сборка карточки ----------

LEGAL_FORMS = {"ооо", "оао", "зао", "пао", "ао", "ип", "общество", "ограниченной", "ответственностью", "акционерное",
               "индивидуальный", "предприниматель", "компания", "торговый", "дом", "тд", "группа", "производственная"}


def name_on_site(legal_name: str, rec: dict) -> bool:
    """Значимое слово названия из реестра есть в тексте страниц сайта (без формы собственности и общих слов)."""
    from .extract import loose
    from .fetch import Fetcher
    words = [w for w in loose(legal_name).split() if len(w) >= 4 and w not in LEGAL_FORMS]
    if not words or (rec.get("inn_given") and not rec.get("pages")):    # ИНН задан руками и сайта нет — сверять не с чем
        return True
    text = " ".join(loose((Fetcher.cached(p["url"]) or {}).get("text", "")) for p in rec.get("pages", []))
    return any(w in text for w in words)


def site_sources(rec: dict) -> list[dict]:
    out = []
    for i, p in enumerate(rec["pages"]):
        title = p.get("title") or p["url"]
        out.append({"id": f"site-p{i + 1}", "kind": "site", "url": p["url"],
                    "title": "Сайт: " + (title[:70] + "…" if len(title) > 70 else title), "fetched_at": p.get("fetched_at", TODAY)})
    return out


def searched_site(rec: dict) -> list[str]:
    if rec.get("no_site"):
        return [rec["no_site"]]
    n = len(rec["pages"])
    names = []
    for p in rec["pages"]:
        path = re.sub(r"^https?://[^/]+", "", p["url"]).strip("/") or "главная"
        names.append(path[:30])
    return [f"сайт: {n} стр. — " + ", ".join(names[:6])] if n else ["сайт не открылся"]


def build_supplier(c: dict, rec: dict, reg: dict, cat: dict) -> dict:
    facts = rec["facts"]
    src = site_sources(rec)
    sid = lambda f: [f"site-p{f['page'] + 1}"] if f and f.get("page") is not None else []
    where = searched_site(rec)

    def claimed(key: str, transform=None, quote=True):
        f = facts.get(key)
        if not f:
            return F(searched_in=where)
        v = transform(f["value"]) if transform else f["value"]
        return F(v, "claimed", sid(f), f.get("quote") if quote else None)

    search_src = {"id": "search", "kind": "search", "url": c["urls"][0] if c["urls"] else c["root"],
                  "title": (f"Веб-поиск: «{c['queries'][0]}»" if c.get("queries") else "Проба полноты 10.10: веб-поиск"),
                  "fetched_at": TODAY}
    src.append(search_src)

    inn = digits(facts["inn"]["value"]) if facts.get("inn") else None
    pb = reg.get("pb") if inn else None
    company_info = company_from_pb(pb, reg.get("fedresurs"), OKVED_BY_CAT[cat["id"]]) if pb else None
    fns = "pb"
    pb_err = (pb or {}).get("error")
    if inn and not company_info and reg.get("bo"):        # «Прозрачный бизнес» за капчей — бухотчётность ФНС
        company_info = company_from_bo(reg["bo"], reg.get("fedresurs"), OKVED_BY_CAT[cat["id"]],
                                       "ФНС «Прозрачный бизнес» попросила капчу" if pb_err and "капч" in pb_err else "«Прозрачный бизнес» не ответил")
        fns = "bo" if company_info else "pb"
    reg_where = ([f"ФНС «Прозрачный бизнес» по ИНН {inn}" + (f": {pb_err}" if pb_err else "")] if inn
                 else ["без ИНН реестры не проверить"])
    # ИНН на сайте может оказаться чужим (разработчика сайта, партнёра) — данные реестра берём, только если
    # название компании из реестра встречается на сайте
    if company_info and not name_on_site(company_info["legal_name"], rec):
        reg_where = [f"ИНН {inn} с сайта: в реестре это «{company_info['legal_name']}», на сайте такого названия нет — данные реестра не прикреплены"]
        rec.setdefault("inn_mismatch", company_info["legal_name"])
        company_info, fns = None, "pb"
        inn_unverified = True
    else:
        # ИНН, найденный шаблоном, а не моделью в реквизитах, без подтверждения реестром по названию к реестрам не цепляем
        inn_unverified = bool(inn and not company_info and facts["inn"].get("via") and not rec.get("inn_given"))
    if inn and fns == "pb":
        src.append({"id": "pb", "kind": "registry", "url": f"https://pb.nalog.ru/search.html#mode=search-all&queryAll={inn}",
                    "title": "ФНС «Прозрачный бизнес»: карточка по ИНН", "fetched_at": TODAY})
    if inn and fns == "bo":
        src.append({"id": "bo", "kind": "registry", "url": f"https://bo.nalog.gov.ru/organizations-card/{reg['bo']['data']['id']}",
                    "title": "ФНС: бухгалтерская отчётность (ГИР БО)", "fetched_at": TODAY})

    # юрлицо: реестр важнее сайта
    if company_info:
        legal = F(company_info["legal_name"], "found", [fns])
    else:
        legal = claimed("legal_name")

    # адрес и присутствие в городе
    if facts.get("city_address"):
        fa = facts["city_address"]
        kind = fa.get("kind")
        address = F(fa["value"] + (f" — {kind}" if kind else ""), "claimed", sid(fa), fa["quote"])
        presence = F("warehouse", "claimed", sid(fa), fa["quote"])
    else:
        if company_info and company_info.get("address"):
            address = F(f"{company_info['address']} (юридический адрес)", "found", [fns])
        elif facts.get("home_city"):
            fh = facts["home_city"]
            address = F(fh["value"], "claimed", sid(fh), fh["quote"])
        else:
            address = F(searched_in=where)
        regs = facts.get("regions_served", {}).get("value", []) if facts.get("regions_served") else []
        d = facts.get("delivery")
        serves_city = any(r in ("Екатеринбург", "Свердловская область", "Урал", "вся Россия") for r in regs)
        if serves_city or (d and (d["value"].get("to_door") or d["value"].get("transport_company"))):
            fr = facts.get("regions_served") or d
            presence = F("delivery_only", "claimed", sid(fr), fr.get("quote"))
        else:
            presence = F("unknown", "not_found", searched_in=where)

    regions = claimed("regions_served")

    # минимальный заказ, цены, доставка
    min_order = claimed("min_order", lambda v: {"amount": v.get("amount"), "unit": v.get("unit") or "RUB", "text": v.get("text") or ""})
    prices = claimed("prices", lambda v: {"mode": v["mode"], "pricelist_url": v.get("pricelist_url"),
                                           "examples": [{"item": e["item"], "price": e["price"]} for e in v.get("examples", [])][:3]})
    if facts.get("delivery"):
        dv = facts["delivery"]["value"]
        delivery = F({"to_door": bool(dv.get("to_door")), "free_from": dv.get("free_from"), "cost": dv.get("cost"),
                      "lead_time": dv.get("lead_time"), "pickup": bool(dv.get("pickup")), "zones": dv.get("zones"),
                      "transport_company": bool(dv.get("transport_company"))},
                     "claimed", sid(facts["delivery"]), facts["delivery"]["quote"])
    else:
        delivery = F(searched_in=where)

    # документы
    decl_list = declarations_from_fsa(reg.get("fsa")) if inn and not inn_unverified else None
    if inn and not inn_unverified:
        src.append({"id": "fsa", "kind": "registry", "url": "https://pub.fsa.gov.ru/rds/declaration",
                    "title": "Росаккредитация: реестр деклараций по ИНН заявителя", "fetched_at": TODAY})
    if decl_list:
        decl_list.sort(key=lambda d: (d["status"] != "действует", -int(d["valid_to"].replace("-", "") or 0)))
        declarations = F(decl_list, "found", ["fsa"])
    else:
        declarations = F(searched_in=([f"реестр деклараций Росаккредитации по ИНН {inn}"] if inn and not inn_unverified
                                      else reg_where if inn else ["без ИНН реестр не проверить"]))
    marking = None
    if cat.get("marking_group"):
        groups = marking_from_crpt(reg.get("crpt")) if inn and not inn_unverified else None
        if inn and not inn_unverified:
            src.append({"id": "crpt", "kind": "registry", "url": "https://markirovka.crpt.ru/",
                        "title": "«Честный знак»: участник оборота по ИНН", "fetched_at": TODAY})
        marking = (F(groups, "found", ["crpt"]) if groups else
                   F(searched_in=([f"«Честный знак» по ИНН {inn}: " + ("не зарегистрирован" if groups == [] else "реестр не ответил")]
                                  if inn and not inn_unverified else reg_where if inn else ["без ИНН реестр не проверить"])))

    if company_info:
        company = F(company_info["company"], "found", [fns] + (["fedresurs"] if reg.get("fedresurs", {}).get("data") else []))
        if reg.get("fedresurs", {}).get("data"):
            src.append({"id": "fedresurs", "kind": "registry", "url": f"https://fedresurs.ru/search/entity?code={inn}",
                        "title": "Федресурс: сведения о банкротстве", "fetched_at": TODAY})
        tax = F(company_info["tax_regime"], "found", [fns]) if company_info.get("tax_regime") else F(searched_in=reg_where)
    else:
        company = F(searched_in=reg_where if not (pb and pb.get("error")) else [f"ФНС не ответила: {pb['error']}"])
        tax = F(searched_in=reg_where)

    name = rec.get("name") or c["host"]
    subs = [s for s in (rec["answer"] or {}).get("subcategories", []) if s in {x["id"] for x in cat["subcategories"]}]
    if not subs:
        subs = [s for s in c.get("subcategories", {}) if s in {x["id"] for x in cat["subcategories"]}] or [cat["subcategories"][0]["id"]]

    sup = {
        "id": slug(name),
        "name": name,
        "demo": False,
        "category": cat["id"],
        "subcategories": subs,
        "city": CITY,
        "legal_name": legal,
        "inn": claimed("inn", lambda v: digits(v)),
        "products": claimed("products", quote=False),
        "address": address,
        "presence": presence,
        "regions_served": regions,
        "phones": claimed("phones", quote=False),
        "emails": claimed("emails", quote=False),
        "messengers": claimed("messengers", quote=False),
        "website": F(c["root"].rstrip("/"), "claimed", ["search"]),
        "map_link": f"https://2gis.ru/ekaterinburg/search/{urlquote(name)}",
        "works_with_horeca": claimed("works_with_horeca", lambda v: bool(v)),
        "min_order": min_order,
        "prices": prices,
        "delivery": delivery,
        "payment_terms": claimed("payment_terms"),
        "documents": {"declarations": declarations, "marking": marking, "site_mentions": claimed("doc_mentions")},
        "company": company,
        "tax_regime": tax,
        "not_supplier": None if (rec["answer"] or {}).get("is_supplier", True) else ((rec["answer"] or {}).get("not_supplier_reason") or "так решила модель по тексту сайта"),
        "meta": {"collected_at": TODAY, "pipeline_version": VERSION, "sources": src,
                 "not_collected_reason": rec.get("error"), "pages": len(rec["pages"])},
    }
    return sup


def add_estimates(sups: list[dict], recs_by_id: dict[str, dict]):
    """◇ оценки: минимальный заказ — медиана известных в категории; цены — разброс открытых цен по эталонам категории."""
    by_cat: dict[str, list[dict]] = {}
    for s in sups:
        by_cat.setdefault(s["category"], []).append(s)
    for cat_id, group in by_cat.items():
        mins = [(s["min_order"]["value"]["amount"], s["name"]) for s in group
                if s["min_order"]["status"] == "claimed" and s["min_order"]["value"]["unit"] == "RUB" and s["min_order"]["value"]["amount"]]
        refs = market_refs([recs_by_id[s["id"]] for s in group if s["id"] in recs_by_id])
        price_lines, price_basis = [], []
        for ref in CAT_REFS[cat_id]:
            vals = sorted(p for p, _ in refs.get(ref, []))
            who = sorted({n for _, n in refs.get(ref, [])})
            if len(who) >= 3:
                lo, hi = statistics.quantiles(vals, n=4)[0], statistics.quantiles(vals, n=4)[2]
                price_lines.append(f"{REF_LABEL[ref]} — ~{fmt_rub(lo)}–{fmt_rub(hi)} ₽/{REF_UNIT[ref]}")
                price_basis.append(f"{REF_LABEL[ref]}: {len(vals)} цен у {len(who)} поставщиков ({', '.join(who[:4])}{'…' if len(who) > 4 else ''})")
        for s in group:
            if s["min_order"]["status"] == "not_found" and len(mins) >= 3:
                med = statistics.median(a for a, _ in mins)
                s["min_order"] = F({"amount": round(med, -2) if med >= 1000 else round(med), "unit": "RUB", "text": f"~{fmt_rub(med)} ₽"},
                                   "estimated", ["market"], basis=f"медиана минимального заказа у {len(mins)} поставщиков категории, которые его публикуют: "
                                   + ", ".join(f"{fmt_rub(a)} ₽" for a, _ in sorted(mins)) + f"; собрано {TODAY}")
                _add_market_src(s)
            no_prices = s["prices"]["status"] == "not_found" or s["prices"]["value"]["mode"] in ("on_request", "after_login")
            if no_prices and price_lines:
                s["price_estimate"] = F("; ".join(price_lines), "estimated", ["market"],
                                        basis="открытые цены поставщиков категории на их сайтах: " + "; ".join(price_basis) + f"; собрано {TODAY}")
                _add_market_src(s)


def _add_market_src(s: dict):
    if not any(x["id"] == "market" for x in s["meta"]["sources"]):
        s["meta"]["sources"].append({"id": "market", "kind": "market", "url": "#/about",
                                     "title": "Ориентир по рынку: открытые данные других поставщиков категории", "fetched_at": TODAY})
