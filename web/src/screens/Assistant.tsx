// Помощник (T-536): человек описывает точку → модель предлагает, что может понадобиться → поставщиков подбирает сервер
// кодом по ассортименту набора. Модель названий поставщиков не видит, поэтому назвать того, кого нет в наборе, не может.
// T-544: ожидание со счётчиком секунд, ответ на уточняющий вопрос кнопкой (один раунд), мини-карточки в подборе,
// подбор переживает переход к поставщику и «назад» — без повторного вызова модели.
// T-546: второй способ — «Загрузить план закупа» (screens/PlanImport.tsx), переключатель в адресе: #/assistant?mode=plan.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { href, navigate, type Route } from "../router.ts";
import { useStore } from "../store.ts";
import { byId, categoryOf, defaultScores } from "../data.ts";
import { plural } from "../lib/format.ts";
import { ApiError, assist, cachedHealth, health, match, type Found, type Health, type Match, type Suggest } from "../lib/api.ts";
import { Hint, Seg } from "../components/ui.tsx";
import { Wait } from "../components/AssistWait.tsx";
import { PlanImport } from "./PlanImport.tsx";
import { CoverChips, ListCard } from "../components/ListCard.tsx";

const EXAMPLES = ["у меня бабл-ти в ТЦ", "суши-бар на доставку", "пиццерия у дома", "кофейня у метро"];
const TEXT_MAX = 500;                 // как TEXT_MAX на сервере (api/assistant.py)
const ANSWER_MAX = 80;
const NO_MORE = "Уточнение уже получено, вопросов больше не задавай.";
// пока модель думает — сменяющиеся фразы о том, что сейчас происходит (Павел 15.10: «чтобы было видно, что идёт работа»)
const PHRASES_ASK = ["Читаю описание", "Определяю, что за точка", "Составляю список закупок", "Подбираю названия, как в прайсах", "Сверяю с ассортиментом набора"];
const PHRASES_REPLY = ["Учитываю ответ", "Уточняю список закупок", "Подбираю названия, как в прайсах", "Сверяю с ассортиментом набора"];
const OOPS = "Что-то пошло не так. Попробуйте ещё раз.";

/** Описание и уточнение одним текстом: сервер истории не помнит. Склейка не длиннее TEXT_MAX — при нужде укорачивается
 *  описание, а не уточнение: серверная обрезка срезала бы как раз ответ клиента в конце. */
export function glue(desc: string, question: string, answer: string) {
  const tail = `. Уточнение: ${question} — ${answer}. ${NO_MORE}`;
  let d = desc.trim().replace(/[\s.!?…]+$/, "");
  if (d.length + tail.length > TEXT_MAX) d = d.slice(0, Math.max(0, TEXT_MAX - tail.length - 1)).trimEnd() + "…";
  return d + tail;
}

// ---- состояние экрана: вне компонента и в sessionStorage вкладки — переход к поставщику и «назад» его не сбрасывают ----
type Busy = "ask" | "reply" | "match";
interface Saved {
  text: string;                       // поле ввода
  asked: string;                      // описание, на которое получен первый ответ
  first: Suggest | null;              // первый ответ — с уточняющим вопросом, если модель его задала
  answer: string | null;              // ответ клиента на этот вопрос
  sug: Suggest | null;                // ответ на экране: первый или уточнённый
  picked: string[];
  res: Match | null;
  sort: Sort;                         // порядок в подборе
}
interface State extends Saved {
  busy: Busy | null;
  since: number;                      // когда ушёл запрос — для счётчика секунд
  err: { at: Busy; text: string } | null;
}
const KEY = "supplier-scout:assistant";
const EMPTY: State = { text: "", asked: "", first: null, answer: null, sug: null, picked: [], res: null, sort: "cover", busy: null, since: 0, err: null };
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
    /* хранилище недоступно — подбор живёт до перезагрузки */
  }
  listeners.forEach((l) => l());
}
const useAssist = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => state);

let inflight: AbortController | null = null;
const defaults = (s: Suggest) => s.needs.filter((n) => n.suppliers_count > 0).map((n) => n.id);

async function suggestFor(text: string, at: "ask" | "reply"): Promise<Suggest | null> {
  const ctl = new AbortController();
  inflight = ctl;
  set({ busy: at, since: Date.now(), err: null });
  try {
    return await assist(text, ctl.signal);
  } catch (e) {
    const timeout = ctl.signal.aborted && ctl.signal.reason === "timeout";
    if (!ctl.signal.aborted || timeout) {
      set({ err: { at, text: timeout ? "Модель не ответила за полторы минуты. Попробуйте ещё раз — если ответ всё же придёт, повтор того же текста лимит не потратит."
        : e instanceof ApiError ? e.message : OOPS } });
    }
    return null;
  } finally {
    if (inflight === ctl) inflight = null;
    set({ busy: null });
  }
}

