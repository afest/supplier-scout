// Раздел «Разбор» на странице поставщика (T-543) — сюда переехал экран «Почему такой порядок» (#/why).
// Сверху — разбор балла по критериям; нажали «Сравнить» в строке рейтинга — рядом встаёт столбец той компании.
// Ниже — рейтинг при этих весах; строка этой компании не уезжает при прокрутке. Переход на другую компанию —
// по её имени или значку ↗. «Что важнее» — в колонке слева (PrioSwitch), на телефоне — над разбором.
import { useEffect, useRef, type ReactNode } from "react";
import { actions } from "../store.ts";
import type { Query } from "../data.ts";
import { leaderText } from "../lib/explain.ts";
import { logoOf } from "../lib/logos.ts";
import { bigWholesale, CRITS, firstToWrite, PRIORITIES, weightsFor, type CritId, type Excluded, type Priority, type Scored } from "../lib/score.ts";
import type { Supplier } from "../types.ts";
import { Avatar, Hint, Rule, ScoreNum, StatusIcon } from "./ui.tsx";

const fmt1 = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });

export interface Place { place: number; n: number }

/** «Что важнее» с местом этой компании при каждом наборе весов — в колонке страницы поставщика, как параметры в колонке списков. */
export function PrioSwitch({ value, places, onChange }: { value: Priority; places: Record<Priority, Place | null>; onChange: (p: Priority) => void }) {
  return (
    <div className="prio-sw" role="radiogroup" aria-label="Что важнее">
      <span className="label">Что важнее<Hint label="Веса">От набора весов зависит балл и место в рейтинге. Справа — место этой компании при каждом наборе.</Hint></span>
      {PRIORITIES.map((x) => (
        <button key={x.id} type="button" role="radio" aria-checked={x.id === value} className={x.id === value ? "on" : ""} onClick={() => onChange(x.id)}>
          <span className="ps-l">{x.label}</span>
          <span className="ps-n num">{places[x.id] ? `${places[x.id]!.place}-й из ${places[x.id]!.n}` : "исключён"}</span>
        </button>
      ))}
    </div>
  );
}

