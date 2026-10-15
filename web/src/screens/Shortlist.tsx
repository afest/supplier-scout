import { useEffect, useMemo, useState } from "react";
import { href, navigate, useRoute } from "../router.ts";
import { actions, CONTACT_STATUSES, useStore, type ContactStatus } from "../store.ts";
import { byId, categoryOf, orphanShortIds, rankCategory, readQuery, shortlistIds, subsIn, volParam, type Query } from "../data.ts";
import { draftRequest } from "../lib/explain.ts";
import { score, type Scored } from "../lib/score.ts";
import type { Supplier } from "../types.ts";
import { isKnown, plural } from "../lib/format.ts";
import { Avatar, CatGlyph, Hint, Score, StatusIcon } from "../components/ui.tsx";
import { logoOf } from "../lib/logos.ts";

/** Записи о поставщиках, которых нет в нынешнем наборе: не считаются и не показываются, но и не удаляются молча —
 *  после пересборки набора ID могут смениться, и с записью ушла бы заметка закупщика. Убрать — его решение. */
function Orphans({ ids, notes }: { ids: string[]; notes: number }) {
  if (!ids.length) return null;
  const n = ids.length;
  return (
    <p className="orphans">
      Ещё {n} {plural(n, "запись", "записи", "записей")} — о поставщиках, которых нет в нынешнем наборе{notes ? `, в ${notes} есть заметка` : ""}. В счётчик не входят.{" "}
      <button type="button" className="link-btn" onClick={() => actions.dropShort(ids)}>Убрать</button>
    </p>
  );
}

