// Рекомендация «с кем связаться» — раздел 4 логики сервиса.
// Порядок считает формула, а не модель: одинаковые данные дают одинаковый порядок,
// и каждый балл раскладывается на строки. Неизвестное — треть балла критерия.
import type { Category, FieldStatus, Supplier } from "../types.ts";
import { ageYears, daysSince, isKnown, plural, rub, years } from "./format.ts";

export type Priority = "balanced" | "reliability" | "terms" | "fast";
export type CritId = "reliability" | "documents" | "min_order" | "delivery" | "prices" | "completeness";

export const PRIORITIES: { id: Priority; label: string; short: string }[] = [
  { id: "balanced", label: "Сбалансированно", short: "Баланс" },
  { id: "reliability", label: "Надёжность и документы", short: "Надёжность" },
  { id: "terms", label: "Условия и цена", short: "Условия" },
  { id: "fast", label: "Быстрая доставка", short: "Доставка" },
];

export const CRITS: { id: CritId; label: string; short: string }[] = [
  { id: "reliability", label: "Надёжность компании", short: "Надёжность" },
  { id: "documents", label: "Документы на продукцию", short: "Документы" },
  { id: "min_order", label: "Минимальный заказ к вашему объёму", short: "Мин. заказ" },
  { id: "delivery", label: "Доставка в ваш город", short: "Доставка" },
  { id: "prices", label: "Прозрачность цен", short: "Цены" },
  { id: "completeness", label: "Полнота и свежесть данных", short: "Полнота" },
];

const BASE: Record<Priority, Record<CritId, number>> = {
  balanced: { reliability: 25, documents: 20, min_order: 20, delivery: 15, prices: 10, completeness: 10 },
  reliability: { reliability: 30, documents: 35, min_order: 10, delivery: 10, prices: 5, completeness: 10 },
  terms: { reliability: 15, documents: 10, min_order: 30, delivery: 15, prices: 25, completeness: 5 },
  fast: { reliability: 15, documents: 15, min_order: 15, delivery: 40, prices: 5, completeness: 10 },
};

/** Для рыбы, морепродуктов и молочного вес документов +10 за счёт полноты и цен. */
export function weightsFor(prio: Priority, cat: Category): Record<CritId, number> {
  const w = { ...BASE[prio] };
  if (cat.docs_critical) {
    w.documents += 10;
    w.completeness -= 5;
    w.prices -= 5;
  }
  return w;
}

export const UNKNOWN = 1 / 3;

/** 19 полей, по которым считается полнота карточки. */
export const TRACKED: { key: string; label: string; get: (s: Supplier) => { status: FieldStatus; value: unknown } }[] = [
  { key: "legal_name", label: "Юрлицо", get: (s) => s.legal_name },
  { key: "inn", label: "ИНН", get: (s) => s.inn },
  { key: "products", label: "Товары", get: (s) => s.products },
  { key: "address", label: "Адрес или склад", get: (s) => s.address },
  { key: "presence", label: "Склад в городе", get: (s) => s.presence },
  { key: "regions_served", label: "Регион работы", get: (s) => s.regions_served },
  { key: "phones", label: "Телефон", get: (s) => s.phones },
  { key: "emails", label: "Email", get: (s) => s.emails },
  { key: "messengers", label: "Мессенджер", get: (s) => s.messengers },
  { key: "website", label: "Сайт", get: (s) => s.website },
  { key: "works_with_horeca", label: "Работа с ресторанами", get: (s) => s.works_with_horeca },
  { key: "min_order", label: "Минимальный заказ", get: (s) => s.min_order },
  { key: "prices", label: "Цены", get: (s) => s.prices },
  { key: "delivery", label: "Доставка", get: (s) => s.delivery },
  { key: "payment_terms", label: "Оплата и отсрочка", get: (s) => s.payment_terms },
  { key: "declarations", label: "Декларации", get: (s) => s.documents.declarations },
  { key: "site_mentions", label: "Документы на сайте", get: (s) => s.documents.site_mentions },
  { key: "company", label: "Компания в ФНС", get: (s) => s.company },
  { key: "tax_regime", label: "Налоговый режим", get: (s) => s.tax_regime },
];

export function completeness(s: Supplier) {
  const found = TRACKED.filter((t) => isKnown(t.get(s) as never)).length;
  return { found, total: TRACKED.length };
}

export interface Ctx {
  volume: number | null;
  category: Category;
  /** все поставщики категории — для места по минимальному заказу, когда объём не задан */
  peers: Supplier[];
  now?: Date;
}

export interface CritResult {
  id: CritId;
  score: number;
  known: boolean;
  mark: FieldStatus | null;
  text: string;
}

export function activeDeclarations(s: Supplier, now = new Date()) {
  const f = s.documents.declarations;
  if (!isKnown(f)) return [];
  return f.value!.filter((d) => d.status === "действует" && new Date(d.valid_to) > now);
}

