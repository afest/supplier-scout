"""Ключи — только из файла вне репозитория или из переменной окружения; в репозиторий и в вывод не попадают."""
from __future__ import annotations

import os
from pathlib import Path

# По умолчанию — личная папка секретов на машине разработчика; на сервере — переменные окружения.
DEFAULT_ENV_FILE = Path.home() / ".claude" / "secrets" / "supplier-scout.env"


def get(name: str) -> str:
    if os.environ.get(name):
        return os.environ[name]
    path = Path(os.environ.get("SUPPLIER_SCOUT_ENV", DEFAULT_ENV_FILE))
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{name}="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    raise SystemExit(f"Нет ключа {name}: задайте переменную окружения или строку {name}=… в {path}")
