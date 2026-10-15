// Приёмочный прогон интерфейса по сценариям 1–3 из логики сервиса: закупщик сети ищет контейнеры для роллов,
// владелец точки срочно меняет поставщика лосося, трое на примете — сравнить и решить, кому писать первым.
// Всё проходится кликами и вводом в настоящем браузере (headless Chromium) на настоящем наборе data/suppliers.json;
// ожидаемые значения считаются из этого файла отдельным кодом, а не берутся с экрана. Пишет протокол и скриншоты.
// Навигацию, подкатегории, правки T-539 и «Знаю поставщика» через сервер проверяют e2e-nav.cjs и e2e-server.cjs — здесь они не повторяются.
//
// Запуск (нужен Playwright с установленным Chromium; сервер dist и заглушка API поднимаются в этом же процессе):
//   VITE_API_URL=http://127.0.0.1:8765 npm --prefix web run build
//   NODE_PATH=<папка с node_modules/playwright> API_STUB_PYTHON=<python с зависимостями api/> node scripts/e2e.cjs [папка-вывода]
// Без аргумента протокол (прогон-сценариев.md) и скриншоты кладутся в e2e-out/ (она в .gitignore).
// Сборка без VITE_API_URL ходит на боевой сервер и падает по CORS: отзывы и «Знаю поставщика» зовут API.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { serveDist } = require("./serve-dist.cjs");
const { startApiStub } = require("./api-stub.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "e2e-out"));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "suppliers.json"), "utf8"));
fs.mkdirSync(OUT, { recursive: true });

// ---------- ожидания из набора (отдельная реализация правил, не вызов кода интерфейса) ----------
const S = DATA.suppliers.filter((s) => !s.live_only);
const LIVE = DATA.suppliers.filter((s) => s.live_only);
const byName = new Map(DATA.suppliers.map((s) => [s.name.trim(), s]));
const known = (f) => !!f && f.value !== null && ["found", "claimed", "user"].includes(f.status);
const SERVES = ["Екатеринбург", "Свердловская область", "Урал", "вся Россия"];
const stopped = (s) => {
  if (known(s.company) && s.company.value.status !== "active") return true;
  const reg = known(s.regions_served) ? s.regions_served.value : [];
  const localWh = s.city === "Екатеринбург" && known(s.presence) && s.presence.value === "warehouse";
  return !!(reg.length && !reg.some((r) => SERVES.includes(r)) && !localWh) || !!s.not_supplier;
};
const PRED = {
  door: (s) => known(s.delivery) && s.delivery.value.to_door,
  warehouse: (s) => known(s.presence) && s.presence.value === "warehouse",
  active: (s) => known(s.company) && s.company.value.status === "active",
};
const minRub = (s) => (known(s.min_order) && s.min_order.value.unit === "RUB" ? s.min_order.value.amount ?? 0 : null);
const cat = (id) => DATA.categories.find((c) => c.id === id);
/** Кто попадает в «Вся категория» (поставщики с этой основной категорией) и в подкатегорию (все, кто её продаёт, — и гости из чужих категорий). */
const inCat = (catId, subId) => S.filter((s) => !stopped(s) && (subId ? s.subcategories.includes(subId) : s.category === catId));
const names = (list) => list.map((s) => s.name.trim());
/** Чем два списка имён отличаются — для подробности в протоколе. */
const delta = (actual, expected) => `лишние на экране: ${actual.filter((x) => !expected.includes(x)).join(", ") || "нет"}; не хватает: ${expected.filter((x) => !actual.includes(x)).join(", ") || "нет"}`;
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
const itemsOf = (s) => (s.assortment && known(s.assortment) ? s.assortment.value.items.map((x) => x.name) : s.products.value ?? []);
const hasWord = (s, w) => [s.name, ...itemsOf(s)].join(" ").toLowerCase().split(/[^а-яa-z0-9ё]+/).some((x) => x.startsWith(w));

// ---------- протокол ----------
const log = [];
let failed = 0;
let total = 0;
const step = (t) => { log.push(`\n### ${t}\n`); console.log(`\n== ${t}`); };
function check(ok, what, detail = "") {
  total++;
  if (!ok) failed++;
  const line = `- ${ok ? "✅" : "❌"} ${what}${detail ? ` — ${detail}` : ""}`;
  log.push(line);
  console.log(line);
}
const unix = (s) => s.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const norm = (s) => (s || "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
const int = (t) => Number((norm(t).match(/\d+/) || [])[0]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hashOf = (page) => decodeURIComponent(new URL(page.url()).hash);
const settle = (page, ms = 250) => page.waitForTimeout(ms);

// ---------- приёмы работы с экраном ----------
/** Строки списка результатов: имя, балл, место, пометки. */
const rowsInfo = (page) => page.locator(".rows .lcard").evaluateAll((rs) => rs.map((r) => ({
  name: r.querySelector("a.nm").textContent.trim(),
  score: Number(r.querySelector(".lc-score .score")?.textContent.match(/\d+/)?.[0]),
  rank: r.querySelector(".lc-rank")?.textContent.trim(),
  opt: !!r.querySelector(".opt-pill"),
  fresh: !!r.querySelector(".fresh-pill"),
})));
const rowOf = (page, name) => page.locator(".rows .lcard").filter({ has: page.locator("a.nm", { hasText: new RegExp(`^${esc(name)}$`) }) });
/** Строка вида «Таблица» — в ней флажок сравнения (T-541). */
const tableRowOf = (page, name) => page.locator(".tbl tbody tr").filter({ has: page.locator("a.nm", { hasText: new RegExp(`^${esc(name)}$`) }) });
/** Выпадающий выбор категорий и подкатегорий в колонке (T-541, круг 2). */
const picker = {
  open: async (page) => { if (!(await page.locator(".cpick.open").count())) await page.locator(".cp-trigger").click(); },
  done: async (page) => { if (await page.locator(".cpick.open").count()) await page.locator(".cp-foot .btn", { hasText: "Готово" }).click(); },
  cat: async (page, short) => { await picker.open(page); await page.locator(".cp-cat-h .cp-row", { hasText: short }).click(); await settle(page); },
  all: async (page) => { await picker.open(page); await page.locator(".cp-foot .link-btn", { hasText: "Все категории" }).click(); await settle(page); },
};
const flag = (page, label) => page.locator(".filters .chk", { hasText: label });
const sig = (rows) => rows.map((r) => `${r.name}:${r.score}`).join();

/** Ползунок «минимальный заказ до» — с клавиатуры, как человек: в начало и стрелкой вправо до нужного шага. */
async function setRange(page, target) {
  const r = page.locator(".filters .range input[type=range]");
  await r.focus();
  await r.press("Home");
  for (let i = 0; i < 60; i++) {
    const v = Number(await r.inputValue());
    if (v >= target) break;
    await r.press("ArrowRight");
  }
  return Number(await r.inputValue());
}

/** Закупка в неделю — поле в параметрах рекомендации, в колонке слева (T-541). */
async function setVolume(page, value) {
  const inp = page.locator(".rail-params input[aria-label='Закупка в неделю, рублей']");
  await inp.click();
  await inp.press("Control+A");
  await page.keyboard.type(String(value));
  await inp.press("Enter");
  await settle(page);
}

/** Сравнение: имена колонок по порядку и строки таблицы «поле → ячейки». */
async function readCompare(page) {
  const cols = (await page.locator(".cmp-grid .hd:not(.add):not(.ex) b").allInnerTexts()).map(norm);
  const rows = await page.evaluate((n) => {
    const out = [];
    for (const k of document.querySelectorAll(".cmp-grid .k.sticky")) {
      const label = k.textContent.trim();
      if (!label) continue;
      const cells = [];
      let el = k.nextElementSibling;
      for (let i = 0; i < n && el; i++, el = el.nextElementSibling) cells.push({ text: el.querySelector(".cell-v")?.textContent.replace(/\s+/g, " ").trim() ?? "", miss: el.classList.contains("miss"), best: !!el.querySelector(".best") });
      out.push({ label, cells });
    }
    return out;
  }, cols.length);
  return { cols, rows };
}

/** Строки CSV: "..";".." с удвоенными кавычками. */
const parseCsv = (text) => text.replace(/^﻿/, "").split("\r\n").filter(Boolean).map((l) => (l.match(/"((?:[^"]|"")*)"/g) || []).map((c) => c.slice(1, -1).replace(/""/g, '"')));

// ====================================================================================================
/** Раздел страницы поставщика (T-543): меню — в колонке слева; поля условий и документов — в своих разделах, на «Основном» — виджеты. */
async function cardTab(page, name) {
  await page.locator(".card-nav .nav-item", { hasText: name }).click();
  await page.waitForTimeout(200);
}

(async () => {
  const { server, base } = await serveDist(path.join(ROOT, "web", "dist"));
  const api = await startApiStub();
  const browser = await chromium.launch({ headless: true });
  // один профиль на все три сценария — как один закупщик за одну сессию: шорт-лист копится
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base.replace(/\/$/, "") });
  const page = await ctx.newPage();
  const errors = [];
  const watch = (p, w) => {
    p.on("pageerror", (e) => errors.push(`${w}: ${e.message}`));
    p.on("console", (m) => m.type() === "error" && errors.push(`${w}: ${m.text()}`));
  };
  watch(page, "1440");
  log.push(`# Прогон сценариев интерфейса\n\nДата: ${new Date().toLocaleString("ru-RU")}. Браузер: Chromium headless, 1440×900 и 390×844. Сборка: web/dist, заглушка API на ${api.url}. Набор: ${S.length} поставщиков + ${LIVE.length} для живого сбора, собран ${DATA.meta.collected_at}. Все действия — клики и ввод с клавиатуры; ожидания считаются из data/suppliers.json.`);

  const shots = [];
  const shot = async (p, name) => { await p.screenshot({ path: path.join(OUT, name), fullPage: true }); shots.push(name); };

  // ================= Сценарий 1 =================
  step("Сценарий 1. Закупщик сети ищет контейнеры для роллов");
  await page.goto(base + "#/", { waitUntil: "networkidle" });
  await page.locator(".ways .way", { hasText: "Поиск по товару" }).click();
  await settle(page);
  await page.locator("#q").click();
  await page.keyboard.type("контейнеры для роллов");
  await page.locator("#q").press("Enter");
  await settle(page);
  const sushi = cat("packaging").subcategories.find((x) => x.id === "sushi-boxes");
  const sushiSet = inCat("packaging", "sushi-boxes");
  const headN = int((norm(await page.locator("body").innerText()).match(/\d+\s+поставщик\S*\s+в\s+\d+\s+категори/) || [""])[0]);
  check(headN === sushiSet.length, `поиск «контейнеры для роллов» находит ровно тех, у кого в наборе подкатегория «${sushi.name}»`, `экран: ${headN}, набор: ${sushiSet.length}`);
  await page.locator(".sub-jump a", { hasText: sushi.name }).click();
  await settle(page);
  check(hashOf(page) === "#/results?cat=packaging&sub=sushi-boxes", "«Подкатегория целиком» → результаты рекомендации", hashOf(page));

  let rows = await rowsInfo(page);
  const miss1 = names(sushiSet).filter((n) => !rows.some((r) => r.name === n));
  const extra1 = rows.map((r) => r.name).filter((n) => !names(sushiSet).includes(n));
  check(sameSet(rows.map((r) => r.name), names(sushiSet)), `в списке все поставщики подкатегории из набора: ${rows.length}`, `пропали: ${miss1.join(", ") || "нет"}; лишние: ${extra1.join(", ") || "нет"}`);
  check(rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score), "список по рекомендации идёт по убыванию балла", rows.map((r) => r.score).join(" ≥ "));
  check(rows.every((r, i) => r.rank === String(i + 1)), "место по рекомендации под логотипом: 1, 2, 3… без пропусков");

  const zone = await page.locator(".first .gcard").evaluateAll((cs) => cs.map((c) => ({
    name: c.querySelector(".nm").textContent.trim(),
    score: Number(c.querySelector(".score").textContent.match(/\d+/)[0]),
    signal: !!c.querySelector(".signal"),
    why: c.querySelector(".why").textContent.replace(/\s+/g, " ").trim(),
    ask: (c.querySelector(".ask")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  })));
  check(zone.length === 3, "сверху три карточки «Кому написать первым»");
  check(zone.map((z) => z.name).join() === rows.filter((r) => !r.opt).slice(0, 3).map((r) => r.name).join(), "это три верхних строки списка (кроме крупного опта)", zone.map((z) => z.name).join(", "));
  check(zone[0].signal && !zone[1].signal && !zone[2].signal, "метка «первым» только у лидера");
  check(zone.every((z) => z.score === rows.find((r) => r.name === z.name).score), "балл на карточке совпадает с баллом в списке", zone.map((z) => z.score).join(", "));
  check(zone[0].why.length > 20 && zone[0].ask.startsWith("Уточните в первом письме:"), "у лидера — «почему» и «что уточнить» одной строкой", `${zone[0].why} ${zone[0].ask}`);
  check(zone.slice(1).every((z) => z.why.length > 20 && /^Уточнить:/.test(z.ask)), "у остальных — «чем уступает» и «что уточнить»", zone[1].why);

  // закупка и приоритет двигают баллы
  const before = sig(rows);
  await setVolume(page, 1000);
  check(hashOf(page) === "#/results?cat=packaging&sub=sushi-boxes&vol=1000", "закупка 1 000 ₽ в неделю попала в адрес", hashOf(page));
  check(sig(await rowsInfo(page)) !== before, "при закупке 1 000 ₽ (минимальные заказы ~3 500 ₽ стали больше закупки) баллы пересчитались");
  await setVolume(page, 20000);
  check(sig(await rowsInfo(page)) === before, "возврат к 20 000 ₽ возвращает те же баллы");
  await page.locator(".rail-params select").selectOption({ label: "Надёжность и документы" });
  await settle(page);
  check(hashOf(page).includes("prio=reliability"), "«что важнее» → «Надёжность и документы» в адресе", hashOf(page));
  const relRows = await rowsInfo(page);
  check(sig(relRows) !== before && relRows.every((r, i) => i === 0 || relRows[i - 1].score >= r.score), "баллы пересчитаны и список снова по убыванию");
  await page.locator(".rail-params select").selectOption({ label: "Сбалансированно" });
  await settle(page);

  // фильтры — на всей категории, ожидания из набора
  await picker.cat(page, cat("packaging").short);
  await picker.done(page);
  await settle(page, 300);
  const pack = inCat("packaging", null);
  rows = await rowsInfo(page);
  check(sameSet(rows.map((r) => r.name), names(pack)), `«Вся категория»: ${rows.length} поставщиков = набор (с гостями из других категорий)`, `в наборе ${pack.length}`);
  const nStopped = S.filter(stopped).length;
  check(nStopped === 0 && (await page.locator(".excluded-toggle").count()) === 0, "в наборе нет ликвидированных, «не возит к нам» и «не поставщиков» — блока «Исключены» нет", `стоп-условий в наборе: ${nStopped}`);

  await flag(page, "Доставка до точки").click();
  await settle(page);
  let want = pack.filter(PRED.door);
  rows = await rowsInfo(page);
  check(sameSet(rows.map((r) => r.name), names(want)), `«Доставка до точки»: остаются ровно те, у кого в наборе to_door — ${want.length}`, delta(rows.map((r) => r.name), names(want)));
  const head = norm(await page.locator(".list-count").innerText());
  check(head.includes(`${pack.length - want.length} скрыто фильтрами`), "над списком сказано, сколько скрыто", head);
  await flag(page, "Компания действует").click();
  await settle(page);
  want = pack.filter((s) => PRED.door(s) && PRED.active(s));
  rows = await rowsInfo(page);
  check(sameSet(rows.map((r) => r.name), names(want)), `+ «Компания действует» (фильтры складываются): ${want.length}`, delta(rows.map((r) => r.name), names(want)));
  check(/f=door(,|%2C)active/.test(page.url()), "фильтры лежат в адресе — ссылкой можно поделиться", hashOf(page));

  const v1 = await setRange(page, 5000);
  check(v1 === 5000, "ползунок «минимальный заказ до» стоит на 5 000 ₽", String(v1));
  want = pack.filter((s) => PRED.door(s) && PRED.active(s) && (minRub(s) === null || minRub(s) <= 5000));
  rows = await rowsInfo(page);
  const withUnknown = want.filter((s) => minRub(s) === null);
  check(sameSet(rows.map((r) => r.name), names(want)), `до 5 000 ₽: остаются те, у кого минимум ≤ 5 000 ₽ или не указан в рублях — ${want.length}`, `из них без минимума в рублях: ${withUnknown.length}`);
  check(withUnknown.length > 0 && (await page.locator(".list-count .pop-btn").count()) === 1, "неизвестный минимум не выкинут молча — рядом «?» с объяснением");
  await page.locator(".list-count .pop-btn").click();
  check(norm(await page.locator(".pop-body").textContent()).includes("помечены"), "в «?» объяснено, почему они остались");
  await page.keyboard.press("Escape");
  await flag(page, "и где не указан").click();
  await settle(page);
  want = want.filter((s) => minRub(s) !== null);
  rows = await rowsInfo(page);
  check(sameSet(rows.map((r) => r.name), names(want)), `«и где не указан» снята — остаются только с известным минимумом: ${want.length}`, delta(rows.map((r) => r.name), names(want)));
  check((await page.locator(".list-count .pop-btn").count()) === 0, "«?» про неизвестный минимум исчез вместе с ними");
  await page.locator(".filters").getByRole("button", { name: "Сбросить" }).click();
  await settle(page);
  rows = await rowsInfo(page);
  check(rows.length === pack.length && !/[?&](f|max|unk)=/.test(page.url()), "«Сбросить» возвращает всех и чистит адрес", `${rows.length}, ${hashOf(page)}`);

  // поиск внутри категории и сортировка
  await page.locator("input[aria-label='Поиск по названию и товарам в выбранном']").fill("крафт");
  await settle(page);
  want = pack.filter((s) => hasWord(s, "крафт"));
  rows = await rowsInfo(page);
  check(want.length > 0 && sameSet(rows.map((r) => r.name), names(want)), `«Поиск в категории: крафт» — те, у кого слово есть в названии или товарах: ${want.length}`, delta(rows.map((r) => r.name), names(want)));
  await page.locator("input[aria-label='Поиск по названию и товарам в выбранном']").fill("");
  await page.locator("select[aria-label='Сортировка']").selectOption({ label: "По минимальному заказу" });
  await settle(page);
  rows = await rowsInfo(page);
  const mins = rows.map((r) => minRub(byName.get(r.name)) ?? Infinity);
  check(mins.every((m, i) => i === 0 || mins[i - 1] <= m), "сортировка «По минимальному заказу»: по возрастанию, без рублёвого минимума — в конце", mins.slice(0, 8).map((m) => (m === Infinity ? "—" : m)).join(" ≤ ") + " …");
  await page.locator("select[aria-label='Сортировка']").selectOption({ label: "По рекомендации" });
  await settle(page);

  // вид «Таблица»
  rows = await rowsInfo(page);
  await page.locator(".seg[aria-label='Вид'] button", { hasText: "Таблица" }).click();
  await settle(page);
  const trs = await page.locator(".tbl tbody tr").count();
  const th = (await page.locator(".tbl thead th").allInnerTexts()).map(norm).filter(Boolean);
  check(trs === rows.length && hashOf(page).includes("view=table"), `вид «Таблица»: ${trs} строк = число поставщиков в списке`, th.join(" · "));
  check((await page.locator(".tbl tbody a.nm").allInnerTexts()).map(norm).join() === rows.map((r) => r.name).join(), "порядок в таблице тот же, что в списке");
  await page.locator(".seg[aria-label='Вид'] button", { hasText: "Список" }).click();
  await settle(page);

  // выбираем троих: лидер, тот, у кого «Оплата и отсрочка» не найдена (и есть декларации), и тот, чья компания не проверена
  rows = await rowsInfo(page);
  const pickA = rows[0].name;
  const pickB = rows.find((r) => r.name !== pickA && byName.get(r.name).payment_terms.status === "not_found" && (byName.get(r.name).documents.declarations.value || []).length > 0).name;
  const pickC = rows.find((r) => ![pickA, pickB].includes(r.name) && !known(byName.get(r.name).company)).name;
  const picks1 = [pickA, pickB, pickC];
  const rankB = rows.findIndex((r) => r.name === pickB) + 1;
  const nRows1 = rows.length;
  // T-541: карточка списка целиком — ссылка, второй кнопкой в ней только звёздочка; сравнение отмечается в виде «Таблица»
  check(await rowOf(page, pickA).locator(".chk").count() === 0, "в карточке списка нет флажка «сравнить» — только звёздочка");
  await page.locator(".seg[aria-label='Вид'] button", { hasText: "Таблица" }).click();
  await settle(page);
  for (const n of picks1) await tableRowOf(page, n).locator(".chk").click();
  check(norm(await page.locator(".selbar").textContent()).includes("Выбрано 3 из 4"), "в таблице отмечены трое — панель «Выбрано 3 из 4»", picks1.join(", "));
  const spare = rows.filter((r) => !picks1.includes(r.name)).map((r) => r.name);
  await tableRowOf(page, spare[0]).locator(".chk").click();
  await tableRowOf(page, spare[1]).locator(".chk").click();
  check(norm(await page.locator(".selbar").textContent()).includes("Выбрано 4 из 4") && !(await tableRowOf(page, spare[1]).locator("input").isChecked()), "пятого выбрать нельзя: потолок «4 из 4»", `пятый — ${spare[1]}`);
  await tableRowOf(page, spare[0]).locator(".chk").click();
  check(norm(await page.locator(".selbar").textContent()).includes("Выбрано 3 из 4"), "четвёртого снимаем — снова «3 из 4»");

  await page.locator(".selbar").getByRole("link", { name: "Сравнить" }).click();
  await page.waitForURL(/#\/compare/);
  await page.locator(".conclusion").waitFor();
  let cmp = await readCompare(page);
  const idsOf = (ns) => ns.map((n) => byName.get(n).id);
  check(sameSet(cmp.cols, picks1) && cmp.cols.length === 3, "сравнение: три колонки — ровно отмеченные", cmp.cols.join(" | "));
  const colScores = (await page.locator(".cmp-grid .hd:not(.add):not(.ex) .score").allInnerTexts()).map(int);
  check(colScores.every((v, i) => i === 0 || colScores[i - 1] >= v), "колонки упорядочены по баллу", colScores.join(" ≥ "));
  check(cmp.rows.map((r) => r.label).join(" · ") === "Минимальный заказ · Цены · Доставка · Регион работы · Документы · Компания · НДС · Работа с ресторанами · Контакты · Полнота данных", "строки сравнения — поля карточки в фиксированном порядке");
  const bestCells = cmp.rows.flatMap((r) => r.cells.filter((c) => c.best));
  check(bestCells.length > 0 && bestCells.every((c) => !c.miss), "▲ «лучший» стоит, и ни разу — на «не найдено»", `${bestCells.length} отметок`);
  check(cmp.rows.every((r) => !r.cells.some((c) => c.best) || new Set(r.cells.map((c) => c.text)).size > 1), "▲ только в строках, где значения различаются");
  const concl = norm(await page.locator(".conclusion").textContent());
  check(concl.startsWith(`Первым — ${cmp.cols[0]}:`), "вывод под таблицей называет лидера первой колонки", concl.slice(0, 120));
  const conclP = await page.locator(".conclusion p").allInnerTexts();
  check(conclP.length === 3 && cmp.cols.slice(1).every((n, i) => norm(conclP[i + 1]).startsWith(`${n}:`)), "и по строке про каждого из остальных, чем он уступает");
  await shot(page, "_s1-compare.png");

  // × убирает колонку; «Только различия» проверяем на оставшейся паре — у двоих есть совпадающие строки
  const gone = cmp.cols[2];
  await page.locator(`.cmp-grid button.x[aria-label='Убрать ${gone} из сравнения']`).click();
  await settle(page);
  cmp = await readCompare(page);
  check(cmp.cols.length === 2 && !cmp.cols.includes(gone) && decodeURIComponent(page.url()).includes(`ids=${idsOf(cmp.cols).join(",")}`), `× убирает колонку «${gone}», адрес обновился`, cmp.cols.join(" | "));
  const same = cmp.rows.filter((r) => new Set(r.cells.map((c) => c.text)).size === 1).map((r) => r.label);
  await page.locator(".page-tools .chk", { hasText: "Только различия" }).click();
  const diffOnly = await readCompare(page);
  check(same.length > 0 && diffOnly.rows.length === cmp.rows.length - same.length && diffOnly.rows.every((r) => new Set(r.cells.map((c) => c.text)).size > 1), "«Только различия»: совпадающие строки скрыты, остальные на месте", `было ${cmp.rows.length}, скрыто: ${same.join(", ")}`);
  await page.locator(".page-tools .chk", { hasText: "Только различия" }).click();
  check((await readCompare(page)).rows.length === cmp.rows.length, "снять «Только различия» — строки возвращаются");
  await page.locator("select[aria-label='Добавить поставщика в сравнение']").selectOption({ label: gone });
  await settle(page);
  cmp = await readCompare(page);
  check(cmp.cols.length === 3 && cmp.cols.includes(gone), "«+ добавить» возвращает её");

  // карточка того, у кого оплата не найдена
  await page.locator(".cmp-grid .hd a", { hasText: pickB }).click();
  await page.waitForURL(/#\/s\//);
  await page.locator(".card-grid").waitFor();
  const sB = byName.get(pickB);
  // поля с цитатами — во вкладках «Условия» и «Документы» страницы поставщика (T-543)
  await cardTab(page, "Условия");
  const quotes = (await page.locator(".field .q").allInnerTexts()).map(norm);
  const payF = page.locator(".field", { hasText: "Оплата и отсрочка" });
  await payF.locator(".pop-btn").click();
  check(norm(await payF.locator(".v").first().textContent()).startsWith("не найдено"), "«Оплата и отсрочка»: явное «не найдено», а не пустота");
  const where = norm(await page.locator(".pop-body").textContent());
  check(where.includes("Искали:") && where.includes(norm(sB.payment_terms.searched_in[0])), "«?» говорит, где искали, — из набора", sB.payment_terms.searched_in[0].slice(0, 60));
  await page.keyboard.press("Escape");
  await cardTab(page, "Документы");
  quotes.push(...(await page.locator(".field .q").allInnerTexts()).map(norm));
  const expectQuoted = [sB.min_order, sB.prices, sB.delivery, sB.regions_served, sB.works_with_horeca, sB.payment_terms, sB.documents.declarations, sB.documents.site_mentions, sB.hours].filter((f) => f && f.quote && !["not_found", "estimated"].includes(f.status)).length;
  check(quotes.length > 0 && quotes.length >= expectQuoted - 1, `во вкладках «Условия» и «Документы» у значений — цитаты с сайта: ${quotes.length} (полей с цитатой в наборе: ${expectQuoted})`);
  check(known(sB.min_order) && quotes.includes(`«${norm(sB.min_order.quote)}»`), "цитата под «Минимальный заказ» — дословно из набора", norm(sB.min_order.quote).slice(0, 90));
  const decl = sB.documents.declarations.value || [];
  check((await page.locator(".decls li").count()) === decl.length, `декларации в карточке: ${decl.length} из реестра Росаккредитации`);
  check(norm(await page.locator(".decls").innerText()).includes(decl[0].number), "у декларации виден её номер", decl[0].number);
  await cardTab(page, "Основное");                  // компания, контакты, заметки — плашки «Основного»
  const stText = norm(await page.locator(".status .status-h").textContent());
  check(known(sB.company) ? stText.includes("Действует") : stText.includes("Не проверена"), "блок «Компания»: статус по набору", stText);
  const placeTxt = norm(await page.locator(".sp-place").innerText());
  check(placeTxt.startsWith(`${rankB}-й из ${nRows1}`), `место в карточке совпадает с местом в списке, откуда пришли (${rankB}-й из ${nRows1})`, placeTxt);
  const phones = sB.phones.value || [];
  const contacts = norm(await page.locator(".mini-fields").innerText());
  check(phones.every((p) => contacts.includes(norm(p))), "в контактах все телефоны из набора", phones.join(", "));

  await page.getByRole("button", { name: "В шорт-лист" }).first().click();
  check(await page.getByRole("button", { name: "В шорт-листе" }).first().isVisible(), "«В шорт-лист» — кнопка меняет состояние");
  check((await page.locator(".side-nav .count").innerText()).trim() === "1", "в меню у «Шорт-лист» появился счётчик 1");
  await page.getByRole("link", { name: "Написать — черновик запроса" }).click();
  await page.waitForURL(/#\/shortlist/);
  const draft1 = await page.locator(".draft-text").inputValue();
  const qLines = draft1.split("\n").filter((l) => l.startsWith("—"));
  check(draft1.includes("Подскажите, пожалуйста:") && qLines.some((l) => /оплаты и возможна ли отсрочка/.test(l)), "черновик: вопрос про оплату и отсрочку — потому что поле пустое", qLines.join(" "));
  const draftSub = cat(sB.category).subcategories.find((x) => sB.subcategories.includes(x.id)).name.toLowerCase();
  check(norm(draft1).includes("Закупка — около 20 000 ₽ в неделю") && draft1.includes(`ищем поставщика: ${draftSub}.`), "в черновике — закупка из запроса и товар, который поставщик правда продаёт (первая его подкатегория)", draft1.split("\n")[2]);
  check(qLines.length >= 2 && qLines.length <= 4 && qLines.slice(0, -1).every((l) => l.endsWith(";")) && qLines.at(-1).endsWith("."), "вопросов 2–4, списком через «;» и точкой в конце", String(qLines.length));
  await page.locator(".draft").getByRole("button", { name: "Скопировать" }).click();
  await settle(page, 150);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => "ERR " + e.message));
  check(unix(clip) === draft1 && (await page.locator(".draft .btn.pr").innerText()) === "Скопировано", "«Скопировать» кладёт в буфер ровно этот текст", unix(clip) === draft1 ? "" : `в буфере: ${clip.slice(0, 80)}; кнопка: ${await page.locator(".draft .btn.pr").innerText()}`);
  const mail = sB.emails.value[0];
  check((await page.locator(".draft a", { hasText: "Открыть в почте" }).getAttribute("href")).startsWith(`mailto:${mail}?subject=`), "«Открыть в почте» — письмо на адрес из набора", mail);

  // ================= Сценарий 2 =================
  step("Сценарий 2. Владелец точки срочно меняет поставщика лосося");
  const salmon = cat("fish").subcategories.find((x) => x.id === "salmon");
  await page.locator(".side-nav .nav-item", { hasText: "Поиск по категории" }).click();
  await settle(page);
  await page.locator(".cat-acc-h", { hasText: cat("fish").short }).click();
  await page.locator(".cat-sub", { hasText: salmon.name }).first().click();
  await page.locator(".cats-go-btn").click();   // T-541, круг 3: подкатегории отмечаются, переход — кнопкой справа
  await settle(page, 300);
  const salmonSet = inCat("fish", "salmon");
  rows = await rowsInfo(page);
  check(hashOf(page) === "#/results?cat=fish&sub=salmon" && sameSet(rows.map((r) => r.name), names(salmonSet)), `каталог → Рыба → «${salmon.name}»: ${rows.length} поставщиков = набор`, hashOf(page));
  await page.locator(".rail-params select").selectOption({ label: "Быстрая доставка" });
  await settle(page);
  check(hashOf(page).includes("prio=fast"), "«что важнее» → «Быстрая доставка»", hashOf(page));
  const fastRows = await rowsInfo(page);
  check(fastRows.every((r, i) => i === 0 || fastRows[i - 1].score >= r.score), "список по убыванию балла при весах «доставка»");
  check(norm(await page.locator(".first .gcard.lead .nm").innerText()) === fastRows.find((r) => !r.opt).name, "лидер зоны «Кому написать первым» — верхняя строка списка");

  await flag(page, "Склад в Екатеринбурге").click();
  await flag(page, "Доставка до точки").click();
  await settle(page);
  want = salmonSet.filter((s) => PRED.warehouse(s) && PRED.door(s));
  rows = await rowsInfo(page);
  check(want.length > 0 && sameSet(rows.map((r) => r.name), names(want)), `«склад в городе» + «доставка до точки»: ${want.map((s) => s.name).join(", ")}`, `экран ${rows.map((r) => r.name).join(", ")}`);
  const v2 = await setRange(page, 10000);
  rows = await rowsInfo(page);
  check(v2 === 10000 && sameSet(rows.map((r) => r.name), names(want.filter((s) => minRub(s) === null || minRub(s) <= 10000))), "до 10 000 ₽: поставщик с минимумом в килограммах остаётся — в рублях его не сравнить", rows.map((r) => r.name).join(", "));
  await flag(page, "и где не указан").click();
  await settle(page);
  check((await rowsInfo(page)).length === want.filter((s) => minRub(s) !== null && minRub(s) <= 10000).length && (await page.locator(".empty-list").count()) === 1 && norm(await page.locator(".empty-list").innerText()).includes("Под фильтры никто не подошёл"), "если никто не подошёл — так и сказано, а не пустой экран");
  check((await page.locator(".first").count()) === 0, "блока «Кому написать первым» при пустом списке нет");
  await page.locator(".empty-list").getByRole("button", { name: "Сбросить" }).click();
  await settle(page);
  check((await rowsInfo(page)).length === salmonSet.length && hashOf(page) === "#/results?cat=fish&sub=salmon&prio=fast", "«Сбросить» в пустом списке возвращает всех, «что важнее» остаётся", hashOf(page));

  await flag(page, "Склад в Екатеринбурге").click();
  await settle(page);
  rows = await rowsInfo(page);
  const lead2 = rows.find((r) => !r.opt).name;
  const s2 = byName.get(lead2);
  check(rows.length === salmonSet.filter(PRED.warehouse).length, `со складом в городе: ${rows.length}; лидер при весах «доставка» — ${lead2}`);
  await page.locator(".first .gcard").first().click();
  await page.waitForURL(/#\/s\//);
  const id2 = decodeURIComponent(hashOf(page).split("/s/")[1].split("?")[0]);
  check(id2 === s2.id, "клик по карточке лидера открывает его карточку", id2);
  await cardTab(page, "Условия");
  const card2 = norm(await page.locator(".card-page").innerText());
  check(known(s2.delivery) && (!s2.delivery.value.lead_time || card2.includes(norm(s2.delivery.value.lead_time))), "срок доставки на карточке — из набора", s2.delivery.value?.lead_time ?? "срока нет в наборе");
  if (s2.delivery.quote) check((await page.locator(".field", { hasText: "Доставка" }).first().locator(".q").first().innerText()).includes(norm(s2.delivery.quote).slice(0, 40)), "у доставки — цитата с сайта", norm(s2.delivery.quote).slice(0, 70));
  await cardTab(page, "Документы");
  const docHead = page.locator(".section-h", { hasText: "Документы" });
  await docHead.locator(".pop-btn").click();
  check(norm(await page.locator(".pop-body").textContent()).includes("ВетИС"), "у рыбы в «Документах» есть «?»: ветеринарные документы по ИНН не проверить, ВетИС — по номеру");
  await page.keyboard.press("Escape");
  const mark = s2.documents.marking;
  const markRow = norm(await page.locator(".field", { hasText: "«Честный знак»" }).innerText());
  check(mark && known(mark) ? markRow.includes(`участник: ${mark.value.join(", ")}`) : markRow.includes("не найдено"), "«Честный знак»: группы из набора или «не найдено»", markRow.slice(0, 120));
  await cardTab(page, "Основное");
  check(norm(await page.locator(".asks").innerText()).includes("ветеринарные документы (Меркурий)"), "в «Что уточнить» для рыбы — вопрос про Меркурий");
  const contacts2 = norm(await page.locator(".mini-fields").innerText());
  check((s2.phones.value || []).every((p) => contacts2.includes(norm(p))) && (s2.messengers.value || []).every((m) => contacts2.includes(m)), "телефоны и мессенджеры из набора на месте", `${(s2.phones.value || []).join(", ")}; ${(s2.messengers.value || []).join(", ")}`);

  // статус и заметка живут у записи шорт-листа: без звёздочки их нет
  check(norm(await page.locator(".notes").innerText()).includes("Статус контакта и заметки ведутся для поставщиков из шорт-листа"), "до звёздочки заметок нет: «ведутся для поставщиков из шорт-листа»");
  await page.locator(".notes").getByRole("button", { name: "В шорт-лист" }).click();
  await page.locator(`#st-${id2}`).selectOption("Ответил");
  await page.locator(`#note-${id2}`).click();
  await page.keyboard.type("мин. 10 кг, привоз пн/чт");
  check(await page.getByRole("button", { name: "Сохранить заметку" }).isEnabled(), "после ввода «Сохранить заметку» доступна");
  await page.getByRole("button", { name: "Сохранить заметку" }).click();
  check(norm(await page.locator(".notes .panel-h").textContent()).includes("сохранено") && !(await page.getByRole("button", { name: "Сохранить заметку" }).isEnabled()), "заметка сохранена: время рядом, кнопка снова серая");
  await page.locator(".side-nav .nav-item", { hasText: "Шорт-лист" }).click();
  await page.waitForURL(/#\/shortlist/);
  let row2 = page.locator(".sl-row", { hasText: lead2 });
  check((await row2.locator(".sl-note input").inputValue()) === "мин. 10 кг, привоз пн/чт" && (await row2.locator(".sl-note .st").count()) === 1, "заметка с пометкой ✎ видна в шорт-листе");
  check((await row2.locator("select").inputValue()) === "Ответил", "статус «Ответил» виден в шорт-листе");
  await page.reload({ waitUntil: "networkidle" });
  row2 = page.locator(".sl-row", { hasText: lead2 });
  check((await row2.locator("select").inputValue()) === "Ответил" && (await row2.locator(".sl-note input").inputValue()) === "мин. 10 кг, привоз пн/чт", "после перезагрузки страницы статус и заметка на месте (хранятся в браузере)");
  check((await page.locator(".sl-row").count()) === 2 && (await page.locator(".side-nav .count").innerText()).trim() === "2", "в шорт-листе двое — из первого сценария и этот; счётчик в меню «2»");

  // ================= Сценарий 3 =================
  step("Сценарий 3. Трое на примете: сравнить и решить, кому писать первым");
  const bySite = LIVE.find((s) => s.live_only === "site");
  const byInn = LIVE.find((s) => s.live_only === "inn");
  const site = bySite.website.value.replace(/^https?:\/\//, "");
  await page.locator(".side-nav .nav-item", { hasText: "Знаю поставщика" }).click();
  await settle(page);
  const ex = (await page.locator(".examples .pill-out").allInnerTexts()).map(norm);
  check(ex.length === LIVE.length && ex.some((t) => t.includes(site)) && ex.some((t) => t.includes(byInn.inn.value)), "примеры на экране — оба из набора: сайт и ИНН", ex.join(" | "));
  await page.getByLabel("Сайт или ИНН").click();
  await page.keyboard.type(site);
  await page.getByRole("button", { name: "Собрать" }).click();
  await page.locator(".run-h", { hasText: "Готово" }).waitFor({ timeout: 15000 });
  const stepTexts = (loc) => loc.evaluateAll((ls) => ls.map((l) => l.lastElementChild.textContent.replace(/\s+/g, " ").trim()));
  const sitSteps = await stepTexts(page.locator(".steps li.done"));
  check(sitSteps.length === 6 && sitSteps[0].startsWith("Открыли сайт") && sitSteps[1].includes(bySite.inn.value), "сбор по сайту: шесть шагов, ИНН в шаге 2 — из набора", sitSteps[1]);
  check(sitSteps.some((t) => t.startsWith("ФНС: ")) && sitSteps.some((t) => t.startsWith("Росаккредитация: ")), "в шагах — проверка в ФНС и Росаккредитации");
  const rc = page.locator(".result-card");
  check(norm(await rc.locator(".nm").textContent()) === bySite.name && norm(await rc.locator(".rank").textContent()).includes("собрано сейчас"), "карточка результата: имя и пометка «собрано сейчас»", bySite.name);
  const rcSub = norm(await rc.locator(".sub").textContent());
  const placeM = rcSub.match(/(\d+)-й из (\d+) в категории/);
  const nPack = inCat(bySite.category, null).length + 1;
  check(!!placeM && Number(placeM[2]) === nPack, `«${rcSub}»: в категории теперь на одного больше (${nPack})`);

  // ИНН: сначала ФНС, потом сайт на подтверждение; «нет» отменяет
  await page.getByLabel("Сайт или ИНН").fill(byInn.inn.value);
  await page.getByRole("button", { name: "Собрать" }).click();
  await page.locator(".confirm").waitFor({ timeout: 10000 });
  const innSteps = await stepTexts(page.locator(".steps li"));
  check(innSteps[0].includes("ЕГРЮЛ") && innSteps[0].includes(byInn.legal_name.value) && innSteps[1].includes("Ищем сайт"), "по ИНН: сначала ЕГРЮЛ с названием юрлица, потом поиск сайта", innSteps.join(" / "));
  const siteOfInn = byInn.website.value.replace(/^https?:\/\//, "");
  check(norm(await page.locator(".confirm").textContent()).includes(siteOfInn), "найденный сайт показан на подтверждение, а не взят молча", siteOfInn);
  await page.getByRole("button", { name: "Нет, введу сайт сам" }).click();
  check((await page.locator(".confirm").count()) === 0 && (await page.locator(".run .steps li.done").count()) === 0, "«Нет» отменяет сбор: подтверждения и шагов нет");
  await page.getByLabel("Сайт или ИНН").fill(byInn.inn.value);
  await page.getByRole("button", { name: "Собрать" }).click();
  await page.locator(".confirm").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Да, собрать с этого сайта" }).click();
  await page.locator(".run-h", { hasText: "Готово" }).waitFor({ timeout: 15000 });
  check(norm(await rc.locator(".nm").textContent()) === byInn.name, "после подтверждения собрана карточка по ИНН", byInn.name);
  await page.getByLabel("Сайт или ИНН").fill(S[0].website.value.replace(/^https?:\/\//, ""));
  await page.getByRole("button", { name: "Собрать" }).click();
  check(norm(await page.locator(".add-page .panel b").first().textContent()).includes("уже есть в собранном наборе"), "сайт из основного набора не собирается заново: «уже есть в собранном наборе»", S[0].name);

  await page.getByLabel("Сайт или ИНН").fill(site);
  await page.getByRole("button", { name: "Собрать" }).click();
  await page.locator(".result-card").waitFor({ timeout: 15000 });
  await page.getByRole("link", { name: "Сравнить с остальными" }).click();
  await page.waitForURL(/#\/results/);
  await page.locator(".rows .lcard").first().waitFor();
  rows = await rowsInfo(page);
  const fresh = rows.filter((r) => r.fresh).map((r) => r.name);
  check(fresh.join() === bySite.name && rows.length === nPack, `в выдаче категории — собранный сейчас (${bySite.name}) с пометкой, всего ${rows.length}`, `пометки: ${fresh.join(", ")}`);
  const myPlace = rows.findIndex((r) => r.name === bySite.name) + 1;
  check(myPlace === Number(placeM[1]), `его место в списке (${myPlace}-й) = месту в результате сбора (${placeM[1]}-й)`);

  // сессия помнит прошлые выборы: «что важнее» из сценария 2 и отмеченные для сравнения в сценарии 1
  check((await page.locator(".rail-params select").inputValue()) === "fast", "«что важнее» осталось от прошлого запроса — «Быстрая доставка»");
  check(norm(await page.locator(".selbar").textContent()).includes("Выбрано 3 из 4"), "отмеченные в сценарии 1 трое всё ещё выбраны для сравнения");
  await page.locator(".selbar").getByRole("button", { name: "очистить" }).click();
  check((await page.locator(".selbar").count()) === 0, "«очистить» снимает выбор, панель исчезает");
  await page.locator(".rail-params select").selectOption({ label: "Сбалансированно" });
  await settle(page);
  rows = await rowsInfo(page);
  // трое: собранный сейчас + два верхних из остальных
  const others = rows.filter((r) => !r.fresh && !r.opt).slice(0, 2).map((r) => r.name);
  const trio = [bySite.name, ...others];
  await page.locator(".seg[aria-label='Вид'] button", { hasText: "Таблица" }).click();
  await settle(page);
  for (const n of trio) await tableRowOf(page, n).locator(".chk").click();
  await page.locator(".selbar").getByRole("link", { name: "Сравнить" }).click();
  await page.waitForURL(/#\/compare/);
  await page.locator(".conclusion").waitFor();
  cmp = await readCompare(page);
  check(sameSet(cmp.cols, trio), "сравнение: собранный сейчас рядом с двумя из выдачи", cmp.cols.join(" | "));
  const leaderCmp = cmp.cols[0];
  await page.locator(".conclusion a").click();
  await page.waitForURL(/#\/s\/.*tab=why/);
  // разбор — вкладка «Разбор» на странице лидера сравнения, второй из сравнения — рядом (T-543)
  const readWhy = async () => ({
    me: norm(await page.locator(".brk-h.me .brk-h-nm").innerText()),
    vs: (await page.locator(".brk-h.vs .brk-h-nm").count()) ? norm(await page.locator(".brk-h.vs .brk-h-nm").innerText()).replace(/\s*↗$/, "") : null,
    w: (await page.locator(".brk-k:not(.brk-hk):not(.brk-total) .num").allInnerTexts()).map(int),
    c: (await page.locator(".brk-c.cur:not(.brk-total) .brk-contrib").allInnerTexts()).map((t) => Number(norm(t).replace("+", "").replace(",", "."))),
    total: int(await page.locator(".brk-c.cur.brk-total .snum").innerText()),
    vsTotal: (await page.locator(".brk-c.vs.brk-total .snum").count()) ? int(await page.locator(".brk-c.vs.brk-total .snum").innerText()) : null,
    order: await page.locator(".order.rk li").evaluateAll((ls) => ls.map((l) => ({ name: l.querySelector(".nm").firstChild.textContent.trim(), score: Number(l.querySelector(".snum").textContent), me: l.classList.contains("me") }))),
  });
  const why = await readWhy();
  const trioOrder = (o) => o.filter((x) => trio.includes(x.name)).map((x) => x.name);
  check(why.me === leaderCmp && why.vs === cmp.cols[1], "«Почему такой порядок» из сравнения открывает «Разбор» лидера, второй из сравнения — рядом", `${why.me} | ${why.vs}`);
  check(why.w.length === 6 && why.w.reduce((a, b) => a + b, 0) === 100, "веса шести критериев в сумме 100", why.w.join(" + "));
  check(Math.abs(why.c.reduce((a, b) => a + b, 0) - why.total) <= 1, "вклады критериев в сумме дают итоговый балл", `${why.c.join(" + ")} ≈ ${why.total}`);
  check(sameSet(trioOrder(why.order), trio) && trioOrder(why.order)[0] === leaderCmp && why.order.find((o) => o.me).score === why.total && why.order.every((o, i) => i === 0 || why.order[i - 1].score >= o.score),
    "рейтинг категории по убыванию, трое из сравнения в нём, лидер сравнения — выше двоих", trioOrder(why.order).join(" › "));
  await shot(page, "_s3-why-balanced.png");
  const prio = (label) => page.locator(".card-rail .prio-sw button", { hasText: label });
  await prio("Условия").click();
  await settle(page);
  const wTerms = await readWhy();
  check(hashOf(page).includes("prio=terms") && hashOf(page).startsWith(`#/s/${byName.get(leaderCmp).id}`) && wTerms.w[2] > why.w[2] && wTerms.w[4] > why.w[4] && wTerms.w.reduce((a, b) => a + b, 0) === 100, "«Условия и цена»: веса минимального заказа и цен выросли, сумма всё равно 100", `${why.w.join("/")} → ${wTerms.w.join("/")}`);
  check(Math.abs(wTerms.c.reduce((a, b) => a + b, 0) - wTerms.total) <= 1 && wTerms.order.every((o, i) => i === 0 || wTerms.order[i - 1].score >= o.score), "и там вклады дают итог, порядок по убыванию", wTerms.order.map((o) => `${o.name} ${o.score}`).join(" › "));
  await prio("Доставка").click();
  await settle(page);
  const wFast = await readWhy();
  check(wFast.w[3] > why.w[3] && wFast.w.reduce((a, b) => a + b, 0) === 100, "«Быстрая доставка»: вес доставки вырос", `${why.w[3]} → ${wFast.w[3]}`);
  await prio("Надёжность").click();
  await settle(page);
  const wRel = await readWhy();
  check(wRel.w[0] > why.w[0] && wRel.w[1] > why.w[1], "«Надёжность и документы»: вес надёжности и документов вырос", `${why.w.join("/")} → ${wRel.w.join("/")}`);
  const second = wRel.order.find((o) => !o.me).name;
  await page.locator(".order.rk li:not(.me)", { hasText: second }).first().locator(".rk-cmp").click();
  await settle(page, 600);
  const wFocus = await readWhy();
  check(wFocus.vs === second && wFocus.vsTotal === wRel.order.find((o) => o.name === second).score && wFocus.me === leaderCmp, "значок «сравнить» в строке рейтинга ставит разбор другого поставщика рядом, с его баллом", `${wFocus.me} | ${wFocus.vs}: ${wFocus.vsTotal}`);
  await prio("Сбалансированно").click();
  await settle(page);
  const orderBal = trioOrder((await readWhy()).order);
  await prio("Условия").click();
  await settle(page);
  const orderTerms = trioOrder((await readWhy()).order);
  const leader3 = orderTerms[0];
  log.push(`  - порядок троих при «Сбалансированно»: ${orderBal.join(" › ")}; при «Условия и цена»: ${orderTerms.join(" › ")}`);
  await page.goBack();
  await settle(page);
  cmp = await readCompare(page);
  check(hashOf(page).startsWith("#/compare") && sameSet(cmp.cols, trio), "«назад» из разбора ведёт к сравнению тех же троих", hashOf(page));
  for (const btn of await page.locator(".cmp-grid .star").all()) {
    if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  }
  check((await page.locator(".cmp-grid .star[aria-pressed=true]").count()) === 3, "все трое отмечены звёздочкой прямо в сравнении");
  await page.locator(".side-nav .nav-item", { hasText: "Шорт-лист" }).click();
  await page.waitForURL(/#\/shortlist/);
  await page.locator(".sl-row").first().waitFor();
  const slNames = (await page.locator(".sl-row .nm").allInnerTexts()).map(norm);
  const expectSl = new Set([pickB, lead2, ...trio]);
  check(sameSet(slNames, [...expectSl]) && (await page.locator(".side-nav .count").innerText()).trim() === String(expectSl.size), `в шорт-листе все, кого отмечали по трём сценариям: ${expectSl.size}`, delta(slNames, [...expectSl]));
  await page.locator(".sl-row", { hasText: leader3 }).locator("select").selectOption("Написал");
  const rest = trio.filter((n) => n !== leader3);
  const st3 = [];
  for (const n of rest) st3.push(await page.locator(".sl-row", { hasText: n }).locator("select").inputValue());
  check(st3.every((x) => x === "Не связывались"), `лидеру «Условия и цена» (${leader3}) — «Написал», двое других остаются «Не связывались»`, `${rest.join(", ")}: ${st3.join(", ")}`);
  const cmpLink = page.locator(".page-tools a", { hasText: "Сравнить ·" });
  check(((await cmpLink.getAttribute("aria-disabled")) ?? "false") === "false" && (await cmpLink.getAttribute("href")).includes("ids="), "в шорт-листе «Сравнить · …» активна: есть двое из одной категории");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Скачать CSV" }).click()]);
  const csvPath = path.join(OUT, "_shortlist.csv");
  await dl.saveAs(csvPath);
  const csvRaw = fs.readFileSync(csvPath, "utf8");
  fs.unlinkSync(csvPath);
  const csv = parseCsv(csvRaw);
  check(csvRaw.startsWith("﻿") && csv[0].join("|") === "Поставщик|Категория|Балл|Статус контакта|Заметка|Телефон|Email|Сайт|Демо", "CSV: BOM для Excel, заголовок из девяти колонок", csv[0].join("|"));
  check(csv.length - 1 === expectSl.size && sameSet(csv.slice(1).map((r) => r[0]), [...expectSl]), `CSV: строк столько же, сколько в шорт-листе (${csv.length - 1}), имена те же`);
  const csvLead = csv.find((r) => r[0] === leader3);
  const csv2 = csv.find((r) => r[0] === lead2);
  check(csvLead[3] === "Написал" && csv2[3] === "Ответил" && csv2[4] === "мин. 10 кг, привоз пн/чт", "в CSV — статусы и заметка, как выставили", `${csvLead[3]}; ${csv2[3]} / ${csv2[4]}`);
  const slScore = int(await page.locator(".sl-row", { hasText: leader3 }).locator(".score").innerText());
  check(Number(csvLead[2]) === slScore && csvLead[1] === cat(byName.get(leader3).category).name && csvLead[5] === (byName.get(leader3).phones.value || []).join(", "), "балл, категория и телефоны в CSV совпадают с экраном и набором", `${csvLead[1]}, ${csvLead[2]}`);
  // убрать из шорт-листа
  await page.locator(`.sl-row .x[aria-label='Убрать ${pickB} из шорт-листа']`).click();
  check((await page.locator(".sl-row").count()) === expectSl.size - 1 && (await page.locator(".side-nav .count").innerText()).trim() === String(expectSl.size - 1), "× убирает запись, счётчик в меню уменьшился");

  // ================= Каталог =================
  step("Каталог «Все поставщики»: смотреть всех, как в магазине");
  await page.locator(".side-nav .nav-item", { hasText: "Все поставщики" }).click();
  await page.waitForURL(/#\/catalog/);
  await page.locator(".lcard.tile").first().waitFor();
  const cnames = (await page.locator(".lcard.tile a.nm").allInnerTexts()).map(norm);
  const alive = S.filter((s) => !stopped(s));
  const shown = [...alive, bySite, byInn]; // в каталоге рядом с набором лежат собранные в этой сессии
  check(sameSet(cnames, names(shown)), `все ${S.length} поставщиков набора и двое собранных сейчас — ${cnames.length}`, delta(cnames, names(shown)));
  const sorted = [...cnames].sort((a, b) => a.localeCompare(b, "ru"));
  check(cnames.join("|") === sorted.join("|"), "по алфавиту, А → Я", `${cnames[0]} … ${cnames.at(-1)}`);
  check((await page.locator(".lcard.tile .fresh-pill").count()) === 2 && norm(await page.locator(".cat-count").innerText()).startsWith(String(shown.length)) && norm(await page.locator(".side-nav .nav-item", { hasText: "Все поставщики" }).locator(".nav-n").innerText()) === String(S.length), "две карточки «собрано сейчас»; счётчик на странице считает их, в меню — только основной набор", `${norm(await page.locator(".cat-count").innerText())} / ${norm(await page.locator(".side-nav .nav-item", { hasText: "Все поставщики" }).locator(".nav-n").innerText())}`);
  await page.locator("select[aria-label='Сортировка']").selectOption({ label: "По алфавиту, Я → А" });
  await settle(page);
  check((await page.locator(".lcard.tile a.nm").allInnerTexts()).map(norm).join("|") === [...sorted].reverse().join("|"), "«Я → А» разворачивает порядок");
  await page.locator("select[aria-label='Сортировка']").selectOption({ label: "По алфавиту, А → Я" });
  await settle(page);
  await picker.cat(page, cat("dairy").short);
  let cn = (await page.locator(".lcard.tile a.nm").allInnerTexts()).map(norm);
  check(sameSet(cn, names(alive.filter((s) => s.category === "dairy"))) && (await page.locator(".lcard.tile .sc-cat").allInnerTexts()).every((c) => norm(c).startsWith(cat("dairy").short)), `отметка «${cat("dairy").short}» в списке категорий оставляет только эту категорию: ${cn.length}`);
  await picker.cat(page, cat("fish").short);
  cn = (await page.locator(".lcard.tile a.nm").allInnerTexts()).map(norm);
  check(sameSet(cn, names(alive.filter((s) => ["dairy", "fish"].includes(s.category)))), "вторая отметка добавляет категорию (можно несколько)", `${cn.length}`);
  await picker.all(page);
  await picker.done(page);
  const allN = await page.locator(".lcard.tile").count();
  await flag(page, "Доставка до точки").click();
  await settle(page);
  const doorN = shown.filter(PRED.door).length;
  check((await page.locator(".lcard.tile").count()) === doorN && doorN < allN, "те же фильтры, что в поиске: «Доставка до точки»", `${allN} → ${doorN}`);
  await flag(page, "Доставка до точки").click();
  await page.getByLabel("Поиск по названию и товарам").click();
  await page.keyboard.type("нори");
  await settle(page);
  const foundNori = (await page.locator(".lcard.tile a.nm").allInnerTexts()).map(norm);
  const wantNori = shown.filter((s) => hasWord(s, "нори"));
  check(wantNori.length > 0 && sameSet(foundNori, names(wantNori)), `поиск «нори» по названию и товарам: ${foundNori.length}`, foundNori.join(", "));
  await page.getByLabel("Поиск по названию и товарам").fill("");
  await settle(page);
  const exBox = page.locator(".list-tools .chk", { hasText: "исключённые" });
  check(norm(await exBox.innerText()).endsWith("· 0") && (await page.locator(".lcard.tile.is-stopped").count()) === 0, "«исключённые · 0»: в этом наборе таких нет — и приглушённых карточек нет");
  await page.locator("select[aria-label='Сортировка']").selectOption({ label: "По рекомендации" });
  await settle(page);
  const recScores = (await page.locator(".lcard.tile .lc-score .score").allInnerTexts()).map(int);
  check(recScores.length === shown.length && recScores.every((v, i) => i === 0 || recScores[i - 1] >= v), "«По рекомендации»: баллы по убыванию", recScores.join(" ≥ "));
  const firstCard = norm(await page.locator(".lcard.tile a.nm").first().innerText());
  await page.locator(".lcard.tile a.nm").first().click();
  await page.waitForURL(/#\/s\//);
  check(norm(await page.locator(".card-title .h1").innerText()).startsWith(firstCard), "карточка из каталога открывается на том же поставщике", firstCard);

  // ================= Общие проверки =================
  step("Общие проверки");
  const tnum = await page.evaluate(() => {
    const m = (t) => { const s = document.createElement("span"); s.className = "num"; s.style.fontSize = "40px"; s.textContent = t; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
    return { ones: m("111111"), zeros: m("000000") };
  });
  check(Math.abs(tnum.ones - tnum.zeros) < 1, "у шрифта чисел табличные цифры: колонки чисел не пляшут", `111111 = ${tnum.ones.toFixed(1)} px, 000000 = ${tnum.zeros.toFixed(1)} px`);

  // ================= Телефон 390 =================
  step("Телефон, 390 px");
  const mob = await ctx.newPage();
  watch(mob, "390");
  await mob.setViewportSize({ width: 390, height: 844 });
  const trioIds = idsOf(trio);
  const routes = {
    find: "#/find?q=контейнеры для роллов", results: "#/results?cat=packaging&sub=sushi-boxes", card: `#/s/${byName.get(pickB).id}?cat=packaging&tab=terms`,
    compare: `#/compare?ids=${trioIds.join(",")}&cat=packaging`, why: `#/why?ids=${trioIds.join(",")}&cat=packaging`,
    shortlist: "#/shortlist", add: "#/add", catalog: "#/catalog",
  };
  await mob.goto(base + routes.results, { waitUntil: "networkidle" });
  const listN = int(await mob.locator(".list-count .big").innerText());
  await mob.getByRole("button", { name: /^Фильтры/ }).click();
  check(await mob.locator(".filters.open").isVisible(), "фильтры открываются выезжающей панелью");
  await mob.locator(".filters.open .chk", { hasText: "Доставка до точки" }).click();
  const showBtn = norm(await mob.getByRole("button", { name: /^Показать/ }).innerText());
  const doorSushi = sushiSet.filter(PRED.door).length;
  check(showBtn === `Показать ${doorSushi}`, "кнопка панели считает, сколько останется", `${showBtn}; без фильтра было ${listN}`);
  await mob.getByRole("button", { name: /^Показать/ }).click();
  await settle(mob, 300);
  check(!(await mob.locator(".filters.open").count()) && int(await mob.locator(".list-count .big").innerText()) === doorSushi, "панель закрылась, в списке столько же, сколько обещала кнопка");
  check(norm(await mob.getByRole("button", { name: /^Фильтры/ }).innerText()) === "Фильтры · 1", "на кнопке «Фильтры» видно число включённых");
  await mob.goto(base + routes.card, { waitUntil: "networkidle" });
  await mob.locator(".field", { hasText: "Оплата и отсрочка" }).locator(".pop-btn").click();
  const pb = await mob.locator(".pop-body").boundingBox();
  check(!!pb && pb.x >= 0 && pb.x + pb.width <= 390, "пояснение «?» на телефоне не уезжает за край экрана", pb ? `${Math.round(pb.x)}…${Math.round(pb.x + pb.width)} px` : "");
  await mob.keyboard.press("Escape");
  check((await mob.locator(".field .q").count()) > 0 && (await mob.locator(".field .q").first().isVisible()), "цитаты в карточке видны и на телефоне");
  await mob.goto(base + routes.compare, { waitUntil: "networkidle" });
  const cm = await mob.evaluate(() => { const el = document.querySelector(".cmp-scroll"); return { sw: el.scrollWidth, cw: el.clientWidth }; });
  check(cm.sw > cm.cw, "сравнение на телефоне — горизонтальная прокрутка колонок внутри таблицы, не страницы", `${cm.sw} > ${cm.cw}`);
  check(await mob.evaluate(() => getComputedStyle(document.querySelector(".cmp-grid .k.sticky")).position === "sticky"), "колонка с названиями полей закреплена");
  await mob.evaluate(() => { document.querySelector(".cmp-scroll").scrollLeft = 300; });
  const kBox = await mob.locator(".cmp-grid .k.sticky").nth(1).boundingBox();
  const sBox = await mob.locator(".cmp-scroll").boundingBox();
  check(!!kBox && !!sBox && Math.abs(kBox.x - sBox.x) < 2, "при прокрутке колонок подписи полей остаются у левого края", `x=${Math.round(kBox?.x ?? -1)} против ${Math.round(sBox?.x ?? -1)}`);

  // ================= Скриншоты =================
  step("Скриншоты");
  for (const [w, pg] of [[1440, page], [390, mob]]) {
    let i = 0;
    for (const [name, hash] of Object.entries(routes)) {
      i++;
      await pg.goto(base + hash, { waitUntil: "networkidle" });
      await pg.waitForTimeout(250);
      await shot(pg, `${String(i).padStart(2, "0")}-${name}-${w}.png`);
    }
  }
  log.push(`- ${shots.length} скриншотов: ${shots.join(", ")}`);
  check(errors.length === 0, "в консоли браузера нет ошибок", errors.slice(0, 3).join(" | "));

  log.push(`\n**Итог:** ${failed ? `❌ провалено проверок: ${failed} из ${total}` : `✅ все проверки пройдены (${total})`}.`);
  fs.writeFileSync(path.join(OUT, "прогон-сценариев.md"), log.join("\n") + "\n", "utf8");
  console.log(`\n${failed ? `FAILED: ${failed} из ${total}` : `ALL PASSED: ${total}`} · протокол: ${path.join(OUT, "прогон-сценариев.md")}`);
  await browser.close();
  server.close();
  api.stop();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
