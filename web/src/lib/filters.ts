// Фильтры по дополнительным полям — общие для результатов поиска и каталога «Все поставщики».
import type { Category, Supplier } from "../types.ts";
import { ageYears, isKnown } from "./format.ts";
import { activeDeclarations, markingOk } from "./score.ts";

export type FilterId = "door" | "pickup" | "warehouse" | "pricelist" | "horeca" | "active" | "age3" | "decl" | "marking" | "noflags";

export const FILTER_GROUPS: { title: string; items: { id: FilterId; label: string; markingOnly?: boolean }[] }[] = [
  {
    title: "Условия",
    items: [
      { id: "door", label: "Доставка до точки" },
      { id: "pickup", label: "Самовывоз в городе" },
      { id: "warehouse", label: "Склад в Екатеринбурге" },
      { id: "pricelist", label: "Прайс на сайте" },
      { id: "horeca", label: "Работает с ресторанами" },
    ],
  },
  {
    title: "Надёжность",
    items: [
      { id: "active", label: "Компания действует" },
      { id: "age3", label: "Старше 3 лет" },
      { id: "decl", label: "Есть декларации" },
      { id: "marking", label: "В «Честном знаке»", markingOnly: true },
      { id: "noflags", label: "Без красных флагов ФНС" },
    ],
  },
];

const local = (s: Supplier) => s.city === "Екатеринбург";

export const PRED: Record<FilterId, (s: Supplier, cat: Category) => boolean> = {
  door: (s) => isKnown(s.delivery) && s.delivery.value!.to_door,
  pickup: (s) => isKnown(s.delivery) && s.delivery.value!.pickup && local(s),
  warehouse: (s) => isKnown(s.presence) && s.presence.value === "warehouse" && local(s),
  pricelist: (s) => isKnown(s.prices) && s.prices.value!.mode === "pricelist",
  horeca: (s) => isKnown(s.works_with_horeca) && s.works_with_horeca.value === true,
  active: (s) => isKnown(s.company) && s.company.value!.status === "active",
  age3: (s) => isKnown(s.company) && ageYears(s.company.value!.registered_at) >= 3,
  decl: (s) => activeDeclarations(s).length > 0,
  marking: (s, cat) => markingOk(s, cat),
  noflags: (s) => isKnown(s.company) && s.company.value!.flags.length === 0,
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
