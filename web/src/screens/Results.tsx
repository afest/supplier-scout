import { useEffect, useMemo, useState } from "react";
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, MAX_COMPARE, useStore } from "../store.ts";
import { byId, queryParams, rankCategory, readQuery, type Query } from "../data.ts";
import { leaderText, followerText } from "../lib/explain.ts";
import { completeness, PRIORITIES, type Priority, type Scored } from "../lib/score.ts";
import { activeCount, minRub, passes, readFilters } from "../lib/filters.ts";
import { isKnown, plural, rub } from "../lib/format.ts";
import { Check, Comb, Hint, Mono, Score, StarButton, StatusIcon } from "../components/ui.tsx";
import { FiltersPanel, SubcatChecks } from "../components/Filters.tsx";
import { companyShort, deliveryShort, documentsShort, minOrderShort, pricesShort, RowBadges, supplierMeta } from "../components/supplier.tsx";

export function Results({ route }: { route: Route }) {
  const st = useStore();
  const p = route.params;
  const q = readQuery(p);
  const base = queryParams(q);
  const fs = readFilters(p);
  const view = p.get("view") === "table" ? "table" : "list";
  const sort = p.get("sort") ?? "rec";
  const [sheet, setSheet] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);

  useEffect(() => {
    actions.rememberQuery({ cat: q.cat.id, sub: base.sub ?? "", vol: q.volume ? String(q.volume) : "", prio: q.prio });
  }, [q.cat.id, base.sub, q.volume, q.prio]);

  const setParam = (patch: Record<string, string | null>) => navigate("/results", { ...paramsToObject(p), ...patch }, { replace: true });
  const { ranked, excluded } = useMemo(() => rankCategory(q, st, { subsOnly: true }), [q.cat.id, q.subs.join(), q.volume, q.prio, st]);

  const visible = ranked.filter((sc) => passes(sc.supplier, q.cat, fs));
  const sorted = [...visible];
  if (sort === "min") sorted.sort((a, b) => (minRub(a.supplier) ?? Infinity) - (minRub(b.supplier) ?? Infinity));
  if (sort === "full") sorted.sort((a, b) => completeness(b.supplier).found - completeness(a.supplier).found);
  const hidden = ranked.length - visible.length;
  const top = visible.slice(0, 3);
  const nFilters = activeCount(fs);

  const compareIds = st.compare.filter((id) => byId.get(id)?.category === q.cat.id);
  const onCompare = (id: string) => {
    if (st.compare.some((x) => byId.get(x)?.category !== q.cat.id)) actions.setCompare([id]);
    else actions.toggleCompare(id);
  };
  const cardHref = (id: string) => href(`/s/${id}`, { ...base });
  const unknownKept = fs.max !== null && fs.keepUnknown && visible.some((sc) => minRub(sc.supplier) === null);

  return (
    <div className="results">
      <header className="q-head">
        <div className="q-title">
          <div className="label">Результаты{q.q ? ` · «${q.q}»` : ""}</div>
          <h1 className="h1">{q.cat.name}</h1>
        </div>
        <img className="q-illu" src={q.cat.illustration} alt="" width={160} height={160} />
      </header>

      <div className="ruler" aria-label="Сводка запроса">
        <div className="ruler-labels"><div>Подкатегория</div><div>Город</div><div>Закупка</div><div>Что важнее</div></div>
        <div className="ticks" />
        <div className="ruler-pills">
          <div><span className="pill-out">{q.subs.length === q.cat.subcategories.length ? "Все подкатегории" : q.subs.map((id) => q.cat.subcategories.find((s) => s.id === id)!.name).join(" · ")}</span></div>
          <div><span className="pill-out">Екатеринбург</span></div>
          <div><span className="pill-out num">{q.volume ? `${rub(q.volume)} / нед` : "не задана"}</span></div>
          <div>
            <label className="pill-out pill-select">
              <span className="sr-only">Что важнее</span>
              <select value={q.prio} onChange={(e) => setParam({ prio: (e.target.value as Priority) === "balanced" ? null : e.target.value })}>
                {PRIORITIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </label>
          </div>
        </div>
        <a className="q-edit" href={href("/", { ...base })}>Изменить запрос</a>
      </div>

      {top.length > 0 && <FirstZone top={top} q={q} cardHref={cardHref} whyHref={href("/why", base)} />}

      <div className="lr">
        <aside className={`filters${sheet ? " open" : ""}`} aria-label="Фильтры">
          <FiltersPanel state={fs} onChange={setParam} marking={!!q.cat.marking_group} count={visible.length}
            onClose={() => setSheet(false)} onReset={() => setParam({ f: null, max: null, unk: null, sub: null })}
            top={<SubcatChecks cat={q.cat} value={q.subs} onChange={(next) => setParam({ sub: next.length === q.cat.subcategories.length ? null : next.join(",") })} />} />
        </aside>
        {sheet && <div className="scrim" onClick={() => setSheet(false)} />}

        <div className="list">
          <div className="list-head">
            <div className="list-count">
              <span className="big num">{visible.length}</span>
              <span>{plural(visible.length, "поставщик", "поставщика", "поставщиков")}{hidden > 0 && <span className="muted"> · {hidden} скрыто фильтрами</span>}</span>
              {unknownKept && <Hint label="Почему остались без минимума">Поставщики без минимального заказа в рублях оставлены в списке и помечены ○: фильтр не выкидывает неизвестное молча. Снимите «и где не указан», чтобы их скрыть.</Hint>}
            </div>
            <button type="button" className="btn sec sm sm-only" onClick={() => setSheet(true)}>Фильтры{nFilters ? ` · ${nFilters}` : ""}</button>
            <div className="list-tools">
              <select className="input sm" value={sort} onChange={(e) => setParam({ sort: e.target.value === "rec" ? null : e.target.value })} aria-label="Сортировка">
                <option value="rec">По рекомендации</option>
                <option value="min">По минимальному заказу</option>
                <option value="full">По полноте данных</option>
              </select>
              <div className="seg sm" role="radiogroup" aria-label="Вид">
                <button type="button" role="radio" aria-checked={view === "list"} className={view === "list" ? "on" : ""} onClick={() => setParam({ view: null })}>Список</button>
                <button type="button" role="radio" aria-checked={view === "table"} className={view === "table" ? "on" : ""} onClick={() => setParam({ view: "table" })}>Таблица</button>
              </div>
            </div>
          </div>

          {view === "list" ? (
            <div className="rows">
              {sorted.map((sc, i) => (
                <Row key={sc.supplier.id} sc={sc} rank={i + 1} q={q} hrefCard={cardHref(sc.supplier.id)}
                  inCompare={compareIds.includes(sc.supplier.id)} onCompare={() => onCompare(sc.supplier.id)}
                  starred={!!st.shortlist[sc.supplier.id]} collected={!!st.collected[sc.supplier.id]} />
              ))}
            </div>
          ) : (
            <ResultsTable list={sorted} q={q} cardHref={cardHref} compareIds={compareIds} onCompare={onCompare} shortlist={st.shortlist} />
          )}
          {sorted.length === 0 && (
            <div className="empty-list">
              <p>Под фильтры никто не подошёл.</p>
              <button type="button" className="btn sec sm" onClick={() => setParam({ f: null, max: null, unk: null })}>Сбросить фильтры</button>
            </div>
          )}

          {excluded.length > 0 && (
            <div className="excluded">
              <button type="button" className="excluded-toggle" aria-expanded={showExcluded} onClick={() => setShowExcluded((v) => !v)}>
                Исключены из рекомендации · {excluded.length} <span aria-hidden="true">{showExcluded ? "↑" : "↓"}</span>
              </button>
              <Hint>Стоп-условия считаются отдельно от баллов: ликвидация или банкротство, «не возит в ваш город», «это не поставщик». Решение «не поставщик» можно отменить руками.</Hint>
              {showExcluded && (
                <ul>
                  {excluded.map((e) => (
                    <li key={e.supplier.id}>
                      <Mono s={e.supplier} size={32} />
                      <a href={cardHref(e.supplier.id)}>{e.supplier.name}</a>
                      <span className="why-ex"><StatusIcon status={e.mark} /> {e.reason}</span>
                      {e.canReturn && <button type="button" className="link-btn" onClick={() => actions.returnSupplier(e.supplier.id)}>вернуть в выдачу</button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {compareIds.length > 0 && (
        <div className="selbar" role="region" aria-label="Выбрано для сравнения">
          <div className="selbar-in">
            <span className="sel-monos">{compareIds.map((id) => <Mono key={id} s={byId.get(id)!} size={28} />)}</span>
            <span>Выбрано {compareIds.length} из {MAX_COMPARE}</span>
            <button type="button" className="link-btn" onClick={() => actions.setCompare([])}>очистить</button>
            <a className={`btn pr${compareIds.length < 2 ? " disabled" : ""}`} aria-disabled={compareIds.length < 2}
              href={compareIds.length < 2 ? undefined : href("/compare", { ids: compareIds.join(","), vol: q.volume, prio: base.prio, cat: q.cat.id })}>
              Сравнить
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function FirstZone({ top, q, cardHref, whyHref }: { top: Scored[]; q: Query; cardHref: (id: string) => string; whyHref: string }) {
  const lead = top[0];
  return (
    <section className="first" aria-label="Кому написать первым">
      <div className="first-head">
        <h2 className="h2">Кому написать первым</h2>
        <a href={whyHref}>Почему такой порядок →</a>
      </div>
      <div className="cards3">
        {top.map((sc, i) => {
          const t = i === 0 ? leaderText(sc, q.cat, q.volume) : followerText(sc, lead, q.cat, q.volume);
          const c = companyShort(sc.supplier);
          return (
            <a key={sc.supplier.id} className={`gcard${i === 0 ? " lead" : ""}`} href={cardHref(sc.supplier.id)}>
              <div className="g-top">
                <span className="g-rank num">{i + 1}</span>
                {i === 0 && <span className="signal">первым</span>}
                <Score value={sc.total} unit className="g-score" />
              </div>
              <div className="who">
                <Mono s={sc.supplier} />
                <div>
                  <div className="nm">{sc.supplier.name}</div>
                  <div className="sub">{c.status === "found" ? `${sc.supplier.company.value!.form} · ${c.text.replace("действует ", "")}` : "компания не проверена"}</div>
                </div>
              </div>
              <div className="why">{t.why}</div>
              {t.ask && <div className="ask">{t.ask}</div>}
            </a>
          );
        })}
      </div>
    </section>
  );
}

function Row({ sc, rank, q, hrefCard, inCompare, onCompare, starred, collected }: {
  sc: Scored; rank: number; q: Query; hrefCard: string; inCompare: boolean; onCompare: () => void; starred: boolean; collected: boolean;
}) {
  const s = sc.supplier;
  const c = completeness(s);
  return (
    <div className={`row${inCompare ? " sel" : ""}`}>
      <Check checked={inCompare} onChange={onCompare}><span className="sr-only">Сравнить {s.name}</span><span className="chk-l" aria-hidden="true">сравнить</span></Check>
      <Mono s={s} size={48} />
      <div className="row-main">
        <div className="row-title">
          <a className="nm" href={hrefCard}>{s.name}</a>
          {collected && <span className="fresh-pill">собрано сейчас</span>}
        </div>
        <div className="row-meta">{!isKnown(s.company) && <StatusIcon status="not_found" size={10} />} {supplierMeta(s)}</div>
        <RowBadges s={s} cat={q.cat} />
      </div>
      <div className="comb-cell"><Comb found={c.found} total={c.total} /></div>
      <div className="row-score">
        <Score value={sc.total} />
        <span className="rank-n">{rank}-й</span>
      </div>
      <StarButton on={starred} onClick={() => actions.toggleShort(s.id)} />
    </div>
  );
}

function ResultsTable({ list, q, cardHref, compareIds, onCompare, shortlist }: {
  list: Scored[]; q: Query; cardHref: (id: string) => string; compareIds: string[]; onCompare: (id: string) => void; shortlist: Record<string, unknown>;
}) {
  const cell = (b: { status: Parameters<typeof StatusIcon>[0]["status"]; text: string }) => (
    <span className={b.status === "not_found" ? "miss" : ""}><StatusIcon status={b.status} /> {b.text}</span>
  );
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th><span className="sr-only">Сравнить</span></th><th>Поставщик</th><th className="r">Балл</th><th>Мин. заказ</th><th>Доставка</th><th>Цены</th><th>Документы</th><th>Компания</th><th>Полнота</th><th><span className="sr-only">Шорт-лист</span></th>
          </tr>
        </thead>
        <tbody>
          {list.map((sc) => {
            const s = sc.supplier;
            const c = completeness(s);
            return (
              <tr key={s.id} className={compareIds.includes(s.id) ? "sel" : ""}>
                <td><Check checked={compareIds.includes(s.id)} onChange={() => onCompare(s.id)}><span className="sr-only">Сравнить {s.name}</span></Check></td>
                <td><a className="nm" href={cardHref(s.id)}>{s.name}</a></td>
                <td className="r"><Score value={sc.total} className="sm" /></td>
                <td>{cell(minOrderShort(s))}</td>
                <td>{isKnown(s.delivery) ? cell({ status: s.delivery.status, text: deliveryShort(s.delivery.value!) }) : cell({ status: "not_found", text: "не найдено" })}</td>
                <td>{cell(pricesShort(s))}</td>
                <td>{cell(documentsShort(s, q.cat))}</td>
                <td>{cell(companyShort(s))}</td>
                <td className="num">{c.found}/{c.total}</td>
                <td><StarButton on={!!shortlist[s.id]} onClick={() => actions.toggleShort(s.id)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
