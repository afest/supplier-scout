// Текст объяснения собирается шаблоном из полей (раздел 4, шаг 4 логики сервиса).
// Модель текст не пишет, поэтому не может приписать поставщику то, чего нет в полях.
import type { Category, FieldStatus } from "../types.ts";
import { ageYears, isKnown, plural, rub, years } from "./format.ts";
import { CRITS, fnsFlags, markingOk, profileDeclarations, type CritId, type Scored } from "./score.ts";

const EXPLAINED: CritId[] = CRITS.map((c) => c.id).filter((id) => id !== "completeness");

/** Сильная сторона поставщика по критерию — фраза для «почему». */
export function strength(id: CritId, sc: Scored, cat: Category, volume: number | null): string {
  const s = sc.supplier;
  switch (id) {
    case "reliability": {
      const c = s.company.value!;
      const f = fnsFlags(c.flags);
      return `работает ${years(ageYears(c.registered_at))}${f.real.length || f.unchecked ? "" : " без красных флагов ФНС"}`;
    }
    case "documents": {
      const n = profileDeclarations(s, cat).length;
      if (n) return `${n} ${plural(n, "декларация подтверждена", "декларации подтверждены", "деклараций подтверждены")} реестром`;
      if (markingOk(s, cat)) return `в «Честном знаке» по группе «${cat.marking_group}»`;
      return "документы упомянуты на сайте";
    }
    case "min_order": {
      const m = s.min_order.value!;
      if (m.unit === "RUB" && !m.amount) return "без минимального заказа";
      if (m.unit !== "RUB") return `минимальный заказ ${sc.crits.min_order.text}`;
      return volume && m.amount! <= volume ? `минимальный заказ ${rub(m.amount!)} не больше вашей закупки` : `минимальный заказ ${rub(m.amount!)}`;
    }
    case "delivery": {
      const d = s.delivery.value!;
      if (d.to_door && d.free_from != null && (volume == null || d.free_from <= volume)) return `доставка бесплатно от ${rub(d.free_from)}${d.lead_time ? `, ${d.lead_time}` : ""}`;
      if (d.to_door) return `доставка до точки${d.lead_time ? ` ${d.lead_time}` : ""}`;
      if (d.transport_company) return "доставка транспортной компанией";
      if (d.pickup) return `самовывоз со склада в городе${d.lead_time ? `, ${d.lead_time}` : ""}`;
      return "доставка транспортной компанией";
    }
    case "prices":
      return s.prices.value!.mode === "pricelist" ? "прайс открыт на сайте" : "цены на часть позиций на сайте";
    default:
      return "данные почти полные";
  }
}

/** Слабая сторона — фраза для «но …». */
export function weakness(id: CritId, sc: Scored, volume: number | null): string {
  const s = sc.supplier;
  const r = sc.crits[id];
  switch (id) {
    case "reliability": {
      if (!r.known) return "компанию не проверить — ИНН не найден";
      const c = s.company.value!;
      const f = fnsFlags(c.flags);
      if (f.real.length) return `у ФНС флаг «${f.real[0]}»`;
      if (f.unchecked) return "флаги ФНС не проверены";
      const age = ageYears(c.registered_at);
      return age < 5 ? `компания моложе — ${age < 1 ? "меньше года" : years(age)}` : "ОКВЭД не по профилю";
    }
    case "documents":
      return r.known ? "документы — только упоминание на сайте" : "документы на продукцию не нашли";
    case "min_order": {
      if (!r.known) return "минимальный заказ не указан";
      const m = s.min_order.value!;
      if (m.unit !== "RUB") return `минимальный заказ ${r.text}`;
      return volume && (m.amount ?? 0) > volume ? `минимальный заказ ${rub(m.amount ?? 0)} больше вашей закупки` : `минимальный заказ выше — ${rub(m.amount ?? 0)}`;
    }
    case "delivery": {
      if (!r.known) return "условия доставки не нашли";
      const d = s.delivery.value!;
      if (!d.to_door && d.transport_company) return "везут транспортной компанией из другого города";
      if (!d.to_door) return "только самовывоз";
      return d.free_from != null ? `доставка бесплатна только от ${rub(d.free_from)}` : "доставка платная";
    }
    case "prices": {
      if (!r.known) return "цен на сайте нет";
      return { pricelist: "", partial: "цены — только на часть позиций", on_request: "цены только по запросу", after_login: "цены только после регистрации" }[s.prices.value!.mode];
    }
    default:
      return "данных о нём меньше";
  }
}

export interface Ask {
  key: string;
  label: string;
  mark: FieldStatus | null;
  weight: number;
  /** вопрос для черновика письма */
  question: string;
}

