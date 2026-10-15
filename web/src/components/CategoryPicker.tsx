// Выпадающий выбор категорий и подкатегорий с множественным выбором (T-541, круг 2) — в колонке «Поиска по категории»
// и «Всех поставщиков». Список раскрывается в колонке, а не поверх выдачи: колонка прокручивается сама и ничего не обрезает.
// Под закрытым списком — выбранное пилюлями с крестиком.
import { useEffect, useId, useState } from "react";
import type { Category } from "../types.ts";
import { CATEGORIES, countIn } from "../data.ts";
import type { State } from "../store.ts";
import { selSummary, subsOf, toggleCat, toggleSub, type Selection } from "../lib/selection.ts";
import { CatGlyph } from "./ui.tsx";

export function CategoryPicker({ sel, onChange, state, required = false, empty = "Все категории" }: {
  sel: Selection;
  onChange: (next: Selection) => void;
  state: Pick<State, "collected">;
  /** «Поиск по категории»: последнюю категорию снять нельзя, без неё нечего рекомендовать */
  required?: boolean;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [exp, setExp] = useState<Set<string>>(() => new Set(sel.cats.map((c) => c.id)));
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const flip = (cid: string) => setExp((s) => { const n = new Set(s); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });
  const isOn = (c: Category) => sel.cats.some((x) => x.id === c.id);

  return (
    <div className={`cpick${open ? " open" : ""}`}>
      <button type="button" className="cp-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className="cp-k">Категории и подкатегории</span>
        <span className="cp-v">{selSummary(sel, empty)}</span>
        <span className="cp-chev" aria-hidden="true" />
      </button>

      {open ? (
        <div className="cp-panel" id={id} role="group" aria-label="Категории и подкатегории">
          {CATEGORIES.map((c) => {
            const on = isOn(c), own = on ? subsOf(sel, c) : [], whole = on && !own.length;
            const lastLocked = required && whole && sel.cats.length === 1;
            return (
              <div key={c.id} className={`cp-cat${on ? " on" : ""}`}>
                <div className="cp-cat-h">
                  <label className={`chk cp-row${lastLocked ? " locked" : ""}`}>
                    <input type="checkbox" checked={whole} ref={(el) => { if (el) el.indeterminate = on && !whole; }}
                      onChange={() => onChange(toggleCat(sel, c, required))} aria-label={c.name} />
                    <i aria-hidden="true" />
                    <CatGlyph cat={c} size={22} />
                    <span className="cp-l">{c.short}</span>
                    <span className="pn num">{countIn(c, null, state)}</span>
                  </label>
                  <button type="button" className="cp-exp" aria-expanded={exp.has(c.id)} aria-label={`Подкатегории: ${c.short}`} onClick={() => flip(c.id)} />
                </div>
                {exp.has(c.id) && (
                  <div className="cp-subs">
                    {c.subcategories.map((s) => (
                      <label key={s.id} className="chk cp-row sub">
                        <input type="checkbox" checked={whole || own.includes(s.id)} onChange={() => onChange(toggleSub(sel, c, s.id, required))} />
                        <i aria-hidden="true" />
                        <span className="cp-l">{s.name}</span>
                        <span className="pn num">{countIn(c, s.id, state)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="cp-foot">
            {!required && sel.cats.length > 0 && <button type="button" className="link-btn" onClick={() => onChange({ cats: [], subs: [] })}>Все категории</button>}
            <button type="button" className="btn sec sm" onClick={() => setOpen(false)}>Готово</button>
          </div>
        </div>
      ) : (
        sel.cats.length > 0 && (
          <div className="cp-chips" aria-label="Выбрано">
            {sel.cats.flatMap((c) => {
              const own = subsOf(sel, c);
              if (!own.length) {
                const locked = required && sel.cats.length === 1;
                return [<span key={c.id} className="cp-chip"><CatGlyph cat={c} size={18} />{c.short}{!locked && <button type="button" aria-label={`Убрать ${c.short}`} onClick={() => onChange(toggleCat(sel, c, required))}>×</button>}</span>];
              }
              return c.subcategories.filter((s) => own.includes(s.id)).map((s) => (
                <span key={s.id} className="cp-chip"><CatGlyph cat={c} size={18} />{s.name}<button type="button" aria-label={`Убрать ${s.name}`} onClick={() => onChange(toggleSub(sel, c, s.id, required))}>×</button></span>
              ));
            })}
          </div>
        )
      )}
    </div>
  );
}
