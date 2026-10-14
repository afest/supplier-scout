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

    # ---- ревью 14.10: значение сверяется с цитатой, а не только цитата со страницей (В2) ----
    def one(field, value, quote, text=None, page_url="https://example.ru/delivery"):
        page = {"final_url": page_url, "title": "", "links": [], "text": text or quote}
        return check_answer({field: {"value": value, "quote": quote, "page": "P1"}}, [page])

    retail = one("works_with_horeca", True, "Продаём только в розницу физлицам")
    no_word = one("works_with_horeca", True, "Свежая рыба каждый день с доставкой")
    horeca = one("works_with_horeca", True, "Работаем с ресторанами и кафе по договору")
    bad_addr = one("city_address", "г. Екатеринбург, ул. Ленина 5", "Склад: г. Екатеринбург, ул. Завокзальная 13")
    good_addr = one("city_address", "г. Екатеринбург, ул. Завокзальная 13", "Адрес склада: г. Екатеринбург, ул. Завокзальная 13 (вход со двора)")
    pay_num = one("payment_terms", "отсрочка 30 дней", "Отсрочка платежа 14 дней для сетей")
    doc_ok = one("doc_mentions", "декларации, ветеринарные документы в Меркурии",
                 "На всю продукцию есть декларации и ветеринарные документы в системе Меркурий")
    res += [
        case("«работает с ресторанами» при цитате «только в розницу физлицам» отброшено", "works_with_horeca" not in retail.facts),
        case("«работает с ресторанами» без слов про рестораны и опт в цитате отброшено", "works_with_horeca" not in no_word.facts),
        case("«работает с ресторанами» с цитатой про рестораны принято", horeca.facts.get("works_with_horeca", {}).get("value") is True),
        case("адрес, которого нет в цитате, отброшен", "city_address" not in bad_addr.facts),
        case("адрес из цитаты принят", "city_address" in good_addr.facts),
        case("условие оплаты с чужим числом не проходит — значением стала дословная цитата",
             pay_num.facts["payment_terms"]["value"] == "Отсрочка платежа 14 дней для сетей"),
        case("пересказ про документы, совпадающий с цитатой, принят", "doc_mentions" in doc_ok.facts),
    ]
    office_text = "Офис: г. Екатеринбург, ул. Репина 42А"
    kind_office = check_answer({"city_address": {"value": "г. Екатеринбург, ул. Репина 42А", "quote": office_text, "page": "P1"},
                                "city_address_kind": "склад"},
                               [{"final_url": "https://example.ru/contacts", "links": [], "text": office_text}])
    door = one("delivery", {"to_door": True, "free_from": None, "cost": None, "lead_time": None, "pickup": True, "zones": None,
                            "transport_company": False}, "Доставка по Екатеринбургу в день заказа")
    kg = one("min_order", {"amount": 5000, "unit": "kg", "text": "от 5000 кг"}, "Минимальный заказ от 5000 рублей")
    res += [
        case("«склад» без слова «склад» в цитате адреса — тип адреса снят", kind_office.facts["city_address"]["kind"] is None),
        case("самовывоз без слова про самовывоз в цитате — не подтверждён",
             door.facts["delivery"]["value"]["pickup"] is False and door.facts["delivery"]["value"]["to_door"] is True),
        case("минимум в кг при цитате в рублях отброшен", "min_order" not in kg.facts),
    ]

    # ---- минимальный заказ ↔ порог бесплатной доставки в обе стороны (В3) ----
    gross_q = "Минимальная сумма - 20 000 рублей, подробности уточняйте у менеджера при оформлении заявки."
    gross = one("delivery", {"to_door": True, "free_from": 20000, "cost": None, "lead_time": None, "pickup": False, "zones": None,
                             "transport_company": False}, gross_q, text="Доставка по городу. " + gross_q)
    both_text = "Бесплатная доставка от 5000, минимальный заказ 3000 рублей"
    both = check_answer({"min_order": {"value": {"amount": 3000, "unit": "RUB", "text": "3 000 ₽"}, "quote": both_text, "page": "P1"},
                         "delivery": {"value": {"to_door": True, "free_from": 5000, "cost": None, "lead_time": None, "pickup": False,
                                                "zones": None, "transport_company": False}, "quote": both_text, "page": "P1"}},
                        [{"final_url": "https://example.ru/d", "links": [], "text": both_text}])
    free_min = one("min_order", {"amount": 5000, "unit": "RUB", "text": "5 000 ₽"}, "При заказе от 5000 руб. доставка бесплатная")
    italika = one("delivery", {"to_door": True, "free_from": 3000, "cost": 300, "lead_time": None, "pickup": False, "zones": None,
                               "transport_company": False}, "Стоимость доставки От 3 000 руб. - бесплатно До 3 000 руб. - 300 руб.")
    res += [
        case("Гросс Фуд: «Минимальная сумма — 20 000» — не порог доставки, а минимальный заказ",
             gross.facts["delivery"]["value"]["free_from"] is None
             and gross.facts.get("min_order", {}).get("value", {}).get("amount") == 20000),
        case("«бесплатная доставка от 5000, минимальный заказ 3000»: оба значения на своих местах",
             both.facts.get("min_order", {}).get("value", {}).get("amount") == 3000
             and both.facts.get("delivery", {}).get("value", {}).get("free_from") == 5000),
        case("порог бесплатной доставки, записанный минимумом, переносится в доставку",
             "min_order" not in free_min.facts and free_min.facts.get("delivery", {}).get("value", {}).get("free_from") == 5000),
        case("«От 3 000 руб. — бесплатно»: точка после «руб.» фразу не рвёт, порог принят",
             italika.facts["delivery"]["value"]["free_from"] == 3000),
    ]

    # ---- условие другого города: в значении и в адресе страницы (В4) ----
    q11 = "Сумма для оформления заказа от 11 000 ₽."
    gfc = one("min_order", {"amount": 11000, "unit": "RUB", "text": "от 11 000 ₽ (Москва)"}, q11)
    gfc_page = one("min_order", {"amount": 11000, "unit": "RUB", "text": "от 11 000 ₽"}, q11, page_url="https://gfc-russia.ru/delivery/moskva")
    ekb_page = one("min_order", {"amount": 11000, "unit": "RUB", "text": "от 11 000 ₽"},
                   "Сумма для оформления заказа в Екатеринбурге от 11 000 ₽.", page_url="https://gfc-russia.ru/delivery/moskva")
    res += [
        case("gfc-russia: минимум «от 11 000 ₽ (Москва)» — город в значении, отброшен", "min_order" not in gfc.facts),
        case("минимум со страницы /delivery/moskva отброшен", "min_order" not in gfc_page.facts),
        case("Екатеринбург в цитате важнее адреса страницы", "min_order" in ekb_page.facts),
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
    res += network_cases() + hours_cases() + assortment_cases() + build_cases() + subcat_cases() + t539_cases()
    print(f"\n{sum(res)} из {len(res)}")
    return 0 if all(res) else 1


def t539_cases() -> list[bool]:
    """Правки перед публикацией (T-539): порог бесплатной доставки, страницы под robots.txt, ответ ФНС без id."""
    import json
    import tempfile
    from pathlib import Path

    import httpx

    from . import build, registries
    from .config import load_categories
    from .extract import free_threshold

    def delivery(value, quote, text):
        return check_answer({"delivery": {"value": value, "quote": quote, "page": "P1"}},
                            [{"final_url": "https://x.ru/dostavka", "links": [], "text": text}]).facts.get("delivery")

    # «Морское счастье»: порог модель взяла двумя строками ниже цитаты про тариф
    sea_text = ("Стоимость доставки по г. Екатеринбург\nСтоимость доставки при заказе до 3 000 руб. составляет 450 рублей.\n"
                "Стоимость доставки при заказе свыше 3 000 руб. составляет 350 рублей.\nПри заказе от 10 000руб. доставка бесплатно.\n"
                "В пригороды Екатеринбурга стоимость доставки оплачивается по тарифу Яндекс доставки.")
    sea = delivery({"to_door": True, "free_from": 10000, "cost": 450, "lead_time": None, "pickup": False, "zones": None,
                    "transport_company": False}, "Стоимость доставки при заказе до 3 000 руб. составляет 450 рублей.", sea_text)
    far = delivery({"to_door": True, "free_from": 10000, "cost": 450, "lead_time": None, "pickup": False, "zones": None,
                    "transport_company": False}, "Стоимость доставки при заказе до 3 000 руб. составляет 450 рублей.",
                   sea_text.replace("При заказе от 10 000руб. доставка бесплатно.", "Пункт 1.\nПункт 2.\nПункт 3.\nПункт 4.\n"
                                    "При заказе от 10 000руб. доставка бесплатно."))
    # Уралпаксистем: порог в штуках рублёвое поле не держит
    ural_q = "Бесплатно доставим заказ от 1000 шт по г. Екатеринбургу."
    ural = delivery({"to_door": True, "pickup": False, "zones": "г. Екатеринбург", "transport_company": False}, ural_q, ural_q)
    res = [
        case("«Морское счастье»: порог 10 000 ₽ с соседней строки принят, цитата продлена до неё дословно",
             sea["value"]["free_from"] == 10000 and sea["value"]["cost"] == 450 and "10 000руб" in sea["quote"]
             and quote_in(sea["quote"], norm(sea_text))),
        case("порог дальше трёх строк от цитаты не подтягивается — отброшен, как раньше", far["value"]["free_from"] is None),
        case("«от 10 000руб. доставка бесплатно»: точка после «руб.», слитного с числом, фразу не рвёт",
             free_threshold("При заказе от 10 000руб. доставка бесплатно.") == {"amount": 10000, "unit": "RUB", "text": "10 000 ₽"}),
        case("Уралпаксистем: «бесплатно от 1000 шт» — free_from пуст, порог в штуках сохранён отдельно",
             ural["value"].get("free_from") is None
             and ural["value"].get("free_from_qty") == {"amount": 1000, "unit": "pcs", "text": "от 1 000 шт"}),
        case("«от МКАД — покупки от 12000р бесплатная доставка» — порог другого города не берётся",
             free_threshold("в пределах 5 км от МКАД - Покупки от 12000р бесплатная доставка") is None),
    ]

    # RedFish: прайс закрыт robots.txt — «не собрано», а не «нет на сайте»; закрытая политика конфиденциальности цен не касается
    cat = {c["id"]: c for c in load_categories()["categories"]}
    saved_pages = build.PAGES_DIR
    build.PAGES_DIR = Path(tempfile.mkdtemp())
    try:
        for host, path in (("shop.example", "/prajs-listy"), ("other.example", "/privacy")):
            (build.PAGES_DIR / host).mkdir()
            (build.PAGES_DIR / host / "a.json").write_text(json.dumps({"url": f"https://www.{host}{path}", "error": "robots.txt запрещает",
                                                                       "text": ""}), encoding="utf-8")

        def card(host):
            rec = {"facts": {}, "pages": [{"url": f"https://www.{host}/", "title": "", "fetched_at": "2026-10-14"}], "answer": {"subcategories": []}}
            return build.build_supplier({"host": host, "root": f"https://www.{host}", "urls": [], "queries": []}, rec, {}, cat["grocery"])
        shop, other = card("shop.example"), card("other.example")
    finally:
        build.PAGES_DIR = saved_pages
    res += [
        case("RedFish: прайс закрыт robots.txt — у цен пометка «сайт запрещает сбор» и адрес страницы в «где искали»",
             shop["prices"]["status"] == "not_found" and "robots.txt закрывает /prajs-listy" in (shop["prices"].get("blocked") or "")
             and any("prajs-listy" in w for w in shop["prices"]["searched_in"])),
        case("закрытая страница другого вида (/privacy) цены «не собранными» не делает",
             "blocked" not in other["prices"] and "blocked" not in other["delivery"]),
    ]

    # Food-Face: ФНС ответила без id — один повтор, потом понятная причина вместо KeyError 'id'
    answers = []

    def fns(request):
        return httpx.Response(200, json=answers.pop(0) if answers else {})
    saved_dir, saved_sleep = registries.REG_DIR, registries.time.sleep
    registries.REG_DIR, registries.time.sleep = Path(tempfile.mkdtemp()), (lambda s: None)
    try:
        r = registries.Registries(pause=0)
        r.http = httpx.Client(transport=httpx.MockTransport(fns))
        answers[:] = [{}, {"id": "task-1"}]
        retried = r._pb_task("https://pb.nalog.ru/search-proc.json", {}, "поиск") == {"id": "task-1"}
        answers[:] = []
        rec = r.pb("6679154435")
    finally:
        registries.REG_DIR, registries.time.sleep = saved_dir, saved_sleep
    res += [
        case("ФНС ответила без id — запрос повторён, второй ответ принят", retried),
        case("Food-Face: ФНС дважды без id — причина «не приняла запрос», а не KeyError 'id'",
             "ФНС не приняла запрос" in (rec.get("error") or "") and "KeyError" not in (rec.get("error") or "")),
    ]

    # ИП из реестра: ФНС отдаёт ФИО без «ИП» — в карточку идёт «ИП Фамилия И. О.», полного ФИО нигде нет (ФИО вымышленное)
    F = build.F
    person = {"name": "Пример", "legal_name": F("Петров Пётр Сергеевич", "found", ["pb"]), "inn": F("770708389312", "found", ["pb"]),
              "phones": F(["+7 (343) 226-09-36"], "claimed"), "meta": {"sources": []},
              "company": F({"form": "ИП", "note": "владелец — Петров Пётр Сергеевич"}, "found", ["pb"])}
    build.redact_person(person, "770708389312")
    res.append(case("ИП из реестра без приставки «ИП»: имя сокращено до «ИП Петров П. С.», полного ФИО в карточке нет",
                    person["legal_name"]["value"] == "ИП Петров П. С." and "Пётр Сергеевич" not in json.dumps(person, ensure_ascii=False)))
    return res


def network_cases() -> list[bool]:
    """Загрузка и платные вызовы — на подменённом транспорте httpx, без сети и без денег (ревью 14.10, В10, В11, В13)."""
    import tempfile
    from pathlib import Path

    import httpx

    from . import fetch, kie
    from .fetch import Fetcher, _decode

    body = "<html><body><p>Доставка по Екатеринбургу</p></body></html>".encode("cp1251")
    res = [case("заголовок ISO-8859-1 при теле cp1251 — кириллица, а не мусор",
                "Доставка" in _decode(body, "text/html; charset=ISO-8859-1"))]

    jina_calls = []
    saved_dir, saved_jina = fetch.PAGES_DIR, Fetcher._jina
    fetch.PAGES_DIR = Path(tempfile.mkdtemp())
    Fetcher._jina = lambda self, url, r: jina_calls.append(url)
    try:
        def site(request):
            if request.url.host == "down.example" and request.url.path == "/robots.txt":
                raise httpx.ConnectError("нет связи")
            if request.url.path == "/robots.txt":
                return httpx.Response(404)
            return httpx.Response(403, text="Forbidden")
        f = Fetcher(delay=0)
        f.http = httpx.Client(transport=httpx.MockTransport(site))
        res.append(case("robots.txt не открылся из-за сети — сайт закрыт для сбора (RFC 9309)",
                        not f.allowed("https://down.example/catalog/")))
        p = f.page("https://shop.example/catalog/")
        res.append(case("после 403 посредник Jina не зовётся", p["error"] == "HTTP 403" and not jina_calls))
        f.max_per_site = 1
        f.page("https://shop.example/a")
        res.append(case("общий лимит загрузок на сайт", "лимит" in (f.page("https://shop.example/b").get("error") or "")))
        off = Fetcher(offline=True).page("https://nowhere.example/")
        res.append(case("офлайн — без сети: страницы нет в кэше, значит ошибка", "офлайн" in (off.get("error") or "")))
    finally:
        fetch.PAGES_DIR, Fetcher._jina = saved_dir, saved_jina

    calls = []

    def slow(request):
        calls.append(1)
        raise httpx.ReadTimeout("180 с без ответа")
    saved_sleep = kie.time.sleep
    kie.time.sleep = lambda s: None
    try:
        k = kie.Kie(budget_rub=5)
        k._http = httpx.Client(transport=httpx.MockTransport(slow))
        try:
            k._post("/claude/v1/messages", {})
            timeout_ok = False
        except kie.KieError:
            timeout_ok = len(calls) == 1
        res.append(case("ReadTimeout платного вызова не повторяется — двойного списания нет", timeout_ok))
        res.append(case("потолок — на расход прогона, а не на журнал за всё время", k.run_rub() == 0))
        k2 = kie.Kie(budget_rub=2.5, reserve_rub=1.0)
        with k2._slot(), k2._slot():
            try:
                with k2._slot():
                    pass
                slot_ok = False
            except kie.BudgetExceeded:
                slot_ok = True
        res.append(case("третий параллельный вызов не уходит, если резерв двух в полёте уже упирается в потолок", slot_ok))
    finally:
        kie.time.sleep = saved_sleep
    return res


def build_cases() -> list[bool]:
    """Сборка карточки, кэш раскладки, запись набора и категория по товарам (ревью 14.10: А3, В9, В12, Italika)."""
    import json
    import tempfile
    from datetime import date, timedelta
    from pathlib import Path

    from . import build, run, site
    from .config import load_categories

    cats = load_categories()["categories"]
    cat = {c["id"]: c for c in cats}

    def card(kind):
        rec = {"facts": {"city_address": {"value": "г. Екатеринбург, ул. Репина 42А", "quote": "Екатеринбург, ул. Репина 42А", "page": 0,
                                          "kind": kind},
                         "delivery": {"value": {"to_door": True, "transport_company": False}, "quote": "Доставка по городу", "page": 0}},
               "pages": [{"url": "https://x.ru/", "title": "", "fetched_at": "2026-10-14"}], "answer": {"subcategories": []}}
        return build.build_supplier({"host": "x.ru", "root": "https://x.ru/", "urls": [], "queries": []}, rec, {},
                                    cat["packaging"])["presence"]["value"]

    tmp = Path(tempfile.mkdtemp())
    saved_dir, saved_runs = site.EXTRACT_DIR, run.RUNS
    site.EXTRACT_DIR, run.RUNS = tmp / "extract", tmp / "runs"
    try:
        site.EXTRACT_DIR.mkdir()
        old = (date.today() - timedelta(days=40)).isoformat()
        for host, rec in {"err.example": {"answer": None, "error": "сайт не открылся"},
                          "old.example": {"answer": {"brand": "x"}, "extracted_at": old},
                          "ok.example": {"answer": {"brand": "x"}, "extracted_at": date.today().isoformat()}}.items():
            (site.EXTRACT_DIR / f"{host}.json").write_text(json.dumps({"host": host, "pages": [], **rec}), encoding="utf-8")
        cache_ok = (site.cached_extract("err.example") is None and site.cached_extract("old.example") is None
                    and site.cached_extract("ok.example") is not None)
        run.RUNS.mkdir()
        first = run.report_path()
        run.write_atomic(first, {"a": 1})
        second = run.report_path()
        run.write_atomic(second, {"a": 2})
        report_ok = (first != second and json.loads(first.read_text(encoding="utf-8")) == {"a": 1}
                     and not list(run.RUNS.glob("*.tmp")))
    finally:
        site.EXTRACT_DIR, run.RUNS = saved_dir, saved_runs

    # Упакофф (ревью Дир 61): «7 городов России» + адрес в Екатеринбурге + доставка до двери — интерфейс не исключает
    from .extract import norm_region

    def regional(delivery):
        facts = {"city_address": {"value": "Екатеринбург, ул. Машиностроителей, 33", "quote": "Екатеринбург, ул. Машиностроителей, 33",
                                  "page": 0, "kind": None},
                 "regions_served": {"value": ["7 городов России"], "quote": "Работаем в 7 городах России", "page": 0}}
        if delivery:
            facts["delivery"] = {"value": {"to_door": True, "pickup": False, "transport_company": False}, "quote": "Доставка до двери", "page": 0}
        rec = {"facts": facts, "pages": [{"url": "https://x.ru/", "title": "", "fetched_at": "2026-10-14"}], "answer": {"subcategories": []}}
        return build.build_supplier({"host": "x.ru", "root": "https://x.ru/", "urls": [], "queries": []}, rec, {}, cat["packaging"])

    upakoff, no_door = regional(True), regional(False)

    boxes = {"facts": {"products": {"value": ["Коробки для пиццы", "Коробки для тортов"]}},
             "assortment": {"items": [{"name": "Коробка для пиццы 30 см", "group": None}, {"name": "Пакет крафт", "group": None}]}}
    new, note = run.check_category(boxes, cat["dairy"], cats)
    return [
        case("«склад в городе» — только склад или производство", card("склад") == "warehouse" and card("производство") == "warehouse"),
        case("офис, магазин, пункт выдачи в городе — не склад, присутствие по доставке",
             all(card(k) == "delivery_only" for k in ("офис", "магазин", "пункт выдачи", None))),
        case("кэш раскладки: запись-ошибка и раскладка старше 30 дней не берутся, свежая — берётся", cache_ok),
        case("второй отчёт за день не затирает первый, запись набора без недописанного .tmp", report_ok),
        case("поставщик коробок в «Сыре» без единого сырного товара переезжает в «Упаковку» с пометкой в отчёте",
             new["id"] == "packaging" and bool(note)),
        case("Упакофф: «7 городов России» + адрес в Екатеринбурге + до двери — «Екатеринбург» в регионах, не исключается",
             "Екатеринбург" in upakoff["regions_served"]["value"] and build.excluded_by_region(upakoff) is None),
        case("тот же поставщик без доставки и склада — исключается, правило stopReason повторено верно",
             build.excluded_by_region(no_door) is not None),
        case("FoodFace: «любой город России», «все регионы РФ» — это «вся Россия», а «7 городов России» — нет",
             norm_region("любой город России") == norm_region("все регионы РФ") == norm_region("регионы РФ")
             == norm_region("89 субъектов РФ и СНГ") == norm_region("вся территория РФ") == "вся Россия"
             and norm_region("7 городов России") == "7 городов России" and norm_region("за пределами РФ") == "за пределами РФ"
             and norm_region("вся центральная Россия") == "вся центральная Россия"),
    ]


def subcat_cases() -> list[bool]:
    """Подкатегории по ассортименту (T-538): правила из data/categories.json на позициях, которые ловились ложно."""
    from .config import load_categories
    from .subcats import assign

    cats = load_categories()["categories"]

    def subs(items=(), products=(), category="packaging"):
        return assign({"category": category, "products": {"value": list(products)},
                       "assortment": {"value": {"items": [{"name": n, "group": g} for n, g in items]}}})

    def has(sid, *names, group=None):
        return sid in subs([(n, group) for n in names])[0]

    ids = [s["id"] for c in cats for s in c["subcategories"]]
    fish_cups, basis = subs([("Креветки очищ. в/м 200/300 VICI (1кг/уп)", None), ("Стакан бумажный 250 мл", None)], category="grocery")
    return [
        case("подкатегории: у каждой категории 6–10, id не повторяются между категориями",
             all(6 <= len(c["subcategories"]) <= 10 for c in cats) and len(ids) == len(set(ids))),
        case("стакан — в «Стаканах»; сметана в стакане, вафельный стаканчик, лапша в стакане — нет",
             has("cups", "Стакан бумажный 250 мл") and not has("cups", "Сметана м.д.ж.20% стакан 6х0,18 кг")
             and not has("cups", "88195. Вафельный стаканчик БЕЗ САХАРА 75") and not has("cups", "Суп-лапша в удобном стакане")),
        case("товар «в пакете» и мешок для мусора — не «Пакеты», «Пакет майка» — «Пакеты»",
             has("bags", "Пакет Майка 40×70 см") and not has("bags", "Ванилин (1000 гр) пакет SpicExpert")
             and not has("bags", "Мешок для мусора ПВД 120л")),
        case("кабачковая икра и икра лососевых: первая не «Икра», вторая не «Лосось»",
             not has("roe", "Икра кабачковая 500 г") and has("roe", "Икра кеты «Ничира», 250 г")
             and not has("salmon", "Икра кеты «Ничира», 250 г")),
        case("рабочие перчатки х/б и паллетная стрейч-плёнка — не «Перчатки, плёнка, фольга»; пищевые перчатки — да",
             not has("consumables", "Перчатки вязаные х/б с ПВХ черные") and not has("consumables", "Стрейч пленка 500мм 20мкм 1,8кг")
             and has("consumables", "Перчатки одноразовые полиэтиленовые")),
        case("перец чили кочукару — «Специи»; замороженный «перец красный полоска» — нет",
             has("spices", "Перец чили Кочукару мелкого помола") and not has("spices", "Перец красный полоска 10 кг, Китай")),
        case("«Сливки» в разделе «Бакалея» — сухие, не «Сливки»; «Сливки 33%» — «Сливки»",
             not has("cream", "Сливки", group="Бакалея") and has("cream", "Сливки Петмол 33% (1л)")),
        case("раздел каталога — тоже основание: «Кручёная ручка ‹Бумажные крафт пакеты›» — «Пакеты»",
             has("bags", "Кручёная ручка", group="Бумажные крафт пакеты")),
        case("подкатегория из чужой категории: у бакалеи с креветками и стаканами — «Креветки» и «Стаканы», с основаниями",
             "shrimp" in fish_cups and "cups" in fish_cups and basis["shrimp"] == ["Креветки очищ. в/м 200/300 VICI (1кг/уп)"]),
        case("товары с сайта учитываются вместе с ассортиментом", "rice" in subs([("Азиатская кухня", None)], ["Рис для суши"])[0]),
    ]


def hours_cases() -> list[bool]:
    from .hours import find_hours

    def h(text, url="https://x.ru/dostavka"):
        got = find_hours([{"final_url": "https://x.ru/", "text": ""}, {"final_url": url, "text": text}])
        return got["value"] if got else {}

    late = h("Доставка осуществляется с понедельника по пятницу с 12:00 до 22:00.")
    return [
        case("часы: «Пн-Пт 9:00-18:00» — режим работы", h("Пн-Пт 9:00-18:00", "https://x.ru/contacts").get("office") == "Пн-Пт 9:00-18:00"),
        case("часы: доставка до 22:00 — окно доставки и «возят вечером»",
             late.get("delivery_window") and late.get("evening_or_night") is True),
        case("часы: доставка с 9 до 18 — вечером не возят", h("Доставка в рабочие дни с 9 до 18 часов.").get("evening_or_night") is False),
        case("часы: «заказы до 18:00 — на следующий день» — время приёма заказа",
             h("Заказы, оформленные до 18:00, доставляются на следующий рабочий день.").get("order_cutoff") is not None),
        case("часы: «в течение 2–3 рабочих дней» — срок, а не дни доставки", not h("Отгрузка в течение 2-3 рабочих дней.")),
        case("часы: «от 7 до 21 дня» — не время заказа", not h("Изготовление заказа занимает от 7 до 21 дня.")),
        case("часы: «Сеть магазинов 24/7» — не круглосуточная работа", not h("Сеть магазинов «24/7»")),
        case("часы: доставка по Москве закупщику из Екатеринбурга не показывается", not h("МСК: Доставка с понедельника по пятницу.")),
    ]


def assortment_cases() -> list[bool]:
    from .catalog import assemble, verify, xlsx_items

    page = {"url": "https://x.ru/catalog/syry/", "group": "Сыры", "kind": "html",
            "text": "Сыры\nСыр Моцарелла для пиццы 42%\nЦена 710 ₽/кг\nВ корзину\nСливки Петмол 33% (1л)\nЦена 430 ₽/шт"}
    ans = {"products": [{"name": "Сыр Моцарелла для пиццы 42%", "group": None, "price": "710 ₽/кг", "page": "P1"},
                        {"name": "Молоко Простоквашино 3,2%", "group": None, "price": None, "page": "P1"},
                        {"name": "Сливки Петмол 33% (1л)", "group": None, "price": "999 ₽", "page": "P1"},
                        {"name": "В корзину", "group": None, "price": None, "page": "P1"}],
           "sections": [{"name": "Сыры", "parent": None}]}
    products, sections, rejected = verify(ans, [page])
    names = [p["name"] for p in products]
    rows = [["Прайс-лист"], ["Наименование", "Ед.изм.", "Цена"], ["РЫБА"], ["Лосось филе", "кг.", 1450], ["Нори Gold 50л", "уп.", 890], None]
    xl = xlsx_items(rows)
    many = [{"name": f"Товар {p}-{i}", "group": None, "price": None, "page": p} for p in (0, 1) for i in range(5)]
    items, total = assemble(many, [], limit=4)

    # уценка и акции (ревью Дир 61): раздел «Уцененные товары» и «УЦЕНКА!» в названии — не ассортимент
    from .catalog import is_sale
    sale_page = {"url": "https://x.ru/catalog/ucenennye/", "group": "Уцененные товары", "kind": "html",
                 "text": "Бак мусорный 75л с крышкой\n500.00 руб."}
    shop_page = {"url": "https://x.ru/catalog/muka/", "group": "Мучная продукция", "kind": "html",
                 "text": "Сухари Панко фракция 3 мм\nДиспенсер 337х203 УЦЕНКА! (царапины)\nУцененные товары"}
    sale_ans = {"products": [{"name": "Бак мусорный 75л с крышкой", "group": None, "price": "500.00 руб.", "page": "P1"},
                             {"name": "Сухари Панко фракция 3 мм", "group": None, "price": None, "page": "P2"},
                             {"name": "Диспенсер 337х203 УЦЕНКА! (царапины)", "group": None, "price": None, "page": "P2"}],
                "sections": [{"name": "Уцененные товары", "parent": None}]}
    s_products, s_sections, s_rejected = verify(sale_ans, [sale_page, shop_page])
    s_names = [p["name"] for p in s_products]
    return [
        case("ассортимент: позиция со страницы принята, цена рядом с ней — тоже",
             "Сыр Моцарелла для пиццы 42%" in names and products[0]["price"] == "710 ₽/кг"),
        case("ассортимент: позиции, которой нет на странице, нет в результате", "Молоко Простоквашино 3,2%" not in names),
        case("ассортимент: цена, которой нет рядом с товаром, снята, позиция осталась",
             next(p for p in products if p["name"].startswith("Сливки"))["price"] is None),
        case("ассортимент: кнопка «В корзину» — не товар", "В корзину" not in names),
        case("ассортимент: группа товара — раздел каталога, откуда страница", products[0]["group"] == "Сыры"),
        case("прайс xlsx: шапка «Наименование … Цена», строка-заголовок — группа, цена с единицей",
             xl == [{"name": "Лосось филе", "group": "РЫБА", "price": "1450 ₽/кг."}, {"name": "Нори Gold 50л", "group": "РЫБА", "price": "890 ₽/уп."}]),
        case("ассортимент: при лимите позиции берутся по очереди со всех страниц, а не только с первой",
             total == 10 and {x["name"].split("-")[0] for x in items} == {"Товар 0", "Товар 1"}),
        case("уценка: позиции раздела «Уцененные товары» и с «УЦЕНКА!» в названии в ассортимент не попадают, сам раздел — тоже",
             s_names == ["Сухари Панко фракция 3 мм"] and not s_sections
             and sum(1 for r in s_rejected if r["field"] == "assortment.sale") == 3),
        case("уценка: «Товары со скидкой - 50%», «Наши акции», «Распродажа» — разделы акций; «фракция», «Сливки 33%», "
             "«Транзакции» — нет",
             all(is_sale(g) for g in ("Товары со скидкой - 50%", "Наши акции", "Распродажа", "Спецпредложения", "Акции и Скидки"))
             and not any(is_sale(g) for g in ("Мучная продукция", "Сухари Панко фракция 3 мм", "Сливки 33%", "Транзакции"))),
    ]


if __name__ == "__main__":
    raise SystemExit(main())
