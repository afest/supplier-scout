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
  /** откуда добавили в шорт-лист: поиск, категория, план закупа, помощник (T-546, круг 3) — для мини-истории строки */
  from?: string | null;
}

export interface LastQuery {
  cat: string;
  sub: string;
  vol: string;
  prio: string;
}

/** Позиция, ради которой открыли поставщика (Павел 15.10, T-546): name — как на чипе, text — как писать в запросе
 *  (строка из плана закупа с брендом и фасовкой); без text в запрос идёт name. */
export interface WantItem {
  name: string;
  text?: string;
  /** где выбрали и когда — для мини-истории в шорт-листе */
  from?: string | null;
  at?: string;
}

export interface State {
  shortlist: Record<string, ShortItem>;
  /** что хотели взять у поставщика: переносится кликом по карточке с чипами, показывается на его странице и уходит в черновик */
  wanted: Record<string, WantItem[]>;
  compare: string[];
  /** поставщики, которых конвейер счёл «не поставщиком», а закупщик вернул руками */
  returned: string[];
  /** карточки, собранные живым сбором в этом браузере, и когда */
  collected: Record<string, string>;
  last: LastQuery | null;
  /** откуда пришли к поставщику: последний список, который смотрели («Поиск по товару «молоко, сыр»», «План закупа …») */
  trail: string | null;
}

const KEY = "supplier-scout:v1";
const EMPTY: State = { shortlist: {}, wanted: {}, compare: [], returned: [], collected: {}, last: null, trail: null };

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

/** Клик по карточке с чипами (и колёсиком — в новую вкладку) переносит отмеченное у поставщика к нему на страницу. */
export const carry = (id: string, items: WantItem[]) => items.length ? {
  onClick: () => actions.want(id, items),
  onAuxClick: (e: { button: number }) => { if (e.button === 1) actions.want(id, items); },
} : {};

export const MAX_COMPARE = 4;

export const actions = {
  toggleShort(id: string) {
    const s = { ...state.shortlist };
    if (s[id]) delete s[id];
    else s[id] = { status: "Не связывались", note: "", note_at: null, added_at: new Date().toISOString(), from: state.trail };
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
  /** Позиции с карточки — к уже выбранным у этого поставщика, без повторов: из плана закупа можно открыть его из итога
   *  и из группы, ничего не потеряв. */
  want(id: string, items: WantItem[]) {
    const had = state.wanted[id] ?? [];
    const seen = new Set(had.map((x) => x.name.toLowerCase()));
    const at = new Date().toISOString();
    const add = items.filter((x) => x.name && !seen.has(x.name.toLowerCase()) && seen.add(x.name.toLowerCase()))
      .map((x) => ({ ...x, from: x.from ?? state.trail, at }));
    if (add.length) set({ ...state, wanted: { ...state.wanted, [id]: [...had, ...add] } });
  },
  unwant(id: string, name: string) {
    const left = (state.wanted[id] ?? []).filter((x) => x.name !== name);
    const w = { ...state.wanted };
    if (left.length) w[id] = left;
    else delete w[id];
    set({ ...state, wanted: w });
  },
  clearWant(id: string) {
    const w = { ...state.wanted };
    delete w[id];
    set({ ...state, wanted: w });
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
  /** Список, который сейчас смотрят, — запоминается для «откуда» у шорт-листа и выбранных позиций. */
  setTrail(trail: string | null) {
    if (state.trail !== trail) set({ ...state, trail });
  },
  rememberQuery(q: LastQuery) {
    set({ ...state, last: q });
  },
  reset() {
    set(EMPTY);
  },
};
