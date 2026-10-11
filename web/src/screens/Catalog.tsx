// «Все поставщики» — витрина для закупщика, который ещё не знает, что ему нужно: смотреть всех, как в магазине.
// По алфавиту с указателем букв, поиск по названию и товарам, те же фильтры, что в результатах поиска.
import { useMemo, useState } from "react";
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { CATEGORIES, catById, rankCategory, readQuery, visibleSuppliers } from "../data.ts";
import { completeness, stopReason } from "../lib/score.ts";
import { activeCount, minRub, passes, readFilters } from "../lib/filters.ts";
import { isKnown, plural } from "../lib/format.ts";
import type { Supplier } from "../types.ts";
import { CatGlyph, Check, Comb, Hint, Mono, Score, StarButton, StatusIcon } from "../components/ui.tsx";
import { FiltersPanel, SubcatChecks } from "../components/Filters.tsx";
import { RowBadges, supplierMeta } from "../components/supplier.tsx";

const SORTS = [
  { id: "az", label: "По алфавиту, А → Я" },
  { id: "za", label: "По алфавиту, Я → А" },
  { id: "rec", label: "По рекомендации" },
  { id: "min", label: "По минимальному заказу" },
  { id: "full", label: "По полноте данных" },
];

const firstLetter = (s: Supplier) => s.name.replace(/^[«"]/, "")[0].toUpperCase();

export function Catalog({ route }: { route: Route }) {
  const st = useStore();
  const p = route.params;
  const fs = readFilters(p);
  const cats = (p.get("cats") ?? "").split(",").map((id) => catById(id)).filter(Boolean) as typeof CATEGORIES;
  const single = cats.length === 1 ? cats[0] : null;
  const subs = single ? (p.get("sub") ?? "").split(",").filter((id) => single.subcategories.some((x) => x.id === id)) : [];
  const text = p.get("q") ?? "";
  const sort = p.get("sort") ?? "az";
  const showEx = p.get("ex") === "1";
  const [sheet, setSheet] = useState(false);
  const setParam = (patch: Record<string, string | null>) => navigate("/catalog", { ...paramsToObject(p), ...patch }, { replace: true });
  const toggleCat = (id: string) => {
    const ids = cats.map((c) => c.id);
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setParam({ cats: next.join(",") || null, sub: null });
  };

  // балл — по сохранённому запросу (объём, «что важнее»), в каждой категории свой рейтинг
  const scores = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of CATEGORIES) {
      const q = readQuery(new URLSearchParams({ cat: c.id, ...(st.last ? { vol: st.last.vol, prio: st.last.prio } : {}) }));
      for (const sc of rankCategory(q, st).ranked) m.set(sc.supplier.id, sc.total);
    }
    return m;
  }, [st]);

  const returned = new Set(st.returned);
  const all = visibleSuppliers(st);
  const needle = text.trim().toLowerCase().replace(/ё/g, "е");
  const pool = all.filter((s) => {
    const cat = catById(s.category)!;
    if (cats.length && !cats.some((c) => c.id === s.category)) return false;
    if (subs.length && !s.subcategories.some((x) => subs.includes(x))) return false;
    if (needle && !`${s.name} ${(s.products.value ?? []).join(" ")}`.toLowerCase().replace(/ё/g, "е").includes(needle)) return false;
    return passes(s, cat, fs);
  });
  const stopped = pool.filter((s) => stopReason(s, returned));
  const list = showEx ? pool : pool.filter((s) => !stopReason(s, returned));

  const sorted = [...list];
  const az = (a: Supplier, b: Supplier) => a.name.localeCompare(b.name, "ru");
  if (sort === "az") sorted.sort(az);
  if (sort === "za") sorted.sort((a, b) => az(b, a));
  if (sort === "rec") sorted.sort((a, b) => (scores.get(b.id) ?? -1) - (scores.get(a.id) ?? -1));
  if (sort === "min") sorted.sort((a, b) => (minRub(a) ?? Infinity) - (minRub(b) ?? Infinity));
  if (sort === "full") sorted.sort((a, b) => completeness(b).found - completeness(a).found);

  const alpha = sort === "az" || sort === "za";
  const groups: { letter: string; items: Supplier[] }[] = [];
  if (alpha) for (const s of sorted) {
    const l = firstLetter(s);
    if (groups[groups.length - 1]?.letter !== l) groups.push({ letter: l, items: [] });
    groups[groups.length - 1].items.push(s);
  }
  const letters = groups.map((g) => g.letter);
  const markingAny = (cats.length ? cats : CATEGORIES).some((c) => c.marking_group);

  const firstOfLetter = new Set(groups.map((g) => g.items[0].id));
  const card = (s: Supplier) => {
    const cat = catById(s.category)!;
    const c = completeness(s);
    const stop = stopReason(s, returned);
    const starts = alpha && firstOfLetter.has(s.id);
    return (
      <article key={s.id} className={`shop-card${stop ? " stopped" : ""}`} id={starts ? `L-${firstLetter(s)}` : undefined}>
        {starts && <span className="sc-letter" aria-hidden="true">{firstLetter(s)}</span>}
        <div className="sc-top">
          <Mono s={s} size={52} />
          <div className="sc-score">
            {stop ? <span className="ex-tag" title={stop.reason}>исключён</span> : <Score value={scores.get(s.id) ?? 0} />}
          </div>
        </div>
        <a className="nm" href={href(`/s/${s.id}`, st.last ? { vol: st.last.vol || null, prio: st.last.prio === "balanced" ? null : st.last.prio } : {})}>{s.name}</a>
        <div className="sc-cat"><CatGlyph cat={cat} size={22} /> {cat.short}{st.collected[s.id] && <span className="fresh-pill">собрано сейчас</span>}</div>
        <div className="row-meta">{!isKnown(s.company) && <StatusIcon status="not_found" size={10} />} {supplierMeta(s)}</div>
        {stop ? <div className="sc-stop"><StatusIcon status={stop.mark} size={10} /> {stop.reason}</div> : <RowBadges s={s} cat={cat} />}
        <div className="sc-foot">
          <Comb found={c.found} total={c.total} />
          <StarButton on={!!st.shortlist[s.id]} onClick={() => actions.toggleShort(s.id)} />
        </div>
      </article>
    );
  };

  return (
    <div className="catalog">
      <header className="cat-head">
        <div>
          <div className="label">Каталог</div>
          <h1 className="h1">Все поставщики</h1>
        </div>
        <div className="cat-count"><span className="num">{list.length}</span>{plural(list.length, "поставщик", "поставщика", "поставщиков")}</div>
      </header>

      <div className="cat-bar">
        <input className="input lg" type="search" value={text} onChange={(e) => setParam({ q: e.target.value || null })} placeholder="Название или товар: моцарелла, нори, крафт-пакет" aria-label="Поиск по названию и товарам" />
        <div className="cat-chips" role="group" aria-label="Категории">
          <button type="button" className={`cat-chip-btn${cats.length === 0 ? " on" : ""}`} aria-pressed={cats.length === 0} onClick={() => setParam({ cats: null, sub: null })}>Все</button>
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={`cat-chip-btn${cats.some((x) => x.id === c.id) ? " on" : ""}`} aria-pressed={cats.some((x) => x.id === c.id)} onClick={() => toggleCat(c.id)}>
              <img src={c.illustration} alt="" width={36} height={36} />{c.short}
            </button>
          ))}
        </div>
      </div>

      <div className="lr">
        <aside className={`filters${sheet ? " open" : ""}`} aria-label="Фильтры">
          <FiltersPanel state={fs} onChange={setParam} marking={markingAny} count={list.length}
            onClose={() => setSheet(false)} onReset={() => setParam({ f: null, max: null, unk: null, sub: null, cats: null, q: null })}
            top={single ? <SubcatChecks cat={single} value={subs.length ? subs : single.subcategories.map((x) => x.id)} onChange={(next) => setParam({ sub: next.length === single.subcategories.length ? null : next.join(",") })} /> : undefined} />
        </aside>
        {sheet && <div className="scrim" onClick={() => setSheet(false)} />}

        <div className="list">
          <div className="list-head">
            <div className="list-tools">
              <select className="input sm" value={sort} onChange={(e) => setParam({ sort: e.target.value === "az" ? null : e.target.value })} aria-label="Сортировка">
                {SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
              <Check checked={showEx} onChange={(v) => setParam({ ex: v ? "1" : null })}>исключённые · {stopped.length}</Check>
              <Hint>Балл — тот же, что в поиске: по объёму закупки и «что важнее» из последнего запроса, внутри своей категории. Исключённые — ликвидированные, не возящие в Екатеринбург и «не поставщики» — по умолчанию скрыты.</Hint>
            </div>
            <button type="button" className="btn sec sm sm-only" onClick={() => setSheet(true)}>Фильтры{activeCount(fs) ? ` · ${activeCount(fs)}` : ""}</button>
          </div>
          {alpha && letters.length > 1 && (
            <nav className="az" aria-label="Буквы">
              {letters.map((l) => (
                <button key={l} type="button" onClick={() => document.getElementById(`L-${l}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{l}</button>
              ))}
            </nav>
          )}

          <div className="shop-grid">{sorted.map(card)}</div>
          {sorted.length === 0 && (
            <div className="empty-list">
              <p>Никого не нашли — ослабьте фильтры или поиск.</p>
              <button type="button" className="btn sec sm" onClick={() => setParam({ f: null, max: null, unk: null, q: null })}>Сбросить</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
