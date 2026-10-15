import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Category, FieldStatus, Supplier } from "../types.ts";
import { initials, plural } from "../lib/format.ts";
import { avgText, type ReviewStat } from "../lib/reviewStats.ts";
import { level } from "../lib/level.ts";
import type { Logo } from "../lib/logos.ts";

// ---------- статусы полей: различаются формой знака, не цветом ----------
export const STATUS_LABEL: Record<FieldStatus, string> = {
  found: "найдено в государственном реестре",
  claimed: "со слов поставщика: его сайт, прайс",
  not_found: "не найдено: искали и не нашли",
  estimated: "оценка: открытых данных нет, ориентир по рынку",
  user: "вручную: внёс закупщик",
};
export const STATUS_SHORT: Record<FieldStatus, string> = {
  found: "найдено", claimed: "со слов поставщика", not_found: "не найдено", estimated: "оценка", user: "вручную",
};

export function StatusIcon({ status, size = 12 }: { status: FieldStatus | null; size?: number }) {
  if (!status) return null;
  const s = { width: size, height: size };
  let g: ReactNode;
  switch (status) {
    case "found": g = <circle cx="6" cy="6" r="4.6" fill="var(--ink)" />; break;
    case "claimed":
      g = <><circle cx="6" cy="6" r="4.2" fill="none" stroke="var(--ink)" strokeWidth="1.3" /><path d="M6 1.8a4.2 4.2 0 0 1 0 8.4z" fill="var(--ink)" /></>;
      break;
    case "not_found": g = <circle cx="6" cy="6" r="4.2" fill="none" stroke="var(--muted-soft)" strokeWidth="1.3" />; break;
    case "estimated": g = <path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="var(--steel-ink)" strokeWidth="1.3" strokeLinejoin="round" />; break;
    case "user":
      g = <path d="M2 10l.6-2.6L8 2l2 2-5.4 5.4zM7 3l2 2" fill="none" stroke="var(--ink)" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />;
      break;
  }
  return (
    <svg className="st" viewBox="0 0 12 12" style={s} role="img" aria-label={STATUS_SHORT[status]}>
      <title>{STATUS_LABEL[status]}</title>
      {g}
    </svg>
  );
}

// ---------- носители сущностей: поставщик — квадрат, категория — круг, документ — лист ----------
export function Mono({ s, size = 44 }: { s: Pick<Supplier, "name">; size?: number }) {
  return (
    <span className="mono" style={{ width: size, height: size, fontSize: size * 0.36, borderRadius: size * 0.27 }} aria-hidden="true">
      {initials(s.name)}
    </span>
  );
}

/** Аватар поставщика: логотип, если он есть, иначе монограмма в цветах дизайн-системы.
 *  Логотип в покое — одноцветный синий: SVG-фильтр #ava-navy (AvaFilters) перекрашивает саму картинку, файл не меняется;
 *  свои цвета — при наведении на карточку или фокусе в ней (.lcard, .gcard). Белый логотип (onDark) — на тёмной плашке всегда. */
export function Avatar({ s, size = 48, logo, color = false }: { s: Pick<Supplier, "name">; size?: number; logo?: Logo; /** свои цвета всегда — страница поставщика (T-543) */ color?: boolean }) {
  if (!logo) return <Mono s={s} size={size} />;
  return (
    <span className={`ava${logo.onDark ? " dk" : ""}${color ? " color" : ""}`} style={{ width: size, height: size, borderRadius: size * 0.27 }} aria-hidden="true">
      <img src={logo.src} alt="" loading="lazy" />
    </span>
  );
}

/** Фильтр «логотип в синий»: яркость → от --navy (тёмное) до белого (светлое), средние тона темнее (гамма 1,8), прозрачность не трогается.
 *  Раньше — слой --navy в режиме lighten поверх картинки: полупрозрачные края логотипа становились серым контуром (круг 3). */
export function AvaFilters() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id="ava-navy" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="gamma" amplitude="0.8353" exponent="1.8" offset="0.1647" />
          <feFuncG type="gamma" amplitude="0.7725" exponent="1.8" offset="0.2275" />
          <feFuncB type="gamma" amplitude="0.6706" exponent="1.8" offset="0.3294" />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

