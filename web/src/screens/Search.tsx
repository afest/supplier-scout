import { useMemo, useState, type FormEvent } from "react";
import { href, navigate, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { baseCount, CATEGORIES, matchQuery, queryParams, readQuery, visibleSuppliers } from "../data.ts";
import { PRIORITIES, type Priority } from "../lib/score.ts";
import { num } from "../lib/format.ts";
import { Check, Hint, Seg } from "../components/ui.tsx";

export function Search({ route }: { route: Route }) {
  const st = useStore();
  const init = useMemo(() => {
    const p = route.params.has("cat") ? route.params : new URLSearchParams(st.last ? { cat: st.last.cat, sub: st.last.sub, vol: st.last.vol, prio: st.last.prio } : {});
    return readQuery(p);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState(init.q);
  const [catId, setCatId] = useState(route.params.has("cat") || st.last ? init.cat.id : "");
  const [subs, setSubs] = useState<string[]>(init.subs.length === init.cat.subcategories.length ? [] : init.subs);
  const [vol, setVol] = useState(init.volume ? num(init.volume) : "");
  const [prio, setPrio] = useState<Priority>(init.prio);
  const [region, setRegion] = useState(true);
  const [known, setKnown] = useState("");

  const match = useMemo(() => matchQuery(text), [text]);
  const counts = useMemo(() => {
    const vis = visibleSuppliers(st);
    return Object.fromEntries(CATEGORIES.map((c) => [c.id, vis.filter((s) => s.category === c.id).length]));
  }, [st]);

  const onText = (v: string) => {
    setText(v);
    const m = matchQuery(v);
    if (m) {
      setCatId(m.cat.id);
      setSubs([m.sub.id]);
    }
  };
  const pickCat = (id: string) => {
    setCatId(id);
    setSubs([]);
  };
  const toggleSub = (id: string) => setSubs((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const cat = CATEGORIES.find((c) => c.id === catId) ?? null;
  const unknownText = text.trim().length >= 3 && !match;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cat) return;
    const volume = Number(vol.replace(/\D/g, "")) || null;
    const q = { cat, subs: subs.length ? subs : cat.subcategories.map((s) => s.id), volume, prio, q: text.trim() };
    const params = queryParams(q);
    actions.rememberQuery({ cat: cat.id, sub: params.sub ?? "", vol: volume ? String(volume) : "", prio });
    navigate("/results", params);
  };

  return (
    <div className="search">
      <form className="search-main" onSubmit={submit}>
        <div className="label">Закупка для ресторанов · Екатеринбург</div>
        <h1 className="hero">Найти поставщика</h1>
        <p className="lead">Условия со всех сайтов в одной форме — <em>с источником у каждого поля</em> и подсказкой, кому написать первым.</p>

        <div className="block">
          <label className="label" htmlFor="q">
            Что ищем
            <Hint>Строка сводится к дереву категорий: «лосось охлаждённый» → рыба для суши. В продукте это делает языковая модель, в прототипе — словарь. Можно не писать, а выбрать категорию ниже.</Hint>
          </label>
          <input id="q" className="input xl" value={text} onChange={(e) => onText(e.target.value)} placeholder="например, контейнеры для роллов" autoComplete="off" />
          <div className="match" aria-live="polite">
            {match && <span className="match-chip">→ {match.cat.short} · {match.sub.name.toLowerCase()}</span>}
            {unknownText && <span className="match-chip off">в собранном наборе такой категории нет — выберите одну из четырёх</span>}
          </div>
        </div>

        <div className="block">
          <div className="label">
            Категория
            <Hint>Четыре категории собраны заранее — закупка суши- и пицца-сети. Другая категория в продукте — живой поиск на несколько минут; в демо он не подключён.</Hint>
          </div>
          <div className="cat-tiles" role="radiogroup" aria-label="Категория">
            {CATEGORIES.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={c.id === catId} className={`tile${c.id === catId ? " on" : ""}`} onClick={() => pickCat(c.id)}>
                <img src={c.illustration} alt="" width={132} height={132} />
                <span className="tile-name">{c.name}</span>
                <span className="tile-meta num">{counts[c.id]}</span>
              </button>
            ))}
          </div>
          {cat && (
            <div className="subs">
              {cat.subcategories.map((s) => (
                <button key={s.id} type="button" className={`pill-out sm${subs.includes(s.id) ? " on" : ""}`} aria-pressed={subs.includes(s.id)} onClick={() => toggleSub(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="params">
          <div>
            <label className="label" htmlFor="city">Город</label>
            <select id="city" className="input" defaultValue="ekb">
              <option value="ekb">Екатеринбург</option>
              <option disabled>Другие города — после сбора</option>
            </select>
            <Check checked={region} onChange={setRegion}>и Свердловская область</Check>
          </div>
          <div>
            <label className="label" htmlFor="vol">
              Закупка в неделю
              <Hint>Необязательно. Сравним с минимальным заказом поставщика: тот, у кого минимум больше вашей закупки, опустится ниже.</Hint>
            </label>
            <div className="input-unit">
              <input id="vol" className="input num" inputMode="numeric" value={vol} onChange={(e) => setVol(e.target.value.replace(/[^\d\s]/g, ""))} placeholder="20 000" />
              <span>₽</span>
            </div>
          </div>
        </div>

        <div className="block">
          <div className="label">
            Что важнее
            <Hint>Меняет веса рекомендации: надёжность, документы, минимальный заказ, доставка, цены. Тот же переключатель есть на разборе — порядок пересчитается без нового поиска.</Hint>
          </div>
          <Seg label="Что важнее" options={PRIORITIES.map((p) => ({ id: p.id, label: p.label }))} value={prio} onChange={setPrio} />
        </div>

        <div className="search-cta">
          <button className="btn pr xl" type="submit" disabled={!cat}>Найти поставщиков</button>
        </div>
      </form>

      <aside className="search-side">
        <div className="known">
          <div className="label light">Живой сбор</div>
          <h2>Уже знаете поставщика?</h2>
          <p>Вставьте сайт или ИНН — соберём карточку и сравним с остальными.</p>
          <form onSubmit={(e) => { e.preventDefault(); navigate("/add", { q: known.trim() || null }); }}>
            <input className="input" value={known} onChange={(e) => setKnown(e.target.value)} placeholder="сайт или ИНН" aria-label="Сайт или ИНН поставщика" />
            <button className="btn light" type="submit">Собрать данные</button>
          </form>
        </div>
        <a className="browse" href={href("/catalog")}>
          <span className="browse-imgs" aria-hidden="true">
            {CATEGORIES.map((c) => <img key={c.id} src={c.illustration} alt="" width={64} height={64} />)}
          </span>
          <span className="label">Не знаете, что нужно?</span>
          <b>Все {baseCount} поставщиков</b>
          <span className="browse-go">Смотреть по алфавиту →</span>
        </a>
      </aside>
    </div>
  );
}
