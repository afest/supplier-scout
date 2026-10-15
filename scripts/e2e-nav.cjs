// Навигация и раскладка (T-537): главная → четыре входа, каталог категорий → подкатегория на месте,
// поиск по товару, пустой ответ, шорт-лист и его счётчик, отсутствие горизонтального скролла на 390.
// T-541: колонка фильтров на трёх экранах, карточка-ссылка и звёздочка, цвет шкал по третям, ползунок по пикселям.
// T-543: страница поставщика — вкладки в адресе, разбор с весами и сравнением, старые ссылки #/why, логотипы, отзывы-примеры.
// Всё кликами и вводом в headless Chromium; сервер dist — в том же процессе.
//
// Запуск (нужен Playwright с установленным Chromium; экраны с сервером ходят в заглушку API — scripts/api-stub.cjs):
//   VITE_API_URL=http://127.0.0.1:8765 npm --prefix web run build
//   NODE_PATH=<папка с node_modules/playwright> node scripts/e2e-nav.cjs [файл-протокола]
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { serveDist } = require("./serve-dist.cjs");
const { startApiStub } = require("./api-stub.cjs");
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
const rowNames = (page) => page.locator(".rows .lcard a.nm").allInnerTexts();
/** Экран «Поиск по категории» (круг 3): подкатегории отмечаются, переход — кнопкой «Перейти к поставщикам» справа. */
const goSuppliers = async (page) => { await page.locator(".cats-go-btn").click(); await page.waitForTimeout(300); };
/** Выпадающий выбор категорий и подкатегорий (T-541, круг 2): раскрыть, отметить, прочитать выбранное пилюлями. */
const picker = {
  open: async (page) => { if (!(await page.locator(".cpick.open").count())) await page.locator(".cp-trigger").click(); },
  done: async (page) => { if (await page.locator(".cpick.open").count()) await page.locator(".cp-foot .btn", { hasText: "Готово" }).click(); },
  cat: async (page, short) => { await picker.open(page); await page.locator(".cp-cat-h .cp-row", { hasText: short }).click(); await page.waitForTimeout(250); },
  sub: async (page, short, name) => {
    await picker.open(page);
    const c = page.locator(".cp-cat", { has: page.locator(".cp-cat-h", { hasText: short }) });
    if ((await c.locator(".cp-exp").getAttribute("aria-expanded")) !== "true") await c.locator(".cp-exp").click();
    await c.locator(".cp-row.sub", { hasText: name }).click();
    await page.waitForTimeout(250);
  },
  chips: async (page) => (await page.locator(".cp-chip").allInnerTexts()).map((x) => x.replace(/×/g, "").replace(/\s+/g, " ").trim()),
};

