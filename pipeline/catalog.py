"""Ассортимент поставщика (T-535): всё, что он продаёт, а не 3–5 примеров из поля `products`.

Источники по надёжности:
1. прайс-лист xlsx — таблица разбирается кодом, без модели: строка с названием и ценой — позиция, строка
   с одним текстом — заголовок группы;
2. страницы каталога и прайс-лист PDF — модель называет позиции и разделы, код оставляет только те, что
   дословно стоят на странице, и цену — только если она стоит рядом с названием. Меню сайта повторяется на каждой
   странице, поэтому со страниц разделов в модель уходят только строки, которых нет на главной;
3. сайт без каталога — то же по главной: разделы меню и товары, которые на ней названы.

Модель не пишет названий от себя: всё, чего нет на странице символ в символ (после нормализации кавычек, тире,
регистра и пробелов), отбрасывается и попадает в отчёт прогона.
"""
from __future__ import annotations

import json
import re
from datetime import date
from urllib.parse import urlparse

from .config import ASSORTMENT_LIMIT, CACHE, CATALOG_PAGES, PRICE_FILES
from .extract import loose, near, norm
from .fetch import Fetcher, host_of

CATALOG_DIR = CACHE / "catalog"     # оплаченный ответ модели — на диск до проверки; правка правил его не тратит

PRICE_FILE = re.compile(r"\.(xlsx|pdf)(\?|$)", re.I)
PRICE_HINT = re.compile(r"прайс|прейскурант|price|prajs|prais|каталог|catalog|katalog|ассортимент|assortiment|продукц|produkc", re.I)
NOT_PRICE = re.compile(r"privacy|polic|politik|политик|agreement|soglash|соглаш|oferta|offer|оферт|cookie|invoice|rekvizit|реквизит|"
                       r"pravila|правила|licen|лиценз|sertifikat|сертификат|deklar|деклар|rekomend|рекоменд|dogovor|договор|"
                       r"anket|анкет|instrukc|инструкц|personal|персонал|kartochka|карточк|soglasie|согласи", re.I)
CATALOG_PATH = re.compile(r"/(catalog|katalog|catalogue|product-category|product_category|products?|shop|produkc\w*|produkt\w*|"
                          r"produk\w*|assortiment|assortment|tovary?|goods|collections?|category|categories|kategori\w*|"
                          r"каталог|продукция|ассортимент)(/|$|\.)", re.I)
CATALOG_WORD = re.compile(r"каталог|продукци|ассортимент|товары|прайс", re.I)
SKIP_URL = re.compile(r"[?&](sort|order|orderby|page|PAGEN_\d+|sel|filter|set_filter|view|display|limit|q|s|search|add-to-cart|"
                      r"action|utm_\w+)=|/(personal|cart|basket|korzina|compare|favorites?|wishlist|login|auth|register|search|"
                      r"poisk|blog|news|novosti|stati|articles?|vacanc\w*|vakans\w*|akcii|actions|reviews|otzyvy|contacts?|kontakty|"
                      r"about|o-kompanii|dostavka|delivery|oplata|payment)(/|$)|compare\.php|"
                      r"\.(jpe?g|png|gif|webp|svg|pdf|xlsx?|docx?|zip)(\?|$)", re.I)
JUNK = re.compile(r"^(в корзину|подробнее|купить|заказать|новинка|новинки|хит|хит продаж|акция|акции|скидка|распродажа|каталог|"
                  r"главная|все товары|все категории|показать ещ[её]|смотреть все|в наличии|нет в наличии|под заказ|избранное|"
                  r"сравнить|шт|кор|уп)$|^(каталог|прайс|скачать)\b")      # «Каталог HoReCa», «Прайс-лист» — файлы, а не товары
GROUP_JUNK = re.compile(r"^(каталог|каталог товаров|каталог продукции|продукция|товары|главная|популярн\w*( товары| продукция)?|"
                        r"новинки|хиты продаж|все товары)$")
# Уценка, распродажа, акции: цена там временная или за брак, а в карточке читалась бы как обычная (правки Павла 14.10,
# ревью Дир 61). Слово — только с начала слова: «фракция» и «транзакция» не акция.
SALE_SECTION = re.compile(r"(?<![а-яёa-z])(уцен|распрод|ликвид|скидк|акци|спецпредлож|спец\.?\s*предлож|дисконт|outlet|sale\b)"
                          r"|(скидк\w*|минус|[-−–])\s*\d{1,2}\s*%")