const GLYPHS: Record<string, ReactNode> = {
  fish: <><path d="M18 48c8-11 20-15 31-12 6 2 10 6 13 12-3 6-7 10-13 12-11 3-23-1-31-12z" /><path d="M62 48l12-9v18z" /><circle cx="30" cy="45" r="1.8" fill="currentColor" stroke="none" /><path d="M40 39c2 6 2 12 0 18" /></>,
  cheese: <><path d="M20 58V44l40-14 16 14v14z" /><path d="M20 44h56" /><circle cx="36" cy="51" r="3" /><circle cx="56" cy="53" r="2.2" /><circle cx="64" cy="48" r="1.6" /></>,
  rice: <><path d="M20 48h56c0 13-12 22-28 22S20 61 20 48z" /><path d="M27 48c2-6 7-9 12-8 3-5 10-6 14-2 5-2 11 1 13 6" /><path d="M58 22l18 16M64 20l14 18" /></>,
  box: <><path d="M48 24 74 36v26L48 74 22 62V36z" /><path d="M22 36l26 12 26-12M48 48v26" /><path d="M35 30l26 12" /></>,
  doc: <><path d="M28 18h28l14 14v46H28z" /><path d="M56 18v14h14" /><path d="M36 44h24M36 52h24M36 60h16" /></>,
};

export function CatGlyph({ cat, size = 24, onDark = false }: { cat: Pick<Category, "glyph">; size?: number; onDark?: boolean }) {
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden="true" className="cat-glyph">
      <circle cx="48" cy="48" r="46" fill={onDark ? "rgba(236,240,249,.16)" : "var(--surface-cool)"} />
      <g fill="none" stroke={onDark ? "#ECF0F9" : "var(--steel-ink)"} strokeWidth={size < 32 ? 4.5 : 2.6} strokeLinecap="round" strokeLinejoin="round" color={onDark ? "#ECF0F9" : "var(--steel-ink)"}>
        {GLYPHS[cat.glyph]}
      </g>
    </svg>
  );
}

export function DocGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="16 12 64 72" width={size} height={size * 1.12} aria-hidden="true" className="doc-glyph">
      <g fill="var(--bg)" stroke="var(--steel-ink)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">{GLYPHS.doc}</g>
    </svg>
  );
}

// ---------- шкалы: линейка, гребёнка ----------
/** Линейка: заливка от прозрачного до маркера, под ней риски. Цвет — по трети (T-543): «чем больше, тем лучше». */
export function Rule({ value, left, right, compact = false }: { value: number; left?: ReactNode; right?: ReactNode; compact?: boolean }) {
  const w = `${Math.max(0, Math.min(1, value)) * 100}%`;
  return (
    <div className={`rule lv-${level(value, 1)}${compact ? " compact" : ""}`}>
      {(left || right) && <div className="rule-top"><span>{left}</span><span className="num">{right}</span></div>}
      <div className="rule-bar" style={{ ["--w" as string]: w }} />
      <div className="rule-ticks" />
    </div>
  );
}

/** Балл — только цифра, полужирная, цветом трети (круг 3: плашка на голубом фоне наведения смотрелась плохо).
 *  Цвет — тот же --lv-c, что у шкалы полноты (круг 4): жёлтый как в шкале, ниже AA на светлом фоне — решение Павла. */
export function ScoreNum({ value, size }: { value: number; size?: "sm" }) {
  return <b className={`snum score num lv-${level(value)}${size ? ` ${size}` : ""}`} title={`Балл ${value} из 100`}>{value}</b>;
}

/** Полнота данных — тонкая шкала из дизайн-системы, как линейки в карточке поставщика: полупрозрачная заливка до черты,
 *  под ней засечка на каждое поле; цвет — по трети. «18/19» — в той же строке справа, подпись «данные» появляется
 *  при наведении поверх, ничего не сдвигая (Павел, круг 4). compact — в таблице, без подписи. */
export function FillBar({ found, total, compact = false }: { found: number; total: number; compact?: boolean }) {
  const t = `Найдено ${found} полей из ${total}`;
  const w = total ? Math.min(1, found / total) : 0;
  return (
    <span className={`fbar lv-${level(found, total)}${compact ? " compact" : ""}`} title={t} role="img" aria-label={t}>
      {!compact && <span className="fbar-k" aria-hidden="true">полнота данных</span>}
      <span className="fbar-rule" aria-hidden="true" style={{ ["--w" as string]: `${w * 100}%`, ["--n" as string]: String(Math.max(1, total)) }}>
        <i className="fbar-fill" />
        <i className="fbar-ticks" />
      </span>
      <span className="fbar-n num" aria-hidden="true"><b>{found}</b>/{total}</span>
    </span>
  );
}

