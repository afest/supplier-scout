import { useEffect, useMemo, useState } from "react";
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, MAX_COMPARE, useStore } from "../store.ts";
import { byId, categoryOf, inCategory, queryParams, rankCategory, readQuery, volParam, type Query } from "../data.ts";
import type { Category } from "../types.ts";
import { readSelection, selParams, subsOf } from "../lib/selection.ts";
import { CategoryPicker } from "../components/CategoryPicker.tsx";
import { leaderText, followerText } from "../lib/explain.ts";
import { bigWholesale, BIG_WHOLESALE, completeness, firstToWrite, PRIORITIES, type Priority, type Scored } from "../lib/score.ts";
import { minRub, passes, readFilters } from "../lib/filters.ts";
import { isKnown, num, plural } from "../lib/format.ts";
import { matchesSupplier } from "../lib/search.ts";
import { logoOf } from "../lib/logos.ts";
import { ReviewBadge, Avatar, CatGlyph, Check, FillBar, Hint, Score, ScoreNum, StarButton, StatusIcon } from "../components/ui.tsx";
import { useReviewStat } from "../lib/reviewStats.ts";
import { FilterRail, Railed } from "../components/FilterRail.tsx";
import { ListCard } from "../components/ListCard.tsx";
import { Basis, companyShort, deliveryShort, documentsShort, GuestTag, minOrderShort, pricesShort, subBasis } from "../components/supplier.tsx";

