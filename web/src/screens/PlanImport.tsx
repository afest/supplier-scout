// План закупа (T-546): файл .xlsx / .csv или колонка из Excel → строки с названиями → один вызов модели на сервере
// (позиция, поисковые слова, группа набора) → поставщики по каждой позиции кодом → итог «у кого брать»: до трёх
// поставщиков на весь план, по формуле из lib/plan.ts, без модели. Файл читается в браузере, на сервер уходят только
// названия. Состояние — вне компонента и в sessionStorage вкладки: переход к поставщику и «назад» его не сбрасывают.
import { useEffect, useMemo, useState, useSyncExternalStore, type DragEvent } from "react";
import { href } from "../router.ts";
import { carry, useStore } from "../store.ts";
import { byId, CATEGORIES, catById, categoryOf, defaultScored } from "../data.ts";
import { isKnown, plural } from "../lib/format.ts";
import { bigWholesale, type Scored } from "../lib/score.ts";
import { logoOf } from "../lib/logos.ts";
import { ApiError, cachedHealth, health, plan, type Health, type PlanPosition, type PlanResult } from "../lib/api.ts";
import { decodeText, PlanError, planFromTable, PLAN_MAX, readDelimited, readXlsx, verdict, type PlanRead, type Table, type Verdict } from "../lib/plan.ts";
import { Avatar, CatGlyph, Hint, Score, StatusIcon } from "../components/ui.tsx";
import { CoverChips, ListCard } from "../components/ListCard.tsx";
import { deliveryShort, minOrderShort } from "../components/supplier.tsx";
import { Wait } from "../components/AssistWait.tsx";

const EXAMPLE = "plan-sushi-bar.xlsx";          // web/public: тот же файл скачивается кнопкой — его можно открыть и загрузить самому
const EXAMPLE_URL = `${import.meta.env.BASE_URL}${EXAMPLE}`;
const EXAMPLE_NAME = "План закупа — суши-бар.xlsx";
const FILE_MAX = 5 * 1024 * 1024;
const LINES_SHOWN = 8;
const CARDS_SHOWN = 6;
const PHRASES = ["Читаю строки плана", "Отделяю бренд и фасовку от товара", "Раскладываю по категориям набора", "Ищу позиции в ассортименте поставщиков"];
const OOPS = "Что-то пошло не так. Попробуйте ещё раз.";
/** Как называть группу в итоге: «упаковка — U2B, рыба — Редфиш». */
const ROLE: Record<string, string> = { packaging: "упаковка", fish: "рыба", dairy: "молочное", grocery: "бакалея", other: "прочее" };
const NUM = ["", "один", "два", "три"];

// ---- состояние экрана ----
interface Source { kind: "file" | "paste" | "example"; name: string; sheet?: string }
interface Saved {
  source: Source | null;
  paste: string;                     // текст в поле вставки
  table: Table | null;               // прочитанная таблица
  col: number | null;                // колонка названий, выбранная вручную
  res: PlanResult | null;
  sent: string[] | null;             // строки, на которые пришёл ответ: сменили файл или колонку — ответ уже не про них
}
interface State extends Saved {
  busy: "read" | "plan" | null;
  since: number;
  err: { at: "read" | "plan"; text: string } | null;
}
const KEY = "supplier-scout:plan";
const EMPTY: State = { source: null, paste: "", table: null, col: null, res: null, sent: null, busy: null, since: 0, err: null };
let state: State = (() => {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw), busy: null, err: null } : EMPTY;
  } catch {
    return EMPTY;
  }
})();
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  try {
    const { busy: _b, since: _s, err: _e, ...keep } = state;
    sessionStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* хранилище недоступно или переполнено — план живёт до перезагрузки */
  }
  listeners.forEach((l) => l());
}
const usePlan = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => state);

let inflight: AbortController | null = null;

async function tableOf(name: string, buf: ArrayBuffer): Promise<{ table: Table; sheet?: string }> {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "xlsx") return readXlsx(buf);
  if (ext === "csv" || ext === "tsv" || ext === "txt") return { table: readDelimited(decodeText(new Uint8Array(buf))) };
  if (ext === "xls") throw new PlanError("Старый формат .xls не читается — сохраните файл в Excel как «Книга Excel (.xlsx)» или как CSV.");
  throw new PlanError("Подойдёт файл .xlsx или .csv — или вставьте колонку из Excel в поле справа.");
}

