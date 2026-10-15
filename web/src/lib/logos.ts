// Логотипы поставщиков для аватара — собраны с их сайтов в T-542, подключены в T-541 (круг 2, просьба Павла 15.10).
// Файлы — web/public/logos/, карта id → файл — data/logos.json. Нет записи — монограмма.
import raw from "../../../data/logos.json";

export interface Logo {
  src: string;
  /** белый логотип, рассчитанный на тёмный фон: стоит на тёмной плашке и в покое, и по наведению */
  onDark?: boolean;
}

const LOGOS = raw as Record<string, { file: string; on_dark: boolean }>;

export function logoOf(id: string): Logo | undefined {
  const l = LOGOS[id];
  return l ? { src: import.meta.env.BASE_URL + l.file, onDark: l.on_dark } : undefined;
}
