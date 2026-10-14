"""Лимит запросов на IP: скользящее окно в памяти процесса. Перезапуск сервера счётчики обнуляет — для прототипа хватает."""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_lock = threading.Lock()

# Сколько прокси стоит перед приложением и дописывает адрес в X-Forwarded-For. Свой адрес каждый дописывает справа,
# поэтому адрес клиента — N-й с конца; всё левее прислал сам клиент. На Amvera — один (замер на стенде, T-539).
TRUSTED_PROXY_HOPS = int(os.environ.get("TRUSTED_PROXY_HOPS", "1"))


def client_ip(request: Request) -> str:
    """Адрес для лимитов и «один отзыв с адреса в сутки». Первый адрес X-Forwarded-For присылает клиент — подменив его,
    лимит обходили (ревью T-536); берём тот, что дописал прокси Amvera."""
    fwd = [x.strip() for x in (request.headers.get("x-forwarded-for") or "").split(",") if x.strip()]
    if fwd and TRUSTED_PROXY_HOPS > 0:
        return fwd[-min(TRUSTED_PROXY_HOPS, len(fwd))]
    return request.client.host if request.client else "?"


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