export function Breakdown({ s, q, current, stop, ranked, excluded, vsId, prio, onVs, linkFor }: {
  s: Supplier;
  q: Query;
  /** балл текущей компании — считается и у исключённой, чтобы был виден разбор */
  current: Scored;
  stop: { reason: string } | null;
  ranked: Scored[];
  excluded: Excluded[];
  vsId: string | null;
  /** переключатель весов — на телефоне здесь, над разбором (на широком экране он в колонке слева) */
  prio: ReactNode;
  onVs: (id: string | null) => void;
  linkFor: (id: string) => string;
}) {
  const weights = weightsFor(q.prio, q.cat);
  const vs = vsId && vsId !== s.id ? ranked.find((x) => x.supplier.id === vsId) ?? null : null;
  const leader = firstToWrite(ranked)[0] ?? ranked[0];
  const lt = leader ? leaderText(leader, q.cat, q.volume) : null;
  // выбрали компанию в рейтинге внизу — показываем сравнение: два столбца наверху вкладки
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!vs) return;
    const r = grid.current?.getBoundingClientRect();
    // отступ сверху — под прилипшими меню (scroll-margin-top в styles.css)
    if (r && r.top < (parseFloat(getComputedStyle(grid.current!).scrollMarginTop) || 0)) grid.current!.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [vs?.supplier.id]);
  const placeOf = (id: string) => ranked.findIndex((x) => x.supplier.id === id) + 1;
  /** ▲ — у кого выше оценка критерия в сравнении; неизвестное не побеждает */
  const better = (id: CritId) => {
    if (!vs) return null;
    const a = current.crits[id], b = vs.crits[id];
    if (!a.known && !b.known) return null;
    if (Math.abs(a.score - b.score) < 1e-9) return null;
    return a.score > b.score ? "cur" : "vs";
  };

  return (
    <div className="brk">
      <div className="brk-tools">{prio}</div>
      {lt && leader && <p className="verdict"><b>Первым — {leader.supplier.name}:</b> {lt.why.charAt(0).toLowerCase() + lt.why.slice(1)} {lt.ask}</p>}

      <div ref={grid} className={`brk-grid${vs ? " cmp" : ""}`}>
        <div className="brk-k brk-hk"><span>Критерий</span><span>вес</span></div>
        <Head sc={current} place={stop ? null : placeOf(s.id)} n={ranked.length} pinned stop={stop?.reason} />
        {vs && <Head sc={vs} place={placeOf(vs.supplier.id)} n={ranked.length} href={linkFor(vs.supplier.id)} onClose={() => onVs(null)} />}
        {CRITS.map((c) => {
          const b = better(c.id);
          return [
            <div key={`${c.id}-k`} className="brk-k"><span>{c.label}</span><span className="num">{weights[c.id]}</span></div>,
            <Cell key={`${c.id}-a`} sc={current} id={c.id} best={b === "cur"} side="cur" />,
            vs && <Cell key={`${c.id}-b`} sc={vs} id={c.id} best={b === "vs"} side="vs" />,
          ];
        })}
        <div className="brk-k brk-total"><span>Итого</span><span className="num">100</span></div>
        <div className="brk-c cur brk-total"><ScoreNum value={current.total} /><span className="unit">/100</span></div>
        {vs && <div className="brk-c vs brk-total"><ScoreNum value={vs.total} /><span className="unit">/100</span></div>}
      </div>

      <h2 className="section-h brk-rank-h">
        Рейтинг при этих весах
        <Hint>Строка этой компании закреплена и не уезжает при прокрутке. Кнопка «Сравнить» в строке ставит разбор той компании рядом с этим, повторное нажатие убирает. Имя или ↗ — перейти на страницу компании. Полоса — вклад критериев слева направо: надёжность, документы, минимальный заказ, доставка, цены, полнота.</Hint>
      </h2>
      {stop && <p className="q plain brk-stop"><StatusIcon status="not_found" size={10} /> Эта компания исключена из рекомендации: {stop.reason}. В рейтинге её нет.</p>}
      <ol className="order rk">
        {ranked.map((x, i) => {
          const me = x.supplier.id === s.id;
          const sel = x.supplier.id === vs?.supplier.id;
          const name = x.supplier.name;
          return (
            <li key={x.supplier.id} className={`${me ? "me" : ""}${sel ? " sel" : ""}`}>
              <span className="n num">{i + 1}</span>
              <Avatar s={x.supplier} size={32} logo={logoOf(x.supplier.id)} color />
              <span className="nm">
                {me ? <b>{name}</b> : <a href={linkFor(x.supplier.id)}>{name}</a>}
                {bigWholesale(x) && <span className="opt-pill">крупный опт</span>}
                {me && <span className="rk-tag">эта компания</span>}
              </span>
              <span className="stack" aria-hidden="true">
                {CRITS.map((c) => <i key={c.id} style={{ width: `${x.contrib[c.id]}%` }} title={c.short} />)}
              </span>
              <ScoreNum value={x.total} size="sm" />
              {me ? <span /> : (
                <button type="button" className="rk-cmp" aria-pressed={sel} onClick={() => onVs(sel ? null : x.supplier.id)}
                  aria-label={sel ? `Убрать ${name} из сравнения` : `Сравнить ${s.name} с ${name}`}>
                  {sel ? "✓ Сравнение" : "Сравнить"}
                </button>
              )}
              {me ? <span /> : <a className="rk-go" href={linkFor(x.supplier.id)} aria-label={`Открыть страницу ${name}`} title="Открыть страницу компании">↗</a>}
            </li>
          );
        })}
      </ol>

      {excluded.length > 0 && (
        <div className="brk-ex">
          <h3 className="label">Исключены из рекомендации<Hint>Стоп-условия — отдельно от баллов: ликвидация или банкротство, «не возит в ваш город», «это не поставщик».</Hint></h3>
          <ul className="ex-list">
            {excluded.map((e) => (
              <li key={e.supplier.id}>
                <Avatar s={e.supplier} size={24} logo={logoOf(e.supplier.id)} color />
                <div>
                  {e.supplier.id === s.id ? <b>{e.supplier.name}</b> : <a href={linkFor(e.supplier.id)}>{e.supplier.name}</a>}
                  <div className="q plain"><StatusIcon status={e.mark} size={10} /> {e.reason}</div>
                  {e.canReturn && <button type="button" className="link-btn" onClick={() => actions.returnSupplier(e.supplier.id)}>вернуть в выдачу</button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Head({ sc, place, n, pinned = false, stop, href, onClose }: { sc: Scored; place: number | null; n: number; pinned?: boolean; stop?: string; href?: string; onClose?: () => void }) {
  return (
    <div className={`brk-h${pinned ? " me" : " vs"}`}>
      <Avatar s={sc.supplier} size={40} logo={logoOf(sc.supplier.id)} color />
      <div className="brk-h-t">
        {href ? <a className="brk-h-nm" href={href}>{sc.supplier.name} <span aria-hidden="true">↗</span></a> : <b className="brk-h-nm">{sc.supplier.name}</b>}
        <span className="brk-h-sub">{place ? `${place}-й из ${n}` : stop ? "исключён" : "—"}{pinned && <span className="rk-tag">эта компания</span>}</span>
      </div>
      {onClose && <button type="button" className="brk-x" aria-label="Закрыть сравнение" title="Закрыть сравнение" onClick={onClose}>×</button>}
    </div>
  );
}

function Cell({ sc, id, best, side }: { sc: Scored; id: CritId; best: boolean; side: "cur" | "vs" }) {
  const r = sc.crits[id];
  return (
    <div className={`brk-c ${side}${best ? " win" : ""}`}>
      <div className="brk-c-top">
        <b className="num">{r.known ? Math.round(r.score * 100) : "⅓"}</b>
        <span className="brk-contrib num" title="Вклад в балл">+{fmt1(sc.contrib[id])}</span>
        {best && <span className="best-tag">▲ выше</span>}
      </div>
      <Rule value={r.score} compact />
      <div className={`brk-c-t${r.known ? "" : " miss"}`}><StatusIcon status={r.mark} size={10} /> {r.text}</div>
    </div>
  );
}
