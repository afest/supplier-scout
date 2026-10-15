// План закупа (T-546): файл закупщика → строки с названиями позиций → итог «у кого брать».
// Файл читается здесь, в браузере, и на сервер не уходит — сервер получает только названия позиций.
// Итог — комбинацию до трёх поставщиков — тоже считает этот код, без модели: охват позиций, потом балл.
// Модуль без зависимостей от данных и DOM: его же гоняет scripts/selftest-plan.mjs в Node.

export const PLAN_MAX = 50;          // как PLAN_MAX на сервере (api/assistant.py)
export const LINE_MAX = 120;
const READ_ROWS = 2000;              // больше строк из файла не читаем: план закупа — десятки позиций, не прайс

export type Table = string[][];

export class PlanError extends Error {}

// ---------- текст: CSV и вставка из Excel ----------

/** Байты текстового файла → строка. Русский Excel сохраняет «CSV (разделители — запятые)» в Windows-1251,
 *  «CSV UTF-8» — отдельный пункт меню; не UTF-8 — значит 1251. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

/** Запятая между двумя цифрами — дробь, а не разделитель: «Молоко 3,2%» — одна ячейка (дефект поиска T-544). */
const isDecimalComma = (t: string, i: number) => /\d/.test(t[i - 1] ?? "") && /\d/.test(t[i + 1] ?? "");

function countOutsideQuotes(line: string, d: string) {
  let n = 0;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (!q && line[i] === d && !(d === "," && isDecimalComma(line, i))) n++;
  }
  return n;
}

/** Разделитель колонок: табуляция (вставка из Excel), «;» (CSV русского Excel), запятая — если есть хотя бы в половине
 *  непустых строк. Иначе колонка одна: строка целиком — название. */
function delimiter(t: string, comma: boolean): string | null {
  const lines = t.split("\n").filter((l) => l.trim()).slice(0, 40);
  if (!lines.length) return null;
  for (const d of comma ? ["\t", ";", ","] : ["\t", ";"]) {
    const hit = lines.filter((l) => countOutsideQuotes(l, d) > 0).length;
    if (hit >= Math.ceil(lines.length / 2)) return d;
  }
  return null;
}

/** Таблица из CSV-файла или из текста, вставленного в поле. Кавычки — как в CSV: внутри них разделитель и перенос строки
 *  не делят ячейку, "" — кавычка. comma: false — для вставки: там запятая — часть названия («Стакан 0,5 л, белый»). */
export function readDelimited(text: string, opts: { comma?: boolean } = {}): Table {
  const t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const d = delimiter(t, opts.comma ?? true);
  const rows: Table = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < t.length && rows.length < READ_ROWS; i++) {
    const ch = t[i];
    if (q) {
      if (ch !== '"') cell += ch;
      else if (t[i + 1] === '"') { cell += '"'; i++; }
      else q = false;
    } else if (ch === '"' && d && !cell.trim()) {
      q = true;
      cell = "";
    } else if (d && ch === d && !(d === "," && isDecimalComma(t, i))) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- .xlsx: zip + XML, без библиотек ----------

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Оглавление zip-архива: имя файла → чтение его текста. Читаем только то, что нужно, — архив не распаковывается целиком. */
function unzip(b: Uint8Array): Map<string, () => Promise<string>> {
  let e = b.length - 22;
  while (e >= 0 && u32(b, e) !== 0x06054b50) e--;
  if (e < 0) throw new PlanError("Файл не похож на .xlsx. Сохраните его в Excel как «Книга Excel (.xlsx)» или как CSV.");
  const files = new Map<string, () => Promise<string>>();
  let p = u32(b, e + 16);
  for (let i = 0, n = u16(b, e + 10); i < n && u32(b, p) === 0x02014b50; i++) {
    const method = u16(b, p + 10), size = u32(b, p + 20), nameLen = u16(b, p + 28);
    const local = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    files.set(name, async () => {
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
      const data = b.subarray(start, start + size);
      if (method !== 0 && method !== 8) throw new PlanError("Файл .xlsx сжат необычным способом — сохраните его как CSV.");
      return new TextDecoder().decode(method === 8 ? await inflate(data) : data);
    });
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
  }
  return files;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function unxml(s: string) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m)
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));     // _x000D_ — экранирование OOXML
}
/** Текст ячейки или общей строки: все <t> подряд (у форматированного текста их несколько), без фонетических подсказок. */
const texts = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((m) => unxml(m[1] ?? "")).join("");
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function sheetTable(xml: string, shared: string[]): Table {
  const rows: Table = [];
  let r = -1;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rn = Number(attr(rm[1], "r"));
    r = rn > 0 ? rn - 1 : r + 1;
    if (r >= READ_ROWS) break;
    const row: string[] = [];
    let c = -1;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /^([A-Z]+)\d+$/.exec(attr(cm[1], "r") ?? "");
      c = ref ? colIndex(ref[1]) : c + 1;
      const body = cm[2] ?? "";
      const t = attr(cm[1], "t");
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      row[c] = t === "inlineStr" ? texts(body) : v === undefined ? "" : t === "s" ? shared[Number(v)] ?? "" : unxml(v);
    }
    rows[r] = Array.from(row, (x) => x ?? "");
  }
  return Array.from(rows, (x) => x ?? []);
}

