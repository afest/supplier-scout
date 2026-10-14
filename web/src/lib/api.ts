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
export const health = () => call<Health>("/health");

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
export interface Suggest { place: string; question: string | null; needs: Need[] }
export interface Found {
  id: string; name: string; category: string; category_name: string | null; demo: boolean;
  exact: boolean; matched: string[]; matched_total: number;
}
export interface Match {
  by_need: { label: string; suppliers: Found[] }[];
  best: { id: string; name: string; category: string; category_name: string | null; demo: boolean; covers: string[] }[];
  missing: string[];
}
export const assist = (text: string) => post<Suggest>("/assist", { text });
export const match = (needs: Pick<Need, "label" | "terms">[]) => post<Match>("/assist/match", { needs });

// ---- отзывы ----
export interface Review { rating: number; text: string; author: string | null; created_at: string }
export interface Reviews { supplier_id: string; count: number; avg: number | null; items: Review[] }
export const reviews = (id: string) => call<Reviews>(`/reviews/${encodeURIComponent(id)}`);
export const addReview = (id: string, data: { rating: number; text: string; author: string; website: string }) =>
  post<Reviews>(`/reviews/${encodeURIComponent(id)}`, data);
