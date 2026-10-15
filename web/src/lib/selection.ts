// Выбор категорий и подкатегорий — один на «Поиск по категории» и «Все поставщики» (T-541, круг 2).
// Можно несколько категорий и в каждой — свои подкатегории. Категория без выбранных подкатегорий — целиком.
// Адрес: одна категория — cat=…, несколько — cats=…,…; подкатегории всех категорий — sub=…,… (id подкатегорий не повторяются).
import type { Category, Supplier } from "../types.ts";
import { CATEGORIES, catById } from "../data.ts";

export interface Selection {
  cats: Category[];
  /** выбранные подкатегории всех категорий; у категории без своих — она целиком */
  subs: string[];
}

export function readSelection(p: URLSearchParams, opts: { required?: boolean; fallback?: string } = {}): Selection {
  const ids = [...(p.get("cats") ?? "").split(","), p.get("cat") ?? ""].filter(Boolean);
  let cats = CATEGORIES.filter((c) => ids.includes(c.id));
  if (!cats.length && opts.required) cats = [catById(opts.fallback ?? "packaging")!];
  const subs = (p.get("sub") ?? "").split(",").filter((id) => cats.some((c) => c.subcategories.some((s) => s.id === id)));
  return { cats, subs };
}

/** Подкатегории категории в выборе; пусто — категория целиком. */
export const subsOf = (sel: Selection, cat: Category) => cat.subcategories.filter((s) => sel.subs.includes(s.id)).map((s) => s.id);

/** Параметры адреса для выбора: одна категория — cat, несколько — cats. Подкатегории, выбранные все, не пишем. */
export function selParams(sel: Selection): Record<string, string | null> {
  const subs = sel.cats.flatMap((c) => {
    const own = subsOf(sel, c);
    return own.length === c.subcategories.length ? [] : own;
  });
  return {
    cat: sel.cats.length === 1 ? sel.cats[0].id : null,
    cats: sel.cats.length > 1 ? sel.cats.map((c) => c.id).join(",") : null,
    sub: subs.length ? subs.join(",") : null,
  };
}

/** Поставщик попадает в выбор: категория целиком — по основной категории, подкатегории — все, кто их продаёт, из любой категории. */
export function inSelection(s: Supplier, sel: Selection) {
  if (!sel.cats.length) return true;
  return sel.cats.some((c) => {
    const own = subsOf(sel, c);
    return own.length ? s.subcategories.some((x) => own.includes(x)) : s.category === c.id;
  });
}

// ---------- действия в выпадающем списке ----------
const keep = (cats: Category[], subs: string[]): Selection => ({
  cats: CATEGORIES.filter((c) => cats.some((x) => x.id === c.id)),
  subs: subs.filter((id) => cats.some((c) => c.subcategories.some((s) => s.id === id))),
});

/** Флажок категории: не выбрана → целиком; частично → целиком; целиком → снять (последнюю обязательную — нельзя). */
export function toggleCat(sel: Selection, cat: Category, required = false): Selection {
  const on = sel.cats.some((c) => c.id === cat.id);
  const own = subsOf(sel, cat);
  if (!on) return keep([...sel.cats, cat], sel.subs);
  if (own.length) return keep(sel.cats, sel.subs.filter((id) => !own.includes(id)));
  if (required && sel.cats.length === 1) return sel;
  return keep(sel.cats.filter((c) => c.id !== cat.id), sel.subs.filter((id) => !cat.subcategories.some((s) => s.id === id)));
}

/** Флажок подкатегории. Категория целиком = все подкатегории отмечены: снятие одной оставляет остальные.
 *  Отмечены все — снова «целиком»; снята последняя — категория уходит из выбора (последняя обязательная остаётся целиком). */
export function toggleSub(sel: Selection, cat: Category, sub: string, required = false): Selection {
  const on = sel.cats.some((c) => c.id === cat.id);
  const all = cat.subcategories.map((s) => s.id);
  const own = on ? (subsOf(sel, cat).length ? subsOf(sel, cat) : all) : [];
  const next = own.includes(sub) ? own.filter((x) => x !== sub) : [...own, sub];
  const others = sel.subs.filter((id) => !all.includes(id));
  if (!next.length) {
    if (required && sel.cats.length === 1) return keep(sel.cats, others);
    return keep(sel.cats.filter((c) => c.id !== cat.id), others);
  }
  const cats = on ? sel.cats : [...sel.cats, cat];
  return keep(cats, next.length === all.length ? others : [...others, ...next]);
}

/** Подпись выбора одной строкой: «Упаковка: стаканы, пакеты · Сыр». */
export function selSummary(sel: Selection, empty = "Все категории") {
  if (!sel.cats.length) return empty;
  return sel.cats.map((c) => {
    const own = c.subcategories.filter((s) => sel.subs.includes(s.id));
    return own.length ? `${c.short}: ${own.map((s) => s.name.toLowerCase()).join(", ")}` : c.short;
  }).join(" · ");
}
