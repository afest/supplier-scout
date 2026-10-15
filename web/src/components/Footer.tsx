import { CATEGORIES, DATA, baseCount } from "../data.ts";
import { href } from "../router.ts";
import { dateRu } from "../lib/format.ts";

/** Подвал. На экранах с колонкой фильтров он внутри правой части — колонка стоит на месте до конца страницы (T-541). */
export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <span>{DATA.meta.city.name} · {CATEGORIES.length} категории · {baseCount} поставщиков · собрано {dateRu(DATA.meta.collected_at)}</span>
        <a href={href("/about-data")}>Как собраны данные →</a>
      </div>
    </footer>
  );
}
