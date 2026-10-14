// Поиск по товару — по всему набору. Без запроса — вход: поле, примеры, подсказки при наборе.
// С запросом — результаты, сгруппированные по категориям; рекомендация «кому первым» живёт на странице категории.
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { href, navigate, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { CATEGORIES, rankCategory, readQuery, visibleSuppliers } from "../data.ts";
import { buildIndex, norm, sameStem, search, suggest, type Hit, type Index, type Suggestion } from "../lib/search.ts";
import { isKnown, plural } from "../lib/format.ts";
import type { Category, Supplier } from "../types.ts";
import { CatGlyph, Hint, Mono, Score, StarButton, StatusIcon } from "../components/ui.tsx";
import { RowBadges, supplierMeta } from "../components/supplier.tsx";

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
    <form className={`gsearch${big ? "" : " sm"}`} onSubmit={submit} role="search">
      <div className="gsearch-box">
        <svg className="gsearch-ic" width={big ? 22 : 20} height={big ? 22 : 20} viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="8" r="5.2" /><path d="M12 12l4 4" /></svg>
        <input id="q" className={`input ${big ? "xl" : "lg"}`} value={text} onChange={(e) => { setText(e.target.value); setActive(-1); }} onKeyDown={onKey}
          placeholder={big ? "товар или поставщик: моцарелла, нори, крафт-пакет" : "товар или поставщик"} aria-label="Что ищем" autoComplete="off" autoFocus={big}
          role="combobox" aria-expanded={sugg.length > 0} aria-controls="sugg" aria-activedescendant={active >= 0 ? `sg-${active}` : undefined} />
        <button className={`btn pr${big ? " xl" : ""}`} type="submit" disabled={!text.trim()}>Найти</button>
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

export function Find({ route }: { route: Route }) {
  const st = useStore();
  const q = (route.params.get("q") ?? "").trim();
  const vis = useMemo(() => visibleSuppliers(st), [st]);
  const ix = useMemo(() => buildIndex(vis, CATEGORIES), [vis]);
  const r = useMemo(() => search(q, vis, ix), [q, vis, ix]);

  // балл — внутри своей категории, при запросе по умолчанию (закупка 20 000 ₽, сбалансированно)
  const scores = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of CATEGORIES) for (const sc of rankCategory(readQuery(new URLSearchParams({ cat: c.id })), st).ranked) m.set(sc.supplier.id, sc.total);
    return m;
  }, [st]);

  const groups = useMemo(() => {
    const by = new Map<string, Hit[]>();
    for (const h of r.hits) by.set(h.supplier.category, [...(by.get(h.supplier.category) ?? []), h]);
    return CATEGORIES.filter((c) => by.has(c.id)).map((c) => ({ cat: c, hits: by.get(c.id)! })).sort((a, b) => b.hits.length - a.hits.length);
  }, [r]);

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

  return (
    <div className="find">
      <SearchBox q={q} vis={vis} ix={ix} big={false} />

      <header className="find-h">
        <div className="label">Поиск по товару · все категории</div>
        <h1 className="h1">«{q}»</h1>
        {r.hits.length > 0 && <div className="find-count"><span className="num">{r.hits.length}</span> {plural(r.hits.length, "поставщик", "поставщика", "поставщиков")} в {groups.length} {plural(groups.length, "категории", "категориях", "категориях")}</div>}
      </header>

      {r.corrected && (
        <div className="notice">Показываем по запросу <b>«{r.corrected}»</b> — похоже, в «{q}» опечатка.</div>
      )}

      {(r.subs.length > 0 || r.cats.length > 0) && (
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
              <FindRow key={h.supplier.id} h={h} cat={cat} tokens={r.tokens} score={scores.get(h.supplier.id)} starred={!!st.shortlist[h.supplier.id]} />
            ))}
          </div>
        </section>
      ))}

      {r.hits.length === 0 && r.cats.length === 0 && <Empty q={q} unknown={r.unknown} related={r.relatedCats} />}
    </div>
  );
}

function FindRow({ h, cat, tokens, score, starred }: { h: Hit; cat: Category; tokens: string[]; score: number | undefined; starred: boolean }) {
  const s = h.supplier;
  return (
    <div className="row find-row">
      <Mono s={s} size={48} />
      <div className="row-main">
        <div className="row-title"><a className="nm" href={href(`/s/${s.id}`, { cat: cat.id })}>{s.name}</a></div>
        <div className="row-meta">{!isKnown(s.company) && <StatusIcon status="not_found" size={10} />} {supplierMeta(s)}</div>
        <div className="found-in">
          <span className="found-k">{VIA[h.via]}:</span>{" "}
          {h.matched.slice(0, 3).map((m, i) => <span key={i} className="found-v">{i > 0 && " · "}<Marked text={m} tokens={tokens} /></span>)}
          {h.matched.length > 3 && <span className="muted"> · ещё {h.matched.length - 3}</span>}
        </div>
        <RowBadges s={s} cat={cat} />
      </div>
      <div className="row-score">
        {score !== undefined ? <><Score value={score} /><span className="rank-n">балл в категории</span></> : <span className="ex-tag">исключён</span>}
      </div>
      <StarButton on={starred} onClick={() => actions.toggleShort(s.id)} />
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
