// Оценка по отзывам (T-543, правка Павла 15.10): средняя и число отзывов — на странице поставщика и в списках.
// Отзывы с сервера приходят сводкой одним запросом (GET /reviews), примеры из интерфейса считаются вместе с ними,
// как обычные отзывы: иначе функцию не видно. Сервер не ответил — остаются примеры.
import { useSyncExternalStore } from "react";
import { reviewsSummary } from "./api.ts";
import { sampleReviews } from "./sampleReviews.ts";

export interface ReviewStat { count: number; avg: number }
type Summary = Record<string, { count: number; avg: number | null }>;

let summary: Summary = {};
let started = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!started) {
    started = true;
    reviewsSummary().then((s) => { summary = s; emit(); }).catch(() => { /* без сервера — только примеры */ });
  }
  return () => subs.delete(cb);
}

/** Отзыв оставлен на странице — сервер вернул новый счёт этого поставщика, списки обновляются без перезагрузки. */
export function patchReviewStat(id: string, count: number, avg: number | null) {
  summary = { ...summary, [id]: { count, avg } };
  emit();
}

/** Сводка сервера + примеры: число и средняя. Отзывов нет — null. */
export function mergeStat(real: { count: number; avg: number | null } | undefined, id: string): ReviewStat | null {
  const ex = sampleReviews(id);
  const n = (real?.count ?? 0) + ex.length;
  if (!n) return null;
  const sum = (real?.avg ?? 0) * (real?.count ?? 0) + ex.reduce((a, r) => a + r.rating, 0);
  return { count: n, avg: sum / n };
}

export function useReviewStat(id: string): ReviewStat | null {
  const s = useSyncExternalStore(subscribe, () => summary);
  return mergeStat(s[id], id);
}

/** 4,7 — одна цифра после запятой, по-русски. */
export const avgText = (v: number) => v.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
