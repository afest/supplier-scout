"""Kie.ai: Claude (раскладка по полям) и Gemini с поиском Google (кандидаты).

Каждый вызов пишется в журнал расхода; при достижении потолка новые вызовы не уходят.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path

import httpx

from . import keys
from .config import CACHE, CLAUDE_MODEL, GEMINI_MODEL, RUB_PER_CREDIT

BASE = "https://api.kie.ai"
LEDGER = CACHE / "spend.jsonl"
_LOCK = threading.Lock()


class BudgetExceeded(RuntimeError):
    pass


class KieError(RuntimeError):
    pass


def spent_credits() -> float:
    if not LEDGER.exists():
        return 0.0
    return sum(json.loads(l).get("credits", 0) or 0 for l in LEDGER.read_text(encoding="utf-8").splitlines() if l.strip())


def spent_rub() -> float:
    return spent_credits() * RUB_PER_CREDIT


class Kie:
    def __init__(self, budget_rub: float, reserve_rub: float = 1.0):
        self.budget_rub = budget_rub
        self.reserve_rub = reserve_rub
        # Kie — напрямую, мимо системного прокси: через VPN соединение рвётся (канон AI content generation).
        self.http = httpx.Client(trust_env=False, timeout=httpx.Timeout(180, connect=20),
                                 headers={"Authorization": f"Bearer {keys.get('KIE_API_KEY')}"})
        self.run_credits = 0.0

    # ---- учёт ----
    def _guard(self):
        if spent_rub() + self.reserve_rub > self.budget_rub:
            raise BudgetExceeded(f"потолок {self.budget_rub:.0f} ₽: уже потрачено {spent_rub():.2f} ₽")

    def _log(self, kind: str, model: str, label: str, credits: float | None, usage: dict):
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        rec = {"ts": datetime.now().isoformat(timespec="seconds"), "kind": kind, "model": model, "label": label,
               "credits": credits, "input_tokens": usage.get("input_tokens") or usage.get("promptTokenCount"),
               "output_tokens": usage.get("output_tokens") or usage.get("candidatesTokenCount"),
               "usage": usage}
        with _LOCK:
            with LEDGER.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self.run_credits += credits or 0

    def balance(self) -> float:
        r = self.http.get(f"{BASE}/api/v1/chat/credit")
        j = r.json()
        if j.get("code") != 200:
            raise KieError(f"баланс: {j}")
        return float(j["data"])

    def _post(self, path: str, body: dict, stream: bool = False) -> httpx.Response:
        for attempt in range(4):
            try:
                r = self.http.post(f"{BASE}{path}", json=body)
            except httpx.TransportError as e:
                if attempt == 3:
                    raise KieError(f"сеть: {e}") from e
                time.sleep(3 * (attempt + 1))
                continue
            if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            return r
        raise KieError("нет ответа")

    # ---- Claude: ответ строго через инструмент с JSON-схемой ----
    def claude_tool(self, prompt: str, tool: dict, label: str, system: str | None = None,
                    max_tokens: int = 4096, model: str = CLAUDE_MODEL) -> dict:
        self._guard()
        body = {"model": model, "messages": [{"role": "user", "content": prompt}], "tools": [tool],
                "tool_choice": {"type": "tool", "name": tool["name"]},
                "thinkingFlag": False, "thinking": {"type": "disabled"}, "stream": False, "max_tokens": max_tokens}
        if system:
            body["system"] = system
        r = self._post("/claude/v1/messages", body)
        try:
            j = r.json()
        except ValueError as e:
            raise KieError(f"Claude: HTTP {r.status_code}, не JSON: {r.text[:300]}") from e
        if "content" not in j:
            raise KieError(f"Claude: {str(j)[:400]}")
        self._log("claude", j.get("model", model), label, j.get("credits_consumed"), j.get("usage", {}))
        for block in j["content"]:
            if block.get("type") == "tool_use" and block.get("name") == tool["name"]:
                return block["input"]
        raise KieError(f"Claude не вызвал инструмент: stop_reason={j.get('stop_reason')}, {str(j['content'])[:300]}")

    # ---- Gemini + поиск Google: текст ответа и источники выдачи ----
    def gemini_search(self, prompt: str, label: str, model: str = GEMINI_MODEL) -> dict:
        self._guard()
        body = {"stream": True, "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "tools": [{"googleSearch": {}}],
                "generationConfig": {"thinkingConfig": {"includeThoughts": False, "thinkingLevel": "low"}}}
        r = self._post(f"/gemini/v1/models/{model}:streamGenerateContent", body, stream=True)
        text, chunks, queries, credits, usage, errors = [], [], [], None, {}, []
        for line in r.text.splitlines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                ev = json.loads(payload)
            except ValueError:
                continue
            if ev.get("code") not in (None, 200):
                errors.append(ev)
            for cand in ev.get("candidates", []):
                for part in (cand.get("content") or {}).get("parts", []):
                    if part.get("text") and not part.get("thought"):
                        text.append(part["text"])
                gm = cand.get("groundingMetadata") or {}
                for ch in gm.get("groundingChunks", []):
                    web = ch.get("web") or {}
                    if web.get("uri"):
                        chunks.append({"uri": web["uri"], "title": web.get("title", "")})
                queries += gm.get("webSearchQueries", [])
            if ev.get("usageMetadata"):
                usage = ev["usageMetadata"]
            if ev.get("credits_consumed") is not None:
                credits = ev["credits_consumed"]
        if not text and not chunks:
            if r.text.strip().startswith("{"):
                errors.append(r.text[:400])
            raise KieError(f"Gemini: пустой ответ, HTTP {r.status_code}: {errors or r.text[:400]}")
        self._log("gemini-search", model, label, credits, usage)
        return {"text": "".join(text), "chunks": chunks, "queries": list(dict.fromkeys(queries)),
                "credits": credits, "usage": usage}
