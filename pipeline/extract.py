"""Шаги 2 и 4. Модель раскладывает текст страниц по полям, код проверяет каждое значение по тексту.

Правило конвейера: значение со слов поставщика принимается только с дословной цитатой, которая находится в тексте
загруженной страницы. Нет цитаты, цитата не нашлась, число в значении не совпадает с числом в цитате — значение
отбрасывается и поле становится «не найдено». Отброшенное пишется в отчёт прогона.
"""
from __future__ import annotations

import re

from .config import CITY

# ---------- нормализация и проверки ----------

_QUOTES = str.maketrans({"«": '"', "»": '"', "“": '"', "”": '"', "„": '"', "'": '"', "`": '"', "’": "'",
                         "–": "-", "—": "-", "‑": "-", "−": "-", "ё": "е", "Ё": "Е", "\xa0": " ", " ": " "})


def norm(s: str) -> str:
    s = (s or "").translate(_QUOTES).lower()
    s = re.sub(r"\s+", " ", s)
    return s.strip(" .,;:!-\"'")


def digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def quote_in(quote: str, text_norm: str) -> bool:
    q = norm(quote)
    if len(q) < 4:
        return False
    if q in text_norm:
        return True
    parts = [p.strip(" .,;:-") for p in re.split(r"\.\.\.|…", q)]
    parts = [p for p in parts if p]
    return len(parts) > 1 and all(len(p) >= 8 and p in text_norm for p in parts)


WORD_NUMS = {1: r"одн|один", 2: r"дв[аеу]", 3: r"тр[иё]", 5: r"пят", 10: r"десят"}


def _numbers(text: str) -> set[float]:
    """Числа текста в двух прочтениях: как написаны и со склеенными разрядами («5 000», «20,000», «1.000.000» → одно число).
    Склеиваются только группы по три цифры после первой группы из 1–3 цифр, поэтому «3000 650» остаются двумя числами."""
    t = (text or "").replace("\xa0", " ").replace(" ", " ")
    merged = re.sub(r"(?<![\d.,])(\d{1,3})((?:[ .,]\d{3})+)(?![\d])", lambda m: m.group(1) + re.sub(r"\D", "", m.group(2)), t)
    out = set()
    for src in (t, merged):
        for x in re.findall(r"\d+(?:[.,]\d+)?", src):
            try:
                out.add(float(x.replace(",", ".")))
            except ValueError:
                pass
    return out


def number_in(n: float | int | None, quote: str) -> bool:
    if n is None:
        return True
    target = float(n)
    nums = _numbers(quote)
    if target in nums or (re.search(r"тыс", quote or "", re.I) and target / 1000 in nums):
        return True
    word = WORD_NUMS.get(int(target)) if target == int(target) else None
    return bool(word and re.search(word, norm(quote)))


CITIES = (r"москв|мкад|подмосков|санкт|спб|петербург|краснодар|казан|новосибирск|нижн\w* новгород|"
          r"ростов|самар|воронеж|челябинск|перм|уф[аеы]\b|тюмен|омск|красноярск|владивосток")
OTHER_CITY = re.compile(rf"\b(для|по|в пределах|в)\s+({CITIES})", re.I)
CITY_NAMED = re.compile(rf"\b({CITIES})", re.I)
CITY_PAGE = re.compile(r"/(moskva|moscow|msk|spb|sankt-peterburg|piter|krasnodar|kazan|novosibirsk|rostov|samara|"
                       r"voronezh|chelyabinsk|perm|ufa|tyumen|omsk|krasnoyarsk|vladivostok)(/|$|\.)", re.I)
OUR_CITY = re.compile(r"екатеринбург|свердловск|\bекб\b")


def other_city(quote: str, value_text: str | None = None, page_url: str | None = None) -> str | None:
    """Условие для другого города: «Для Москвы — от 10 000 ₽» в цитате, «(Москва)» в значении, страница /delivery/moskva.
    Если Екатеринбург назван в цитате — условие общее."""
    q = norm(quote)
    if OUR_CITY.search(q):
        return None
    if OTHER_CITY.search(q):
        return "условие для другого города"
    v = norm(value_text or "")
    if v and CITY_NAMED.search(v) and not OUR_CITY.search(v):
        return "в значении назван другой город"
    if page_url and CITY_PAGE.search(page_url):
        return "условие со страницы другого города"
    return None


def _clauses(quote: str) -> list[str]:
    """Части цитаты между знаками препинания, разряды числа склеены. Точка после сокращения («руб.», «шт.») фразу не делит,
    и слитно с числом тоже: «от 10 000руб. доставка бесплатно» — одна часть («Морское счастье»)."""
    q = re.sub(r"(?<=\d)[ ,.](?=\d{3}(?!\d))", "", norm(quote))
    q = re.sub(r"(?<![а-яa-z])(руб|р|шт|кг|гр|г|ул|тыс|т\.р|д|стр|мин|макс|коп|уп|кор|ед)\.", r"\1", q)
    return [p.strip() for p in re.split(r"[;!?\n]|,(?!\d)|\.(?!\d)", q)]


