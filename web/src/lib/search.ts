// Глобальный поиск по товару — без модели: словарь из названий, товаров и подкатегорий,
// окончания не мешают (общий корень), опечатки правит расстояние Дамерау — Левенштейна.
// Поиск внутри категории — свой, на странице категории; здесь — по всему набору.
import type { Category, Subcategory, Supplier } from "../types.ts";

const STOP = new Set(["для", "и", "в", "во", "на", "с", "со", "по", "из", "от", "до", "оптом", "опт", "купить", "поставщик", "поставщики", "поставщика", "екатеринбург", "екб", "ресторана", "ресторанов"]);

export const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter((w) => w.length >= 2);
export const queryTokens = (q: string) => words(q).filter((w) => !STOP.has(w));

/** Одно слово — та же основа: русские окончания отличаются последними 1–3 буквами. */
export function sameStem(a: string, b: string) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 3) return false;
  let p = 0;
  while (p < n && a[p] === b[p]) p++;
  // запрос короче слова — дописывают: «моца» → «моцарелла»
  if (p === a.length && a.length >= 3) return true;
  // слово намного короче запроса — не основа, а обрубок: «упакофка» ≠ «упак»
  if (Math.abs(a.length - b.length) > 3) return false;
  // короткое слово — разница в одну букву окончания, длинное — в две: «молоко» ≠ «молочная», «роллов» = «роллы»
  return p >= Math.max(3, n - (n >= 8 ? 2 : 1));
}

/** Общий корень — мягче, чем основа: только для подсказки «похожая категория», не для находок. */
const sameRoot = (a: string, b: string) => sameStem(a, b) || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));

/** Дамерау — Левенштейн: перестановка соседних букв — одна ошибка, как замена. */
export function distance(a: string, b: string) {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[m][n];
}

const tolerance = (len: number) => (len <= 3 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : 3);

/** Позиции, по которым ищем: ассортимент, если собран, иначе примеры товаров. */
export function itemsOf(s: Supplier): string[] {
  const a = s.assortment?.value?.items;
  if (a?.length) return a.map((x) => x.name);
  return s.products.value ?? [];
}

/** Поиск внутри категории: все слова запроса есть в названии или товарах поставщика. */
export function matchesSupplier(s: Supplier, q: string) {
  const toks = queryTokens(q);
  if (!toks.length) return true;
  const text = [...words(s.name), ...itemsOf(s).flatMap(words)];
  return toks.every((t) => text.some((w) => sameStem(t, w)));
}

export interface Index {
  vocab: string[];
  cats: Category[];
}

