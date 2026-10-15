// Цвет шкал по третям — один на весь интерфейс (T-541): балл, полнота данных, любые «чем больше, тем лучше».
// Доля округляется до процента: до 33% включительно — красный, 34–66% — жёлтый, от 67% — зелёный.
// Цвета — токены --lvl-<уровень>-c / -bg / -ink в tokens.css.

export type Level = "low" | "mid" | "high";

export function level(value: number, max = 100): Level {
  const pct = max > 0 ? Math.round((Math.max(0, Math.min(value, max)) / max) * 100) : 0;
  if (pct <= 33) return "low";
  if (pct <= 66) return "mid";
  return "high";
}

export const LEVEL_LABEL: Record<Level, string> = { low: "низко", mid: "средне", high: "высоко" };