SALE_ITEM = re.compile(r"(?<![а-яёa-z])(уцен|распрод|ликвид)")
SALE_URL = re.compile(r"/(sale|rasprodazh\w*|ucen\w*|utsen\w*|uts?enen\w*|skidk\w*|discount\w*|outlet|likvid\w*|akci\w*|aktsi\w*|"
                      r"specpredlozh\w*|spetspredlozh\w*)(/|$|\.|-)", re.I)


def is_sale(*texts: str | None) -> bool:
    return any(t and SALE_SECTION.search(norm(t)) for t in texts)


def clean_group(g: str | None) -> str | None:
    """Группа — короткое название раздела. Заголовок-предложение («Мы производим упаковку различного назначения:»)
    и пустое «Каталог» группой не считаются."""
    if not g:
        return None
    g = " ".join(g.split()).rstrip(" :")
    if len(g) > 60 or GROUP_JUNK.match(norm(g)) or len(g.split()) > 7:
        return None
    return g


# ---------- что открывать ----------

def _depth(url: str) -> int:
    return len([p for p in urlparse(url).path.split("/") if p])


def discover(home: dict, seen: list[dict]) -> tuple[list[str], list[dict], int]:
    """→ (прайс-листы, страницы каталога [{url, group}], сколько разделов осталось неоткрытыми)."""
    base = host_of(home.get("final_url") or home["url"])
    home_url = (home.get("final_url") or home["url"]).rstrip("/")
    files: list[str] = []
    for p in [home] + seen:
        for l in p.get("links", []):
            u, t = l["url"], l.get("text") or ""
            if (PRICE_FILE.search(u) and base in host_of(u) and (PRICE_HINT.search(u) or PRICE_HINT.search(t))
                    and not NOT_PRICE.search(u + " " + t) and u not in files):
                files.append(u)
    cats: dict[str, dict] = {}
    for l in home.get("links", []):
        u = l["url"].split("#")[0]
        t = " ".join((l.get("text") or "").split())[:80]
        if host_of(u) != base or SKIP_URL.search(u) or SALE_URL.search(u) or is_sale(t) or u.rstrip("/") == home_url:
            continue        # разделы уценки и акций не открываем: их позиции в ассортимент всё равно не идут
        if not (CATALOG_PATH.search(urlparse(u).path) or CATALOG_WORD.search(t)):
            continue
        key = u.rstrip("/")
        if key not in cats or (t and not cats[key]["group"]):
            cats[key] = {"url": u, "group": t if re.search(r"[а-яa-z]{3}", t.lower()) else None}
    # корень каталога и разделы верхнего уровня первыми — шире охват; порядок внутри уровня — как в меню сайта
    order = sorted(cats.values(), key=lambda c: _depth(c["url"]))
    return files[:PRICE_FILES], order[:CATALOG_PAGES], max(0, len(order) - CATALOG_PAGES)


# ---------- прайс-лист xlsx: без модели ----------

HEADER_NAME = re.compile(r"наименован|название|номенклатур|товар|продукц|позици|описание")
HEADER_PRICE = re.compile(r"цена|стоим|руб|прайс|опт")
HEADER_UNIT = re.compile(r"ед\.?\s*изм|единиц|фасовк|упак")


def xlsx_items(rows: list) -> list[dict]:
    """Позиции прайса по строкам таблицы (fetch.xlsx_rows): под шапкой «Наименование … Цена» строка с названием —
    позиция, строка с одним текстом и без чисел — заголовок группы. None в списке — граница листа."""
    items: list[dict] = []
    name_col = price_col = unit_col = group = None
    for cells in rows:
        if cells is None:                       # новый лист — шапку ищем заново
            name_col = price_col = unit_col = group = None
            continue
        texts = {j: str(c).strip() for j, c in enumerate(cells) if isinstance(c, str) and c.strip()}
        nums = {j: c for j, c in enumerate(cells) if isinstance(c, (int, float)) and not isinstance(c, bool)}
        if name_col is None:
            low = {j: t.lower() for j, t in texts.items()}
            nj = next((j for j, t in low.items() if HEADER_NAME.search(t) and len(t) < 40), None)
            if nj is not None:
                name_col = nj
                price_col = next((j for j, t in low.items() if j != nj and HEADER_PRICE.search(t)), None)
                unit_col = next((j for j, t in low.items() if j != nj and HEADER_UNIT.search(t)), None)
            continue
        name = texts.get(name_col)
        if name and len(texts) == 1 and not nums:
            if re.search(r"[а-яa-z]{3}", name.lower()) and len(name) <= 80:
                group = name
            continue
        if not name or not re.search(r"[а-яa-z]{3}", name.lower()):
            continue
        price = None
        pv = cells[price_col] if price_col is not None and price_col < len(cells) else None
        if isinstance(pv, (int, float)) and not isinstance(pv, bool) and pv > 0:
            unit = texts.get(unit_col) if unit_col is not None else None
            price = f"{pv:g} ₽" + (f"/{unit}" if unit else "")       # число и единица — из ячеек той же строки
        elif isinstance(pv, str) and re.search(r"\d", pv):
            price = pv.strip()
        items.append({"name": " ".join(name.split()), "group": group, "price": price})
    return items


