// Проверка аватара (T-541), только в dev-сборке: #/lab/avatar. Карточки списка с монограммой и с тестовым логотипом —
// в покое логотип синий, при наведении на карточку и при фокусе с клавиатуры — в своих цветах.
// Настоящие логотипы подключит T-543 через logoOf; тестовые знаки ниже придуманы и ни на чей логотип не похожи.
import { useStore } from "../store.ts";
import { CATEGORIES, catById, visibleSuppliers } from "../data.ts";
import type { Logo } from "../lib/logos.ts";
import { ListCard } from "../components/ListCard.tsx";

const svg = (body: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;
// цветной знак на прозрачном фоне: оранжевый круг, зелёный лист, тёмная черта
const TEST_LOGO: Logo = { src: svg(`<circle cx="26" cy="30" r="16" fill="#F28C28"/><path d="M34 40c0-14 10-24 24-24 0 14-10 24-24 24z" fill="#3BA55C"/><rect x="10" y="50" width="44" height="5" rx="2.5" fill="#1F2B40"/>`) };
// белый знак под тёмный фон (on_dark в logos.json)
const TEST_LOGO_DARK: Logo = { src: svg(`<circle cx="26" cy="30" r="16" fill="none" stroke="#fff" stroke-width="5"/><path d="M34 40c0-14 10-24 24-24 0 14-10 24-24 24z" fill="#fff"/><rect x="10" y="50" width="44" height="5" rx="2.5" fill="#fff"/>`), onDark: true };

export function AvatarLab() {
  const st = useStore();
  const [a, b, c] = visibleSuppliers(st);
  const cat = (id: string) => catById(id) ?? CATEGORIES[0];
  const cards = [
    { s: a, logo: undefined, t: "Монограмма — от наведения не меняется" },
    { s: b, logo: TEST_LOGO, t: "Тестовый логотип — синий в покое, свои цвета по наведению" },
    { s: c, logo: TEST_LOGO_DARK, t: "Белый логотип (onDark) — в покое инвертирован, в цвете на тёмной плашке" },
  ];
  return (
    <div className="lab">
      <h1 className="h1">Аватар · проверка</h1>
      {(["row", "tile"] as const).map((v) => (
        <section key={v} className="lab-sec">
          <div className="label">{v === "row" ? "Строка списка" : "Плитка"}</div>
          <div className={v === "row" ? "rows" : "tile-grid"}>
            {cards.map(({ s, logo, t }) => (
              <div key={s.id} className="lab-item">
                <p className="sub">{t}</p>
                <ListCard variant={v} s={s} cat={cat(s.category)} href={`#/s/${s.id}`} score={v === "row" ? 74 : 31} starred={false} onStar={() => {}} logo={logo} showCat={v === "tile"} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
