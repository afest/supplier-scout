// Навигация и раскладка (T-537): главная → четыре входа, каталог категорий → подкатегория на месте,
// поиск по товару, пустой ответ, шорт-лист и его счётчик, отсутствие горизонтального скролла на 390.
// T-541: колонка фильтров на трёх экранах, карточка-ссылка и звёздочка, цвет шкал по третям, ползунок по пикселям.
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
    check((await page.locator(".card-page > .crumb").innerText()).includes("Рыба и морепродукты"), "«назад» ведёт в рыбу, откуда пришли");
    check((await page.locator(".sp-place").innerText()).replace(/\s+/g, " ").includes("в подкатегории «Креветки»"), "место — в подкатегории «Креветки»", (await page.locator(".sp-place").innerText()).replace(/\s+/g, " "));
    check(await page.locator(".in-subs-line").count() >= 2, "в ассортименте — «В подкатегориях» по категориям, со ссылками");

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
    await page.goto(base + "#/s/morskoe-schaste", { waitUntil: "networkidle" });
    const sea = await value("Доставка");
    const seaQuote = await field("Доставка");
    check(sea.includes("бесплатно от 10 000 ₽") && !paid(sea) && seaQuote.includes("10 000руб. доставка бесплатно"),
      "«Морское счастье»: доставка бесплатно от 10 000 ₽, в цитате — строка с порогом", sea);
    await page.goto(base + "#/s/uralpaksistem", { waitUntil: "networkidle" });
    const ural = await value("Доставка");
    check(ural.includes("бесплатно от 1 000 шт") && !paid(ural), "Уралпаксистем: «бесплатно от 1 000 шт», а не «платно»", ural);
    await page.goto(base + "#/s/atlant-grupp", { waitUntil: "networkidle" });
    const atl = await value("Доставка");
    check(atl.includes("стоимость не указана") && !paid(atl), "Атлант: стоимость доставки не указана — не «платно»", atl);
    await page.goto(base + "#/s/redfish", { waitUntil: "networkidle" });
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
    await page.goto(base + "#/why?cat=fish&sub=shrimp", { waitUntil: "networkidle" });
    const verdict = await page.locator(".verdict").innerText();
    check(!verdict.includes("Атлант") && verdict.includes(first[0]), "«Почему такой порядок»: первым — тот же, что в тройке", verdict.slice(0, 80));

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

    step("Телефон 390: нет горизонтального скролла");
    const screens = ["#/", "#/find", "#/find?q=моцарелла", "#/find?q=молоко", "#/find?q=кофе", "#/find?q=малоко", "#/find?q=рыба для суши", "#/categories", "#/categories?open=packaging", "#/categories?open=fish", "#/categories?open=dairy", "#/categories?open=grocery", "#/results?cat=packaging", "#/results?cat=packaging&sub=pizza-boxes", "#/results?cat=fish", "#/results?cat=fish&sub=shrimp", "#/results?cat=packaging&sub=cups", "#/results?cat=dairy&sub=mozzarella", "#/results?cat=fish&sub=shrimp&view=table", "#/find?q=стаканчики", "#/find?q=тапиока", "#/s/anfish?cat=dairy&sub=mozzarella", "#/s/rosspak?cat=packaging", "#/catalog?cats=packaging&sub=cups", "#/results?cat=dairy", "#/results?cat=grocery&view=table", "#/results?cat=packaging&view=table", "#/catalog", "#/compare?ids=kraft-upakovka,po-karton,tara-dlya-tovara,parus-pak&cat=packaging", "#/why?cat=fish", "#/s/ubplastik?cat=packaging", "#/compare", "#/why?cat=packaging", "#/shortlist", "#/add", "#/about-data", "#/assistant"];
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