/** Что уточнить при первом контакте: пробелы карточки, отсортированные по весу. */
export function asks(sc: Scored, cat: Category): Ask[] {
  const s = sc.supplier;
  const w = sc.weights;
  const out: Ask[] = [];
  const mo = s.min_order;
  if (!isKnown(mo)) out.push({ key: "min_order", label: "минимальный заказ", mark: mo.status, weight: w.min_order, question: "минимальный заказ для юрлиц" });
  else if (mo.value!.unit === "RUB" && mo.value!.amount) out.push({ key: "min_order_confirm", label: `минимальный заказ для сетей — на сайте ${mo.value!.text}`, mark: "claimed", weight: 2, question: `минимальный заказ для юрлиц (на сайте указано ${mo.value!.text})` });
  if (!isKnown(s.prices) || s.prices.value!.mode !== "pricelist") {
    out.push({ key: "prices", label: s.prices.value?.mode === "partial" ? "полный прайс" : "цены", mark: isKnown(s.prices) ? "claimed" : "not_found", weight: w.prices, question: "можно ли получить прайс для сетей" });
  } else {
    out.push({ key: "prices_chain", label: "прайс для сетей", mark: "claimed", weight: 1, question: "есть ли отдельный прайс для сетей" });
  }
  if (!isKnown(s.payment_terms)) out.push({ key: "payment", label: "условия оплаты и отсрочку", mark: "not_found", weight: 12, question: "условия оплаты и возможна ли отсрочка" });
  if (!sc.crits.documents.known || sc.crits.documents.score < 1) out.push({ key: "documents", label: "документы на продукцию", mark: sc.crits.documents.mark, weight: w.documents, question: "декларации соответствия на продукцию" });
  if (cat.docs_critical) out.push({ key: "vet", label: "ветеринарные документы (Меркурий)", mark: "not_found", weight: 11, question: "оформляете ли ветеринарные сопроводительные документы в «Меркурии»" });
  if (!isKnown(s.delivery)) out.push({ key: "delivery", label: "условия доставки", mark: "not_found", weight: w.delivery, question: "условия и сроки доставки до точки" });
  if (!isKnown(s.company)) out.push({ key: "inn", label: "ИНН и реквизиты", mark: "not_found", weight: w.reliability, question: "реквизиты компании (ИНН)" });
  if (!isKnown(s.messengers)) out.push({ key: "messengers", label: "мессенджер для заказов", mark: "not_found", weight: 0.5, question: "можно ли присылать заказы в мессенджер" });
  return out.sort((a, b) => b.weight - a.weight);
}

function strengths(sc: Scored) {
  // при равном вкладе первой идёт сторона с полной оценкой: «5 000 ₽ ниже закупки» сильнее «12 лет, но ОКВЭД не тот»
  return EXPLAINED.filter((id) => sc.crits[id].known && sc.crits[id].score >= 0.5)
    .sort((a, b) => sc.contrib[b] - sc.contrib[a] || sc.crits[b].score - sc.crits[a].score)
    .slice(0, 2);
}

/** Чем надёжность поставщика лучше лидерской — называем именно эту составляющую. */
function reliabilityEdge(sc: Scored, leader: Scored) {
  const a = sc.supplier.company.value!;
  const b = leader.supplier.company.value;
  if (b && a.okved_match && !b.okved_match) return "основной ОКВЭД — по профилю категории";
  if (b && !fnsFlags(a.flags).real.length && !fnsFlags(a.flags).unchecked && fnsFlags(b.flags).real.length) return "без красных флагов ФНС";
  if (!b) return `компания проверена в ФНС: ${years(ageYears(a.registered_at))}`;
  return `работает дольше — ${years(ageYears(a.registered_at))}`;
}

export function leaderText(sc: Scored, cat: Category, volume: number | null) {
  const st = strengths(sc).map((id) => strength(id, sc, cat, volume));
  const gap = asks(sc, cat)[0];
  return {
    why: st.length ? capitalize(st.join(", ")) + "." : "Сильных сторон по известным полям нет — выше остальных за счёт полноты данных.",
    ask: gap ? `Уточните в первом письме: ${gap.label}.` : "",
  };
}

export function followerText(sc: Scored, leader: Scored, cat: Category, volume: number | null) {
  const diff = EXPLAINED.map((id) => ({ id, d: sc.contrib[id] - leader.contrib[id] }));
  const better = diff.filter((x) => x.d > 0.01 && sc.crits[x.id].known).sort((a, b) => b.d - a.d)[0];
  const worse = diff.filter((x) => x.d < -0.01).sort((a, b) => a.d - b.d)[0];
  const gap = asks(sc, cat)[0];
  const edge = (id: CritId) => (id === "reliability" ? reliabilityEdge(sc, leader) : strength(id, sc, cat, volume));
  let why: string;
  if (better && worse) why = `${capitalize(edge(better.id))}, но ${weakness(worse.id, sc, volume)}.`;
  else if (worse) why = `Уступает лидеру: ${weakness(worse.id, sc, volume)}.`;
  else if (better) why = `${capitalize(edge(better.id))}, но данных о нём меньше.`;
  else why = "По известным полям почти равен лидеру, данных меньше.";
  return { why, ask: gap ? `Уточнить: ${gap.label}.` : "" };
}

/** Вывод под сравнением: лидер и чем проигрывают остальные. */
export function compareConclusion(list: Scored[], cat: Category, volume: number | null) {
  if (list.length < 2) return "";
  const [lead, ...rest] = list;
  const l = leaderText(lead, cat, volume);
  const others = rest.map((sc) => `${sc.supplier.name}: ${lowerFirst(followerText(sc, lead, cat, volume).why)}`);
  return { lead: `Первым — ${lead.supplier.name}`, why: l.why, others };
}

export function draftRequest(sc: Scored, cat: Category, subName: string, volume: number | null) {
  const qs = asks(sc, cat).filter((a) => a.key !== "messengers").slice(0, 4);
  const lines = [
    "Здравствуйте!",
    "",
    `Мы — сеть ресторанов в Екатеринбурге, ищем поставщика: ${subName.toLowerCase()}.${volume ? ` Закупка — около ${rub(volume)} в неделю.` : ""}`,
    "",
    "Подскажите, пожалуйста:",
    ...qs.map((q, i) => `— ${q.question}${i === qs.length - 1 ? "." : ";"}`),
    "",
    "[подпись]",
  ];
  return { text: lines.join("\n"), from: qs };
}

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
