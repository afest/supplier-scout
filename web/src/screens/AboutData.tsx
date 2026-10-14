import { useMemo } from "react";
import { DATA, baseCount, CATEGORIES } from "../data.ts";
import { TRACKED } from "../lib/score.ts";
import { dateRu, isKnown } from "../lib/format.ts";
import type { FieldStatus } from "../types.ts";
import { CatGlyph, Hint, Rule, STATUS_LABEL, STATUS_SHORT, StatusIcon } from "../components/ui.tsx";

const PIPE = [
  { n: "1", t: "Кандидаты", d: "веб-поиск по подкатегории и городу, три формулировки запроса" },
  { n: "2", t: "Фильтр", d: "поставщик ли это: агрегаторы, розница и рестораны отсеиваются; город — по адресу и региону ИНН" },
  { n: "3", t: "Сайт и поля", d: "5–6 страниц; модель раскладывает текст по полям, без дословной цитаты значение отбрасывается" },
  { n: "4", t: "Проверка по ИНН", d: "ФНС, Росаккредитация, «Честный знак», Федресурс" },
  { n: "5", t: "Балл", d: "стоп-условия и формула с весами; текст объяснения — шаблоном" },
];

const SOURCES: { name: string; gives: string; status: FieldStatus | null }[] = [
  { name: "Сайт поставщика", gives: "условия, цены, доставка, контакты, ИНН в реквизитах", status: "claimed" },
  { name: "Веб-поиск", gives: "кандидаты: сайты поставщиков", status: null },
  { name: "ФНС: ЕГРЮЛ, «Прозрачный бизнес»", gives: "статус, возраст, ОКВЭД, выручка, красные флаги", status: "found" },
  { name: "Росаккредитация", gives: "декларации на продукцию по ИНН заявителя", status: "found" },
  { name: "«Честный знак»", gives: "рыба и молочное: группы маркировки участника", status: "found" },
  { name: "Федресурс", gives: "банкротство — стоп-условие", status: "found" },
  { name: "Рыночные ориентиры", gives: "цены и минимальный заказ, где поставщик их не публикует", status: "estimated" },
  { name: "2ГИС", gives: "только ссылка «на карте»: хранить данные запрещают условия", status: null },
];

export function AboutData() {
  const set = DATA.suppliers.filter((s) => !s.live_only);
  // «склад» считаем по значению, а не по заполненности: «только доставка» — тоже заполненное поле
  const rows = useMemo(() => TRACKED.map((t) => (t.key === "presence"
    ? { ...t, label: "Склад в Екатеринбурге", n: set.filter((s) => isKnown(s.presence) && s.presence.value === "warehouse").length }
    : { ...t, n: set.filter((s) => isKnown(t.get(s) as never)).length })).sort((a, b) => b.n - a.n), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="about">
      <div className="label">Для проверяющего и недоверчивого закупщика</div>
      <h1 className="h1">Как собраны данные</h1>
      <p className="lead-sm">У каждого поля — источник и статус. Государственный реестр, слова поставщика, оценка по рынку и «не нашли» различаются формой знака, чтобы пустое поле не выглядело ошибкой, а оценка — фактом.</p>

      <ol className="pipe dark">
        {PIPE.map((x) => (
          <li key={x.n}><span className="pipe-n num">{x.n}</span><b>{x.t}</b><span>{x.d}</span></li>
        ))}
      </ol>

      <div className="legend">
        {(["found", "claimed", "not_found", "estimated", "user"] as FieldStatus[]).map((s) => (
          <div key={s}><StatusIcon status={s} size={16} /><b>{STATUS_SHORT[s]}</b><span>{STATUS_LABEL[s].split(": ")[1] ?? STATUS_LABEL[s]}</span></div>
        ))}
      </div>

      <div className="about-grid">
        <section className="panel">
          <div className="panel-h"><b>Полнота по полям{DATA.meta.fixture && <Hint>Сейчас здесь демо-набор: цифры посчитаны по придуманным поставщикам и показывают, как экран будет выглядеть. Полноту настоящего сбора подставит прогон конвейера.</Hint>}</b><span className="sub">{baseCount} поставщиков · {DATA.meta.fixture ? "демо-набор" : `собрано ${dateRu(DATA.meta.collected_at)}`}</span></div>
          <div className="fill-rows">
            {rows.map((r) => (
              <Rule key={r.key} value={r.n / set.length} left={r.label} right={`${r.n} из ${set.length}`} compact />
            ))}
          </div>
        </section>

        <section>
          <div className="panel">
            <div className="panel-h"><b>Источники</b></div>
            <table className="tbl">
              <thead><tr><th>Источник</th><th>Что даёт</th><th>Знак</th></tr></thead>
              <tbody>
                {SOURCES.map((s) => (
                  <tr key={s.name}><td>{s.name}</td><td className="sub">{s.gives}</td><td>{s.status ? <StatusIcon status={s.status} /> : "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel dont">
            <div className="panel-h"><b><span className="warn-mark" aria-hidden="true">!</span>Чего сервис не делает</b></div>
            <ul>
              <li>не выдаёт оценку за факт: ◇ видна, но в балле считается как неизвестное</li>
              <li>не обходит запрет сайта на сбор и защиту каталогов от ботов</li>
              <li>не хранит данные карт и не парсит каталоги поставщиков</li>
              <li>не пишет поставщикам сам: письмо отправляет закупщик</li>
            </ul>
          </div>
          <div className="panel cats">
            <div className="panel-h"><b>Категории набора</b></div>
            {CATEGORIES.map((c) => (
              <div key={c.id} className="cat-line"><CatGlyph cat={c} size={28} /><span>{c.name}</span><span className="num sub">{set.filter((s) => s.category === c.id).length}</span></div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