def amount_clause(quote: str, amount) -> str | None:
    """Часть цитаты, где стоит число: в «Бесплатная доставка от 5000, минимальный заказ 3000» у 3000 это «минимальный заказ 3000»."""
    if amount is None:
        return None
    target = float(amount)
    for part in _clauses(quote):
        nums = _numbers(part)
        if target in nums or ("тыс" in part and target / 1000 in nums):
            return part
    return None


FREE_FROM_RX = re.compile(r"(?:от|свыше|более|больше)\s*(\d+(?:[.,]\d+)?)\s*(тыс\w*\s*)?(₽|руб|р\b|шт|кг)")
FREE_UNIT = {"₽": "RUB", "руб": "RUB", "р": "RUB", "шт": "pcs", "кг": "kg"}


def free_threshold(quote: str) -> dict | None:
    """Порог бесплатной доставки из фразы, где «бесплатно» и «от N» стоят в одной части: «При заказе от 10 000 руб. доставка
    бесплатно» → 10 000 ₽, «Бесплатно доставим заказ от 1000 шт» → 1000 шт. Порог в штуках и килограммах — отдельно
    от рублёвого: с закупкой в рублях его не сравнить (Уралпаксистем)."""
    for part in _clauses(quote):
        m = FREE_FROM_RX.search(part)
        # «в пределах 5 км от МКАД — покупки от 12000р бесплатная доставка» (RedFish): город назван не после «для / по / в»
        foreign = CITY_NAMED.search(part) and not OUR_CITY.search(part)
        if m and FREE_WORDS.search(part) and not foreign and not other_city(part):
            amount = float(m.group(1).replace(",", ".")) * (1000 if m.group(2) else 1)
            amount = int(amount) if amount == int(amount) else amount
            unit = FREE_UNIT[m.group(3)]
            text = f"{amount:,} ₽".replace(",", " ") if unit == "RUB" else f"от {amount:,} {m.group(3)}".replace(",", " ")
            return {"amount": amount, "unit": unit, "text": text}
    return None


# Слова, без которых цитата не подтверждает значение (ревью 14.10, В2)
HORECA_YES = re.compile(r"ресторан|кафе|horeca|хорека|общепит|юр\w*\.?\s*лиц|юрлиц|юридическ|организац|оптов|оптом|\bопт\b|b2b|"
                        r"предприят|корпоратив|бизнес|заведени|кейтер|отел|гостиниц|пиццер|кофейн|пекарн|столов|фаст-?фуд|"
                        r"\bбар|точ\w* питани|сетям|сетей|дилер|оптовик")
HORECA_NO = re.compile(r"только\s+(в\s+)?розниц|только\s+(для\s+)?физ|только\s+частн|только\s+населени|"
                       r"не\s+работаем\s+с\s+юр|не\s+продаем\s+юр|юр\w*\s+лиц\w*\s+не\s+обслуж")
DELIVERY_MARK = {
    "to_door": re.compile(r"доставк|доставля|доставим|привез|привоз|курьер|до двери|до адреса|до склада клиента|до точки|"
                          r"по адресу|развоз|отвез|экспедир"),
    "pickup": re.compile(r"самовывоз|забрать|заберите|со склада|пункт\w* выдач|выдач"),
    "transport_company": re.compile(r"транспортн|\bтк\b|сдэк|cdek|деловые линии|\bпэк\b|байкал|энерги|\bкит\b|\bжд\b|почт|"
                                    r"межгород|в регион|по росси|отправ"),
}
UNIT_MARK = {"RUB": re.compile(r"₽|руб|\bр\b|\bр\.|тыс|т\.?\s?р|сумм"), "kg": re.compile(r"кг|килограм|тонн|\bт\b"),
             "pcs": re.compile(r"шт|штук|единиц|\bед\b"),
             "box": re.compile(r"короб|\bкор\b|упаков|ящик|паллет|блок|кейс|пачк|\bмест")}
MIN_WORDS = re.compile(r"миним|парти|кратн|не менее|заказ\w*[^,;]{0,30}?\b(от|свыше|на сумму)\s*\d|сумм\w*[^,;]{0,30}заказ|"
                       r"закуп\w*\s+от|отгрузк\w*\s+от|от\s*\d+\s*(шт|кг|короб|упак|ящик|паллет|т\b|тонн|пачк|блок|ед)")
FREE_WORDS = re.compile(r"бесплатн|free")


