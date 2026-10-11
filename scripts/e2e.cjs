// Приёмочный прогон интерфейса: сценарии 1–3 из логики сервиса проходятся кликами и вводом
// в настоящем браузере (headless Chromium), а не вызовом функций. Пишет протокол и скриншоты.
//
// Запуск (нужен Playwright с установленным Chromium):
//   npm --prefix web run build
//   NODE_PATH=<папка с node_modules/playwright> node scripts/e2e.cjs [папка-для-скриншотов]
// Без аргумента скриншоты и протокол кладутся в e2e-out/.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { serveDist } = require("./serve-dist.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "e2e-out"));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "suppliers.json"), "utf8"));
fs.mkdirSync(OUT, { recursive: true });

const log = [];
let failed = 0;
const step = (t) => { log.push(`\n### ${t}\n`); console.log(`\n== ${t}`); };
function check(ok, what, detail = "") {
  if (!ok) failed++;
  const line = `- ${ok ? "✅" : "❌"} ${what}${detail ? ` — ${detail}` : ""}`;
  log.push(line);
  console.log(line);
}
const norm = (s) => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

/** Ползунок «минимальный заказ до» — кликом по треку и стрелками, как человек. */
async function setRange(page, target) {
  const r = page.locator(".filters .range input[type=range]");
  const box = await r.boundingBox();
  await page.mouse.click(box.x + box.width * (target / 50000), box.y + box.height / 2);
  for (let i = 0; i < 60; i++) {
    const v = Number(await r.inputValue());
    if (v === target) break;
    await r.press(v < target ? "ArrowRight" : "ArrowLeft");
  }
  return Number(await r.inputValue());
}

const rowOf = (page, name) => page.locator(".row", { has: page.locator("a.nm", { hasText: name }) });