async function ask(value: string) {
  const v = value.trim();
  if (!v || state.busy) return;
  set({ text: v, asked: v, first: null, answer: null, sug: null, picked: [], res: null });
  const s = await suggestFor(v, "ask");
  if (s) set({ first: s, sug: s, picked: defaults(s) });
}

async function reply(value: string) {
  const a = value.trim().slice(0, ANSWER_MAX);
  const q = state.first?.question;
  if (!a || !q || state.busy) return false;
  const s = await suggestFor(glue(state.asked, q, a), "reply");
  if (s) set({ answer: a, sug: s, picked: defaults(s), res: null });
  return !!s;
}

async function pick() {
  const { sug, picked, busy } = state;
  if (!sug || busy) return;
  set({ busy: "match", err: null });
  try {
    set({ res: await match(sug.needs.filter((n) => picked.includes(n.id))) });
  } catch (e) {
    set({ err: { at: "match", text: e instanceof ApiError ? e.message : OOPS } });
  } finally {
    set({ busy: null });
  }
}

/** «Очистить» — с чистого листа: описание, вопрос, подбор; идущий запрос отменяется. Порядок сортировки остаётся. */
function reset() {
  if (state.busy === "match") return;
  inflight?.abort("cancel");
  set({ text: "", asked: "", first: null, answer: null, sug: null, picked: [], res: null, err: null });
}

const toggle = (id: string) => set({ res: null, picked: state.picked.includes(id) ? state.picked.filter((x) => x !== id) : [...state.picked, id] });

type Mode = "words" | "plan";
const MODES: { id: Mode; label: string }[] = [{ id: "words", label: "Описать словами" }, { id: "plan", label: "Загрузить план закупа" }];

export function Assistant({ route }: { route: Route }) {
  const mode: Mode = route.params.get("mode") === "plan" ? "plan" : "words";
  return (
    <div className="assistant">
      <div className="label">Помощник</div>
      {mode === "plan" ? (
        <>
          <h1 className="h1">Есть план закупа?</h1>
          <p className="lead-sm">Загрузите его файлом или вставьте колонку из Excel — помощник разберёт строки, найдёт, у кого из собранного набора что есть, и предложит, у кого брать: до трёх поставщиков на весь план.</p>
        </>
      ) : (
        <>
          <h1 className="h1">Не знаете, как искать?</h1>
          <p className="lead-sm">Опишите точку своими словами — помощник предложит, что ей обычно закупают, а поставщиков подберёт из собранного набора по их ассортименту.</p>
        </>
      )}
      <div className="assist-modes">
        <Seg label="Способ" options={MODES} value={mode} onChange={(m) => navigate("/assistant", { mode: m === "plan" ? "plan" : null }, { replace: true })} />
      </div>
      {mode === "plan" ? <PlanImport /> : <Describe />}
    </div>
  );
}

