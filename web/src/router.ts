// Маршруты через # — статика живёт на GitHub Pages без серверных правил.
import { useSyncExternalStore } from "react";

export interface Route {
  path: string;
  params: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return { path: path || "/", params: new URLSearchParams(query) };
}

let current = parse();
const listeners = new Set<() => void>();
const emit = () => {
  current = parse();
  listeners.forEach((l) => l());
};
window.addEventListener("hashchange", () => {
  emit();
  window.scrollTo(0, 0);
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export type Params = Record<string, string | number | null | undefined | false>;

export function href(path: string, params: Params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== false && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}

/** replace: true — смена фильтра не плодит записи в истории браузера. */
export function navigate(path: string, params: Params = {}, opts: { replace?: boolean } = {}) {
  const h = href(path, params);
  if (opts.replace) {
    history.replaceState(null, "", h);
    emit();
  } else {
    window.location.hash = h;
  }
}

export function paramsToObject(p: URLSearchParams): Record<string, string> {
  return Object.fromEntries(p.entries());
}
