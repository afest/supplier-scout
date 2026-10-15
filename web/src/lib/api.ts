// Сервер сбора, помощника и отзывов (T-536). Интерфейс — статика, сервер — отдельно на Amvera.
// Адрес переопределяется при сборке: VITE_API_URL=http://127.0.0.1:8000 npm run dev
import type { Supplier } from "../types.ts";

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "")
  ?? "https://supplier-scout-api-afest.msk1.amvera.tech";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError("Сервер не ответил — возможно, он перезапускается. Попробуйте через минуту.", 0);
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `Сервер ответил ошибкой ${r.status}.`;
    throw new ApiError(detail, r.status);
  }
  return body as T;
}
const post = <T>(path: string, data: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(data) });

export interface Health {
  ok: boolean;
  model_configured: boolean;
  demo_left: Record<"collect" | "assist", { left: number; per_day: number }>;
}
let lastHealth: Health | null = null;
/** Последний ответ /health: экран помощника рисует остаток лимита сразу, пока идёт свежий запрос. Без него строка лимита
 *  появлялась после «назад» с опозданием и сдвигала страницу на свою высоту — место прокрутки уезжало (T-546). */
export const cachedHealth = () => lastHealth;
export const health = () => call<Health>("/health").then((h) => (lastHealth = h));

// ---- живой сбор ----
export interface Job {
  id: string;
  state: "queued" | "running" | "done" | "error";
  position?: number;
  steps: { t: number; text: string }[];
  card: Supplier | null;
  error: string | null;
  spent_rub: number | null;
}
export const collect = (site: string | null, inn: string | null, category: string | null) =>
  post<Job>("/collect", { site, inn, category });
export const job = (id: string) => call<Job>(`/jobs/${id}`);

// ---- помощник ----
export interface Need { id: string; label: string; why: string; terms: string[]; suppliers_count: number }
/** answers — 2–4 варианта ответа на уточняющий вопрос для кнопок (T-544); пусто, если вопроса нет */
export interface Suggest { place: string; question: string | null; answers: string[]; needs: Need[] }
export interface Found {
  id: string; name: string; category: string; category_name: string | null; demo: boolean;
  exact: boolean; matched: string[]; matched_total: number;
}
export interface Match {
  by_need: { label: string; suppliers: Found[] }[];
  best: { id: string; name: string; category: string; category_name: string | null; demo: boolean; covers: string[] }[];
  missing: string[];
}
export const assist = (text: string, signal?: AbortSignal) =>
  call<Suggest>("/assist", { method: "POST", body: JSON.stringify({ text }), signal });
export const match = (needs: Pick<Need, "label" | "terms">[]) => post<Match>("/assist/match", { needs });

// ---- план закупа (T-546): уходят только названия позиций, файл остаётся в браузере ----
/** group — id категории набора или "other" (вне набора); parsed: false — модель строку пропустила, искали по её тексту */
export interface PlanPosition {
  id: string; label: string; group: string; terms: string[]; lines: string[]; parsed: boolean;
  suppliers: { id: string; exact: boolean; matched: string[]; price: { item: string; price: string } | null }[];
}
export interface PlanResult { positions: PlanPosition[]; skipped: string[] }
export const plan = (lines: string[], signal?: AbortSignal) =>
  call<PlanResult>("/assist/plan", { method: "POST", body: JSON.stringify({ lines }), signal });

// ---- отзывы ----
export interface Review { rating: number; text: string; author: string | null; created_at: string }
export interface Reviews { supplier_id: string; count: number; avg: number | null; items: Review[] }
export const reviews = (id: string) => call<Reviews>(`/reviews/${encodeURIComponent(id)}`);
/** Сводка по всем поставщикам одним запросом: id → число отзывов и средняя (для списков, T-543). */
export const reviewsSummary = () => call<Record<string, { count: number; avg: number | null }>>("/reviews");
export const addReview = (id: string, data: { rating: number; text: string; author: string; website: string }) =>
  post<Reviews>(`/reviews/${encodeURIComponent(id)}`, data);
