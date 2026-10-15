// Отзывы в правой боковой панели (T-543, правка Павла 15.10): когда отзывов много, их не листать в плашке.
// Панель выезжает справа поверх страницы, у списка свой скролл; сверху — средняя и распределение по оценкам
// (строка — фильтр «только N звёзд»), сортировка: сначала новые, старые, хорошие, плохие. Там же — «Оставить отзыв».
// Отзывы с сервера и примеры из интерфейса — в одном списке; пример помечен плашкой.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Supplier } from "../types.ts";
import { addReview, ApiError, reviews as loadReviews, type Reviews as ReviewList } from "../lib/api.ts";
import { sampleReviews } from "../lib/sampleReviews.ts";
import { avgText, patchReviewStat } from "../lib/reviewStats.ts";
import { plural } from "../lib/format.ts";
import { Hint, Stars } from "./ui.tsx";

/** Отзывы поставщика с сервера; ответ по прошлому поставщику (быстрый переход) не подменяет список этого. */
export function useSupplierReviews(id: string) {
  const [list, setList] = useState<ReviewList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setList(null); setErr(null);
    loadReviews(id).then((l) => alive && setList(l)).catch((e) => alive && setErr(e instanceof ApiError ? e.message : "Отзывы не загрузились."));
    return () => { alive = false; };
  }, [id]);
  return { list, err, setList };
}

interface Item { rating: number; text: string; author: string; date: string; sample: boolean }
type Sort = "new" | "old" | "good" | "bad";
const SORTS: { id: Sort; label: string }[] = [
  { id: "new", label: "Сначала новые" }, { id: "old", label: "Сначала старые" },
  { id: "good", label: "Сначала хорошие" }, { id: "bad", label: "Сначала плохие" },
];

/** Все отзывы поставщика одним списком: с сервера и примеры. */
export function reviewItems(id: string, list: ReviewList | null): Item[] {
  return [
    ...(list?.items ?? []).map((r) => ({ rating: r.rating, text: r.text, author: r.author ?? "Закупщик", date: r.created_at, sample: false })),
    ...sampleReviews(id).map((r) => ({ ...r, sample: true })),
  ];
}

