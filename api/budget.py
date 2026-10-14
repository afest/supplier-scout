"""Расход на модель за сутки — по журналу Kie, который ведёт конвейер (pipeline/.cache/spend.jsonl).

Дневной потолок общий для живого сбора и помощника: сверх него новые вызовы модели не уходят.
"""
from __future__ import annotations

import json
import os
from datetime import date

from pipeline.config import RUB_PER_CREDIT
from pipeline.kie import LEDGER

DAILY_LIMIT_RUB = float(os.environ.get("DAILY_LIMIT_RUB", "10"))     # страховка поверх лимита действий (quota.py)


def spent_today_rub() -> float:
    if not LEDGER.exists():
        return 0.0
    today = date.today().isoformat()
    total = 0.0
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            if str(rec.get("ts", "")).startswith(today):
                total += rec.get("credits") or 0
    return total * RUB_PER_CREDIT


def left_today_rub() -> float:
    return max(DAILY_LIMIT_RUB - spent_today_rub(), 0.0)