def words_in(value: str, quote: str, share: float = 0.6) -> str | None:
    """Пересказ модели (адрес, условия оплаты, документы) сверяется с цитатой: все числа значения и не меньше 60%
    значимых слов. Слово сравнивается по первым пяти буквам: «сертификаты» ~ «сертифицирована»."""
    lq = loose(quote)
    merged = re.sub(r"(?<![\d.,])(\d{1,3})((?:[ .,]\d{3})+)(?![\d])", lambda m: m.group(1) + re.sub(r"\D", "", m.group(2)),
                    (value or "").replace("\xa0", " "))
    if not {float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", merged)} <= _numbers(quote):
        return "числа из значения нет в цитате"
    words = [w for w in loose(value).split() if len(w) >= 4 and not w.isdigit()]
    if words and sum(1 for w in words if w[:5] in lq) / len(words) < share:
        return "значение не совпадает с цитатой"
    return None


def near(text_norm: str, item: str, price: str, before: int = 150, after: int = 400) -> bool:
    """Цена стоит на странице рядом с названием товара — не у соседней позиции через экран."""
    key = norm(item)[:40]
    p = norm(price)
    pos = text_norm.find(key) if key else -1
    while pos != -1:
        if p in text_norm[max(0, pos - before): pos + len(key) + after]:
            return True
        pos = text_norm.find(key, pos + 1)
    return False


def loose(s: str) -> str:
    """Для названий товаров: без кавычек и знаков, размеры «145х105» и «145x105» одинаково."""
    s = re.sub(r"(?<=\d)\s*[хx×*]\s*(?=\d)", "x", norm(s))
    return re.sub(r"\s+", " ", re.sub(r"[^0-9a-zа-я]+", " ", s)).strip()


def inn_valid(inn: str) -> bool:
    d = [int(c) for c in inn]
    if len(d) == 10:
        k = [2, 4, 10, 3, 5, 9, 4, 6, 8]
        return sum(a * b for a, b in zip(k, d)) % 11 % 10 == d[9]
    if len(d) == 12:
        k1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        k2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        return (sum(a * b for a, b in zip(k1, d)) % 11 % 10 == d[10]
                and sum(a * b for a, b in zip(k2, d)) % 11 % 10 == d[11])
    return False


# Регион свободным текстом — к словам, которые понимает интерфейс (web/src/lib/score.ts, SERVES): «любой город России»
# без этого читался бы как «не возит в Екатеринбург». «7 городов России» — не вся Россия и сюда не попадает.
REGION_MAP = [
    (r"екатеринбург", "Екатеринбург"), (r"свердловск", "Свердловская область"),
    (r"урфо|урал|уральск", "Урал"),
    (r"всей росси|все регион|всех регион|во все регион|в любой регион|любой регион|по россии|вся россия|все города|"
     r"любо\w* город|в любую точку|по всей стран|вся страна|все субъект|"
     r"(всей|по|все\w*|любо\w*|вся)\s+(территори\w*\s+)?(рф|росси)|регион\w*\s+(рф|росси)|субъект\w*\s+(рф|росси)|"
     r"^россия$|^рф$",          # «вся центральная Россия» — не вся: между словами допускается только «территория»
     "вся Россия"),
]


def norm_region(v: str) -> str:
    low = norm(v)
    for pat, name in REGION_MAP:
        if re.search(pat, low):
            return name
    return v.strip()


# ---------- схема ответа модели ----------

def _fact(desc: str, value_type: dict | None = None) -> dict:
    return {"type": ["object", "null"], "description": desc + " null — если на страницах этого нет.",
            "properties": {"value": value_type or {"type": "string"},
                           "quote": {"type": "string", "description": "дословный фрагмент текста страницы, 4–25 слов, символ в символ"},
                           "page": {"type": "string", "description": "номер страницы: P1, P2…"}},
            "required": ["value", "quote", "page"]}


def _list_fact(desc: str, item: dict | None = None) -> dict:
    return {"type": ["object", "null"], "description": desc + " null — если на страницах этого нет.",
            "properties": {"values": {"type": "array", "items": item or {"type": "string"}},
                           "quote": {"type": "string"}, "page": {"type": "string"}},
            "required": ["values", "quote", "page"]}


REFS = {
    "container": "контейнер или коробка для роллов/суши, цена за штуку",
    "pizza-box": "коробка для пиццы, цена за штуку",
    "kraft-bag": "крафт-пакет, цена за штуку",
    "salmon": "лосось, сёмга или форель, цена за кг",
    "shrimp": "креветки, цена за кг",
    "mozzarella": "моцарелла, цена за кг",
    "cream-cheese": "сливочный или творожный сыр, цена за кг",
    "rice": "рис для суши, цена за кг",
    "nori": "нори, цена за упаковку",
    "soy-sauce": "соевый соус, цена за литр",
}


def supplier_tool(sub_ids: list[str]) -> dict:
    num = {"type": ["number", "null"]}
    return {
        "name": "record_supplier",
        "description": "Записать факты о компании, найденные в тексте страниц её сайта.",
        "input_schema": {
            "type": "object",
            "properties": {
                "is_supplier": {"type": "boolean", "description": "true — компания сама продаёт эти товары ресторанам, кафе или юрлицам (производитель, оптовик, дистрибьютор, оптово-розничный магазин). false — агрегатор, каталог компаний, маркетплейс, розница только для частных лиц, ресторан, статья."},
                "not_supplier_reason": {"type": ["string", "null"], "description": "если is_supplier=false — коротко почему"},
                "brand": {"type": "string", "description": "название компании, как на сайте"},
                "subcategories": {"type": "array", "items": {"type": "string", "enum": sub_ids},
                                  "description": "какие из подкатегорий компания продаёт — по каталогу и тексту страниц"},
                "products": _list_fact("Примеры товаров из подкатегорий выше, 3–5 штук, названия как на сайте."),
                "legal_name": _fact("Юрлицо или ИП: «ООО …», «ИП …»."),
                "inn": _fact("ИНН компании, 10 или 12 цифр."),
                "ogrn": _fact("ОГРН или ОГРНИП."),
                "city_address": _fact(f"Адрес склада, пункта выдачи, офиса, магазина или производства в городе {CITY}. Адрес в другом городе сюда не писать."),
                "city_address_kind": {"type": ["string", "null"], "enum": ["склад", "пункт выдачи", "офис", "магазин", "производство", None]},
                "home_city": _fact(f"Если склада или офиса в {CITY} нет — город, где они есть."),
                "regions_served": _list_fact("Куда компания доставляет или где работает: до 6 значений — города, области, «вся Россия»."),
                "phones": _list_fact("Телефоны компании (не сотрудников поимённо)."),
                "emails": _list_fact("Email компании."),
                "messengers": _list_fact("Мессенджеры: Telegram, WhatsApp, Viber, VK, MAX — по ссылкам или тексту."),
                "works_with_horeca": _fact("Работает ли с ресторанами, кафе, HoReCa или юрлицами.", {"type": "boolean"}),
                "min_order": _fact("Минимальный заказ или минимальная партия. НЕ путать с порогом бесплатной доставки.",
                                   {"type": "object", "properties": {"amount": num, "unit": {"type": "string", "enum": ["RUB", "kg", "pcs", "box"]},
                                                                     "text": {"type": "string", "description": "коротко: «5 000 ₽», «от 10 кг»"}},
                                    "required": ["amount", "unit", "text"]}),
                "prices": _fact("Как показаны цены: pricelist — цены на сайте или прайс-лист; partial — у части товаров; on_request — «по запросу»; after_login — после входа или регистрации.",
                                {"type": "object", "properties": {
                                    "mode": {"type": "string", "enum": ["pricelist", "partial", "on_request", "after_login"]},
                                    "pricelist_url": {"type": ["string", "null"], "description": "ссылка на файл прайса, если есть на странице"},
                                    "examples": {"type": "array", "description": "до 3 цен товаров из подкатегорий, как на сайте", "items": {
                                        "type": "object", "properties": {
                                            "item": {"type": "string"}, "price": {"type": "string", "description": "как на сайте: «от 7 ₽/шт», «1 450 ₽/кг»"},
                                            "ref": {"type": ["string", "null"], "enum": list(REFS) + [None], "description": "; ".join(f"{k} — {v}" for k, v in REFS.items())},
                                            "unit_price": {**num, "description": "число из цены, если она указана за единицу из ref"},
                                            "quote": {"type": "string"}, "page": {"type": "string"}},
                                        "required": ["item", "price", "ref", "unit_price", "quote", "page"]}}},
                                 "required": ["mode", "pricelist_url", "examples"]}),
                "delivery": _fact(f"Условия доставки в {CITY}: до двери, порог бесплатной доставки в ₽, стоимость, срок, самовывоз, зоны, отправка транспортной компанией.",
                                  {"type": "object", "properties": {
                                      "to_door": {"type": "boolean"}, "free_from": num, "cost": num,
                                      "lead_time": {"type": ["string", "null"]}, "pickup": {"type": "boolean"},
                                      "zones": {"type": ["string", "null"]}, "transport_company": {"type": "boolean", "description": "везут транспортной компанией из другого города"}},
                                   "required": ["to_door", "free_from", "cost", "lead_time", "pickup", "zones", "transport_company"]}),
                "payment_terms": _fact("Оплата и отсрочка для юрлиц: безнал, НДС, отсрочка платежа."),
                "doc_mentions": _fact("Что сайт говорит о документах: сертификаты, декларации, Меркурий, ветеринарные документы, ХАССП."),
            },
            "required": ["is_supplier", "not_supplier_reason", "brand", "subcategories", "products", "legal_name", "inn", "ogrn",
                         "city_address", "city_address_kind", "home_city", "regions_served", "phones", "emails", "messengers",
                         "works_with_horeca", "min_order", "prices", "delivery", "payment_terms", "doc_mentions"],
        },
    }


SYSTEM = f"""Ты извлекаешь факты о поставщике продуктов или упаковки для ресторанов из текста страниц его сайта. Город закупщика — {CITY}.

Правила:
1. Только то, что написано на страницах. Не додумывай, не оценивай по рынку, не используй знания о компании.
2. У каждого значения — дословная цитата из текста страницы (4–25 слов, скопированная символ в символ, без пересказа) и номер страницы. Нет подходящей цитаты — ставь null.
3. Числа в значении должны стоять в цитате: «бесплатно от 5 000 ₽» → free_from 5000.
4. Минимальный заказ и порог бесплатной доставки — разные поля. «Бесплатная доставка от 10 000 ₽» — это delivery.free_from, а не min_order.
5. Условия доставки — для {CITY}. Если сайт пишет только про другой город — delivery null, а регионы и город склада запиши в regions_served и home_city.
6. Если страниц несколько и они противоречат друг другу — бери значение со страницы, где оно описано подробнее (доставка — со страницы доставки).
7. Телефоны и email — как на странице. Контакты конкретных сотрудников не записывай."""


def pages_block(pages: list[dict], cap_total: int = 32_000, cap_page: int = 9_000) -> str:
    out, total = [], 0
    for i, p in enumerate(pages, 1):
        body = p["text"][:cap_page]
        if total + len(body) > cap_total:
            body = body[: max(0, cap_total - total)]
        total += len(body)
        out.append(f"=== P{i} | {p['final_url']} | {p.get('title', '')[:120]}\n{body}")
    return "\n\n".join(out)


def build_prompt(host: str, pages: list[dict], categories: list[dict]) -> str:
    tree = "\n".join(f"- {c['name']}: " + "; ".join(f"{s['id']} — {s['name']}" for s in c["search_subcategories"]) for c in categories)
    return (f"Сайт: {host}\n\nПодкатегории, которые нас интересуют:\n{tree}\n\n"
            f"Страницы сайта ({len(pages)}):\n\n{pages_block(pages)}\n\nЗапиши факты инструментом record_supplier.")


# ---------- проверка ответа ----------

class Checked:
    """Проверенные факты одного сайта + отброшенные значения с причиной."""

    def __init__(self, pages: list[dict]):
        self.pages = pages
        self.norm = [norm(p["text"]) for p in pages]
        self.loose = [loose(p["text"]) for p in pages]
        self.dig = [digits(p["text"]) for p in pages]
        self.links = set()
        for p in pages:
            for l in p.get("links", []):
                self.links.add(l["url"])
        self.facts: dict = {}
        self.rejected: list[dict] = []
        self.page_url: str | None = None

    def _page_of(self, quote: str, hint: str | None) -> int | None:
        idx = None
        if hint and re.fullmatch(r"P\d+", hint or ""):
            i = int(hint[1:]) - 1
            if 0 <= i < len(self.pages) and quote_in(quote, self.norm[i]):
                return i
        for i, t in enumerate(self.norm):
            if quote_in(quote, t):
                return i
        return idx

    def reject(self, field: str, value, why: str):
        self.rejected.append({"field": field, "value": value, "why": why})

    def widen(self, i: int, quote: str, want, reach: int = 3) -> str | None:
        """Цитата, продлённая до ближайшей строки той же страницы, где стоит нужное значение: строки подряд, не дальше reach
        от цитаты. Дословность сохраняется — это кусок страницы целиком, а не склейка."""
        lines = [l.strip() for l in self.pages[i]["text"].split("\n")]
        nq = norm(quote)
        span = next(((j, j + w - 1) for w in range(1, 7) for j in range(len(lines) - w + 1)
                     if nq in norm(" ".join(lines[j:j + w]))), None)
        if not span:
            return None
        j, k = span
        near = sorted((f for f in range(max(j - reach, 0), min(k + reach, len(lines) - 1) + 1) if want(lines[f])),
                      key=lambda f: 0 if j <= f <= k else min(abs(f - j), abs(f - k)))
        if not near:
            return None
        wide = " ".join(l for l in lines[min(j, near[0]):max(k, near[0]) + 1] if l)
        return wide if len(wide) <= 600 and quote_in(wide, self.norm[i]) else None

    def fact(self, field: str, f: dict | None, check=None):
        if not f:
            return None
        quote = f.get("quote") or ""
        i = self._page_of(quote, f.get("page"))
        if i is None:
            self.reject(field, f.get("value"), "цитаты нет в тексте страниц")
            return None
        self.page_url = self.pages[i].get("final_url") or self.pages[i].get("url")    # для правила «страница другого города»
        if check:
            try:
                why = check(f["value"], quote)
            except (TypeError, ValueError, AttributeError, KeyError) as e:
                why = f"неожиданный формат значения: {type(e).__name__}"
            if why:
                self.reject(field, f.get("value"), why)
                return None
        out = {"value": f["value"], "quote": quote.strip(), "page": i}
        self.facts[field] = out
        return out


FACT_FIELDS = {"legal_name": str, "inn": str, "ogrn": str, "city_address": str, "home_city": str, "works_with_horeca": bool,
               "payment_terms": str, "doc_mentions": str, "min_order": dict, "delivery": dict, "prices": dict}
LIST_FIELDS = ["products", "regions_served", "phones", "emails", "messengers"]


def sanitize(ans: dict, c: Checked) -> dict:
    """Приводит ответ модели к ожидаемой форме; поле в другой структуре отбрасывается с причиной, а не роняет проверку."""
    out = dict(ans) if isinstance(ans, dict) else {}
    for k, typ in FACT_FIELDS.items():
        f = out.get(k)
        if f is None:
            continue
        ok = (isinstance(f, dict) and isinstance(f.get("quote"), str) and isinstance(f.get("value"), typ)
              and (f.get("page") is None or isinstance(f.get("page"), str)))
        if ok and typ is dict and k == "prices":
            exs = f["value"].get("examples")
            f["value"]["examples"] = [e for e in (exs if isinstance(exs, list) else [])
                                      if isinstance(e, dict) and isinstance(e.get("quote"), str) and isinstance(e.get("item"), str)]
        if not ok:
            c.reject(k, str(f)[:120], "неожиданный формат ответа")
            out[k] = None
    for k in LIST_FIELDS:
        f = out.get(k)
        if f is None:
            continue
        if isinstance(f, dict) and isinstance(f.get("values"), list):
            f["values"] = [v for v in f["values"] if isinstance(v, str) and v.strip()]
            f["quote"] = f.get("quote") if isinstance(f.get("quote"), str) else ""
        else:
            c.reject(k, str(f)[:120], "неожиданный формат ответа")
            out[k] = None
    return out


def check_answer(ans: dict, pages: list[dict]) -> Checked:
    c = Checked(pages)
    ans = sanitize(ans, c)

    def inn_check(v, q):
        d = digits(v)
        if not inn_valid(d):
            return "ИНН не проходит контрольную сумму"
        if d not in digits(q):
            return "ИНН нет в цитате"
        return None

    def name_check(v, q):
        words = [w for w in re.findall(r"[а-яa-z0-9]{3,}", norm(v)) if w not in ("ооо", "общество", "ограниченной", "ответственностью")]
        return None if words and all(w in norm(q) for w in words) else "название не совпадает с цитатой"

    def horeca_check(v, q):
        qn = norm(q)
        if v is True and HORECA_NO.search(qn):
            return "в цитате сказано обратное: только розница или частные лица"
        if v is True and not HORECA_YES.search(qn):
            return "в цитате нет слов про рестораны, юрлиц или опт"
        if v is False and not (HORECA_NO.search(qn) or re.search(r"не\s+работаем|не\s+продаем", qn)):
            return "в цитате нет отказа работать с юрлицами"
        return None

    c.fact("legal_name", ans.get("legal_name"), name_check)
    c.fact("inn", ans.get("inn"), inn_check)
    c.fact("ogrn", ans.get("ogrn"), lambda v, q: None if len(digits(v)) in (13, 15) and digits(v) in digits(q) else "ОГРН не совпадает с цитатой")
    c.fact("city_address", ans.get("city_address"), words_in)
    if "city_address" in c.facts:
        kind = ans.get("city_address_kind")
        # склад и производство — основание для «склад в городе»: тип адреса должен стоять на странице в цитате или
        # рядом с ней («Склад» заголовком над адресом), а не только в ответе модели
        fa = c.facts["city_address"]
        t = c.norm[fa["page"]]
        pos = t.find(norm(fa["quote"])[:40])
        around = t[max(0, pos - 200): pos + len(norm(fa["quote"])) + 100] if pos >= 0 else norm(fa["quote"])
        if kind in ("склад", "производство") and not re.search(r"склад|производств|цех|завод|фабрик|\bбаз[аеуы]\b|хранени", around):
            c.reject("city_address_kind", kind, "ни в цитате адреса, ни рядом с ней нет слов про склад или производство")
            kind = None
        c.facts["city_address"]["kind"] = kind
    c.fact("home_city", ans.get("home_city"))
    c.fact("works_with_horeca", ans.get("works_with_horeca"), horeca_check)
    # условия оплаты и документы — пересказ модели; шире цитаты («работают с НДС и без», которого в ней нет) —
    # значением становится сама цитата: она стоит на странице дословно и подтверждает себя сама
    for k in ("payment_terms", "doc_mentions"):
        got = c.fact(k, ans.get(k))
        if got:
            why = words_in(got["value"], got["quote"])
            if why:
                c.reject(k, got["value"], f"{why} — значением стала сама цитата")
                got["value"] = got["quote"]

    # списки: каждый элемент должен встречаться в тексте страниц
    prods = ans.get("products")
    if prods:
        def on_page(v: str) -> bool:     # название целиком или все его слова на одной странице
            lv = loose(v)
            words = [w for w in lv.split() if len(w) >= 3]
            return any(lv in lt or (words and all(re.search(rf"(?<![0-9a-zа-я]){re.escape(w)}", lt) for w in words)) for lt in c.loose)
        ok = [v for v in prods.get("values", []) if on_page(v)]
        for v in prods.get("values", []):
            if v not in ok:
                c.reject("products", v, "товара нет в тексте страниц")
        if ok:
            c.facts["products"] = {"value": ok, "quote": prods.get("quote", ""), "page": c._page_of(prods.get("quote", ""), prods.get("page")) or 0}

    phones = ans.get("phones")
    if phones:
        ok = []
        for v in phones.get("values", []):
            d = digits(v)[-10:]
            if len(d) == 10 and any(d in x for x in c.dig):
                ok.append(v)
            else:
                c.reject("phones", v, "номера нет на страницах")
        if ok:
            c.facts["phones"] = {"value": list(dict.fromkeys(ok)), "quote": None, "page": c._page_of(phones.get("quote", ""), phones.get("page")) or 0}

    emails = ans.get("emails")
    if emails:
        ok = []
        for v in emails.get("values", []):
            if "@" in v and any(v.lower().strip() in t for t in c.norm):
                ok.append(v.lower().strip())
            else:
                c.reject("emails", v, "адреса нет на страницах")
        if ok:
            c.facts["emails"] = {"value": list(dict.fromkeys(ok)), "quote": None, "page": c._page_of(emails.get("quote", ""), emails.get("page")) or 0}

    msg = ans.get("messengers")
    if msg:
        markers = {"telegram": ("t.me", "telegram"), "whatsapp": ("wa.me", "whatsapp", "ватсап", "вотсап"), "viber": ("viber", "вайбер"),
                   "vk": ("vk.com", "вконтакте"), "max": ("max.ru", "мессенджер max", "мессенджере max")}
        ok = []
        for v in msg.get("values", []):
            keys_ = next((m for k, m in markers.items() if k in norm(v)), (norm(v),))
            if any(any(k in t for k in keys_) for t in c.norm):
                ok.append(v)
            else:
                c.reject("messengers", v, "мессенджера нет на страницах")
        if ok:
            c.facts["messengers"] = {"value": ok, "quote": None, "page": 0}

    reg = ans.get("regions_served")
    if reg:
        i = c._page_of(reg.get("quote", ""), reg.get("page"))
        if i is None:
            c.reject("regions_served", reg.get("values"), "цитаты нет в тексте страниц")
        else:
            vals = list(dict.fromkeys(norm_region(v) for v in reg.get("values", []) if v))
            if vals:
                c.facts["regions_served"] = {"value": vals, "quote": reg["quote"].strip(), "page": i}

    free_as_min = []            # «Минимальная сумма — 20 000» модель записала порогом бесплатной доставки (Гросс Фуд)

    def min_check(v, q):
        amt = v.get("amount")
        if not number_in(amt, q):
            return "числа нет в цитате"
        part = amount_clause(q, amt) or norm(q)       # слова смотрим в той части фразы, где стоит число
        if amt and FREE_WORDS.search(part):          # проба T-510: порог бесплатной доставки выдавали за минимум
            free_as_min.append((amt, q))
            return "это порог бесплатной доставки, а не минимальный заказ"
        if not MIN_WORDS.search(part):
            return "в цитате нет слов про минимальный заказ"
        unit = v.get("unit") or "RUB"
        if unit in UNIT_MARK and not UNIT_MARK[unit].search(norm(q)):
            return "единица минимума не совпадает с цитатой"
        return None

    c.fact("min_order", ans.get("min_order"),
           lambda v, q: other_city(q, v.get("text"), c.page_url) or min_check(v, q))

    got = c.fact("delivery", ans.get("delivery"), lambda v, q: other_city(q, v.get("zones"), c.page_url))
    if got:                     # число, которого нет в цитате, обнуляется само, остальные условия доставки остаются
        v = dict(got["value"])
        # порог модель взяла с соседней строки, а цитату дала про тариф: «Морское счастье» — «до 3 000 руб. — 450 рублей»,
        # двумя строками ниже «от 10 000руб. доставка бесплатно». Цитата продлевается до этой строки, порог не теряется
        if v.get("free_from") and not number_in(v["free_from"], got["quote"]):
            want = v["free_from"]
            wide = c.widen(got["page"], got["quote"], lambda line: (free_threshold(line) or {}).get("amount") == want
                           and free_threshold(line)["unit"] == "RUB")
            if wide:
                got["quote"] = wide
        for k in ("free_from", "cost"):
            if v.get(k) is not None and not number_in(v[k], got["quote"]):
                c.reject(f"delivery.{k}", v[k], "числа нет в цитате")
                v[k] = None
        if v.get("free_from"):
            part = amount_clause(got["quote"], v["free_from"]) or norm(got["quote"])
            if not FREE_WORDS.search(part):
                why = ("это минимальный заказ, а не порог бесплатной доставки" if MIN_WORDS.search(part)
                       else "в цитате нет слов про бесплатную доставку")
                c.reject("delivery.free_from", v["free_from"], why)
                if MIN_WORDS.search(part) and "min_order" not in c.facts and UNIT_MARK["RUB"].search(part):
                    amt = v["free_from"]
                    c.facts["min_order"] = {"value": {"amount": amt, "unit": "RUB", "text": f"{amt:,.0f} ₽".replace(",", " ")},
                                            "quote": got["quote"], "page": got["page"]}
                    c.reject("min_order", amt, "перенесено из порога бесплатной доставки: в цитате минимальный заказ")
                v["free_from"] = None
        # да/нет в условиях доставки — только если в цитате есть слово про это
        for k, rx in DELIVERY_MARK.items():
            if v.get(k) and not rx.search(norm(got["quote"])):
                c.reject(f"delivery.{k}", True, "в цитате нет слов про это — не подтверждено")
                v[k] = False
        # срок и зоны — пересказ модели: оставляем, только если его значимые слова стоят на страницах сайта
        for k in ("lead_time", "zones"):
            txt = v.get(k)
            if txt:
                words = [w for w in loose(txt).split() if len(w) >= 4]
                hits = sum(1 for w in words if any(w[:6] in lt for lt in c.loose))
                if words and hits / len(words) < 0.6:
                    c.reject(f"delivery.{k}", txt, "слов из пересказа нет на страницах")
                    v[k] = None
        # порог, которого модель не записала, а в цитате он есть: рубли — в free_from, штуки и килограммы — в free_from_qty
        # (Уралпаксистем: «Бесплатно доставим заказ от 1000 шт» — рублёвое поле такой порог не держит, а терять его нельзя)
        # (неверное число модели не подменяем числом из цитаты — оно обнуляется, как раньше; добор — только когда порога в ответе нет)
        thr = free_threshold(got["quote"]) if v.get("to_door") and got["value"].get("free_from") is None else None
        if thr and thr["unit"] == "RUB":
            v["free_from"] = thr["amount"]
        elif thr:
            v["free_from_qty"] = thr
        # «доставка бесплатно» без суммы — порог 0, иначе интерфейс прочитает пустой порог как «платно»
        q = norm(got["quote"])
        if v.get("to_door") and v.get("free_from") is None and v.get("cost") is None and "бесплатн" in q and not re.search(r"\d", q):
            v["free_from"] = 0
        got["value"] = v
    elif free_as_min:           # обратный случай: порог бесплатной доставки модель записала минимумом, а доставку не нашла
        amt, q = free_as_min[0]
        i = c._page_of(q, None)
        if i is not None and DELIVERY_MARK["to_door"].search(norm(q)) and not other_city(q):
            c.facts["delivery"] = {"value": {"to_door": True, "free_from": amt, "cost": None, "lead_time": None, "pickup": False,
                                             "zones": None, "transport_company": False}, "quote": q.strip(), "page": i}
            c.reject("delivery", amt, "перенесено из минимального заказа: в цитате порог бесплатной доставки")

    pr = ans.get("prices")
    if pr:
        got = c.fact("prices", pr)
        if got:
            v = dict(got["value"])
            exs = []
            for ex in v.get("examples", []) or []:
                i = c._page_of(ex.get("quote", ""), ex.get("page"))
                price = str(ex.get("price") or "")
                price_nums = _numbers(price)
                if i is None:
                    c.reject("prices.examples", ex.get("item"), "цитаты нет в тексте страниц")
                elif not price_nums:
                    c.reject("prices.examples", ex.get("item"), "в цене нет числа")
                elif not (price_nums & _numbers(ex["quote"]) or near(c.norm[i], ex.get("item", ""), price)):
                    c.reject("prices.examples", ex.get("item"), "цены нет ни в цитате, ни рядом с товаром на странице")
                else:
                    exs.append({**ex, "page": i})
            v["examples"] = exs
            url = v.get("pricelist_url")
            if url and not any(url.rstrip("/") == l.rstrip("/") or url in l for l in c.links):
                c.reject("prices.pricelist_url", url, "ссылки нет на страницах")
                v["pricelist_url"] = None
            got["value"] = v
    return c