# ---------- страницы каталога и PDF: модель называет, код проверяет ----------

ASSORTMENT_TOOL = {
    "name": "record_assortment",
    "description": "Записать ассортимент поставщика по тексту страниц его сайта.",
    "input_schema": {"type": "object", "properties": {
        "sections": {"type": "array", "description": "Разделы каталога — виды товаров из меню или каталога: «Молочные продукты», "
                                                     "«Коробки для пиццы». Только то, что продаётся; не «О компании», «Доставка», «Акции».",
                     "items": {"type": "object", "properties": {
                         "name": {"type": "string", "description": "как на странице, символ в символ"},
                         "parent": {"type": ["string", "null"], "description": "раздел верхнего уровня, если он виден"}},
                         "required": ["name", "parent"]}},
        "products": {"type": "array", "description": f"Конкретные товары: названия карточек каталога или строк прайса. Не больше "
                                                     f"{ASSORTMENT_LIMIT} на весь ответ и не больше 30 с одной страницы.",
                     "items": {"type": "object", "properties": {
                         "name": {"type": "string", "description": "название как на странице, символ в символ, без цены"},
                         "group": {"type": ["string", "null"], "description": "заголовок раздела или группы прайса над товаром, как на странице"},
                         "price": {"type": ["string", "null"], "description": "цена рядом с товаром, как на странице: «110 ₽/шт», «2370»"},
                         "page": {"type": "string", "description": "P1, P2…"}},
                         "required": ["name", "group", "price", "page"]}}},
        "required": ["sections", "products"]},
}

PROMPT = """Сайт поставщика для ресторанов: {host}. Ниже — текст его страниц: главная (P1 — на ней меню сайта), разделы каталога и прайс-листы. Со страниц разделов убраны строки, которые повторяют главную (меню, шапка, подвал).

Перечисли, что поставщик продаёт:
- sections — разделы каталога и виды товаров;
- products — конкретные товары с названием, как в карточке или строке прайса.

Правила: копируй названия символ в символ, как они стоят в тексте, ничего не дописывай и не исправляй. Цену бери, только если она стоит рядом с товаром. Не включай кнопки и служебные строки («В корзину», «Подробнее», «Новинка», сортировки), пункты меню вроде «Доставка», «О компании», «Контакты». Товаров — не больше {limit} на весь ответ и не больше 30 с одной страницы: лучше по несколько из каждого раздела, чем все из первого.

{pages}

Запиши ответ инструментом record_assortment."""


def _lines(text: str) -> list[str]:
    return [l.strip() for l in (text or "").split("\n") if l.strip()]


def prompt_pages(home: dict, listing: list[dict], pdfs: list[dict], cap_total: int = 30_000) -> tuple[str, list[dict], bool]:
    """Текст для модели: главная целиком, разделы — без строк главной, PDF — как есть. → (текст, страницы P1…, обрезано ли)."""
    home_set = {norm(l) for l in _lines(home.get("text", ""))}
    # Меню раздела на сайте шире, чем на главной: строка, которая повторяется на нескольких страницах разделов, —
    # навигация; она остаётся только на первой странице, где встретилась.
    shown: set[str] = set()
    useful = lambda l: len(l) <= 300 and re.search(r"[а-яa-z]{3}", l.lower())
    listing_lines = []
    for p, g in listing:
        keep = []
        for l in _lines(p.get("text", "")):
            n = norm(l)
            if n in home_set or not useful(l) or (n in shown and not re.search(r"\d", n)):    # цены повторяются у разных товаров
                continue
            shown.add(n)
            keep.append(l)
        listing_lines.append((p, g, keep, 6_000))
    blocks, pages, total, cut = [], [], 0, False
    entries = [(home, None, [l for l in _lines(home.get("text", "")) if useful(l)], 9_000)]
    entries += listing_lines
    entries += [(p, None, _lines(p.get("text", "")), 12_000) for p in pdfs]
    for p, group, lines, cap_page in entries:
        body = "\n".join(lines)
        if len(body) > cap_page:
            body, cut = body[:cap_page], True
        if total + len(body) > cap_total:
            body, cut = body[: max(0, cap_total - total)], True
        if not body.strip():
            continue
        total += len(body)
        pages.append({**p, "group": group})
        head = f"=== P{len(pages)} | {p.get('final_url') or p['url']}" + (f" | раздел: {group}" if group else "")
        blocks.append(f"{head}\n{body}")
    return "\n\n".join(blocks), pages, cut


