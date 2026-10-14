"""Проверка источников с того места, где запущен сервер: отвечают ли реестры, сайты поставщиков и модель.

Реестры — тем же кодом, что у конвейера (pipeline.registries), без кэша. Сайты — тем же User-Agent, что у конвейера.
Модель — без ключа: важен сам ответ сервера Kie, платных вызовов здесь нет.
"""
from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import httpx

from pipeline.config import USER_AGENT
from pipeline.kie import Kie
from pipeline.registries import Registries

INNS = ["7726410031", "6658460512"]      # два ООО из набора
SITES = ["gfc-russia.ru", "gurman-llc.ru", "ekat.grossfood.ru", "po-karton.com", "parusekb.ru", "sushi-lover.ru",
         "arosa.ru", "ekaterinburg.upakoff.biz", "food-face.ru", "izumifood.ru", "nevafood.ru", "plastikko.ru",
         "sakkuram.ru", "tara174.ru", "upak-komplekt.ru", "yakimal.com", "atlant-group.info", "tamaki.ru"]
TTL = 600                                 # не чаще раза в 10 минут: реестры и сайты лишний раз не дёргаем

_state: dict = {"state": "idle"}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _timed(fn):
    t = time.time()
    try:
        res = fn()
        return {"ok": True, "found": res is not None and res != {"found": False}, "sec": round(time.time() - t, 1)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:120]}", "sec": round(time.time() - t, 1)}


def _site(host: str) -> dict:
    t = time.time()
    try:
        r = httpx.get(f"https://{host}/", headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(30, connect=15),
                      follow_redirects=True)
        return {"host": host, "ok": r.status_code == 200 and len(r.content) > 2000, "http": r.status_code,
                "kb": len(r.content) // 1024, "sec": round(time.time() - t, 1)}
    except Exception as e:
        return {"host": host, "ok": False, "error": type(e).__name__, "sec": round(time.time() - t, 1)}


def _http(url: str) -> dict:
    t = time.time()
    try:
        r = httpx.get(url, timeout=httpx.Timeout(40, connect=15))
        return {"ok": True, "http": r.status_code, "sec": round(time.time() - t, 1)}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__, "sec": round(time.time() - t, 1)}


def _kie_key() -> dict:
    """Принимает ли Kie ключ сервера: чтение баланса бесплатное. Сумму наружу не отдаём — только да/нет."""
    if not os.environ.get("KIE_API_KEY"):
        return {"ok": False, "error": "переменной KIE_API_KEY на сервере нет"}
    t = time.time()
    try:
        Kie(budget_rub=0).balance()
        return {"ok": True, "sec": round(time.time() - t, 1)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:120]}", "sec": round(time.time() - t, 1)}


def _run():
    out: dict = {}
    try:
        geo = httpx.get("https://ipinfo.io/json", timeout=15).json()
        out["egress"] = {"country": geo.get("country"), "org": geo.get("org")}      # сам IP не показываем
    except Exception as e:
        out["egress"] = {"error": type(e).__name__}

    regs = Registries()
    reg: dict = {}
    for inn in INNS:
        reg[inn] = {
            "pb": _timed(lambda: regs._pb(inn)),
            "bo": _timed(lambda: regs._bo(inn)),
            "fsa": _timed(lambda: regs._fsa(inn)),
            "crpt": _timed(lambda: regs._crpt(inn)),
            "fedresurs": _timed(lambda: regs._fedresurs(inn)),
        }
        time.sleep(3)
    out["registries"] = reg

    with ThreadPoolExecutor(6) as ex:
        sites = list(ex.map(_site, SITES))
    out["sites"] = {"ok": sum(s["ok"] for s in sites), "total": len(sites), "items": sites}

    out["kie"] = _http("https://api.kie.ai/")                    # без ключа: любой HTTP-ответ = сервер доступен
    out["kie_key"] = _kie_key()
    out["jina"] = _http("https://r.jina.ai/https://tamaki.ru/")
    return out


def _worker():
    try:
        res = _run()
        with _lock:
            _state.update(state="done", finished_at=_now(), result=res)
    except Exception as e:
        with _lock:
            _state.update(state="error", finished_at=_now(), error=f"{type(e).__name__}: {e}")


def status() -> dict:
    """Текущий результат; если его нет или он старше TTL — запускает новую проверку в фоне."""
    with _lock:
        stale = _state.get("state") in ("idle", "error") or (
            _state.get("state") == "done" and time.time() - _state.get("_t", 0) > TTL)
        if stale:
            _state.clear()
            _state.update(state="running", started_at=_now(), _t=time.time())
            threading.Thread(target=_worker, daemon=True).start()
        return {k: v for k, v in _state.items() if not k.startswith("_")}
