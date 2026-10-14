// Фильтры по дополнительным полям — общие для результатов поиска и каталога «Все поставщики».
import type { Category, Supplier } from "../types.ts";
import { ageYears, isKnown } from "./format.ts";
import { fnsFlags, markingOk, profileDeclarations } from "./score.ts";

export type FilterId = "door" | "pickup" | "warehouse" | "evening" | "pricelist" | "horeca" | "active" | "age3" | "decl" | "marking" | "noflags";

export const FILTER_GROUPS: { title: string; items: { id: FilterId; label: string; markingOnly?: boolean; hoursOnly?: boolean }[] }[] = [
  {
    title: "Условия",
    items: [
      { id: "door", label: "Доставка до точки" },
      { id: "pickup", label: "Самовывоз со склада в городе" },
      { id: "warehouse", label: "Склад в Екатеринбурге" },
      { id: "evening", label: "Возят вечером или ночью", hoursOnly: true },
      { id: "pricelist", label: "Прайс на сайте" },
      { id: "horeca", label: "Работает с ресторанами" },
    ],
  },
  {
    title: "Надёжность",
    items: [
      { id: "active", label: "Компания действует" },
      { id: "age3", label: "Старше 3 лет" },
      { id: "decl", label: "Декларации на продукцию категории" },
      { id: "marking", label: "В «Честном знаке»", markingOnly: true },
      { id: "noflags", label: "ФНС проверила: флагов нет" },
    ],
  },
];

const warehouse = (s: Supplier) => isKnown(s.presence) && s.presence.value === "warehouse";

export const PRED: Record<FilterId, (s: Supplier, cat: Category) => boolean> = {
  door: (s) => isKnown(s.delivery) && s.delivery.value!.to_door,
  pickup: (s) => isKnown(s.delivery) && s.delivery.value!.pickup && warehouse(s),
  warehouse: (s) => warehouse(s),
  evening: (s) => !!s.hours && isKnown(s.hours) && s.hours.value!.evening_or_night === true,
  pricelist: (s) => isKnown(s.prices) && s.prices.value!.mode === "pricelist",
  horeca: (s) => isKnown(s.works_with_horeca) && s.works_with_horeca.value === true,
  active: (s) => isKnown(s.company) && s.company.value!.status === "active",
  age3: (s) => isKnown(s.company) && ageYears(s.company.value!.registered_at) >= 3,
  decl: (s, cat) => profileDeclarations(s, cat).length > 0,
  marking: (s, cat) => markingOk(s, cat),
  // «не проверены» — не «чисто»: фильтр оставляет только тех, кого ФНС действительно проверила
  noflags: (s) => {
    if (!isKnown(s.company)) return false;
    const f = fnsFlags(s.company.value!.flags);
    return !f.real.length && !f.unchecked;
  },
};

export const MAX_RANGE = 50000;

/** Минимальный заказ, сравнимый с суммой в рублях; иначе null — не указан или не в рублях. */
export function minRub(s: Supplier) {
  return isKnown(s.min_order) && s.min_order.value!.unit === "RUB" ? s.min_order.value!.amount ?? 0 : null;
}

export interface FilterState {
  flags: Set<FilterId>;
  max: number | null;
  keepUnknown: boolean;
}

export function readFilters(p: URLSearchParams): FilterState {
  return {
    flags: new Set((p.get("f") ?? "").split(",").filter(Boolean) as FilterId[]),
    max: p.get("max") ? Number(p.get("max")) : null,
    keepUnknown: p.get("unk") !== "0",
  };
}

export function passes(s: Supplier, cat: Category, f: FilterState) {
  for (const id of f.flags) if (!PRED[id](s, cat)) return false;
  if (f.max !== null) {
    const m = minRub(s);
    if (m === null ? !f.keepUnknown : m > f.max) return false;
  }
  return true;
}

export const activeCount = (f: FilterState) => f.flags.size + (f.max !== null ? 1 : 0);
