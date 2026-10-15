import { useEffect, useMemo, useState } from "react";
import { href, navigate, useRoute } from "../router.ts";
import { actions, CONTACT_STATUSES, MAX_COMPARE, useStore, type ContactStatus, type ShortItem, type WantItem } from "../store.ts";
import { byId, CATEGORIES, categoryOf, inCategory, orphanShortIds, rankCategory, readQuery, shortlistIds, subsIn, volParam, type Query } from "../data.ts";
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
  // сравнение — те, у кого отмечено «Сравнить» (здесь, в списках или на странице поставщика), а не первые из категории
  // текущей строки (Павел 15.10, T-546: «не понимаю, что с чем сравниваем»). Сравнивают внутри одной категории
  const [notice, setNotice] = useState("");
  const cmpIds = st.compare.filter((id) => byId.has(id));
  const cmpCat = CATEGORIES.find((c) => cmpIds.length > 0 && cmpIds.every((id) => inCategory(byId.get(id)!, c))) ?? null;
  const toggleCmp = (s: Supplier) => {
    setNotice("");
    const own = categoryOf(s);
    if (st.compare.some((x) => { const o = byId.get(x); return !o || !inCategory(o, own); })) {
      actions.setCompare([s.id]);
      if (cmpIds.length) setNotice(`Сравнивают внутри одной категории — выбор начат заново: ${own.name.toLowerCase()}.`);
    } else if (!actions.toggleCompare(s.id)) setNotice(`В сравнении уже ${MAX_COMPARE} поставщика — снимите отметку с одного.`);
  };

  const csv = () => {
    // «Позиции» — в конце: колонки, которые уже разбирают таблицы закупщиков, остаются на своих местах (T-546)
    const head = ["Поставщик", "Категория", "Балл", "Статус контакта", "Заметка", "Телефон", "Email", "Сайт", "Демо", "Позиции"];
    const lines = rows.map(({ s, sc, item }) => [s.name, categoryOf(s).name, sc.total, item.status, item.note, s.phones.value?.join(", ") ?? "",
      s.emails.value?.join(", ") ?? "", s.website.value ?? "", s.demo ? "да" : "нет", (st.wanted[s.id] ?? []).map((w) => w.name).join(", ")]);
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
          <a className={`btn sec${cmpIds.length < 2 || !cmpCat ? " disabled" : ""}`} aria-disabled={cmpIds.length < 2 || !cmpCat}
            href={cmpIds.length < 2 || !cmpCat ? undefined : href("/compare", { ids: cmpIds.join(","), cat: cmpCat.id, vol: volParam(current.q.volume), prio: current.q.prio === "balanced" ? null : current.q.prio })}
            title={cmpIds.length < 2 ? "Отметьте «Сравнить» у двух–четырёх поставщиков одной категории" : "Сравнение отмеченных"}>
            Сравнить{cmpIds.length ? ` · ${cmpIds.length}` : ""}{cmpCat ? ` · ${cmpCat.short.toLowerCase()}` : ""}
          </a>
        </div>
      </div>

      {notice && <div className="notice" role="status">{notice}</div>}
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
                <button type="button" className={`btn sm sec sl-cmp${st.compare.includes(s.id) ? " on" : ""}`} aria-pressed={st.compare.includes(s.id)}
                  onClick={() => toggleCmp(s)}>{st.compare.includes(s.id) ? "✓ В сравнении" : "Сравнить"}</button>
                <History item={item} wanted={st.wanted[s.id] ?? []} />
                <div className="sl-actions">
                  <button type="button" className={`btn sm ${current?.s.id === s.id ? "pr" : "sec"}`} onClick={() => navigate("/shortlist", { draft: s.id }, { replace: true })}>Черновик</button>
                  <button type="button" className="x" aria-label={`Убрать ${s.name} из шорт-листа`} onClick={() => actions.toggleShort(s.id)}>×</button>
                </div>
              </div>
            );
          })}
          <Orphans ids={orphans} notes={orphanNotes} />
        </div>

        {/* ключ с позициями: убрали позицию на странице поставщика — черновик собирается заново */}
        {current && <Draft key={`${current.s.id}|${(st.wanted[current.s.id] ?? []).map((w) => w.name).join("|")}`} row={current} wanted={st.wanted[current.s.id] ?? []} />}
      </div>
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });

/** Мини-история строки (Павел 15.10, T-546): когда и откуда поставщик попал в шорт-лист и какие позиции у него выбраны.
 *  Свёрнута в строку-подсказку, по шеврону — подробно, с чипами позиций по поводу, где их выбрали. */
function History({ item, wanted }: { item: ShortItem; wanted: WantItem[] }) {
  const [open, setOpen] = useState(false);
  const groups: { from: string; at: string | undefined; items: WantItem[] }[] = [];
  for (const w of wanted) {
    const key = w.from ?? "";
    const g = groups.find((x) => x.from === key);
    if (g) g.items.push(w);
    else groups.push({ from: key, at: w.at, items: [w] });
  }
  return (
    <div className="sl-hist">
      <button type="button" className="sl-hist-t" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sl-hist-sum">
          в шорт-листе с {day(item.added_at)}{item.from ? ` · ${item.from}` : ""}
          {wanted.length > 0 && <b> · {wanted.length} {plural(wanted.length, "позиция", "позиции", "позиций")}</b>}
        </span>
        <svg className="sl-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul className="sl-hist-list">
          <li><span className="sl-hist-at num">{when(item.added_at)}</span><span>добавлен в шорт-лист{item.from ? <> — {item.from}</> : ""}</span></li>
          {groups.map((g) => (
            <li key={g.from}>
              <span className="sl-hist-at num">{g.at ? when(g.at) : ""}</span>
              <span>
                выбрали позиции{g.from ? <> — {g.from}</> : ""}
                <span className="mc-chips">{g.items.map((w) => <span key={w.name} className="mc-chip on" title={w.text && w.text !== w.name ? w.text : undefined}>{w.name}</span>)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
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

function Draft({ row, wanted }: { row: { s: Supplier; q: Query; sc: Scored }; wanted: WantItem[] }) {
  const { s, q, sc } = row;
  const cat = categoryOf(s);
  // первая подкатегория своей категории; у поставщика без подкатегорий (ассортимент не собран) — категория целиком
  const sub = subsIn(s, cat)[0];
  const d = draftRequest(sc, cat, sub ? sub.name : cat.name, q.volume, wanted);
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
      <div className="panel-h"><b>Черновик запроса<Hint>Вопросы собраны из полей «○ не найдено» и «◐ уточнить» карточки: {d.from.map((x) => x.label).join(", ")}. {wanted.length > 0 && " Позиции — те, что вы выбрали у поставщика: в подборе помощника, плане закупа или поиске."} Сервис ничего не отправляет сам — письмо уходит от вас.</Hint></b><span className="sub">{s.name}</span></div>
      <textarea className="draft-text" value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(13 + wanted.length + (wanted.length ? 3 : 0), 28)} aria-label="Текст запроса" />
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