def verify(answer: dict, pages: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """→ (товары, разделы, отброшенное). Название и раздел — дословно на странице; цена — рядом с названием."""
    norms = [norm(p.get("text", "")) for p in pages]
    rejected: list[dict] = []

    def where(name: str, hint: str | None = None) -> int | None:
        n = norm(name)
        if len(n) < 3 or not re.search(r"[а-яa-z]{2}", n) or JUNK.match(n) or len(n) > 200:
            return None
        if hint and re.fullmatch(r"P\d+", hint):
            i = int(hint[1:]) - 1
            if 0 <= i < len(norms) and n in norms[i]:
                return i
        return next((i for i, t in enumerate(norms) if n in t), None)

    products = []
    for x in (answer or {}).get("products") or []:
        if not isinstance(x, dict) or not isinstance(x.get("name"), str):
            continue
        i = where(x["name"], x.get("page"))
        if i is None:
            rejected.append({"field": "assortment", "value": x.get("name"), "why": "названия нет на странице"})
            continue
        price = x.get("price") if isinstance(x.get("price"), str) and re.search(r"\d", x.get("price") or "") else None
        if price and not near(norms[i], x["name"], price, before=60, after=300):
            rejected.append({"field": "assortment.price", "value": f"{x['name']}: {price}", "why": "цены нет рядом с названием"})
            price = None
        group = x.get("group") if isinstance(x.get("group"), str) and norm(x["group"]) in norms[i] else None
        raw_group = x.get("group") if isinstance(x.get("group"), str) else None
        if (is_sale(raw_group, pages[i].get("group")) or SALE_ITEM.search(norm(x["name"]))
                or SALE_URL.search(pages[i].get("final_url") or pages[i].get("url") or "")):
            rejected.append({"field": "assortment.sale", "value": f"{raw_group or pages[i].get('group') or '—'}: {x['name']}",
                             "why": "раздел уценки, распродажи или акций — цена временная"})
            continue
        products.append({"name": " ".join(x["name"].split()), "group": group or pages[i].get("group"), "price": price, "page": i})
    sections = []
    for x in (answer or {}).get("sections") or []:
        if not isinstance(x, dict) or not isinstance(x.get("name"), str):
            continue
        i = where(x["name"])
        if i is None:
            rejected.append({"field": "assortment.section", "value": x.get("name"), "why": "раздела нет на странице"})
            continue
        if is_sale(x["name"], x.get("parent") if isinstance(x.get("parent"), str) else None):
            rejected.append({"field": "assortment.sale", "value": x["name"], "why": "раздел уценки, распродажи или акций — цена временная"})
            continue
        parent = x.get("parent") if isinstance(x.get("parent"), str) and where(x["parent"]) is not None else None
        sections.append({"name": " ".join(x["name"].split()), "group": parent, "price": None, "page": i})
    return products, sections, rejected


def assemble(products: list[dict], sections: list[dict], limit: int = ASSORTMENT_LIMIT) -> tuple[list[dict], int]:
    """Товары — по очереди со всех страниц, чтобы лимит не съел все разделы, кроме первого; потом разделы,
    которых нет среди групп товаров. → (позиции, сколько увидели всего)."""
    seen, by_page = set(), {}
    for p in products:
        k = norm(p["name"])
        if k not in seen:
            seen.add(k)
            by_page.setdefault(p.get("page", 0), []).append(p)
    queues = list(by_page.values())
    ordered = []
    while any(queues):
        for q in queues:
            if q:
                ordered.append(q.pop(0))
    groups = {norm(p["group"]) for p in ordered if p.get("group")}
    for s in sections:
        k = norm(s["name"])
        if k not in seen and k not in groups:
            seen.add(k)
            ordered.append(s)
    items = [{"name": x["name"], "group": clean_group(x.get("group")), "price": x.get("price")} for x in ordered]
    return items[:limit], len(items)


# ---------- сайт целиком ----------

def collect(kie, fetcher: Fetcher, host: str, home: dict, seen: list[dict], offline: bool = False) -> dict:
    """Ассортимент одного сайта. Запись — в CATALOG_DIR/<host>.json: страницы, ответ модели, позиции xlsx."""
    path = CATALOG_DIR / f"{host}.json"
    cached = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    if cached and (cached.get("answer") is not None or cached.get("xlsx") or offline):
        return rebuild(cached, fetcher)
    if offline:
        return {"host": host, "error": "ассортимент не собирался (прогон офлайн)", "pages": []}
    files, listing, unopened = discover(home, seen)
    rec = {"host": host, "extracted_at": date.today().isoformat(), "unopened_sections": unopened, "answer": None,
           "files": [], "listing": [], "xlsx": [], "error": None}
    xlsx_items_all, pdfs = [], []
    for u in files:
        p = fetcher.page(u, full=True)
        if p.get("error") or not p.get("text"):
            rec["files"].append({"url": u, "error": p.get("error") or "пустой файл"})
            continue
        rec["files"].append({"url": p["final_url"], "kind": p["kind"], "fetched_at": p["fetched_at"]})
        if p["kind"] == "xlsx":
            xlsx_items_all += [{**x, "url": p["final_url"]} for x in xlsx_items(p.get("rows") or [])]
        elif p["kind"] == "pdf":
            pdfs.append(p)
    rec["xlsx"] = xlsx_items_all
    if len(xlsx_items_all) < 10:                          # прайса-таблицы нет или он пустой — каталог и PDF через модель
        opened = []
        for c in listing:
            p = fetcher.page(c["url"], full=True)
            rec["listing"].append({"url": p.get("final_url") or c["url"], "group": c["group"], "error": p.get("error"),
                                   "fetched_at": p.get("fetched_at")})
            if p.get("text") and not p.get("error"):
                opened.append((p, c["group"]))
        text, pages, cut = prompt_pages(home, opened, pdfs)
        rec["prompt_pages"] = [{"url": p.get("final_url") or p["url"], "group": p.get("group")} for p in pages]
        rec["cut"] = cut
        if pages:
            path.parent.mkdir(parents=True, exist_ok=True)
            rec["answer"] = kie.claude_tool(PROMPT.format(host=host, pages=text, limit=ASSORTMENT_LIMIT), ASSORTMENT_TOOL,
                                            label=f"assortment:{host}", max_tokens=8192)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rebuild(rec, fetcher)


def rebuild(rec: dict, fetcher: Fetcher) -> dict:
    """Проверка заново по сохранённому ответу и страницам из кэша — бесплатно."""
    out = {"host": rec["host"], "error": rec.get("error"), "items": [], "total_seen": 0, "from": None, "sources": [],
           "rejected": [], "truncated": False, "searched": []}
    files_ok = [f for f in rec.get("files", []) if not f.get("error")]
    out["searched"] = ([f"прайс-лист: {f['url']}" for f in files_ok]
                       + [f"каталог: {len(rec.get('listing', []))} стр." + (f", ещё {rec['unopened_sections']} разделов не открыто"
                                                                          if rec.get("unopened_sections") else "")]
                       if rec.get("listing") or files_ok else ["ни каталога, ни прайс-листа на главной не нашлось"])
    if len(rec.get("xlsx", [])) >= 10:
        items = rec["xlsx"]
        uniq, seen = [], set()
        for x in items:
            if is_sale(x.get("group")) or SALE_ITEM.search(norm(x["name"])):
                out["rejected"].append({"field": "assortment.sale", "value": f"{x.get('group') or '—'}: {x['name']}",
                                        "why": "раздел уценки, распродажи или акций — цена временная"})
                continue
            if norm(x["name"]) not in seen:
                seen.add(norm(x["name"]))
                uniq.append({"name": x["name"], "group": clean_group(x.get("group")), "price": x.get("price")})
        out.update(items=uniq[:ASSORTMENT_LIMIT], total_seen=len(uniq), truncated=len(uniq) > ASSORTMENT_LIMIT, **{"from": "pricelist"})
        out["sources"] = list(dict.fromkeys(x["url"] for x in items))
        return out
    if not rec.get("answer"):
        return out
    pages = []
    for pp in rec.get("prompt_pages", []):
        p = Fetcher.cached(pp["url"]) or {}
        pages.append({**p, "group": pp.get("group"), "url": pp["url"]})
    products, sections, rejected = verify(rec["answer"], pages)
    items, total = assemble(products, sections)
    used = sorted({x.get("page", 0) for x in products + sections})
    kinds = [pages[i].get("kind") for i in {x["page"] for x in products}] if products else []
    src_from = ("pricelist" if kinds and kinds.count("pdf") * 2 >= len(kinds)
                else "catalog" if any(i > 0 for i in {x["page"] for x in products}) else "site")
    out.update(items=items, total_seen=total, rejected=rejected, **{"from": src_from},
               truncated=total > ASSORTMENT_LIMIT or bool(rec.get("unopened_sections")) or bool(rec.get("cut")),
               sources=[pages[i]["url"] for i in used])
    return out
