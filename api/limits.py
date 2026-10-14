"""Лимит запросов на IP: скользящее окно в памяти процесса. Перезапуск сервера счётчики обнуляет — для прототипа хватает."""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_lock = threading.Lock()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")


def check(request: Request, bucket: str, limit: int, window_sec: int = 3600):
    """Не больше `limit` принятых запросов за окно; сверх — 429 с понятным текстом. Отклонённые не считаются."""
    q = _hits[(bucket, client_ip(request))]
    now = time.time()
    with _lock:
        while q and q[0] < now - window_sec:
            q.popleft()
        if len(q) >= limit:
            wait = int(q[0] + window_sec - now) // 60 + 1
            when = f"{wait} мин." if wait <= 90 else f"{round(wait / 60)} ч."
            raise HTTPException(429, f"Лимит запросов с вашего адреса исчерпан. Попробуйте через {when}")


def record(request: Request, bucket: str):
    with _lock:
        _hits[(bucket, client_ip(request))].append(time.time())
