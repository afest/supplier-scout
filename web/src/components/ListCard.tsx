// Карточка поставщика в списках (T-541): поиск по товару, категория, «Все поставщики».
// Ссылка — вся карточка: псевдоэлемент названия растянут на неё целиком. Поверх него — только звёздочка шорт-листа
// и «?»-пояснения, клик по ним карточку не открывает. Справа (в плитке — снизу) за разделителем балл и полнота данных.
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { Category, FieldStatus, Supplier } from "../types.ts";
import { completeness } from "../lib/score.ts";
import { isKnown } from "../lib/format.ts";
import { logoOf, type Logo } from "../lib/logos.ts";
import { useReviewStat } from "../lib/reviewStats.ts";
import { Avatar, CatGlyph, FillBar, ReviewBadge, ScoreNum, StarButton, StatusIcon } from "./ui.tsx";
import { RowBadges, supplierMeta } from "./supplier.tsx";

export function ListCard({ s, cat, href, variant = "row", score, rank, stop, starred, onStar, tags, extra, showCat = false, logo }: {
  s: Supplier;
  cat: Category;
  href: string;
  variant?: "row" | "tile";
  /** балл в категории; null — поставщик исключён из рекомендации */
  score: number | null;
  rank?: number;
  stop?: { reason: string; mark: FieldStatus | null } | null;
  starred: boolean;
  onStar: () => void;
  /** пилюли рядом с названием: «собрано сейчас», «крупный опт», чужая категория */
  tags?: ReactNode;
  /** строка под названием: где нашлось слово, позиции-основания подкатегории */
  extra?: ReactNode;
  showCat?: boolean;
  /** подмена логотипа — для проверки аватара; по умолчанию из logoOf */
  logo?: Logo;
}) {
  const c = completeness(s);
  // оценка по отзывам, если они есть (правка Павла 15.10, T-543): в поиске она не менее важна, чем балл
  const rs = useReviewStat(s.id);
  // подпись «что это» — только когда курсор над цифрой рейтинга или над шкалой, а не над всей карточкой (Павел, круг 5).
  // Поверх карточки лежит общая ссылка, поэтому часть под курсором определяется по координатам, клик по-прежнему открывает поставщика
  const scoreRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [part, setPart] = useState<"" | "score" | "bar">("");
  const onMove = (e: MouseEvent) => {
    const over = (el: HTMLElement | null) => {
      const r = el?.getBoundingClientRect();
      return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    const next = over(scoreRef.current) ? "score" : over(barRef.current) ? "bar" : "";
    if (next !== part) setPart(next);
  };
  return (
    <article className={`lcard ${variant}${stop ? " is-stopped" : ""}${part ? ` hov-${part}` : ""}`} onMouseMove={onMove} onMouseLeave={() => part && setPart("")}>
      <div className="lc-ava">
        <Avatar s={s} size={variant === "tile" ? 48 : 52} logo={logo ?? logoOf(s.id)} />
        {rank !== undefined && score !== null && <span className="lc-rank num" title={`${rank}-й по рекомендации в категории`}>{rank}</span>}
      </div>
      <div className="lc-main">
        <div className="lc-title">
          <a className="nm" href={href}>{s.name}</a>
          {rs && <ReviewBadge stat={rs} size="sm" />}
          {tags}
        </div>
        {showCat && <div className="sc-cat"><CatGlyph cat={cat} size={20} /> {cat.short}</div>}
        <div className="row-meta">{!isKnown(s.company) && <StatusIcon status="not_found" size={10} />} {supplierMeta(s)}</div>
        {extra}
        {stop ? <div className="sc-stop"><StatusIcon status={stop.mark} size={10} /> {stop.reason}</div> : variant === "row" && <RowBadges s={s} cat={cat} />}
      </div>
      <div className="lc-metrics">
        <div className="lc-score" ref={scoreRef}>
          {score === null ? <span className="ex-tag">исключён</span> : <ScoreNum value={score} />}
          {score !== null && <span className="lc-k" aria-hidden="true">рейтинг в категории</span>}
        </div>
        <i className="lc-div" aria-hidden="true" />
        <div className="lc-bar" ref={barRef}><FillBar found={c.found} total={c.total} /></div>
      </div>
      <StarButton on={starred} onClick={onStar} quiet />
    </article>
  );
}