export function buildIndex(suppliers: Supplier[], cats: Category[]): Index {
  const v = new Set<string>();
  const add = (s: string) => words(s).forEach((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && v.add(w));
  for (const c of cats) {
    add(c.name);
    c.subcategories.forEach((s) => add(s.name));
  }
  for (const s of suppliers) {
    add(s.name);
    itemsOf(s).forEach(add);
  }
  return { vocab: [...v], cats };
}

/** Слово запроса → слово словаря: своё, если есть совпадение по основе, иначе ближайшее по опечаткам. */
export function correctToken(t: string, ix: Index): string | null {
  if (ix.vocab.some((w) => sameStem(t, w))) return t;
  const tol = tolerance(t.length);
  if (!tol) return null;
  let best: { w: string; d: number } | null = null;
  for (const w of ix.vocab) {
    if (Math.abs(w.length - t.length) > tol + 2) continue;
    // недописанное слово сравниваем с началом словарного той же длины
    const d = Math.min(distance(t, w), w.length > t.length ? distance(t, w.slice(0, t.length)) + 0.5 : Infinity);
    if (d <= tol && (!best || d < best.d || (d === best.d && w.length < best.w.length))) best = { w, d };
  }
  return best ? best.w : null;
}

export interface Hit {
  supplier: Supplier;
  /** позиции ассортимента или названия, где нашлось */
  matched: string[];
  via: "item" | "subcategory" | "name";
  /** сколько слов запроса нашлось */
  n: number;
}

export interface SearchResult {
  tokens: string[];
  /** исправленный запрос, если были опечатки */
  corrected: string | null;
  /** слова, которых нет ни в словаре, ни рядом */
  unknown: string[];
  hits: Hit[];
  /** категории, совпавшие названием, — переход ко всей категории */
  cats: Category[];
  /** подкатегории, совпавшие с запросом, — переход к рекомендации */
  subs: { cat: Category; sub: Subcategory }[];
  /** категория совпала только названием — показать как «похожая», не как находку */
  relatedCats: Category[];
}

const hasAll = (text: string[], tokens: string[]) => tokens.every((t) => text.some((w) => sameStem(t, w)));
const hasAny = (text: string[], tokens: string[]) => tokens.filter((t) => text.some((w) => sameStem(t, w))).length;

export function search(q: string, suppliers: Supplier[], ix: Index): SearchResult {
  const raw = queryTokens(q);
  const fixed = raw.map((t) => correctToken(t, ix));
  const tokens = fixed.filter((t): t is string => !!t);
  const unknown = raw.filter((_, i) => !fixed[i]);
  const corrected = fixed.some((t, i) => t && t !== raw[i]) ? tokens.join(" ") : null;
  // похожая категория — и для слов, которых в наборе нет: «молоко» → «Сыр и молочное»
  const related = (skip: Set<string>) => ix.cats.filter((c) => !skip.has(c.id) && [...tokens, ...unknown].some((t) => words(c.name).some((w) => sameRoot(t, w))));
  if (!tokens.length) return { tokens, corrected, unknown, hits: [], cats: [], subs: [], relatedCats: related(new Set()) };

  const cats = ix.cats.filter((c) => hasAll(words(c.name), tokens));
  const subs: SearchResult["subs"] = [];
  const subIds = new Set<string>();
  for (const cat of ix.cats)
    for (const sub of cat.subcategories) {
      const text = [...words(sub.name), ...sub.keywords.map(norm)];
      if (hasAll(text, tokens)) {
        subs.push({ cat, sub });
        subIds.add(sub.id);
      }
    }

  const collect = (strict: boolean) => {
    const out: Hit[] = [];
    for (const s of suppliers) {
      const match = (text: string[]) => (strict ? hasAll(text, tokens) : hasAny(text, tokens) > 0);
      const items = itemsOf(s).filter((it) => (strict ? hasAll(words(it), tokens) : hasAny(words(it), tokens) > 0));
      if (items.length) {
        out.push({ supplier: s, matched: items, via: "item", n: Math.max(...items.map((it) => hasAny(words(it), tokens))) });
        continue;
      }
      if (s.subcategories.some((x) => subIds.has(x))) {
        const cat = ix.cats.find((c) => c.id === s.category)!;
        out.push({ supplier: s, matched: s.subcategories.filter((x) => subIds.has(x)).map((x) => cat.subcategories.find((y) => y.id === x)!.name), via: "subcategory", n: tokens.length });
        continue;
      }
      if (match(words(s.name))) out.push({ supplier: s, matched: [s.name], via: "name", n: hasAny(words(s.name), tokens) });
    }
    return out;
  };
  let hits = collect(true);
  if (!hits.length && tokens.length > 1) hits = collect(false);
  const order = { item: 0, subcategory: 1, name: 2 } as const;
  hits.sort((a, b) => b.n - a.n || order[a.via] - order[b.via] || b.matched.length - a.matched.length || a.supplier.name.localeCompare(b.supplier.name, "ru"));

  const relatedCats = related(new Set([...hits.map((h) => h.supplier.category), ...cats.map((c) => c.id)]));
  return { tokens, corrected, unknown, hits, cats, subs, relatedCats };
}

export interface Suggestion {
  kind: "sub" | "item" | "supplier";
  label: string;
  hint: string;
  href: string;
}

/** Подсказки под строкой поиска: подкатегории, товары, поставщики. */
export function suggest(q: string, suppliers: Supplier[], ix: Index, hrefs: { cat: (c: Category) => string; sub: (c: Category, s: Subcategory) => string; find: (q: string) => string; card: (s: Supplier) => string }): Suggestion[] {
  const r = search(q, suppliers, ix);
  if (!r.tokens.length) return [];
  const out: Suggestion[] = [];
  for (const cat of r.cats.slice(0, 1)) out.push({ kind: "sub", label: cat.name, hint: "вся категория", href: hrefs.cat(cat) });
  for (const { cat, sub } of r.subs.slice(0, 2)) out.push({ kind: "sub", label: sub.name, hint: cat.short, href: hrefs.sub(cat, sub) });
  const seen = new Set<string>();
  for (const h of r.hits) {
    if (h.via !== "item") continue;
    for (const it of h.matched) {
      const key = norm(it);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "item", label: it, hint: h.supplier.name, href: hrefs.find(it) });
      if (seen.size >= 3) break;
    }
    if (seen.size >= 3) break;
  }
  for (const h of r.hits.filter((x) => x.via === "name").slice(0, 2)) out.push({ kind: "supplier", label: h.supplier.name, hint: "поставщик", href: hrefs.card(h.supplier) });
  return out.slice(0, 6);
}
