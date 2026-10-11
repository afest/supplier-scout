import { useEffect } from "react";
import { href, useRoute } from "./router.ts";
import { useStore } from "./store.ts";
import { baseCount, CATEGORIES, DATA } from "./data.ts";
import { dateRu } from "./lib/format.ts";
import { Popover } from "./components/ui.tsx";
import { Search } from "./screens/Search.tsx";
import { Results } from "./screens/Results.tsx";
import { Catalog } from "./screens/Catalog.tsx";
import { SupplierCard } from "./screens/SupplierCard.tsx";
import { Compare } from "./screens/Compare.tsx";
import { Why } from "./screens/Why.tsx";
import { Shortlist } from "./screens/Shortlist.tsx";
import { AddSupplier } from "./screens/AddSupplier.tsx";
import { AboutData } from "./screens/AboutData.tsx";

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="#fff" strokeWidth="1.4" strokeDasharray="1 2.2" />
        <circle cx="8" cy="8" r="1.8" fill="#FFFF00" />
      </svg>
    </span>
  );
}

function DemoBadge() {
  if (!DATA.meta.fixture) return null;
  return (
    <Popover className="demo-pop" label="Демо-данные" wide trigger={<span className="demo-btn"><i aria-hidden="true" />демо</span>}>
      <b>Демо-данные</b>
      <span>Поставщики и значения придуманы для прототипа интерфейса: домены .example, ИНН с неверной контрольной цифрой, телефоны с кодом 000. Их заменит набор, собранный конвейером из открытых источников.</span>
      <a href={href("/about-data")}>Как собираются данные →</a>
    </Popover>
  );
}

const NAV: { path: string; label: string; short: string; match: string[] }[] = [
  { path: "/", label: "Поиск", short: "Поиск", match: ["/", "/results", "/compare", "/why"] },
  { path: "/catalog", label: "Все поставщики", short: "Все", match: ["/catalog"] },
  { path: "/shortlist", label: "Шорт-лист", short: "Шорт-лист", match: ["/shortlist"] },
  { path: "/about-data", label: "Как собраны данные", short: "Данные", match: ["/about-data"] },
];

function Header({ path }: { path: string }) {
  const st = useStore();
  const n = Object.keys(st.shortlist).length;
  const on = (m: string[]) => m.some((x) => (x === "/" ? path === "/" || path === "" : path.startsWith(x)));
  return (
    <header className="top">
      <div className="wrap top-in">
        <a className="brand" href="#/">
          <BrandMark />
          <span className="brand-name">Поставщики</span>
        </a>
        <nav aria-label="Разделы">
          {NAV.map((x) => (
            <a key={x.path} className={on(x.match) ? "on" : ""} href={`#${x.path}`}>
              <span className="lg-only">{x.label}</span>
              <span className="sm-only">{x.short}</span>
              {x.path === "/shortlist" && n > 0 && <span className="count num">{n}</span>}
            </a>
          ))}
        </nav>
        <div className="top-right">
          <DemoBadge />
          <a className="top-add" href="#/add"><span aria-hidden="true">+</span><span className="lg-only"> Добавить по сайту или ИНН</span><span className="sm-only"> ИНН</span></a>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <span>{DATA.meta.city.name} · {CATEGORIES.length} категории · {baseCount} поставщиков · собрано {dateRu(DATA.meta.collected_at)}</span>
        <a href={href("/about-data")}>Как собраны данные →</a>
      </div>
    </footer>
  );
}

const TITLES: Record<string, string> = { "/": "Поиск", "/results": "Результаты", "/catalog": "Все поставщики", "/compare": "Сравнение", "/why": "Почему такой порядок", "/shortlist": "Шорт-лист", "/add": "Добавить поставщика", "/about-data": "Как собраны данные" };

export function App() {
  const route = useRoute();
  const { path } = route;
  useEffect(() => {
    const t = TITLES[path];
    if (t) document.title = `${t} · Поставщики`;
  }, [path]);

  let screen;
  if (path === "/" || path === "") screen = <Search route={route} />;
  else if (path === "/results") screen = <Results route={route} />;
  else if (path === "/catalog") screen = <Catalog route={route} />;
  else if (path.startsWith("/s/")) screen = <SupplierCard route={route} id={decodeURIComponent(path.slice(3))} />;
  else if (path === "/compare") screen = <Compare route={route} />;
  else if (path === "/why") screen = <Why route={route} />;
  else if (path === "/shortlist") screen = <Shortlist />;
  else if (path === "/add") screen = <AddSupplier route={route} />;
  else if (path === "/about-data") screen = <AboutData />;
  else screen = (
    <div className="empty">
      <h1 className="h1">Страница не найдена</h1>
      <p><a href="#/">Вернуться к поиску →</a></p>
    </div>
  );

  return (
    <>
      <Header path={path} />
      <main className="wrap main" id="main">{screen}</main>
      <Footer />
    </>
  );
}
