import { useEffect, useRef, useState, type FormEvent } from "react";
import { href, type Route } from "../router.ts";
import { actions, useStore } from "../store.ts";
import { categoryOf, DATA, rankCategory, readQuery } from "../data.ts";
import { activeDeclarations } from "../lib/score.ts";
import { ageYears, isKnown, plural, years } from "../lib/format.ts";
import type { Supplier } from "../types.ts";
import { DemoPill, Hint, Mono, Score } from "../components/ui.tsx";

type Phase = "idle" | "run" | "confirm" | "done" | "unknown" | "exists";
interface Step { text: string; state: "done" | "run" | "wait" }

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
  const decl = activeDeclarations(s).length;
  return [
    `Открыли сайт: ${pages.slice(0, 4).join(", ")} — ${pages.length} ${pages.length < 5 ? "страницы" : "страниц"}`,
    isKnown(s.inn) ? `Нашли ИНН в реквизитах: ${s.inn.value}` : "ИНН на сайте не нашли — реестры проверить не выйдет",
    "Раскладываем текст по полям — модель выносит цитату к каждому значению, без цитаты значение отбрасываем",
    isKnown(s.company) ? `ФНС: действует ${years(ageYears(s.company.value!.registered_at))}, ОКВЭД ${s.company.value!.okved_main}, ${s.company.value!.flags.length ? "есть флаги" : "красных флагов нет"}` : "ФНС: без ИНН не проверить",
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
  const timers = useRef<number[]>([]);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);
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

  const start = (value: string) => {
    clear();
    setElapsed(0);
    const r = resolve(value);
    if (!r) { setPhase("unknown"); setTarget(null); setSteps([]); return; }
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

      {phase === "unknown" && (
        <div className="panel warn">
          <b>В демо-версии живой сбор подключён только для двух примеров выше.</b>
          <p>Сервер сбора (Python, FastAPI) разворачивается вместе с публикацией сервиса. Демо-версия не открывает чужие сайты и не придумывает карточку по введённому адресу — иначе вышли бы выдуманные данные о настоящей компании.</p>
        </div>
      )}
      {phase === "exists" && target && (
        <div className="panel">
          <b>{target.name} уже есть в собранном наборе.</b> <a href={href(`/s/${target.id}`)}>Открыть карточку →</a>
        </div>
      )}

      {steps.length === 0 && phase !== "exists" && (
        <div className="run panel preview">
          <div className="run-h"><b>Что сделает конвейер</b><span className="sub">30–60 секунд · около 1 ₽<Hint>Если сайт запрещает автоматический сбор или не открылся, карточка всё равно создаётся по ЕГРЮЛ и реестрам, а поля сайта помечаются «○ не собрано» с причиной.</Hint></span></div>
          <ol className="steps">
            {[
              "Откроет сайт: главная, «Контакты», «Доставка», «Оптовикам», «Реквизиты» — до 6 страниц, по правилам robots.txt",
              "Найдёт ИНН в реквизитах, оферте или политике конфиденциальности",
              "Разложит текст по полям: у каждого значения — дословная цитата; нет цитаты — нет значения",
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
            <b>{phase === "done" ? "Готово" : phase === "confirm" ? "Нужно ваше подтверждение" : "Собираем данные"} · <span className="num">0:{String(elapsed).padStart(2, "0")}</span></b>
            <Hint>В продукте 30–60 секунд; в демо шаги проигрываются по заранее собранной карточке.</Hint>
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
            <a className="btn pr" href={href(`/s/${target.id}`, { vol: result.q.volume, prio: result.q.prio === "balanced" ? null : result.q.prio })}>Открыть карточку</a>
            <a className="btn sec" href={href("/results", { cat: target.category, vol: result.q.volume, prio: result.q.prio === "balanced" ? null : result.q.prio })}>Сравнить с остальными</a>
          </div>
        </div>
      )}

    </div>
  );
}
