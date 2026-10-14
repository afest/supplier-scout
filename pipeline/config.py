"""Пути, город, формулировки запросов и словари конвейера."""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
CACHE = Path(__file__).resolve().parent / ".cache"   # промежуточные результаты стадий, в git не идут
RUNS = DATA / "runs"

CITY = "Екатеринбург"
CITY_REGION = "Свердловская область"
CITY_INN_PREFIX = "66"          # первые две цифры ИНН — код региона постановки на учёт

USER_AGENT = "Mozilla/5.0 (compatible; SupplierScoutBot/0.1; +https://github.com/afest/supplier-scout)"

RUB_PER_CREDIT = 0.5            # Kie: 200 кредитов = $1, курс 100 ₽/$

# Модели Kie
CLAUDE_MODEL = "claude-haiku-5-5"
GEMINI_MODEL = "gemini-3-8-flash"

# Поисковые формулировки по подкатегориям: короткая фраза вместо длинного названия из дерева.
SEARCH_TERMS = {
    "containers": "контейнеры для роллов и суши",
    "pizza-boxes": "коробки для пиццы",
    "bags": "крафт пакеты для доставки еды",
    "fish-sushi": "рыба для суши лосось",
    "seafood": "креветки и морепродукты",
    "mozzarella": "сыр моцарелла для пиццы",
    "cream-cheese": "сливочный сыр для роллов",
    "rice": "рис для суши",
    "nori": "нори для суши",
    "sauces": "соусы и васаби для суши",
}

# Три формулировки на подкатегорию (логика сервиса, раздел 6, шаг 1).
QUERY_TEMPLATES = [
    "{term} оптом {city}",
    "поставщик {term} для ресторанов {city}",
    "{term} HoReCa {city}",
]

# Домены, которые заведомо не поставщики: карты, каталоги, маркетплейсы, соцсети, СМИ.
# Каталоги и карты к тому же запрещают сбор (логика сервиса, раздел 3) — их не открываем вовсе.
NOT_SUPPLIER_DOMAINS = {
    "2gis.ru": "карты", "yandex.ru": "поисковик", "ya.ru": "поисковик", "google.com": "поисковик",
    "avito.ru": "доска объявлений", "ozon.ru": "маркетплейс", "wildberries.ru": "маркетплейс",
    "market.yandex.ru": "маркетплейс", "sima-land.ru": "маркетплейс", "vkusvill.ru": "розница",
    "hh.ru": "вакансии", "rabota.ru": "вакансии", "superjob.ru": "вакансии", "zarplata.ru": "вакансии",
    "optlist.ru": "каталог", "regtorg.ru": "каталог", "milknet.ru": "каталог", "productcenter.ru": "каталог",
    "pulscen.ru": "каталог", "tiu.ru": "каталог", "supl.biz": "каталог", "postavshhiki.ru": "каталог",
    "b2b-center.ru": "каталог", "spravker.ru": "справочник", "yopt.ru": "каталог", "tradedir.ru": "каталог",
    "fishretail.ru": "каталог", "allbiz.ru": "каталог", "flagma.ru": "каталог", "satu.kz": "каталог",
    "rusprofile.ru": "справочник компаний", "list-org.com": "справочник компаний", "checko.ru": "справочник компаний",
    "zachestnyibiznes.ru": "справочник компаний", "audit-it.ru": "справочник компаний",
    "vk.com": "соцсеть", "ok.ru": "соцсеть", "t.me": "мессенджер", "youtube.com": "видео", "rutube.ru": "видео",
    "dzen.ru": "блоги", "wikipedia.org": "энциклопедия", "e1.ru": "СМИ", "restoclub.ru": "ресторанный гид",
    "apps.apple.com": "магазин приложений", "play.google.com": "магазин приложений",
    "habr.com": "статьи", "vc.ru": "статьи", "pikabu.ru": "статьи", "otzovik.com": "отзывы", "irecommend.ru": "отзывы",
    "chibbis.ru": "статьи агрегатора доставки", "infoyar.ru": "справочник", "regmarkets.ru": "сравнение цен",
    "yamart.ru": "сравнение цен", "agroserver.ru": "доска объявлений", "foodsuppliers.ru": "каталог",
    "fishnet.ru": "каталог", "milknet.biz": "каталог", "yopt.org": "каталог",
}

# Ссылки, ради которых открываем внутренние страницы сайта (логика, раздел 6, шаг 3).
PAGE_HINTS = [
    ("контакт", 10), ("contact", 10), ("реквизит", 9), ("requisit", 9), ("rekvizit", 9),
    ("доставк", 9), ("delivery", 9), ("dostavk", 9), ("оплат", 6), ("payment", 6), ("oplat", 6),
    ("оптов", 7), ("опт", 5), ("horeca", 8), ("ресторан", 7), ("юрлиц", 7), ("partner", 4), ("сотруднич", 6),
    ("о компании", 6), ("about", 5), ("o-kompanii", 6), ("company", 4),
    ("сертификат", 6), ("документ", 5), ("certificat", 6), ("декларац", 6),
    ("прайс", 7), ("price", 7), ("оферт", 5), ("offer", 4), ("политик", 3), ("privacy", 3), ("policy", 3),
    ("условия", 5), ("conditions", 4), ("как купить", 5), ("как заказать", 5), ("faq", 2),
]
MAX_PAGES = 6                   # главная + до пяти внутренних
PAGE_TEXT_CAP = 12_000          # знаков текста со страницы в модель
JINA_MIN_TEXT = 500             # меньше — сайт на JS, повтор через Jina Reader

CACHE_TTL_REGISTRY_DAYS = 7     # реестры по ИНН не дёргаем чаще раза в неделю


def load_categories() -> dict:
    return json.loads((DATA / "categories.json").read_text(encoding="utf-8"))
