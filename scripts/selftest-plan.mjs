// Самопроверка разбора плана закупа и итога (T-546): node scripts/selftest-plan.mjs   (Node 22.18+: .ts без сборки)
// Без сети и без модели: файл примера, CSV в Windows-1251 и UTF-8, вставка из Excel, пустые строки, шапка, итоги,
// потолок 50 позиций; итог — план целиком в наборе, наполовину вне набора, равенство охвата, исключённые.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeText, PlanError, planFromTable, readDelimited, readXlsx, verdict } from "../web/src/lib/plan.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = [];
const ok = (name, cond) => { res.push(!!cond); console.log(`${cond ? "✓" : "✗"} ${name}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Кириллица и ASCII → байты Windows-1251: так сохраняет CSV русский Excel. */
const cp1251 = (s) => Uint8Array.from([...s].map((ch) => {
  const c = ch.codePointAt(0);
  if (c < 128) return c;
  if (c >= 0x410 && c <= 0x44f) return c - 0x350;
  if (ch === "Ё") return 0xa8;
  if (ch === "ё") return 0xb8;
  throw new Error(`нет в 1251: ${ch}`);
}));

// ---------- файл примера ----------
const buf = readFileSync(join(ROOT, "web", "public", "plan-sushi-bar.xlsx"));
const { table, sheet } = await readXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const ex = planFromTable(table);
ok("xlsx-пример: лист «План закупа», 20 позиций", sheet === "План закупа" && ex.lines.length === 20);
ok("xlsx-пример: колонка «Наименование» найдена по шапке", ex.header && ex.col === 1 && ex.columns.find((c) => c.index === 1)?.title === "Наименование");
ok("xlsx-пример: название документа, дата и шапка отброшены — 3 строки", ex.dropped.head === 3);
ok("xlsx-пример: «Итого позиций: 20» и пустая строка перед ним отброшены", ex.dropped.totals === 1 && ex.dropped.empty === 1 && !ex.lines.some((x) => /итого/i.test(x)));
ok("xlsx-пример: «Имбирь … 1,4 кг» и «Лосось … 1,5–2 кг» — целиком, запятая и тире не делят",
  ex.lines.includes("Имбирь маринованный розовый 1,4 кг") && ex.lines.includes("Лосось филе охл. трим D 1,5–2 кг"));
ok("xlsx-пример: количества и единицы в строки не попали", !ex.lines.some((x) => /^(\d+|шт|кг|уп)$/.test(x)));

// ---------- CSV ----------
const csv1251 = cp1251('Наименование;Кол-во;Ед.\r\n"Молоко 3,2% Простоквашино 1л";20;шт\r\nСливки 33%, 1 л;4;шт\r\n;;\r\n"Контейнер\r\nдля роллов";500;шт\r\nИтого;524;\r\n');
const c1 = planFromTable(readDelimited(decodeText(csv1251)));
ok("CSV в Windows-1251: кириллица прочитана", c1.columns[0]?.title === "Наименование");
ok("CSV «;»: «3,2%» и «33%, 1 л» — одна ячейка, перенос внутри кавычек — пробел",
  eq(c1.lines, ["Молоко 3,2% Простоквашино 1л", "Сливки 33%, 1 л", "Контейнер для роллов"]));
ok("CSV «;»: пустая строка и «Итого» отброшены", c1.dropped.empty === 1 && c1.dropped.totals === 1 && c1.dropped.head === 1);
const c2 = planFromTable(readDelimited(decodeText(new TextEncoder().encode("﻿Наименование,Кол-во\nМолоко 3,2% 1л,20\nСтакан 0,5 л,100\n"))));
ok("CSV с запятой и BOM: запятая между цифрами — не разделитель", eq(c2.lines, ["Молоко 3,2% 1л", "Стакан 0,5 л"]) && c2.col === 0);

// ---------- вставка ----------
const p1 = planFromTable(readDelimited("Рис 25 кг\n\nНори, 50 листов\nСтакан 0,5 л, белый\n", { comma: false }));
ok("вставка колонкой: запятая — часть названия, строки не делятся", eq(p1.lines, ["Рис 25 кг", "Нори, 50 листов", "Стакан 0,5 л, белый"]) && p1.dropped.empty === 1);
const p2 = planFromTable(readDelimited("План закупа на неделю\n\nНаименование\tКол-во\nЛосось\t15\nЛосось\t3\nИтого\t18\n", { comma: false }));
ok("вставка из Excel с табуляцией: шапка найдена, строки выше отброшены, повтор убран",
  eq(p2.lines, ["Лосось"]) && p2.dropped.head === 2 && p2.dropped.repeats === 1 && p2.dropped.totals === 1);
const p3 = planFromTable(readDelimited("101\tРис для суши\t2\n102\tНори Gold\t10\n", { comma: false }));
ok("без шапки: колонка названий — та, где текст, а не коды", p3.col === 1 && eq(p3.lines, ["Рис для суши", "Нори Gold"]) && p3.columns.length === 3);
const p4 = planFromTable(readDelimited("101\tРис для суши\n102\tНори Gold\n", { comma: false }), 0);
ok("колонку можно выбрать руками — коды не названия, строк нет", p4.col === 0 && p4.lines.length === 0 && p4.dropped.empty === 2);
const many = planFromTable(readDelimited(Array.from({ length: 60 }, (_, i) => `Позиция ${i + 1}`).join("\n"), { comma: false }));
ok("больше 50 позиций: первые 50, остальное отрезано с пометкой", many.lines.length === 50 && many.cut === 10 && many.lines[49] === "Позиция 50");
ok("пустой текст — ни строк, ни колонок", eq(planFromTable(readDelimited("\n \n", { comma: false })).lines, []));
let notZip = null;
try { await readXlsx(new TextEncoder().encode("это не xlsx").buffer); } catch (e) { notZip = e; }
ok("не xlsx — понятная ошибка, а не падение", notZip instanceof PlanError);

// ---------- итог ----------
const P = (id, ...sup) => ({ id, suppliers: sup.map((s) => (typeof s === "string" ? { id: s, exact: true } : s)) });
const scores = { A: 70, B: 60, C: 50, D: 90, E: 10, F: 80, G: 75, H: 40, X: null };
const sc = (id) => scores[id] ?? null;

const whole = verdict([P("p1", "A", "C"), P("p2", "A", "C"), P("p3", "B", "C"), P("p4", "B", "D")], sc);
ok("итог: план целиком в наборе — закрыт двумя, из пар выбрана с большим баллом (C+D: 140 против A+B: 130)",
  whole.covered === 4 && eq(whole.picks.map((p) => p.id), ["C", "D"]) && !whole.nobody.length && !whole.elsewhere.length);
ok("итог: у каждого выбранного — свои позиции", eq(whole.picks.map((p) => p.takes), [["p1", "p2", "p3"], ["p4"]]));

const half = verdict([P("p1", "A"), P("p2", "A", "B"), P("p3", "B"), P("p4"), P("p5"), P("p6", "X")], sc);
ok("итог: план наполовину вне набора — 3 из 6, ничьё — отдельно, исключённый — в «есть у других»",
  half.covered === 3 && half.total === 6 && eq(half.nobody, ["p4", "p5"]) && eq(half.elsewhere, [{ pos: "p6", by: ["X"] }]) && !half.picks.some((p) => p.id === "X"));
ok("итог: охват тот же — меньше поставщиков лучше: один E (балл 10) вместо пары с баллами выше",
  eq(verdict([P("p1", "E", "A"), P("p2", "E", "B")], sc).picks.map((p) => p.id), ["E"]));
ok("итог: охват и число равны — выше балл", eq(verdict([P("p1", "A", "B")], sc).picks.map((p) => p.id), ["A"]));
const shared = verdict([P("p1", "C", "D"), P("p2", "C"), P("p3", { id: "C", exact: false }, { id: "D", exact: true }), P("p4", "D")], sc);
const takes = Object.fromEntries(shared.picks.map((p) => [p.id, p.takes]));
ok("итог: общую позицию берёт тот, у кого она нашлась точно (p3 — D), и у кого выше балл, если точно у обоих (p1 — D)",
  eq(takes, { D: ["p1", "p3", "p4"], C: ["p2"] }));
const four = verdict([P("p1", "A"), P("p2", "B"), P("p3", "F"), P("p4", "G")], sc);
ok("итог: не больше трёх поставщиков — четвёртая позиция в «есть у других»",
  four.picks.length === 3 && four.covered === 3 && eq(four.elsewhere, [{ pos: "p2", by: ["B"] }]));
const nothing = verdict([P("p1"), P("p2", "X")], sc);
ok("итог: никого подходящего — пустой итог, а не ошибка", nothing.picks.length === 0 && nothing.covered === 0 && eq(nothing.nobody, ["p1"]));

const t = Date.now();
const big = Array.from({ length: 50 }, (_, i) => P(`p${i}`, ...Array.from({ length: 60 }, (_, j) => `S${j}`).filter((_, j) => (i * 7 + j) % 5 === 0)));
const bigScores = (id) => Number(id.slice(1));
const v = verdict(big, bigScores);
ok(`итог: 50 позиций × 60 поставщиков — полный перебор за ${Date.now() - t} мс`, Date.now() - t < 2000 && v.picks.length <= 3);

console.log(`\n${res.filter(Boolean).length} из ${res.length}`);
process.exit(res.every(Boolean) ? 0 : 1);