(async () => {
  const { server, base } = await serveDist(path.join(ROOT, "web", "dist"));
  const api = await startApiStub();          // помощник, отзывы и живой сбор ходят в сервер (T-536)
  const browser = await chromium.launch({ headless: true });
  const errs = [];
  const newPage = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(`${w}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errs.push(`${w}: ${m.text()} ${m.location()?.url ?? ""}`.trim()); });
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
    await page.locator(".sub-jump a", { hasText: "Моцарелла" }).click();
    await page.waitForTimeout(250);
    check(hash(page) === "#/results?cat=dairy&sub=mozzarella", "«Подкатегория целиком» → результаты с подкатегорией", hash(page));
    const mozN = DATA.suppliers.filter((s) => !s.live_only && s.subcategories.includes("mozzarella")).length;
    const mozShown = (await rowNames(page)).length + Number((await page.locator(".excluded-toggle").allInnerTexts())[0]?.match(/·\s*(\d+)\s*\S*$/)?.[1] ?? 0);
    check((await picker.chips(page)).join() === "Моцарелла" && mozShown === mozN, `  на результатах выбрана «Моцарелла»: ${mozShown} = ${mozN} в наборе, с продавцами из других категорий`);
    await page.goBack();
    await page.waitForTimeout(250);
    // группы — по числу находок: моцареллу продают и рыбные оптовики (T-538), поэтому группа сыра — по названию
    await page.locator(".find-group", { hasText: "Сыр и молочное" }).locator(".find-group-h a").click();
    await page.waitForTimeout(250);
    check(hash(page) === "#/results?cat=dairy", "«Вся категория» из поиска → результаты категории", hash(page));

    // «молоко» после ассортимента T-535 находится — пустой ответ проверяем на том, чего в наборе нет
    step("Пустой ответ «тапиока» — переходы");
    await page.goto(base + "#/find?q=тапиока", { waitUntil: "networkidle" });
    for (const [sel, t, h] of [[".empty-ways a", "Поиск по категории", "#/categories"], [".empty-ways a", "Знаю поставщика", "#/add"], [".empty-ways a", "Помощник", "#/assistant"]]) {
      await page.goto(base + "#/find?q=тапиока", { waitUntil: "networkidle" });
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
    // T-538: подкатегория — все, кто её продаёт, из любой категории
    const packSubs = DATA.categories.find((c) => c.id === "packaging").subcategories;
    const expect = packSubs.map((x) => DATA.suppliers.filter((s) => !s.live_only && s.subcategories.includes(x.id)).length);
    check(subs.slice(1).map((x) => x.match(/\d+$/)[0]).join() === expect.join(), `счётчики ${packSubs.length} подкатегорий совпадают с набором`, expect.join(" / "));
    await page.locator(".cat-sub", { hasText: "Коробки для пиццы" }).click();
    await page.waitForTimeout(200);
    check(hash(page) === "#/categories?open=packaging&cat=packaging&sub=pizza-boxes" && await page.locator(".cat-sub.on").count() === 1,
      "клик по подкатегории отмечает её, а не уводит на выдачу", hash(page));
    const pbN = DATA.suppliers.filter((s) => !s.live_only && s.subcategories.includes("pizza-boxes")).length;
    check(Number(await page.locator(".cats-go-n .num").innerText()) === pbN, `справа — сколько набралось: ${pbN}`);
    await goSuppliers(page);
    check(hash(page) === "#/results?cat=packaging&sub=pizza-boxes", "«Перейти к поставщикам» → результаты с подкатегорией", hash(page));
    check((await activeNav(page)).join() === "Поиск по категории", "на результатах подсвечен «Поиск по категории»");
    const pb = await rowNames(page);
    const pbBad = pb.filter((n) => !byName.get(n.trim())?.subcategories.includes("pizza-boxes"));
    check(pb.length > 0 && pbBad.length === 0, `в результатах только «Коробки для пиццы»: ${pb.length} поставщиков`, pbBad.length ? `чужие: ${pbBad.join(", ")}` : "");
    const firstZone = await page.locator(".first .gcard .nm").allInnerTexts();
    check(firstZone.every((n) => byName.get(n.trim())?.subcategories.includes("pizza-boxes")), "«Кому написать первым» — тоже из подкатегории", firstZone.join(", "));
    // T-541, круг 2: подкатегории меняются выпадающим списком в колонке, можно несколько и из разных категорий
    await picker.sub(page, "Упаковка", "Контейнеры для роллов");
    await picker.sub(page, "Упаковка", "Коробки для пиццы");
    check(hash(page).startsWith("#/results?cat=packaging&sub=sushi-boxes"), "смена подкатегории на месте, без возврата в каталог", hash(page));
    const ct = await rowNames(page);
    check(ct.length > 0 && ct.every((n) => byName.get(n.trim())?.subcategories.includes("sushi-boxes")), `  теперь только «Контейнеры для роллов и суши»: ${ct.length}`);
    await picker.sub(page, "Упаковка", "Пакеты");
    const two = await rowNames(page);
    check(hash(page).includes("sub=sushi-boxes,bags") && two.length > ct.length && two.every((n) => ["sushi-boxes", "bags"].some((x) => byName.get(n.trim())?.subcategories.includes(x))),
      `несколько подкатегорий сразу: «Контейнеры для роллов» + «Пакеты» — ${two.length}`, hash(page));
    await picker.sub(page, "Сыр", "Моцарелла");
    const secs = await page.locator(".res-sec").evaluateAll((ss) => ss.map((s) => ({ name: s.getAttribute("aria-label"), rows: [...s.querySelectorAll(".rows .lcard a.nm")].map((a) => a.textContent.trim()), first: s.querySelectorAll(".first .gcard").length })));
    const dairySec = secs.find((s) => s.name.startsWith("Сыр"));
    const qp = new URLSearchParams(hash(page).split("?")[1]);
    check(qp.get("cats") === "packaging,dairy" && qp.get("sub") === "sushi-boxes,bags,mozzarella" && !qp.get("cat") && secs.length === 2 && secs.every((s) => s.first > 0),
      "и подкатегория другой категории: два раздела, у каждого своя тройка «Кому написать первым»", `${hash(page)} · ${secs.map((s) => `${s.name}: ${s.rows.length}`).join(", ")}`);
    check(!!dairySec && dairySec.rows.every((n) => byName.get(n.trim())?.subcategories.includes("mozzarella")), "  в разделе сыра — только моцарелла");
    await picker.done(page);
    check((await picker.chips(page)).join(" | ") === "Контейнеры для роллов и суши | Пакеты | Моцарелла", "  выбранное — пилюлями под закрытым списком", (await picker.chips(page)).join(" | "));
    await picker.sub(page, "Сыр", "Моцарелла");
    await picker.cat(page, "Упаковка");
    check(hash(page) === "#/results?cat=packaging", "сняли моцареллу, отметили «Упаковку» целиком — снова вся категория", hash(page));
    await picker.cat(page, "Упаковка");
    check(hash(page) === "#/results?cat=packaging", "  последнюю категорию снять нельзя: без неё нечего рекомендовать", hash(page));
    await picker.done(page);
    await page.locator(".rail .crumb").click();
    await page.waitForTimeout(200);
    check(hash(page) === "#/categories?open=packaging&cat=packaging", "«← Поиск по категории» возвращает в каталог: категория открыта, выбор сохранён", hash(page));
    // T-541, круг 3: раскрыть можно несколько категорий сразу и отметить подкатегории в каждой
    await page.locator(".cat-acc-h", { hasText: "Рыба" }).click();
    await page.waitForTimeout(200);
    check(await page.locator(".cat-subs").count() === 2, "вторая категория раскрывается, первая остаётся открытой", hash(page));
    await page.locator(".cat-sub.all.on").click();
    await page.locator(".cat-acc > li", { hasText: "Упаковка" }).locator(".cat-sub", { hasText: "Стаканы и крышки" }).click();
    await page.locator(".cat-acc > li", { hasText: "Упаковка" }).locator(".cat-sub", { hasText: "Пакеты" }).click();
    await page.locator(".cat-acc > li", { hasText: "Рыба" }).locator(".cat-sub", { hasText: "Креветки" }).click();
    await page.waitForTimeout(200);
    const want3 = DATA.suppliers.filter((s) => !s.live_only && ["cups", "bags", "shrimp"].some((x) => s.subcategories.includes(x))).length;
    check(await page.locator(".cat-sub.on").count() === 3 && Number(await page.locator(".cats-go-n .num").innerText()) === want3,
      `отмечены три подкатегории в двух категориях, справа ${want3} — все, кто продаёт хоть одну`, await page.locator(".cats-go-n").innerText());
    await goSuppliers(page);
    const qp3 = new URLSearchParams(hash(page).split("?")[1]);
    check(hash(page).startsWith("#/results?") && qp3.get("cats") === "packaging,fish" && qp3.get("sub") === "cups,bags,shrimp" && await page.locator(".res-sec").count() === 2,
      "«Перейти к поставщикам» → выдача разделами: упаковка и рыба", hash(page));
    await page.goto(base + "#/categories?open=packaging", { waitUntil: "networkidle" });
    await page.locator(".cat-acc-h", { hasText: "Упаковка" }).click();
    await page.waitForTimeout(150);
    check(await page.locator(".cat-subs").count() === 0, "повторный клик сворачивает категорию");

    step("Подкатегории по ассортименту (T-538): все, кто продаёт, — из любой категории");
    const members = (id) => DATA.suppliers.filter((s) => !s.live_only && s.subcategories.includes(id));
    const catShort = Object.fromEntries(DATA.categories.map((c) => [c.id, c.short.toLowerCase()]));
    const excludedN = async () => {
      const t = await page.locator(".excluded-toggle").allInnerTexts();
      return t.length ? Number(t[0].match(/·\s*(\d+)/)[1]) : 0;
    };
    // строки выдачи: имя, пометка «основная категория», первая позиция-основание
    const rowsFull = () => page.locator(".rows .lcard").evaluateAll((rs) => rs.map((r) => ({
      name: r.querySelector(".nm").textContent.trim(),
      guest: r.querySelector(".guest-tag")?.textContent.trim() ?? null,
      basis: r.querySelector(".basis .found-v")?.textContent.replace(/^ · /, "").trim() ?? null,
    })));
    const subCheck = async (catName, subName, id, catId) => {
      await page.goto(base + "#/categories", { waitUntil: "networkidle" });
      await page.locator(".cat-acc-h", { hasText: catName }).click();
      await page.locator(".cat-sub", { hasText: subName }).first().click();
      await goSuppliers(page);
      const rows = await rowsFull(page);
      const want = members(id);
      const ex = await excludedN();
      const wrong = rows.filter((r) => !byName.get(r.name)?.subcategories.includes(id)).map((r) => r.name);
      check(hash(page) === `#/results?cat=${catId}&sub=${id}`, `«${catName}» → «${subName}» кликами`, hash(page));
      check(wrong.length === 0 && rows.length + ex === want.length, `в выдаче все продавцы и только они: ${rows.length} + исключённых ${ex} = ${want.length} в наборе`, wrong.join(", "));
      const tagBad = rows.filter((r) => {
        const s = byName.get(r.name);
        return s.category === catId ? r.guest !== null : r.guest !== `основная категория — ${catShort[s.category]}`;
      }).map((r) => r.name);
      check(tagBad.length === 0, `пометка «основная категория — …» ровно у поставщиков из чужой категории: ${rows.filter((r) => r.guest).length}`, tagBad.join(", "));
      const basisBad = rows.filter((r) => r.basis !== byName.get(r.name).subcategory_basis[id][0]).map((r) => r.name);
      check(basisBad.length === 0, "у каждой строки — позиция-основание из набора", basisBad.join(", "));
      return rows;
    };
    const cups = await subCheck("Упаковка", "Стаканы и крышки", "cups", "packaging");
    check(cups.every((r) => !r.guest), "стаканы продают только упаковщики: все совпадения из других категорий оказались ложными (сметана в стакане, вафельный стаканчик)");
    const shrimp = await subCheck("Рыба", "Креветки", "shrimp", "fish");
    const guestRow = shrimp.find((r) => r.guest);
    check(!!guestRow, `в «Креветках» есть продавцы из других категорий: ${shrimp.filter((r) => r.guest).map((r) => r.name).join(", ")}`);
    await subCheck("Сыр и молочное", "Моцарелла", "mozzarella", "dairy");

    // карточка гостя: балл и «назад» — в той категории, откуда пришли
    await page.goto(base + "#/results?cat=fish&sub=shrimp", { waitUntil: "networkidle" });
    await page.locator(".rows .lcard a.nm", { hasText: guestRow.name }).first().click();
    await page.waitForTimeout(300);
    const label = await page.locator(".card-title .label").innerText();
    check(/основная категория/i.test(label) && label.toLowerCase().includes("креветки"), "карточка гостя: категория просмотра и пометка «основная категория»", label.replace(/\s+/g, " "));
    check((await page.locator(".card-rail .crumb").innerText()).includes("Рыба и морепродукты"), "«назад» ведёт в рыбу, откуда пришли");
    check((await page.locator(".sp-place").innerText()).replace(/\s+/g, " ").includes("в подкатегории «Креветки»"), "место — в подкатегории «Креветки»", (await page.locator(".sp-place").innerText()).replace(/\s+/g, " "));
    await page.locator(".card-nav .nav-item", { hasText: "Ассортимент" }).click();
    await page.waitForTimeout(200);
    check(await page.locator(".in-subs-line").count() >= 2, "во вкладке «Ассортимент» — «В подкатегориях» по категориям, со ссылками");

    // поиск по товару ведёт в подкатегорию целиком; «тапиока» — честное «не нашли»
    await page.goto(base + "#/find?q=стаканчики", { waitUntil: "networkidle" });
    await page.locator(".sub-jump a", { hasText: "Стаканы и крышки" }).click();
    await page.waitForTimeout(300);
    check(hash(page) === "#/results?cat=packaging&sub=cups", "поиск «стаканчики» → подкатегория «Стаканы и крышки»", hash(page));
    for (const [qq, sub] of [["креветки", "Креветки"], ["сливки", "Сливки"]]) {
      await page.goto(base + `#/find?q=${encodeURIComponent(qq)}`, { waitUntil: "networkidle" });
      check(await page.locator(".sub-jump a", { hasText: sub }).count() === 1, `поиск «${qq}» предлагает подкатегорию «${sub}» целиком`);
    }
    await page.goto(base + "#/find?q=тапиока", { waitUntil: "networkidle" });
    check(await page.locator(".find-empty").count() === 1 && await page.locator(".rows .lcard").count() === 0, "«тапиока» — пустой ответ");
    check(await page.locator(".notice").count() === 0 && await page.locator(".find-related").count() === 0 && await page.locator(".sub-jump").count() === 0,
      "без подбора похожего: ни «исправленного запроса», ни «похожей категории»");

    step("Правки перед публикацией (T-539): доставка, robots.txt, ФНС, крупный опт");
    const row = (label) => page.locator(".field", { has: page.locator(".k", { hasText: label }) }).first();
    const field = async (label) => (await row(label).innerText()).replace(/\s+/g, " ");
    const value = async (label) => (await row(label).locator(".v").first().innerText()).replace(/\s+/g, " ");
    const paid = (t) => /(?<!бес)платн/i.test(t);
    await page.goto(base + "#/s/morskoe-schaste?tab=terms", { waitUntil: "networkidle" });
    const sea = await value("Доставка");
    const seaQuote = await field("Доставка");
    check(sea.includes("бесплатно от 10 000 ₽") && !paid(sea) && seaQuote.includes("10 000руб. доставка бесплатно"),
      "«Морское счастье»: доставка бесплатно от 10 000 ₽, в цитате — строка с порогом", sea);
    await page.goto(base + "#/s/uralpaksistem?tab=terms", { waitUntil: "networkidle" });
    const ural = await value("Доставка");
    check(ural.includes("бесплатно от 1 000 шт") && !paid(ural), "Уралпаксистем: «бесплатно от 1 000 шт», а не «платно»", ural);
    await page.goto(base + "#/s/atlant-grupp?tab=terms", { waitUntil: "networkidle" });
    const atl = await value("Доставка");
    check(atl.includes("стоимость не указана") && !paid(atl), "Атлант: стоимость доставки не указана — не «платно»", atl);
    await page.goto(base + "#/s/redfish?tab=terms", { waitUntil: "networkidle" });
    const red = await field("Цены");
    check(red.includes("не собрано: сайт запрещает сбор"), "RedFish: цены «не собрано: сайт запрещает сбор», а не «не найдено»", red.slice(0, 120));
    await page.goto(base + "#/s/food-face-ru", { waitUntil: "networkidle" });
    const ff = (await page.locator(".card-page").innerText()).replace(/\s+/g, " ");
    check(ff.includes("массовый адрес") && !ff.includes("не ответил"), "Food-Face: флаги ФНС проверены — «массовый адрес», без «не ответил»");
    await page.goto(base + "#/results?cat=fish&sub=shrimp", { waitUntil: "networkidle" });
    const first = await page.locator(".first .gcard .nm").allInnerTexts();
    check(first.length > 0 && !first.some((n) => n.includes("Атлант")), "«Креветки»: Атланта нет в «Кому написать первым»", first.join(" · "));
    const atlRow = page.locator(".rows .lcard", { has: page.locator(".nm", { hasText: "Атлант" }) });
    check(await atlRow.count() === 1 && await atlRow.locator(".opt-pill").count() === 1, "«Креветки»: Атлант в списке с пометкой «крупный опт»");
    await page.locator(".first-head a", { hasText: "Почему такой порядок" }).click();
    await page.waitForTimeout(300);
    const verdict = await page.locator(".verdict").innerText();
    check(!verdict.includes("Атлант") && verdict.includes(first[0]), "«Почему такой порядок»: первым — тот же, что в тройке", verdict.slice(0, 80));
    check(hash(page).startsWith(`#/s/${byName.get(first[0].trim())?.id}?`) && hash(page).includes("tab=why") && hash(page).includes("sub=shrimp") && (await page.locator(".sp-place").innerText()).includes("Креветки"),
      "  ссылка ведёт во вкладку «Разбор» первого, рейтинг — внутри «Креветок»", hash(page));

    step("«Знаю поставщика» → живой сбор → «Сравнить с остальными»");
    await page.goto(base + "#/add", { waitUntil: "networkidle" });
    await page.locator(".examples .pill-out").filter({ hasText: "посоветовал коллега" }).first().click();
    const cmp = page.locator(".result-card a", { hasText: "Сравнить с остальными" });
    await cmp.waitFor({ timeout: 60000 }).catch(() => {});
    if (await cmp.count()) {
      await cmp.click();
      await page.waitForTimeout(250);
      check(hash(page).startsWith("#/results?cat="), "«Сравнить с остальными» → результаты категории", hash(page));
      check(!hash(page).includes("sub=") && (await picker.chips(page)).length === 1, "  открыта категория целиком", (await picker.chips(page)).join());
    } else check(false, "«Сравнить с остальными» не появилась за 60 с");
    await ctx.close();
  }

  // ---------- колонка фильтров и карточка в списке (T-541) ----------
  {
    const { ctx, page } = await newPage(1440, 900);
    step("Меню и главная без лишних подписей (T-541)");
    await page.goto(base + "#/", { waitUntil: "networkidle" });
    check(await page.locator(".side-nav .nav-cap").count() === 0, "в меню нет подписи группы «Найти поставщика»");
    check(await page.locator(".home-head .label").count() === 0 && (await page.locator(".home-head").innerText()).includes("Найти поставщика"), "на главной нет надзаголовка, заголовок и пояснение на месте");

    step("Колонка фильтров — одна на три экрана, сразу после меню, не уезжает при прокрутке (1440)");
    const navRight = await page.locator(".side-nav").evaluate((e) => Math.round(e.getBoundingClientRect().right));
    for (const [name, h] of [["поиск по товару", "#/find?q=молоко"], ["категория", "#/results?cat=dairy"], ["все поставщики", "#/catalog"]]) {
      await page.goto(base + h, { waitUntil: "networkidle" });
      const rail = page.locator(".rail");
      const r0 = await rail.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), top: Math.round(r.top), h: Math.round(r.height), line: getComputedStyle(e).borderRightWidth }; });
      await page.evaluate(() => window.scrollTo(0, 1600));
      await page.waitForTimeout(100);
      const r1 = await rail.evaluate((e) => Math.round(e.getBoundingClientRect().top));
      check(await rail.count() === 1 && await page.locator(".rail .filters .filters-in").count() === 1, `${name}: одна колонка, в ней общий блок фильтров`);
      check(r0.x === navRight && r0.top === 0 && r0.h === 900 && r0.line === "1px", `${name}: колонка сразу после меню, во всю высоту, отделена полосой`, JSON.stringify(r0));
      check(r1 === 0 && await page.evaluate(() => window.scrollY) > 0, `${name}: после прокрутки выдачи колонка на месте`);
      check(!(await page.locator(".rail-open").isVisible()), `${name}: кнопки «Фильтры» на широком экране нет`);
    }

    step("Поиск по товару: фильтры сужают 18 поставщиков «молоко»");
    await page.goto(base + "#/find?q=" + encodeURIComponent("молоко"), { waitUntil: "networkidle" });
    check(await page.locator(".rail input#q").inputValue() === "молоко", "ключевое слово — в колонке");
    const n0 = await page.locator(".rows .lcard").count();
    await page.locator(".rail .filters .chk", { hasText: "Доставка до точки" }).click();
    await page.waitForTimeout(200);
    const n1 = await page.locator(".rows .lcard").count();
    const hiddenTxt = (await page.locator(".find-count").innerText()).replace(/\s+/g, " ");
    const hiddenN = Number(hiddenTxt.match(/(\d+) скрыто/)?.[1] ?? 0);
    const door = (await page.locator(".rows .lcard a.nm").allInnerTexts()).filter((n) => !byName.get(n.trim())?.delivery?.value?.to_door);
    check(n1 > 0 && n1 < n0 && n1 + hiddenN === n0, `«Доставка до точки»: ${n0} → ${n1}, скрыто ${hiddenN}`, hiddenTxt);
    check(door.length === 0, "  остались только те, кто возит до точки", door.join(", "));
    check(hash(page).includes("f=door"), "  фильтр — в адресе", hash(page));

    step("Карточка в списке: открывается кликом по любому месту, звёздочка — нет, фокус с клавиатуры виден");
    await page.goto(base + "#/results?cat=dairy", { waitUntil: "networkidle" });
    const card = page.locator(".rows .lcard").first();
    const cname = (await card.locator("a.nm").innerText()).trim();
    await card.locator(".fbar").scrollIntoViewIfNeeded();
    const ring = await card.locator(".fbar").boundingBox();
    await page.mouse.click(ring.x + ring.width / 2, ring.y + ring.height / 2);
    await page.waitForTimeout(250);
    check(hash(page).startsWith(`#/s/${byName.get(cname).id}`), `клик по шкале полноты открывает «${cname}»`, hash(page));
    await page.goBack();
    await page.waitForTimeout(250);
    await page.locator(".rows .lcard").nth(1).locator(".badges").scrollIntoViewIfNeeded();
    const meta = await page.locator(".rows .lcard").nth(1).locator(".badges").boundingBox();
    const name2 = (await page.locator(".rows .lcard").nth(1).locator("a.nm").innerText()).trim();
    await page.mouse.click(meta.x + 4, meta.y + meta.height - 4);
    await page.waitForTimeout(250);
    check(hash(page).startsWith(`#/s/${byName.get(name2).id}`), `клик по бейджам открывает «${name2}»`, hash(page));
    await page.goBack();
    await page.waitForTimeout(250);
    const before = hash(page);
    const star = page.locator(".rows .lcard").first().locator(".star");
    await star.click();
    await page.waitForTimeout(150);
    check(hash(page) === before && await star.getAttribute("aria-pressed") === "true", "клик по звёздочке ставит в шорт-лист и карточку не открывает");
    await star.click();
    check(await page.locator(".rows .lcard").first().locator("button, a, input, select").count() === 2, "в карточке два интерактивных элемента: ссылка и звёздочка", String(await page.locator(".rows .lcard").first().locator("button, a, input, select").count()));
    await page.locator(".first .gcard").last().focus();
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const a = document.activeElement;
      const c = a.closest(".lcard");
      return { on: a.matches(".lcard a.nm:focus-visible"), ring: c ? getComputedStyle(c).boxShadow : "" };
    });
    check(focus.on && focus.ring.includes("rgb(214, 58, 28)"), "Tab → фокус на первой карточке, вокруг карточки видна рамка", focus.ring);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    check(hash(page).startsWith(`#/s/${byName.get(cname).id}`), "Enter открывает поставщика", hash(page));

    step("Подписи «рейтинг» и «полнота данных» — только при наведении на сам элемент (круг 5)");
    await page.goto(base + "#/results?cat=dairy", { waitUntil: "networkidle" });
    const lcd = page.locator(".rows .lcard").nth(1);
    await lcd.scrollIntoViewIfNeeded();
    const labels = () => lcd.evaluate((c) => [getComputedStyle(c.querySelector(".lc-k")).opacity, getComputedStyle(c.querySelector(".fbar-k")).opacity].join());
    const hoverOn = async (sel) => { const b = await lcd.locator(sel).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(250); return labels(); };
    const onMeta = await hoverOn(".row-meta"), onScore = await hoverOn(".snum"), onBar = await hoverOn(".fbar-rule");
    check(onMeta === "0,0" && onScore === "1,0" && onBar === "0,1", "над карточкой подписей нет, над цифрой — «рейтинг в категории», над шкалой — «полнота данных»", `${onMeta} · ${onScore} · ${onBar}`);
    check(await lcd.locator(".lc-div").count() === 1, "между рейтингом и шкалой — разделитель");

    step("Логотипы на стенде (T-541, круг 2): в покое одноцветные, по наведению — свои цвета, аватар не сдвигается");
    await page.goto(base + "#/catalog", { waitUntil: "networkidle" });
    const logos = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "logos.json"), "utf8"));
    const tilesWithLogo = await page.locator(".lcard.tile .ava img").count();
    const expectLogo = (await page.locator(".lcard.tile a.nm").allInnerTexts()).filter((n) => logos[byName.get(n.trim())?.id]).length;
    check(tilesWithLogo > 0 && tilesWithLogo === expectLogo, `логотип у всех, для кого он собран: ${tilesWithLogo} из ${await page.locator(".lcard.tile").count()}`);
    const lc = page.locator(".lcard.tile", { has: page.locator(".ava:not(.dk) img") }).first();
    await lc.scrollIntoViewIfNeeded();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const avaState = () => lc.locator(".ava").evaluate((a) => ({ box: JSON.stringify(a.getBoundingClientRect()), img: JSON.stringify(a.querySelector("img").getBoundingClientRect()), f: getComputedStyle(a.querySelector("img")).filter }));
    const st0 = await avaState();
    const lb = await lc.boundingBox();
    await page.mouse.move(lb.x + lb.width - 40, lb.y + lb.height - 20);
    await page.waitForTimeout(400);
    const st1 = await avaState();
    check(st0.f.includes("ava-navy") && st1.f === "none", "в покое фильтр перекраски в синий на самой картинке (без слоя поверх — без контура), по наведению на карточку — свои цвета", `${st0.f} → ${st1.f}`);
    check(await page.evaluate(() => [...document.querySelectorAll(".ava")].every((a) => getComputedStyle(a, "::after").content === "none")), "  слоя наложения поверх логотипа нет");
    check(st0.box === st1.box && st0.img === st1.img, "аватар и картинка не сдвигаются и не меняют размер", st0.box === st1.box && st0.img === st1.img ? "" : `${st0.box} ${st0.img} → ${st1.box} ${st1.img}`);
    const dk = page.locator(".lcard.tile .ava.dk").first();
    if (await dk.count()) {
      const d0 = await dk.evaluate((a) => getComputedStyle(a).backgroundColor);
      await dk.scrollIntoViewIfNeeded();
      const db = await dk.boundingBox();
      await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
      await page.waitForTimeout(300);
      const d1 = await dk.evaluate((a) => getComputedStyle(a).backgroundColor);
      check(d0 === d1 && d0 === "rgb(42, 58, 84)", "белый логотип — на тёмной плашке и в покое, и по наведению", `${d0} → ${d1}`);
    }

    step("Подсказки «?» поверх страницы (круг 4): колонка и карточка не обрезают окно");
    const popOk = async (where) => {
      await page.waitForFunction(() => document.querySelector(".pop-body")?.style.getPropertyValue("--pt"));
      const r = await page.evaluate(() => {
        const b = document.querySelector(".pop-body");
        if (!b) return { ok: false, why: "окна нет" };
        const rc = b.getBoundingClientRect();
        const inBody = b.parentElement === document.body;
        // точки по углам окна — сверху именно окно, а не колонка или соседняя карточка
        const pts = [[rc.left + 6, rc.top + 6], [rc.right - 6, rc.top + 6], [rc.left + 6, rc.bottom - 6], [rc.right - 6, rc.bottom - 6]];
        const covered = pts.filter(([x, y]) => !b.contains(document.elementFromPoint(x, y))).length;
        return { ok: inBody && covered === 0 && rc.left >= 0 && rc.right <= innerWidth, why: `в body: ${inBody}, перекрыто углов: ${covered}, ${Math.round(rc.left)}…${Math.round(rc.right)}` };
      });
      check(r.ok, `${where}: окно целиком и поверх`, r.why);
      await page.keyboard.press("Escape");
    };
    await page.goto(base + "#/results?cat=fish&sub=shrimp", { waitUntil: "networkidle" });
    await page.locator(".rail-params .rp-k", { hasText: "Закупка в неделю" }).locator(".pop-btn").click();
    await popOk("подсказка в колонке («Закупка в неделю»)");
    await page.locator(".rail .filters .label", { hasText: "Минимальный заказ" }).locator(".pop-btn").click();
    await popOk("подсказка в фильтрах колонки");
    const optRow = page.locator(".rows .lcard", { has: page.locator(".opt-pill") }).first();
    await optRow.scrollIntoViewIfNeeded();
    await optRow.locator(".opt-pill .pop-btn").click();
    await popOk("подсказка «крупный опт» внутри карточки");
    check(hash(page).startsWith("#/results?cat=fish"), "  клик по «?» в карточке карточку не открывает", hash(page));
    await page.locator(".rail .rail-params .pop-btn").first().click();
    await page.evaluate(() => document.querySelector(".rail").scrollBy(0, 120));
    await page.waitForTimeout(150);
    const follow = await page.evaluate(() => { const b = document.querySelector(".pop-body").getBoundingClientRect(), k = document.querySelector(".rail .rail-params .pop-btn").getBoundingClientRect(); return Math.abs(b.top - (k.bottom + 12)) < 2; });
    check(follow, "при прокрутке колонки окно едет вместе с «?»");
    await page.keyboard.press("Escape");

    step("Цвет шкал по третям: цифра балла и шкала полноты");
    await page.goto(base + "#/catalog", { waitUntil: "networkidle" });
    const lv = (v, max = 100) => { const p = Math.round((v / max) * 100); return p <= 33 ? "low" : p <= 66 ? "mid" : "high"; };
    const tiles = await page.locator(".lcard.tile").evaluateAll((ts) => ts.map((t) => ({
      score: t.querySelector(".snum")?.className, n: Number(t.querySelector(".snum")?.textContent),
      ring: t.querySelector(".fbar").className, f: t.querySelector(".fbar-n").textContent,
      w: t.querySelector(".fbar-rule").style.getPropertyValue("--w"), num: getComputedStyle(t.querySelector(".snum") ?? t).color, bar: getComputedStyle(t.querySelector(".fbar-fill"), "::after").backgroundColor,
    })));
    const lvBad = tiles.filter((t) => (t.score && !t.score.includes(`lv-${lv(t.n)}`)) || !t.ring.includes(`lv-${lv(...t.f.split("/").map(Number))}`) || Math.abs(parseFloat(t.w) - (100 * t.f.split("/")[0]) / t.f.split("/")[1]) > 0.5);
    // цифра балла — тем же цветом, что черта шкалы, у плиток одного уровня (круг 4)
    const sameColor = tiles.filter((t) => t.score && t.score.match(/lv-\w+/)[0] === t.ring.match(/lv-\w+/)[0]).every((t) => t.num === t.bar);
    check(sameColor, "цифра балла того же цвета, что шкала полноты, когда у них один уровень");
    check(tiles.length > 0 && lvBad.length === 0, `у ${tiles.length} плиток цвет балла и шкалы — по трети, заливка шкалы — доля найденных полей`, JSON.stringify(lvBad.slice(0, 3)));
    const seen = new Set(tiles.flatMap((t) => [t.score?.match(/lv-\w+/)?.[0], t.ring.match(/lv-\w+/)[0]]));
    check(seen.has("lv-low") || seen.has("lv-mid"), "в каталоге встречаются разные уровни", [...seen].join(", "));

    step("Ползунок «минимальный заказ»: черта бегунка примыкает к краю заливки");
    // замер по пикселям: самый правый столбец насыщенного красного (черта) и последний розоватый (заливка)
    const gap = async () => {
      const el = page.locator(".rail .range input[type=range]");
      const b = await el.boundingBox();
      const png = await page.screenshot({ clip: { x: b.x, y: b.y, width: b.width, height: b.height } });
      return page.evaluate(async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        const d = x.getImageData(0, Math.floor(img.height / 2), img.width, 1).data;
        let line = -1, fill = -1;
        for (let i = 0; i < img.width; i++) {
          const [R, G, B] = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
          if (R > 200 && G < 120 && B < 90) line = i;
          if (R - B > 6) fill = i;
        }
        return { line, fill, w: img.width };
      }, png.toString("base64"));
    };
    const gaps = [];
    for (const v of [0, 5000, 15000, 25000, 40000, 49000, null]) {
      await page.goto(base + "#/catalog" + (v === null ? "" : `?max=${v}`), { waitUntil: "networkidle" });
      const g = await gap();
      gaps.push({ v: v ?? "любой", ...g, d: g.fill - g.line });
    }
    log.push("  - " + gaps.map((g) => `${g.v}: черта ${g.line}, заливка до ${g.fill}`).join(" · "));
    check(gaps.every((g) => g.line >= 0 && Math.abs(g.d) <= 1), "в 7 положениях от 0 до максимума разрыв не больше 1 px", gaps.map((g) => `${g.v}:${g.d}`).join(" "));
    check(gaps[0].line <= 1 && gaps[gaps.length - 1].line >= gaps[gaps.length - 1].w - 2, "  в нуле черта у левого края, в максимуме — у правого", `${gaps[0].line} · ${gaps[gaps.length - 1].line}/${gaps[gaps.length - 1].w}`);
    const rb = await page.locator(".rail .range input[type=range]").boundingBox();
    await page.mouse.move(rb.x + rb.width * 0.9, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width * 0.3, rb.y + rb.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const dragged = await gap();
    check(hash(page).includes("max=") && Math.abs(dragged.fill - dragged.line) <= 1, "перетаскивание мышью: значение в адресе, черта у края заливки", `${hash(page)} · черта ${dragged.line}, заливка ${dragged.fill}`);
    await ctx.close();
  }

  // ---------- колонка сузила выдачу: ничего не обрезается внутри карточек на широких экранах (T-541, ревью Дир 63) ----------
  {
    step("Переполнение внутри карточек на 1024 / 1280 / 1440: «кому первым», строки, плитки, шкалы");
    const bad = [];
    for (const w of [1024, 1280, 1440]) {
      const { ctx, page } = await newPage(w, 900);
      for (const h of ["#/results?cat=dairy", "#/results?cat=packaging", "#/results?cats=packaging,dairy&sub=cups,bags,mozzarella", "#/catalog", "#/find?q=молоко"]) {
        await page.goto(base + h, { waitUntil: "networkidle" });
        const over = await page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll(".gcard, .gcard .g-top, .gcard .who, .lcard, .lc-main, .lc-metrics, .snum, .fbar, .cp-trigger, .res-bar, .cats-go")) {
            if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className.split(" ")[0]} ${el.scrollWidth}/${el.clientWidth}`);
          }
          // балл в карточке «кому первым» целиком внутри карточки (обрезка «80/10» — под overflow, scrollWidth её не всегда видит)
          for (const c of document.querySelectorAll(".gcard")) {
            const s = c.querySelector(".g-score").getBoundingClientRect(), r = c.getBoundingClientRect();
            if (s.right > r.right - 8) out.push(`g-score за краем на ${Math.round(s.right - r.right + 8)} px`);
            const n = c.querySelector(".g-rank").getBoundingClientRect();
            if (Math.abs(n.width - n.height) > 1) out.push(`кружок места ${Math.round(n.width)}×${Math.round(n.height)}`);
          }
          return [...new Set(out)];
        });
        if (over.length) bad.push(`${w} ${h}: ${over.slice(0, 4).join("; ")}`);
      }
      await ctx.close();
    }
    check(bad.length === 0, "ни на одном из 15 экранов содержимое не вылезает за карточку, балл «кому первым» целиком, кружок места круглый", bad.join(" | "));
  }

  // ---------- страница поставщика: вкладки, разбор с весами и сравнением, логотипы, отзывы-примеры (T-543) ----------
  {
    const { ctx, page } = await newPage(1440, 900);
    const tabOn = async () => (await page.locator(".card-nav .nav-item.on .nav-l").allInnerTexts()).join("");
    const qp = (k) => new URLSearchParams(hash(page).split("?")[1] ?? "").get(k);
    const sup = (id) => DATA.suppliers.find((x) => x.id === id);
    const lvOf = (v, max = 100) => { const p = Math.round((v / max) * 100); return p <= 33 ? "low" : p <= 66 ? "mid" : "high"; };
    const norm = (x) => x.replace(/\s+/g, " ").trim();
    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

    step("Страница поставщика: меню разделов в колонке слева, раздел — в адресе, «назад» и «вперёд» ходят по разделам (T-543)");
    await page.goto(base + "#/s/rosspak?cat=packaging", { waitUntil: "networkidle" });
    const tabNames = await page.locator(".card-nav .nav-l").allInnerTexts();
    check(tabNames.join(" · ") === "Основное · Разбор · Условия · Документы · Ассортимент", "пять вкладок — вариант, выбранный Павлом на показе", tabNames.join(" · "));
    check(await tabOn() === "Основное" && await page.locator(".card-nav .nav-item.on").getAttribute("aria-current") === "page", "без параметра открыто «Основное»");
    const railBox = await page.evaluate(() => { const r = document.querySelector(".card-rail").getBoundingClientRect(), n = document.querySelector(".side-nav").getBoundingClientRect(), h = document.querySelector(".card-h2").getBoundingClientRect(); return [Math.round(r.left - n.right), Math.round(h.left - r.right), getComputedStyle(document.querySelector(".card-rail")).position, getComputedStyle(document.querySelector(".card-tabs")).display]; });
    check(railBox[0] === 0 && railBox[1] > 0 && railBox[2] === "sticky" && railBox[3] === "none", "меню разделов — колонкой сразу после основного меню, как колонка фильтров; полосы вкладок над разделом нет", railBox.join(" / "));
    const look = await page.evaluate(() => { const a = getComputedStyle(document.querySelector(".card-nav .nav-item")), b = getComputedStyle(document.querySelector(".side-nav .nav-item")); return [a.height, a.borderRadius, b.height, b.borderRadius]; });
    check(look[0] === look[2] && look[1] === look[3], "пункты разделов оформлены как основное меню: высота и скругление", look.join(" / "));
    const wdgs = await page.locator(".wdg").evaluateAll((ws) => ws.map((w) => `${w.tagName}:${w.querySelector(".wdg-h b").textContent}:${new URLSearchParams(w.getAttribute("href").split("?")[1]).get("tab")}`));
    check(wdgs.join(" ") === "A:Условия:terms A:Документы:docs A:Ассортимент:assortment", "на «Основном» три виджета, каждый целиком — ссылка на свою вкладку", wdgs.join(" "));
    check(await page.locator(".side .panel", { hasText: "Контакты" }).count() === 1 && await page.locator(".side .status").count() === 1, "на «Основном» справа плашки: компания, контакты");
    const colW = await page.evaluate(() => { const c = document.querySelector(".card-main .collected").getBoundingClientRect(), m = document.querySelector(".card-main").getBoundingClientRect(), s = document.querySelector(".side").getBoundingClientRect(); return [c.width, m.width, c.right, s.left]; });
    check(Math.abs(colW[0] - colW[1]) < 1 && colW[2] < colW[3], "строка «N из M полей найдено» — шириной левого столбца, правый не делит", colW.map(Math.round).join(" / "));
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(150);
    await page.locator(".wdg", { hasText: "Все условия" }).click();
    await page.waitForTimeout(250);
    const y1 = await page.evaluate(() => [Math.round(window.scrollY), Math.round(document.querySelector(".tabs-anchor").getBoundingClientRect().top), Math.round(document.querySelector(".card-rail").getBoundingClientRect().top)]);
    check(qp("tab") === "terms" && await tabOn() === "Условия", "клик по виджету «Условия» → раздел «Условия», ?tab=terms", hash(page));
    check(await page.locator(".side, .status, .rev-panel").count() === 0 && await page.locator(".card-body .fsec").evaluate((e) => e.getBoundingClientRect().width) > 700, "в разделе «Условия» плашек компании и контактов нет — раздел во всю ширину");
    check(y1[0] > 0 && Math.abs(y1[1]) <= 1 && y1[2] === 0, "страница не прыгает наверх: начало раздела у верхнего края, колонка с меню на месте", `scrollY ${y1[0]}, раздел на ${y1[1]} px, колонка на ${y1[2]} px`);
    check(await page.locator(".card-body .field .k", { hasText: "Минимальный заказ" }).count() === 1, "  в разделе — поля условий с цитатами");
    await page.locator(".card-nav .nav-item", { hasText: "Документы" }).click();
    await page.waitForTimeout(200);
    check(qp("tab") === "docs" && await page.locator(".card-body .field .k", { hasText: "Декларации" }).count() === 1, "раздел «Документы» — декларации", hash(page));
    await page.locator(".card-nav .nav-item", { hasText: "Ассортимент" }).click();
    await page.waitForTimeout(200);
    const nItems = await page.locator(".card-body .assort li").count();
    check(qp("tab") === "assortment" && nItems === sup("rosspak").assortment.value.items.length && await page.locator(".card-body .link-btn", { hasText: "показать все" }).count() === 0,
      `раздел «Ассортимент» — весь список сразу: ${nItems} позиций`);
    check(await page.locator(".card-body .in-subs-line").count() >= 1, "  над списком — «В подкатегориях» со ссылками");
    await page.goBack(); await page.waitForTimeout(250);
    const b1 = qp("tab");
    await page.goBack(); await page.waitForTimeout(250);
    const b2 = qp("tab");
    await page.goForward(); await page.waitForTimeout(250);
    const f1 = qp("tab");
    check(b1 === "docs" && b2 === "terms" && f1 === "docs" && await tabOn() === "Документы", "«назад» и «вперёд» ходят по разделам", `${b1} → ${b2} → ${f1}`);
    await page.goto(base + "#/s/rosspak?cat=packaging&tab=assortment", { waitUntil: "networkidle" });
    check(await tabOn() === "Ассортимент", "ссылка на раздел открывает его сразу");

    step("Разбор: «что важнее» в колонке слева пересчитывает балл и место компании на той же странице");
    await page.goto(base + "#/s/rosspak?cat=packaging", { waitUntil: "networkidle" });
    await page.locator(".score-panel a", { hasText: "разбор" }).click();
    await page.waitForTimeout(250);
    check(qp("tab") === "why" && await tabOn() === "Разбор" && await page.locator(".card-rail .prio-sw").count() === 1, "«Почему N — разбор →» в плашке открывает раздел «Разбор», в колонке появляется «что важнее»", hash(page));
    check(await page.locator(".side, .status").count() === 0, "в «Разборе» плашек компании и контактов нет");
    const read = () => page.evaluate(() => ({
      big: document.querySelector(".sp-big").firstChild.textContent, place: document.querySelector(".sp-place").innerText.replace(/\s+/g, " "),
      me: document.querySelector(".order.rk li.me .n").textContent, meScore: document.querySelector(".order.rk li.me .snum").textContent,
      cur: document.querySelector(".brk-c.cur.brk-total .snum").textContent, foot: document.querySelector(".sp-foot").innerText,
    }));
    const r0 = await read();
    const segRel = page.locator(".card-rail .prio-sw button", { hasText: "Надёжность" });
    const promised = (await segRel.locator(".ps-n").innerText()).match(/\d+/)[0];
    await segRel.click();
    await page.waitForTimeout(250);
    const r1 = await read();
    check(qp("prio") === "reliability" && hash(page).startsWith("#/s/rosspak") && await tabOn() === "Разбор", "веса — в адресе, остаёмся на той же странице и в том же разделе", hash(page));
    check(r0.place !== r1.place && r1.place.startsWith(`${promised}-й`) && r1.me === promised,
      `место в рейтинге категории пересчиталось: «${r0.place}» → «${r1.place}», строка «эта компания» — ${r1.me}-я, как обещала подпись в колонке`);
    check(r1.big === r1.meScore && r1.big === r1.cur && await page.locator(".sp-prio select").inputValue() === "reliability", `балл в плашке пересчитан (${r0.big} → ${r1.big}) и совпадает с разбором и строкой рейтинга; список «Веса» в плашке показывает тот же набор`);

    step("Веса — выпадающим списком в плашке балла на любом разделе; шапка — название слева, плашка сбоку (Павел, круг 3)");
    await page.goto(base + "#/s/rosspak?cat=packaging&tab=terms", { waitUntil: "networkidle" });
    const side = await page.evaluate(() => { const a = document.querySelector(".card-id").getBoundingClientRect(), b = document.querySelector(".score-panel").getBoundingClientRect(); return [Math.round(b.left - a.right), Math.round(Math.abs(a.top - b.top))]; });
    check(side[0] > 0 && side[1] < 10, "на 1440 плашка балла — сбоку от названия, на одной высоте", side.join(" / "));
    const placeBefore = norm(await page.locator(".sp-place").innerText());
    await page.locator(".sp-prio select").selectOption("reliability");
    await page.waitForTimeout(250);
    check(qp("prio") === "reliability" && qp("tab") === "terms" && norm(await page.locator(".sp-place").innerText()) !== placeBefore && await page.locator(".sp-prio select").inputValue() === "reliability",
      "в разделе «Условия» список «Веса» в плашке меняет набор: место пересчиталось, раздел тот же", `${placeBefore} → ${norm(await page.locator(".sp-place").innerText())}`);
    await page.locator(".card-nav .nav-item", { hasText: "Разбор" }).click();
    await page.waitForTimeout(250);
    check(await page.locator(".card-rail .prio-sw button.on").innerText().then((x) => x.includes("Надёжность")), "в колонке «Разбора» выбран тот же набор — переключатели согласованы");

    step("Разбор: строка компании закреплена, кнопка «Сравнить» в строке — сравнение в два столбца, имя — переход");
    check(await page.locator(".brk-grid.cmp").count() === 0 && await page.locator(".brk-h").count() === 1, "пока второй не выбран — один столбец, без заготовки под сравнение");
    const meVisible = () => page.locator(".order.rk li.me").evaluate((li) => { const r = li.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(li).position === "sticky"; });
    await page.goto(base + "#/s/uralkarton?cat=packaging&tab=why", { waitUntil: "networkidle" });
    const lowPlace = Number(await page.locator(".order.rk li.me .n").innerText());
    await page.locator(".order.rk").evaluate((ol) => ol.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(150);
    const pinBottom = await meVisible();
    await page.goto(base + "#/s/u2b-upakovka-dlya-biznesa?cat=packaging&tab=why", { waitUntil: "networkidle" });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(150);
    const pinTop = await meVisible();
    check(lowPlace > 15 && pinBottom && pinTop, `строка «эта компания» не уезжает: ${lowPlace}-я видна у нижнего края при начале списка, 1-я — у верхнего в конце прокрутки`);
    await page.goto(base + "#/s/rosspak?cat=packaging&tab=why", { waitUntil: "networkidle" });
    const other = page.locator(".order.rk li:not(.me)").nth(2);
    const otherName = (await other.locator(".nm a").innerText()).trim();
    await other.scrollIntoViewIfNeeded();
    const ob = await other.boundingBox();
    await page.mouse.click(ob.x + ob.width * 0.62, ob.y + ob.height / 2);      // по полосе вклада — мимо значка
    await page.waitForTimeout(200);
    check(!qp("vs") && await page.locator(".brk-grid.cmp").count() === 0 && norm(await other.locator(".rk-cmp").innerText()) === "Сравнить", "в строке — кнопка «Сравнить»; клик по строке мимо неё сравнение не включает");
    await other.locator(".rk-cmp").click();
    await page.waitForTimeout(700);
    const heads = await page.locator(".brk-h .brk-h-nm").allInnerTexts();
    check(qp("vs") === byName.get(otherName)?.id && await page.locator(".brk-grid.cmp").count() === 1 && hash(page).startsWith("#/s/rosspak"), `«Сравнить» у «${otherName}» — сравнение на той же странице, в адресе vs=`, hash(page));
    check(heads.length === 2 && heads[0].includes("РоссПак") && heads[1].includes(otherName), "верхние блоки в два столбца: эта компания и выбранная", heads.join(" | "));
    check(await page.locator(".brk-grid").evaluate((g) => { const r = g.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; }), "  разбор прокручен в зону видимости");
    check(await page.locator(".order.rk li.sel").count() === 1 && await other.locator(".rk-cmp").getAttribute("aria-pressed") === "true" && norm(await other.locator(".rk-cmp").innerText()) === "✓ Сравнение" && await page.locator(".brk-c.win").count() > 0, "  кнопка — «✓ Сравнение», строка подсвечена, у лучшей оценки в строке — «▲ выше»");
    await page.locator(".brk-x").click();
    await page.waitForTimeout(200);
    check(!qp("vs") && await page.locator(".brk-grid.cmp").count() === 0, "× закрывает сравнение", hash(page));
    await other.locator(".rk-cmp").click();
    await page.waitForTimeout(300);
    await other.locator(".rk-cmp").click();
    await page.waitForTimeout(300);
    check(!qp("vs"), "повторный клик по кнопке убирает компанию из сравнения", hash(page));
    const first = page.locator(".order.rk li:not(.me)").first();
    const firstName = (await first.locator(".nm a").innerText()).trim();
    await first.locator(".nm a").click();
    await page.waitForTimeout(300);
    check(hash(page).startsWith(`#/s/${byName.get(firstName)?.id}`) && qp("tab") === "why" && (await page.locator(".order.rk li.me .nm b").innerText()).trim() === firstName,
      `клик по имени «${firstName}» — его страница, сразу «Разбор», закреплён уже он`, hash(page));
    await page.goBack(); await page.waitForTimeout(250);
    check(hash(page).startsWith("#/s/rosspak"), "«назад» — к прежней компании", hash(page));
    await page.locator(".order.rk li:not(.me) .rk-go").first().click();
    await page.waitForTimeout(300);
    check(hash(page).startsWith(`#/s/${byName.get(firstName)?.id}`), "значок ↗ — тот же переход", hash(page));

    step("Старые ссылки #/why — во вкладку «Разбор» нужного поставщика; #/compare — как раньше");
    await page.goto(base + "#/why?cat=packaging&id=rosspak", { waitUntil: "networkidle" });
    await page.waitForTimeout(200);
    check(hash(page).startsWith("#/s/rosspak?") && qp("tab") === "why" && await page.locator(".brk").count() === 1, "#/why?…&id=rosspak → РоссПак, раздел «Разбор»", hash(page));
    await page.goto(base + "#/why?cat=packaging", { waitUntil: "networkidle" });
    await page.waitForTimeout(200);
    const leadRow = (await page.locator(".order.rk li").first().locator(".nm").innerText()).split("\n")[0].trim();
    check(qp("tab") === "why" && (await page.locator(".order.rk li.me .nm b").innerText()).trim() === leadRow, `#/why?cat=packaging → первый в рейтинге упаковки (${leadRow})`, hash(page));
    await page.goto(base + "#/why?ids=kraft-upakovka,po-karton,tara-dlya-tovara&cat=packaging", { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    check(qp("tab") === "why" && !!qp("vs") && await page.locator(".brk-grid.cmp").count() === 1, "#/why?ids=… (старая ссылка из сравнения) → лучший из сравниваемых, второй рядом", hash(page));
    await page.goto(base + "#/compare?ids=kraft-upakovka,po-karton,tara-dlya-tovara,parus-pak&cat=packaging", { waitUntil: "networkidle" });
    check(await page.locator(".cmp-grid .hd:not(.k):not(.add):not(.ex)").count() === 4 && await page.locator(".cmp-grid .best").count() > 0, "сравнение из шорт-листа: четыре столбца, ▲ лучший");
    const cmpFirst = (await page.locator(".cmp-grid .hd:not(.k) .hd-t b").first().innerText()).trim();
    await page.locator(".conclusion a", { hasText: "Почему такой порядок" }).click();
    await page.waitForTimeout(300);
    check(hash(page).startsWith(`#/s/${byName.get(cmpFirst)?.id}`) && qp("tab") === "why" && !!qp("vs"), `«Почему такой порядок» из сравнения → «Разбор» первого (${cmpFirst}), второй рядом`, hash(page));

    step("Цвет шкал по третям на странице поставщика: балл, подшкалы, полнота");
    for (const id of ["rosspak", "u2b-upakovka-dlya-biznesa"]) {
      await page.goto(base + `#/s/${id}?cat=packaging`, { waitUntil: "networkidle" });
      const sc = await page.evaluate(() => ({
        big: [document.querySelector(".sp-big").className, Number(document.querySelector(".sp-big").firstChild.textContent)],
        rules: [...document.querySelectorAll(".score-panel .rule")].map((r) => [r.className, Number(r.querySelector(".rule-top .num").textContent), r.querySelector(".rule-top span").textContent, getComputedStyle(r.querySelector(".rule-bar"), "::after").backgroundColor]),
        fill: [document.querySelector(".collected .fbar").className, document.querySelector(".collected .fbar-n").textContent],
      }));
      const bad = sc.rules.filter(([c, n]) => !c.includes(`lv-${lvOf(n)}`));
      const [ff, ft] = sc.fill[1].split("/").map(Number);
      check(sc.big[0].includes(`lv-${lvOf(sc.big[1])}`) && bad.length === 0 && sc.fill[0].includes(`lv-${lvOf(ff, ft)}`),
        `${id}: балл ${sc.big[1]}, шесть подшкал и полнота ${sc.fill[1]} — цветом своей трети`, bad.map((b) => b.slice(1, 3).join(" ")).join(", "));
      const rel = sc.rules.find((r) => r[2] === "Надёжность");
      if (rel[1] === 100) check(rel[3] === "rgb(98, 213, 146)", `${id}: надёжность 100 — зелёная, а не красная`, rel[3]);
    }

    step("Логотип на странице поставщика — свои цвета с первого кадра; белый — на тёмной плашке; нет логотипа — монограмма");
    await page.goto(base + "#/s/rosspak?cat=packaging", { waitUntil: "networkidle" });
    check(await page.locator(".card-id .ava img").evaluate((i) => getComputedStyle(i).filter) === "none", "шапка: логотип РоссПак без перекраски, без наведения");
    await page.goto(base + "#/s/anfish?cat=fish", { waitUntil: "networkidle" });
    check(await page.locator(".card-id .ava.dk").evaluate((a) => getComputedStyle(a).backgroundColor) === "rgb(42, 58, 84)", "белый логотип ANFISH — на тёмной плашке");
    await page.goto(base + "#/s/prod66?cat=fish", { waitUntil: "networkidle" });
    check(await page.locator(".card-id .mono").count() === 1 && await page.locator(".card-id .ava").count() === 0, "без логотипа — монограмма");
    await page.goto(base + "#/s/rosspak?cat=packaging&tab=why", { waitUntil: "networkidle" });
    const rkF = await page.locator(".order.rk .ava img").evaluateAll((is) => is.map((i) => getComputedStyle(i).filter));
    check(rkF.length > 20 && rkF.every((f) => f === "none"), `рейтинг во вкладке: ${rkF.length} логотипов в своих цветах`);
    await page.evaluate(() => { const it = { status: "Не связывались", note: "", note_at: null, added_at: "2026-10-15T10:00:00.000Z" }; localStorage.setItem("supplier-scout:v1", JSON.stringify({ shortlist: { rosspak: it, anfish: it }, compare: [], returned: [], collected: {}, last: null })); });
    await page.goto(base + "#/shortlist", { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });        // смена только # страницу не перезагружает — шорт-лист читается из localStorage при старте
    const slRow = page.locator(".sl-row", { has: page.locator(".ava:not(.dk) img") }).first();
    await page.mouse.move(5, 5);
    const sl0 = await slRow.locator(".ava img").evaluate((i) => getComputedStyle(i).filter);
    await slRow.hover({ position: { x: 300, y: 20 } });
    await page.waitForTimeout(250);
    const sl1 = await slRow.locator(".ava img").evaluate((i) => getComputedStyle(i).filter);
    check(await page.locator(".sl-row .ava").count() === 2 && sl0.includes("ava-navy") && sl1 === "none", "шорт-лист: логотипы синие, по наведению на строку — свои цвета", `${sl0} → ${sl1}`);
    await page.goto(base + "#/compare?ids=kraft-upakovka,po-karton,tara-dlya-tovara,parus-pak&cat=packaging", { waitUntil: "networkidle" });
    const hd = page.locator(".cmp-grid .hd", { has: page.locator(".ava img") }).first();
    await page.mouse.move(5, 5);
    const c0 = await hd.locator(".ava img").evaluate((i) => getComputedStyle(i).filter);
    await hd.hover();
    await page.waitForTimeout(250);
    const c1 = await hd.locator(".ava img").evaluate((i) => getComputedStyle(i).filter);
    check(c0.includes("ava-navy") && c1 === "none", "сравнение: логотипы в шапках столбцов синие, по наведению — свои цвета", `${c0} → ${c1}`);

    step("Отзывы: оценка и число — в шапке и в плашке; «N отзывов» открывает правую панель со своим скроллом, сортировкой и фильтром (Павел, круг 3)");
    const samples = { "u2b-upakovka-dlya-biznesa": [12, "4,4"], "td-gurman": [1, "5,0"], arosa: [1, "5,0"], "sen-soy": [1, "4,0"] };
    const got = [];
    for (const [id, [n, avg]] of Object.entries(samples)) {
      await page.goto(base + `#/s/${id}`, { waitUntil: "networkidle" });
      await page.locator(".rev-sum").waitFor();
      const head = norm(await page.locator(".card-rev .rbadge").innerText());
      const sum = norm(await page.locator(".rev-sum").innerText());
      const closed = await page.locator(".rev-drawer").count() === 0;
      await page.locator(".rev-sum").click();
      await page.locator(".rev-drawer").waitFor();
      const ex = await page.locator(".rev-drawer .rev-ex").evaluateAll((ls) => ls.map((l) => l.querySelector(".rev-ex-pill").textContent.includes("пример отзыва")));
      const ok = head.includes(avg) && head.includes(`${n} отзыв`) && sum.startsWith(avg) && sum.includes(`${n} отзыв`) && closed && ex.length === n && ex.every(Boolean);
      got.push(`${id}: «${head}», в плашке «${sum}», в панели ${ex.length}${ok ? "" : " ❌"}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    check(!got.some((g) => g.includes("❌")), "в шапке и в плашке — средняя и «N отзывов» с учётом примеров; по клику — панель с отзывами, у примеров плашка", got.join("; "));
    check(await page.locator(".rev-drawer").count() === 0, "  Esc закрывает панель");

    // длинный список: U2B, 12 отзывов — открываем из шапки на «Разборе», раздел не меняется
    await page.goto(base + "#/s/u2b-upakovka-dlya-biznesa?cat=packaging&tab=why", { waitUntil: "networkidle" });
    await page.locator(".card-rev .rbadge").click();
    await page.locator(".rev-drawer").waitFor();
    await page.waitForTimeout(400);                     // панель выезжает с анимацией
    const dr = await page.evaluate(() => {
      const d = document.querySelector(".rev-drawer").getBoundingClientRect(), l = document.querySelector(".rd-list"), b = document.querySelector(".rd-foot .btn").getBoundingClientRect();
      return { right: Math.round(innerWidth - d.right), h: Math.round(d.height), vh: innerHeight, own: l.scrollHeight > l.clientHeight + 20, body: getComputedStyle(document.body).overflow, btn: b.bottom <= innerHeight };
    });
    check(qp("tab") === "why" && dr.right === 0 && dr.h === dr.vh && dr.own && dr.body === "hidden" && dr.btn,
      "из шапки на «Разборе» — панель справа во всю высоту, у списка свой скролл, страница под ней не прокручивается, «Оставить отзыв» на экране", JSON.stringify(dr));
    const readList = () => page.locator(".rd-list li").evaluateAll((ls) => ls.map((l) => ({ r: l.querySelector(".rev-stars b").textContent.length, d: l.querySelector(".sub").textContent.split("·").pop().trim().split(".").reverse().join("-") })));
    const isSorted = (a, cmp) => a.every((x, i) => i === 0 || cmp(a[i - 1], x) <= 0);
    const lNew = await readList();
    await page.locator(".rd-sort select").selectOption("old");
    const lOld = await readList();
    await page.locator(".rd-sort select").selectOption("bad");
    const lBad = await readList();
    await page.locator(".rd-sort select").selectOption("good");
    const lGood = await readList();
    check(lNew.length === 12 && isSorted(lNew, (a, b) => b.d.localeCompare(a.d)) && isSorted(lOld, (a, b) => a.d.localeCompare(b.d)) && isSorted(lBad, (a, b) => a.r - b.r) && isSorted(lGood, (a, b) => b.r - a.r) && lBad[0].r === 3 && lGood[0].r === 5,
      "сортировка: по умолчанию сначала новые; старые, плохие, хорошие — в своём порядке", `новые ${lNew[0].d}…${lNew.at(-1).d}, плохие ${lBad.map((x) => x.r).join("")}`);
    await page.locator(".rd-h", { hasText: "3 ★" }).click();
    const l3 = await readList();
    const shownTxt = norm(await page.locator(".rd-shown").innerText());
    check(l3.length === 2 && l3.every((x) => x.r === 3) && shownTxt.includes("2 из 12") && await page.locator(".rd-h", { hasText: "3 ★" }).getAttribute("aria-pressed") === "true", "строка «3 ★» в распределении — фильтр: два отзыва на три звезды", shownTxt);
    await page.locator(".rd-tools .link-btn", { hasText: "показать все" }).click();
    check((await readList()).length === 12 && await page.locator(".rd-h:disabled").count() === 2, "«показать все» снимает фильтр; пустые оценки (2 и 1 ★) не нажимаются");
    await page.locator(".rd-x").click();
    await page.waitForTimeout(150);
    check(await page.locator(".rev-drawer").count() === 0 && await page.evaluate(() => getComputedStyle(document.body).overflow) !== "hidden", "× закрывает панель, прокрутка страницы возвращается");
    await page.locator(".card-rev .rbadge").click();
    await page.locator(".rev-scrim").click({ position: { x: 40, y: 400 } });
    await page.waitForTimeout(150);
    check(await page.locator(".rev-drawer").count() === 0, "клик мимо панели закрывает её");
    await page.goto(base + "#/s/rosspak?cat=packaging", { waitUntil: "networkidle" });
    await page.locator(".rev-sum-none, .panel .rev-own").first().waitFor();
    check(await page.locator(".rev-ex").count() === 0 && await page.locator(".card-rev").count() === 0 && (await page.locator(".rev-sum-none").innerText()).includes("пока нет"), "у остальных оценки в шапке нет, в плашке — «отзывов пока нет»");
    await page.goto(base + "#/catalog", { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const withRev = await page.locator(".lcard", { has: page.locator(".rbadge") }).evaluateAll((cs) => cs.map((c) => [c.querySelector("a.nm").textContent.trim(), c.querySelector(".rbadge").textContent.replace(/\s+/g, " ").trim()]));
    const expectRev = Object.keys(samples).map((id) => DATA.suppliers.find((x) => x.id === id).name.trim());
    check(sameSet(withRev.map((w) => w[0]), expectRev) && withRev.every((w) => /★\s?\d,\d/.test(w[1])), `«Все поставщики»: оценка по отзывам у тех, у кого есть отзывы — ${withRev.map((w) => `${w[0]} ${w[1]}`).join("; ")}`);
    await page.goto(base + "#/results?cat=packaging", { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const u2bName = DATA.suppliers.find((x) => x.id === "u2b-upakovka-dlya-biznesa").name.trim();
    check(await page.locator(".rows .lcard", { hasText: u2bName }).locator(".rbadge").count() === 1 && await page.locator(".first .gcard", { hasText: u2bName }).locator(".rbadge").count() === 1, "«Поиск по категории»: оценка в карточке списка и в «Кому написать первым»");
    await ctx.close();
  }

  // ---------- страница поставщика: ничего не вылезает за плашки на 1024 / 1280 / 1440 (T-543) ----------
  {
    step("Страница поставщика на 1024 / 1280 / 1440: колонка с меню, шапка, виджеты, разбор и сравнение не вылезают за свои блоки");
    const bad = [];
    for (const w of [1024, 1280, 1440]) {
      const { ctx, page } = await newPage(w, 900);
      for (const h of ["#/s/rosspak?cat=packaging", "#/s/u2b-upakovka-dlya-biznesa?cat=packaging&tab=why&vs=rosspak", "#/s/anfish?cat=dairy&sub=mozzarella&tab=why", "#/s/td-gurman?cat=dairy&tab=terms", "#/s/rosspak?cat=packaging&tab=assortment"]) {
        await page.goto(base + h, { waitUntil: "networkidle" });
        const over = await page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll(".card-rail, .card-nav .nav-item, .prio-sw button, .card-h2, .card-id .actions, .wdg, .wrow, .brk-grid, .brk-grid > *, .order.rk li, .score-panel, .sp-crits .rule, .collected, .lcard .lc-title")) {
            if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className.split(" ")[0]} ${el.scrollWidth}/${el.clientWidth}`);
          }
          const main = document.querySelector(".card-main")?.getBoundingClientRect(), side = document.querySelector(".side")?.getBoundingClientRect();
          if (main && side && side.top < main.bottom && main.right > side.left + 1 && side.left > main.left) out.push(`левый столбец заходит под правый на ${Math.round(main.right - side.left)} px`);
          return [...new Set(out)];
        });
        if (over.length) bad.push(`${w} ${h}: ${over.slice(0, 4).join("; ")}`);
      }
      await ctx.close();
    }
    check(bad.length === 0, "ни на одном из 15 экранов содержимое не вылезает за свой блок", bad.join(" | "));
  }

  // ---------- шорт-лист: чистый профиль ----------
  {
    const { ctx, page } = await newPage(1440, 900);
    step("Шорт-лист: чистый профиль → две звёздочки → «2» в меню и двое на странице");
    await page.goto(base + "#/categories", { waitUntil: "networkidle" });
    check(await navCount(page) === "нет", "при чистом профиле в меню нет счётчика");
    await page.locator(".cat-acc-h", { hasText: "Рыба" }).click();
    await page.locator(".cat-sub.all").click();
    await goSuppliers(page);
    await page.waitForTimeout(300);
    const stars = page.locator(".rows .lcard .star");
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
    check(await page.locator(".cats-go-btn").isVisible(), "на телефоне «Перейти к поставщикам» — плашкой снизу");
    await goSuppliers(page);
    check(hash(page) === "#/results?cat=packaging&sub=pizza-boxes" && (await activeNav(page)).join() === "Поиск по категории", "главная → категория → подкатегория кликами; подсвечен «Поиск по категории»", hash(page));
    await picker.sub(page, "Упаковка", "Пакеты");
    await picker.sub(page, "Упаковка", "Коробки для пиццы");
    await picker.done(page);
    const bags = await rowNames(page);
    check(hash(page).includes("sub=bags") && bags.every((x) => byName.get(x.trim())?.subcategories.includes("bags")), `смена подкатегории на месте: «Пакеты», ${bags.length}`);

    step("Телефон 390: фильтры свёрнуты в кнопку и открываются панелью — на трёх экранах (T-541)");
    for (const [name, h] of [["поиск по товару", "#/find?q=молоко"], ["категория", "#/results?cat=dairy"], ["все поставщики", "#/catalog"]]) {
      await page.goto(base + h, { waitUntil: "networkidle" });
      const hiddenBefore = await page.locator(".rail .filters").evaluate((e) => e.getBoundingClientRect().left >= window.innerWidth);
      await page.locator(".rail-open").click();
      await page.waitForTimeout(350);
      const shown = await page.locator(".filters.open").evaluate((e) => { const r = e.getBoundingClientRect(); return r.left < window.innerWidth && r.right <= window.innerWidth + 1; });
      await page.locator(".filters.open .chk", { hasText: "Доставка до точки" }).click();
      await page.locator(".filters.open .btn", { hasText: /^Показать/ }).click();
      await page.waitForTimeout(350);
      check(hiddenBefore && shown && await page.locator(".filters.open").count() === 0 && (await page.locator(".rail-open").innerText()).trim() === "Фильтры · 1",
        `${name}: фильтры за кнопкой, панель открывается и закрывается «Показать», на кнопке «Фильтры · 1»`);
    }

    step("Телефон 390: вкладки страницы поставщика прилипают под полосой меню, а не прячутся под неё (T-543)");
    await page.goto(base + "#/s/rosspak?cat=packaging&tab=why", { waitUntil: "networkidle" });
    await page.locator(".order.rk").evaluate((ol) => ol.scrollIntoView({ block: "end" }));     // конец рейтинга: 13-я строка ушла бы вверх
    await page.waitForTimeout(150);
    const stuck = await page.evaluate(() => {
      const t = document.querySelector(".card-tabs").getBoundingClientRect(), n = document.querySelector(".side-nav").getBoundingClientRect();
      const hit = document.elementFromPoint(40, t.top + t.height / 2);
      const me = document.querySelector(".order.rk li.me").getBoundingClientRect();
      return { ok: Math.abs(t.top - n.bottom) <= 1 && !!hit?.closest(".card-tabs") && me.top >= t.bottom - 1 && me.bottom <= innerHeight, why: `меню до ${Math.round(n.bottom)}, вкладки ${Math.round(t.top)}…${Math.round(t.bottom)}, строка компании ${Math.round(me.top)}…${Math.round(me.bottom)}` };
    });
    check(stuck.ok, "вкладки сразу под полосой меню и видны; закреплённая строка рейтинга — под ними", stuck.why);
    await page.locator(".card-tabs .nav-item", { hasText: "Условия" }).click();
    await page.waitForTimeout(250);
    const yTab = await page.evaluate(() => [Math.round(document.querySelector(".card-tabs").getBoundingClientRect().top), Math.round(document.querySelector(".side-nav").getBoundingClientRect().bottom), Math.round(window.scrollY)]);
    check(new URLSearchParams(hash(page).split("?")[1]).get("tab") === "terms" && Math.abs(yTab[0] - yTab[1]) <= 1 && yTab[2] > 0, "переключение вкладки на телефоне: начало вкладки под меню, наверх страница не прыгает", `вкладки ${yTab[0]}, меню до ${yTab[1]}, scrollY ${yTab[2]}`);

    step("Телефон 390: нет горизонтального скролла");
    const screens = ["#/", "#/find", "#/find?q=моцарелла", "#/find?q=молоко", "#/find?q=кофе", "#/find?q=малоко", "#/find?q=рыба для суши", "#/categories", "#/categories?open=packaging", "#/categories?open=fish", "#/categories?open=dairy", "#/categories?open=grocery", "#/results?cat=packaging", "#/results?cat=packaging&sub=pizza-boxes", "#/results?cat=fish", "#/results?cat=fish&sub=shrimp", "#/results?cat=packaging&sub=cups", "#/results?cat=dairy&sub=mozzarella", "#/results?cat=fish&sub=shrimp&view=table", "#/find?q=стаканчики", "#/find?q=тапиока", "#/s/anfish?cat=dairy&sub=mozzarella", "#/s/rosspak?cat=packaging", "#/s/rosspak?cat=packaging&tab=why", "#/s/rosspak?cat=packaging&tab=why&vs=u2b-upakovka-dlya-biznesa", "#/s/rosspak?cat=packaging&tab=terms", "#/s/rosspak?cat=packaging&tab=docs", "#/s/rosspak?cat=packaging&tab=assortment", "#/s/u2b-upakovka-dlya-biznesa?cat=packaging", "#/catalog?cats=packaging&sub=cups", "#/results?cat=dairy", "#/results?cat=grocery&view=table", "#/results?cat=packaging&view=table", "#/catalog", "#/compare?ids=kraft-upakovka,po-karton,tara-dlya-tovara,parus-pak&cat=packaging", "#/why?cat=fish", "#/s/ubplastik?cat=packaging", "#/compare", "#/why?cat=packaging", "#/shortlist", "#/add", "#/about-data", "#/assistant"];
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
  api.stop();
  const head = `# Навигация — сценарии кликами\n\nПрогон ${new Date().toISOString()}, \`web/dist\`, headless Chromium. Проверок с ошибкой: ${failed}.\n`;
  const out = process.argv[2] || path.join(ROOT, "e2e-out", "nav.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, head + log.join("\n") + "\n");
  console.log(`\nFAILED: ${failed} · протокол: ${out}`);
  process.exitCode = failed ? 1 : 0;
})();
