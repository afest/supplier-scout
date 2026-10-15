// «Все поставщики» — витрина для закупщика, который ещё не знает, что ему нужно: смотреть всех, как в магазине.
// По алфавиту, поиск по названию и товарам, те же фильтры, что в категории.
import { useEffect, useMemo } from "react";
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { CATEGORIES, catById, rankCategory, readQuery, visibleSuppliers } from "../data.ts";
import { completeness, stopReason } from "../lib/score.ts";
import { minRub, passes, readFilters } from "../lib/filters.ts";
import { plural } from "../lib/format.ts";
import { matchesSupplier } from "../lib/search.ts";
import type { Supplier } from "../types.ts";
import { inSelection, readSelection, selParams } from "../lib/selection.ts";
import { Check, Hint } from "../components/ui.tsx";
import { CategoryPicker } from "../components/CategoryPicker.tsx";
import { FilterRail, Railed } from "../components/FilterRail.tsx";
import { ListCard } from "../components/ListCard.tsx";

const SORTS = [
  { id: "az", label: "По алфавиту, А → Я" },
  { id: "za", label: "По алфавиту, Я → А" },
  { id: "rec", label: "По рекомендации" },
  { id: "min", label: "По минимальному заказу" },
  { id: "full", label: "По полноте данных" },
];

export function Catalog({ route }: { route: Route }) {
  const st = useStore();
  const p = route.params;
  const fs = readFilters(p);
  // тот же выбор, что в «Поиске по категории»: несколько категорий и в каждой свои подкатегории; пусто — все (T-541, круг 2)
  const sel = readSelection(p);
  const text = p.get("q") ?? "";
  const sort = p.get("sort") ?? "az";
  const showEx = p.get("ex") === "1";
  const setParam = (patch: Record<string, string | null>) => navigate("/catalog", { ...paramsToObject(p), ...patch }, { replace: true });
  useEffect(() => actions.setTrail("Все поставщики"), []);                       // «откуда» для шорт-листа (T-546)

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
  const pool = all.filter((s) => {
    const cat = catById(s.category)!;
    // подкатегория — все, кто её продаёт, из любой категории (T-538); категория целиком — по основной категории
    if (!inSelection(s, sel)) return false;
    if (!matchesSupplier(s, text)) return false;
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

  const markingAny = (sel.cats.length ? sel.cats : CATEGORIES).some((c) => c.marking_group);

  const cardParams = st.last ? { vol: st.last.vol || null, prio: st.last.prio === "balanced" ? null : st.last.prio } : {};
  const card = (s: Supplier) => {
    const stop = stopReason(s, returned);
    return (
      <ListCard key={s.id} variant="tile" s={s} cat={catById(s.category)!} href={href(`/s/${s.id}`, cardParams)} showCat
        score={stop ? null : scores.get(s.id) ?? 0} stop={stop} starred={!!st.shortlist[s.id]} onStar={() => actions.toggleShort(s.id)}
        tags={st.collected[s.id] ? <span className="fresh-pill">собрано сейчас</span> : undefined} />
    );
  };

  const head = (
    <>
      <div className="label">Каталог</div>
      <input className="input" type="search" value={text} onChange={(e) => setParam({ q: e.target.value || null })} placeholder="Название или товар" aria-label="Поиск по названию и товарам" />
      <CategoryPicker sel={sel} onChange={(next) => setParam(selParams(next))} state={st} />
    </>
  );

  const rail = (
    <FilterRail label="Поиск и фильтры" head={head} fs={fs} onChange={setParam} marking={markingAny} count={list.length}
      onReset={() => setParam({ f: null, max: null, unk: null, sub: null, cat: null, cats: null, q: null })} />
  );

  return (
    <Railed rail={rail}>
      <div className="catalog">
        <header className="cat-head">
          <h1 className="h1">Все поставщики</h1>
          <div className="cat-count"><span className="num">{list.length}</span>{plural(list.length, "поставщик", "поставщика", "поставщиков")}</div>
        </header>

        <div className="list">
          <div className="list-head">
            <div className="list-tools">
              <select className="input sm" value={sort} onChange={(e) => setParam({ sort: e.target.value === "az" ? null : e.target.value })} aria-label="Сортировка">
                {SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
              <Check checked={showEx} onChange={(v) => setParam({ ex: v ? "1" : null })}>исключённые · {stopped.length}</Check>
              <Hint>Балл — тот же, что в поиске: по объёму закупки и «что важнее» из последнего запроса, внутри своей категории. Исключённые — ликвидированные, не возящие в Екатеринбург и «не поставщики» — по умолчанию скрыты.</Hint>
            </div>
          </div>

          <div className="tile-grid">{sorted.map(card)}</div>
          {sorted.length === 0 && (
            <div className="empty-list">
              <p>Никого не нашли — ослабьте фильтры или поиск.</p>
              <button type="button" className="btn sec sm" onClick={() => setParam({ f: null, max: null, unk: null, q: null })}>Сбросить</button>
            </div>
          )}
        </div>
      </div>
    </Railed>
  );
}
