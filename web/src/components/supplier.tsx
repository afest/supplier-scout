import type { ReactNode } from "react";
import type { Category, Delivery, Field, FieldStatus, Prices, Source, Supplier } from "../types.ts";
import { ageYears, isKnown, plural, rub, years } from "../lib/format.ts";
import { activeDeclarations, markingOk, profileDeclarations } from "../lib/score.ts";
import { Badge, Hint, StatusIcon } from "./ui.tsx";

// ---------- источники ----------
const REG_LABEL: Record<string, string> = {
  egrul: "ЕГРЮЛ", pb: "ФНС", "fns-open": "ФНС", fsa: "ФСА", cz: "Честный знак", fedresurs: "Федресурс", market: "рынок", search: "поиск",
};

export function sourceLabel(src: Source) {
  if (src.kind === "site") return src.url.endsWith(".pdf") ? "прайс" : "сайт";
  return REG_LABEL[src.id] ?? src.title;
}

export function SourceLinks({ s, ids }: { s: Supplier; ids: string[] }) {
  const list = ids.map((id) => s.meta.sources.find((x) => x.id === id)).filter(Boolean) as Source[];
  if (!list.length) return null;
  return (
    <span className="srcs">
      {list.map((src) =>
        s.demo || !src.url ? (
          <span key={src.id} className="src demo-link" title={`${src.title}${s.demo ? " · в демо-данных ссылка-заглушка" : ""}`}>
            {sourceLabel(src)} ↗
          </span>
        ) : (
          <a key={src.id} className="src" href={src.url} target="_blank" rel="noreferrer" title={src.title}>
            {sourceLabel(src)} ↗
          </a>
        ),
      )}
    </span>
  );
}

/** Найденное число в цитате подсвечено тоном (серый текст, ключевое — тёмным). */
export function Quote({ text, where }: { text: string; where?: string }) {
  const parts = text.split(/(\d[\d\s .,:–-]*\d|\d)/g);
  return (
    <div className="q">
      «{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}»{where ? ` — ${where}` : ""}
    </div>
  );
}

function pageTitle(s: Supplier, f: Field<unknown>) {
  const src = s.meta.sources.find((x) => x.id === f.sources[0]);
  return src?.kind === "site" ? `страница «${src.title.replace("Сайт: ", "")}»` : undefined;
}

// ---------- строка поля карточки ----------
export function FieldRow({ s, label, f, value, extra }: { s: Supplier; label: string; f: Field<unknown> | null; value?: ReactNode; extra?: ReactNode }) {
  if (!f) return null;
  let body: ReactNode;
  if (f.status === "not_found") {
    body = (
      <div className="v miss">
        не найдено
        {f.searched_in && <Hint label="Где искали">Искали: {f.searched_in.join("; ")}. Пустое поле уходит в вопросы черновика письма поставщику.</Hint>}
      </div>
    );
  } else if (f.status === "estimated") {
    body = (
      <div className="v est">
        <span className="est-tag">оценка</span> {value}
        {f.basis && <Hint label="На чём основана оценка">Открытых данных нет. Ориентир: {f.basis}. В балл идёт как неизвестное — додуманное не двигает выбор.</Hint>}
      </div>
    );
  } else {
    body = (
      <>
        <div className="v">{value}</div>
        {f.quote && <Quote text={f.quote} where={undefined} />}
      </>
    );
  }
  const alts = f.alternatives ?? [];
  return (
    <div className={`field${alts.length ? " conflict" : ""}`}>
      <span className="k">{label}</span>
      <div>
        {body}
        {alts.map((a, i) => (
          <div key={i} className="alt">
            <span className="alt-tag">расходится <Hint label="Страницы расходятся">Страницы одного сайта говорят разное. Оставляем оба значения со ссылками, выберет закупщик при звонке.</Hint></span>
            {a.quote && <Quote text={a.quote} where={pageTitle(s, a)} />}
            <SourceLinks s={s} ids={a.sources} />
          </div>
        ))}
        {extra}
      </div>
      <span className="field-src">
        <StatusIcon status={f.status} />
        <SourceLinks s={s} ids={f.sources} />
      </span>
    </div>
  );
}

