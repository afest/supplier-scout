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
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (expect422 && /status of 422/.test(m.text())) { expect422--; expected.push(m.text()); return; }
      errs.push(`${w}: ${m.text()}`);
    });
    return { ctx, page };
  };
  const noHScroll = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  try {
    // ---------- помощник ----------
    {
      const { ctx, page } = await newPage(1440, 900);
      step("Помощник: описание → варианты → поставщики из набора");
      await page.goto(base + "#/", { waitUntil: "networkidle" });
      check(await page.locator(".ways .way", { hasText: "Помощник" }).locator(".way-soon").count() === 0, "на главной у «Помощника» нет пометки «скоро»");
      check(await page.locator(".side-nav .nav-item", { hasText: "Помощник" }).locator(".nav-soon").count() === 0, "в меню у «Помощника» нет пометки «скоро»");
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
      check(/осталось 9 из 10/.test(await page.locator(".assist-quota").innerText()), "лимит уменьшился на один запрос");
      await page.locator(".assist-need", { hasText: "Тапиока" }).click();
      await page.locator(".assist-step .btn.pr").click();
      await page.waitForSelector(".assist-res");
      const links = await page.locator(".assist-res a[href^='#/s/']").evaluateAll((as) => as.map((a) => a.getAttribute("href").replace("#/s/", "").split("?")[0]));
      check(links.length > 0 && links.every((x) => ids.has(x)), "все предложенные поставщики — из набора", `${links.length} ссылок`);
      const missing = await page.locator(".assist-res .panel.warn b").innerText().catch(() => "");
      check(/Тапиока/.test(missing), "чего нет в наборе — названо честно", missing);
      check(await page.locator(".assist-res .panel.warn a", { hasText: "Знаю поставщика" }).count() === 1, "рядом — переход к живому сбору");
      const item = await page.locator(".assist-item").first().innerText();
      check(/^(есть|похоже): «/.test(item), "у поставщика видна позиция, по которой он подобран", item);
      await page.locator(".assist-res a[href^='#/s/']").first().click();
      await page.waitForTimeout(300);
      check(hash(page).startsWith("#/s/"), "клик по поставщику открывает его карточку", hash(page));
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      await page.locator(".examples .pill-out", { hasText: "у меня бабл-ти в ТЦ" }).click();
      await page.waitForSelector(".assist-need");
      check(/осталось 9 из 10/.test(await page.locator(".assist-quota").innerText()), "повтор того же описания лимит не тратит");
      await ctx.close();
    }

    // ---------- отзывы ----------
    {
      step("Отзывы: оставлен в одном браузере — виден в другом");
      const sid = "ubplastik";
      const a = await newPage(1440, 900);
      await a.page.goto(base + `#/s/${sid}`, { waitUntil: "networkidle" });
      await a.page.waitForSelector(".rev-sum");
      check(/пока нет/.test(await a.page.locator(".rev-sum").innerText()), "до отзыва: «пока нет»");
      check(!(await a.page.locator(".rev-trap").isVisible().catch(() => false)) || (await a.page.locator(".rev-trap").boundingBox()).x < 0, "поле-ловушка не видно человеку");
      await a.page.locator("button", { hasText: "Оставить отзыв" }).click();
      await a.page.locator(".rev-rate button", { hasText: "4" }).click();
      await a.page.locator(".rev-form textarea").fill("Привозят вовремя, цены как в прайсе.");
      await a.page.locator(".rev-form input.input").fill("Кафе на Ленина");
      await a.page.locator(".rev-form .btn.pr").click();
      await a.page.waitForSelector(".rev-list li");
      check(/Спасибо/.test(await a.page.locator(".panel", { hasText: "Отзывы клиентов" }).innerText()), "после отправки — «спасибо», форма закрыта");
      const b = await newPage(1440, 900);
      await b.page.goto(base + `#/s/${sid}`, { waitUntil: "networkidle" });
      await b.page.waitForSelector(".rev-list li");
      const seen = await b.page.locator(".rev-list li").first().innerText();
      check(/Привозят вовремя/.test(seen) && /Кафе на Ленина/.test(seen), "во втором браузере отзыв виден", seen.replace(/\s+/g, " "));
      check(/4\.0/.test(await b.page.locator(".rev-sum").innerText()), "средняя оценка 4.0");
      await b.page.locator("button", { hasText: "Оставить отзыв" }).click();
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
      await page.goto(base + "#/assistant", { waitUntil: "networkidle" });
      await page.locator(".add-form input").fill("суши-бар на доставку");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".assist-need");
      await page.locator(".assist-step .btn.pr").click();
      await page.waitForSelector(".assist-res");
      check(await noHScroll(page), "#/assistant с результатом");
      await page.goto(base + "#/s/ubplastik", { waitUntil: "networkidle" });
      await page.waitForSelector(".rev-list li");
      check(await noHScroll(page), "#/s/ubplastik с отзывом");
      await page.goto(base + "#/add", { waitUntil: "networkidle" });
      await page.locator(".add-form input").fill("molluska.ru");
      await page.locator(".add-form button[type=submit]").click();
      await page.waitForSelector(".live-card", { timeout: 20000 });
      check(await noHScroll(page), "#/add с карточкой живого сбора");
      await ctx.close();
    }
  } catch (e) {
    check(false, "сценарий оборвался", e.message.split("\n")[0]);
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
