// Главная: четыре равных способа найти поставщика, каждый ведёт на свой экран.
// Поле поиска здесь не живёт — вход в поиск по товару на #/find.
import type { ReactNode } from "react";
import { CATEGORIES } from "../data.ts";
import { CatGlyph } from "../components/ui.tsx";

const SearchIc = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="5.2" /><path d="M12 12l4 4" /></svg>
);

// Графика плашек — у каждого способа свой силуэт, различимый и без цвета:
// поле с подсказками · четыре глифа категорий · реплика и варианты-кнопки · поле → карточка.
function ArtSearch() {
  return (
    <div className="art art-search" aria-hidden="true">
      <div className="art-field"><SearchIc /><span>моцарелла</span><i className="art-caret" /></div>
      <div className="art-sugg">
        <div><span>Моцарелла для пиццы</span><em>подкатегория</em></div>
        <div><span>Сыр и молочное</span><em>категория</em></div>
      </div>
    </div>
  );
}

function ArtCats() {
  return (
    <div className="art art-cats" aria-hidden="true">
      {CATEGORIES.map((c) => (
        <span key={c.id} className="art-cat"><CatGlyph cat={c} size={56} /><span>{c.short}</span></span>
      ))}
    </div>
  );
}

function ArtAssist() {
  return (
    <div className="art art-assist" aria-hidden="true">
      <div className="art-bubble">у меня бабл-ти в ТЦ</div>
      <div className="art-chips">
        {["молоко", "сиропы", "тапиока", "стаканы"].map((x, i) => <span key={x} className={i < 2 ? "on" : ""}>{x}</span>)}
      </div>
    </div>
  );
}

function ArtKnown() {
  return (
    <div className="art art-known" aria-hidden="true">
      <div className="art-field sm"><span>сайт или ИНН</span></div>
      <span className="art-arrow">→</span>
      <div className="art-card"><span className="art-mono">П</span><i /><i className="short" /><i className="tiny" /></div>
    </div>
  );
}

const WAYS: { to: string; title: string; when: string; ex: ReactNode; art: ReactNode; soon?: boolean }[] = [
  { to: "#/find", title: "Поиск по товару", when: "Знаю, какой товар нужен", ex: "моцарелла, нори", art: <ArtSearch /> },
  { to: "#/categories", title: "Поиск по категории", when: "Хочу посмотреть всех в категории", ex: "упаковка целиком или только коробки для пиццы", art: <ArtCats /> },
  { to: "#/assistant", title: "Помощник", when: "Не знаю, что нужно — опишу точку", ex: "у меня бабл-ти в ТЦ", art: <ArtAssist />, soon: true },
  { to: "#/add", title: "Знаю поставщика", when: "Уже есть на примете — проверить и сравнить", ex: "сайт или ИНН", art: <ArtKnown /> },
];

export function Search() {
  return (
    <div className="home">
      <section className="home-head">
        <div className="label">Закупка для ресторанов · Екатеринбург</div>
        <h1 className="hero">Найти поставщика</h1>
        <p className="lead">Условия со всех сайтов в одной форме — <em>с источником у каждого поля</em> и подсказкой, кому написать первым.</p>
      </section>

      <section className="ways" aria-label="Способы найти поставщика">
        {WAYS.map((w) => (
          <a key={w.to} className="way" href={w.to}>
            {w.art}
            <div className="way-body">
              <div className="way-t">
                <h2>{w.title}</h2>
                {w.soon && <span className="way-soon">скоро</span>}
                <span className="way-go" aria-hidden="true">→</span>
              </div>
              <p className="way-when">{w.when}</p>
              <div className="way-ex"><span className="label">Например</span><span>{w.ex}</span></div>
            </div>
          </a>
        ))}
      </section>
    </div>
  );
}
