import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { byId, queryParams, rankCategory, readQuery } from "../data.ts";
import { asks, leaderText } from "../lib/explain.ts";
import { CRITS, PRIORITIES, UNKNOWN, weightsFor, type Priority } from "../lib/score.ts";
import { Gauge, Hint, Mono, Rule, Score, Seg, StatusIcon } from "../components/ui.tsx";

const fmt1 = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });

export function Why({ route }: { route: Route }) {
  const st = useStore();
  const p = route.params;
  const ids = p.get("ids") ? p.get("ids")!.split(",").filter((id) => byId.has(id)) : null;
  const pp = new URLSearchParams(p);
  const anchor = byId.get(ids?.[0] ?? p.get("id") ?? "");
  if (anchor) pp.set("cat", anchor.category);
  const q = readQuery(pp);
  const base = queryParams(q);
  const { ranked, excluded } = rankCategory(q, st, ids ? { ids } : { subsOnly: true });
  if (!ranked.length) {
    return <div className="empty"><h1 className="h1">Некого ранжировать</h1><p><a href="#/categories">К поиску по категории →</a></p></div>;
  }
  const leader = ranked[0];
  const focusId = p.get("id");
  const focus = ranked.find((x) => x.supplier.id === focusId) ?? leader;
  const isLeader = focus === leader;
  const setParam = (patch: Record<string, string | null>) => navigate("/why", { ...paramsToObject(p), ...patch }, { replace: true });
  const weights = weightsFor(q.prio, q.cat);
  const gaps = asks(focus, q.cat);
  const lt = leaderText(leader, q.cat, q.volume);
  const back = ids ? href("/compare", { ...base, ids: ids.join(",") }) : href("/results", base);

  return (
    <div className="why-page">
      <div className="page-h">
        <div>
          <a className="crumb" href={back}>← {ids ? "Сравнение" : q.cat.name}</a>
          <h1 className="h1">{isLeader ? <>Почему {leader.supplier.name} первый</> : <>Разбор балла · {focus.supplier.name}</>}</h1>
        </div>
        <Seg label="Что важнее" options={PRIORITIES.map((x) => ({ id: x.id, label: x.label }))} value={q.prio}
          onChange={(v: Priority) => setParam({ prio: v === "balanced" ? null : v })} />
      </div>
      <p className="verdict"><b>Первым — {leader.supplier.name}:</b> {lt.why.charAt(0).toLowerCase() + lt.why.slice(1)} {lt.ask}</p>

      <div className="why-grid">
        <div>
          <div className="table-wrap">
            <table className="tbl why-tbl">
              <thead>
                <tr><th>Критерий</th><th className="r">Вес</th><th>Что известно</th><th className="w-bar">Оценка<Hint label="Как считается оценка">Неизвестное значение даёт треть балла критерия ({fmt1(UNKNOWN * 100)} из 100), а не ноль и не полный: неизвестность — повод уточнить, а не приговор. «Со слов поставщика» ◐ считается полностью, но помечено. Оценка ◇ видна для ориентира, а в балле считается как неизвестное.{q.cat.docs_critical && " Для этой категории вес документов +10 за счёт полноты и цен: без документов закупка невозможна."}</Hint></th><th className="r">Вклад</th></tr>
              </thead>
              <tbody>
                {CRITS.map((c) => {
                  const r = focus.crits[c.id];
                  return (
                    <tr key={c.id}>
                      <td>{c.label}</td>
                      <td className="r num">{weights[c.id]}</td>
                      <td><span className={r.known ? "" : "miss"}><StatusIcon status={r.mark} /> {r.text}</span></td>
                      <td><Rule value={r.score} compact right={r.known ? `${Math.round(r.score * 100)}` : "⅓"} /></td>
                      <td className="r num">{fmt1(focus.contrib[c.id])}</td>
                    </tr>
                  );
                })}
                <tr className="total"><td><b>Итого</b></td><td className="r num">100</td><td /><td /><td className="r"><Score value={focus.total} unit className="sm" /></td></tr>
              </tbody>
            </table>
          </div>

          <h2 className="section-h">Порядок при этих весах<Hint>Полоса — вклад критериев слева направо: надёжность, документы, минимальный заказ, доставка, цены, полнота. Нажмите на строку — откроется её разбор.</Hint></h2>
          <ol className="order">
            {ranked.map((sc, i) => (
              <li key={sc.supplier.id} className={sc === focus ? "on" : ""}>
                <button type="button" onClick={() => setParam({ id: sc.supplier.id })} aria-pressed={sc === focus}>
                  <span className="n num">{i + 1}</span>
                  <Mono s={sc.supplier} size={32} />
                  <span className="nm">{sc.supplier.name}</span>
                  <span className="stack" aria-hidden="true">
                    {CRITS.map((c) => <i key={c.id} style={{ width: `${sc.contrib[c.id]}%` }} title={c.short} />)}
                  </span>
                  <Score value={sc.total} className="sm" />
                </button>
              </li>
            ))}
          </ol>
        </div>

        <aside className="side">
          <div className="panel center">
            <Gauge value={focus.total} size={220} label={<>{focus.supplier.name}</>} />
            <a className="btn sec sm" href={href(`/s/${focus.supplier.id}`, base)}>Открыть карточку</a>
          </div>
          <div className="panel">
            <div className="panel-h"><b>Что уточнить в первом письме</b></div>
            <ul className="asks">{gaps.slice(0, 5).map((a) => <li key={a.key}><StatusIcon status={a.mark} /> {a.label}</li>)}</ul>
          </div>
          <div className="panel">
            <div className="panel-h"><b>Исключены<Hint>Стоп-условия — отдельно от баллов: ликвидация или банкротство, «не возит в ваш город», «это не поставщик».</Hint></b></div>
            {excluded.length ? (
              <ul className="ex-list">
                {excluded.map((e) => (
                  <li key={e.supplier.id}>
                    <Mono s={e.supplier} size={24} />
                    <div>
                      <a href={href(`/s/${e.supplier.id}`, base)}>{e.supplier.name}</a>
                      <div className="q plain"><StatusIcon status={e.mark} size={10} /> {e.reason}</div>
                      {e.canReturn && <button type="button" className="link-btn" onClick={() => actions.returnSupplier(e.supplier.id)}>вернуть в выдачу</button>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="q plain">Никого: все прошли стоп-условия.</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