// ---------- значения полей текстом ----------
export function deliveryText(d: Delivery) {
  const parts: string[] = [];
  if (d.to_door) {
    if (d.free_from === 0) parts.push("до точки бесплатно");
    else if (d.free_from != null) parts.push(`до точки бесплатно от ${rub(d.free_from)}${d.cost ? `, иначе ${rub(d.cost)}` : ""}`);
    else parts.push(d.cost ? `до точки — ${rub(d.cost)}` : "до точки, платно");
    if (d.transport_company) parts.push("в другие города — транспортной компанией");
  } else if (d.transport_company) parts.push("транспортной компанией со склада в другом городе");
  if (d.lead_time) parts.push(d.lead_time);
  if (d.pickup) parts.push(d.to_door ? "есть самовывоз" : "только самовывоз");
  return parts.join(", ");
}

export function deliveryShort(d: Delivery) {
  if (d.to_door && d.free_from != null) return `бесплатно от ${rub(d.free_from)}`;
  if (d.to_door) return `до точки${d.cost ? ` ${rub(d.cost)}` : ", платно"}`;
  if (d.transport_company) return `ТК, ${d.lead_time ?? "срок не указан"}`;
  if (d.pickup) return `самовывоз${d.lead_time ? ` ${d.lead_time}` : ""}`;
  return "—";
}

export const PRICE_MODE: Record<Prices["mode"], string> = {
  pricelist: "прайс-лист на сайте", partial: "цены на часть позиций", on_request: "по запросу", after_login: "после регистрации",
};
export const PRICE_SHORT: Record<Prices["mode"], string> = {
  pricelist: "прайс", partial: "цены частично", on_request: "цены по запросу", after_login: "цены после входа",
};

/** Где поставщик относительно города закупщика — так в списке виден регион, а не только название города. */
export function presenceText(s: Supplier) {
  if (!isKnown(s.presence) || s.presence.value === "unknown") return "где склад — не указано";
  if (s.presence.value === "warehouse") return "склад в Екатеринбурге";
  const tc = isKnown(s.delivery) && s.delivery.value!.transport_company && !s.delivery.value!.to_door;
  return tc ? "склад в другом городе, везут ТК" : "без склада в городе, привозят";
}

export function companyShort(s: Supplier): { status: FieldStatus; text: string } {
  if (!isKnown(s.company)) return { status: "not_found", text: "компания не проверена" };
  const c = s.company.value!;
  const st = { active: "действует", liquidating: "ликвидируется", liquidated: "ликвидирована", bankrupt: "банкротство" }[c.status];
  return { status: "found", text: `${st} ${years(ageYears(c.registered_at))}`.replace("действует 0 лет", "действует меньше года") };
}

export function documentsShort(s: Supplier, cat: Category): { status: FieldStatus; text: string } {
  const n = profileDeclarations(s, cat).length;
  const mk = markingOk(s, cat);
  if (n || mk) {
    const parts = [];
    if (n) parts.push(`${n} ${plural(n, "декларация", "декларации", "деклараций")}`);
    if (mk) parts.push("Честный знак");
    return { status: "found", text: parts.join(" · ") };
  }
  if (activeDeclarations(s).length) return { status: "found", text: "декларации не по категории" };
  if (isKnown(s.documents.site_mentions)) return { status: "claimed", text: "документы — упоминание" };
  return { status: "not_found", text: "документы" };
}

export function minOrderShort(s: Supplier): { status: FieldStatus; text: string } {
  const f = s.min_order;
  if (f.status === "not_found") return { status: "not_found", text: "мин. заказ" };
  const m = f.value!;
  if (f.status !== "estimated" && m.unit === "RUB" && !m.amount) return { status: f.status, text: "без минимального заказа" };
  return { status: f.status, text: `мин. заказ ${m.text}` };
}

export function pricesShort(s: Supplier): { status: FieldStatus; text: string } {
  const f = s.prices;
  if (!isKnown(f)) return { status: "not_found", text: "цены" };
  return { status: f.status, text: PRICE_SHORT[f.value!.mode] };
}

/** Подпись под названием: форма и возраст компании, где склад. */
export function supplierMeta(s: Supplier) {
  const parts: string[] = [];
  if (isKnown(s.company)) parts.push(`${s.company.value!.form} · ${years(ageYears(s.company.value!.registered_at))}`);
  else parts.push("компания не проверена");
  parts.push(presenceText(s));
  return parts.join(" · ");
}

export function RowBadges({ s, cat }: { s: Supplier; cat: Category }) {
  const items = [minOrderShort(s)];
  const d = isKnown(s.delivery) ? { status: s.delivery.status, text: deliveryShort(s.delivery.value!) } : { status: "not_found" as FieldStatus, text: "доставка" };
  items.push(d, documentsShort(s, cat), pricesShort(s));
  return (
    <div className="badges">
      {items.map((b, i) => <Badge key={i} status={b.status}>{b.text}</Badge>)}
    </div>
  );
}
