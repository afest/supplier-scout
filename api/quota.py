"""Лимит демо-стенда: сколько платных действий в сутки на весь стенд — сверх них модель не вызывается.

Стенд нужен проверяющему, а не публике: 5 живых сборов и 10 диалогов помощника в сутки хватает, чтобы всё посмотреть,
и никто не превратит стенд в бесплатный доступ к модели. Сутки — по Екатеринбургу; счётчик на постоянном диске,
перезапуск сервера его не обнуляет. В продукте вместо этого — квоты на аккаунт и оплата.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

PER_DAY = {"collect": int(os.environ.get("DEMO_COLLECT_PER_DAY", "5")),
           "assist": int(os.environ.get("DEMO_ASSIST_PER_DAY", "10"))}
NAMES = {"collect": "живых сборов", "assist": "запросов помощника"}   # описание словами и план закупа (T-546) — вместе
YEKT = timezone(timedelta(hours=5))          # Екатеринбург, без перехода на летнее время

_lock = threading.Lock()
_file: Path | None = None


class Exhausted(RuntimeError):
    pass


def init(store: Path):
    global _file
    _file = store / "demo-quota.json"


def _today() -> str:
    return datetime.now(YEKT).date().isoformat()


def _load() -> dict:
    if _file and _file.exists():
        d = json.loads(_file.read_text(encoding="utf-8"))
        if d.get("date") == _today():
            return d
    return {"date": _today(), "collect": 0, "assist": 0}


def take(kind: str):
    """Списывает одно действие; если на сегодня всё израсходовано — Exhausted с текстом для интерфейса."""
    with _lock:
        d = _load()
        if d[kind] >= PER_DAY[kind]:
            raise Exhausted(f"Демо-стенд: на сегодня все {PER_DAY[kind]} {NAMES[kind]} израсходованы — "
                            "лимит обнулится в полночь по Екатеринбургу. Собранный набор работает как обычно.")
        d[kind] += 1
        _file.write_text(json.dumps(d), encoding="utf-8")


def left() -> dict:
    with _lock:
        d = _load()
    return {k: {"left": max(PER_DAY[k] - d[k], 0), "per_day": PER_DAY[k]} for k in PER_DAY}