/** Первый непустой видимый лист книги .xlsx → таблица строк. Формулы — по сохранённому значению, даты остаются числом. */
export async function readXlsx(buf: ArrayBuffer): Promise<{ table: Table; sheet: string }> {
  const files = unzip(new Uint8Array(buf));
  const read = (name: string) => files.get(name)?.() ?? Promise.resolve("");
  if (!files.has("xl/workbook.xml")) {
    throw new PlanError("Внутри файла нет книги Excel. Сохраните его в Excel как «Книга Excel (.xlsx)» или как CSV.");
  }
  const [wb, rels, sst] = await Promise.all([read("xl/workbook.xml"), read("xl/_rels/workbook.xml.rels"), read("xl/sharedStrings.xml")]);
  const shared = [...sst.matchAll(/<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => texts(m[1] ?? ""));
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)]
    .filter((m) => !/^(hidden|veryHidden)$/.test(attr(m[0], "state") ?? ""))
    .map((m) => ({ name: unxml(attr(m[0], "name") ?? ""), target: targets.get(attr(m[0], "r:id")) ?? "" }));
  for (const s of sheets.slice(0, 10)) {
    const path = s.target.startsWith("/") ? s.target.slice(1) : `xl/${s.target}`;
    const table = sheetTable(await read(path), shared);
    if (table.some((row) => row.some((x) => x.trim()))) return { table, sheet: s.name };
  }
  throw new PlanError("В книге нет листа с данными.");
}

// ---------- таблица → строки плана ----------