(async () => {
  const { server, base } = await serveDist(path.join(ROOT, "web", "dist"));
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  log.push(`# Прогон сценариев интерфейса\n\nДата: ${new Date().toLocaleString("ru-RU")}. Браузер: Chromium headless, 1440×900 и 390×844. Сборка: web/dist. Все действия — клики и ввод с клавиатуры.`);

  // ================= Сценарий 1 =================
  step("Сценарий 1. Закупщик сети ищет упаковку под доставку");
  await page.goto(base + "#/", { waitUntil: "networkidle" });
  await page.locator(".demo-btn").click();
  check(norm(await page.locator(".demo-pop .pop-body").textContent()).includes("придуманы"), "«демо» в шапке — по нажатию пояснение про демо-данные");
  await page.keyboard.press("Escape");
  check((await page.locator(".pop-body").count()) === 0, "пояснение закрывается по Esc");
  await page.locator("#q").click();
  await page.keyboard.type("контейнеры для роллов");
  check(norm(await page.locator(".match").textContent()).includes("Упаковка"), "строка «контейнеры для роллов» сведена к категории", norm(await page.locator(".match").textContent()));
  await page.locator("#vol").click();
  await page.keyboard.type("20000");
  await page.getByRole("radio", { name: "Сбалансированно" }).click();
  await page.getByRole("button", { name: "Найти поставщиков" }).click();
  await page.waitForURL(/#\/results/);
  const cards = page.locator(".first .gcard");
  await cards.first().waitFor();
  check((await cards.count()) === 3, "сверху три карточки «Кому написать первым»");
  const lead1 = norm(await cards.nth(0).locator(".nm").textContent());
  const why1 = norm(await cards.nth(0).locator(".why").textContent());
  const ask1 = norm(await cards.nth(0).locator(".ask").textContent());
  check(!!lead1 && why1.length > 20 && ask1.startsWith("Уточните"), "у лидера строка «почему» и строка «что уточнить»", `${lead1}: ${why1} ${ask1}`);
  const total1 = norm(await page.locator(".list-count").textContent());
  check(/^\d+\s*поставщик/.test(total1), "список поставщиков с бейджами", total1);

  await page.locator(".filters .chk", { hasText: "Доставка до точки" }).click();
  await page.locator(".filters .chk", { hasText: "Компания действует" }).click();
  const v1 = await setRange(page, 20000);
  check(v1 === 20000, "фильтр «мин. заказ до 20 000 ₽» выставлен ползунком", String(v1));
  const head1 = norm(await page.locator(".list-count").textContent());
  check(/скрыто фильтрами/.test(head1), "фильтры скрывают часть выдачи и говорят об этом", head1);
  await page.locator(".list-count .pop-btn").click();
  check(norm(await page.locator(".list-count .pop-body").textContent()).includes("оставлены"), "поставщики без указанного минимума остаются в списке, пояснение — в «?»");
  await page.keyboard.press("Escape");
  await page.locator(".excluded-toggle").click();
  const ex1 = norm(await page.locator(".excluded ul").textContent());
  check(/ликвидирована/.test(ex1) && /не возит в Екатеринбург/.test(ex1), "свёрнутый список «Исключены» с причинами", ex1.slice(0, 160));

  const picks1 = [];
  for (const sc of await page.locator(".rows .row").all()) {
    if (picks1.length === 3) break;
    picks1.push(norm(await sc.locator("a.nm").textContent()));
    await sc.locator(".chk").click();
  }
  check(norm(await page.locator(".selbar").textContent()).includes("Выбрано 3 из 4"), "отмечены трое — панель «Выбрано 3 из 4»", picks1.join(", "));
  await page.locator(".selbar").getByRole("link", { name: "Сравнить" }).click();
  await page.waitForURL(/#\/compare/);
  await page.locator(".conclusion").waitFor();
  check((await page.locator(".cmp-grid .hd:not(.add) b").count()) === 3, "сравнение: три колонки");
  check((await page.locator(".cmp-grid .best").count()) > 0, "лучшее известное значение помечено ▲");
  const concl1 = norm(await page.locator(".conclusion").textContent());
  check(concl1.startsWith(`Первым — ${lead1}`), "вывод под таблицей называет лидера", concl1.slice(0, 140));
  await page.screenshot({ path: path.join(OUT, "_s1-compare.png") });

  await page.locator(".cmp-grid .hd a", { hasText: lead1 }).click();
  await page.waitForURL(/#\/s\//);
  await page.locator(".card-grid").waitFor();
  check((await page.locator(".field .q").count()) >= 4, "в карточке под значениями — цитаты с сайта");
  const pay = page.locator(".field", { hasText: "Оплата и отсрочка" });
  await pay.locator(".pop-btn").click();
  check(norm(await pay.textContent()).includes("не найдено") && norm(await pay.locator(".pop-body").textContent()).includes("Искали"), "«Оплата и отсрочка»: явное «не найдено», где искали — по нажатию «?»");
  await page.keyboard.press("Escape");
  check(norm(await page.locator(".status").textContent()).includes("Действует"), "блок «Компания»: статус из ЕГРЮЛ");
  check((await page.locator(".decls li").count()) > 0, "декларации из реестра Росаккредитации с номерами", `${await page.locator(".decls li").count()} шт.`);
  await page.getByRole("button", { name: "В шорт-лист" }).click();
  check(await page.getByRole("button", { name: "В шорт-листе" }).isVisible(), "«В шорт-лист» — кнопка меняет состояние");
  await page.getByRole("link", { name: "Написать — черновик запроса" }).click();
  await page.waitForURL(/#\/shortlist/);
  const draft1 = await page.locator(".draft-text").inputValue();
  check(/Подскажите, пожалуйста/.test(draft1) && /отсрочк/.test(draft1), "черновик письма с вопросами по пустым полям", draft1.split("\n").filter((l) => l.startsWith("—")).join(" "));

  // ================= Сценарий 2 =================
  step("Сценарий 2. Владелец точки срочно меняет поставщика рыбы");
  await page.locator(".top nav a", { hasText: "Поиск" }).click();
  await page.waitForURL(/#\/$/);
  await page.locator("#q").fill("");
  await page.locator("#q").click();
  await page.keyboard.type("лосось охлаждённый");
  check(norm(await page.locator(".match").textContent()).includes("охлаждённая и замороженная рыба"), "«лосось охлаждённый» сведён к подкатегории", norm(await page.locator(".match").textContent()));
  await page.locator("#vol").fill("");
  await page.getByRole("radio", { name: "Быстрая доставка" }).click();
  await page.getByRole("button", { name: "Найти поставщиков" }).click();
  await page.waitForURL(/#\/results/);
  await page.locator(".filters .chk", { hasText: "Доставка до точки" }).click();
  await page.locator(".filters .chk", { hasText: "Склад в Екатеринбурге" }).click();
  const v2 = await setRange(page, 10000);
  check(v2 === 10000, "фильтры: доставка до точки, склад в городе, мин. заказ до 10 000 ₽", String(v2));
  await page.locator(".first .gcard").first().click();
  await page.waitForURL(/#\/s\//);
  const name2 = norm(await page.locator(".card-h .h1").textContent()).replace(/(демо|собрано сейчас)+$/, "").trim();
  const card2 = norm(await page.locator(".card-page").textContent());
  check(/при заказе до 14:00/.test(card2), "у лидера доставка «на следующий день при заказе до 14:00» с цитатой", name2);
  check(/Морепродукты/.test(card2) && /Росаккредитация|ЕАЭС/.test(card2), "проверяемое: декларации в реестре и группа «Честного знака»");
  await page.locator(".section-h", { hasText: "Документы" }).locator(".pop-btn").click();
  check(/Меркурий/.test(card2) && norm(await page.locator(".section-h .pop-body").textContent()).includes("ВетИС"), "подсказка про ветеринарные документы (ВетИС по ИНН не проверить) — в «?»");
  await page.keyboard.press("Escape");
  check(/WhatsApp|Telegram/.test(norm(await page.locator(".mini-fields").textContent())), "в контактах — телефон и мессенджер");
  const id2 = page.url().split("/s/")[1].split("?")[0];
  await page.locator(`#st-${id2}`).selectOption("Ответил");
  await page.locator(`#note-${id2}`).click();
  await page.keyboard.type("мин. 10 кг, привоз пн/чт");
  await page.getByRole("button", { name: "Сохранить заметку" }).click();
  check(norm(await page.locator(".notes .panel-h").textContent()).includes("сохранено"), "статус «Ответил» и заметка сохранены");
  await page.locator(".top nav a", { hasText: "Шорт-лист" }).click();
  await page.waitForURL(/#\/shortlist/);
  const row2 = page.locator(".sl-row", { hasText: name2 });
  check((await row2.locator(".sl-note input").inputValue()) === "мин. 10 кг, привоз пн/чт" && (await row2.locator(".sl-note .st").count()) === 1, "заметка с пометкой ✎ видна в шорт-листе");
  check((await row2.locator("select").inputValue()) === "Ответил", "статус «Ответил» виден в шорт-листе");

  // ================= Сценарий 3 =================
  step("Сценарий 3. Трое на примете: сравнить и решить, кому писать первым");
  const bySite = DATA.suppliers.find((s) => s.live_only === "site");
  const byInn = DATA.suppliers.find((s) => s.live_only === "inn");
  const third = DATA.suppliers.find((s) => s.id === "slivochny-kray");
  await page.locator(".top-add").click();
  await page.waitForURL(/#\/add/);
  await page.getByLabel("Сайт или ИНН").click();
  await page.keyboard.type(bySite.website.value.replace("https://", ""));
  await page.getByRole("button", { name: "Собрать" }).click();
  await page.locator(".run-h", { hasText: "Готово" }).waitFor({ timeout: 15000 });
  check((await page.locator(".steps li.done").count()) >= 5, "живой сбор по сайту: шаги видны (сайт → поля → ФНС → декларации → балл)");
  check(norm(await page.locator(".result-card").textContent()).includes("собрано сейчас"), "на выходе карточка с пометкой «собрано сейчас»", bySite.name);
  await page.getByLabel("Сайт или ИНН").fill("");
  await page.getByLabel("Сайт или ИНН").click();
  await page.keyboard.type(byInn.inn.value);
  await page.getByRole("button", { name: "Собрать" }).click();
  await page.locator(".confirm").waitFor({ timeout: 10000 });
  check(norm(await page.locator(".steps li").first().textContent()).includes("ЕГРЮЛ") && norm(await page.locator(".steps li").nth(1).textContent()).includes("Ищем сайт"), "по ИНН: сначала ФНС, потом поиск сайта по названию");
  check(norm(await page.locator(".confirm").textContent()).includes("Это сайт компании"), "найденный сайт показан на подтверждение, а не взят молча");
  await page.getByRole("button", { name: "Да, собрать с этого сайта" }).click();
  await page.locator(".run-h", { hasText: "Готово" }).waitFor({ timeout: 15000 });
  check(norm(await page.locator(".result-card .nm").textContent()) === byInn.name, "карточка по ИНН собрана", byInn.name);
  await page.getByRole("link", { name: "Сравнить с остальными" }).click();
  await page.waitForURL(/#\/results/);
  await page.locator(".rows .row").first().waitFor();
  check((await page.locator(".rows .fresh-pill").count()) === 2, "обе собранные карточки — в выдаче категории с пометкой «собрано сейчас»");
  for (const n of [bySite.name, byInn.name, third.name]) await rowOf(page, n).locator(".chk").click();
  await page.locator(".selbar").getByRole("link", { name: "Сравнить" }).click();
  await page.waitForURL(/#\/compare/);
  await page.locator(".conclusion a").click();
  await page.waitForURL(/#\/why/);
  await page.getByRole("radio", { name: "Сбалансированно" }).click();
  const orderBal = (await page.locator(".order .nm").allTextContents()).map((t) => norm(t).replace(/ демо$/, ""));
  check(orderBal.length === 3 && (await page.locator(".why-tbl tbody tr").count()) === 7, "разбор: веса и баллы по шести критериям, итог", orderBal.join(" › "));
  await page.screenshot({ path: path.join(OUT, "_s3-why-balanced.png") });
  await page.getByRole("radio", { name: "Условия и цена" }).click();
  const orderTerms = (await page.locator(".order .nm").allTextContents()).map((t) => norm(t).replace(/ демо$/, ""));
  check(orderTerms[0] !== orderBal[0], "«Условия и цена» — порядок меняется, видно почему", orderTerms.join(" › "));
  const leader3 = orderTerms[0];
  await page.goBack();
  await page.waitForURL(/#\/compare/);
  for (const btn of await page.locator(".cmp-grid .star").all()) {
    if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  }
  await page.locator(".top nav a", { hasText: "Шорт-лист" }).click();
  await page.waitForURL(/#\/shortlist/);
  await page.locator(".sl-row", { hasText: leader3 }).locator("select").selectOption("Написал");
  const others = [bySite.name, byInn.name, third.name].filter((n) => n !== leader3);
  const st3 = [];
  for (const n of others) st3.push(await page.locator(".sl-row", { hasText: n }).locator("select").inputValue());
  check(st3.every((x) => x === "Не связывались"), "лидеру — «Написал», двое других в шорт-листе «Не связывались»", `${leader3}; ${others.join(", ")}: ${st3.join(", ")}`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Скачать CSV" }).click()]);
  const csvPath = path.join(OUT, "_shortlist.csv");
  await dl.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, "utf8");
  check(csv.includes("Статус контакта") && csv.split("\r\n").length >= 6, "шорт-лист выгружается в CSV", `${csv.split("\r\n").length - 1} строк`);
  fs.unlinkSync(csvPath);

  // ================= Каталог =================
  step("Каталог «Все поставщики»: смотреть всех, как в магазине");
  await page.locator(".top nav a", { hasText: "Все поставщики" }).click();
  await page.waitForURL(/#\/catalog/);
  await page.locator(".shop-card").first().waitFor();
  const names = (await page.locator(".shop-card .nm").allTextContents()).map(norm);
  const sortedNames = [...names].sort((a, b) => a.localeCompare(b, "ru"));
  check(names.length >= 30 && names.join("|") === sortedNames.join("|"), "все поставщики по алфавиту", `${names.length} карточек, ${names[0]} … ${names[names.length - 1]}`);
  check((await page.locator(".az button").count()) >= 10, "указатель букв", `${await page.locator(".az button").count()} букв`);
  await page.locator(".az button", { hasText: "Л" }).click();
  await page.waitForTimeout(700);
  const lBox = await page.locator("#L-Л").boundingBox();
  check(!!lBox && lBox.y >= 0 && lBox.y < 450, "буква в указателе прокручивает к своей группе", lBox ? `y=${Math.round(lBox.y)}` : "");
  await page.locator(".cat-chip-btn", { hasText: "Сыр" }).click();
  const cats = (await page.locator(".shop-card .sc-cat").allTextContents()).map(norm);
  check(cats.length > 0 && cats.every((c) => c.startsWith("Сыр")), "чип категории оставляет только её", `${cats.length} карточек`);
  await page.locator(".cat-chip-btn", { hasText: "Все" }).click();
  const before = await page.locator(".shop-card").count();
  await page.locator(".filters .chk", { hasText: "Доставка до точки" }).click();
  const after = await page.locator(".shop-card").count();
  check(after < before, "те же фильтры, что в поиске", `${before} → ${after}`);
  await page.locator(".filters .chk", { hasText: "Доставка до точки" }).click();
  await page.getByLabel("Поиск по названию и товарам").click();
  await page.keyboard.type("нори");
  const found = (await page.locator(".shop-card .nm").allTextContents()).map(norm);
  check(found.length > 0 && found.length < before, "поиск по названию и товарам", `«нори» → ${found.join(", ")}`);
  await page.getByLabel("Поиск по названию и товарам").fill("");
  await page.locator(".list-tools .chk", { hasText: "исключённые" }).click();
  check((await page.locator(".shop-card.stopped").count()) > 0, "исключённые показываются по галочке, приглушённо");

  // ================= Общие проверки =================
  step("Общие проверки");
  await page.goto(base + "#/results?cat=packaging&vol=20000&view=table", { waitUntil: "networkidle" });
  check((await page.locator(".tbl tbody tr").count()) > 5, "вид «Таблица» работает");
  const tnum = await page.evaluate(() => {
    const m = (t) => { const s = document.createElement("span"); s.className = "num"; s.style.fontSize = "40px"; s.textContent = t; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
    return { ones: m("111111"), zeros: m("000000") };
  });
  check(Math.abs(tnum.ones - tnum.zeros) < 1, "у Onest есть табличные цифры (tabular-nums): колонки чисел не пляшут", `111111 = ${tnum.ones.toFixed(1)} px, 000000 = ${tnum.zeros.toFixed(1)} px`);

  // ================= Телефон 390 =================
  step("Телефон, 390 px");
  const mob = await ctx.newPage();
  await mob.setViewportSize({ width: 390, height: 844 });
  mob.on("pageerror", (e) => errors.push(e.message));
  const routes = {
    search: "#/", results: "#/results?cat=packaging&vol=20000", card: `#/s/lanchbox-opt?vol=20000`,
    compare: "#/compare?ids=lanchbox-opt,konteyner-servis,kraft-i-karton&cat=packaging&vol=20000",
    why: "#/why?cat=packaging&vol=20000", shortlist: "#/shortlist", add: "#/add", about: "#/about-data", catalog: "#/catalog",
  };
  for (const [name, hash] of Object.entries(routes)) {
    await mob.goto(base + hash, { waitUntil: "networkidle" });
    const over = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 0, `${name}: без горизонтальной прокрутки страницы`, over > 0 ? `лишние ${over} px` : "");
  }
  await mob.goto(base + routes.results, { waitUntil: "networkidle" });
  await mob.getByRole("button", { name: /^Фильтры/ }).click();
  check(await mob.locator(".filters.open").isVisible(), "фильтры открываются выезжающей панелью");
  await mob.getByRole("button", { name: /^Показать/ }).click();
  await mob.waitForTimeout(300);
  check(!(await mob.locator(".filters.open").count()), "панель фильтров закрывается");
  await mob.goto(base + routes.card, { waitUntil: "networkidle" });
  await mob.locator(".field", { hasText: "Оплата и отсрочка" }).locator(".pop-btn").click();
  const pb = await mob.locator(".pop-body").boundingBox();
  check(!!pb && pb.x >= 0 && pb.x + pb.width <= 390, "пояснение «?» на телефоне не уезжает за край экрана", pb ? `${Math.round(pb.x)}…${Math.round(pb.x + pb.width)} px` : "");
  await mob.keyboard.press("Escape");
  await mob.goto(base + routes.compare, { waitUntil: "networkidle" });
  const cmp = await mob.evaluate(() => { const el = document.querySelector(".cmp-scroll"); return { sw: el.scrollWidth, cw: el.clientWidth }; });
  check(cmp.sw > cmp.cw, "сравнение на телефоне — горизонтальная прокрутка колонок внутри таблицы", `${cmp.sw} > ${cmp.cw}`);
  check(await mob.evaluate(() => getComputedStyle(document.querySelector(".cmp-grid .k.sticky")).position === "sticky"), "колонка с названиями полей закреплена");

  // ================= Скриншоты =================
  step("Скриншоты");
  const shots = [];
  for (const [w, pg] of [[1440, page], [390, mob]]) {
    for (const [name, hash] of Object.entries(routes)) {
      await pg.goto(base + hash, { waitUntil: "networkidle" });
      await pg.waitForTimeout(250);
      const file = `${String(Object.keys(routes).indexOf(name) + 1).padStart(2, "0")}-${name}-${w}.png`;
      await pg.screenshot({ path: path.join(OUT, file), fullPage: true });
      shots.push(file);
    }
  }
  log.push(`- ${shots.length} скриншотов: ${shots.join(", ")}`);
  check(errors.length === 0, "в консоли браузера нет ошибок", errors.slice(0, 3).join(" | "));

  log.push(`\n**Итог:** ${failed ? `❌ провалено проверок: ${failed}` : "✅ все проверки пройдены"}.`);
  fs.writeFileSync(path.join(OUT, "прогон-сценариев.md"), log.join("\n") + "\n", "utf8");
  console.log(`\n${failed ? `FAILED: ${failed}` : "ALL PASSED"} · протокол: ${path.join(OUT, "прогон-сценариев.md")}`);
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