export function markingOk(s: Supplier, cat: Category) {
  const m = s.documents.marking;
  return !!(cat.marking_group && m && isKnown(m) && m.value!.includes(cat.marking_group));
}

function reliability(s: Supplier, now: Date): CritResult {
  const f = s.company;
  if (!isKnown(f)) {
    return { id: "reliability", score: UNKNOWN, known: false, mark: "not_found",
      text: isKnown(s.inn) ? "компания не найдена в ФНС" : "ИНН на сайте не найден — компанию не проверить" };
  }
  const c = f.value!;
  const age = ageYears(c.registered_at, now);
  const score = Math.min(age / 5, 1) * 0.5 + (c.okved_match ? 0.2 : 0) + (c.flags.length === 0 ? 0.3 : 0);
  const parts = [
    age < 1 ? "действует меньше года" : `действует ${years(age)}`,
    c.okved_match ? "ОКВЭД совпадает" : "ОКВЭД не по профилю",
    c.flags.length ? `флаги ФНС: ${c.flags.join(", ")}` : "красных флагов нет",
  ];
  return { id: "reliability", score, known: true, mark: "found", text: parts.join(", ") };
}

function documents(s: Supplier, cat: Category, now: Date): CritResult {
  const active = activeDeclarations(s, now);
  const mk = markingOk(s, cat);
  if (active.length || mk) {
    const parts: string[] = [];
    if (active.length) parts.push(`${active.length} ${plural(active.length, "действующая декларация", "действующие декларации", "действующих деклараций")} в реестре`);
    if (mk) parts.push(`в «Честном знаке» — «${cat.marking_group}»`);
    return { id: "documents", score: 1, known: true, mark: "found", text: parts.join(", ") };
  }
  if (isKnown(s.documents.site_mentions)) {
    return { id: "documents", score: 0.5, known: true, mark: "claimed", text: `только упоминание на сайте: ${s.documents.site_mentions.value}` };
  }
  return { id: "documents", score: UNKNOWN, known: false, mark: "not_found",
    text: isKnown(s.inn) ? "в реестре по ИНН деклараций нет, на сайте не упоминаются" : "без ИНН реестры не проверить, на сайте не упоминаются" };
}

function minOrder(s: Supplier, ctx: Ctx): CritResult {
  const f = s.min_order;
  if (!isKnown(f)) {
    return { id: "min_order", score: UNKNOWN, known: false, mark: f.status,
      text: f.status === "estimated" ? `не указан; ◇ по рынку ${f.value!.text}` : "не указан на сайте" };
  }
  const m = f.value!;
  if (m.unit !== "RUB") return { id: "min_order", score: 0.5, known: true, mark: f.status, text: `${m.text} — с бюджетом в рублях не сравнить` };
  const amt = m.amount ?? 0;
  if (amt === 0) return { id: "min_order", score: 1, known: true, mark: f.status, text: "минимума нет" };
  if (ctx.volume) {
    if (amt <= ctx.volume) return { id: "min_order", score: 1, known: true, mark: f.status, text: `${rub(amt)} — не больше вашей закупки` };
    if (amt <= ctx.volume * 2) return { id: "min_order", score: 0.5, known: true, mark: f.status, text: `${rub(amt)} — больше вашей закупки, но меньше двух` };
    return { id: "min_order", score: 0.1, known: true, mark: f.status, text: `${rub(amt)} — больше вашей закупки в ${(amt / ctx.volume).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} раза` };
  }
  const known = ctx.peers
    .filter((p) => isKnown(p.min_order) && p.min_order.value!.unit === "RUB")
    .map((p) => p.min_order.value!.amount ?? 0)
    .sort((a, b) => a - b);
  const i = known.indexOf(amt);
  const n = known.length;
  const score = n <= 1 ? 1 : 1 - (0.9 * i) / (n - 1);
  return { id: "min_order", score, known: true, mark: f.status, text: `${rub(amt)} — ${i + 1}-й по размеру из ${n} в категории` };
}

function delivery(s: Supplier, ctx: Ctx): CritResult {
  const f = s.delivery;
  if (!isKnown(f)) return { id: "delivery", score: UNKNOWN, known: false, mark: "not_found", text: "условия доставки не нашли" };
  const d = f.value!;
  const lead = d.lead_time ? `, ${d.lead_time}` : "";
  const conflict = f.alternatives?.length ? " · страницы сайта расходятся" : "";
  if (d.transport_company) return { id: "delivery", score: 0.2, known: true, mark: f.status, text: `склад в другом городе, транспортной компанией${lead}` };
  if (d.to_door) {
    if (d.free_from === 0) return { id: "delivery", score: 1, known: true, mark: f.status, text: `до точки бесплатно${lead}${conflict}` };
    if (d.free_from != null && (ctx.volume == null || d.free_from <= ctx.volume)) {
      return { id: "delivery", score: 1, known: true, mark: f.status, text: `до точки бесплатно от ${rub(d.free_from)}${lead}${conflict}` };
    }
    const paid = d.free_from != null ? `платно, бесплатно только от ${rub(d.free_from)}` : d.cost ? `до точки за ${rub(d.cost)}` : "до точки, платно";
    return { id: "delivery", score: 0.7, known: true, mark: f.status, text: `${paid}${lead}${conflict}` };
  }
  if (d.pickup) return { id: "delivery", score: 0.5, known: true, mark: f.status, text: `только самовывоз${lead}` };
  return { id: "delivery", score: UNKNOWN, known: false, mark: "not_found", text: "условия доставки не нашли" };
}