async function load(kind: Source["kind"], name: string, getBuf: () => Promise<ArrayBuffer>) {
  if (state.busy) return;
  set({ busy: "read", err: null });
  try {
    const { table, sheet } = await tableOf(name, await getBuf());
    set({ source: { kind, name, sheet }, table, col: null, res: null, sent: null, paste: "" });
  } catch (e) {
    set({ err: { at: "read", text: e instanceof PlanError ? e.message : "Файл не прочитался. Сохраните его в Excel как .xlsx или CSV и попробуйте ещё раз." } });
  } finally {
    set({ busy: null });
  }
}

function loadFile(f: File) {
  if (f.size > FILE_MAX) {
    set({ err: { at: "read", text: "Файл больше 5 МБ — для плана закупа это много. Оставьте в нём лист с позициями." } });
    return;
  }
  load("file", f.name, () => f.arrayBuffer());
}

function loadExample() {
  load("example", EXAMPLE_NAME, async () => {
    const r = await fetch(EXAMPLE_URL);
    if (!r.ok) throw new PlanError("Пример не загрузился — обновите страницу.");
    return r.arrayBuffer();
  });
}

function pasted(text: string) {
  const has = !!text.trim();
  set({ paste: text, table: has ? readDelimited(text, { comma: false }) : null, source: has ? { kind: "paste", name: "вставка" } : null,
    col: null, res: null, sent: null, err: null });
}

async function run(lines: string[]) {
  if (!lines.length || state.busy) return;
  const ctl = new AbortController();
  inflight = ctl;
  set({ busy: "plan", since: Date.now(), err: null });
  try {
    const res = await plan(lines, ctl.signal);
    set({ res, sent: lines });
  } catch (e) {
    const timeout = ctl.signal.aborted && ctl.signal.reason === "timeout";
    if (!ctl.signal.aborted || timeout) {
      set({ err: { at: "plan", text: timeout ? "Модель не ответила за полторы минуты. Попробуйте ещё раз — если ответ всё же придёт, повтор того же плана лимит не потратит."
        : e instanceof ApiError ? e.message : OOPS } });
    }
  } finally {
    if (inflight === ctl) inflight = null;
    set({ busy: null });
  }
}

function reset() {
  inflight?.abort("cancel");
  set({ source: null, paste: "", table: null, col: null, res: null, sent: null, err: null });
}

