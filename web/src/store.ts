// Шорт-лист, заметки, выбор для сравнения — в памяти браузера (localStorage), без входа и кабинетов.
// Доступ к хранилищу обёрнут: в приватном окне его может не быть, тогда всё живёт до перезагрузки.
import { useSyncExternalStore } from "react";

export const CONTACT_STATUSES = ["Не связывались", "Написал", "Ответил", "Договорились", "Не подходит"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export interface ShortItem {
  status: ContactStatus;
  note: string;
  note_at: string | null;
  added_at: string;
}

export interface LastQuery {
  cat: string;
  sub: string;
  vol: string;
  prio: string;
}

export interface State {
  shortlist: Record<string, ShortItem>;
  compare: string[];
  /** поставщики, которых конвейер счёл «не поставщиком», а закупщик вернул руками */
  returned: string[];
  /** карточки, собранные живым сбором в этом браузере, и когда */
  collected: Record<string, string>;
  last: LastQuery | null;
}

const KEY = "supplier-scout:v1";
const EMPTY: State = { shortlist: {}, compare: [], returned: [], collected: {}, last: null };

function load(): State {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

let state = load();
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* хранилище недоступно — работаем в памяти */
  }
  listeners.forEach((l) => l());
}

export function useStore(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export const getState = () => state;

export const MAX_COMPARE = 4;

export const actions = {
  toggleShort(id: string) {
    const s = { ...state.shortlist };
    if (s[id]) delete s[id];
    else s[id] = { status: "Не связывались", note: "", note_at: null, added_at: new Date().toISOString() };
    set({ ...state, shortlist: s });
  },
  addShort(id: string) {
    if (!state.shortlist[id]) actions.toggleShort(id);
  },
  // статус и заметка — у записи шорт-листа; в шорт-лист поставщик попадает только звёздочкой или «Написать»
  setStatus(id: string, status: ContactStatus) {
    const item = state.shortlist[id];
    if (!item) return;
    set({ ...state, shortlist: { ...state.shortlist, [id]: { ...item, status } } });
  },
  setNote(id: string, note: string) {
    const item = state.shortlist[id];
    if (!item) return;
    set({ ...state, shortlist: { ...state.shortlist, [id]: { ...item, note, note_at: new Date().toISOString() } } });
  },
  /** Убрать записи разом — для поставщиков, которых больше нет в наборе. */
  dropShort(ids: string[]) {
    const s = { ...state.shortlist };
    for (const id of ids) delete s[id];
    set({ ...state, shortlist: s });
  },
  toggleCompare(id: string) {
    const has = state.compare.includes(id);
    if (!has && state.compare.length >= MAX_COMPARE) return false;
    set({ ...state, compare: has ? state.compare.filter((x) => x !== id) : [...state.compare, id] });
    return true;
  },
  setCompare(ids: string[]) {
    set({ ...state, compare: ids.slice(0, MAX_COMPARE) });
  },
  returnSupplier(id: string) {
    if (!state.returned.includes(id)) set({ ...state, returned: [...state.returned, id] });
  },
  markCollected(id: string) {
    set({ ...state, collected: { ...state.collected, [id]: new Date().toISOString() } });
  },
  rememberQuery(q: LastQuery) {
    set({ ...state, last: q });
  },
  reset() {
    set(EMPTY);
  },
};
