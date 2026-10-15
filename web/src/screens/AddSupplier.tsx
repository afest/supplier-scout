import { useEffect, useRef, useState, type FormEvent } from "react";
import { href, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { CATEGORIES, catById, categoryOf, DATA, rankCategory, readQuery, volParam } from "../data.ts";
import { flagsText, profileDeclarations } from "../lib/score.ts";
import { ageYears, clock, isKnown, minOrderText, plural, years } from "../lib/format.ts";
import { ApiError, collect, health, job as loadJob, type Health, type Job } from "../lib/api.ts";
import type { Supplier } from "../types.ts";
import { DemoPill, Hint, Mono, Score } from "../components/ui.tsx";
import { deliveryText } from "../components/supplier.tsx";

// replay — записанный прогон по примеру (мгновенно, без лимита); live — настоящий сбор на сервере (T-536)
type Phase = "idle" | "run" | "confirm" | "done" | "exists" | "need-cat" | "live-done" | "live-error";
interface Step { text: string; state: "done" | "run" | "wait" }
const POLL_MS = 2000;
const isInn = (v: string) => /^\d{10}(\d{2})?$/.test(v.replace(/\s/g, ""));

const STEP_MS = 900;
const LIVE = DATA.suppliers.filter((s) => s.live_only);
const domainOf = (s: Supplier) => (s.website.value ?? "").replace(/^https?:\/\//, "");

function resolve(input: string): { s: Supplier; by: "site" | "inn" } | { s: Supplier; by: "exists" } | null {
  const v = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\s/g, "");
  if (!v) return null;
  for (const s of DATA.suppliers) {
    const hit = (domainOf(s) && v === domainOf(s)) || (isKnown(s.inn) && v === s.inn.value);
    if (hit) return s.live_only ? { s, by: /^\d+$/.test(v) ? "inn" : "site" } : { s, by: "exists" };
  }
  return null;
}

function siteSteps(s: Supplier): string[] {
  const pages = s.meta.sources.filter((x) => x.kind === "site").map((x) => `«${x.title.replace("Сайт: ", "")}»`);
  const decl = profileDeclarations(s, categoryOf(s)).length;
  return [
    `Открыли сайт: ${pages.slice(0, 4).join(", ")} — ${pages.length} ${pages.length < 5 ? "страницы" : "страниц"}`,
    isKnown(s.inn) ? `Нашли ИНН в реквизитах: ${s.inn.value}` : "ИНН на сайте не нашли — реестры проверить не выйдет",
    "Раскладываем текст по полям — модель выносит цитату к каждому значению, без цитаты значение отбрасываем",
    isKnown(s.company) ? `ФНС: действует ${years(ageYears(s.company.value!.registered_at))}, ОКВЭД ${s.company.value!.okved_main}, ${flagsText(s.company.value!.flags)}` : "ФНС: без ИНН не проверить",
    `Росаккредитация: ${decl} ${plural(decl, "действующая декларация", "действующие декларации", "действующих деклараций")}${s.documents.marking && isKnown(s.documents.marking) ? "; «Честный знак» — участник" : ""}`,
    "Считаем балл и место среди остальных в категории",
  ];
}

export function AddSupplier({ route }: { route: Route }) {
  const st = useStore();
  const [input, setInput] = useState(route.params.get("q") ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<Step[]>([]);
  const [target, setTarget] = useState<Supplier | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState(false);
  const [liveJob, setLiveJob] = useState<Job | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [cat, setCat] = useState("");
  const [hl, setHl] = useState<Health | null>(null);
  const timers = useRef<number[]>([]);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);
  useEffect(() => { health().then(setHl).catch(() => setHl(null)); }, [phase === "live-done" || phase === "live-error"]);
  useEffect(() => {
    if (phase !== "run") return;
    const t0 = Date.now();
    const iv = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => window.clearInterval(iv);
  }, [phase]);

  const play = (texts: string[], prefix: Step[], onDone: () => void) => {
    setSteps([...prefix, ...texts.map((text, i) => ({ text, state: (i === 0 ? "run" : "wait") as Step["state"] }))]);
    texts.forEach((_, i) => {
      timers.current.push(window.setTimeout(() => {
        setSteps((prev) => prev.map((x, j) => {
          const k = j - prefix.length;
          if (k < 0) return x;
          return { ...x, state: k <= i ? "done" : k === i + 1 ? "run" : "wait" };
        }));
        if (i === texts.length - 1) onDone();
      }, STEP_MS * (i + 1)));
    });
  };

  // Живой сбор на сервере: задача в очередь, шаги конвейера — опросом раз в 2 секунды.
  const startLive = async (value: string) => {
    const v = value.trim();
    const inn = isInn(v) ? v.replace(/\s/g, "") : null;
    setTarget(null); setLiveJob(null); setLiveErr(null); setLive(true);
    if (inn && !cat) { setPhase("need-cat"); setSteps([]); return; }
    setPhase("run");
    setSteps([{ text: "Отправляем на сервер сбора", state: "run" }]);
    const show = (j: Job) => setSteps(j.state === "queued"
      ? [{ text: `В очереди: ${j.position ?? 1}-й — сборы идут по одному`, state: "run" }]
      : j.steps.map((x, i, all) => ({ text: x.text, state: i === all.length - 1 && j.state === "running" ? "run" : "done" })));
    const poll = async (id: string) => {
      try {
        const j = await loadJob(id);
        show(j);
        if (j.state === "done") { setLiveJob(j); setPhase("live-done"); return; }
        if (j.state === "error") { setLiveErr(j.error ?? "Сбор не удался."); setPhase("live-error"); return; }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { setLiveErr(e.message); setPhase("live-error"); return; }
      }
      timers.current.push(window.setTimeout(() => poll(id), POLL_MS));
    };
    try {
      const j = await collect(inn ? null : v, inn, inn ? cat : null);
      show(j);
      timers.current.push(window.setTimeout(() => poll(j.id), POLL_MS));
    } catch (e) {
      setLiveErr(e instanceof ApiError ? e.message : "Сервер не ответил."); setPhase("live-error"); setSteps([]);
    }
  };

  const start = (value: string) => {
    clear();
    setElapsed(0);
    const r = resolve(value);
    if (!r) { startLive(value); return; }
    setLive(false);
    setTarget(r.s);
    if (r.by === "exists") { setPhase("exists"); setSteps([]); return; }
    setPhase("run");
    if (r.by === "site") {
      play(siteSteps(r.s), [], () => { actions.markCollected(r.s.id); setPhase("done"); });
    } else {
      play([
        `ЕГРЮЛ: ${r.s.legal_name.value}, действует ${years(ageYears(r.s.company.value!.registered_at))}`,
        `Ищем сайт по названию «${r.s.name}» в поиске`,
      ], [], () => setPhase("confirm"));
    }
  };

  const confirmSite = () => {
    if (!target) return;
    setPhase("run");
    play(siteSteps(target).slice(0, 1).concat(siteSteps(target).slice(2)), steps.map((x) => ({ ...x, state: "done" as const })).concat({ text: `Сайт подтверждён: ${domainOf(target)}`, state: "done" }),
      () => { actions.markCollected(target.id); setPhase("done"); });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    start(input);
  };

  const doneCount = steps.filter((x) => x.state === "done").length;
  const result = phase === "done" && target ? (() => {
    const q = readQuery(new URLSearchParams({ cat: target.category, ...(st.last ? { vol: st.last.vol, prio: st.last.prio } : {}) }));
    const { ranked } = rankCategory(q, st);
    const i = ranked.findIndex((x) => x.supplier.id === target.id);
    return { sc: ranked[i], place: i + 1, n: ranked.length, q };
  })() : null;

  return (
    <div className="add-page">
      <div className="label">Живой сбор одного поставщика</div>
      <h1 className="h1">Собрать карточку поставщика</h1>
      <p className="lead-sm">Вставьте сайт или ИНН — конвейер откроет сайт, разложит текст по полям с цитатами, проверит компанию в реестрах и посчитает балл среди остальных в категории.</p>

      <form className="add-form" onSubmit={submit}>
        <input className="input lg" value={input} onChange={(e) => setInput(e.target.value)} placeholder="сайт или ИНН" aria-label="Сайт или ИНН" />
        <button className="btn pr lg" type="submit" disabled={phase === "run"}>Собрать</button>
      </form>
      <div className="examples">
        <span className="label">Примеры</span>
        {LIVE.map((s) => {
          const v = s.live_only === "inn" ? s.inn.value! : domainOf(s);
          return (
            <button key={s.id} type="button" className="pill-out sm" onClick={() => { setInput(v); start(v); }}>
              {s.live_only === "inn" ? `ИНН ${v} — визитка с выставки` : `${v} — посоветовал коллега`}
            </button>
          );
        })}
      </div>

      {hl && (
        <p className="assist-quota">
          Сервер сбора работает · демо-стенд: {hl.demo_left.collect.left > 0
            ? <>осталось {hl.demo_left.collect.left} из {hl.demo_left.collect.per_day} сборов на сегодня</>
            : <>сборы на сегодня закончились — примеры выше работают всегда</>}
          <Hint label="Почему лимит">Каждый сбор — вызовы языковой модели за деньги, поэтому на стенде для проверки — несколько сборов в сутки. Примеры выше — записанные прогоны того же конвейера, они лимит не тратят.</Hint>
        </p>
      )}

      {phase === "need-cat" && (
        <div className="panel">
          <b>По одному ИНН категорию не определить — выберите её.</b>
          <p className="sub">Без сайта карточка соберётся по реестрам: ФНС, Росаккредитация, «Честный знак», Федресурс. Модель не вызывается.</p>
          <div className="add-form">
            <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Категория">
              <option value="">Категория…</option>
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button type="button" className="btn pr" disabled={!cat} onClick={() => startLive(input)}>Собрать по ИНН</button>
          </div>
        </div>
      )}
      {phase === "live-error" && liveErr && (
        <div className="panel warn">
          <b>{liveErr}</b>
          <p>Конвейер можно запустить и без сервера, из командной строки: <code>python -m pipeline.one --site адрес</code> или <code>--inn ИНН --category id</code>.</p>
        </div>
      )}
      {phase === "exists" && target && (
        <div className="panel">
          <b>{target.name} уже есть в собранном наборе.</b> <a href={href(`/s/${target.id}`)}>Открыть карточку →</a>
        </div>
      )}

      {steps.length === 0 && !["exists", "need-cat", "live-error"].includes(phase) && (
        <div className="run panel preview">
          <div className="run-h"><b>Что сделает конвейер</b><span className="sub">2–4 минуты · около 1 ₽<Hint>Если сайт запрещает автоматический сбор или не открылся, карточка всё равно создаётся по ЕГРЮЛ и реестрам, а поля сайта помечаются «○ не собрано» с причиной.</Hint></span></div>
          <ol className="steps">
            {[
              "Откроет сайт: главная, «Контакты», «Доставка», «Оптовикам», «Реквизиты» — до 6 страниц, по правилам robots.txt",
              "Найдёт ИНН в реквизитах, оферте или политике конфиденциальности",
              "Разложит текст по полям: у каждого значения — дословная цитата; нет цитаты — нет значения",
              "Соберёт ассортимент с каталога и прайс-листов — каждую позицию сверит со страницей",
              "Проверит компанию в ФНС: статус, возраст, ОКВЭД, выручка, красные флаги; банкротство — в Федресурсе",
              "Найдёт декларации в реестре Росаккредитации и группы в «Честном знаке»",
              "Посчитает балл и место среди остальных в категории",
            ].map((t, i) => <li key={i} className="wait"><span className="mark" aria-hidden="true">{i + 1}</span><span>{t}</span></li>)}
          </ol>
        </div>
      )}

      {steps.length > 0 && (
        <div className="run panel">
          <div className="run-h">
            <b>{phase === "done" || phase === "live-done" ? "Готово" : phase === "confirm" ? "Нужно ваше подтверждение" : phase === "live-error" ? "Сбор остановился" : "Собираем данные"} · <span className="num">{clock(elapsed)}</span></b>
            {live
              ? <Hint>Сбор идёт сейчас на сервере: шаги — вывод конвейера. Обычно 2–4 минуты; дольше всего — разбор страниц языковой моделью.</Hint>
              : <Hint>Это записанный прогон конвейера по примеру — без очереди и лимита. Любой другой сайт или ИНН соберётся вживую на сервере.</Hint>}
          </div>
          <ol className="steps">
            {steps.map((x, i) => (
              <li key={i} className={x.state}>
                <span className="mark" aria-hidden="true">{x.state === "done" ? "✓" : x.state === "run" ? "" : "○"}</span>
                <span>{x.text}</span>
              </li>
            ))}
          </ol>
          <div className="run-bar"><div className="rule-bar" style={{ ["--w" as string]: `${(doneCount / Math.max(steps.length, 1)) * 100}%` }} /><div className="rule-ticks" /></div>

          {phase === "confirm" && target && (
            <div className="confirm">
              <p>Нашли сайт по названию: <b>{domainOf(target)}</b>. Это сайт компании «{target.name}»? Берём только после вашего подтверждения — по названию легко попасть в однофамильца.</p>
              <div className="row-btns">
                <button type="button" className="btn pr" onClick={confirmSite}>Да, собрать с этого сайта</button>
                <button type="button" className="btn sec" onClick={() => { clear(); setPhase("idle"); setSteps([]); }}>Нет, введу сайт сам</button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === "live-done" && liveJob?.card && <LiveCard s={liveJob.card} spent={liveJob.spent_rub} />}

      {result && target && (
        <div className="result-card">
          <Mono s={target} size={56} />
          <div className="rc-main">
            <div className="rank">собрано сейчас {target.demo && <DemoPill />}</div>
            <div className="nm">{target.name}</div>
            <div className="sub">{categoryOf(target).name} · {result.place}-й из {result.n} в категории</div>
          </div>
          <Score value={result.sc.total} unit />
          <div className="row-btns">
            <a className="btn pr" href={href(`/s/${target.id}`, { vol: volParam(result.q.volume), prio: result.q.prio === "balanced" ? null : result.q.prio })}>Открыть карточку</a>
            <a className="btn sec" href={href("/results", { cat: target.category, vol: volParam(result.q.volume), prio: result.q.prio === "balanced" ? null : result.q.prio })}>Сравнить с остальными</a>
          </div>
        </div>
      )}

    </div>
  );
}

/** Карточка живого сбора: главное — сразу на экране. В общий набор не попадает: её никто ещё не проверял. */
function LiveCard({ s, spent }: { s: Supplier; spent: number | null }) {
  const cat = catById(s.category);
  const c = isKnown(s.company) ? s.company.value! : null;
  const decl = s.documents.declarations.value ?? [];
  const items = s.assortment?.value?.items ?? [];
  const rows: [string, string | null][] = [
    ["Юрлицо", s.legal_name.value],
    ["ИНН", s.inn.value],
    ["Компания в ФНС", c ? `${c.status === "active" ? "действует" : c.status} ${years(ageYears(c.registered_at))}, ОКВЭД ${c.okved_main}` : null],
    ["Адрес", s.address.value],
    ["Телефоны", s.phones.value?.join(", ") || null],
    ["Минимальный заказ", isKnown(s.min_order) ? minOrderText(s.min_order.value!) : null],
    ["Доставка", isKnown(s.delivery) ? deliveryText(s.delivery.value!) : null],
    ["Декларации", decl.length ? `${decl.length} ${plural(decl.length, "декларация", "декларации", "деклараций")} в Росаккредитации` : null],
    ["«Честный знак»", s.documents.marking && isKnown(s.documents.marking) ? s.documents.marking.value!.join(", ") : null],
    ["Ассортимент", items.length ? `${items.length} ${plural(items.length, "позиция", "позиции", "позиций")}: ${items.slice(0, 5).map((x) => x.name).join("; ")}${items.length > 5 ? "…" : ""}` : null],
  ];
  return (
    <div className="panel live-card">
      <div className="panel-h">
        <b>{s.name}</b>
        <span className="sub">{cat?.name ?? "категория не определена"}{spent != null && ` · модель: ${spent.toFixed(2).replace(".", ",")} ₽`}</span>
      </div>
      {s.not_supplier && <p className="rev-own">Конвейер решил, что это не поставщик: {s.not_supplier}</p>}
      {rows.map(([k, v]) => (
        <div key={k} className="mf-row"><span className="k">{k}</span><span className={v ? "mf-v" : "miss"}>{v ?? "не найдено"}</span></div>
      ))}
      <p className="sub">Карточка собрана сейчас и в общий набор не попадает: в продукте её сначала проверил бы человек. Значения с сайта — со слов поставщика, у каждого в данных есть цитата и страница.</p>
    </div>
  );
}