export interface Column { index: number; title: string; sample: string }
export interface PlanRead {
  /** колонки с данными — выбор, если угадали не ту */
  columns: Column[];
  /** колонка с названиями */
  col: number;
  /** нашлась строка шапки («Наименование», «Товар») — колонка взята из неё */
  header: boolean;
  /** названия позиций, не больше PLAN_MAX */
  lines: string[];
  dropped: { head: number; empty: number; totals: number; repeats: number };
  /** сколько позиций сверх PLAN_MAX отрезано */
  cut: number;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
// «Наименование…» и «Номенклатура…» строку позиции не начинают; «Товар», «Позиция» — только ячейкой целиком: «Позиция 1» — не шапка
const HEAD = /^(наименование|номенклатура)(?![а-яё])|^(название|товар|продукт|позиция|продукция|сырь[её])( (товара|позиции|продукции|продукта))?[.:]?$/i;
const TOTAL = /^(итого|всего|итог)(?![а-яё])/i;
const WORDY = /[a-zа-яё]{2,}/i;
export const colLetter = (i: number): string => (i >= 26 ? colLetter(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

/** Какие строки таблицы — позиции плана. Шапка — строка, где ячейка начинается с «Наименование», «Товар», «Позиция»…:
 *  колонка названий — её, строки выше (название документа, дата) отбрасываются. Шапки нет — колонка, где больше всего
 *  текста. Отбрасываются строки без названия, итоги («Итого», «Всего») и повторы; позиций — не больше PLAN_MAX. */
export function planFromTable(table: Table, pick: number | null = null): PlanRead {
  const rows = table.map((r) => r.map(norm));
  const filled = (r: string[]) => r.some(Boolean);
  const first = rows.findIndex(filled);
  const last = rows.length - 1 - [...rows].reverse().findIndex(filled);
  const dropped = { head: 0, empty: 0, totals: 0, repeats: 0 };
  if (first < 0) return { columns: [], col: 0, header: false, lines: [], dropped, cut: 0 };

  let headAt = -1;
  let headCol = -1;
  for (let i = first, seen = 0; i <= last && seen < 10; i++) {
    if (!filled(rows[i])) continue;
    seen++;
    const c = rows[i].findIndex((x) => x.length <= 40 && HEAD.test(x));
    if (c >= 0) { headAt = i; headCol = c; break; }
  }
  const data = rows.slice(headAt >= 0 ? headAt + 1 : first, last + 1);
  if (headAt >= 0) dropped.head = rows.slice(first, headAt + 1).filter(filled).length;

  const width = Math.max(0, ...data.map((r) => r.length));
  const columns: Column[] = [];
  const weight: number[] = [];
  for (let c = 0; c < width; c++) {
    const vals = data.map((r) => r[c] ?? "").filter(Boolean);
    if (!vals.length) continue;
    const wordy = vals.filter((v) => WORDY.test(v));
    weight[c] = wordy.length * (wordy.reduce((n, v) => n + v.length, 0) / (wordy.length || 1));
    const title = headAt >= 0 ? rows[headAt][c] : "";
    columns.push({ index: c, title: title || `Колонка ${colLetter(c)}`, sample: (wordy[0] ?? vals[0]).slice(0, 40) });
  }
  const best = columns.reduce((a, c) => (weight[c.index] > weight[a] ? c.index : a), columns[0]?.index ?? 0);
  const col = pick !== null && columns.some((c) => c.index === pick) ? pick : headCol >= 0 ? headCol : best;

  const all: string[] = [];
  const seenLines = new Set<string>();
  for (const r of data) {
    const v = r[col] ?? "";
    if (!WORDY.test(v)) dropped.empty++;
    else if (TOTAL.test(v)) dropped.totals++;
    else if (seenLines.has(v.toLowerCase())) dropped.repeats++;
    else {
      seenLines.add(v.toLowerCase());
      all.push(v.slice(0, LINE_MAX));
    }
  }
  return { columns, col, header: headCol >= 0 && col === headCol, lines: all.slice(0, PLAN_MAX), dropped, cut: Math.max(0, all.length - PLAN_MAX) };
}

// ---------- итог: кому писать ----------

export interface PlanSupplier { id: string; exact: boolean }
export interface PlanPos { id: string; suppliers: PlanSupplier[] }
export interface Pick { id: string; takes: string[] }
export interface Verdict {
  /** до трёх поставщиков; у каждого — позиции, которые он берёт на себя */
  picks: Pick[];
  covered: number;
  total: number;
  /** позиции, которые есть у кого-то в наборе, но не у выбранных: крупный опт, исключённые или просто не влезли в тройку */
  elsewhere: { pos: string; by: string[] }[];
  /** позиции, которых нет ни у кого в наборе */
  nobody: string[];
}

const popcount = (m: bigint) => {
  let n = 0;
  for (let x = m; x; x &= x - 1n) n++;
  return n;
};

/** Комбинация до max поставщиков, которая закрывает больше всего позиций. При равенстве — где поставщиков меньше
 *  (меньше минимальных заказов и доставок), потом — где выше сумма баллов. Перебор полный: кандидатов десятки,
 *  сочетаний по три — десятки тысяч, это миллисекунды. score(id) === null — поставщик в итог не идёт (исключён из
 *  рекомендации или крупный опт для одной точки), но в «есть у других» его видно.
 *  Позицию, которая есть у нескольких выбранных, берёт тот, у кого она нашлась точно, потом — у кого выше балл. */
export function verdict(positions: PlanPos[], score: (id: string) => number | null, max = 3): Verdict {
  const bit = new Map(positions.map((p, i) => [p.id, 1n << BigInt(i)]));
  const masks = new Map<string, bigint>();
  for (const p of positions) for (const s of p.suppliers) {
    if (score(s.id) === null) continue;
    masks.set(s.id, (masks.get(s.id) ?? 0n) | bit.get(p.id)!);
  }
  const cand = [...masks.keys()].sort((a, b) => popcount(masks.get(b)!) - popcount(masks.get(a)!) || score(b)! - score(a)! || a.localeCompare(b));
  let best: string[] = [];
  let bestKey = [0, 0, 0];
  const better = (k: number[]) => k[0] > bestKey[0] || (k[0] === bestKey[0] && (k[1] > bestKey[1] || (k[1] === bestKey[1] && k[2] > bestKey[2])));
  const visit = (ids: string[], m: bigint) => {
    const k = [popcount(m), -ids.length, ids.reduce((n, id) => n + score(id)!, 0)];
    if (better(k)) { best = ids; bestKey = k; }
  };
  for (let i = 0; i < cand.length; i++) {
    const mi = masks.get(cand[i])!;
    visit([cand[i]], mi);
    if (max < 2) continue;
    for (let j = i + 1; j < cand.length; j++) {
      const mj = mi | masks.get(cand[j])!;
      visit([cand[i], cand[j]], mj);
      if (max < 3) continue;
      for (let k = j + 1; k < cand.length; k++) visit([cand[i], cand[j], cand[k]], mj | masks.get(cand[k])!);
    }
  }

  const takes = new Map(best.map((id) => [id, [] as string[]]));
  const elsewhere: Verdict["elsewhere"] = [];
  const nobody: string[] = [];
  for (const p of positions) {
    const mine = p.suppliers.filter((s) => takes.has(s.id))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || score(b.id)! - score(a.id)! || best.indexOf(a.id) - best.indexOf(b.id));
    if (mine.length) takes.get(mine[0].id)!.push(p.id);
    else if (p.suppliers.length) elsewhere.push({ pos: p.id, by: p.suppliers.map((s) => s.id) });
    else nobody.push(p.id);
  }
  const picks = best.map((id) => ({ id, takes: takes.get(id)! }))
    .sort((a, b) => b.takes.length - a.takes.length || score(b.id)! - score(a.id)!);
  return { picks, covered: bestKey[0], total: positions.length, elsewhere, nobody };
}
