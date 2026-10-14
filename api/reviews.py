"""Отзывы закупщиков о поставщиках: оценка 1–5 и текст, видны всем. Без регистрации и без модерации (прототип).

Защита от спама: скрытое поле-ловушка, лимит на IP (в main.py), один отзыв на поставщика с адреса в сутки, без ссылок.
IP не хранится — только хеш с солью, чтобы считать повторы.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.config import DATA

TEXT_MIN, TEXT_MAX, AUTHOR_MAX = 10, 1000, 60

_lock = threading.Lock()
_db: sqlite3.Connection | None = None
_salt = ""
_ids: set[str] = set()


class Invalid(ValueError):
    pass


def init(store: Path):
    global _db, _salt, _ids
    store.mkdir(parents=True, exist_ok=True)
    salt_file = store / "review-salt"
    if not salt_file.exists():
        salt_file.write_text(secrets.token_hex(16), encoding="utf-8")
    _salt = salt_file.read_text(encoding="utf-8").strip()
    _db = sqlite3.connect(store / "reviews.db", check_same_thread=False)
    _db.execute("""CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY,
        supplier_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        text TEXT NOT NULL,
        author TEXT,
        created_at TEXT NOT NULL,
        ip_hash TEXT NOT NULL)""")
    _db.execute("CREATE INDEX IF NOT EXISTS reviews_supplier ON reviews (supplier_id, created_at)")
    _db.commit()
    sups = json.loads((DATA / "suppliers.json").read_text(encoding="utf-8"))["suppliers"]
    _ids = {s["id"] for s in sups}


def known(supplier_id: str) -> bool:
    return supplier_id in _ids


def _ip_hash(ip: str) -> str:
    return hashlib.sha256(f"{_salt}:{ip}".encode()).hexdigest()[:24]


def list_for(supplier_id: str) -> dict:
    with _lock:
        rows = _db.execute("SELECT rating, text, author, created_at FROM reviews WHERE supplier_id = ? "
                           "ORDER BY created_at DESC LIMIT 100", (supplier_id,)).fetchall()
    items = [{"rating": r, "text": t, "author": a, "created_at": c} for r, t, a, c in rows]
    return {"supplier_id": supplier_id, "count": len(items),
            "avg": round(sum(i["rating"] for i in items) / len(items), 1) if items else None, "items": items}


def summary() -> dict:
    """Оценка и число отзывов по всем поставщикам — для списка и сортировки по отзывам."""
    with _lock:
        rows = _db.execute("SELECT supplier_id, COUNT(*), ROUND(AVG(rating), 1) FROM reviews GROUP BY supplier_id").fetchall()
    return {sid: {"count": n, "avg": avg} for sid, n, avg in rows}


def add(supplier_id: str, rating, text: str, author: str | None, trap: str | None, ip: str) -> dict:
    if trap:                                   # поле-ловушку человек не видит и не заполняет
        raise Invalid("Отзыв не принят.")
    if not known(supplier_id):
        raise Invalid("Такого поставщика нет в наборе.")
    if not isinstance(rating, int) or not 1 <= rating <= 5:
        raise Invalid("Оценка — от 1 до 5.")
    text = re.sub(r"\s+", " ", text or "").strip()
    author = re.sub(r"\s+", " ", author or "").strip()[:AUTHOR_MAX] or None
    if len(text) < TEXT_MIN:
        raise Invalid(f"Напишите хотя бы пару слов — от {TEXT_MIN} знаков.")
    if len(text) > TEXT_MAX:
        raise Invalid(f"Отзыв длиннее {TEXT_MAX} знаков — сократите, пожалуйста.")
    if re.search(r"https?://|www\.|\b[a-z0-9-]+\.(?:ru|com|рф|net|org|io)\b", f"{text} {author or ''}", re.I):
        raise Invalid("Ссылки в отзывах не принимаются.")
    now = datetime.now(timezone.utc)
    h = _ip_hash(ip)
    with _lock:
        dup = _db.execute("SELECT 1 FROM reviews WHERE supplier_id = ? AND ip_hash = ? AND created_at > ?",
                          (supplier_id, h, (now - timedelta(days=1)).isoformat(timespec="seconds"))).fetchone()
        if dup:
            raise Invalid("С вашего адреса уже есть отзыв об этом поставщике за последние сутки.")
        _db.execute("INSERT INTO reviews (supplier_id, rating, text, author, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)",
                    (supplier_id, rating, text, author, now.isoformat(timespec="seconds"), h))
        _db.commit()
    return list_for(supplier_id)
