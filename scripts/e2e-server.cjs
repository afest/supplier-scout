// Экраны с сервером (T-536): помощник, отзывы закупщиков, живой сбор — кликами в headless Chromium.
// Сервер — заглушка scripts/api-stub.py: тот же код api/, модель и конвейер подменены, денег и лимита стенда не тратит.
//
// Запуск:
//   VITE_API_URL=http://127.0.0.1:8765 npm --prefix web run build
//   NODE_PATH=<папка с node_modules/playwright> node scripts/e2e-server.cjs [файл-протокола]
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { serveDist } = require("./serve-dist.cjs");
const { startApiStub } = require("./api-stub.cjs");
const ROOT = path.resolve(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "suppliers.json"), "utf8"));
const ids = new Set(DATA.suppliers.map((s) => s.id));

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

(async () => {
  const { server, base } = await serveDist(path.join(ROOT, "web", "dist"));
  const api = await startApiStub();
  const browser = await chromium.launch({ headless: true });
  const errs = [];
  let expect422 = 0;                         // отказ сервера, который сценарий вызывает намеренно (повторный отзыв)
  const expected = [];
  const newPage = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(`${w}: ${e.message}`));
    page.on("request", (r) => { if (isAssist(r)) assistCalls++; });
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (expect422 && /status of 422/.test(m.text())) { expect422--; expected.push(m.text()); return; }
      errs.push(`${w}: ${m.text()}`);
    });
    return { ctx, page };
  };
  const noHScroll = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  let assistCalls = 0;                       // запросы к модели через /assist со всех страниц
  const isAssist = (r) => r.method() === "POST" && new URL(r.url()).pathname === "/assist";
  const sentTexts = (page) => { const out = []; page.on("request", (r) => isAssist(r) && out.push(JSON.parse(r.postData()).text)); return out; };
  // свой адрес клиента на сценарий: лимит адреса (5 в сутки) общий для всех страниц прогона, а запросов у сценариев больше
  const asAddress = (page, ip) => page.route("**/assist", (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }));
  const quotaLeft = async (page) => Number((/осталось (\d+)/.exec(await page.locator(".assist-quota").innerText()) || [])[1]);
  const needLabels = (page) => page.locator(".assist-need > span:first-child").allInnerTexts();

  try {
    // ---------- помощник ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      step("Помощник: описание → варианты → поставщики из набора");
      await page.goto(base + "#/", { waitUntil: "networkidle" });
      check(await page.locator(".ways .way", { hasText: "Помощник" }).locator(".way-soon").count() === 0, "на главной у «Помощника» нет пометки «скоро»");
      check(await page.locator(".side-nav .nav-item", { hasText: "Помощник" }).locator(".nav-soon").count() === 0, "в меню у «Помощника» нет пометки «скоро»");
      await page.goto(base + "#/find?q=" + encodeURIComponent("тапиока"), { waitUntil: "networkidle" });
      const emptyWays = (await page.locator(".find-empty .empty-ways a").allInnerTexts()).join(" | ");
      check(/Помощник/.test(emptyWays) && !/скоро/.test(emptyWays), "пустой поиск по товару: «Помощник» без пометки «скоро» (T-513)", emptyWays);
      await page.goto(base + "#/s/" + DATA.suppliers.find((s) => !s.live_only).id, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Обновить данные" }).click();
      const refresh = await page.locator("body").innerText();
      check(/Знаю поставщика/.test(refresh) && !/появится вместе с публикацией/.test(refresh), "«Обновить данные»: не обещает сервер, который уже работает (T-513)");
      await page.goto(base + "#/", { waitUntil: "networkidle" });
      await page.locator(".ways .way", { hasText: "Помощник" }).click();
      await page.waitForSelector(".assist-quota");
      check(hash(page) === "#/assistant", "плашка ведёт на #/assistant");
      check(/осталось 10 из 10/.test(await page.locator(".assist-quota").innerText()), "показан остаток лимита стенда", await page.locator(".assist-quota").innerText());
      await page.locator(".add-form input").fill("у меня бабл-ти в ТЦ");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".assist-need");
      const needs = await page.locator(".assist-need").allInnerTexts();
      check(needs.length === 6, "варианты-кнопки появились", needs.map((x) => x.replace(/\s+/g, " ")).join(" | "));
      const zero = await page.locator(".assist-need .assist-n.zero").count();
      const on = await page.locator(".assist-need.on").count();
      check(on === needs.length - zero && on > 0, "отмечены варианты, для которых в наборе есть поставщики", `отмечено ${on}, «нет» у ${zero}`);
      // остаток приходит отдельным запросом /health после ответа — ждём его, а не читаем строку в ту же миллисекунду
      await page.waitForFunction(() => /осталось 9 из 10/.test(document.querySelector(".assist-quota")?.textContent ?? ""), null, { timeout: 3000 }).catch(() => {});
      check(/осталось 9 из 10/.test(await page.locator(".assist-quota").innerText()), "лимит уменьшился на один запрос");
      await page.locator(".assist-need", { hasText: "Тапиока" }).click();
      await page.locator(".assist-step .btn.pr").click();
      await page.waitForSelector(".assist-res");
      const links = await page.locator(".assist-res a[href^='#/s/']").evaluateAll((as) => as.map((a) => a.getAttribute("href").replace("#/s/", "").split("?")[0]));
      check(links.length > 0 && links.every((x) => ids.has(x)), "все предложенные поставщики — из набора", `${links.length} ссылок`);
      const missing = await page.locator(".assist-res .panel.warn b").innerText().catch(() => "");
      check(/Тапиока/.test(missing), "чего нет в наборе — названо честно", missing);
      check(await page.locator(".assist-res .panel.warn a", { hasText: "Знаю поставщика" }).count() === 1, "рядом — переход к живому сбору");
      // чипы отмеченных позиций и порядок (Павел 15.10): тёмная — есть у поставщика, светлая — нет
      const panels = () => page.locator(".assist-res .panel:not(.warn)").evaluateAll((ps) => ps.map((p) => ({
        title: p.querySelector(".panel-h b").textContent.trim(),
        cards: [...p.querySelectorAll(".lcard.mini")].map((c) => ({ on: [...c.querySelectorAll(".mc-chip.on")].map((x) => x.textContent),
          all: c.querySelectorAll(".mc-chip").length, score: Number(c.querySelector(".snum")?.textContent ?? -1) })),
      })));
      let ps = await panels();
      const bestP = ps.find((x) => /несколько позиций/.test(x.title));
      const needP = ps.filter((x) => x !== bestP);
      check(needP.length > 1 && needP.every((x) => x.cards.every((c) => c.on.includes(x.title) && c.all === needP.length)),
        "в карточке — чипы всех отмеченных позиций, позиция своего блока тёмная у каждой", needP.map((x) => `${x.title} ${x.cards.length}`).join(", "));
      const counted = await page.locator(".assist-res .lcard.mini").evaluateAll((cs) => cs.map((c) => [c.querySelector(".mc-count")?.textContent, c.querySelectorAll(".mc-chip.on").length, c.querySelectorAll(".mc-chip").length]));
      check(counted.every(([t, n, all]) => t === `есть ${n} из ${all}`), "в мини-карточке — «есть N из M» по чипам", counted[0][0]);
      check(!!bestP && bestP.cards.length > 0 && bestP.cards.every((c) => c.on.length > 1), "«Закрывают несколько позиций сразу» — у каждой больше одной тёмной позиции",
        bestP && bestP.cards.map((c) => c.on.join("+")).join(" | "));
      const okCover = (a, c) => a.on.length > c.on.length || (a.on.length === c.on.length && a.score >= c.score);
      const okScore = (a, c) => a.score > c.score || (a.score === c.score && a.on.length >= c.on.length);
      const inOrder = (list, ok) => list.every((x) => x.cards.every((c, i) => i === 0 || ok(x.cards[i - 1], c)));
      check(inOrder(ps, okCover), "по умолчанию — сначала больше позиций, при равенстве — выше рейтинг",
        needP[0].cards.map((c) => `${c.on.length}/${c.score}`).join(" "));
      await page.locator(".assist-sort .pill-out", { hasText: "выше рейтинг" }).click();
      ps = await panels();
      check(inOrder(ps, okScore) && JSON.stringify(ps) !== "[]", "«выше рейтинг» — сначала рейтинг, при равенстве — больше позиций",
        ps.find((x) => !/несколько/.test(x.title)).cards.map((c) => `${c.score}/${c.on.length}`).join(" "));
      await page.locator(".assist-sort .pill-out", { hasText: "больше позиций" }).click();
      await page.locator(".assist-sort .pill-out.on").hover();
      const hov = await page.locator(".assist-sort .pill-out.on").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
      check(hov[0] === "rgb(58, 59, 68)" && hov[1] === "rgb(255, 255, 255)", "выбранный порядок при наведении остаётся тёмным, текст белый", hov.join(" / "));
      // мини-карточки (T-544): аватар, название, балл цветом трети, карточка целиком — ссылка
      const nMini = await page.locator(".assist-res .lcard.mini").count();
      const scored = await page.locator(".assist-res .lcard.mini .snum[class*='lv-']").count();
      const excluded = await page.locator(".assist-res .lcard.mini .ex-tag").count();
      check(nMini > 0 && nMini === links.length && scored + excluded === nMini, "подбор — мини-карточками, у каждой балл цветом трети", `${nMini} карточек, с баллом ${scored}, исключено ${excluded}`);
      check(await page.locator(".assist-res .lcard.mini :is(.ava, .mono)").count() === nMini, "у каждой мини-карточки — аватар");
      const [tab] = await Promise.all([ctx.waitForEvent("page"), page.locator(".assist-res .lcard.mini a.nm").nth(1).click({ modifiers: ["Control"] })]);
      await tab.waitForURL(/#\/s\//);                 // вкладка открывается с about:blank
      const tabHash = decodeURIComponent(new URL(tab.url()).hash);
      check(tabHash.startsWith("#/s/") && hash(page) === "#/assistant", "Ctrl+клик открывает поставщика в новой вкладке, подбор остаётся", tabHash);
      await tab.close();
      // карточка → назад → подбор на месте, без повторного вызова модели
      const target = page.locator(".assist-res .lcard.mini a.nm").nth(6);
      await target.scrollIntoViewIfNeeded();
      const snap = async () => ({ y: await page.evaluate(() => Math.round(window.scrollY)), n: await page.locator(".assist-res .lcard.mini").count(),
        on: (await page.locator(".assist-need.on").allInnerTexts()).join("|"), text: await page.locator(".add-form input").inputValue() });
      const was = await snap();
      const callsWas = assistCalls;
      await target.click();
      await page.waitForFunction(() => location.hash.startsWith("#/s/"));
      check(true, "клик по мини-карточке открывает поставщика", hash(page));
      await page.goBack();
      await page.waitForSelector(".assist-res .lcard.mini");
      await page.waitForTimeout(400);
      const now = await snap();
      check(now.n === was.n && now.on === was.on && now.text === was.text, "«назад» с карточки: описание, отмеченные варианты и подбор на месте", `${now.n} карточек, отмечено ${now.on}`);
      check(was.y > 300 && Math.abs(now.y - was.y) <= 4, "«назад» с карточки: то же место прокрутки", `${was.y} → ${now.y}`);
      check(assistCalls === callsWas && /осталось 9 из 10/.test(await page.locator(".assist-quota").innerText()), "«назад» модель не вызывает, лимит тот же");
      // примеры: после «Подсказать» не нужны, стёр описание — вернулись
      check(await page.locator(".examples").count() === 0, "после «Подсказать» строки «Примеры» нет");
      await page.locator(".add-form input").fill("");
      check(await page.locator(".examples").count() === 1, "стёр описание — примеры снова видны");
      await page.locator(".examples .pill-out", { hasText: "у меня бабл-ти в ТЦ" }).click();
      await page.waitForSelector(".assist-need");
      check(/осталось 9 из 10/.test(await page.locator(".assist-quota").innerText()), "повтор того же описания лимит не тратит");
      await ctx.close();
    }

    // ---------- план закупа (T-546) ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      step("План закупа: пример → что прочитано → итог «у кого брать» → кто что закрывает (T-546)");
      // свой адрес клиента: лимит адреса общий с «Описать словами»
      await page.route("**/assist/plan", (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": "198.51.100.41" } }));
      const planBodies = [];
      page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/assist/plan") planBodies.push(JSON.parse(r.postData())); });
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      await page.locator(".assist-modes .seg button", { hasText: "Загрузить план закупа" }).click();
      await page.waitForSelector(".plan-drop");
      check(hash(page) === "#/assistant?mode=plan", "второй способ рядом с «Описать словами» — свой адрес", hash(page));
      check(/на сервер уходят только названия/.test(await page.locator(".plan-drop").innerText()), "у загрузки сказано, что файл на сервер не уходит");
      const exHref = await page.locator(".examples a[download]").getAttribute("href");
      const exFile = await page.request.get(new URL(exHref, base + "x").href);
      check(exFile.ok() && (await exFile.body()).length > 1000, "пример скачивается файлом", exHref);
      await page.locator(".examples .pill-out", { hasText: "суши-бар" }).click();
      await page.waitForSelector(".plan-read");
      const readText = (await page.locator(".plan-read").innerText()).replace(/\s+/g, " ");
      check(/20 позиций/.test(readText) && /лист «План закупа»/.test(readText), "пример прочитан: 20 позиций, лист назван", readText.slice(0, 120));
      check(await page.locator(".plan-col select").inputValue() === "1" && await page.locator(".plan-col select option:checked").innerText() === "Наименование",
        "колонка названий определена по шапке, её можно сменить", await page.locator(".plan-col select option:checked").innerText());
      check(/шапка — 3 строки/.test(readText) && /итоги — 1/.test(readText) && /пустые — 1/.test(readText), "отброшены шапка, итог и пустая строка — и это видно",
        (/Отброшено:[^.]*/.exec(readText) || [""])[0]);
      check(await page.locator(".plan-lines li").count() === 8 && /Показать все · 20/.test(readText), "строки плана — первые 8, остальные по кнопке");
      await page.locator(".plan-read .assist-more").click();
      const lines = (await page.locator(".plan-lines li").allInnerTexts()).map((x) => x.replace(/^\d+\s*/, ""));
      check(lines.length === 20 && lines.includes("Имбирь маринованный розовый 1,4 кг"), "«Показать все» — 20 строк, «1,4 кг» целиком");
      await page.waitForSelector(".plan-go .assist-quota");
      const standLeft = async () => (await (await fetch(`${api.url}/health`)).json()).demo_left.assist.left;
      const q0 = await standLeft();
      check(await quotaLeft(page) === q0, "у кнопки — остаток лимита стенда", `${q0}`);
      await page.locator(".plan-go .btn.pr").click();
      await page.waitForSelector(".plan-verdict .plan-pick");
      check(planBodies.length === 1 && JSON.stringify(Object.keys(planBodies[0])) === '["lines"]' && planBodies[0].lines.length === 20
        && !planBodies[0].lines.some((x) => /^\d+$|итого/i.test(x)), "на сервер ушли только 20 названий — без количеств, единиц и итога");
      const seen = await (await fetch(`${api.url}/_stub/seen`)).json();
      check(JSON.stringify(seen.plans.at(-1)) === JSON.stringify(lines), "до модели дошли те же строки, что показаны на экране");
      const verdictText = (await page.locator(".plan-verdict-text").innerText()).replace(/\s+/g, " ");
      const picks = await page.locator(".plan-pick").evaluateAll((as) => as.map((a) => ({
        id: a.getAttribute("href").replace("#/s/", ""), takes: [...a.querySelectorAll(".mc-chip.on")].map((x) => x.textContent),
        role: a.querySelector(".plan-role").textContent, why: a.querySelector(".plan-why").textContent })));
      check(picks.length >= 1 && picks.length <= 3 && picks.every((p) => ids.has(p.id)), "итог — от одного до трёх поставщиков, все из набора", picks.map((p) => `${p.id}: ${p.role}`).join(" · "));
      const covered = Number((/закрывают (\d+) из 20/.exec(verdictText) || [])[1]);
      check(/Одной компании, которая поставляет всё, в наборе нет/.test(verdictText) && covered === picks.reduce((n, p) => n + p.takes.length, 0),
        "текст итога: «одной компании нет», лучшая комбинация, «закрывают K из 20» — K совпадает с позициями в карточках", verdictText);
      check(picks.every((p) => p.takes.length > 0 && p.role && verdictText.includes(p.role)), "у каждого — свои позиции и роль, роль названа в тексте итога");
      check(picks.every((p) => /мин\. заказ|минимального/.test(p.why) && /доставка/.test(p.why)), "у каждого — минимальный заказ и доставка");
      check(!/эконом|сэконом|дешевле/i.test(await page.locator(".plan-res").innerText()), "слов про экономию нет");
      const gaps = (await page.locator(".plan-gaps").innerText()).replace(/\s+/g, " ");
      check(/Вне набора: Огурцы свежие, Авокадо/.test(gaps) && /четырём/.test(gaps), "что не закрыл никто — отдельной строкой, «вне набора»", gaps.slice(0, 140));
      const groups = await page.locator(".plan-group").evaluateAll((ps) => ps.map((p) => ({
        title: p.querySelector(".panel-h b").textContent.trim(),
        cards: [...p.querySelectorAll(".lcard.mini")].map((c) => ({ all: c.querySelectorAll(".mc-chip").length, on: c.querySelectorAll(".mc-chip.on").length,
          pick: !!c.querySelector(".fresh-pill") })),
      })));
      check(["Упаковка", "Рыба", "Сыр", "Рис"].every((t) => groups.some((g) => g.title.startsWith(t))), "покрытие — по группам набора", groups.map((g) => `${g.title} ${g.cards.length}`).join(" · "));
      check(groups.every((g) => g.cards.every((c) => c.on >= 1 && c.all === g.cards[0].all)), "в каждой группе у карточки — чипы позиций группы, хоть одна тёмная");
      check(groups.flatMap((g) => g.cards).filter((c) => c.pick).length >= picks.length, "выбранные в итог помечены «в итоге»");
      check(groups.every((g) => g.cards.length <= 6), "в группе — не больше 6 карточек, остальные по кнопке");
      await page.locator(".plan-parse summary").click();
      check(await page.locator(".plan-parse li").count() === 20, "«Как помощник прочитал строки» — 20 строк");
      check(await standLeft() === q0 - 1, "разбор плана — один запрос из дневного лимита помощника", `${q0} → ${await standLeft()}`);
      const callsBefore = planBodies.length;
      // карточка итога → назад → итог на месте, модель не вызвана
      await page.locator(".plan-pick").first().click();
      await page.waitForFunction(() => location.hash.startsWith("#/s/"));
      await page.goBack();
      await page.waitForSelector(".plan-verdict .plan-pick");
      check(hash(page) === "#/assistant?mode=plan" && (await page.locator(".plan-verdict-text").innerText()).replace(/\s+/g, " ") === verdictText,
        "«назад» с поставщика: тот же способ, итог и таблица на месте");
      check(planBodies.length === callsBefore, "«назад» модель не вызывает");
      // тот же файл через выбор файла — ответ из кэша, лимит не тратится
      await page.locator(".plan-clear").click();
      check(await page.locator(".plan-read, .plan-res").count() === 0, "«Очистить» убирает прочитанное и итог");
      await page.setInputFiles(".plan-drop input[type=file]", path.join(ROOT, "web", "public", "plan-sushi-bar.xlsx"));
      await page.waitForSelector(".plan-read");
      check(/файл «plan-sushi-bar\.xlsx»/.test(await page.locator(".plan-read").innerText()), "файл загружается кнопкой выбора");
      await page.locator(".plan-go .btn.pr").click();
      await page.waitForSelector(".plan-verdict .plan-pick");
      check(await standLeft() === q0 - 1, "повтор того же плана — из кэша, лимит не тратится", `${q0} → ${await standLeft()}`);
      // CSV из русского Excel — в Windows-1251, с «;» и «3,2%»
      const tmp = path.join(ROOT, "e2e-out", "plan-1251.csv");
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      const cp1251 = (s) => Buffer.from([...s].map((ch) => { const c = ch.codePointAt(0); return c < 128 ? c : c >= 0x410 && c <= 0x44f ? c - 0x350 : ch === "ё" ? 0xb8 : 0xa8; }));
      fs.writeFileSync(tmp, cp1251("Наименование;Кол-во\r\nМолоко 3,2% Простоквашино 1л;20\r\nСливки 33%, 1 л;4\r\n\r\nИтого;24\r\n"));
      await page.setInputFiles(".plan-drop input[type=file]", tmp);
      await page.waitForFunction(() => /2 позиции/.test(document.querySelector(".plan-read")?.textContent ?? ""));
      const csvLines = await page.locator(".plan-lines li").allInnerTexts();
      check(csvLines.map((x) => x.replace(/^\d+\s*/, "")).join("|") === "Молоко 3,2% Простоквашино 1л|Сливки 33%, 1 л" && await page.locator(".plan-res").count() === 0,
        "CSV в Windows-1251: кириллица и «3,2%» целы, старый итог скрыт", csvLines.join(" | "));
      // вставка колонкой: запятая — часть названия; две колонки без шапки — выбор колонки
      await page.locator(".plan-paste").fill("Стакан 0,5 л, белый\nКрышка купольная\n");
      await page.waitForFunction(() => /2 позиции/.test(document.querySelector(".plan-read")?.textContent ?? ""));
      check(/из вставленного текста/.test(await page.locator(".plan-read").innerText()) && (await page.locator(".plan-lines li").first().innerText()).includes("Стакан 0,5 л, белый"),
        "вставка: строка — одна позиция, запятая её не делит");
      await page.locator(".plan-paste").fill("101\tРис для суши\n102\tНори Gold\n");
      await page.waitForSelector(".plan-col select");
      check(await page.locator(".plan-col select").inputValue() === "1", "две колонки без шапки — названия угаданы, колонку можно выбрать");
      await page.locator(".plan-col select").selectOption("0");
      check(/Строк с названием товара не нашлось/.test(await page.locator(".plan-read").innerText()), "выбрал колонку с кодами — честно: строк нет");
      // переполнение внутри карточек итога и таблицы — на трёх ширинах (правило: сузил зону — смотри внутрь карточек)
      await page.locator(".plan-clear").click();
      await page.locator(".examples .pill-out", { hasText: "суши-бар" }).click();
      await page.locator(".plan-go .btn.pr").click();                                     // тот же план — из кэша
      await page.waitForSelector(".plan-verdict .plan-pick");
      await page.locator(".plan-parse summary").click();
      for (const w of [1024, 1280, 1440]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(150);
        const over = await page.locator(".plan-pick, .plan-pick *, .plan-group .lcard.mini, .plan-group .lcard.mini *, .plan-parse li, .plan-parse li *, .plan-read, .plan-read *, .plan-gaps")
          .evaluateAll((els) => els.filter((el) => {
            if (el.tagName === "OPTION" || getComputedStyle(el).textOverflow === "ellipsis") return false;   // цена с сайта — многоточием намеренно
            const box = el.closest(".plan-pick, .lcard, .plan-parse li, .plan-read, .plan-gaps").getBoundingClientRect();
            const r = el.getBoundingClientRect();
            if (!r.width && !r.height) return false;                                          // <title> в значках — без размера
            return el.scrollWidth > el.clientWidth + 1 || r.right > box.right + 1 || r.left < box.left - 1;
          }).map((el) => el.getAttribute("class") || el.tagName));
        check(over.length === 0 && await noHScroll(page), `${w}: внутри карточек итога, таблицы и разбора строк ничего не вылезает`, over.slice(0, 4).join(", "));
        if (w === 1440) await page.screenshot({ path: path.join(ROOT, "e2e-out", "plan-1440.png"), fullPage: true });
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await newPage(390, 844);
      step("План закупа на телефоне 390");
      await page.goto(base + "#/assistant?mode=plan", { waitUntil: "networkidle" });
      check(await noHScroll(page), "загрузка плана без горизонтального скролла");
      await page.locator(".examples .pill-out", { hasText: "суши-бар" }).click();
      await page.waitForSelector(".plan-read");
      await page.locator(".plan-go .btn.pr").click();       // тот же план — ответ из кэша, лимит не тратится
      await page.waitForSelector(".plan-verdict .plan-pick");
      await page.locator(".plan-parse summary").click();
      check(await noHScroll(page), "итог, таблица и разбор строк на 390 без горизонтального скролла");
      const over = await page.locator(".plan-pick, .plan-group .lcard.mini, .plan-parse li").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
      check(over === 0, "карточки итога и таблицы на 390 без переполнения внутри", `${over}`);
      await page.screenshot({ path: path.join(ROOT, "e2e-out", "plan-390.png"), fullPage: true });
      await ctx.close();
    }

    // ---------- выбранные позиции → страница поставщика → черновик (Павел 15.10, T-546) ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      step("Выбранные позиции: клик по карточке с чипами → «Вы выбрали» у поставщика → черновик запроса (T-546)");
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const wantedNow = async () => (await page.locator(".wanted-chip").allInnerTexts()).map((x) => x.replace(/×\s*$/, "").trim());
      const darkOf = (card) => card.locator(".mc-chip.on").allInnerTexts();
      // план закупа: карточка итога
      await page.goto(base + "#/assistant?mode=plan", { waitUntil: "networkidle" });
      await page.locator(".examples .pill-out", { hasText: "суши-бар" }).click();
      await page.locator(".plan-go .btn.pr").click();                                     // тот же план — из кэша
      await page.waitForSelector(".plan-verdict .plan-pick");
      const pick = page.locator(".plan-pick").first();
      const takes = await darkOf(pick);
      const pid = (await pick.getAttribute("href")).replace("#/s/", "");
      await pick.click();
      await page.waitForSelector(".wanted");
      check(same(await wantedNow(), takes) && /Вы выбрали · \d+/i.test(await page.locator(".wanted .label").innerText()),
        "план: позиции карточки итога — в «Вы выбрали» на странице поставщика", takes.join(", "));
      await page.locator(".card-tabs .nav-item, .card-nav .nav-item").filter({ hasText: "Условия" }).first().click();
      check(await page.locator(".wanted").count() === 1, "блок виден и в другом разделе страницы");
      await page.locator(".wanted-chip", { hasText: takes[0] }).locator("button").click();
      check(same(await wantedNow(), takes.slice(1)), "крестик убирает одну позицию, остальные на месте", takes[0]);
      await page.locator(".wanted-go").click();
      await page.waitForSelector(".draft-text");
      const draft = await page.locator(".draft-text").inputValue();
      const items = (draft.split("Интересуют позиции:")[1] || "").split("Пришлите")[0].split("\n").filter((l) => l.startsWith("— "));
      check(items.length === takes.length - 1 && draft.includes("Нори Gold 50 листов, 140 г") && !draft.includes("«Японика»"),
        "черновик: позиции уже вписаны строками плана — с брендом и фасовкой, убранной нет", items.slice(0, 2).join(" "));
      check(/Пришлите, пожалуйста, цены и фасовку/.test(draft) && /И подскажите ещё:/.test(draft), "черновик: просьба о ценах и фасовке, дальше — обычные вопросы");
      await page.goto(base + "#/s/" + pid, { waitUntil: "networkidle" });
      check(await page.locator(".wanted-chip").count() === takes.length - 1, "позиции хранятся: снова на странице поставщика — блок на месте");
      await page.locator(".wanted-close").click();
      await page.reload({ waitUntil: "networkidle" });
      check(await page.locator(".wanted").count() === 0, "«Закрыть» убирает блок, после перезагрузки его нет");
      // план закупа: карточка группы — к уже выбранному, без повторов
      await page.goto(base + "#/assistant?mode=plan", { waitUntil: "networkidle" });
      await page.waitForSelector(".plan-group .lcard.mini");
      const g1 = page.locator(".plan-group").first().locator(".lcard.mini").first();
      const g1dark = await darkOf(g1);
      const g1id = (await g1.locator("a.nm").getAttribute("href")).replace("#/s/", "");
      await g1.locator("a.nm").click();
      await page.waitForSelector(".wanted");
      check(same(await wantedNow(), g1dark), "план: карточка группы — её тёмные позиции", g1dark.join(", "));
      await page.goBack();
      await page.waitForSelector(".plan-group .lcard.mini");
      await page.locator(".plan-group").first().locator(".lcard.mini").first().locator("a.nm").click();
      await page.waitForSelector(".wanted");
      check(same(await wantedNow(), g1dark), "второй клик по той же карточке позиции не дублирует", g1id);
      // помощник «Описать словами»: мини-карточка в «Закрывают несколько позиций сразу»
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      await page.locator(".add-form input").fill("у меня бабл-ти в ТЦ");                  // то же описание — из кэша
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".assist-need");
      await page.locator(".assist-step .btn.pr").click();
      await page.waitForSelector(".assist-res .lcard.mini");
      const m1 = page.locator(".assist-res .panel", { hasText: "несколько позиций" }).locator(".lcard.mini").first();
      const m1dark = await darkOf(m1);
      await m1.locator("a.nm").click();
      await page.waitForSelector(".wanted");
      check(m1dark.length > 1 && same(await wantedNow(), m1dark), "помощник: отмеченные позиции мини-карточки — у поставщика", m1dark.join(", "));
      // поиск по нескольким товарам
      await page.goto(base + "#/find?q=" + encodeURIComponent("молоко, сыр сливочный"), { waitUntil: "networkidle" });
      const f1 = page.locator(".lcard", { has: page.locator(".mc-chip.on") }).first();
      const f1dark = await darkOf(f1);
      await f1.locator("a.nm").click();
      await page.waitForSelector(".wanted");
      check(f1dark.length >= 1 && (await wantedNow()).slice(-f1dark.length).join("|") === f1dark.join("|"), "поиск по нескольким товарам: найденные товары — у поставщика", f1dark.join(", "));
      // категория с несколькими подкатегориями: «Кому написать первым»
      await page.goto(base + "#/results?cat=packaging&sub=cups,straws", { waitUntil: "networkidle" });
      const c1 = page.locator(".first .gcard").first();
      const c1dark = await darkOf(c1);
      await c1.click();
      await page.waitForSelector(".wanted");
      check(c1dark.length >= 1 && (await wantedNow()).slice(-c1dark.length).join("|") === c1dark.join("|"), "категория: отмеченные подкатегории из «Кому написать первым» — у поставщика", c1dark.join(", "));
      check(await noHScroll(page), "страница поставщика с блоком без горизонтального скролла");
      await page.screenshot({ path: path.join(ROOT, "e2e-out", "want-1440.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      const over = await page.locator(".wanted, .wanted *").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
      check(await noHScroll(page) && over === 0, "390: блок «Вы выбрали» без переполнения и горизонтального скролла", `${over}`);
      await ctx.close();
    }

    // ---------- уточняющий вопрос (T-544) ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      await asAddress(page, "198.51.100.21");
      const sent = sentTexts(page);
      step("Помощник: уточняющий вопрос → кнопка ответа → новые варианты (T-544)");
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      await page.waitForSelector(".assist-quota");
      const q0 = await quotaLeft(page);
      await page.locator(".add-form input").fill("пончики на фудкорте");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".assist-clar");
      const answers = await page.locator(".assist-answers button").allInnerTexts();
      check(answers.join("|") === "Жарим на месте|Привозим готовыми", "под вопросом — кнопки ответов; длиннее 30 знаков и повтор сервер отбросил", answers.join(" | "));
      check(await page.locator(".assist-own input[maxlength='80']").count() === 1, "и поле «Свой ответ» до 80 знаков");
      check(/жарите на месте/.test(await page.locator(".assist-clar-q").innerText()), "вопрос модели виден над кнопками");
      const needs0 = await needLabels(page);
      await page.locator(".assist-answers button", { hasText: "Жарим на месте" }).click();
      await page.waitForSelector(".assist-noted");
      const needs1 = await needLabels(page);
      check(needs1.includes("Масло фритюрное") && !needs0.includes("Масло фритюрное"), "ответ кнопкой — варианты обновились", needs1.join(", "));
      check(sent.at(-1) === "пончики на фудкорте. Уточнение: Пончики жарите на месте или привозите готовыми? — Жарим на месте. Уточнение уже получено, вопросов больше не задавай.",
        "в запросе — описание, вопрос и ответ одним текстом", sent.at(-1));
      check(await page.locator(".add-form input").inputValue() === "пончики на фудкорте", "исходное описание в поле не изменилось");
      const noted = await page.locator(".assist-noted").innerText();
      check(/Учтено/i.test(noted) && /Жарим на месте/.test(noted) && /Изменить/.test(noted), "над списком — «Учтено: …» и «Изменить»", noted.replace(/\s+/g, " "));
      check(await page.locator(".assist-clar").count() === 0 && await page.locator(".assist-q").count() === 0, "после ответа второго вопроса нет");
      check(await quotaLeft(page) === q0 - 2, "ответ на уточнение — обычный запрос: счётчик стенда минус один", `${q0} → ${await quotaLeft(page)}`);
      await page.locator(".assist-noted .link-btn", { hasText: "Изменить" }).click();
      check(await page.locator(".assist-answers button[aria-pressed=true]").innerText() === "Жарим на месте", "«Изменить» возвращает к вопросу, выбранный ответ отмечен");
      await page.locator(".assist-answers button", { hasText: "Жарим на месте" }).click();
      check(await page.locator(".assist-noted").count() === 1 && sent.length === 2, "тот же ответ — вопрос закрылся без запроса");
      await page.locator(".assist-noted .link-btn", { hasText: "Изменить" }).click();
      await page.locator(".assist-answers button", { hasText: "Привозим готовыми" }).click();
      await page.waitForFunction(() => /Привозим готовыми/.test(document.querySelector(".assist-noted")?.textContent || ""));
      check(!(await needLabels(page)).includes("Масло фритюрное"), "другой ответ — другие варианты", (await needLabels(page)).join(", "));
      await page.locator(".assist-noted .link-btn", { hasText: "Изменить" }).click();
      await page.locator(".assist-own input").fill("Ещё не решили");
      await page.locator(".assist-own button[type=submit]").click();
      await page.waitForFunction(() => /Ещё не решили/.test(document.querySelector(".assist-noted")?.textContent || ""));
      check(await page.locator(".assist-q").innerText() === "А кофе тоже будет?" && await page.locator(".assist-clar, .assist-answers").count() === 0,
        "свой ответ принят; модель спросила ещё раз — вопрос текстом, без кнопок (раунд один)");
      await page.locator(".assist-step .btn.pr").click();
      await page.waitForSelector(".assist-res .lcard.mini");
      check(true, "подбор после уточнения — мини-карточками");
      await page.locator(".assist-clear").click();
      check(await page.locator(".add-form input").inputValue() === "" && await page.locator(".assist-step, .assist-res").count() === 0
        && await page.locator(".examples").count() === 1 && await page.locator(".assist-clear").count() === 0,
        "«Очистить» — пустое поле, ни вопроса, ни подбора, снова примеры");
      check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === "Опишите точку", "после «Очистить» курсор в поле описания");
      await ctx.close();
    }

    // ---------- длинное описание с уточнением (T-544) ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      await asAddress(page, "198.51.100.22");
      const sent = sentTexts(page);
      step("Помощник: длинное описание с уточнением не теряет ответ");
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      const filler = (n) => "пончики на фудкорте у вокзала, кофе с собой, ".repeat(20).slice(0, n).trim();
      await page.locator(".add-form input").fill(filler(700));
      check((await page.locator(".add-form input").inputValue()).length === 500, "в поле — не больше 500 знаков");
      const d300 = filler(300);
      await page.locator(".add-form input").fill(d300);
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".assist-clar");
      await page.locator(".assist-answers button", { hasText: "Жарим на месте" }).click();
      await page.waitForSelector(".assist-noted");
      const seen = async () => (await (await fetch(`${api.url}/_stub/seen`)).json()).texts.at(-1);
      const g300 = sent.at(-1);
      check(g300.length > 400 && g300.length <= 500 && !g300.includes("…") && g300.startsWith(d300.replace(/[\s.,!?…]+$/, "")) && await seen() === g300,
        "описание 300 знаков с ответом — склейка целиком дошла до модели", `${g300.length} знаков`);
      const d480 = filler(480);
      await page.locator(".add-form input").fill(d480);
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".assist-clar");
      await page.locator(".assist-own input").fill("Жарим, тесто покупаем готовое");
      await page.locator(".assist-own button[type=submit]").click();
      await page.waitForSelector(".assist-noted");
      const g480 = sent.at(-1);
      check(g480.length <= 500 && g480.includes("…. Уточнение: Пончики жарите") && g480.endsWith("— Жарим, тесто покупаем готовое. Уточнение уже получено, вопросов больше не задавай.") && await seen() === g480,
        "описание 480 знаков: укорочено описание, а ответ дошёл целиком", `${g480.length} знаков`);
      await ctx.close();
    }

    // ---------- ожидание ответа (T-544) ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      step("Помощник: ожидание — счётчик секунд, «дольше обычного», отмена, сдача через полторы минуты (T-544)");
      await page.clock.install();                // время страницы двигаем вручную, а не ждём 90 секунд
      const held = [];                           // ответ сервера не приходит: запрос держим, к серверу он не уходит
      await page.route("**/assist", (route) => new Promise((r) => held.push(r)).then(() => route.continue()).catch(() => {}));
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      const submitBtn = page.locator(".add-form button[type=submit]");
      await page.locator(".add-form input").fill("кофейня у метро");
      await submitBtn.click();
      await page.waitForSelector(".assist-wait");
      await page.clock.fastForward(1000);
      const p1 = await page.locator(".assist-phrase").innerText();
      await page.clock.fastForward(3000);
      const w0 = await page.locator(".assist-wait").innerText();
      const p2 = await page.locator(".assist-phrase").innerText();
      check(p1 === "Читаю описание" && p2 !== p1 && / · 0:04/.test(w0) && /обычно 5–15 секунд/.test(w0) && await page.locator(".assist-dots i").count() === 3,
        "пока модель думает — анимация, сменяющиеся фразы и секунды", `${p1} → ${w0.replace(/\s+/g, " ")}`);
      check(await submitBtn.isDisabled(), "кнопка в это время не нажимается повторно");
      await page.clock.fastForward(17000);
      const w1 = await page.locator(".assist-wait").innerText();
      check(/0:21/.test(w1) && /Дольше обычного/.test(w1), "дольше 20 секунд — пишем, что модель задерживается", w1.replace(/\s+/g, " "));
      await page.locator(".assist-wait .link-btn", { hasText: "Отменить" }).click();
      await page.waitForSelector(".assist-wait", { state: "detached" });
      check(await page.locator(".panel.warn").count() === 0 && await submitBtn.isEnabled(), "«Отменить» — ожидание снято, ошибки нет, кнопка снова работает");
      await submitBtn.click();
      await page.waitForSelector(".assist-wait");
      await page.clock.fastForward(91000);
      await page.waitForSelector(".panel.warn");
      const gaveUp = await page.locator(".panel.warn").innerText();
      check(/полторы минуты/.test(gaveUp) && await submitBtn.isEnabled() && await page.locator(".assist-wait").count() === 0,
        "через полторы минуты запрос отменяется сам: понятный текст, кнопка не залипла", gaveUp);
      held.forEach((r) => r());
      await ctx.close();
    }

    // ---------- отзывы ----------
    {
      step("Отзывы: оставлен в одном браузере — виден в другом");
      const sid = "ubplastik";
      const a = await newPage(1440, 900);
      await a.page.goto(base + `#/s/${sid}`, { waitUntil: "networkidle" });
      await a.page.waitForSelector(".rev-sum-none");
      check(/пока нет/.test(await a.page.locator(".rev-sum-none").innerText()), "до отзыва: «пока нет»");
      check(!(await a.page.locator(".rev-trap").isVisible().catch(() => false)) || (await a.page.locator(".rev-trap").boundingBox()).x < 0, "поле-ловушка не видно человеку");
      await a.page.locator("button", { hasText: "Оставить отзыв" }).click();
      await a.page.locator(".rev-rate button", { hasText: "4" }).click();
      await a.page.locator(".rev-form textarea").fill("Привозят вовремя, цены как в прайсе.");
      await a.page.locator(".rev-form input.input").fill("Кафе на Ленина");
      await a.page.locator(".rev-form .btn.pr").click();
      await a.page.waitForSelector(".rev-list li");
      check(/Спасибо/.test(await a.page.locator(".rev-drawer").innerText()) && await a.page.locator(".rev-form").count() === 0, "после отправки — «спасибо» в панели отзывов, форма закрыта");
      const b = await newPage(1440, 900);
      await b.page.goto(base + `#/s/${sid}`, { waitUntil: "networkidle" });
      await b.page.locator(".rev-sum").click();          // «N отзывов» открывает правую панель (T-543)
      await b.page.waitForSelector(".rev-list li");
      const seen = await b.page.locator(".rev-list li").first().innerText();
      check(/Привозят вовремя/.test(seen) && /Кафе на Ленина/.test(seen), "во втором браузере отзыв виден", seen.replace(/\s+/g, " "));
      check(/4,0/.test(await b.page.locator(".rev-sum").innerText()) && /4,0/.test(await b.page.locator(".card-rev").innerText()), "средняя оценка 4,0 — в плашке и в шапке");
      await b.page.locator(".rev-drawer button", { hasText: "Оставить отзыв" }).click();
      await b.page.locator(".rev-rate button", { hasText: "5" }).click();
      await b.page.locator(".rev-form textarea").fill("Ещё один отзыв с того же адреса.");
      expect422 = 1;
      await b.page.locator(".rev-form .btn.pr").click();
      await b.page.waitForTimeout(500);
      const err = await b.page.locator(".rev-form .rev-own").innerText().catch(() => "");
      check(/уже есть отзыв/.test(err), "второй отзыв с того же адреса за сутки — понятный отказ", err);
      await a.ctx.close();
      await b.ctx.close();
    }

    // ---------- живой сбор ----------
    {
      step("Живой сбор: сайт не из набора и ИНН — через сервер");
      const { ctx, page } = await newPage(1440, 900);
      await page.goto(base + "#/add", { waitUntil: "networkidle" });
      await page.waitForSelector(".assist-quota");
      check(/Сервер сбора работает/.test(await page.locator(".assist-quota").innerText()), "экран говорит правду: сервер сбора работает");
      check(await page.getByText("Сервера сбора ещё нет").count() === 0, "старого текста «сервера сбора ещё нет» нет");
      await page.locator(".add-form input").fill("molluska.ru");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".run .steps li");
      await page.waitForSelector(".live-card", { timeout: 20000 });
      const steps = await page.locator(".run .steps li").allInnerTexts();
      check(steps.length >= 5 && /Раскладка по полям/.test(steps.join(" ")), "шаги конвейера пришли с сервера", `${steps.length} шагов`);
      check(/Готово/.test(await page.locator(".run-h b").innerText()), "заголовок — «Готово»");
      const card = await page.locator(".live-card").innerText();
      check(/ИНН/.test(card) && /Компания в ФНС/.test(card), "карточка живого сбора показана на экране", card.split("\n")[0]);
      await page.locator(".add-form input").fill("6679179246");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector("select[aria-label='Категория']");
      check(true, "только ИНН — просит выбрать категорию");
      await page.locator("select[aria-label='Категория']").selectOption("fish");
      await page.locator("button", { hasText: "Собрать по ИНН" }).click();
      await page.waitForSelector(".live-card", { timeout: 20000 });
      check(true, "сбор по ИНН с категорией дошёл до карточки");
      const left = await page.locator(".assist-quota").innerText();
      check(/осталось 3 из 5/.test(left), "остаток сборов уменьшился на два", left);
      await ctx.close();
    }

    // ---------- телефон ----------
    {
      step("Телефон 390: нет горизонтального скролла на экранах с сервером");
      const { ctx, page } = await newPage(390, 844);
      // описания те же, что выше: ответы из кэша, лимит стенда не тратится
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      await page.locator(".add-form input").fill("пончики на фудкорте");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".assist-clar");
      check(await noHScroll(page), "#/assistant с уточняющим вопросом");
      await page.locator(".assist-answers button", { hasText: "Жарим на месте" }).click();
      await page.waitForSelector(".assist-noted");
      await page.locator(".assist-step .btn.pr").click();
      await page.waitForSelector(".assist-res .lcard.mini");
      check(await noHScroll(page), "#/assistant с мини-карточками");
      const over = await page.locator(".assist-res .lcard.mini").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
      check(over === 0, "мини-карточки на 390 без переполнения внутри", `${over}`);
      await page.goto(base + "#/s/ubplastik", { waitUntil: "networkidle" });
      await page.locator(".rev-sum").click();
      await page.waitForSelector(".rev-list li");
      check(await noHScroll(page), "#/s/ubplastik с отзывом");
      await page.goto(base + "#/add", { waitUntil: "networkidle" });
      await page.locator(".add-form input").fill("molluska.ru");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".live-card", { timeout: 20000 });
      check(await noHScroll(page), "#/add с карточкой живого сбора");
      await ctx.close();
    }

    // ---------- поиск по нескольким товарам (Павел 15.10) ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      step("Поиск по товару: несколько товаров через запятую — чипы, группы по охвату");
      await page.goto(base + "#/find?q=" + encodeURIComponent("молоко, сыр, тесто"), { waitUntil: "networkidle" });
      await page.waitForSelector(".terms-bar");
      const chips = await page.locator(".terms-bar .assist-need").allInnerTexts();
      check(chips.length === 3 && chips.every((c) => /\d/.test(c)), "запрос через запятую — три чипа с числом поставщиков", chips.map((c) => c.replace(/\s+/g, " ")).join(" | "));
      const groups = () => page.locator(".find-group").evaluateAll((gs) => gs.map((g) => ({
        title: g.querySelector(".section-h").textContent.replace(/\s+/g, " ").trim(),
        on: [...g.querySelectorAll(".lcard")].map((c) => c.querySelectorAll(".mc-chips .mc-chip.on").length),
        all: [...g.querySelectorAll(".lcard")].map((c) => c.querySelectorAll(".mc-chips .mc-chip").length) })));
      let gs = await groups();
      check(gs.length > 1 && /^Есть всё/.test(gs[0].title) && gs.every((g, i) => i === 0 || g.on[0] < gs[i - 1].on[0]),
        "группы по охвату: сначала «есть всё», дальше меньше", gs.map((g) => g.title).join(" | "));
      check(gs.every((g) => g.on.every((n) => n === g.on[0]) && g.all.every((n) => n === 3)), "под каждой карточкой — три чипа, тёмных столько, сколько в заголовке группы");
      const counts = await page.locator(".find-group .lcard").evaluateAll((cs) => cs.map((c) => [c.querySelector(".mc-count")?.textContent, c.querySelectorAll(".mc-chip.on").length]));
      check(counts.length > 0 && counts.every(([t, n]) => t === `есть ${n} из 3`), "перед чипами — «есть N из 3», N — число тёмных чипов", counts[0][0]);
      await page.locator(".terms-bar .assist-need", { hasText: "тесто" }).click();
      await page.waitForTimeout(200);
      gs = await groups();
      check(/off=тесто/.test(hash(page)) && gs.every((g) => g.all.every((n) => n === 2)) && /из 2/.test(gs.at(-1).title),
        "чип «тесто» выключен — ищем по двум, выключенный в адресе", hash(page));
      await page.locator(".terms-add input").fill("сливки");
      await page.locator(".terms-add button").click();
      await page.waitForTimeout(200);
      check(/q=молоко, сыр, тесто, сливки/.test(hash(page).replace(/\+/g, " ")) && /off=тесто/.test(hash(page)) && await page.locator(".terms-bar .assist-need").count() === 4,
        "«Ещё товар» дописывает товар в запрос, выключенный остаётся выключенным", hash(page));
      await page.goBack();
      await page.waitForTimeout(200);
      check(await page.locator(".terms-bar .assist-need").count() === 3, "«назад» — запрос до добавления");
      await page.goto(base + "#/find?q=" + encodeURIComponent("молоко"), { waitUntil: "networkidle" });
      check(await page.locator(".terms-bar .assist-need").count() === 1 && await page.locator(".find-group .mc-chips").count() === 0,
        "один товар — выдача как раньше, по категориям, чип один и «Ещё товар» рядом");
      // несколько подкатегорий в «Поиске по категории» — то же «есть N из M» и чипы (Павел 15.10)
      await page.goto(base + "#/results?cat=packaging&sub=cups,straws,containers,napkins", { waitUntil: "networkidle" });
      await page.waitForSelector(".lcard");
      const sc = await page.locator(".res-sec .lcard, .rows .lcard").evaluateAll((cs) => cs.map((c) => [c.querySelector(".mc-count")?.textContent, c.querySelectorAll(".mc-chip.on").length, c.querySelectorAll(".mc-chip").length]));
      check(sc.length > 0 && sc.every(([t, n, all]) => all === 4 && n >= 1 && t === `есть ${n} из 4`), "категория, 4 подкатегории — в каждой карточке «есть N из 4» и чипы подкатегорий",
        `${sc.length} карточек, ${[...new Set(sc.map((x) => x[0]))].join(" · ")}`);
      const g3 = await page.locator(".first .gcard").evaluateAll((cs) => cs.map((c) => [c.querySelector(".mc-count")?.textContent, c.querySelectorAll(".mc-chip.on").length, c.querySelectorAll(".mc-chip").length]));
      check(g3.length === 3 && g3.every(([t, n, all]) => all === 4 && t === `есть ${n} из 4`), "«Кому написать первым» — тоже «есть N из 4» и чипы", g3.map((x) => x[0]).join(" · "));
      await page.goto(base + "#/results?cat=packaging", { waitUntil: "networkidle" });
      await page.waitForSelector(".lcard");
      check(await page.locator(".lcard .mc-chips").count() === 0, "вся категория — без чипов: выбирать было не из чего");
      await ctx.close();
    }

    // ---------- «назад» на списках T-541 ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      step("«Назад» на списках: фильтры и место прокрутки на месте (T-544)");
      const lists = [["Поиск по товару", "#/find?q=" + encodeURIComponent("стаканы") + "&f=door"], ["Поиск по категории", "#/results?cat=packaging&f=door"],
        ["Все поставщики", "#/catalog?f=active"]];
      for (const [name, url] of lists) {
        await page.goto(base + url, { waitUntil: "networkidle" });
        await page.waitForSelector(".lcard a.nm");
        const cards = page.locator(".lcard a.nm");
        const target = cards.nth(Math.min((await cards.count()) - 1, 20));
        await target.scrollIntoViewIfNeeded();
        const y0 = await page.evaluate(() => Math.round(window.scrollY));
        const h0 = hash(page);
        await target.click();
        await page.waitForFunction(() => location.hash.startsWith("#/s/"));
        await page.goBack();
        await page.waitForSelector(".lcard a.nm");
        await page.waitForTimeout(400);
        const y1 = await page.evaluate(() => Math.round(window.scrollY));
        check(hash(page) === h0 && y0 > 200 && Math.abs(y1 - y0) <= 4, `${name}: «назад» с карточки — те же фильтры и место прокрутки`, `${h0} · ${y0} → ${y1}`);
      }
      // вкладки карточки (T-543) поверх прокрутки по записям (T-544): «назад» и «вперёд» — каждая вкладка на своём месте
      await page.goto(base + "#/s/u2b-upakovka-dlya-biznesa?cat=packaging", { waitUntil: "networkidle" });
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(150);
      await page.locator("nav[aria-label='Разделы карточки'] .nav-item:visible", { hasText: "Разбор" }).first().click();
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(150);
      const yWhy = await page.evaluate(() => Math.round(window.scrollY));
      await page.goBack();
      await page.waitForTimeout(400);
      const yMain = await page.evaluate(() => Math.round(window.scrollY));
      await page.goForward();
      await page.waitForTimeout(400);
      const yFwd = await page.evaluate(() => Math.round(window.scrollY));
      check(/tab=why/.test(hash(page)) && Math.abs(yMain - 300) <= 4 && yWhy > 300 && Math.abs(yFwd - yWhy) <= 4,
        "вкладки карточки: «назад» — «Основное» на своём месте, «вперёд» — «Разбор» на своём, не наверху", `${yMain} · ${yWhy} → ${yFwd}`);
      await page.goto(base + "#/catalog", { waitUntil: "networkidle" });
      await page.evaluate(() => window.scrollTo(0, 700));
      await page.waitForTimeout(100);
      await page.locator(".side-nav .nav-item", { hasText: "Шорт-лист" }).click();
      await page.waitForTimeout(300);
      check(await page.evaluate(() => window.scrollY) === 0, "новый переход по меню открывает страницу сверху");
      await ctx.close();
    }
  } catch (e) {
    check(false, "сценарий оборвался", e.message.split("\n")[0]);
  }

  // Как на Amvera: левые адреса X-Forwarded-For присылает клиент, крайний правый дописывает прокси (T-539)
  step("Адрес клиента за прокси: подменённый X-Forwarded-For «один отзыв с адреса в сутки» не обходит");
  {
    const post = (xff, text) => fetch(`${api.url}/reviews/rosspak`, { method: "POST", body: JSON.stringify({ rating: 4, text }),
      headers: { "Content-Type": "application/json", "X-Forwarded-For": xff } });
    const a = await post("203.0.113.1, 198.51.100.7", "Проверка адреса: первый отзыв из-за прокси");
    const b = await post("203.0.113.2, 198.51.100.7", "Проверка адреса: левый адрес подменён, правый тот же");
    const c = await post("203.0.113.3, 198.51.100.8", "Проверка адреса: другой клиент за тем же прокси");
    check(a.status === 201 && b.status === 422 && c.status === 201,
      "первый отзыв принят, второй с подменённым левым адресом — отказ, другой клиент — принят", `${a.status} · ${b.status} · ${c.status}`);
  }

  step("Ошибки консоли");
  check(errs.length === 0, "0 ошибок консоли и страницы", errs.join(" | "));
  check(expected.length === 1, "ровно один ожидаемый отказ 422 — повторный отзыв", `${expected.length}`);

  await browser.close();
  server.close();
  api.stop();
  const head = `# Экраны с сервером — сценарии кликами\n\nПрогон ${new Date().toISOString()}, \`web/dist\` + заглушка API, headless Chromium. Проверок с ошибкой: ${failed}.\n`;
  const out = process.argv[2] || path.join(ROOT, "e2e-out", "server.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, head + log.join("\n") + "\n");
  console.log(`\nFAILED: ${failed} · протокол: ${out}`);
  process.exitCode = failed ? 1 : 0;
})();