export function Shortlist() {
  const st = useStore();
  const route = useRoute();
  const ids = shortlistIds(st);
  const orphans = orphanShortIds(st);
  const orphanNotes = orphans.filter((id) => st.shortlist[id].note).length;
  const draftId = route.params.get("draft");
  const [sel, setSel] = useState<string | null>(draftId && ids.includes(draftId) ? draftId : ids[0] ?? null);
  useEffect(() => {
    if (draftId && ids.includes(draftId)) setSel(draftId);
  }, [draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastParams = new URLSearchParams(st.last ? { vol: st.last.vol, prio: st.last.prio } : {});
  const rows = useMemo(() => ids.map((id) => {
    const s = byId.get(id)!;
    const p = new URLSearchParams(lastParams);
    p.set("cat", s.category);
    const q = readQuery(p);
    const peers = rankCategory(q, st).ranked.map((r) => r.supplier);
    return { s, q, sc: score(s, { volume: q.volume, category: q.cat, peers }, q.prio), item: st.shortlist[id] };
  }), [st]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = rows.find((r) => r.s.id === sel) ?? rows[0];
  const sameCat = current ? rows.filter((r) => r.s.category === current.s.category).map((r) => r.s.id) : [];

  const csv = () => {
    const head = ["Поставщик", "Категория", "Балл", "Статус контакта", "Заметка", "Телефон", "Email", "Сайт", "Демо"];
    const lines = rows.map(({ s, sc, item }) => [s.name, categoryOf(s).name, sc.total, item.status, item.note, s.phones.value?.join(", ") ?? "", s.emails.value?.join(", ") ?? "", s.website.value ?? "", s.demo ? "да" : "нет"]);
    const text = [head, ...lines].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "шорт-лист-поставщиков.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!rows.length) {
    return (
      <div className="empty">
        <div className="empty-illu">
          {["packaging", "fish"].map((c) => <img key={c} src={`categories/${c}.webp`} alt="" width={120} height={120} />)}
        </div>
        <h1 className="h1">Шорт-лист пуст</h1>
        <p>Отметьте звёздочкой поставщиков в результатах или в карточке — здесь появятся статусы контакта, заметки и черновик запроса.</p>
        <a className="btn pr" href="#/">Найти поставщика</a>
        <Orphans ids={orphans} notes={orphanNotes} />
      </div>
    );
  }

  return (
    <div className="shortlist">
      <div className="page-h">
        <h1 className="h1">Шорт-лист <span className="count-big num">{rows.length}</span><Hint>Статусы: {CONTACT_STATUSES.join(" · ")}. Заметка отсюда и с карточки — одна и та же. Всё хранится в этом браузере, без регистрации.</Hint></h1>
        <div className="page-tools">
          <button type="button" className="btn sec" onClick={csv}>Скачать CSV</button>
          <a className={`btn sec${sameCat.length < 2 ? " disabled" : ""}`} aria-disabled={sameCat.length < 2}
            href={sameCat.length < 2 ? undefined : href("/compare", { ids: sameCat.slice(0, 4).join(","), cat: current.s.category, vol: volParam(current.q.volume), prio: current.q.prio === "balanced" ? null : current.q.prio })}
            title="Сравнение — внутри одной категории">
            Сравнить · {current ? categoryOf(current.s).short.toLowerCase() : ""}
          </a>
        </div>
      </div>

      <div className="sl-grid">
        <div className="sl-list">
          {rows.map(({ s, sc, item }) => {
            const cat = categoryOf(s);
            return (
              <div key={s.id} className={`sl-row${current?.s.id === s.id ? " on" : ""}`}>
                <Avatar s={s} size={40} logo={logoOf(s.id)} />
                <div className="sl-main">
                  <a className="nm" href={href(`/s/${s.id}`)}>{s.name}</a>
                  <div className="sub"><CatGlyph cat={cat} size={20} /> {cat.short} · <Score value={sc.total} className="xs" /></div>
                </div>
                <label className="sl-status">
                  <span className="sr-only">Статус контакта</span>
                  <select className={`input sm st-${CONTACT_STATUSES.indexOf(item.status)}`} value={item.status} onChange={(e) => actions.setStatus(s.id, e.target.value as ContactStatus)}>
                    {CONTACT_STATUSES.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </label>
                <NoteCell id={s.id} note={item.note} />
                <div className="sl-actions">
                  <button type="button" className={`btn sm ${current?.s.id === s.id ? "pr" : "sec"}`} onClick={() => navigate("/shortlist", { draft: s.id }, { replace: true })}>Черновик</button>
                  <button type="button" className="x" aria-label={`Убрать ${s.name} из шорт-листа`} onClick={() => actions.toggleShort(s.id)}>×</button>
                </div>
              </div>
            );
          })}
          <Orphans ids={orphans} notes={orphanNotes} />
        </div>

        {current && <Draft key={current.s.id} row={current} />}
      </div>
    </div>
  );
}

function NoteCell({ id, note }: { id: string; note: string }) {
  const [text, setText] = useState(note);
  useEffect(() => setText(note), [note]);
  return (
    <label className="sl-note">
      <span className="sr-only">Заметка</span>
      {note && <StatusIcon status="user" />}
      <input className="input sm" value={text} placeholder="заметка ✎" onChange={(e) => setText(e.target.value)} onBlur={() => text !== note && actions.setNote(id, text)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

function Draft({ row }: { row: { s: Supplier; q: Query; sc: Scored } }) {
  const { s, q, sc } = row;
  const cat = categoryOf(s);
  // первая подкатегория своей категории; у поставщика без подкатегорий (ассортимент не собран) — категория целиком
  const sub = subsIn(s, cat)[0];
  const d = draftRequest(sc, cat, sub ? sub.name : cat.name, q.volume);
  const [text, setText] = useState(d.text);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const email = isKnown(s.emails) ? s.emails.value![0] : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };
  return (
    <aside className="draft">
      <div className="panel-h"><b>Черновик запроса<Hint>Вопросы собраны из полей «○ не найдено» и «◐ уточнить» карточки: {d.from.map((x) => x.label).join(", ")}. Сервис ничего не отправляет сам — письмо уходит от вас.</Hint></b><span className="sub">{s.name}</span></div>
      <textarea className="draft-text" value={text} onChange={(e) => setText(e.target.value)} rows={13} aria-label="Текст запроса" />
      <div className="row-btns">
        <button type="button" className="btn pr" onClick={copy}>{copied === "ok" ? "Скопировано" : "Скопировать"}</button>
        <a className={`btn sec${email ? "" : " disabled"}`} aria-disabled={!email}
          href={email && !s.demo ? `mailto:${email}?subject=${encodeURIComponent("Запрос условий поставки")}&body=${encodeURIComponent(text)}` : undefined}
          title={s.demo ? "У демо-поставщика адрес-заглушка" : email ? `Откроется почтовая программа: ${email}` : "Email на сайте не найден"}>
          Открыть в почте
        </a>
      </div>
      {copied === "fail" && <div className="q plain">Браузер не дал доступ к буферу — выделите текст и скопируйте вручную.</div>}
    </aside>
  );
}
