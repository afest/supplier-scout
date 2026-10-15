import type { Field, MinOrder, Supplier } from "../types.ts";

/** Неразрывные пробелы: сумма не рвётся на строки («5 / 000 ₽»). */
export const rub = (n: number) => `${n.toLocaleString("ru-RU").replace(/[   ]/g, " ")} ₽`;
export const num = (n: number) => n.toLocaleString("ru-RU").replace(/ /g, " ");

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
export const years = (n: number) => `${n} ${plural(n, "год", "года", "лет")}`;

export function ageYears(iso: string, now = new Date()) {
  const d = new Date(iso);
  let y = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) y--;
  return Math.max(0, y);
}
export function daysSince(iso: string, now = new Date()) {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000);
}
export const dateRu = (iso: string) => iso.split("-").reverse().join(".");
export function dateShort(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}
export function monthYear(iso: string) {
  const [y, m] = iso.split("-");
  return `${m}.${y}`;
}

/** Поле считается известным, если значение пришло из реестра, с сайта или от закупщика. */
export const isKnown = (f: Field<unknown> | null | undefined) =>
  !!f && f.value !== null && (f.status === "found" || f.status === "claimed" || f.status === "user");

export function minOrderText(m: MinOrder) {
  if (m.amount === 0) return "минимума нет";
  return m.text;
}

export function companyAge(s: Supplier) {
  return isKnown(s.company) ? ageYears(s.company.value!.registered_at) : null;
}

export function initials(name: string) {
  const words = name.replace(/[«»"№]/g, " ").split(/[\s-]+/).filter((w) => /[А-ЯЁA-Z]/i.test(w[0] ?? ""));
  const a = words[0]?.[0] ?? "?";
  const b = words[1]?.[0] ?? "";
  return (a + b).toUpperCase();
}

/** Секунды → «0:07» — счётчик ожидания у живого сбора и помощника. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
