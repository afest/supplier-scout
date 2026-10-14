// Проверка набора перед публикацией: придуманный поставщик не должен уйти в сдачу молча.
// По правилам сервиса (логика, раздел 5) «демо»-поставщики допустимы только в категории, где
// реальных меньше шести, и только с плашкой. Демо-фикстура прототипа целиком — не допустима.
// Запуск: node scripts/check-data.mjs          — отчёт
//         node scripts/check-data.mjs --release — код выхода 1, если набор нельзя публиковать
import { readdirSync, readFileSync } from "node:fs";

const release = process.argv.includes("--release");
const d = JSON.parse(readFileSync(new URL("../data/suppliers.json", import.meta.url), "utf8"));
const problems = [];

if (d.meta.fixture) problems.push("набор — демо-фикстура прототипа (meta.fixture: true): все поставщики придуманы");
for (const cat of d.categories) {
  const inCat = d.suppliers.filter((s) => s.category === cat.id && !s.live_only);
  const real = inCat.filter((s) => !s.demo).length;
  const demo = inCat.filter((s) => s.demo);
  if (!d.meta.fixture) {
    if (demo.length && real >= 6) problems.push(`${cat.name}: ${demo.length} демо при ${real} реальных — демо допустимы только там, где реальных меньше шести`);
    for (const s of demo) if (s.inn?.value) problems.push(`${s.name}: у демо-поставщика не должно быть ИНН`);
  }
  console.log(`${cat.name}: реальных ${real}, демо ${demo.length}`);
}

// Подкатегории по ассортименту (T-538): 6–10 на категорию, выбор из одного поставщика — не выбор,
// у каждого членства — позиции-основания, по которым поставщик туда попал.
const subIds = new Set(d.categories.flatMap((c) => c.subcategories.map((x) => x.id)));
const base = d.suppliers.filter((s) => !s.live_only);
for (const cat of d.categories) {
  const n = cat.subcategories.length;
  if (n < 6 || n > 10) problems.push(`${cat.name}: ${n} подкатегорий — нужно 6–10`);
  for (const sub of cat.subcategories) {
    const k = base.filter((s) => s.subcategories.includes(sub.id)).length;
    if (k < 2) problems.push(`${cat.name} → ${sub.name}: ${k} поставщиков — меньше двух, слить с соседней или убрать`);
  }
}
for (const s of d.suppliers) {
  for (const id of s.subcategories) {
    if (!subIds.has(id)) problems.push(`${s.name}: подкатегории «${id}» нет в описании категорий`);
    else if (!s.subcategory_basis?.[id]?.length) problems.push(`${s.name}: в подкатегории «${id}» без позиций-оснований`);
  }
}
console.log(`Подкатегорий ${subIds.size}, членств ${base.reduce((a, s) => a + s.subcategories.length, 0)}, из них из чужой категории ${
  base.reduce((a, s) => a + s.subcategories.filter((id) => !d.categories.find((c) => c.id === s.category).subcategories.some((x) => x.id === id)).length, 0)}`);

// Персональные данные ИП (логика, раздел 10; ревью 14.10, Б3): в публичных файлах — «ИП Фамилия И. О.»,
// без ИНН физлица (12 цифр с верной контрольной суммой), без полного ФИО и без мобильных номеров ИП.
const innValid = (s) => {
  const d = [...s].map(Number);
  const k = (w, n) => (w.reduce((a, x, i) => a + x * d[i], 0) % 11) % 10 === d[n];
  return k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
};
const fullName = /(ИП|Индивидуальный предприниматель)\s+[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё]+(\s+[А-ЯЁ][а-яё]+)?/;
const files = ["suppliers.json", ...["live", "runs"].flatMap((dir) => {
  try { return readdirSync(new URL(`../data/${dir}/`, import.meta.url)).filter((f) => f.endsWith(".json")).map((f) => `${dir}/${f}`); }
  catch { return []; }
})];
for (const f of files) {
  const text = readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8");
  const inns = [...new Set(text.match(/(?<!\d)\d{12}(?!\d)/g) || [])].filter(innValid);
  if (inns.length) problems.push(`data/${f}: ИНН физлица (12 цифр) — ${inns.length} шт.`);
  const fio = text.match(fullName);
  if (fio) problems.push(`data/${f}: полное ФИО индивидуального предпринимателя («${fio[0].split(/\s+/).slice(0, 2).join(" ")} …»)`);
}
for (const s of d.suppliers) {
  const person = /^ИП\s/.test(s.legal_name?.value || "") || s.company?.value?.form === "ИП"
    || (s.inn?.searched_in || []).some((t) => t.includes("индивидуального предпринимателя"));
  const mobiles = (s.phones?.value || []).filter((p) => /^9/.test(p.replace(/\D/g, "").slice(-10)));
  if (person && mobiles.length) problems.push(`${s.name}: у ИП в карточке мобильный номер — это личные данные`);
}

if (problems.length) {
  console.log("\nНельзя публиковать как есть:\n" + problems.map((p) => `— ${p}`).join("\n"));
  if (release) process.exit(1);
} else console.log("\nНабор можно публиковать.");
