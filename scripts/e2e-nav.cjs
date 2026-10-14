// Навигация и раскладка (T-537): главная → четыре входа, каталог категорий → подкатегория на месте,
// поиск по товару, пустой ответ, шорт-лист и его счётчик, отсутствие горизонтального скролла на 390.
// Всё кликами и вводом в headless Chromium; сервер dist — в том же процессе.
//
// Запуск (нужен Playwright с установленным Chromium):
//   npm --prefix web run build
//   NODE_PATH=<папка с node_modules/playwright> node scripts/e2e-nav.cjs [файл-протокола]
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { serveDist } = require("./serve-dist.cjs");
const ROOT = path.resolve(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "suppliers.json"), "utf8"));
const byName = new Map(DATA.suppliers.map((s) => [s.name.trim(), s]));

const log = [];
let failed = 0;
const step = (t) => { log.push(`\n### ${t}\n`); console.log(`\n== ${t}`); };
function check(ok, what, detail = "") {
  if (!ok) failed++;
  const line = `- ${ok ? "✅" : "❌"} ${what}${detail ? ` — ${detail}` : ""}`;
  log.push(line);
  console.log(line);
}
const hash = (page) => decodeURIComponent(new URL(page.url()).hash);
const activeNav = (page) => page.locator(".side-nav .nav-item.on .nav-l").allInnerTexts();
const navCount = async (page) => (await page.locator(".side-nav .count").count()) ? (await page.locator(".side-nav .count").innerText()).trim() : "нет";
const rowNames = (page) => page.locator(".rows .row .nm").allInnerTexts();

