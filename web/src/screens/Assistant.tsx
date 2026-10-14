// Помощник (T-536): человек описывает точку → модель предлагает, что может понадобиться → поставщиков подбирает сервер
// кодом по ассортименту набора. Модель названий поставщиков не видит, поэтому назвать того, кого нет в наборе, не может.
import { useEffect, useState, type FormEvent } from "react";
import { href } from "../router.ts";
import { plural } from "../lib/format.ts";
import { ApiError, assist, health, match, type Health, type Match, type Suggest } from "../lib/api.ts";
import { Hint } from "../components/ui.tsx";

const EXAMPLES = ["у меня бабл-ти в ТЦ", "суши-бар на доставку", "пиццерия у дома", "кофейня у метро"];

export function Assistant() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"suggest" | "match" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sug, setSug] = useState<Suggest | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [res, setRes] = useState<Match | null>(null);
  const [hl, setHl] = useState<Health | null>(null);

  useEffect(() => { health().then(setHl).catch(() => setHl(null)); }, [sug]);

  const ask = async (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    setText(v); setBusy("suggest"); setErr(null); setSug(null); setRes(null);
    try {
      const s = await assist(v);
      setSug(s);
      setPicked(new Set(s.needs.filter((n) => n.suppliers_count > 0).map((n) => n.id)));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Что-то пошло не так. Попробуйте ещё раз.");
    } finally {
      setBusy(null);
    }
  };

  const pick = async () => {
    if (!sug || busy) return;
    setBusy("match"); setErr(null);
    try {
      setRes(await match(sug.needs.filter((n) => picked.has(n.id))));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Что-то пошло не так. Попробуйте ещё раз.");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) => {
    setRes(null);
    setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(text); };
  const left = hl?.demo_left.assist;

  return (
    <div className="assistant">
      <div className="label">Помощник</div>
      <h1 className="h1">Не знаете, что нужно?</h1>
      <p className="lead-sm">Опишите точку своими словами — помощник предложит, что ей обычно закупают, а поставщиков подберёт из собранного набора по их ассортименту.</p>

      <form className="add-form" onSubmit={submit}>
        <input className="input lg" value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
          placeholder="например: у меня бабл-ти в ТЦ" aria-label="Опишите точку" />
        <button className="btn pr lg" type="submit" disabled={!!busy || text.trim().length < 3}>{busy === "suggest" ? "Думаю…" : "Подсказать"}</button>
      </form>
      <div className="examples">
        <span className="label">Примеры</span>
        {EXAMPLES.map((x) => <button key={x} type="button" className="pill-out sm" disabled={!!busy} onClick={() => ask(x)}>{x}</button>)}
      </div>
      {left && (
        <p className="assist-quota">
          Демо-стенд: {left.left > 0 ? <>осталось {left.left} из {left.per_day} {plural(left.per_day, "запроса", "запросов", "запросов")} на сегодня</> : <>запросы на сегодня закончились</>}
          <Hint label="Почему лимит">Стенд сделан для проверки, а не для публики: каждый запрос — вызов языковой модели за деньги. В продукте вместо этого — квоты на аккаунт. Повтор того же описания лимит не тратит.</Hint>
        </p>
      )}

      {busy === "suggest" && <div className="panel assist-wait">Разбираю описание — обычно 5–15 секунд…</div>}
      {err && <div className="panel warn"><b>{err}</b></div>}

      {sug && (
        <section className="assist-step">
          <div className="panel-h">
            <b>{sug.place ? `Для точки «${sug.place}» обычно нужно` : "Что может понадобиться"}</b>
            <Hint>Варианты предложила языковая модель по вашему описанию. Число рядом — сколько поставщиков в наборе продают такое: его считает код по ассортименту, а не модель.</Hint>
          </div>
          {sug.question && <p className="assist-q">{sug.question}</p>}
          {sug.needs.length > 0 && (
            <>
              <div className="assist-needs" role="group" aria-label="Что нужно">
                {sug.needs.map((n) => (
                  <button key={n.id} type="button" className={`assist-need${picked.has(n.id) ? " on" : ""}`} aria-pressed={picked.has(n.id)}
                    onClick={() => toggle(n.id)} title={n.why}>
                    <span>{n.label}</span>
                    <span className={`assist-n${n.suppliers_count ? "" : " zero"}`}>{n.suppliers_count || "нет"}</span>
                  </button>
                ))}
              </div>
              <div className="row-btns">
                <button type="button" className="btn pr" disabled={!picked.size || !!busy} onClick={pick}>
                  {busy === "match" ? "Подбираю…" : `Подобрать поставщиков${picked.size ? ` · ${picked.size}` : ""}`}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {res && <Result res={res} />}
    </div>
  );
}

function Result({ res }: { res: Match }) {
  const found = res.by_need.filter((b) => b.suppliers.length);
  return (
    <section className="assist-res">
      {res.best.length > 0 && (
        <div className="panel">
          <div className="panel-h"><b>Закрывают несколько позиций сразу</b><Hint>Удобно заказывать у одного: меньше минимальных заказов и доставок.</Hint></div>
          <div className="assist-best">
            {res.best.map((b) => (
              <a key={b.id} className="assist-best-i" href={href(`/s/${b.id}`)}>
                <b>{b.name}</b>
                <span className="sub">{b.category_name}</span>
                <span className="assist-covers">{b.covers.join(" · ")}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {found.map((b) => (
        <div key={b.label} className="panel">
          <div className="panel-h"><b>{b.label}</b><span className="sub">{b.suppliers.length} {plural(b.suppliers.length, "поставщик", "поставщика", "поставщиков")}</span></div>
          <ul className="assist-list">
            {b.suppliers.map((s) => (
              <li key={s.id}>
                <a href={href(`/s/${s.id}`)}><b>{s.name}</b></a>
                <span className="sub">{s.category_name}</span>
                <span className="assist-item">
                  {s.exact ? "есть" : "похоже"}: «{s.matched[0]}»{s.matched_total > 1 && ` и ещё ${s.matched_total - 1}`}
                </span>
              </li>
            ))}
          </ul>
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
