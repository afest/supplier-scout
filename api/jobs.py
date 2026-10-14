"""Живой сбор одного поставщика: очередь задач поверх `python -m pipeline.one`.

Конвейер запускается отдельным процессом — тот же код и те же стадии, что в командной строке. Память освобождается
после каждого сбора, падение сбора не роняет сервер. Сборы идут по одному: на тарифе 512 МБ два сразу не поместятся.
Задачи живут в памяти: перезапуск сервера их теряет, карточка при этом остаётся в кэше раскладки.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from pipeline.config import REPO, load_categories
from pipeline.extract import digits, inn_valid

from . import budget, quota

RUN_BUDGET_RUB = 2.0          # потолок модели на один сбор; обычный сбор — 0,3–0,6 ₽
JOB_TIMEOUT_SEC = 300
MAX_WAITING = 3
KEEP_JOBS = 50

_jobs: dict[str, dict] = {}
_queue: deque[str] = deque()
_lock = threading.Lock()
_wake = threading.Event()
_worker: threading.Thread | None = None

_FAKE_IP = ipaddress.ip_network("198.18.0.0/15")
_STEP = re.compile(r"^\[\+(\d+):(\d\d)\] (.*?)(?: · потрачено [\d.,]+ ₽)?$")
_SPENT = re.compile(r"расход за запуск ([\d.]+) ₽")


class Rejected(ValueError):
    """Запрос не принят: неверный ввод, очередь полна или дневной потолок исчерпан."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _public(host: str) -> bool:
    """Адрес сайта ведёт в интернет, а не во внутреннюю сеть сервера. Редиректы на внутренние адреса этим не ловятся."""
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(host.encode("idna").decode(), 443)}
    except (OSError, UnicodeError):
        return False
    ips = [ipaddress.ip_address(a.split("%")[0]) for a in addrs]
    # 198.18.0.0/15 — подменные адреса VPN-клиента на машине разработчика (fake-IP), во внутреннюю сеть не ведут
    return bool(ips) and all(ip.is_global or ip in _FAKE_IP for ip in ips)


def _validate(site: str | None, inn: str | None, category: str | None) -> tuple[str | None, str | None, str | None]:
    site = (site or "").strip() or None
    inn = digits(inn) if inn else None
    cats = {c["id"] for c in load_categories()["categories"]}
    if not site and not inn:
        raise Rejected("Нужен адрес сайта или ИНН.")
    if site:
        host = re.sub(r"^https?://", "", site, flags=re.I).split("/")[0].split(":")[0].lower()
        if not re.fullmatch(r"[a-z0-9а-яё.-]+\.[a-zа-яё][a-zа-яё0-9-]+", host) or not _public(host):
            raise Rejected("Не похоже на адрес сайта.")
    if inn and not inn_valid(inn):
        raise Rejected("ИНН: неверная длина или контрольная сумма.")
    if category and category not in cats:
        raise Rejected("Неизвестная категория.")
    if not site and not category:
        raise Rejected("Для поиска только по ИНН выберите категорию: без сайта её не определить.")
    return site, inn, category


def submit(site: str | None, inn: str | None, category: str | None) -> dict:
    site, inn, category = _validate(site, inn, category)
    if budget.left_today_rub() < RUN_BUDGET_RUB:
        raise Rejected("Дневной лимит живого сбора исчерпан — попробуйте завтра. Собранный набор работает как обычно.")
    with _lock:
        if len(_queue) >= MAX_WAITING:
            raise Rejected("Сейчас собираются другие карточки. Попробуйте через пару минут.")
        quota.take("collect")
        jid = uuid.uuid4().hex[:12]
        _jobs[jid] = {"id": jid, "state": "queued", "input": {"site": site, "inn": inn, "category": category},
                      "created_at": _now(), "steps": [], "card": None, "error": None, "spent_rub": None}
        _queue.append(jid)
        _trim()
        _ensure_worker()
    _wake.set()
    return view(jid)


def view(jid: str) -> dict | None:
    with _lock:
        job = _jobs.get(jid)
        if not job:
            return None
        out = dict(job, steps=list(job["steps"]))
        if jid in _queue:
            out["position"] = list(_queue).index(jid) + 1
        return out


def _trim():
    done = [j for j in _jobs.values() if j["state"] in ("done", "error")]
    for j in sorted(done, key=lambda j: j["created_at"])[:max(len(done) - KEEP_JOBS, 0)]:
        _jobs.pop(j["id"], None)


def _ensure_worker():
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_loop, daemon=True)
        _worker.start()


def _loop():
    while True:
        with _lock:                              # статус меняется вместе с выходом из очереди — иначе view() видит «в очереди» без места в ней
            jid = _queue.popleft() if _queue else None
            if jid:
                _jobs[jid].update(state="running", started_at=_now())
        if jid is None:
            _wake.wait(30)
            _wake.clear()
            continue
        _run(jid)


def _run(jid: str):
    job = _jobs[jid]
    inp = job["input"]
    args = [sys.executable, "-m", "pipeline.one", "--budget-rub", str(RUN_BUDGET_RUB)]
    if inp["site"]:
        args += ["--site", inp["site"]]
    if inp["inn"]:
        args += ["--inn", inp["inn"]]
    if inp["category"]:
        args += ["--category", inp["category"]]
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(args, cwd=REPO, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    timer = threading.Timer(JOB_TIMEOUT_SEC, proc.kill)
    timer.start()
    card_path, tail = None, deque(maxlen=5)
    try:
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            tail.append(line)
            m = _STEP.match(line)
            if m:
                with _lock:
                    job["steps"].append({"t": int(m[1]) * 60 + int(m[2]), "text": m[3]})
                spent = _SPENT.search(line)
                if spent:
                    job["spent_rub"] = float(spent[1])
            elif line.startswith("→ "):
                card_path = Path(line[2:].strip())
        proc.wait()
    finally:
        timer.cancel()
    with _lock:
        job["finished_at"] = _now()
        if proc.returncode == 0 and card_path and card_path.exists():
            job["card"] = json.loads(card_path.read_text(encoding="utf-8"))
            job["state"] = "done"
        else:
            killed = proc.returncode in (-9, 137) or proc.returncode is None
            job["error"] = (f"Сбор не уложился в {JOB_TIMEOUT_SEC // 60} минут и остановлен." if killed
                            else (tail[-1] if tail else f"Конвейер завершился с кодом {proc.returncode}."))
            job["state"] = "error"
