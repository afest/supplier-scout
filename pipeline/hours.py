"""Режим работы и окно доставки (T-535) — без модели.

Маленькой точке в торговом центре важно, привезут ли до открытия или после 22:00. Фразы с часами и днями недели
со страниц сайта разбираются шаблонами: значение каждого поля — дословная фраза со страницы, поэтому цитата
подтверждает его по построению. Что не нашлось — null, а не догадка.
"""
from __future__ import annotations

import re

from .extract import CITY_NAMED, OUR_CITY, norm

# «с 9 до 18», «с 9:00 до 18:00», «9:00–18:00»; «с 1 до 3 дней» и «с 10 до 15 кг» — не часы
NOT_HOURS = r"(?!\s*(?:дн|день|дня|дней|сут|недел|мес|рабоч|кг|г\b|гр|шт|л\b|%|лет|раз|ед|позиц|тонн|т\b|упак|короб|см|мм|числ))"
TIME_RANGE = re.compile(r"\b[сc]\s*(\d{1,2})(?:[:.\-](\d{2}))?\s*(?:ч\.?|час\w*)?\s*до\s*(\d{1,2})(?:[:.\-](\d{2}))?(?![\d.,])" + NOT_HOURS +
                        r"|(?<![\d.,])(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})(?!\d)")
# «в рабочие дни» — дни недели; «в течение 2–3 рабочих дней» — срок, а не дни доставки, поэтому общего «рабочих дней» тут нет
DAYS = re.compile(r"\b(пн|вт|ср|чт|пт|сб|вс|понедельник\w*|вторник\w*|сред[аыу]|четверг\w*|пятниц\w*|суббот\w*|воскресень\w*|"
                  r"будн\w*|выходн\w*|ежедневно|без выходных|в рабочие дни|по рабочим дням)\b", re.I)
DAY_HOURS = re.compile(DAYS.pattern + r"\.?\s*[:,]?\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})(?![\d.,:]|\s*(кг|г|шт|мм|см|л|%))", re.I)
# «24/7» само по себе — часто название («Сеть магазинов 24/7») или поддержка; засчитывается рядом с работой и доставкой
ROUND = re.compile(r"круглосуточн|без перерыв\w* и выходн|ночью|в ночное время|"
                   r"(работаем|доставк\w*|доставля\w*|принима\w*|при[её]м\w*)[^.]{0,20}(24/7|24 часа)")
CUTOFF = re.compile(r"(заказ\w*|заявк\w*|оформ\w*)[^.;]{0,50}?\bдо\s*(\d{1,2})(?:[:.](\d{2}))?"
                    r"(?!\s*(?:кг|шт|₽|руб|т\b|тонн|\d|дн|день|дня|дней|сут|рабоч|недел|мес))")
DELIVERY = re.compile(r"доставк|доставля|доставим|привоз|привез|отгруз|курьер|развоз|рейс")
OFFICE = re.compile(r"режим работы|график работы|часы работы|время работы|работаем|офис|склад\b|склад работает|магазин|"
                    r"пункт\w* выдач|при[её]м заказ|при[её]м звонков|отдел продаж|менеджер|самовывоз")


def _sentences(text: str) -> list[str]:
    out = []
    for line in (text or "").split("\n"):
        line = line.strip()
        if not line:
            continue
        # предложение кончается точкой перед заглавной буквой: «9.00» и «ул. Ленина» его не рвут
        out += [s.strip() for s in re.split(r"(?<=[!?])\s+|(?<=\.)\s+(?=[А-ЯA-Z])", line) if s.strip()]
    return out


def _clip(s: str, m: re.Match, width: int = 160) -> str:
    """Длинная фраза — окно вокруг совпадения по границам слов; остаётся дословной подстрокой страницы."""
    if len(s) <= width:
        return s
    a = max(0, m.start() - 60)
    b = min(len(s), m.end() + 80)
    a = s.rfind(" ", 0, a) + 1 if a else 0
    b = s.find(" ", b) if s.find(" ", b) != -1 else len(s)
    return s[a:b].strip(" ,;")