(async () => {
  const { server, base } = await serveDist(path.join(ROOT, "web", "dist"));
  const browser = await chromium.launch({ headless: true });
  const errs = [];
  const newPage = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(`${w}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errs.push(`${w}: ${m.text()}`); });
    return { ctx, page };
  };

  // ---------- 1440 ----------
  {
    const { ctx, page } = await newPage(1440, 900);
    await page.goto(base + "#/", { waitUntil: "networkidle" });

    step("Главная → каждая из четырёх плашек ведёт на свой экран (1440)");
    const ways = await page.locator(".ways .way h2").allInnerTexts();
    check(ways.join(" · ") === "Поиск по товару · Поиск по категории · Помощник · Знаю поставщика", "на главной четыре плашки в порядке меню", ways.join(" · "));
    check(await page.locator(".home .gsearch, .home input").count() === 0, "отдельной строки поиска на главной нет");
    const nav1 = await page.locator(".side-nav .nav-group").first().locator(".nav-l").allInnerTexts();
    check(nav1.join(" · ") === ways.join(" · "), "первая группа меню — те же четыре входа в том же порядке", nav1.join(" · "));
    const nav2 = await page.locator(".side-nav .nav-group").nth(1).locator(".nav-l").allInnerTexts();
    check(nav2.join(" · ") === "Все поставщики · Шорт-лист · Как собраны данные", "вторая группа меню", nav2.join(" · "));
    check(await page.locator(".side-nav .cat-glyph").count() === 0, "категорий в меню нет");
    const targets = [["Поиск по товару", "#/find", "Поиск по товару"], ["Поиск по категории", "#/categories", "Поиск по категории"], ["Помощник", "#/assistant", "Помощник"], ["Знаю поставщика", "#/add", "Знаю поставщика"]];
    for (const [t, h, nav] of targets) {
      await page.goto(base + "#/", { waitUntil: "networkidle" });
      await page.locator(".ways .way", { hasText: t }).click();
      await page.waitForTimeout(200);
      const on = await activeNav(page);
      check(hash(page) === h, `плашка «${t}» → ${h}`, `адрес ${hash(page)}, активный пункт меню «${on.join()}»`);
      check(on.length === 1 && on[0] === nav, `  в меню подсвечен «${nav}»`);
    }

    step("Поиск по товару: вход без запроса, подсказки при наборе, опечатка");
    await page.locator(".side-nav .nav-item", { hasText: "Поиск по товару" }).click();
    await page.waitForTimeout(150);
    check(hash(page) === "#/find", "пункт меню «Поиск по товару» → #/find");
    check(await page.locator(".find-entry input#q").isVisible(), "на #/find без запроса — поле поиска");
    check(await page.locator(".find-entry .try .pill-out").count() === 4, "примеры запросов под полем");
    await page.locator("#q").fill("моцар");
    await page.waitForTimeout(150);
    const sg = await page.locator(".sugg li").allInnerTexts();
    check(sg.length > 0, "подсказки появляются при наборе", sg.slice(0, 3).map((x) => x.replace(/\s+/g, " ")).join(" | "));
    await page.locator("#q").fill("моцарела");
    await page.locator("#q").press("Enter");
    await page.waitForTimeout(250);
    check(hash(page) === "#/find?q=моцарела", "Enter → результаты по запросу", hash(page));
    check(await page.locator(".find-group").count() > 0, "по запросу с опечаткой есть результаты", `групп: ${await page.locator(".find-group").count()}`);
    check((await activeNav(page)).join() === "Поиск по товару", "на результатах подсвечен «Поиск по товару»");
    check(await page.locator(".sugg").count() === 0, "после поиска подсказки не висят поверх результатов");
    await page.locator(".sub-jump a", { hasText: "Моцарелла для пиццы" }).click();
    await page.waitForTimeout(250);
    check(hash(page) === "#/results?cat=dairy&sub=mozzarella", "«Подкатегория целиком» → результаты с подкатегорией", hash(page));
    check((await page.locator(".sub-chip.on").allInnerTexts()).map((x) => x.replace(/\s+/g, " ")).join() === "Моцарелла для пиццы 5", "  на результатах выбрана «Моцарелла для пиццы»");
    await page.goBack();
    await page.waitForTimeout(250);
    await page.locator(".find-group-h a").first().click();
    await page.waitForTimeout(250);
    check(hash(page) === "#/results?cat=dairy", "«Вся категория» из поиска → результаты категории", hash(page));

    step("Пустой ответ «молоко» — переходы");
    await page.goto(base + "#/find?q=молоко", { waitUntil: "networkidle" });
    for (const [sel, t, h] of [[".find-related a", "Сыр и молочное", "#/results?cat=dairy"], [".empty-ways a", "Поиск по категории", "#/categories"], [".empty-ways a", "Знаю поставщика", "#/add"], [".empty-ways a", "Помощник", "#/assistant"]]) {
      await page.goto(base + "#/find?q=молоко", { waitUntil: "networkidle" });
      await page.locator(sel, { hasText: t }).click();
      await page.waitForTimeout(200);
      check(hash(page) === h, `«${t}» → ${h}`, hash(page));
    }

    step("Поиск по категории: каталог → «Упаковка» → «Коробки для пиццы» → смена подкатегории на месте");
    await page.goto(base + "#/", { waitUntil: "networkidle" });
    await page.locator(".side-nav .nav-item", { hasText: "Поиск по категории" }).click();
    await page.waitForTimeout(200);
    check(hash(page) === "#/categories", "меню → #/categories");
    check(await page.locator(".cat-acc > li").count() === 4, "четыре категории");
    check(await page.locator(".cat-subs").count() === 0, "до клика подкатегории свёрнуты");
    await page.locator(".cat-acc-h", { hasText: "Упаковка для доставки" }).click();
    await page.waitForTimeout(200);
    check(hash(page) === "#/categories?open=packaging", "клик по категории не открывает поставщиков, а раскрывает её", hash(page));
    check(await page.locator(".cat-acc-h", { hasText: "Упаковка" }).getAttribute("aria-expanded") === "true", "  aria-expanded=true");
    const subs = (await page.locator(".cat-subs .cat-sub").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").replace(" →", "").trim());
    check(subs[0].startsWith("Вся категория"), "первый пункт — «Вся категория (N)»", subs.join(" | "));
    const expect = ["containers", "pizza-boxes", "bags"].map((id) => DATA.suppliers.filter((s) => !s.live_only && s.category === "packaging" && s.subcategories.includes(id)).length);
    check(subs.slice(1).map((x) => x.match(/\d+$/)[0]).join() === expect.join(), "счётчики подкатегорий совпадают с набором", expect.join(" / "));
    await page.locator(".cat-sub", { hasText: "Коробки для пиццы" }).click();
    await page.waitForTimeout(300);
    check(hash(page) === "#/results?cat=packaging&sub=pizza-boxes", "«Коробки для пиццы» → результаты с подкатегорией", hash(page));
    check((await activeNav(page)).join() === "Поиск по категории", "на результатах подсвечен «Поиск по категории»");
    const pb = await rowNames(page);
    const pbBad = pb.filter((n) => !byName.get(n.trim())?.subcategories.includes("pizza-boxes"));
    check(pb.length > 0 && pbBad.length === 0, `в результатах только «Коробки для пиццы»: ${pb.length} поставщиков`, pbBad.length ? `чужие: ${pbBad.join(", ")}` : "");
    const firstZone = await page.locator(".first .gcard .nm").allInnerTexts();
    check(firstZone.every((n) => byName.get(n.trim())?.subcategories.includes("pizza-boxes")), "«Кому написать первым» — тоже из подкатегории", firstZone.join(", "));
    await page.locator(".sub-chip", { hasText: "Контейнеры для роллов" }).click();
    await page.waitForTimeout(300);
    check(hash(page).startsWith("#/results?cat=packaging&sub=containers"), "смена подкатегории на месте, без возврата в каталог", hash(page));
    const ct = await rowNames(page);
    check(ct.length > 0 && ct.every((n) => byName.get(n.trim())?.subcategories.includes("containers")), `  теперь только «Контейнеры»: ${ct.length}`);
    await page.locator(".sub-chip", { hasText: "Вся категория" }).click();
    await page.waitForTimeout(300);
    check(hash(page) === "#/results?cat=packaging", "«Вся категория» на месте", hash(page));
    await page.locator(".results > .crumb").click();
    await page.waitForTimeout(200);
    check(hash(page) === "#/categories?open=packaging", "«← Поиск по категории» возвращает в каталог с открытой категорией", hash(page));
    await page.locator(".cat-acc-h", { hasText: "Упаковка" }).click();
    await page.waitForTimeout(150);
    check(await page.locator(".cat-subs").count() === 0, "повторный клик сворачивает категорию");

    step("«Знаю поставщика» → живой сбор → «Сравнить с остальными»");
    await page.goto(base + "#/add", { waitUntil: "networkidle" });
    await page.locator(".examples .pill-out").filter({ hasText: "посоветовал коллега" }).first().click();
    const cmp = page.locator(".result-card a", { hasText: "Сравнить с остальными" });
    await cmp.waitFor({ timeout: 60000 }).catch(() => {});
    if (await cmp.count()) {
      await cmp.click();
      await page.waitForTimeout(250);
      check(hash(page).startsWith("#/results?cat="), "«Сравнить с остальными» → результаты категории", hash(page));
      check((await page.locator(".sub-chip.on").allInnerTexts()).join().includes("Вся категория"), "  открыта категория целиком");
    } else check(false, "«Сравнить с остальными» не появилась за 60 с");
    await ctx.close();
  }

  // ---------- шорт-лист: чистый профиль ----------
  {
    const { ctx, page } = await newPage(1440, 900);
    step("Шорт-лист: чистый профиль → две звёздочки → «2» в меню и двое на странице");
    await page.goto(base + "#/categories", { waitUntil: "networkidle" });
    check(await navCount(page) === "нет", "при чистом профиле в меню нет счётчика");
    await page.locator(".cat-acc-h", { hasText: "Рыба" }).click();
    await page.locator(".cat-sub.all").click();
    await page.waitForTimeout(300);
    const stars = page.locator(".rows .row .star");
    await stars.nth(0).click();
    await stars.nth(1).click();
    await page.waitForTimeout(150);
    check(await navCount(page) === "2", "после двух звёздочек в меню «2»", await navCount(page));
    await page.locator(".side-nav .nav-item", { hasText: "Шорт-лист" }).click();
    await page.waitForTimeout(250);
    const n = await page.locator(".sl-row").count();
    check(n === 2, "на странице шорт-листа двое", `${n}; в заголовке ${await page.locator(".count-big").innerText()}`);
    check(await page.locator(".orphans").count() === 0, "строки про старые записи нет");

    step("Карточка без звёздочки: статус и заметку побочно не поставить");
    const s = DATA.suppliers.find((x) => !x.live_only && x.category === "dairy");
    await page.goto(base + `#/s/${s.id}?cat=dairy`, { waitUntil: "networkidle" });
    check(await page.locator(".notes select, .notes textarea").count() === 0, `у ${s.name} без звёздочки полей статуса и заметки нет`);
    check((await page.locator(".notes-off").innerText()).includes("из шорт-листа"), "вместо них — пояснение и кнопка «В шорт-лист»");
    check(await navCount(page) === "2", "счётчик не изменился", await navCount(page));
    await page.locator(".notes .btn", { hasText: "В шорт-лист" }).click();
    await page.waitForTimeout(150);
    check(await navCount(page) === "3", "кнопка «В шорт-лист» — осознанное добавление → «3»", await navCount(page));
    check(await page.locator(".actions .star.on").count() === 1, "звёздочка в шапке карточки включилась");
    await page.locator(".notes select").selectOption("Написал");
    await page.locator(".notes textarea").fill("проверка заметки");
    await page.locator(".notes .btn", { hasText: "Сохранить заметку" }).click();
    await page.waitForTimeout(150);
    const stored = await page.evaluate((id) => JSON.parse(localStorage.getItem("supplier-scout:v1")).shortlist[id], s.id);
    check(stored && stored.status === "Написал" && stored.note === "проверка заметки", "статус и заметка сохраняются у записи шорт-листа");
    await page.locator(".actions .star").click();
    await page.waitForTimeout(150);
    check(await page.locator(".notes select").count() === 0 && await navCount(page) === "2", "звёздочку сняли — поля скрыты, счётчик «2»", await navCount(page));
    await ctx.close();
  }

  // ---------- шорт-лист: профиль с записями прошлого набора ----------
  {
    const { ctx, page } = await newPage(1440, 900);
    step("Шорт-лист: записи о поставщиках не из набора (как в браузере Павла)");
    await page.goto(base + "#/shortlist", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const it = { status: "Не связывались", note: "", note_at: null, added_at: "2026-10-11T10:00:00.000Z" };
      localStorage.setItem("supplier-scout:v1", JSON.stringify({ shortlist: { "demo-old-1": it, "demo-old-2": { ...it, note: "старая заметка" } }, compare: [], returned: [], collected: {}, last: null }));
    });
    await page.reload({ waitUntil: "networkidle" });
    check(await navCount(page) === "нет", "две записи не из набора — в меню счётчика нет (было «2»)");
    check((await page.locator("h1").innerText()).includes("пуст"), "страница — «Шорт-лист пуст»");
    const o = await page.locator(".orphans").innerText();
    check(o.includes("2 записи") && o.includes("в 1 есть заметка"), "строка про старые записи", o.replace(/\s+/g, " "));
    await page.locator(".orphans .link-btn").click();
    await page.waitForTimeout(150);
    const left = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("supplier-scout:v1")).shortlist).length);
    check(left === 0 && await page.locator(".orphans").count() === 0, "«Убрать» удаляет их по решению закупщика", `осталось записей: ${left}`);
    await ctx.close();
  }

  // ---------- 390 ----------
  {
    const { ctx, page } = await newPage(390, 844);
    step("Телефон 390: меню — те же пункты верхней полосой, подсветка на вложенных экранах");
    await page.goto(base + "#/", { waitUntil: "networkidle" });
    const items = await page.locator(".side-nav .nav-item .nav-l").allInnerTexts();
    check(items.join(" · ") === "Поиск по товару · Поиск по категории · Помощник · Знаю поставщика · Все поставщики · Шорт-лист · Как собраны данные", "пункты и порядок", items.join(" · "));
    check(await page.locator(".side-nav").evaluate((e) => getComputedStyle(e).flexDirection) === "row", "меню — верхняя полоса");
    await page.locator(".ways .way", { hasText: "Поиск по категории" }).click();
    await page.waitForTimeout(200);
    await page.locator(".cat-acc-h", { hasText: "Упаковка" }).click();
    await page.locator(".cat-sub", { hasText: "Коробки для пиццы" }).click();
    await page.waitForTimeout(300);
    check(hash(page) === "#/results?cat=packaging&sub=pizza-boxes" && (await activeNav(page)).join() === "Поиск по категории", "главная → категория → подкатегория кликами; подсвечен «Поиск по категории»", hash(page));
    await page.locator(".sub-chip", { hasText: "Пакеты и крафт" }).click();
    await page.waitForTimeout(300);
    const bags = await rowNames(page);
    check(hash(page).includes("sub=bags") && bags.every((x) => byName.get(x.trim())?.subcategories.includes("bags")), `смена подкатегории на месте: «Пакеты и крафт», ${bags.length}`);

    step("Телефон 390: нет горизонтального скролла");
    const screens = ["#/", "#/find", "#/find?q=моцарелла", "#/find?q=молоко", "#/find?q=кофе", "#/find?q=малоко", "#/find?q=рыба для суши", "#/categories", "#/categories?open=packaging", "#/categories?open=fish", "#/categories?open=dairy", "#/categories?open=grocery", "#/results?cat=packaging", "#/results?cat=packaging&sub=pizza-boxes", "#/results?cat=fish", "#/results?cat=fish&sub=fish-sushi", "#/results?cat=dairy", "#/results?cat=grocery&view=table", "#/results?cat=packaging&view=table", "#/catalog", "#/compare?ids=kraft-upakovka,po-karton,tara-dlya-tovara,parus-pak&cat=packaging", "#/why?cat=fish", "#/s/ubplastik?cat=packaging", "#/compare", "#/why?cat=packaging", "#/shortlist", "#/add", "#/about-data", "#/assistant"];
    await page.evaluate(() => { const it = { status: "Не связывались", note: "заметка", note_at: null, added_at: "2026-10-14T10:00:00.000Z" }; localStorage.setItem("supplier-scout:v1", JSON.stringify({ shortlist: { ubplastik: it, pack24: it, "demo-old-1": it }, compare: [], returned: [], collected: {}, last: null })); });
    const bad = [];
    for (const r of screens) {
      await page.goto(base + r, { waitUntil: "networkidle" });
      await page.waitForTimeout(150);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      if (w[0] > w[1]) bad.push(`${r} ${w[0]}/${w[1]}`);
      log.push(`  - ${r}: ${w[0]} / ${w[1]}`);
    }
    check(bad.length === 0, `scrollWidth ≤ clientWidth на ${screens.length} экранах`, bad.join("; "));
    await ctx.close();
  }

  step("Ошибки консоли");
  check(errs.length === 0, "0 ошибок консоли и страницы", errs.join(" | "));

  await browser.close();
  server.close();
  const head = `# Навигация — сценарии кликами\n\nПрогон ${new Date().toISOString()}, \`web/dist\`, headless Chromium. Проверок с ошибкой: ${failed}.\n`;
  const out = process.argv[2] || path.join(ROOT, "e2e-out", "nav.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, head + log.join("\n") + "\n");
  console.log(`\nFAILED: ${failed} · протокол: ${out}`);
  process.exitCode = failed ? 1 : 0;
})();
