// Поиск по категории — как каталог интернет-магазина: клик по категории раскрывает подкатегории со счётчиками,
// выбор ведёт на результаты — категорией целиком или одной подкатегорией. Открытая категория — в адресе (?open=).
import { href, navigate, type Route } from "../router.ts";
import { useStore } from "../store.ts";
import { CATEGORIES, countIn } from "../data.ts";
import { plural } from "../lib/format.ts";
import { CatGlyph } from "../components/ui.tsx";

/** Подкатегории под названием — первые три и «ещё N»: список берётся из данных и может вырасти до десятка (T-538). */
function preview(names: string[]) {
  const rest = names.length - 3;
  return rest > 1 ? `${names.slice(0, 3).join(" · ")} · ещё ${rest}` : names.join(" · ");
}

export function Categories({ route }: { route: Route }) {
  const st = useStore();
  const open = route.params.get("open");
  const toggle = (id: string) => navigate("/categories", { open: open === id ? null : id }, { replace: true });

  return (
    <div className="cats-page">
      <div className="label">Найти поставщика · по категории</div>
      <h1 className="h1">Поиск по категории</h1>
      <p className="lead-sm">Откройте категорию и выберите её целиком или одну подкатегорию. Внутри — рекомендация «кому написать первым», фильтры и поиск по категории.</p>

      <ul className="cat-acc">
        {CATEGORIES.map((c) => {
          const on = open === c.id;
          const n = countIn(c, null, st);
          return (
            <li key={c.id} className={on ? "open" : ""}>
              <button type="button" className="cat-acc-h" aria-expanded={on} aria-controls={`subs-${c.id}`} onClick={() => toggle(c.id)}>
                <img src={c.illustration} alt="" width={96} height={96} />
                <span className="cat-acc-t">
                  <span className="cat-acc-name">{c.name}</span>
                  <span className="cat-acc-meta">{preview(c.subcategories.map((s) => s.name.toLowerCase()))}</span>
                </span>
                <span className="cat-acc-n"><span className="num">{n}</span><span>{plural(n, "поставщик", "поставщика", "поставщиков")}</span></span>
                <span className="chev" aria-hidden="true" />
              </button>
              {on && (
                <ul className="cat-subs" id={`subs-${c.id}`} aria-label={`Подкатегории: ${c.name}`}>
                  <li>
                    <a className="cat-sub all" href={href("/results", { cat: c.id })}>
                      <span className="cs-t"><CatGlyph cat={c} size={30} onDark /><b>Вся категория</b></span>
                      <span className="cs-f"><span className="cs-n num">{n}</span><span className="cs-go" aria-hidden="true">→</span></span>
                    </a>
                  </li>
                  {c.subcategories.map((s) => {
                    const k = countIn(c, s.id, st);
                    return (
                      <li key={s.id}>
                        <a className="cat-sub" href={href("/results", { cat: c.id, sub: s.id })}>
                          <span className="cs-t"><b>{s.name}</b></span>
                          <span className="cs-f"><span className="cs-n num">{k}</span><span className="cs-go" aria-hidden="true">→</span></span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
