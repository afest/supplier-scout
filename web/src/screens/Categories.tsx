// Поиск по категории — как каталог интернет-магазина, с множественным выбором (T-541, круг 3): раскрыть можно сразу
// несколько категорий, в каждой отметить подкатегории или категорию целиком; справа — сколько поставщиков набралось
// и «Перейти к поставщикам». Раскрытые — в адресе (?open=…), выбор — теми же cat / cats / sub, что на выдаче.
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { useStore } from "../store.ts";
import { CATEGORIES, countIn, visibleSuppliers } from "../data.ts";
import { plural } from "../lib/format.ts";
import { inSelection, readSelection, selParams, selSummary, subsOf, toggleCat, toggleSub, type Selection } from "../lib/selection.ts";
import { CatGlyph, Hint } from "../components/ui.tsx";

/** Подкатегории под названием — первые три и «ещё N»: список берётся из данных и может вырасти до десятка (T-538). */
function preview(names: string[]) {
  const rest = names.length - 3;
  return rest > 1 ? `${names.slice(0, 3).join(" · ")} · ещё ${rest}` : names.join(" · ");
}

export function Categories({ route }: { route: Route }) {
  const st = useStore();
  const p = route.params;
  const open = new Set((p.get("open") ?? "").split(",").filter(Boolean));
  const sel = readSelection(p);
  const set = (patch: Record<string, string | null>) => navigate("/categories", { ...paramsToObject(p), ...patch }, { replace: true });
  const flip = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ open: [...next].join(",") || null });
  };
  const pick = (next: Selection) => set(selParams(next));
  // сколько поставщиков наберётся: категория целиком — по основной, подкатегория — все, кто продаёт (как на выдаче)
  const found = sel.cats.length ? visibleSuppliers(st).filter((s) => inSelection(s, sel)).length : 0;
  const go = () => navigate("/results", selParams(sel));

  return (
    <div className="cats-page">
      <div className="label">Найти поставщика · по категории</div>
      <h1 className="h1">Поиск по категории</h1>
      <p className="lead-sm">
        Откройте одну или несколько категорий и отметьте, что нужно: категорию целиком или подкатегории. Справа — сколько поставщиков набралось и переход к ним.
        <Hint label="Почему в подкатегории бывает больше, чем в категории">Категория — поставщики, для которых она основная. Подкатегория — все, у кого такие позиции есть на сайте, из любой категории: моцареллу продают и рыбные оптовики. Поэтому в «Молоке» может быть больше поставщиков, чем во всём «Сыре».</Hint>
      </p>

      <div className="cats-grid">
        <ul className="cat-acc">
          {CATEGORIES.map((c) => {
            const on = open.has(c.id);
            const n = countIn(c, null, st);
            const picked = sel.cats.some((x) => x.id === c.id);
            const own = picked ? subsOf(sel, c) : [];
            const whole = picked && !own.length;
            return (
              <li key={c.id} className={`${on ? "open" : ""}${picked ? " picked" : ""}`}>
                <button type="button" className="cat-acc-h" aria-expanded={on} aria-controls={`subs-${c.id}`} onClick={() => flip(c.id)}>
                  <img src={c.illustration} alt="" width={96} height={96} />
                  <span className="cat-acc-t">
                    <span className="cat-acc-name">{c.name}</span>
                    <span className="cat-acc-meta">{picked ? `Выбрано: ${own.length ? c.subcategories.filter((s) => own.includes(s.id)).map((s) => s.name.toLowerCase()).join(", ") : "вся категория"}` : preview(c.subcategories.map((s) => s.name.toLowerCase()))}</span>
                  </span>
                  <span className="cat-acc-n"><span className="num">{n}</span><span>{plural(n, "поставщик", "поставщика", "поставщиков")}</span></span>
                  <span className="chev" aria-hidden="true" />
                </button>
                {on && (
                  <ul className="cat-subs" id={`subs-${c.id}`} aria-label={`Подкатегории: ${c.name}`}>
                    <li>
                      <button type="button" className={`cat-sub all${whole ? " on" : ""}`} aria-pressed={whole} onClick={() => pick(toggleCat(sel, c))}>
                        <span className="cs-t"><CatGlyph cat={c} size={30} onDark /><b>Вся категория</b></span>
                        <span className="cs-f"><span className="cs-n num">{n}</span><span className="cs-mark" aria-hidden="true" /></span>
                      </button>
                    </li>
                    {c.subcategories.map((s) => {
                      const k = countIn(c, s.id, st);
                      const onSub = whole || own.includes(s.id);
                      return (
                        <li key={s.id}>
                          <button type="button" className={`cat-sub${onSub ? " on" : ""}`} aria-pressed={onSub} onClick={() => pick(toggleSub(sel, c, s.id))}>
                            <span className="cs-t"><b>{s.name}</b></span>
                            <span className="cs-f"><span className="cs-n num">{k}</span><span className="cs-mark" aria-hidden="true" /></span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        <aside className="cats-go" aria-label="Выбрано">
          <div className="label">Выбрано</div>
          {sel.cats.length ? (
            <>
              <div className="cats-go-n"><span className="num">{found}</span> {plural(found, "поставщик", "поставщика", "поставщиков")}</div>
              <ul className="cats-go-list">
                {sel.cats.map((c) => <li key={c.id}><CatGlyph cat={c} size={22} /> {selSummary({ cats: [c], subs: subsOf(sel, c) })}</li>)}
              </ul>
              <a className="btn pr cats-go-btn" href={href("/results", selParams(sel))} onClick={(e) => { e.preventDefault(); go(); }}>Перейти к поставщикам</a>
              <button type="button" className="link-btn" onClick={() => set({ cat: null, cats: null, sub: null })}>Сбросить выбор</button>
            </>
          ) : (
            <p className="cats-go-empty">Откройте категорию и отметьте её целиком или подкатегории — здесь появится, сколько поставщиков набралось.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
