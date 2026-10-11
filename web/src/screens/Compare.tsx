import { useState, type ReactNode } from "react";
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, MAX_COMPARE, useStore } from "../store.ts";
import { byId, queryParams, rankCategory, readQuery, visibleSuppliers } from "../data.ts";
import { compareConclusion } from "../lib/explain.ts";
import { completeness, PRIORITIES, type CritId, type Priority, type Scored } from "../lib/score.ts";
import { ageYears, isKnown, years } from "../lib/format.ts";
import type { FieldStatus } from "../types.ts";
import { Check, DocGlyph, Hint, Mono, Score, Seg, StarButton, StatusIcon } from "../components/ui.tsx";
import { deliveryShort, documentsShort, PRICE_SHORT } from "../components/supplier.tsx";

interface Cell { status: FieldStatus | null; text: ReactNode; plain: string; extra?: ReactNode }
interface RowDef { label: string; crit?: CritId; cell: (sc: Scored) => Cell }

const nf = (t = "не найдено"): Cell => ({ status: "not_found", text: t, plain: t });

export function Compare({ route }: { route: Route }) {
  const st = useStore();
  const p = route.params;
  const ids = (p.get("ids") ?? "").split(",").filter((id) => byId.has(id));
  const first = byId.get(ids[0] ?? "");
  const pp = new URLSearchParams(p);
  if (first) pp.set("cat", first.category);
  const q = readQuery(pp);
  const base = queryParams(q);
  const [onlyDiff, setOnlyDiff] = useState(false);

  const { ranked, excluded } = rankCategory(q, st, { ids });
  const cols = ranked;
  const setIds = (next: string[]) => {
    actions.setCompare(next);
    navigate("/compare", { ...paramsToObject(p), ids: next.join(",") }, { replace: true });
  };
  const candidates = visibleSuppliers(st).filter((s) => s.category === q.cat.id && !ids.includes(s.id));

  if (!first || ids.length < 1) {
    return (
      <div className="empty">
        <h1 className="h1">Сравнивать пока некого</h1>
        <p>Отметьте 2–4 поставщиков в результатах поиска. <a href="#/">К поиску →</a></p>
      </div>
    );
  }

  const ROWS: RowDef[] = [
    {
      label: "Минимальный заказ", crit: "min_order",
      cell: ({ supplier: s }) => s.min_order.status === "not_found" ? nf() : { status: s.min_order.status, text: s.min_order.value!.text, plain: s.min_order.value!.text },
    },
    {
      label: "Цены", crit: "prices",
      cell: ({ supplier: s }) => {
        if (!isKnown(s.prices)) return nf();
        const v = s.prices.value!;
        const ex = v.examples[0];
        return {
          status: s.prices.status, text: <>{PRICE_SHORT[v.mode]}{ex && <span className="sub"> · {ex.item} — {ex.price}</span>}</>, plain: PRICE_SHORT[v.mode] + (ex?.price ?? ""),
          extra: s.price_estimate && <div className="est-line"><StatusIcon status="estimated" /> ориентир: {s.price_estimate.value}</div>,
        };
      },
    },
    {
      label: "Доставка", crit: "delivery",
      cell: ({ supplier: s }) => isKnown(s.delivery) ? { status: s.delivery.status, text: <>{deliveryShort(s.delivery.value!)}{s.delivery.value!.lead_time && <span className="sub"> · {s.delivery.value!.lead_time}</span>}</>, plain: deliveryShort(s.delivery.value!) + s.delivery.value!.lead_time } : nf(),
    },
    {
      label: "Регион работы",
      cell: ({ supplier: s }) => isKnown(s.regions_served) ? { status: s.regions_served.status, text: s.regions_served.value!.join(", "), plain: s.regions_served.value!.join() } : nf(),
    },
    {
      label: "Документы", crit: "documents",
      cell: (sc) => {
        const d = documentsShort(sc.supplier, q.cat);
        return { status: d.status, text: <>{d.status === "found" && <DocGlyph size={16} />} {d.status === "not_found" ? "не найдено" : d.text}</>, plain: d.text };
      },
    },
    {
      label: "Компания", crit: "reliability",
      cell: ({ supplier: s }) => {
        if (!isKnown(s.company)) return nf("не проверена: нет ИНН");
        const c = s.company.value!;
        const t = `действует, ${years(ageYears(c.registered_at))}${c.flags.length ? ` · флаг: ${c.flags[0]}` : ""}`;
        return { status: "found", text: t, plain: t };
      },
    },
    {
      label: "НДС",
      cell: ({ supplier: s }) => isKnown(s.tax_regime) ? { status: "found", text: s.tax_regime.value === "general" ? "с НДС" : "без НДС (УСН)", plain: s.tax_regime.value! } : nf(),
    },
    {
      label: "Работа с ресторанами",
      cell: ({ supplier: s }) => isKnown(s.works_with_horeca) ? { status: s.works_with_horeca.status, text: s.works_with_horeca.value ? "да" : "нет", plain: String(s.works_with_horeca.value) } : nf(),
    },
    {
      label: "Контакты",
      cell: ({ supplier: s }) => {
        const parts = [isKnown(s.phones) && "телефон", isKnown(s.emails) && "email", isKnown(s.messengers) && s.messengers.value!.join(", ")].filter(Boolean).join(", ");
        return { status: null, text: parts || "—", plain: parts };
      },
    },
    {
      label: "Полнота данных", crit: "completeness",
      cell: ({ supplier: s }) => {
        const c = completeness(s);
        return { status: null, text: <span className="num">{c.found} из {c.total}</span>, plain: String(c.found) };
      },
    },
  ];

  /** ▲ — лучшее известное значение; только если в строке есть разница. Неизвестное не участвует. */
  const best = (crit: CritId | undefined) => {
    if (!crit || cols.length < 2) return new Set<string>();
    const known = cols.filter((sc) => sc.crits[crit].known);
    if (known.length < 2) return new Set<string>();
    const top = Math.max(...known.map((sc) => sc.crits[crit].score));
    if (known.every((sc) => sc.crits[crit].score === top)) return new Set<string>();
    return new Set(known.filter((sc) => sc.crits[crit].score === top).map((sc) => sc.supplier.id));
  };

  const concl = compareConclusion(cols, q.cat, q.volume);
  const gridCols = `minmax(140px, 180px) repeat(${cols.length + (excluded.length ? excluded.length : 0)}, minmax(200px, 1fr))${cols.length + excluded.length < MAX_COMPARE ? " minmax(150px, 0.6fr)" : ""}`;

  return (
    <div className="compare">
      <div className="page-h">
        <div>
          <a className="crumb" href={href("/results", base)}>← {q.cat.name}</a>
          <h1 className="h1">Сравнение<Hint label="Как читать сравнение">Колонки упорядочены по баллу при выбранных весах — переключите «что важнее», и порядок колонок изменится. Строки — поля карточки, их порядок фиксирован. ▲ — лучшее известное значение в строке; «не найдено» не побеждает и не проигрывает.</Hint></h1>
        </div>
        <div className="page-tools">
          <Check checked={onlyDiff} onChange={setOnlyDiff}>Только различия</Check>
          <Seg label="Что важнее" size="sm" options={PRIORITIES.map((x) => ({ id: x.id, label: x.short }))} value={q.prio}
            onChange={(v: Priority) => navigate("/compare", { ...paramsToObject(p), prio: v === "balanced" ? null : v }, { replace: true })} />
        </div>
      </div>

      <div className="cmp-scroll">
        <div className="cmp-grid" style={{ gridTemplateColumns: gridCols, minWidth: 140 + (cols.length + excluded.length) * 200 + (cols.length + excluded.length < MAX_COMPARE ? 150 : 0) }}>
          <div className="hd k sticky" />
          {cols.map((sc, i) => (
            <div key={sc.supplier.id} className={`hd${i === 0 ? " col1" : ""}`}>
              <Mono s={sc.supplier} />
              <div className="hd-t">
                <a href={href(`/s/${sc.supplier.id}`, base)}><b>{sc.supplier.name}</b></a>
                <div className="hd-meta">{i === 0 && <span className="signal sm">первым</span>}</div>
                <Score value={sc.total} className="s" />
              </div>
              <button type="button" className="x" aria-label={`Убрать ${sc.supplier.name} из сравнения`} onClick={() => setIds(ids.filter((x) => x !== sc.supplier.id))}>×</button>
            </div>
          ))}
          {excluded.map((e) => (
            <div key={e.supplier.id} className="hd ex">
              <Mono s={e.supplier} />
              <div className="hd-t"><b>{e.supplier.name}</b><div className="sub">исключён: {e.reason}</div></div>
              <button type="button" className="x" aria-label="Убрать" onClick={() => setIds(ids.filter((x) => x !== e.supplier.id))}>×</button>
            </div>
          ))}
          {cols.length + excluded.length < MAX_COMPARE && (
            <div className="hd add">
              <label className="add-sel">
                <span>+ добавить</span>
                <select value="" onChange={(e) => e.target.value && setIds([...ids, e.target.value])} aria-label="Добавить поставщика в сравнение">
                  <option value="">+ добавить</option>
                  {candidates.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            </div>
          )}

          {ROWS.map((r) => {
            const cells = cols.map((sc) => r.cell(sc));
            if (onlyDiff && cells.every((c) => c.plain === cells[0].plain)) return null;
            const b = best(r.crit);
            return [
              <div key={`${r.label}-k`} className="k sticky">{r.label}</div>,
              ...cols.map((sc, i) => (
                <div key={`${r.label}-${sc.supplier.id}`} className={`${i === 0 ? "col1 " : ""}${cells[i].status === "not_found" ? "miss" : ""}`}>
                  <div className="cell-v"><StatusIcon status={cells[i].status} /> <span>{cells[i].text}</span></div>
                  {cells[i].extra}
                  {b.has(sc.supplier.id) && <span className="best">▲ лучший</span>}
                </div>
              )),
              ...excluded.map((e) => <div key={`${r.label}-${e.supplier.id}`} className="miss">—</div>),
              ...(cols.length + excluded.length < MAX_COMPARE ? [<div key={`${r.label}-add`} />] : []),
            ];
          })}

          <div className="k sticky" />
          {cols.map((sc, i) => (
            <div key={`act-${sc.supplier.id}`} className={i === 0 ? "col1" : ""}>
              <StarButton on={!!st.shortlist[sc.supplier.id]} onClick={() => actions.toggleShort(sc.supplier.id)} label={st.shortlist[sc.supplier.id] ? "В шорт-листе" : "В шорт-лист"} />
            </div>
          ))}
          {excluded.map((e) => <div key={`act-${e.supplier.id}`} />)}
          {cols.length + excluded.length < MAX_COMPARE && <div />}
        </div>
      </div>

      {concl && (
        <div className="conclusion">
          <p><b>{concl.lead}:</b> {concl.why.charAt(0).toLowerCase() + concl.why.slice(1)}</p>
          {concl.others.map((o) => <p key={o}>{o}</p>)}
          <a href={href("/why", { ...base, ids: ids.join(",") })}>Почему такой порядок — разбор балла →</a>
        </div>
      )}
    </div>
  );
}