const same = (a: string[] | null, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

export function PlanImport() {
  const st = usePlan();
  const [hl, setHl] = useState<Health | null>(cachedHealth);
  const [drag, setDrag] = useState(false);
  const [allLines, setAllLines] = useState(false);
  const read = useMemo(() => (st.table ? planFromTable(st.table, st.col) : null), [st.table, st.col]);
  const fresh = !!read && !!st.res && same(st.sent, read.lines);
  useEffect(() => { health().then(setHl).catch(() => setHl(null)); }, [st.res]);

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  };
  const left = hl?.demo_left.assist;
  const error = (at: "read" | "plan") => st.err?.at === at && <div className="panel warn"><b>{st.err.text}</b></div>;

  return (
    <>
      <div className="plan-in">
        <label className={`plan-drop${drag ? " on" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={drop}>
          <input type="file" className="sr-only" accept=".xlsx,.csv,.tsv,.txt" disabled={!!st.busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }} />
          <FileGlyph />
          <span className="plan-drop-t"><u>Выберите файл</u> или перетащите сюда</span>
          <span className="sub">.xlsx или .csv — файл читается в браузере, на сервер уходят только названия позиций</span>
        </label>
        <span className="plan-or" aria-hidden="true">или</span>
        <textarea className="input plan-paste" value={st.paste} onChange={(e) => pasted(e.target.value)} rows={5} aria-label="Вставьте колонку из Excel"
          placeholder={"Вставьте колонку из Excel — позиция в строке:\nРис для суши 25 кг\nНори Gold 50 листов\nСоевый соус Kikkoman 1 л"} />
      </div>
      <div className="examples">
        <span className="label">Пример</span>
        <button type="button" className="pill-out sm" disabled={!!st.busy} onClick={loadExample}>Попробовать на примере: суши-бар на доставке</button>
        <a className="link-btn" href={EXAMPLE_URL} download={EXAMPLE_NAME}>Скачать файл примера</a>
      </div>
      {error("read")}

      {read && st.source && (
        <section className="panel plan-read" aria-label="Что прочитано">
          <div className="plan-read-h">
            <div>
              <div className="label">Прочитано</div>
              <p className="plan-read-n"><b className="num">{read.lines.length}</b> {plural(read.lines.length, "позиция", "позиции", "позиций")}
                <span className="sub"> · {st.source.kind === "paste" ? "из вставленного текста" : `${st.source.kind === "example" ? "пример" : "файл"} «${st.source.name}»${st.source.sheet ? `, лист «${st.source.sheet}»` : ""}`}</span>
              </p>
            </div>
            <button type="button" className="assist-clear plan-clear" disabled={st.busy === "plan"} onClick={() => { reset(); setAllLines(false); }}>
              <span aria-hidden="true">×</span> Очистить
            </button>
          </div>
          <ReadMeta read={read} />
          {read.lines.length > 0 ? (
            <>
              <ol className="plan-lines">
                {(allLines ? read.lines : read.lines.slice(0, LINES_SHOWN)).map((x, i) => <li key={i}><span className="num">{i + 1}</span>{x}</li>)}
              </ol>
              {read.lines.length > LINES_SHOWN && (
                <button type="button" className="link-btn assist-more" onClick={() => setAllLines(!allLines)}>{allLines ? "Свернуть" : `Показать все · ${read.lines.length}`}</button>
              )}
              {!fresh && (
                <div className="plan-go">
                  <button type="button" className="btn pr" disabled={!!st.busy} onClick={() => run(read.lines)}>
                    {st.busy === "plan" ? "Разбираю…" : "Разобрать план"}
                  </button>
                  {left && (
                    <p className="assist-quota">
                      Один запрос к модели на весь план. Демо-стенд: {left.left > 0 ? <>осталось {left.left} из {left.per_day} на сегодня</> : <>запросы на сегодня закончились</>}
                      <Hint label="Почему лимит">Стенд сделан для проверки, а не для публики: разбор плана — вызов языковой модели за деньги. Лимит общий с «Описать словами». Повтор того же плана лимит не тратит.</Hint>
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="plan-none">Строк с названием товара не нашлось. {read.columns.length > 1 ? "Выберите колонку с названиями выше." : "Проверьте, что в файле есть колонка с названиями позиций."}</p>
          )}
        </section>
      )}

      {st.busy === "plan" && <Wait since={st.since} phrases={PHRASES} abort={(r) => inflight?.abort(r)} usual="обычно 10–30 секунд" />}
      {error("plan")}
      {fresh && st.res && <PlanResultView res={st.res} />}
    </>
  );
}

function ReadMeta({ read }: { read: PlanRead }) {
  const d = read.dropped;
  const parts = [
    d.head && `шапка — ${d.head} ${plural(d.head, "строка", "строки", "строк")}`,
    d.totals && `итоги — ${d.totals}`,
    d.empty && `пустые — ${d.empty}`,
    d.repeats && `повторы — ${d.repeats}`,
  ].filter(Boolean);
  const col = read.columns.find((c) => c.index === read.col);
  return (
    <div className="plan-meta">
      {read.columns.length > 1 ? (
        <label className="plan-col">
          <span>Названия — в колонке</span>
          <select className="input sm" value={read.col} onChange={(e) => set({ col: Number(e.target.value), res: null, sent: null })}>
            {read.columns.map((c) => <option key={c.index} value={c.index}>{c.title}{c.title.startsWith("Колонка") ? ` — «${c.sample}»` : ""}</option>)}
          </select>
        </label>
      ) : col && read.header && <span>Названия — колонка «{col.title}»</span>}
      {parts.length > 0 && <span>Отброшено: {parts.join(", ")}</span>}
      {read.cut > 0 && <span className="plan-cut">Позиций больше {PLAN_MAX}: разберём первые {PLAN_MAX}, ещё {read.cut} отрезано</span>}
    </div>
  );
}

function FileGlyph() {
  return (
    <svg className="plan-glyph" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M11 4.5h13l7 7v24a1 1 0 0 1-1 1H11a1 1 0 0 1-1-1v-30a1 1 0 0 1 1-1z" />
      <path d="M24 4.5v7h7" />
      <path d="M14.5 19h11M14.5 23.5h11M14.5 28h7M19 16.5v14" strokeLinecap="round" />
    </svg>
  );
}

// ---------- итог ----------

type Pos = PlanPosition;
/** Роль поставщика в итоге — его главные группы: та, где больше всего позиций, и те, где их хотя бы две.
 *  Одна икра у оптовика бакалеи не делает его «рыбой» — она видна в чипах. */
const roleOf = (groups: string[]) => {
  const n = new Map<string, number>();
  for (const g of groups) n.set(g, (n.get(g) ?? 0) + 1);
  const top = Math.max(0, ...n.values());
  const names = [...n].filter(([, k]) => k === top || k >= 2).map(([g]) => g).sort((a, b) => order(a) - order(b))
    .map((g) => ROLE[g] ?? catById(g)?.short.toLowerCase() ?? g);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}` : names[0] ?? "";
};
const order = (g: string) => { const i = CATEGORIES.findIndex((c) => c.id === g); return i < 0 ? CATEGORIES.length : i; };
const groupName = (g: string) => catById(g)?.name ?? "Вне категорий набора";
/** Позиция плана → что нести поставщику: на чипе — короткое название, в запросе — строки плана с брендом и фасовкой. */
const wantOf = (p: Pos) => ({ name: p.label, text: p.lines.join("; ") });

function PlanResultView({ res }: { res: PlanResult }) {
  const store = useStore();
  const scored = useMemo(() => defaultScored(store), [store]);
  // поставщики только из этого набора: ответ сервера мог прийти от другой версии набора
  const positions: Pos[] = useMemo(() => res.positions.map((p) => ({ ...p, suppliers: p.suppliers.filter((s) => byId.has(s.id)) })), [res]);
  const pos = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions]);
  // в итог не идут исключённые из рекомендации и крупный опт — как в «Кому написать первым»
  const pickable = (id: string) => { const sc = scored.get(id); return sc && !bigWholesale(sc) ? sc.total : null; };
  const v = useMemo(() => verdict(positions, pickable), [positions, scored]);
  const picked = new Set(v.picks.map((p) => p.id));

  return (
    <div className="plan-res">
      <Summary v={v} pos={pos} scored={scored} />
      <Gaps v={v} pos={pos} scored={scored} />

      <section className="plan-cover">
        <div className="assist-step-h">
          <h2 className="section-h">Кто что закрывает</h2>
          <Hint>Поставщики набора, у которых в ассортименте нашлись позиции плана, — по группам. Тёмная позиция у поставщика есть, светлая — не нашлась. Совпадение ищет код по названиям позиций на сайтах поставщиков, а не модель.</Hint>
        </div>
        {[...new Set(positions.map((p) => p.group))].sort((a, b) => order(a) - order(b)).map((g) => (
          <GroupPanel key={g} group={g} positions={positions.filter((p) => p.group === g)} scored={scored} picked={picked} />
        ))}
      </section>

      <details className="plan-parse">
        <summary>Как помощник прочитал строки · {positions.reduce((n, p) => n + p.lines.length, 0) + res.skipped.length}</summary>
        <p className="sub">Модель привела каждую строку к позиции и группе набора — бренд, фасовка и количество для поиска не нужны. Поставщиков по позициям подобрал код.</p>
        <ul>
          {positions.map((p) => p.lines.map((line, i) => (
            <li key={`${p.id}-${i}`}>
              <span className="plan-parse-line">{line}</span>
              <span className="plan-parse-pos">{p.label}{!p.parsed && <span className="muted"> · модель пропустила, искали по строке</span>}</span>
              <span className="plan-parse-g">{p.group === "other" ? "вне набора" : catById(p.group)?.short}</span>
              <span className="plan-parse-n num">{p.suppliers.length ? `${p.suppliers.length} ${plural(p.suppliers.length, "поставщик", "поставщика", "поставщиков")}` : "нет"}</span>
            </li>
          )))}
          {res.skipped.map((line, i) => (
            <li key={`skip-${i}`} className="muted">
              <span className="plan-parse-line">{line}</span>
              <span className="plan-parse-pos">не товар — пропущено</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Summary({ v, pos, scored }: { v: Verdict; pos: Map<string, Pos>; scored: Map<string, Scored> }) {
  const name = (id: string) => byId.get(id)?.name ?? id;
  const n = v.picks.length;
  let text: string;
  if (!n) text = "Ни одной позиции плана нет в ассортименте поставщиков набора.";
  else if (n === 1 && v.covered === v.total) text = `Весь план закрывает один поставщик — ${name(v.picks[0].id)}.`;
  else {
    const roles = v.picks.map((p) => `${roleOf(p.takes.map((t) => pos.get(t)!.group))} — ${name(p.id)}`).join(", ");
    const all = v.covered === v.total ? `весь план — ${v.total} ${plural(v.total, "позицию", "позиции", "позиций")}` : `${v.covered} из ${v.total} ${plural(v.total, "позиции", "позиций", "позиций")}`;
    text = n === 1
      ? `Одной компании, которая поставляет всё, в наборе нет. Больше всего — ${all} — у ${name(v.picks[0].id)}, остальное ни у кого из подходящих не нашлось.`
      : `Одной компании, которая поставляет всё, в наборе нет. Лучшая комбинация — ${NUM[n]} ${plural(n, "поставщик", "поставщика", "поставщиков")}: ${roles}. Вместе они закрывают ${all}.`;
  }
  return (
    <section className="first plan-verdict" aria-label="Итог: у кого брать">
      <div className="first-head">
        <h2 className="h2">У кого брать</h2>
        <Hint label="Как выбрано">Перебираются все сочетания до трёх поставщиков набора. Выше то, что закрывает больше позиций плана; при равенстве — где поставщиков меньше (меньше минимальных заказов и доставок), потом — где выше рейтинг. Позицию, которая есть у двоих, берёт тот, у кого она нашлась точнее, потом — с более высоким рейтингом. Исключённые из рекомендации и крупный опт в итог не идут. Рейтинг — балл в категории поставщика при закупке 20 000 ₽ в неделю. Цены в выборе не участвуют: у большинства поставщиков их нет на сайте.</Hint>
      </div>
      <p className="plan-verdict-text">{text}</p>
      {n > 0 && (
        <div className="cards3">
          {v.picks.map((p, i) => <PickCard key={p.id} rank={i + 1} id={p.id} takes={p.takes.map((t) => pos.get(t)!)} total={v.total} sc={scored.get(p.id)!} />)}
        </div>
      )}
    </section>
  );
}

function PickCard({ rank, id, takes, total, sc }: { rank: number; id: string; takes: Pos[]; total: number; sc: Scored }) {
  const s = byId.get(id)!;
  const m = minOrderShort(s);
  const mo = m.status === "not_found" ? { ...m, text: "мин. заказ не найден" } : m;
  const d = isKnown(s.delivery) ? deliveryShort(s.delivery.value!) : "—";
  const dl = d === "—" ? { status: "not_found" as const, text: "доставка не указана" } : { status: s.delivery.status, text: `доставка ${d}` };
  // цена — только если она стоит на сайте поставщика у найденной позиции
  const prices = takes.flatMap((p) => p.suppliers.filter((x) => x.id === id && x.price).map((x) => x.price!)).slice(0, 3);
  return (
    <a className={`gcard plan-pick${rank === 1 ? " lead" : ""}`} href={href(`/s/${id}`)} {...carry(id, takes.map(wantOf))}>
      <div className="g-top">
        <span className="g-rank num">{rank}</span>
        <span className="plan-role">{roleOf(takes.map((p) => p.group))}</span>
        <Score value={sc.total} unit className="g-score" />
      </div>
      <div className="who">
        <Avatar s={s} logo={logoOf(id)} />
        <div>
          <div className="nm">{s.name}</div>
          <div className="sub">рейтинг в категории «{categoryOf(s).short}»</div>
        </div>
      </div>
      <div className="plan-takes">
        <div className="plan-k">Берёт на себя <b className="num">{takes.length}</b> из {total}</div>
        <div className="mc-chips">{takes.map((p) => <span key={p.id} className="mc-chip on">{p.label}</span>)}</div>
      </div>
      <ul className="plan-why">
        <li><StatusIcon status={mo.status} size={10} /> {mo.text}</li>
        <li><StatusIcon status={dl.status} size={10} /> {dl.text}</li>
      </ul>
      {prices.length > 0 && (
        <div className="plan-prices">
          <div className="plan-k">Цены с сайта</div>
          {prices.map((p, i) => <div key={i}><span>{p.item}</span> <b>{p.price}</b></div>)}
        </div>
      )}
    </a>
  );
}

function Gaps({ v, pos, scored }: { v: Verdict; pos: Map<string, Pos>; scored: Map<string, Scored> }) {
  if (!v.nobody.length && !v.elsewhere.length) return null;
  const labels = (ids: string[]) => ids.map((id) => pos.get(id)!.label).join(", ");
  const outside = v.nobody.filter((id) => pos.get(id)!.group === "other");
  const inside = v.nobody.filter((id) => pos.get(id)!.group !== "other");
  const why = (by: string[]) => {
    const names = by.slice(0, 2).map((id) => byId.get(id)!.name).join(", ") + (by.length > 2 ? ` и ещё ${by.length - 2}` : "");
    const reason = by.every((id) => { const sc = scored.get(id); return !sc || bigWholesale(sc); })
      ? by.every((id) => !scored.get(id)) ? " — исключены из рекомендации" : " — крупный опт" : "";
    return names + reason;
  };
  return (
    <section className="panel plan-gaps" aria-label="Что не закрыто">
      <div className="label">Что не закрыто</div>
      <ul>
        {outside.length > 0 && <li><b>Вне набора: {labels(outside)}.</b> Таких категорий в наборе нет — он собран по четырём: упаковка, рыба, сыр и молочное, рис и азиатская бакалея.</li>}
        {inside.length > 0 && <li><b>Ни у кого в наборе: {labels(inside)}.</b> Категория есть, но в ассортименте поставщиков такой позиции не нашлось.</li>}
        {v.elsewhere.map((e) => <li key={e.pos}><b>{pos.get(e.pos)!.label}</b> — есть у {why(e.by)}, но не у выбранных.</li>)}
      </ul>
      {v.nobody.length > 0 && (
        <p className="sub">Знаете поставщика этих позиций — <a href={href("/add")}>живой сбор</a> соберёт его карточку по сайту или ИНН.</p>
      )}
    </section>
  );
}

function GroupPanel({ group, positions, scored, picked }: { group: string; positions: Pos[]; scored: Map<string, Scored>; picked: Set<string> }) {
  const [all, setAll] = useState(false);
  const cat = catById(group);
  const labels = positions.map((p) => p.label);
  const has = new Map<string, Set<string>>();
  for (const p of positions) for (const s of p.suppliers) {
    if (!has.has(s.id)) has.set(s.id, new Set());
    has.get(s.id)!.add(p.label);
  }
  const score = (id: string) => scored.get(id)?.total ?? -1;
  const ids = [...has.keys()].sort((a, b) => Number(picked.has(b)) - Number(picked.has(a)) || has.get(b)!.size - has.get(a)!.size || score(b) - score(a));
  return (
    <div className="panel plan-group">
      <div className="panel-h">
        <b>{cat ? <CatGlyph cat={cat} size={22} /> : null}{groupName(group)}</b>
        <span className="sub">{positions.length} {plural(positions.length, "позиция", "позиции", "позиций")} · {ids.length ? `${ids.length} ${plural(ids.length, "поставщик", "поставщика", "поставщиков")}` : "поставщиков нет"}</span>
      </div>
      {ids.length > 0 ? (
        <div className="assist-cards">
          {(all ? ids : ids.slice(0, CARDS_SHOWN)).map((id) => {
            const s = byId.get(id)!;
            const sc = scored.get(id);
            const tags = <>{picked.has(id) && <span className="fresh-pill">в итоге</span>}{sc && bigWholesale(sc) && <span className="opt-pill">крупный опт</span>}</>;
            return (
              <ListCard key={id} variant="mini" s={s} cat={categoryOf(s)} href={href(`/s/${id}`)} score={sc?.total ?? null} tags={tags}
                link={carry(id, positions.filter((p) => has.get(id)!.has(p.label)).map(wantOf))}
                extra={<CoverChips items={labels} has={has.get(id)!} />} />
            );
          })}
        </div>
      ) : (
        <div className="mc-chips">{labels.map((x) => <span key={x} className="mc-chip">{x}</span>)}</div>
      )}
      {ids.length > CARDS_SHOWN && (
        <button type="button" className="link-btn assist-more" onClick={() => setAll(!all)}>{all ? "Свернуть" : `Показать всех · ${ids.length}`}</button>
      )}
    </div>
  );
}
