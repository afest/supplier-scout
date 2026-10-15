// Поиск по товару — по всему набору. Без запроса — вход: поле, примеры, подсказки при наборе.
// С запросом — результаты, сгруппированные по категориям; рекомендация «кому первым» живёт на странице категории.
// Несколько товаров через запятую (Павел 15.10): «молоко, сыр, тесто» → чипы над выдачей (выключить, добавить ещё),
// поиск по каждому, группы по охвату — «есть всё», «2 из 3»…; в карточке — какие из товаров у поставщика нашлись.
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { CATEGORIES, catById, defaultScores, visibleSuppliers } from "../data.ts";
import { buildIndex, norm, sameStem, search, suggest, type Hit, type Index, type Suggestion } from "../lib/search.ts";
import { passes, readFilters } from "../lib/filters.ts";
import { plural } from "../lib/format.ts";
import type { Category, Supplier } from "../types.ts";
import { CatGlyph, Hint } from "../components/ui.tsx";
import { CoverChips, ListCard } from "../components/ListCard.tsx";
import { FilterRail, Railed } from "../components/FilterRail.tsx";

const EXAMPLES = ["моцарелла", "контейнеры для роллов", "нори", "креветки"];
const KIND_LABEL: Record<Suggestion["kind"], string> = { sub: "подкатегория", item: "товар", supplier: "поставщик" };

