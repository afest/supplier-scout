import type { ReactNode } from "react";
import type { Category } from "../types.ts";
import { FILTER_GROUPS, MAX_RANGE, type FilterId, type FilterState } from "../lib/filters.ts";
import { num, rub } from "../lib/format.ts";
import { Check, Hint } from "./ui.tsx";

/** Колонка фильтров: условия, надёжность, минимальный заказ. Сверху — свой блок экрана (подкатегории или категории). */
export function FiltersPanel({ state, onChange, top, marking, count, onClose, onReset }: {
  state: FilterState;
  onChange: (patch: Record<string, string | null>) => void;
  top?: ReactNode;
  marking: boolean;
  count: number;
  onClose: () => void;
  onReset: () => void;
}) {
  const toggle = (id: FilterId, v: boolean) => {
    const next = new Set(state.flags);
    if (v) next.add(id);
    else next.delete(id);
    onChange({ f: [...next].join(",") || null });
  };
  return (
    <div className="filters-in">
      <div className="filters-head">
        <h2 className="h3">Фильтры</h2>
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Закрыть фильтры">×</button>
      </div>
      {top}
      <div className="fgroup">
        <div className="label">
          Минимальный заказ до
          <Hint>Сравнивается с минимальной суммой заказа на сайте поставщика. Если минимум не указан или указан в штуках и килограммах, поставщик по умолчанию остаётся в списке — фильтр не выкидывает неизвестное молча.</Hint>
        </div>
        <div className="range">
          <div className="range-val num">{state.max === null ? "любой" : rub(state.max)}</div>
          <input
            type="range" min={0} max={MAX_RANGE} step={1000} value={state.max ?? MAX_RANGE}
            style={{ ["--w" as string]: `${((state.max ?? MAX_RANGE) / MAX_RANGE) * 100}%` }}
            aria-label="Минимальный заказ до, рублей"
            onChange={(e) => onChange({ max: Number(e.target.value) >= MAX_RANGE ? null : e.target.value })}
          />
          <div className="rule-ticks" />
          <div className="range-lbl num"><span>0</span><span>{num(MAX_RANGE)}+</span></div>
        </div>
        <Check checked={state.keepUnknown} onChange={(v) => onChange({ unk: v ? null : "0" })}>и где не указан</Check>
      </div>
      {FILTER_GROUPS.map((g) => (
        <div key={g.title} className="fgroup">
          <div className="label">{g.title}</div>
          {g.items.filter((it) => !it.markingOnly || marking).map((it) => (
            <Check key={it.id} checked={state.flags.has(it.id)} onChange={(v) => toggle(it.id, v)}>{it.label}</Check>
          ))}
        </div>
      ))}
      <div className="fgroup row-btns">
        <button type="button" className="btn ghost sm" onClick={onReset}>Сбросить</button>
        <button type="button" className="btn pr sm sm-only" onClick={onClose}>Показать {count}</button>
      </div>
    </div>
  );
}

export function SubcatChecks({ cat, value, onChange }: { cat: Category; value: string[]; onChange: (subs: string[]) => void }) {
  return (
    <div className="fgroup">
      <div className="label">Подкатегория</div>
      {cat.subcategories.map((s) => (
        <Check key={s.id} checked={value.includes(s.id)} onChange={(v) => {
          const next = v ? [...value, s.id] : value.filter((x) => x !== s.id);
          if (next.length) onChange(next);
        }}>{s.name}</Check>
      ))}
    </div>
  );
}