def _ranges(s: str) -> list[tuple[re.Match, int, int]]:
    """Интервалы времени во фразе с правдоподобными часами: (совпадение, начало, конец)."""
    out = []
    for m in TIME_RANGE.finditer(s):
        a, b = (m.group(1), m.group(3)) if m.group(1) else (m.group(5), m.group(7))
        mins = [x for x in (m.group(2), m.group(4), m.group(6), m.group(8)) if x]
        if int(a) <= 24 and int(b) <= 24 and all(int(x) < 60 for x in mins):
            out.append((m, int(a), int(b)))
    for m in DAY_HOURS.finditer(s):
        a, b = int(m.group(2)), int(m.group(3))
        if a <= 24 and b <= 24 and a < b:
            out.append((m, a, b))
    return out


def _ends(s: str) -> list[int]:
    return [b for _, _, b in _ranges(s)]


def _cutoff(s: str) -> re.Match | None:
    n = norm(s)
    for m in CUTOFF.finditer(n):
        before = n[max(0, m.start(2) - 12): m.start(2)]
        pickup = re.search(r"выдач|самовывоз", n[max(0, m.start() - 15): m.start()])     # «выдача заказов до 16:00» — самовывоз
        if not re.search(r"\bс\s*\d{1,2}([:.]\d{2})?\s*(ч\.?|час\w*)?\s*до\s*$", before) and int(m.group(2)) <= 24 and not pickup:
            return m
    return None


def classify(s: str) -> dict[str, re.Match]:
    """Какие поля закрывает фраза: office, order_cutoff, delivery_days, delivery_window."""
    n = norm(s)
    rs = _ranges(n)
    has_time = rs[0][0] if rs else ROUND.search(n)
    out = {}
    # доставка и приём заказов по Москве («МСК: Доставка…», «за ЦКАД») закупщику из Екатеринбурга ничего не говорят
    elsewhere = (CITY_NAMED.search(n) or re.search(r"\bмск\b|цкад|мкад", n)) and not OUR_CITY.search(n)
    m = _cutoff(s)
    if m and not elsewhere:
        out["order_cutoff"] = m
    if DELIVERY.search(n):
        if elsewhere:
            return out
        if has_time:
            out["delivery_window"] = has_time
        d = DAYS.search(n)
        if d:
            out["delivery_days"] = d
    elif has_time and (DAYS.search(n) or OFFICE.search(n)):
        out["office"] = has_time
    return out


def page_kind(p: dict) -> str:
    hay = ((p.get("final_url") or p.get("url") or "") + " " + (p.get("title") or "")).lower()
    if re.search(r"контакт|contact|kontakt", hay):
        return "contacts"
    if re.search(r"доставк|delivery|dostavk|оплат|oplat|payment|услови", hay):
        return "delivery"
    return "other"


PRIORITY = {"office": ["contacts", "other", "delivery"], "order_cutoff": ["delivery", "other", "contacts"],
            "delivery_days": ["delivery", "other", "contacts"], "delivery_window": ["delivery", "other", "contacts"]}


def find_hours(pages: list[dict]) -> dict | None:
    """→ {"value": Hours, "quotes": [(фраза, № страницы)]} или None. pages — тексты страниц сайта (главная первой)."""
    cands: dict[str, list[tuple[int, int, str]]] = {}
    for i, p in enumerate(pages):
        kind = page_kind(p) if i else "other"
        for s in _sentences(p.get("text", "")):
            if len(s) > 600:
                continue
            for field, m in classify(s).items():
                rank = PRIORITY[field].index(kind)
                cands.setdefault(field, []).append((rank, i, _clip(s, m) if len(s) > 160 else s))
    if not cands:
        return None
    value = {"office": None, "order_cutoff": None, "delivery_days": None, "delivery_window": None, "evening_or_night": None}
    quotes = []
    for field in ("office", "order_cutoff", "delivery_days", "delivery_window"):
        if field in cands:
            rank, i, s = sorted(cands[field], key=lambda x: (x[0], x[1]))[0]
            value[field] = s
            if (s, i) not in quotes:
                quotes.append((s, i))
    # возят ли вечером или ночью — только по фразе про доставку: офис до 18:00 о машинах ничего не говорит
    win = " ".join(v for v in (value["delivery_window"], value["delivery_days"]) if v)
    if win:
        ends = _ends(norm(win))
        if ROUND.search(norm(win)) or any(e >= 20 or e <= 5 for e in ends):
            value["evening_or_night"] = True
        elif ends:
            value["evening_or_night"] = False
    return {"value": value, "quotes": quotes}