// ---------- пояснения: спрятаны в «?», открываются нажатием ----------
/** Всплывающее пояснение. Закрывается кликом мимо и Esc; у края экрана разворачивается влево. */
export function Popover({ trigger, label, children, className = "", wide = false }: { trigger: ReactNode; label: string; children: ReactNode; className?: string; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  // окно подсказки — в корне страницы (портал) с fixed-позицией от кнопки: колонка с прокруткой, тёмная зона и карточки
  // с overflow его больше не обрезают (Павел, круг 4). При прокрутке любой области позиция пересчитывается.
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const id = useId();
  // позиция считается до отрисовки — окно не мигает в углу экрана в первый кадр
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const w = wide ? 360 : 300;
      // у правого края разворачивается влево
      setPos(r.left - 14 + w > window.innerWidth - 16 ? { top: r.bottom + 12, right: window.innerWidth - r.right - 14 } : { top: r.bottom + 12, left: r.left - 14 });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!ref.current?.contains(n) && !body.current?.contains(n)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, wide]);
  const style = pos ? ({ "--pt": `${pos.top}px`, "--pl": pos.left !== undefined ? `${pos.left}px` : "auto", "--pr": pos.right !== undefined ? `${pos.right}px` : "auto" } as CSSProperties) : { visibility: "hidden" as const };
  return (
    <span className={`pop ${className}`} ref={ref}>
      <button type="button" className="pop-btn" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}>
        {trigger}
      </button>
      {open && createPortal(
        <span id={id} ref={body} role="dialog" aria-label={label} style={style} className={`pop-body${pos?.right !== undefined ? " right" : ""}${wide ? " wide" : ""}`}>{children}</span>,
        document.body,
      )}
    </span>
  );
}

export function Hint({ children, label = "Пояснение" }: { children: ReactNode; label?: string }) {
  return <Popover trigger={<span className="q-mark" aria-hidden="true">?</span>} label={label} className="hint-q">{children}</Popover>;
}

/** Метка-подпись секции: мелко, капсом, с разрядкой — задаёт ритм, не спорит с данными. */
export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return <div className="label">{children}{hint && <Hint>{hint}</Hint>}</div>;
}

// ---------- мелочи ----------
export function Badge({ status, children, title }: { status: FieldStatus | null; children: ReactNode; title?: string }) {
  return (
    <span className={`bd${status === "not_found" ? " miss" : ""}`} title={title}>
      <StatusIcon status={status} size={11} />
      {children}
    </span>
  );
}

export function DemoPill({ title = "Поставщик придуман для прототипа — заменится настоящими данными сбора" }: { title?: string }) {
  return <span className="demo-pill" title={title}>демо</span>;
}

export function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`chk${disabled ? " off" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
      {children && <span>{children}</span>}
    </label>
  );
}

export function Seg<T extends string>({ options, value, onChange, label, size }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string; size?: "sm" }) {
  return (
    <div className={`seg${size ? ` ${size}` : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** quiet — тихая звёздочка в карточке списка: без рамки и тёмной заливки, чтобы не спорить с карточкой-ссылкой. */
export function StarButton({ on, onClick, label, quiet = false }: { on: boolean; onClick: () => void; label?: string; quiet?: boolean }) {
  const ink = quiet ? (on ? "var(--ink)" : "var(--muted)") : on ? "#fff" : "var(--ink)";
  return (
    <button type="button" className={`star${on ? " on" : ""}${quiet ? " quiet" : ""}`} onClick={onClick} aria-pressed={on}
      title={on ? "Убрать из шорт-листа" : "В шорт-лист"} aria-label={label ? undefined : on ? "Убрать из шорт-листа" : "В шорт-лист"}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill={on ? ink : "none"} stroke={ink} strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      {label && <span>{label}</span>}
    </button>
  );
}

export function Score({ value, unit = false, className = "" }: { value: number; unit?: boolean; className?: string }) {
  return (
    <span className={`score num ${className}`}>
      {value}
      {unit && <span className="unit">/100</span>}
    </span>
  );
}

/** Пять звёзд: закрашено по средней, округлённой до целой. */
export function Stars({ avg }: { avg: number }) {
  const n = Math.round(avg);
  return <span className="stars" aria-hidden="true"><b>{"★".repeat(n)}</b>{"★".repeat(5 - n)}</span>;
}

/** Оценка по отзывам: ★ 5,0 · 2 отзыва (T-543). onClick — в шапке страницы поставщика раскрывает отзывы;
 *  в карточке списка — просто подпись (вся карточка — ссылка). */
export function ReviewBadge({ stat, onClick, size }: { stat: ReviewStat; onClick?: (e: ReactMouseEvent) => void; size?: "sm" }) {
  const t = `Оценка по отзывам ${avgText(stat.avg)} из 5 · ${stat.count} ${plural(stat.count, "отзыв", "отзыва", "отзывов")}`;
  const body = (
    <>
      <span className="rb-star" aria-hidden="true">★</span>
      <b className="num">{avgText(stat.avg)}</b>
      <span className="rb-n">{stat.count} {plural(stat.count, "отзыв", "отзыва", "отзывов")}</span>
    </>
  );
  const cls = `rbadge${size ? ` ${size}` : ""}`;
  return onClick
    ? <button type="button" className={cls} onClick={onClick} aria-label={`${t} — показать отзывы`}>{body}</button>
    : <span className={cls} title={t} aria-label={t} role="img">{body}</span>;
}

export function Arrow() {
  return <span aria-hidden="true">→</span>;
}