export function Results({ route }: { route: Route }) {
  const st = useStore();
  const p = route.params;
  // несколько категорий и в каждой свои подкатегории (T-541, круг 2); без категории рекомендовать нечего — одна обязательна
  const sel = readSelection(p, { required: true });
  const multi = sel.cats.length > 1;
  const q0 = readQuery(p, sel.cats[0].id);
  const fs = readFilters(p);
  const view = p.get("view") === "table" ? "table" : "list";
  const sort = p.get("sort") ?? "rec";
  const inText = p.get("in") ?? "";
  const [openEx, setOpenEx] = useState<Record<string, boolean>>({});
  const [vol, setVol] = useState(q0.volume ? num(q0.volume) : "");
  useEffect(() => setVol(q0.volume ? num(q0.volume) : ""), [q0.volume]);
  const commitVol = () => {
    const v = Number(vol.replace(/\D/g, ""));
    setParam({ vol: v > 0 ? (v === 20000 ? null : String(v)) : "0" });
  };
  const setParam = (patch: Record<string, string | null>) => navigate("/results", { ...paramsToObject(p), ...patch }, { replace: true });

  // балл и «кому написать первым» считаются внутри категории — поэтому выдача по разделам, раздел на категорию
  const selKey = `${sel.cats.map((c) => c.id).join()}|${sel.subs.join()}`;
  const ranks = useMemo(() => sel.cats.map((cat) => {
    const own = subsOf(sel, cat);
    const q: Query = { cat, subs: own.length ? own : cat.subcategories.map((s) => s.id), volume: q0.volume, prio: q0.prio, q: "" };
    return { cat, q, ...rankCategory(q, st, { subsOnly: true }) };
  }), [selKey, q0.volume, q0.prio, st]);
  const sections = ranks.map((r) => {
    const visible = r.ranked.filter((sc) => passes(sc.supplier, r.cat, fs) && matchesSupplier(sc.supplier, inText));
    const sorted = [...visible];
    if (sort === "min") sorted.sort((a, b) => (minRub(a.supplier) ?? Infinity) - (minRub(b.supplier) ?? Infinity));
    if (sort === "full") sorted.sort((a, b) => completeness(b.supplier).found - completeness(a.supplier).found);
    // место — по рекомендации, а не номер строки: при другой сортировке остаётся тем же
    const place = new Map(visible.map((sc, i) => [sc.supplier.id, i + 1]));
    return { ...r, visible, sorted, place, top: firstToWrite(visible), base: queryParams(r.q) };
  });
  const shown = sections.reduce((n, s) => n + s.visible.length, 0);
  const hidden = sections.reduce((n, s) => n + s.ranked.length - s.visible.length, 0);

  const first = sections[0];
  useEffect(() => {
    actions.rememberQuery({ cat: first.cat.id, sub: first.base.sub ?? "", vol: q0.volume ? String(q0.volume) : "0", prio: q0.prio });
  }, [first.cat.id, first.base.sub, q0.volume, q0.prio]);

  // сравнивают поставщиков одной категории (и гостей из чужих по подкатегории): отметка из другой категории начинает выбор заново
  const fits = (id: string, cat: Category) => { const s = byId.get(id); return !!s && inCategory(s, cat); };
  const compareCat = sections.find((s) => st.compare.some((id) => fits(id, s.cat)))?.cat ?? null;
  const compareIds = compareCat ? st.compare.filter((id) => fits(id, compareCat)) : [];
  const onCompare = (id: string, cat: Category) => {
    if (!st.compare.every((x) => fits(x, cat))) actions.setCompare([id]);
    else actions.toggleCompare(id);
  };
  const unknownKept = fs.max !== null && fs.keepUnknown && sections.some((s) => s.visible.some((sc) => minRub(sc.supplier) === null));

  const head = (
    <>
      <a className="crumb" href={href("/categories", { open: sel.cats.map((c) => c.id).join(","), ...selParams(sel) })}>← Поиск по категории</a>
      <input className="input" type="search" value={inText} onChange={(e) => setParam({ in: e.target.value || null })}
        placeholder="Название или товар" aria-label="Поиск по названию и товарам в выбранном" />
      <CategoryPicker sel={sel} onChange={(next) => setParam(selParams(next))} state={st} required />

      <div className="rail-params" role="group" aria-label="Параметры рекомендации">
        <div className="rp-f">
          <span className="rp-k">Город <Hint label="Город">Набор собран по Екатеринбургу; другие города — тем же конвейером с другим параметром. Регион учитывается в рекомендации: склад в городе, доставка до точки или только транспортной компанией; кто в город не возит — в «Исключены».</Hint></span>
          <span className="rp-v">Екатеринбург</span>
        </div>
        <form className="rp-f" onSubmit={(e) => { e.preventDefault(); commitVol(); }}>
          <span className="rp-k">Закупка в неделю <Hint label="Закупка в неделю">Сравниваем с минимальным заказом поставщика. Минимум в килограммах или штуках переводим в рубли по ориентиру цены категории.</Hint></span>
          <span className="rp-in">
            <input className="num" inputMode="numeric" value={vol} aria-label="Закупка в неделю, рублей" placeholder="не задана"
              onChange={(e) => setVol(e.target.value.replace(/[^\d\s]/g, ""))} onBlur={commitVol} />
            <span>₽</span>
          </span>
        </form>
        <label className="rp-f">
          <span className="rp-k">Что важнее</span>
          <select className="input sm" value={q0.prio} onChange={(e) => setParam({ prio: (e.target.value as Priority) === "balanced" ? null : e.target.value })}>
            {PRIORITIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      </div>
    </>
  );

  const rail = (
    <FilterRail label="Категории и фильтры" head={head} fs={fs} onChange={setParam} onReset={() => setParam({ f: null, max: null, unk: null })}
      marking={sel.cats.some((c) => !!c.marking_group)} count={shown} />
  );

  const title = multi ? sel.cats.map((c) => c.short).join(" · ") : sel.cats[0].name;
  const empty = (
    <div className="empty-list">
      <p>{inText ? `По «${inText}» в выбранном никого.` : "Под фильтры никто не подошёл."}</p>
      <button type="button" className="btn sec sm" onClick={() => setParam({ f: null, max: null, unk: null, in: null })}>Сбросить</button>
      {inText && <p><a href={href("/find", { q: inText })}>Искать «{inText}» во всех категориях →</a></p>}
    </div>
  );

  return (
    <Railed rail={rail}>
    <div className="results">
      {/* сначала текст, картинки категорий — у правого края, первая крайняя справа, следующие внахлёст влево; текст может лечь поверх (Павел, круг 3) */}
      <header className="res-head">
        <div className="res-title">
          <div className="label">{multi ? `Поиск по категории · ${sel.cats.length} ${plural(sel.cats.length, "категория", "категории", "категорий")}` : "Поиск по категории"}</div>
          <h1 className="h1">{title}</h1>
        </div>
        <div className="res-illu" aria-hidden="true">{sel.cats.map((c) => <img key={c.id} src={c.illustration} alt="" width={120} height={120} />)}</div>
      </header>
      <div className="res-bar">
        <div className="list-count">
          <span className="big num">{shown}</span>
          <span>{plural(shown, "поставщик", "поставщика", "поставщиков")}{hidden > 0 && <span className="muted"> · {hidden} скрыто фильтрами</span>}</span>
          {unknownKept && <Hint label="Почему остались без минимума">Поставщики без минимального заказа в рублях оставлены в списке и помечены ○: фильтр не выкидывает неизвестное молча. Снимите «и где не указан», чтобы их скрыть.</Hint>}
        </div>
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

      {shown === 0 && empty}

      {sections.map((sec) => {
        const cardHref = (id: string) => href(`/s/${id}`, { ...sec.base });
        const exOpen = !!openEx[sec.cat.id];
        if (multi && !sec.visible.length && !sec.excluded.length) return null;
        return (
          <section key={sec.cat.id} className="res-sec" aria-label={sec.cat.name}>
            {multi && (
              <div className="res-sec-h">
                <h2 className="section-h"><CatGlyph cat={sec.cat} size={30} /> {sec.cat.name} <span className="find-n num">{sec.visible.length}</span></h2>
                {subsOf(sel, sec.cat).length > 0 && <div className="res-sec-subs">{sec.cat.subcategories.filter((s) => sec.q.subs.includes(s.id)).map((s) => s.name).join(" · ")}</div>}
              </div>
            )}
            {sec.top.length > 0 && <FirstZone top={sec.top} q={sec.q} cardHref={cardHref} whyHref={href(`/s/${sec.top[0].supplier.id}`, { ...sec.base, tab: "why" })} />}

            <div className="list">
              {view === "list" ? (
                <div className="rows">
                  {sec.sorted.map((sc) => (
                    <Row key={sc.supplier.id} sc={sc} rank={sec.place.get(sc.supplier.id)!} q={sec.q} hrefCard={cardHref(sc.supplier.id)}
                      starred={!!st.shortlist[sc.supplier.id]} collected={!!st.collected[sc.supplier.id]} />
                  ))}
                </div>
              ) : (
                sec.sorted.length > 0 && <ResultsTable list={sec.sorted} q={sec.q} cardHref={cardHref} compareIds={compareIds} onCompare={(id) => onCompare(id, sec.cat)} shortlist={st.shortlist} />
              )}
              {multi && shown > 0 && sec.sorted.length === 0 && <p className="res-sec-empty">В этой категории под фильтры никто не подошёл.</p>}

              {sec.excluded.length > 0 && (
                <div className="excluded">
                  <button type="button" className="excluded-toggle" aria-expanded={exOpen} onClick={() => setOpenEx((o) => ({ ...o, [sec.cat.id]: !exOpen }))}>
                    Исключены из рекомендации{multi ? ` · ${sec.cat.short.toLowerCase()}` : ""} · {sec.excluded.length} <span aria-hidden="true">{exOpen ? "↑" : "↓"}</span>
                  </button>
                  <Hint>Стоп-условия считаются отдельно от баллов: ликвидация или банкротство, «не возит в ваш город», «это не поставщик». Решение «не поставщик» можно отменить руками.</Hint>
                  {exOpen && (
                    <ul>
                      {sec.excluded.map((e) => (
                        <li key={e.supplier.id}>
                          <Avatar s={e.supplier} size={32} logo={logoOf(e.supplier.id)} />
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
          </section>
        );
      })}

      {compareCat && compareIds.length > 0 && (
        <div className="selbar" role="region" aria-label="Выбрано для сравнения">
          <div className="selbar-in">
            <span className="sel-monos">{compareIds.map((id) => <Avatar key={id} s={byId.get(id)!} size={28} logo={logoOf(id)} />)}</span>
            <span>Выбрано {compareIds.length} из {MAX_COMPARE}</span>
            <button type="button" className="link-btn" onClick={() => actions.setCompare([])}>очистить</button>
            <a className={`btn pr${compareIds.length < 2 ? " disabled" : ""}`} aria-disabled={compareIds.length < 2}
              href={compareIds.length < 2 ? undefined : href("/compare", { ids: compareIds.join(","), vol: volParam(q0.volume), prio: q0.prio === "balanced" ? null : q0.prio, cat: compareCat.id })}>
              Сравнить
            </a>
          </div>
        </div>
      )}
    </div>
    </Railed>
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
                <Avatar s={sc.supplier} logo={logoOf(sc.supplier.id)} />
                <div>
                  <div className="nm">{sc.supplier.name}</div>
                  <GcardReviews id={sc.supplier.id} />
                  <div className="sub">{c.status === "found" ? `${sc.supplier.company.value!.form} · ${c.text.replace("действует ", "")}` : "компания не проверена"}</div>
                  <GuestTag s={sc.supplier} cat={q.cat} own={categoryOf(sc.supplier)} />
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

/** Оценка по отзывам в карточке «Кому написать первым» — если отзывы есть (T-543). */
function GcardReviews({ id }: { id: string }) {
  const rs = useReviewStat(id);
  return rs ? <ReviewBadge stat={rs} size="sm" /> : null;
}

/** Строка списка — общая карточка (T-541). Сравнение отмечается в виде «Таблица»: в карточке второй кнопкой остаётся только звёздочка. */
function Row({ sc, rank, q, hrefCard, starred, collected }: { sc: Scored; rank: number; q: Query; hrefCard: string; starred: boolean; collected: boolean }) {
  const s = sc.supplier;
  const basis = subBasis(s, q.cat, q.subs);
  const tags = (
    <>
      {collected && <span className="fresh-pill">собрано сейчас</span>}
      {bigWholesale(sc) && (
        <span className="opt-pill">крупный опт
          <Hint label="Крупный опт">Минимальный заказ больше вашей закупки в {Math.round(sc.crits.min_order.ratio!).toLocaleString("ru-RU")} раз. Когда минимум больше закупки в {BIG_WHOLESALE} раз и сильнее, поставщика нет в «Кому написать первым»; место в списке — по баллу, как у всех.</Hint>
        </span>
      )}
      <GuestTag s={s} cat={q.cat} own={categoryOf(s)} />
    </>
  );
  return (
    <ListCard s={s} cat={q.cat} href={hrefCard} score={sc.total} rank={rank} starred={starred} onStar={() => actions.toggleShort(s.id)}
      tags={tags} extra={basis.length > 0 ? <Basis items={basis} /> : undefined} />
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
                <td><a className="nm" href={cardHref(s.id)}>{s.name}</a><GuestTag s={s} cat={q.cat} own={categoryOf(s)} /></td>
                <td className="r"><ScoreNum value={sc.total} size="sm" /></td>
                <td>{cell(minOrderShort(s))}</td>
                <td>{isKnown(s.delivery) ? cell({ status: s.delivery.status, text: deliveryShort(s.delivery.value!) }) : cell({ status: "not_found", text: "не найдено" })}</td>
                <td>{cell(pricesShort(s))}</td>
                <td>{cell(documentsShort(s, q.cat))}</td>
                <td>{cell(companyShort(s))}</td>
                <td><FillBar found={c.found} total={c.total} compact /></td>
                <td><StarButton on={!!shortlist[s.id]} onClick={() => actions.toggleShort(s.id)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
