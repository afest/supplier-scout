"""Шаг 1. Кандидаты: веб-поиск по подкатегориям → ссылки, склеенные по сайту.

Два источника выдачи с одним форматом на выходе:
- `gemini` — Gemini с поиском Google через Kie; ссылки берутся только из источников поиска (groundingChunks),
  текст ответа модели не используется — выдумать сайт она не может;
- `seed` — файл с выдачей поиска, записанной заранее (data/seed/*.json), когда автоматический поиск недоступен.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .config import CACHE, CITY, NOT_SUPPLIER_DOMAINS, QUERY_TEMPLATES, SEARCH_TERMS, load_categories
from .fetch import host_of
from .kie import KieError

OUT = CACHE / "candidates.json"
SEARCH_DIR = CACHE / "search"

GEMINI_PROMPT = (
    "Выполни поиск в Google по запросу: «{query}». Найди компании-поставщики (оптовые компании, производители, "
    "дистрибьюторы), которые продают это ресторанам и кафе в городе {city} или доставляют туда. Не включай агрегаторы, "
    "маркетплейсы, справочники, карты и рестораны. Ответь списком: название компании — сайт."
)


def blocked_reason(host: str) -> str | None:
    for dom, why in sorted(NOT_SUPPLIER_DOMAINS.items(), key=lambda kv: -len(kv[0])):   # market.yandex.ru раньше yandex.ru
        if host == dom or host.endswith("." + dom):
            return why
    if not host.endswith((".ru", ".рф", ".xn--p1ai", ".com", ".info", ".biz", ".net", ".org", ".shop", ".su", ".group", ".pro", ".online", ".store", ".market", ".company")):
        return "домен вне РФ"
    return None


def _add(cands: dict, url: str, title: str, hit: dict):
    host = host_of(url)
    if not host:
        return
    c = cands.setdefault(host, {"host": host, "root": f"{urlparse(url).scheme or 'https'}://{urlparse(url).netloc}/",
                                "urls": [], "titles": [], "categories": Counter(), "subcategories": Counter(),
                                "queries": [], "sources": set(), "blocked": blocked_reason(host)})
    if url not in c["urls"]:
        c["urls"].append(url)
    if title and title not in c["titles"]:
        c["titles"].append(title)
    if hit.get("category"):
        c["categories"][hit["category"]] += 1
    if hit.get("subcategory"):
        c["subcategories"][hit["subcategory"]] += 1
    if hit.get("query") and hit["query"] not in c["queries"]:
        c["queries"].append(hit["query"])
    c["sources"].add(hit["source"])


def from_seed(path: Path, cands: dict, queries: list):
    seed = json.loads(path.read_text(encoding="utf-8"))
    for s in seed["searches"]:
        queries.append({"query": s["query"], "category": s["category"], "subcategory": s.get("subcategory"),
                        "engine": seed["engine"], "date": seed["date"], "results": len(s["results"])})
        for r in s["results"]:
            _add(cands, r["url"], r["title"], {**s, "source": f"search:{seed['date']}"})
    probe = seed.get("probe")
    if probe:
        for r in probe["results"]:
            _add(cands, r["url"], r["title"], {"category": r["category"], "source": f"probe:{probe['date']}"})


def _resolve(uri: str) -> str | None:
    """Ссылка из groundingChunks — переадресация Google; настоящий адрес — в Location."""
    try:
        r = httpx.get(uri, follow_redirects=False, timeout=15)
        return r.headers.get("location") or (uri if r.status_code == 200 else None)
    except httpx.HTTPError:
        return None


def from_gemini(kie, cands: dict, queries: list, log=print):
    cats = load_categories()["categories"]
    for cat in cats:
        for sub in cat["search_subcategories"]:
            for tpl in QUERY_TEMPLATES:
                q = tpl.format(term=SEARCH_TERMS[sub["id"]], city=CITY)
                # оплаченная выдача — на диск сразу: падение на 29-м запросе из 30 не должно оплачивать первые 28 заново
                path = SEARCH_DIR / f"{hashlib.sha1(q.encode()).hexdigest()[:16]}.json"
                if path.exists():
                    res = json.loads(path.read_text(encoding="utf-8"))
                else:
                    try:
                        res = kie.gemini_search(GEMINI_PROMPT.format(query=q, city=CITY), label=f"search:{q}")
                    except KieError as e:
                        queries.append({"query": q, "category": cat["id"], "subcategory": sub["id"], "engine": "Gemini + Google (Kie)",
                                        "google_queries": [], "results": 0, "credits": None, "error": str(e)[:200]})
                        log(f"  поиск «{q}»: ошибка — {str(e)[:120]}")
                        continue
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
                urls = []
                for ch in res["chunks"]:
                    url = _resolve(ch["uri"]) or f"https://{ch['title']}/"
                    urls.append(url)
                    _add(cands, url, ch["title"], {"category": cat["id"], "subcategory": sub["id"], "query": q, "source": "gemini"})
                queries.append({"query": q, "category": cat["id"], "subcategory": sub["id"], "engine": "Gemini + Google (Kie)",
                                "google_queries": res["queries"], "results": len(urls), "credits": res["credits"]})
                log(f"  поиск «{q}»: {len(urls)} ссылок")


def run(provider: str, seed_path: Path | None = None, kie=None, log=print) -> dict:
    cands: dict = {}
    queries: list = []
    if provider == "gemini":
        from_gemini(kie, cands, queries, log)
    else:
        from_seed(seed_path, cands, queries)
    out = []
    for c in cands.values():
        c["categories"] = dict(c["categories"].most_common())
        c["subcategories"] = dict(c["subcategories"].most_common())
        c["sources"] = sorted(c["sources"])
        out.append(c)
    out.sort(key=lambda c: (c["blocked"] is not None, -sum(c["categories"].values()), c["host"]))
    result = {"provider": provider, "seed": str(seed_path.name) if seed_path else None, "queries": queries, "candidates": out}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    links = sum(q["results"] for q in queries)
    log(f"Кандидаты: {len(queries)} запросов, {links} ссылок → {len(out)} сайтов, "
        f"из них сразу отсеяно {sum(1 for c in out if c['blocked'])} (карты, каталоги, маркетплейсы, соцсети)")
    return result
