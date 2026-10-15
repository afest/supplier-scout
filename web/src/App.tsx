import { useEffect, type ReactNode } from "react";
import { href, useRoute } from "./router.ts";
import { useStore } from "./store.ts";
import { baseCount, DATA, shortlistIds } from "./data.ts";
import { AvaFilters, Popover } from "./components/ui.tsx";
import { Footer } from "./components/Footer.tsx";
import { Search } from "./screens/Search.tsx";
import { Find } from "./screens/Find.tsx";
import { Categories } from "./screens/Categories.tsx";
import { Results } from "./screens/Results.tsx";
import { Catalog } from "./screens/Catalog.tsx";
import { SupplierCard } from "./screens/SupplierCard.tsx";
import { Compare } from "./screens/Compare.tsx";
import { Why } from "./screens/Why.tsx";
import { Shortlist } from "./screens/Shortlist.tsx";
import { AddSupplier } from "./screens/AddSupplier.tsx";
import { AboutData } from "./screens/AboutData.tsx";
import { Assistant } from "./screens/Assistant.tsx";
import { AvatarLab } from "./screens/AvatarLab.tsx";

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

// Линейные значки 18 px — у каждого пункта меню свой силуэт, различимый без цвета.
const ICONS: Record<string, ReactNode> = {
  search: <><circle cx="8" cy="8" r="5.2" /><path d="M12 12l4 4" /></>,
  assistant: <><path d="M9 2.5l1.4 3.6L14 7.5l-3.6 1.4L9 12.5 7.6 8.9 4 7.5l3.6-1.4z" /><path d="M14.5 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" /></>,
  add: <><rect x="2.5" y="2.5" width="13" height="13" rx="4" /><path d="M9 6v6M6 9h6" /></>,
  categories: <><rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.6" /><rect x="10" y="2.5" width="5.5" height="5.5" rx="1.6" /><rect x="2.5" y="10" width="5.5" height="5.5" rx="1.6" /><rect x="10" y="10" width="5.5" height="5.5" rx="1.6" /></>,
  all: <><path d="M7 4.5h8.5M7 9h8.5M7 13.5h8.5" /><circle cx="3.3" cy="4.5" r=".9" /><circle cx="3.3" cy="9" r=".9" /><circle cx="3.3" cy="13.5" r=".9" /></>,
  shortlist: <path d="M9 2.3l2 4.2 4.6.6-3.3 3.2.8 4.6L9 12.7 4.9 14.9l.8-4.6L2.4 7.1 7 6.5z" />,
  about: <><circle cx="9" cy="9" r="6.5" /><path d="M9 8.2v4.3M9 5.6v.1" /></>,
};
const Icon = ({ name }: { name: string }) => (
  <svg className="nav-ic" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>
);

function SideNav({ path }: { path: string }) {
  const st = useStore();
  const n = shortlistIds(st).length;
  const item = (to: string, icon: string, label: string, on: boolean, extra?: ReactNode) => (
    <a className={`nav-item${on ? " on" : ""}`} href={`#${to}`} aria-current={on ? "page" : undefined}>
      <Icon name={icon} /><span className="nav-l">{label}</span>{extra}
    </a>
  );
  // каталог категорий и всё, что живёт внутри категории (результаты, разбор, сравнение, карточка)
  const inCat = path === "/categories" || path === "/results" || path === "/why" || path === "/compare" || path.startsWith("/s/");
  return (
    <aside className="side-nav" aria-label="Разделы">
      <div className="side-top">
        <a className="brand" href="#/">
          <BrandMark />
          <span className="brand-name">Поставщики</span>
        </a>
        <DemoBadge />
      </div>
      <nav className="nav-main">
        <div className="nav-group">
          {item("/find", "search", "Поиск по товару", path === "/find")}
          {item("/categories", "categories", "Поиск по категории", inCat)}
          {item("/assistant", "assistant", "Помощник", path === "/assistant")}
          {item("/add", "add", "Знаю поставщика", path === "/add")}
        </div>
        <div className="nav-group">
          {item("/catalog", "all", "Все поставщики", path === "/catalog", <span className="nav-n num">{baseCount}</span>)}
          {item("/shortlist", "shortlist", "Шорт-лист", path === "/shortlist", n > 0 ? <span className="count num">{n}</span> : undefined)}
          {item("/about-data", "about", "Как собраны данные", path === "/about-data")}
        </div>
      </nav>
    </aside>
  );
}

const TITLES: Record<string, string> = { "/": "Найти поставщика", "/find": "Поиск по товару", "/categories": "Поиск по категории", "/results": "Категория", "/catalog": "Все поставщики", "/compare": "Сравнение", "/why": "Почему такой порядок", "/shortlist": "Шорт-лист", "/add": "Добавить поставщика", "/about-data": "Как собраны данные", "/assistant": "Помощник" };

export function App() {
  const route = useRoute();
  const { path } = route;
  useEffect(() => {
    const t = TITLES[path];
    if (t) document.title = `${t} · Поставщики`;
  }, [path]);

  // экраны с колонкой фильтров (T-541): колонка сразу после меню, поэтому выдача сама задаёт себе поля
  // и страница поставщика (T-543): слева её колонка — меню разделов, на «Разборе» — «что важнее»
  const railed = path === "/results" || path === "/catalog" || (path === "/find" && !!route.params.get("q")?.trim()) || path.startsWith("/s/");

  let screen;
  if (path === "/" || path === "") screen = <Search />;
  else if (path === "/find") screen = <Find route={route} />;
  else if (path === "/categories") screen = <Categories route={route} />;
  else if (path === "/results") screen = <Results route={route} />;
  else if (path === "/catalog") screen = <Catalog route={route} />;
  else if (path.startsWith("/s/")) screen = <SupplierCard route={route} id={decodeURIComponent(path.slice(3))} />;
  else if (path === "/compare") screen = <Compare route={route} />;
  else if (path === "/why") screen = <Why route={route} />;
  else if (path === "/shortlist") screen = <Shortlist />;
  else if (path === "/add") screen = <AddSupplier route={route} />;
  else if (path === "/about-data") screen = <AboutData />;
  else if (path === "/assistant") screen = <Assistant route={route} />;
  else if (import.meta.env.DEV && path === "/lab/avatar") screen = <AvatarLab />;
  else screen = (
    <div className="empty">
      <h1 className="h1">Страница не найдена</h1>
      <p><a href="#/">На главную →</a></p>
    </div>
  );

  return (
    <div className="app">
      <AvaFilters />
      <SideNav path={path} />
      <div className="app-col">
        <main className={railed ? "main railed-page" : "wrap main"} id="main">{screen}</main>
        {!railed && <Footer />}
      </div>
    </div>
  );
}