/** Поле поиска с подсказками при наборе. Подсказки — только пока текст отличается от уже найденного запроса. */
function SearchBox({ q, vis, ix, big }: { q: string; vis: Supplier[]; ix: Index; big: boolean }) {
  const [text, setText] = useState(q);
  const [active, setActive] = useState(-1);
  useEffect(() => { setText(q); setActive(-1); }, [q]);
  const typing = text.trim().length >= 2 && text.trim() !== q;
  const sugg = useMemo(
    () => (typing ? suggest(text, vis, ix, { cat: (c) => href("/results", { cat: c.id }), sub: (c, s) => href("/results", { cat: c.id, sub: s.id }), find: (x) => href("/find", { q: x }), card: (s) => href(`/s/${s.id}`) }) : []),
    [typing, text, vis, ix],
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (active >= 0 && sugg[active]) window.location.hash = sugg[active].href;
    else if (text.trim()) navigate("/find", { q: text.trim() });
  };
  const onKey = (e: KeyboardEvent) => {
    if (!sugg.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % sugg.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i <= 0 ? sugg.length - 1 : i - 1)); }
    if (e.key === "Escape") setActive(-1);
  };
  return (
    <form className={`gsearch${big ? "" : " in-rail"}`} onSubmit={submit} role="search">
      <div className="gsearch-box">
        <svg className="gsearch-ic" width={big ? 22 : 18} height={big ? 22 : 18} viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="8" r="5.2" /><path d="M12 12l4 4" /></svg>
        <input id="q" className={`input${big ? " xl" : ""}`} value={text} onChange={(e) => { setText(e.target.value); setActive(-1); }} onKeyDown={onKey}
          placeholder={big ? "товар или поставщик; несколько — через запятую: молоко, сыр, тесто" : "товар или поставщик"} aria-label="Что ищем" autoComplete="off" autoFocus={big}
          role="combobox" aria-expanded={sugg.length > 0} aria-controls="sugg" aria-activedescendant={active >= 0 ? `sg-${active}` : undefined} />
        {big
          ? <button className="btn pr xl" type="submit" disabled={!text.trim()}>Найти</button>
          : <button className="gsearch-go" type="submit" disabled={!text.trim() || text.trim() === q} aria-label="Найти"><span aria-hidden="true">→</span></button>}
        {sugg.length > 0 && (
          <ul className="sugg" id="sugg" role="listbox" aria-label="Подсказки">
            {sugg.map((s, i) => (
              <li key={`${s.kind}-${s.label}-${i}`} id={`sg-${i}`} role="option" aria-selected={i === active}>
                <a className={i === active ? "on" : ""} href={s.href}>
                  <span className="sg-l">{s.label}</span>
                  <span className="sg-k">{KIND_LABEL[s.kind]} · {s.hint}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {big && (
        <div className="try">
          <span className="label">Например</span>
          {EXAMPLES.map((x) => <button key={x} type="button" className="pill-out sm" onClick={() => navigate("/find", { q: x })}>{x}</button>)}
        </div>
      )}
    </form>
  );
}

/** Подсветка слов, совпавших с запросом по основе. */
function Marked({ text, tokens }: { text: string; tokens: string[] }) {
  const parts = text.split(/(\s+)/);
  return <>{parts.map((p, i) => (tokens.some((t) => sameStem(t, norm(p))) ? <mark key={i}>{p}</mark> : p))}</>;
}

const VIA: Record<Hit["via"], string> = { item: "в товарах", subcategory: "подкатегория", name: "в названии" };

/** «молоко, сыр, тесто» → ["молоко", "сыр", "тесто"]; повтор без учёта регистра отбрасывается. Без запятой — один товар.
 *  Запятая между цифрами — часть товара: «молоко 3,2%», «0,5 л» (ревью Дир 63). Точка с запятой и перевод строки делят всегда. */
const TERM_SEP = /[;\n]|,(?!\d)|(?<!\d),/;
export function splitTerms(q: string) {
  const out: string[] = [];
  for (const t of q.split(TERM_SEP).map((x) => x.trim()).filter(Boolean)) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}
/** Выключенные товары в адресе (off=) — через «;»: внутри товара её не бывает, запрос по ней всегда делится. */
const OFF_SEP = ";";

/** Товары запроса чипами: число — сколько поставщиков с этим товаром проходит фильтры; клик выключает и включает товар. */
function TermsBar({ terms, off, counts, onToggle, onAdd }: {
  terms: string[]; off: Set<string>; counts: Map<string, number>; onToggle: (t: string) => void; onAdd: (t: string) => void;
}) {
  const [add, setAdd] = useState("");
  const many = terms.length > 1;
  return (
    <div className="terms-bar">
      <div className="assist-needs" role="group" aria-label="Товары в запросе">
        {terms.map((t) => {
          const on = !off.has(t);
          const n = counts.get(t) ?? 0;
          return (
            <button key={t} type="button" className={`assist-need${on ? " on" : ""}`} aria-pressed={on} disabled={!many} onClick={() => onToggle(t)}
              title={many ? (on ? "Убрать из поиска" : "Вернуть в поиск") : undefined}>
              <span>{t}</span><span className={`assist-n${n ? "" : " zero"}`}>{n || "нет"}</span>
            </button>
          );
        })}
      </div>
      <form className="terms-add" onSubmit={(e) => { e.preventDefault(); if (add.trim()) { onAdd(add); setAdd(""); } }}>
        <input className="input" value={add} onChange={(e) => setAdd(e.target.value)} maxLength={80} placeholder="Ещё товар" aria-label="Добавить товар в поиск" />
        <button type="submit" className="btn sec" disabled={!add.trim()}>Добавить</button>
      </form>
    </div>
  );
}

/** Найденное по нескольким товарам — одной строкой «где нашлось». */
const mergeHits = (hits: Hit[]): Hit => ({
  supplier: hits[0].supplier, matched: [...new Set(hits.flatMap((h) => h.matched))],
  via: hits.some((h) => h.via === "item") ? "item" : hits[0].via, n: hits.length,
});

export function Find({ route }: { route: Route }) {
  const st = useStore();
  const q = (route.params.get("q") ?? "").trim();
  const vis = useMemo(() => visibleSuppliers(st), [st]);
  const ix = useMemo(() => buildIndex(vis, CATEGORIES), [vis]);
  const terms = useMemo(() => splitTerms(q), [q]);
  const multi = terms.length > 1;
  const r = useMemo(() => search(multi ? "" : q, vis, ix), [multi, q, vis, ix]);
  const per = useMemo(() => terms.map((term) => ({ term, r: search(term, vis, ix) })), [terms, vis, ix]);
  const off = new Set((route.params.get("off") ?? "").split(OFF_SEP).filter((t) => terms.includes(t)));
  const active = per.filter((x) => !off.has(x.term));

  // балл — внутри своей категории, при запросе по умолчанию (закупка 20 000 ₽, сбалансированно)
  const scores = useMemo(() => defaultScores(st), [st]);

  // те же фильтры, что в категории (T-541): у каждого найденного — по его собственной категории
  const fs = readFilters(route.params);
  const setParam = (patch: Record<string, string | null>) => navigate("/find", { ...paramsToObject(route.params), ...patch }, { replace: true });
  const ok = (x: Supplier) => passes(x, catById(x.category)!, fs);
  const shown = r.hits.filter((h) => ok(h.supplier));
  // несколько товаров: поставщик → какие из включённых товаров у него нашлись
  const cover = new Map<string, { s: Supplier; terms: Set<string>; hits: Hit[] }>();
  for (const { term, r: tr } of active)
    for (const h of tr.hits) {
      const c = cover.get(h.supplier.id) ?? { s: h.supplier, terms: new Set<string>(), hits: [] };
      c.terms.add(term);
      c.hits.push(h);
      cover.set(h.supplier.id, c);
    }
  const shownMulti = [...cover.values()].filter((c) => ok(c.s));
  const byScore = (a: { s: Supplier }, b: { s: Supplier }) => (scores.get(b.s.id) ?? -1) - (scores.get(a.s.id) ?? -1) || a.s.name.localeCompare(b.s.name, "ru");
  const sections = active.map((_, i) => active.length - i)
    .map((k) => ({ k, items: shownMulti.filter((c) => c.terms.size === k).sort(byScore) })).filter((x) => x.items.length);
  const termCounts = new Map(per.map((x) => [x.term, x.r.hits.filter((h) => ok(h.supplier)).length]));
  const total = multi ? cover.size : r.hits.length;
  const shownN = multi ? shownMulti.length : shown.length;
  const hidden = total - shownN;
  const tokensAll = active.flatMap((x) => x.r.tokens);
  const toggleTerm = (t: string) => {
    const next = off.has(t) ? [...off].filter((x) => x !== t) : [...off, t];
    setParam({ off: next.length ? next.join(OFF_SEP) : null });
  };
  const addTerm = (t: string) => navigate("/find", { ...paramsToObject(route.params), q: splitTerms([...terms, t].join(", ")).join(", ") });

  const by = new Map<string, Hit[]>();
  for (const h of shown) by.set(h.supplier.category, [...(by.get(h.supplier.category) ?? []), h]);
  const groups = CATEGORIES.filter((c) => by.has(c.id)).map((c) => ({ cat: c, hits: by.get(c.id)! })).sort((a, b) => b.hits.length - a.hits.length);
  // «Честный знак» — только если среди найденных есть категория с маркировкой
  const found = multi ? [...cover.values()].map((c) => c.s) : r.hits.map((h) => h.supplier);
  const marking = CATEGORIES.some((c) => c.marking_group && found.some((x) => x.category === c.id));

  if (!q) {
    return (
      <div className="find find-entry">
        <div className="label">Найти поставщика · по товару</div>
        <h1 className="h1">Поиск по товару</h1>
        <p className="lead-sm">
          Ищет по товарам, подкатегориям и названиям во всём наборе — {vis.length} {plural(vis.length, "поставщик", "поставщика", "поставщиков")} в {CATEGORIES.length} категориях.
          <Hint>Окончания не мешают, опечатки исправляются: «моцарела» найдёт моцареллу. Подсказки появляются с двух букв: подкатегория, товар или поставщик.</Hint>
        </p>
        <SearchBox q="" vis={vis} ix={ix} big />
      </div>
    );
  }

  const rail = (
    <FilterRail label="Поиск и фильтры" fs={fs} onChange={setParam} onReset={() => setParam({ f: null, max: null, unk: null })} marking={marking} count={shownN}
      head={<><div className="label">Ключевое слово</div><SearchBox q={q} vis={vis} ix={ix} big={false} /></>} />
  );

  return (
    <Railed rail={rail}>
    <div className="find">
      <header className="find-h">
        <div className="label">Поиск по товару · {multi ? `${terms.length} ${plural(terms.length, "товар", "товара", "товаров")}` : "все категории"}</div>
        <h1 className="h1">«{multi ? terms.join(", ") : q}»</h1>
        {total > 0 && (
          <div className="find-count">
            <span className="num">{shownN}</span> {plural(shownN, "поставщик", "поставщика", "поставщиков")}
            {!multi && <> в {groups.length} {plural(groups.length, "категории", "категориях", "категориях")}</>}
            {hidden > 0 && <span className="muted"> · {hidden} скрыто фильтрами</span>}
          </div>
        )}
        <TermsBar terms={terms} off={off} counts={termCounts} onToggle={toggleTerm} onAdd={addTerm} />
      </header>

      {multi && (
        <>
          {sections.map(({ k, items }) => (
            <section key={k} className="find-group">
              <div className="find-group-h">
                <h2 className="section-h">{k === active.length ? (k > 1 ? "Есть всё, что ищете" : active[0].term) : `Есть ${k} из ${active.length}`} <span className="find-n num">{items.length}</span></h2>
              </div>
              <div className="rows">
                {items.map((c) => {
                  const cat = catById(c.s.category)!;
                  return (
                    <ListCard key={c.s.id} s={c.s} cat={cat} href={href(`/s/${c.s.id}`, { cat: cat.id })} showCat
                      score={scores.get(c.s.id) ?? null} starred={!!st.shortlist[c.s.id]} onStar={() => actions.toggleShort(c.s.id)}
                      extra={<><FoundIn h={mergeHits(c.hits)} tokens={tokensAll} />{active.length > 1 && <CoverChips items={active.map((x) => x.term)} has={c.terms} />}</>} />
                  );
                })}
              </div>
            </section>
          ))}
          {!active.length && <div className="empty-list"><p>Все товары выключены — включите хотя бы один чип выше.</p></div>}
          {active.length > 0 && cover.size > 0 && shownMulti.length === 0 && (
            <div className="empty-list">
              <p>Под фильтры никто из {cover.size} не подошёл.</p>
              <button type="button" className="btn sec sm" onClick={() => setParam({ f: null, max: null, unk: null })}>Сбросить фильтры</button>
            </div>
          )}
          {active.length > 0 && cover.size === 0 && <Empty q={active.map((x) => x.term).join(", ")} unknown={active.flatMap((x) => x.r.unknown)} related={[]} />}
        </>
      )}

      {!multi && r.corrected && (
        <div className="notice">Показываем по запросу <b>«{r.corrected}»</b> — похоже, в «{q}» опечатка.</div>
      )}

      {!multi && (r.subs.length > 0 || r.cats.length > 0) && (
        <div className="sub-jump">
          <span className="label">{r.cats.length ? "Категория" : "Подкатегория"} целиком — с рекомендацией, кому написать первым</span>
          <div className="sub-jump-list">
            {r.cats.map((cat) => (
              <a key={cat.id} className="pill-out" href={href("/results", { cat: cat.id })}><CatGlyph cat={cat} size={22} /> {cat.name} →</a>
            ))}
            {r.subs.map(({ cat, sub }) => (
              <a key={sub.id} className="pill-out" href={href("/results", { cat: cat.id, sub: sub.id })}><CatGlyph cat={cat} size={22} /> {sub.name} →</a>
            ))}
          </div>
        </div>
      )}

      {groups.map(({ cat, hits }) => (
        <section key={cat.id} className="find-group">
          <div className="find-group-h">
            <h2 className="section-h"><CatGlyph cat={cat} size={30} /> {cat.name} <span className="find-n num">{hits.length}</span></h2>
            <a href={href("/results", { cat: cat.id })}>Вся категория — кому написать первым →</a>
          </div>
          <div className="rows">
            {hits.map((h) => (
              <ListCard key={h.supplier.id} s={h.supplier} cat={cat} href={href(`/s/${h.supplier.id}`, { cat: cat.id })}
                score={scores.get(h.supplier.id) ?? null} starred={!!st.shortlist[h.supplier.id]} onStar={() => actions.toggleShort(h.supplier.id)}
                extra={<FoundIn h={h} tokens={r.tokens} />} />
            ))}
          </div>
        </section>
      ))}

      {!multi && r.hits.length > 0 && shown.length === 0 && (
        <div className="empty-list">
          <p>Под фильтры никто из {r.hits.length} не подошёл.</p>
          <button type="button" className="btn sec sm" onClick={() => setParam({ f: null, max: null, unk: null })}>Сбросить фильтры</button>
        </div>
      )}
      {!multi && r.hits.length === 0 && r.cats.length === 0 && <Empty q={q} unknown={r.unknown} related={r.relatedCats} />}
    </div>
    </Railed>
  );
}

/** Где нашлось слово: в товарах, в подкатегории или в названии. */
function FoundIn({ h, tokens }: { h: Hit; tokens: string[] }) {
  return (
    <div className="found-in">
      <span className="found-k">{VIA[h.via]}:</span>{" "}
      {h.matched.slice(0, 3).map((m, i) => <span key={i} className="found-v">{i > 0 && " · "}<Marked text={m} tokens={tokens} /></span>)}
      {h.matched.length > 3 && <span className="muted"> · ещё {h.matched.length - 3}</span>}
    </div>
  );
}

function Empty({ q, unknown, related }: { q: string; unknown: string[]; related: Category[] }) {
  const lines: ReactNode[] = [];
  if (unknown.length) lines.push(<>{unknown.length > 1 ? "Слов" : "Слова"} {unknown.map((u) => `«${u}»`).join(", ")} нет ни в одном товаре, подкатегории или названии поставщика.</>);
  return (
    <div className="find-empty">
      <h2 className="h2">В собранном наборе «{q}» не нашлось</h2>
      {lines.map((l, i) => <p key={i}>{l}</p>)}
      <p>Ищем по каталогам и прайсам, которые поставщики выкладывают на своих сайтах. Чего нет ни у кого из набора, того нет и здесь — похожее вместо искомого не подставляем.</p>
      {related.length > 0 && (
        <div className="find-related">
          <span className="label">Похожая категория</span>
          {related.map((c) => <a key={c.id} className="pill-out" href={href("/results", { cat: c.id })}><CatGlyph cat={c} size={22} /> {c.name} →</a>)}
        </div>
      )}
      <div className="row-btns empty-ways">
        <a className="btn sec" href="#/categories">Поиск по категории</a>
        <a className="btn sec" href="#/add">Знаю поставщика — добавить по сайту или ИНН</a>
        <a className="btn ghost" href="#/assistant">Помощник подберёт</a>
      </div>
    </div>
  );
}
