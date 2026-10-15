// Колонка управления (T-541): стоит сразу после меню, во всю высоту, отделена полосой и не уезжает при прокрутке выдачи.
// Одна на три экрана — поиск по товару, категория, «Все поставщики»: сверху свой блок экрана (ключевое слово,
// категория с подкатегориями и параметрами, поиск по названию с категориями), ниже — общие фильтры.
// На телефоне колонка встаёт над выдачей, а фильтры свёрнуты в кнопку и открываются панелью.
import { useState, type ReactNode } from "react";
import { activeCount, type FilterState } from "../lib/filters.ts";
import { FiltersPanel } from "./Filters.tsx";
import { Footer } from "./Footer.tsx";

export function FilterRail({ head, fs, onChange, onReset, marking, count, top, label }: {
  head: ReactNode;
  fs: FilterState;
  onChange: (patch: Record<string, string | null>) => void;
  onReset: () => void;
  marking: boolean;
  /** сколько останется в выдаче — на кнопке «Показать N» в панели на телефоне */
  count: number;
  /** блок над фильтрами внутри панели (подкатегории в каталоге) */
  top?: ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const n = activeCount(fs);
  return (
    <aside className="rail" aria-label={label}>
      <div className="rail-in">
        <div className="rail-head">{head}</div>
        <button type="button" className="btn sec sm rail-open" onClick={() => setOpen(true)}>Фильтры{n ? ` · ${n}` : ""}</button>
        <div className={`filters${open ? " open" : ""}`} aria-label="Фильтры" role="group">
          <FiltersPanel state={fs} onChange={onChange} top={top} marking={marking} count={count} onClose={() => setOpen(false)} onReset={onReset} />
        </div>
        {open && <div className="scrim" onClick={() => setOpen(false)} />}
      </div>
    </aside>
  );
}

/** Экран с колонкой: колонка слева, выдача и подвал справа. */
export function Railed({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div className="railed">
      {rail}
      <div className="railed-col">
        <div className="railed-main">{children}</div>
        <Footer />
      </div>
    </div>
  );
}
