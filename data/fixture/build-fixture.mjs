// Генератор демо-фикстуры: компактные описания поставщиков → data/suppliers.json по контракту
// web/src/types.ts (раздел 2 логики сервиса). Все поставщики здесь придуманы: названия,
// домены (.example — зарезервированная зона), ИНН (с намеренно неверной контрольной цифрой),
// телефоны (код 000). Настоящие данные подставит сбор — этот файл тогда не нужен.
// Запуск: node data/fixture/build-fixture.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, SPECS } from "./specs.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "suppliers.json");
const COLLECTED = "2026-10-11";
const PIPELINE = "fixture-0.1";

// ---------- ИНН, который не может принадлежать настоящей компании ----------
function checkDigit(digits, weights) {
  return (weights.reduce((s, w, i) => s + w * digits[i], 0) % 11) % 10;
}
function fakeInn(seed, region, person) {
  const head = String(region) + "00";
  if (!person) {
    const body = (head + String(seed).padStart(5, "0")).split("").map(Number);
    const ok = checkDigit(body, [2, 4, 10, 3, 5, 9, 4, 6, 8]);
    return body.join("") + ((ok + 3) % 10);
  }
  const body = (head + String(seed).padStart(6, "0")).split("").map(Number);
  const c1 = checkDigit(body, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const c2 = checkDigit([...body, c1], [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return body.join("") + c1 + ((c2 + 5) % 10);
}

// ---------- поля с происхождением ----------
const f = (value, status, sources, quote, at, extra = {}) => ({
  value, status, sources, quote: quote ?? null, searched_in: null, basis: null, collected_at: at, ...extra,
});
const nf = (searched, at) => ({ value: null, status: "not_found", sources: [], quote: null, searched_in: searched, basis: null, collected_at: at });
const est = (value, basis, at) => ({ value, status: "estimated", sources: ["market"], quote: null, searched_in: null, basis, collected_at: at });

const PAGE = {
  main: ["/", "Главная"],
  contacts: ["/contacts", "Контакты"],
  delivery: ["/delivery", "Доставка и оплата"],
  about: ["/about", "О компании"],
  requisites: ["/requisites", "Реквизиты"],
  certs: ["/certificates", "Сертификаты"],
  horeca: ["/horeca", "Для ресторанов"],
  price: ["/price.pdf", "Прайс-лист, PDF"],
  offer: ["/offer", "Договор-оферта"],
};

function build(spec, idx) {
  const cat = CATEGORIES.find((c) => c.id === spec.cat);
  const at = spec.collected ?? COLLECTED;
  const domain = `${spec.id}.example`;
  const form = spec.form ?? "ООО";
  const usedPages = new Set(["main", "contacts"]);
  const site = (page) => { usedPages.add(page); return `site-${page}`; };
  const siteSearched = () => [`сайт: ${spec.pages ?? 4} стр. — главная, контакты, доставка, о компании`];

  // ИНН и реестры
  let inn = null;
  if (spec.inn !== false) inn = typeof spec.inn === "string" ? spec.inn : fakeInn(idx + 101, spec.innRegion ?? 66, form === "ИП");
  const innField = inn
    ? f(inn, "claimed", [site(spec.innPage ?? "requisites")], `ИНН ${inn}`, at)
    : nf(["сайт: реквизиты, договор-оферта, политика конфиденциальности"], at);
  const registry = [];
  const reg = (id, url, title) => { registry.push({ id, kind: "registry", url, title, fetched_at: at }); return id; };

  const legal = spec.legal ?? `${form} «${spec.name}»`;
  const legalField = inn
    ? f(legal, "found", [reg("egrul", "https://egrul.nalog.ru/", "ЕГРЮЛ: выписка по ИНН")], null, at)
    : spec.legalOnSite
      ? f(legal, "claimed", [site("about")], `${legal}`, at)
      : nf(["сайт: о компании, реквизиты, договор-оферта"], at);

  let company;
  if (!inn) company = nf(["ФНС по ИНН — ИНН на сайте не найден, проверить компанию нельзя"], at);
  else {
    const c = spec.company;
    const src = [reg("pb", "https://pb.nalog.ru/", "ФНС «Прозрачный бизнес»: карточка по ИНН")];
    if (c.status === "bankrupt") src.push(reg("fedresurs", "https://fedresurs.ru/", "Федресурс: сообщения о банкротстве"));
    company = f({
      form, status: c.status ?? "active", registered_at: c.reg,
      okved_main: c.okved[0], okved_title: c.okved[1], okved_match: c.okved[2],
      revenue: (c.rev ?? []).map((mln, i) => ({ year: 2023 + i, mln })),
      staff: c.staff ?? null, flags: c.flags ?? [],
    }, "found", src, null, at);
  }

  const tax = !inn || spec.tax === undefined
    ? nf(inn ? ["открытые данные ФНС о спецрежимах — нет в выгрузке"] : ["нужен ИНН"], at)
    : spec.tax === null
      ? nf(["открытые данные ФНС о спецрежимах — нет в выгрузке"], at)
      : f(spec.tax, "found", [reg("fns-open", "https://www.nalog.gov.ru/opendata/", "ФНС: открытые данные о спецрежимах")], null, at);

  // документы
  let declarations;
  if (!inn) declarations = nf(["реестр Росаккредитации ищет по ИНН заявителя — ИНН нет"], at);
  else if (!spec.decl?.length) declarations = nf(["реестр Росаккредитации по ИНН заявителя — 0 записей; декларации часто оформляет производитель"], at);
  else {
    const fsa = reg("fsa", "https://pub.fsa.gov.ru/rds/declaration", "Росаккредитация: реестр деклараций по ИНН");
    declarations = f(spec.decl.map((d, i) => ({
      number: `ЕАЭС N RU Д-RU.РА0${(idx % 9) + 1}.В.${String(10000 + idx * 37 + i * 11).padStart(5, "0")}/2${4 + (i % 2)}`,
      status: d.status ?? "действует", product: d.product, valid_to: d.to,
      url: "https://pub.fsa.gov.ru/rds/declaration",
    })), "found", [fsa], null, at);
  }
  let marking = null;
  if (cat.marking_group) {
    if (!inn) marking = nf(["«Честный знак» ищет по ИНН — ИНН нет"], at);
    else if (spec.marking) marking = f(spec.marking, "found", [reg("cz", "https://xn--80ajghhoc2aj1c8b.xn--p1ai/", "«Честный знак»: группы товаров участника")], null, at);
    else marking = nf(["«Честный знак»: участник по ИНН не найден"], at);
  }
  const mentions = spec.mentions
    ? f(spec.mentions.text, "claimed", [site(spec.mentions.page ?? "about")], spec.mentions.quote ?? spec.mentions.text, at)
    : nf(siteSearched(), at);

  // контакты и присутствие
  const address = spec.addr
    ? f(spec.addr.text, "claimed", [site(spec.addr.page ?? "contacts")], spec.addr.quote ?? `Адрес склада: ${spec.addr.text}`, at)
    : nf(["сайт: контакты, о компании"], at);
  const presenceValue = spec.presence ?? (spec.addr ? "warehouse" : "unknown");
  const presence = presenceValue === "unknown"
    ? nf(["адрес на сайте и регион ИНН"], at)
    : f(presenceValue, "claimed", [site(spec.addr?.page ?? "contacts")], spec.presenceQuote ?? spec.addr?.quote ?? null, at);
  const regions = spec.regions ?? ["Екатеринбург", "Свердловская область"];
  const regionsField = f(regions, "claimed", [site("delivery")], spec.regionsQuote ?? `Доставляем: ${regions.join(", ")}`, at);
  const phones = f(spec.phones ?? [`+7 343 000-${String(10 + idx).padStart(2, "0")}-${String(40 + ((idx * 7) % 60)).padStart(2, "0")}`], "claimed", [site("contacts")], null, at);
  const emails = spec.emails === null ? nf(["сайт: контакты"], at) : f(spec.emails ?? [`opt@${domain}`], "claimed", [site("contacts")], null, at);
  const messengers = spec.msg ? f(spec.msg, "claimed", [site("contacts")], spec.msgQuote ?? `Принимаем заказы в ${spec.msg.join(" и ")}`, at) : nf(["сайт: контакты, шапка и подвал"], at);
  const website = f(`https://${domain}`, "claimed", ["search"], null, at);
  const horeca = spec.horeca === null
    ? nf(siteSearched(), at)
    : f(spec.horeca ?? true, "claimed", [site(spec.horecaPage ?? "horeca")], spec.horecaQuote ?? "Работаем с ресторанами и кафе, заключаем договор поставки с юрлицами", at);
  const products = f(spec.products, "claimed", [site("main")], null, at);

  // условия
  let minOrder;
  if (spec.min === "est") minOrder = "est";
  else if (!spec.min) minOrder = nf(siteSearched(), at);
  else minOrder = f({ amount: spec.min.amount, unit: spec.min.unit ?? "RUB", text: spec.min.text }, "claimed", [site(spec.min.page ?? "delivery")], spec.min.quote, at);

  let prices;
  let priceEstimate;
  if (!spec.prices) prices = nf(siteSearched(), at);
  else {
    const p = spec.prices;
    const srcPage = p.mode === "pricelist" ? "price" : p.page ?? "main";
    prices = f({
      mode: p.mode,
      pricelist_url: p.mode === "pricelist" ? `https://${domain}/price.pdf` : null,
      examples: (p.examples ?? []).map(([item, price]) => ({ item, price })),
    }, "claimed", [site(srcPage)], p.quote ?? null, at);
    if (p.mode === "on_request" || p.mode === "after_login") priceEstimate = "est";
  }

  let delivery;
  if (!spec.delivery) delivery = nf(siteSearched(), at);
  else {
    const d = spec.delivery;
    delivery = f({
      to_door: d.to_door ?? false, free_from: d.free_from ?? null, cost: d.cost ?? null,
      lead_time: d.lead ?? null, pickup: d.pickup ?? false, zones: d.zones ?? null,
      transport_company: d.tc ?? false,
    }, "claimed", [site(d.page ?? "delivery")], d.quote, at);
    if (d.alt) {
      delivery.alternatives = [f({ ...delivery.value, free_from: d.alt.free_from }, "claimed", [site(d.alt.page ?? "main")], d.alt.quote, at)];
    }
  }
  const payment = spec.pay ? f(spec.pay.text, "claimed", [site(spec.pay.page ?? "delivery")], spec.pay.quote, at) : nf(siteSearched(), at);

  const sources = [...usedPages].map((p) => ({
    id: `site-${p}`, kind: "site", url: `https://${domain}${PAGE[p][0]}`, title: `Сайт: ${PAGE[p][1]}`, fetched_at: at,
  }));
  const sub = cat.subcategories.find((s) => s.id === spec.subs[0]);
  sources.push({ id: "search", kind: "search", url: "https://yandex.ru/search/", title: `Поиск Яндекса: «${sub.name.toLowerCase()} оптом Екатеринбург»`, fetched_at: at });
  sources.push(...registry.filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i));

  return {
    id: spec.id, name: spec.name, demo: true, ...(spec.live ? { live_only: spec.live } : {}),
    category: spec.cat, subcategories: spec.subs, city: spec.city ?? "Екатеринбург",
    legal_name: legalField, inn: innField, products, address, presence, regions_served: regionsField,
    phones, emails, messengers, website,
    map_link: spec.addr ? `https://2gis.ru/ekaterinburg/search/${encodeURIComponent(spec.name)}` : null,
    works_with_horeca: horeca, min_order: minOrder, prices, ...(priceEstimate ? { price_estimate: priceEstimate } : {}),
    delivery, payment_terms: payment,
    documents: { declarations, marking, site_mentions: mentions },
    company, tax_regime: tax, not_supplier: spec.notSupplier ?? null,
    meta: { collected_at: at, pipeline_version: PIPELINE, sources, not_collected_reason: null, pages: spec.pages ?? Math.min(usedPages.size, 6) },
  };
}

// ---------- шаг 6 конвейера: оценки ◇ по рынку для пустых полей ----------
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
const fmt = (n) => n.toLocaleString("ru-RU").replace(/ /g, " ");

function fillEstimates(suppliers) {
  for (const cat of CATEGORIES) {
    const inCat = suppliers.filter((s) => s.category === cat.id);
    const known = inCat.filter((s) => s.min_order.status === "claimed" && s.min_order.value.unit === "RUB").map((s) => s.min_order.value.amount);
    const withPrice = inCat.filter((s) => s.prices.status === "claimed" && s.prices.value.mode === "pricelist").length;
    for (const s of inCat) {
      if (s.min_order === "est") {
        const m = Math.round(median(known) / 1000) * 1000;
        s.min_order = est({ amount: m, unit: "RUB", text: `~${fmt(m)} ₽` },
          `медиана опубликованных минимумов ${known.length} поставщиков категории (от ${fmt(Math.min(...known))} до ${fmt(Math.max(...known))} ₽), ${s.meta.collected_at.split("-").reverse().join(".")}`,
          s.meta.collected_at);
        s.meta.sources.push({ id: "market", kind: "market", url: "", title: "Ориентир по рынку: другие поставщики категории", fetched_at: s.meta.collected_at });
      }
      if (s.price_estimate === "est") {
        s.price_estimate = est(cat.price_benchmark.text,
          `${cat.price_benchmark.basis}; прайс открыт у ${withPrice} поставщиков категории`, s.meta.collected_at);
        if (!s.meta.sources.some((x) => x.id === "market"))
          s.meta.sources.push({ id: "market", kind: "market", url: "", title: "Ориентир по рынку: другие поставщики категории", fetched_at: s.meta.collected_at });
      }
    }
  }
}

const suppliers = SPECS.map(build);
fillEstimates(suppliers);

const dataset = {
  meta: {
    fixture: true,
    note: "Демо-фикстура для прототипа интерфейса: все поставщики и значения придуманы. Заменяется набором, собранным конвейером.",
    city: { id: "ekb", name: "Екатеринбург", region: "Свердловская область" },
    collected_at: COLLECTED,
    pipeline_version: PIPELINE,
  },
  categories: CATEGORIES.map(({ price_benchmark, ...c }) => c),
  suppliers,
};
// суммы и телефоны не должны рваться на строки: «5 000 ₽» — неразрывные пробелы
const json = JSON.stringify(dataset, null, 1).replace(/(\d) (\d{3})/g, "$1 $2").replace(/(\d) (\d{3})/g, "$1 $2").replace(/ ₽/g, " ₽");
writeFileSync(OUT, json + "\n", "utf8");
console.log(`suppliers.json: ${suppliers.length} поставщиков (${suppliers.filter((s) => !s.live_only).length} в наборе, ${suppliers.filter((s) => s.live_only).length} для живого сбора)`);
