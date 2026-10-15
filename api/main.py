"""Серверная часть: живой сбор, помощник, отзывы. Интерфейс — статика на GitHub Pages, сюда он ходит по HTTPS.

Запуск локально: .venv\\Scripts\\python -m uvicorn api.main:app --port 8000
На Amvera постоянный диск — /data: туда уходят кэш конвейера (журнал расхода, реестры, раскладки) и база отзывов.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pipeline.config import CACHE, REPO

from . import assistant, budget, jobs, limits, probe, quota, reviews

# 5174 — второй dev-сервер (ветка server), когда 5173 занят основной копией
ORIGINS = os.environ.get("ALLOWED_ORIGINS", "https://afest.github.io,http://localhost:5173,http://127.0.0.1:5173,"
                                            "http://localhost:5174,http://127.0.0.1:5174").split(",")
PERSIST = (Path(os.environ["API_DATA_DIR"]) if os.environ.get("API_DATA_DIR")          # заглушка для проверок — своя папка
           else Path("/data") if os.name == "posix" and Path("/data").is_dir() else REPO / ".data")

# Кэш конвейера — на постоянный диск: журнал расхода переживает перезапуск, и дневной потолок считается честно.
if PERSIST == Path("/data") and not CACHE.exists():
    (PERSIST / "cache").mkdir(parents=True, exist_ok=True)
    CACHE.symlink_to(PERSIST / "cache", target_is_directory=True)
reviews.init(PERSIST)
quota.init(PERSIST)

DAY = 24 * 3600
app = FastAPI(title="supplier-scout api", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


@app.get("/health")
def health():
    """Жив ли сервер и сколько платных действий демо-стенда осталось на сегодня — интерфейс показывает это у кнопок."""
    return {"ok": True, "model_configured": bool(os.environ.get("KIE_API_KEY")), "demo_left": quota.left(),
            "model_left_today_rub": round(budget.left_today_rub(), 2)}


@app.get("/probe")
def get_probe():
    """Отвечают ли источники конвейера с этого сервера. Не чаще раза в 10 минут; первый вызов запускает проверку."""
    return probe.status()


# ---- живой сбор ----
class CollectIn(BaseModel):
    site: str | None = None
    inn: str | None = None
    category: str | None = None


@app.post("/collect", status_code=202)
def collect(body: CollectIn, request: Request):
    limits.check(request, "collect", limit=3, window_sec=DAY)
    try:
        job = jobs.submit(body.site, body.inn, body.category)
    except jobs.Rejected as e:
        raise HTTPException(422, str(e))
    except quota.Exhausted as e:
        raise HTTPException(429, str(e))
    limits.record(request, "collect")
    return job


@app.get("/jobs/{jid}")
def job(jid: str):
    view = jobs.view(jid)
    if view is None:
        raise HTTPException(404, "Задача не найдена — возможно, сервер перезапускался. Запустите сбор ещё раз.")
    return view


# ---- помощник ----
class AssistIn(BaseModel):
    text: str


class Need(BaseModel):
    label: str
    terms: list[str] = []


class MatchIn(BaseModel):
    needs: list[Need]


@app.post("/assist")
def assist(body: AssistIn, request: Request):
    """Шаг 1: описание точки → варианты-кнопки; у каждого — сколько поставщиков в наборе. Один вызов модели.
    Повтор описания отвечает из кэша и лимит адреса не тратит, как и лимит стенда (T-544)."""
    fresh = not assistant.cached(body.text)
    if fresh:
        limits.check(request, "assist", limit=5, window_sec=DAY)
    try:
        out = assistant.suggest(body.text)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except quota.Exhausted as e:
        raise HTTPException(429, str(e))
    except assistant.Unavailable as e:
        raise HTTPException(503, str(e))
    if fresh:
        limits.record(request, "assist")
    return out


@app.post("/assist/match")
def assist_match(body: MatchIn, request: Request):
    """Шаг 2: отмеченные варианты → поставщики из набора. Без модели, бесплатно."""
    limits.check(request, "match", limit=120)
    limits.record(request, "match")
    return assistant.match([n.model_dump() for n in body.needs])


class PlanIn(BaseModel):
    lines: list[str]


@app.post("/assist/plan")
def assist_plan(body: PlanIn, request: Request):
    """План закупа (T-546): названия позиций из файла закупщика → позиции и группы (один вызов модели) → поставщики
    набора по каждой (код). Файл разбирает браузер, сюда приходят только названия. Тратит один запрос помощника из тех же
    лимитов стенда и адреса; повтор того же списка — из кэша."""
    fresh = not assistant.plan_cached(body.lines)
    if fresh:
        limits.check(request, "assist", limit=5, window_sec=DAY)
    try:
        out = assistant.plan(body.lines)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except quota.Exhausted as e:
        raise HTTPException(429, str(e))
    except assistant.Unavailable as e:
        raise HTTPException(503, str(e))
    if fresh:
        limits.record(request, "assist")
    return out


# ---- отзывы ----
class ReviewIn(BaseModel):
    rating: int
    text: str
    author: str | None = None
    website: str | None = None      # поле-ловушка: в интерфейсе скрыто, человек его не заполняет


@app.get("/reviews")
def reviews_summary():
    return reviews.summary()


@app.get("/reviews/{supplier_id}")
def reviews_list(supplier_id: str):
    if not reviews.known(supplier_id):
        raise HTTPException(404, "Такого поставщика нет в наборе.")
    return reviews.list_for(supplier_id)


@app.post("/reviews/{supplier_id}", status_code=201)
def reviews_add(supplier_id: str, body: ReviewIn, request: Request):
    limits.check(request, "reviews", limit=5)
    try:
        out = reviews.add(supplier_id, body.rating, body.text, body.author, body.website, limits.client_ip(request))
    except reviews.Invalid as e:
        raise HTTPException(422, str(e))
    limits.record(request, "reviews")
    return out
