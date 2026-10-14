"""Самопроверка правил, на которых держится «данные не выдуманы»: python -m pipeline.selftest

Без сети и без модели: на вход — готовые ответы и тексты страниц, на выход — что код принял и что отбросил.
"""
from __future__ import annotations

import sys

from .extract import check_answer, inn_valid, number_in, quote_in, norm
from .fetch import Robots

PAGE = {"final_url": "https://example.ru/delivery", "title": "Доставка", "links": [{"url": "https://example.ru/price.xlsx", "text": "Прайс"}],
        "text": "Доставка по Екатеринбургу — бесплатно от 5 000 ₽.\nМинимальная сумма заказа — 3 000 рублей.\n"
                "ООО «Пример», ИНН 7707083893\nТелефон: +7 (343) 226-09-36\nЦены по запросу\nНаписать в WhatsApp"}


def case(name: str, ok: bool):
    print(("✓ " if ok else "✗ ") + name)
    return ok


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    t = norm(PAGE["text"])
    res = [
        case("цитата находится с другими кавычками и тире", quote_in("Доставка по Екатеринбургу - бесплатно от 5 000 ₽", t)),
        case("пересказ вместо цитаты не проходит", not quote_in("Бесплатная доставка по городу от 5000 рублей", t)),
        case("число «5 000» в цитате совпадает с 5000", number_in(5000, "бесплатно от 5 000 ₽")),
        case("чужое число в цитате не совпадает", not number_in(7000, "бесплатно от 5 000 ₽")),
        case("«20,000 руб» — это 20 000", number_in(20000, "Минимальная сумма заказа для оптовых отгрузок - 20,000 руб")),
        case("«< 3000 650 > 3000» — 650 отдельно, разряды не склеены", number_in(650, "< 3000 650 > 3000 Бесплатно")),
        case("«1,8 кг» остаётся дробью", number_in(1.8, "Нерка, 1,8 - 2,3 кг") and not number_in(1800, "Нерка, 1,8 - 2,3 кг")),
        case("«от одной коробки» — это 1", number_in(1, "Минимальный заказ — от одной коробки")),
        case("ИНН с верной контрольной суммой", inn_valid("7707083893")),
        case("ИНН с неверной контрольной суммой", not inn_valid("6600001017")),
    ]
    ans = {
        "inn": {"value": "7707083893", "quote": "ООО «Пример», ИНН 7707083893", "page": "P1"},
        "min_order": {"value": {"amount": 5000, "unit": "RUB", "text": "5 000 ₽"}, "quote": "бесплатно от 5 000 ₽", "page": "P1"},
        "delivery": {"value": {"to_door": True, "free_from": 5000, "cost": None, "lead_time": None, "pickup": False, "zones": None,
                               "transport_company": False}, "quote": "Доставка по Екатеринбургу — бесплатно от 5 000 ₽", "page": "P1"},
        "payment_terms": {"value": "отсрочка 14 дней", "quote": "Отсрочка платежа 14 дней для сетей", "page": "P1"},
        "phones": {"values": ["+7 (343) 226-09-36", "+7 (343) 000-00-00"], "quote": "", "page": "P1"},
        "messengers": {"values": ["WhatsApp", "Telegram"], "quote": "", "page": "P1"},
        "prices": {"value": {"mode": "on_request", "pricelist_url": "https://example.ru/old-price.pdf", "examples": []},
                   "quote": "Цены по запросу", "page": "P1"},
    }
    c = check_answer(ans, [PAGE])
    why = {r["field"]: r["why"] for r in c.rejected}
    res += [
        case("ИНН принят", "inn" in c.facts),
        case("порог бесплатной доставки, выданный за минимальный заказ, отброшен", "min_order" not in c.facts and "порог" in why.get("min_order", "")),
        case("доставка с числом из цитаты принята", c.facts.get("delivery", {}).get("value", {}).get("free_from") == 5000),
        case("число доставки не из цитаты обнулено, остальное осталось",
             check_answer({"delivery": {"value": {"to_door": True, "free_from": 10000, "cost": None, "lead_time": None, "pickup": False,
                                                  "zones": None, "transport_company": False},
                                        "quote": "Доставка по Екатеринбургу — бесплатно от 5 000 ₽", "page": "P1"}}, [PAGE])
             .facts["delivery"]["value"] == {"to_door": True, "free_from": None, "cost": None, "lead_time": None, "pickup": False,
                                            "zones": None, "transport_company": False}),
        case("минимальный заказ «для Москвы» закупщику из Екатеринбурга не показывается",
             "min_order" not in check_answer({"min_order": {"value": {"amount": 10000, "unit": "RUB", "text": "10 000 ₽"},
                                                            "quote": "Для Москвы — от 10 000 рублей", "page": "P1"}},
                                             [{**PAGE, "text": PAGE["text"] + "\nДля Москвы — от 10 000 рублей. Для региональных клиентов — индивидуально"}]).facts),
        case("«доставка бесплатно» без суммы — порог 0, а не «платно»",
             check_answer({"delivery": {"value": {"to_door": True, "free_from": None, "cost": None, "lead_time": None, "pickup": False,
                                                  "zones": None, "transport_company": False},
                                        "quote": "Доставка до склада клиента абсолютно бесплатно", "page": "P1"}},
                          [{**PAGE, "text": "Доставка до склада клиента абсолютно бесплатно"}]).facts["delivery"]["value"]["free_from"] == 0),
        case("ответ модели в неожиданной форме не роняет проверку",
             not check_answer({"products": ["список вместо объекта"], "delivery": "строка"}, [PAGE]).facts),
        case("условие оплаты без цитаты на странице отброшено", "payment_terms" not in c.facts),
        case("телефона, которого нет на странице, нет в результате", c.facts["phones"]["value"] == ["+7 (343) 226-09-36"]),
        case("мессенджер без следа на странице отброшен", c.facts["messengers"]["value"] == ["WhatsApp"]),
        case("ссылка на прайс, которой нет на странице, убрана", c.facts["prices"]["value"]["pricelist_url"] is None),
    ]
    rb = Robots("User-agent: *\nDisallow: /?\nDisallow: /search\n\nUser-agent: SupplierScoutBot\nDisallow: /private\n")
    rb2 = Robots("User-agent: *\nDisallow: /?\nDisallow: *test\n")
    res += [
        case("robots: «Disallow: /?» не закрывает главную", rb2.allowed("SupplierScoutBot", "https://x.ru/")),
        case("robots: адрес с параметрами закрыт", not rb2.allowed("SupplierScoutBot", "https://x.ru/?sort=1")),
        case("robots: шаблон со звёздочкой", not rb2.allowed("SupplierScoutBot", "https://x.ru/mytest")),
        case("robots: своя группа бота важнее «*»", not rb.allowed("SupplierScoutBot", "https://x.ru/private/a")
             and rb.allowed("SupplierScoutBot", "https://x.ru/search")),
    ]
    print(f"\n{sum(res)} из {len(res)}")
    return 0 if all(res) else 1


if __name__ == "__main__":
    raise SystemExit(main())
