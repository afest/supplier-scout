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

// Прокрутка по записям истории (T-544): «назад» возвращает туда, где читали список, новый переход — наверх.
// У каждой записи свой ключ в history.state; браузер сам прокрутку не восстанавливает — иначе он спорит с этим кодом.
const SCROLL_KEY = "supplier-scout:scroll";
const scrolls: Record<string, number> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(SCROLL_KEY) || "{}");
  } catch {
    return {};
  }
})();
function entryKey(): string {
  const st = history.state as { k?: string } | null;
  if (st?.k) return st.k;
  const k = Math.random().toString(36).slice(2, 10);
  history.replaceState({ ...st, k }, "");
  return k;
}
/** Прокрутить к y, когда страница дорастёт до него: экран рисуется после смены адреса, картинки догружаются. */
function scrollWhenReady(y: number, tries = 20) {
  requestAnimationFrame(() => {
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) > 2 && tries > 0) scrollWhenReady(y, tries - 1);
  });
}
history.scrollRestoration = "manual";
let entry = entryKey();
if (scrolls[entry]) scrollWhenReady(scrolls[entry]);
window.addEventListener("scroll", () => { scrolls[entry] = window.scrollY; }, { passive: true });
window.addEventListener("pagehide", () => {
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(scrolls));
  } catch {
    /* хранилище недоступно — прокрутка помнится до перезагрузки */
  }
});
window.addEventListener("hashchange", () => {
  entry = entryKey();
  emit();
  const y = scrolls[entry];
  if (y) scrollWhenReady(y);
  else window.scrollTo(0, 0);
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
    history.replaceState(history.state, "", h);       // ключ записи сохраняется — прокрутка остаётся за ней
    emit();
  } else {
    window.location.hash = h;
  }
}

export function paramsToObject(p: URLSearchParams): Record<string, string> {
  return Object.fromEntries(p.entries());
}