function Describe() {
  const st = useAssist();
  const { text, first, answer, sug, picked, res, busy, err } = st;
  const [hl, setHl] = useState<Health | null>(cachedHealth);
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => { health().then(setHl).catch(() => setHl(null)); }, [sug]);

  const submit = (e: FormEvent) => { e.preventDefault(); setEditing(false); ask(text); };
  const answerWith = async (a: string) => {
    if (a === answer) { setEditing(false); return; }          // тот же ответ — список уже под него, запрос не нужен
    if (await reply(a)) setEditing(false);
  };
  const left = hl?.demo_left.assist;
  // примеры — пока описание не отправлено; стёр поле, чтобы начать заново, — снова видны
  const showExamples = !text.trim() || (!sug && !busy);
  const asking = first?.question && (answer === null || editing);
  const error = (at: Busy) => err?.at === at && <div className="panel warn"><b>{err.text}</b></div>;

  return (
    <>
      <div className="assist-in-block">
        <form className="add-form" onSubmit={submit}>
          <span className="assist-field">
            <input ref={field} className="input lg" value={text} onChange={(e) => set({ text: e.target.value })} maxLength={TEXT_MAX}
              placeholder="например: у меня бабл-ти в ТЦ" aria-label="Опишите точку" />
            {(text || sug || err) && (
              <button type="button" className="assist-clear" disabled={busy === "match"} title="Очистить и начать новый запрос"
                onClick={() => { reset(); setEditing(false); field.current?.focus(); }}>
                <span aria-hidden="true">×</span> Очистить
              </button>
            )}
          </span>
          <button className="btn pr lg" type="submit" disabled={!!busy || text.trim().length < 3}>{busy === "ask" ? "Думаю…" : "Подсказать"}</button>
        </form>
        {left && (
          <p className="assist-quota">
            Демо-стенд: {left.left > 0 ? <>осталось {left.left} из {left.per_day} {plural(left.per_day, "запроса", "запросов", "запросов")} на сегодня</> : <>запросы на сегодня закончились</>}
            <Hint label="Почему лимит">Стенд сделан для проверки, а не для публики: каждый запрос — вызов языковой модели за деньги. В продукте вместо этого — квоты на аккаунт. Повтор того же описания лимит не тратит, ответ на уточнение — это новый запрос.</Hint>
          </p>
        )}
        {showExamples && (
          <div className="examples">
            <span className="label">Примеры</span>
            {EXAMPLES.map((x) => <button key={x} type="button" className="pill-out sm" disabled={!!busy} onClick={() => { setEditing(false); ask(x); }}>{x}</button>)}
          </div>
        )}
      </div>

      {busy === "ask" && <Wait since={st.since} phrases={PHRASES_ASK} abort={(r) => inflight?.abort(r)} />}
      {error("ask")}

      {sug && (
        <section className="assist-step">
          <div className="assist-step-h">
            <h2 className="section-h">{sug.place ? <>Для точки «{sug.place}» обычно нужно</> : "Что может понадобиться"}</h2>
            <Hint>Варианты предложила языковая модель по вашему описанию. Число рядом — сколько поставщиков в наборе продают такое: его считает код по ассортименту, а не модель.</Hint>
          </div>

          {asking && first?.question && (
            <Clarify question={first.question} answers={first.answers ?? []} current={answer} busy={!!busy} onAnswer={answerWith}
              onCancel={editing ? () => setEditing(false) : undefined} />
          )}
          {answer !== null && !editing && (
            <p className="assist-noted">
              <span className="label">Учтено</span>
              <span>{answer}</span>
              <button type="button" className="link-btn" disabled={!!busy} onClick={() => setEditing(true)}>Изменить</button>
            </p>
          )}
          {busy === "reply" && <Wait since={st.since} phrases={PHRASES_REPLY} abort={(r) => inflight?.abort(r)} />}
          {error("reply")}
          {/* после ответа второй вопрос кнопками не задаём: если модель всё же спросила — просто текстом */}
          {answer !== null && sug.question && <p className="assist-q">{sug.question}</p>}

          {sug.needs.length > 0 && (
            <div className={`assist-pick${busy === "reply" ? " stale" : ""}`}>
              <div className="assist-needs" role="group" aria-label="Что нужно">
                {sug.needs.map((n) => (
                  <button key={n.id} type="button" className={`assist-need${picked.includes(n.id) ? " on" : ""}`} aria-pressed={picked.includes(n.id)}
                    onClick={() => toggle(n.id)} title={n.why}>
                    <span>{n.label}</span>
                    <span className={`assist-n${n.suppliers_count ? "" : " zero"}`}>{n.suppliers_count || "нет"}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="btn pr" disabled={!picked.length || !!busy} onClick={pick}>
                {busy === "match" ? "Подбираю…" : `Подобрать поставщиков${picked.length ? ` · ${picked.length}` : ""}`}
              </button>
            </div>
          )}
          {error("match")}
        </section>
      )}

      {res && <Result res={res} sort={st.sort} />}
    </>
  );
}

/** Уточняющий вопрос модели: варианты ответа кнопками и свой ответ. Раунд один — ответ уходит вместе с описанием. */
function Clarify({ question, answers, current, busy, onAnswer, onCancel }: {
  question: string; answers: string[]; current: string | null; busy: boolean; onAnswer: (a: string) => void; onCancel?: () => void;
}) {
  const [own, setOwn] = useState(current && !answers.includes(current) ? current : "");
  const send = (e: FormEvent) => { e.preventDefault(); if (own.trim()) onAnswer(own); };
  return (
    <div className="assist-clar">
      <div className="label">Уточнение</div>
      <p className="assist-clar-q">{question}</p>
      {answers.length > 0 && (
        <div className="assist-answers" role="group" aria-label="Варианты ответа">
          {answers.map((a) => (
            <button key={a} type="button" className={`pill-out${a === current ? " on" : ""}`} aria-pressed={a === current} disabled={busy} onClick={() => onAnswer(a)}>{a}</button>
          ))}
        </div>
      )}
      <form className="assist-own" onSubmit={send}>
        <input className="input" value={own} onChange={(e) => setOwn(e.target.value)} maxLength={ANSWER_MAX} placeholder="Свой ответ" aria-label="Свой ответ" />
        <button type="submit" className="btn sec" disabled={busy || !own.trim()}>Ответить</button>
        {onCancel && <button type="button" className="link-btn" disabled={busy} onClick={onCancel}>Оставить «{current}»</button>}
      </form>
    </div>
  );
}

type Sort = "cover" | "score";
const BEST_SHOWN = 6;

/** Подбор (Павел 15.10): мини-карточка — логотип, название, чипы отмеченных позиций (есть — тёмная, нет — погашена)
 *  и рейтинг. Порядок — сколько отмеченных позиций закрывает поставщик, при равенстве — рейтинг; или наоборот. */
function Result({ res, sort }: { res: Match; sort: Sort }) {
  const store = useStore();
  const scores = useMemo(() => defaultScores(store), [store]);
  const [allBest, setAllBest] = useState(false);
  const found = res.by_need.filter((b) => b.suppliers.length);
  const labels = found.map((b) => b.label);
  // кто что закрывает: поставщик → позиция → что нашлось в его ассортименте
  const has = useMemo(() => {
    const m = new Map<string, Map<string, Found>>();
    for (const b of found) for (const f of b.suppliers) {
      if (!m.has(f.id)) m.set(f.id, new Map());
      m.get(f.id)!.set(b.label, f);
    }
    return m;
  }, [res]);
  const covers = (id: string) => has.get(id)?.size ?? 0;
  const score = (id: string) => scores.get(id) ?? -1;
  const order = (a: string, b: string) => sort === "cover"
    ? covers(b) - covers(a) || score(b) - score(a)
    : score(b) - score(a) || covers(b) - covers(a);
  const best = [...has.keys()].filter((id) => covers(id) > 1).sort(order);

  const card = (id: string) => {
    const s = byId.get(id);
    if (!s) return null;
    const mine = has.get(id)!;
    return (
      <ListCard key={id} variant="mini" s={s} cat={categoryOf(s)} href={href(`/s/${id}`)} score={scores.get(id) ?? null}
        extra={labels.length > 1 && <CoverChips items={labels} has={new Set(mine.keys())} />} />
    );
  };
  return (
    <section className="assist-res">
      <div className="assist-sort" role="group" aria-label="Порядок">
        <span className="label">Сначала</span>
        {([["cover", "больше позиций"], ["score", "выше рейтинг"]] as const).map(([id, text]) => (
          <button key={id} type="button" className={`pill-out sm${sort === id ? " on" : ""}`} aria-pressed={sort === id} onClick={() => set({ sort: id })}>{text}</button>
        ))}
        <Hint label="Как упорядочено">«Больше позиций» — выше тот, у кого есть больше отмеченного, при равенстве — у кого выше рейтинг. «Выше рейтинг» — наоборот. Рейтинг — балл поставщика в его категории при обычной закупке, как в поиске по товару.</Hint>
      </div>

      {best.length > 0 && (
        <div className="panel">
          <div className="panel-h"><b>Закрывают несколько позиций сразу</b><Hint>Удобно заказывать у одного: меньше минимальных заказов и доставок. Тёмная позиция — у поставщика есть, светлая — не нашлась.</Hint></div>
          <div className="assist-cards">{(allBest ? best : best.slice(0, BEST_SHOWN)).map(card)}</div>
          {best.length > BEST_SHOWN && (
            <button type="button" className="link-btn assist-more" onClick={() => setAllBest(!allBest)}>{allBest ? "Свернуть" : `Показать всех · ${best.length}`}</button>
          )}
        </div>
      )}

      {found.map((b) => (
        <div key={b.label} className="panel">
          <div className="panel-h"><b>{b.label}</b><span className="sub">{b.suppliers.length} {plural(b.suppliers.length, "поставщик", "поставщика", "поставщиков")}</span></div>
          <div className="assist-cards">{b.suppliers.map((s) => s.id).sort(order).map(card)}</div>
        </div>
      ))}

      {res.missing.length > 0 && (
        <div className="panel warn">
          <b>Таких поставщиков в наборе пока нет: {res.missing.join(", ")}.</b>
          <p>Набор собран заранее по четырём категориям Екатеринбурга. Знаете поставщика — живой сбор соберёт его карточку по сайту или ИНН.</p>
          <div className="row-btns"><a className="btn sec" href={href("/add")}>Знаю поставщика</a></div>
        </div>
      )}
    </section>
  );
}
