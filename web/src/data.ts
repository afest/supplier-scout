import raw from "../../data/suppliers.json";
import type { Category, Dataset, Subcategory, Supplier } from "./types.ts";
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

/** Строка поиска → подкатегория. В продукте это делает LLM; в прототипе — словарь основ слов. */
export function matchQuery(q: string): { cat: Category; sub: Subcategory } | null {
  const text = q.toLowerCase().replace(/ё/g, "е");
  if (text.trim().length < 3) return null;
  let best: { cat: Category; sub: Subcategory; hits: number; order: number } | null = null;
  let order = 0;
  for (const cat of CATEGORIES)
    for (const sub of cat.subcategories) {
      order++;
      const hits = sub.keywords.filter((k) => text.includes(k.replace(/ё/g, "е"))).length;
      if (hits && (!best || hits > best.hits)) best = { cat, sub, hits, order };
    }
  return best ? { cat: best.cat, sub: best.sub } : null;
}

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
  const vol = Number((p.get("vol") ?? "").replace(/\s/g, ""));
  const prioRaw = p.get("prio");
  const prio = (PRIORITIES.some((x) => x.id === prioRaw) ? prioRaw : "balanced") as Priority;
  return { cat, subs: subs.length ? subs : cat.subcategories.map((s) => s.id), volume: vol > 0 ? vol : null, prio, q: p.get("q") ?? "" };
}

export function queryParams(q: Query) {
  const allSubs = q.subs.length === q.cat.subcategories.length;
  return { cat: q.cat.id, sub: allSubs ? null : q.subs.join(","), vol: q.volume, prio: q.prio === "balanced" ? null : q.prio, q: q.q || null };
}

/** Рейтинг категории в контексте запроса — один для списка, карточки, сравнения и разбора. */
export function rankCategory(q: Query, state: Pick<State, "collected" | "returned">, opts: { subsOnly?: boolean; ids?: string[] } = {}) {
  const peers = visibleSuppliers(state).filter((s) => s.category === q.cat.id);
  let pool = peers;
  if (opts.ids) pool = opts.ids.map((id) => byId.get(id)!).filter((s) => s && s.category === q.cat.id);
  else if (opts.subsOnly) pool = peers.filter((s) => s.subcategories.some((x) => q.subs.includes(x)));
  return rank(pool, { volume: q.volume, category: q.cat, peers }, q.prio, new Set(state.returned));
}
