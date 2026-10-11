// Проверка набора перед публикацией: придуманный поставщик не должен уйти в сдачу молча.
// По правилам сервиса (логика, раздел 5) «демо»-поставщики допустимы только в категории, где
// реальных меньше шести, и только с плашкой. Демо-фикстура прототипа целиком — не допустима.
// Запуск: node scripts/check-data.mjs          — отчёт
//         node scripts/check-data.mjs --release — код выхода 1, если набор нельзя публиковать
import { readFileSync } from "node:fs";

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

if (problems.length) {
  console.log("\nНельзя публиковать как есть:\n" + problems.map((p) => `— ${p}`).join("\n"));
  if (release) process.exit(1);
} else console.log("\nНабор можно публиковать.");
