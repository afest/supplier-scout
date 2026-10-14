import raw from "../../data/suppliers.json";
import type { Category, Dataset, Supplier } from "./types.ts";
import type { Priority } from "./lib/score.ts";
import { PRIORITIES, rank } from "./lib/score.ts";
import type { State } from "./store.ts";

export const DATA = raw as unknown as Dataset;
export const CATEGORIES: Category[] = DATA.categories;
export const byId = new Map(DATA.suppliers.map((s) => [s.id, s]));

export const catById = (id: string | null | undefined) => CATEGORIES.find((c) => c.id === id) ?? null;
export const subById = (cat: Category, id: string) => cat.subcategories.find((s) => s.id === id) ?? null;
export const categoryOf = (s: Supplier) => catById(s.category)!;

/** Набор, видимый в этом браузере: собранный заранее + собранные живым сбором. */
export function visibleSuppliers(state: Pick<State, "collected">) {
  return DATA.suppliers.filter((s) => !s.live_only || state.collected[s.id]);
}
export const baseCount = DATA.suppliers.filter((s) => !s.live_only).length;

/** Шорт-лист — только поставщики из набора. Одна функция для счётчика в меню и для страницы:
 *  записи о поставщиках прошлых версий набора (демо T-511) в браузере остаются, но не считаются. */
export const shortlistIds = (state: Pick<State, "shortlist">) => Object.keys(state.shortlist).filter((id) => byId.has(id));
export const orphanShortIds = (state: Pick<State, "shortlist">) => Object.keys(state.shortlist).filter((id) => !byId.has(id));

/** Сколько поставщиков в категории или подкатегории — для каталога категорий и переключателя на результатах. */
export function countIn(cat: Category, sub: string | null, state: Pick<State, "collected">) {
  return visibleSuppliers(state).filter((s) => s.category === cat.id && (!sub || s.subcategories.includes(sub))).length;
}

/** Закупка в неделю по умолчанию: одна точка суши или пиццы — порядка 20 000 ₽ по категории. */
export const DEFAULT_VOLUME = 20000;
/** Закупка → параметр адреса: по умолчанию не пишем, стёртую — «0». */
export const volParam = (v: number | null) => (v === DEFAULT_VOLUME ? null : v ?? 0);


export interface Query {
  cat: Category;
  subs: string[];
  volume: number | null;
  prio: Priority;
  q: string;
}

export function readQuery(p: URLSearchParams, fallbackCat = "packaging"): Query {
  const cat = catById(p.get("cat")) ?? catById(fallbackCat)!;
  const subs = (p.get("sub") ?? "").split(",").filter((id) => cat.subcategories.some((s) => s.id === id));
  // закупка не задана в адресе — типичная неделя одной точки; «0» — закупщик сам стёр значение
  const volRaw = (p.get("vol") ?? "").replace(/\s/g, "");
  const vol = volRaw === "" ? DEFAULT_VOLUME : Number(volRaw);
  const prioRaw = p.get("prio");
  const prio = (PRIORITIES.some((x) => x.id === prioRaw) ? prioRaw : "balanced") as Priority;
  return { cat, subs: subs.length ? subs : cat.subcategories.map((s) => s.id), volume: vol > 0 ? vol : null, prio, q: p.get("q") ?? "" };
}

export function queryParams(q: Query) {
  const allSubs = q.subs.length === q.cat.subcategories.length;
  const vol = q.volume === DEFAULT_VOLUME ? null : q.volume ?? 0;
  return { cat: q.cat.id, sub: allSubs ? null : q.subs.join(","), vol, prio: q.prio === "balanced" ? null : q.prio, q: q.q || null };
}

/** Рейтинг категории в контексте запроса — один для списка, карточки, сравнения и разбора. */
export function rankCategory(q: Query, state: Pick<State, "collected" | "returned">, opts: { subsOnly?: boolean; ids?: string[] } = {}) {
  const peers = visibleSuppliers(state).filter((s) => s.category === q.cat.id);
  let pool = peers;
  if (opts.ids) pool = opts.ids.map((id) => byId.get(id)!).filter((s) => s && s.category === q.cat.id);
  else if (opts.subsOnly) pool = peers.filter((s) => s.subcategories.some((x) => q.subs.includes(x)));
  return rank(pool, { volume: q.volume, category: q.cat, peers }, q.prio, new Set(state.returned));
}
