"""Готовит иллюстрации категорий для интерфейса.

Оригиналы (PNG 1024x1024 с прозрачным фоном) лежат вне репозитория, путь — первым аргументом.
Что делает:
  1. Обрезает по объекту.
  2. Масштабирует так, чтобы площадь непрозрачных пикселей у всех четырёх была одинаковой,
     а не ширина: иначе сыр с бутылкой выглядит мельче рыбы.
  3. Поднимает непрозрачность выше 200 до 255: объекты были чуть полупрозрачными (79–99 %).
Запуск: python scripts/prepare_illustrations.py <папка-оригиналов> web/public/categories
"""
import sys
from pathlib import Path

from PIL import Image

NAMES = ["fish", "dairy", "grocery", "packaging"]
CANVAS = 480
PAD = 0.06          # поле по краям, доля холста
FILL = 0.40         # целевая доля непрозрачной площади от холста


def main(src_dir: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        im = Image.open(src_dir / f"{name}.png").convert("RGBA")
        r, g, b, a = im.split()
        a = a.point(lambda v: 255 if v > 200 else v)
        im = Image.merge("RGBA", (r, g, b, a))

        bbox = a.point(lambda v: 255 if v > 16 else 0).getbbox()
        obj = im.crop(bbox)
        opaque = sum(obj.getchannel("A").histogram()[17:])

        scale = (FILL * CANVAS * CANVAS / opaque) ** 0.5
        limit = CANVAS * (1 - 2 * PAD)
        scale = min(scale, limit / obj.width, limit / obj.height)
        w, h = round(obj.width * scale), round(obj.height * scale)
        obj = obj.resize((w, h), Image.LANCZOS)

        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.paste(obj, ((CANVAS - w) // 2, (CANVAS - h) // 2), obj)
        out = out_dir / f"{name}.webp"
        canvas.save(out, "WEBP", quality=88, method=6)
        print(f"{name}: bbox {bbox}, opaque {opaque}px, scale {scale:.3f} -> {w}x{h}, {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