const PRICE_TEXT = { pricelist: "прайс на сайте", partial: "цены на часть позиций", on_request: "цены по запросу", after_login: "цены после регистрации" } as const;
const PRICE_SCORE = { pricelist: 1, partial: 0.6, on_request: 0.2, after_login: 0.2 } as const;

function prices(s: Supplier): CritResult {
  const f = s.prices;
  if (!isKnown(f)) return { id: "prices", score: UNKNOWN, known: false, mark: "not_found", text: "о ценах на сайте ничего нет" };
  const mode = f.value!.mode;
  return { id: "prices", score: PRICE_SCORE[mode], known: true, mark: f.status, text: PRICE_TEXT[mode] };
}

function completenessCrit(s: Supplier, now: Date): CritResult {
  const { found, total } = completeness(s);
  const days = daysSince(s.meta.collected_at, now);
  const stale = days > 30;
  const when = days <= 0 ? "сегодня" : `${days} ${plural(days, "день", "дня", "дней")} назад`;
  return { id: "completeness", score: (found / total) * (stale ? 0.8 : 1), known: true, mark: null,
    text: `${found} из ${total} полей, собрано ${when}${stale ? " — старше 30 дней, минус 20 %" : ""}` };
}

export function evaluate(s: Supplier, ctx: Ctx): Record<CritId, CritResult> {
  const now = ctx.now ?? new Date();
  return {
    reliability: reliability(s, now),
    documents: documents(s, ctx.category, now),
    min_order: minOrder(s, ctx),
    delivery: delivery(s, ctx),
    prices: prices(s),
    completeness: completenessCrit(s, now),
  };
}

export interface Scored {
  supplier: Supplier;
  total: number;
  crits: Record<CritId, CritResult>;
  weights: Record<CritId, number>;
  /** вклад критерия в балл: вес × оценка */
  contrib: Record<CritId, number>;
}

export function score(s: Supplier, ctx: Ctx, prio: Priority): Scored {
  const crits = evaluate(s, ctx);
  const weights = weightsFor(prio, ctx.category);
  const contrib = {} as Record<CritId, number>;
  let total = 0;
  for (const c of CRITS) {
    contrib[c.id] = weights[c.id] * crits[c.id].score;
    total += contrib[c.id];
  }
  return { supplier: s, total: Math.round(total), crits, weights, contrib };
}

export interface Excluded {
  supplier: Supplier;
  reason: string;
  mark: FieldStatus | null;
  /** решение конвейера «это не поставщик» можно отменить руками */
  canReturn: boolean;
}

const STATUS_STOP = { liquidating: "компания ликвидируется", liquidated: "компания ликвидирована", bankrupt: "компания в банкротстве" } as const;
const SERVES = ["Екатеринбург", "Свердловская область", "Урал", "вся Россия"];

export function stopReason(s: Supplier, returned: ReadonlySet<string>): Omit<Excluded, "supplier"> | null {
  if (isKnown(s.company) && s.company.value!.status !== "active") {
    const st = s.company.value!.status as keyof typeof STATUS_STOP;
    return { reason: `${STATUS_STOP[st]} (ФНС${st === "bankrupt" ? ", Федресурс" : ""})`, mark: "found", canReturn: false };
  }
  const regions = isKnown(s.regions_served) ? s.regions_served.value! : [];
  const localWarehouse = s.city === "Екатеринбург" && isKnown(s.presence) && s.presence.value === "warehouse";
  if (regions.length && !regions.some((r) => SERVES.includes(r)) && !localWarehouse) {
    return { reason: `не возит в Екатеринбург: только ${regions.join(", ")}`, mark: "claimed", canReturn: false };
  }
  if (s.not_supplier && !returned.has(s.id)) {
    return { reason: `похоже, не поставщик — ${s.not_supplier}`, mark: null, canReturn: true };
  }
  return null;
}

export function rank(suppliers: Supplier[], ctx: Ctx, prio: Priority, returned: ReadonlySet<string> = new Set()) {
  const ranked: Scored[] = [];
  const excluded: Excluded[] = [];
  for (const s of suppliers) {
    const stop = stopReason(s, returned);
    if (stop) excluded.push({ supplier: s, ...stop });
    else ranked.push(score(s, ctx, prio));
  }
  ranked.sort((a, b) => b.total - a.total || b.crits.completeness.score - a.crits.completeness.score || a.supplier.name.localeCompare(b.supplier.name, "ru"));
  return { ranked, excluded };
}