export function ReviewsDrawer({ s, list, err, setList, startWithForm, onClose }: {
  s: Supplier;
  list: ReviewList | null;
  err: string | null;
  setList: (l: ReviewList) => void;
  startWithForm: boolean;
  onClose: () => void;
}) {
  const items = reviewItems(s.id, list);
  const [sort, setSort] = useState<Sort>("new");
  const [only, setOnly] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(startWithForm);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [trap, setTrap] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // страница под панелью не прокручивается; Esc закрывает; фокус — на кнопку закрытия
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  useEffect(() => { listRef.current?.scrollTo(0, 0); }, [sort, only]);

  const n = items.length;
  const avg = n ? items.reduce((a, r) => a + r.rating, 0) / n : 0;
  const byStars = [5, 4, 3, 2, 1].map((k) => ({ k, c: items.filter((r) => r.rating === k).length }));
  const shown = items
    .filter((r) => only === null || r.rating === only)
    .sort((a, b) => sort === "new" ? b.date.localeCompare(a.date) : sort === "old" ? a.date.localeCompare(b.date)
      : sort === "good" ? b.rating - a.rating || b.date.localeCompare(a.date) : a.rating - b.rating || b.date.localeCompare(a.date));

  const send = async () => {
    setSending(true); setSendErr(null);
    try {
      const next = await addReview(s.id, { rating, text, author, website: trap });
      setList(next);
      patchReviewStat(s.id, next.count, next.avg);      // оценка в шапке и в списках — сразу с новым отзывом
      setSent(true); setFormOpen(false); setText(""); setRating(0); setSort("new"); setOnly(null);
    } catch (e) {
      setSendErr(e instanceof ApiError ? e.message : "Отзыв не отправился. Попробуйте ещё раз.");
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <>
      <div className="rev-scrim" onClick={onClose} />
      <aside className="rev-drawer" role="dialog" aria-modal="true" aria-label={`Отзывы · ${s.name}`}>
        <div className="rd-head">
          <div>
            <span className="label">Отзывы клиентов</span>
            <b className="rd-name">{s.name}</b>
          </div>
          <button ref={closeBtn} type="button" className="rd-x" aria-label="Закрыть отзывы" onClick={onClose}>×</button>
        </div>

        <div className="rd-sum">
          {n ? (
            <>
              <div className="rd-avg">
                <b className="num">{avgText(avg)}</b>
                <Stars avg={avg} />
                <span className="sub">{n} {plural(n, "отзыв", "отзыва", "отзывов")}</span>
              </div>
              <div className="rd-hist" role="group" aria-label="Фильтр по оценке">
                {byStars.map(({ k, c }) => (
                  <button key={k} type="button" className={`rd-h${only === k ? " on" : ""}`} aria-pressed={only === k} disabled={!c}
                    onClick={() => setOnly(only === k ? null : k)} title={c ? `Только ${k} ★` : `Отзывов на ${k} ★ нет`}>
                    <span className="rd-k num">{k} ★</span>
                    <span className="rd-bar"><i style={{ width: `${(c / n) * 100}%` }} /></span>
                    <span className="rd-c num">{c}</span>
                  </button>
                ))}
              </div>
            </>
          ) : <p className="sub rd-none">Отзывов пока нет — станьте первым.</p>}
          {err && <p className="rev-own">{err}</p>}
        </div>

        {n > 0 && (
          <div className="rd-tools">
            <label className="rd-sort">
              <span className="sr-only">Порядок отзывов</span>
              <select className="input sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Порядок отзывов">
                {SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </label>
            <span className="rd-shown sub">{only === null ? `все ${n}` : `${shown.length} из ${n} · только ${only} ★`}</span>
            {only !== null && <button type="button" className="link-btn" onClick={() => setOnly(null)}>показать все</button>}
          </div>
        )}

        <ul className="rev-list rd-list" ref={listRef}>
          {shown.map((r, i) => (
            <li key={`${r.date}-${i}`} className={r.sample ? "rev-ex" : ""}>
              {r.sample && <span className="rev-ex-pill">пример отзыва<Hint label="Пример отзыва">Отзыв-пример: показывает, как работает функция отзывов. Текст написан для прототипа, а не закупщиком; в оценке считается как обычный отзыв.</Hint></span>}
              <span className="rev-stars" aria-label={`Оценка ${r.rating} из 5`}><b>{"★".repeat(r.rating)}</b>{"★".repeat(5 - r.rating)}</span> {r.text}
              <span className="sub">{r.author} · {new Date(r.date).toLocaleDateString("ru-RU")}</span>
            </li>
          ))}
        </ul>

        <div className="rd-foot">
          {sent && <p className="rev-own">Спасибо — отзыв виден всем, кто откроет карточку.</p>}
          {!formOpen && <button type="button" className="btn sec sm" onClick={() => { setFormOpen(true); setSent(false); }}>Оставить отзыв</button>}
          {formOpen && (
            <div className="rev-form">
              <span className="label">Оценка</span>
              <div className="rev-rate" role="group" aria-label="Оценка от 1 до 5">
                {[1, 2, 3, 4, 5].map((k) => <button key={k} type="button" className={k <= rating ? "on" : ""} aria-pressed={k === rating} onClick={() => setRating(k)}>{k}</button>)}
              </div>
              <label className="label" htmlFor={`rev-t-${s.id}`}>Отзыв</label>
              <textarea id={`rev-t-${s.id}`} className="input" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="например: привозят вовремя, цены как в прайсе; минимальный заказ на деле выше" />
              <label className="label" htmlFor={`rev-a-${s.id}`}>Кто вы — по желанию</label>
              <input id={`rev-a-${s.id}`} className="input" maxLength={60} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="например: кафе на Ленина" />
              <input className="rev-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trap} onChange={(e) => setTrap(e.target.value)} name="website" />
              {sendErr && <p className="rev-own">{sendErr}</p>}
              <div className="row-btns">
                <button type="button" className="btn pr sm" disabled={!rating || text.trim().length < 10 || sending} onClick={send}>{sending ? "Отправляю…" : "Отправить"}</button>
                <button type="button" className="btn sec sm" onClick={() => setFormOpen(false)}>Отмена</button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
