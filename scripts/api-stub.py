"""Сервер для проверок интерфейса без трат: тот же код api/, но модель и конвейер подменены.

Помощник отвечает записанным ответом модели (подбор поставщиков при этом настоящий — кодом по набору), живой сбор
проигрывает шаги и отдаёт карточку примера из набора. Отзывы, лимиты и счётчики — настоящие, в отдельной временной папке.
Запуск: python scripts/api-stub.py [порт]   (из корня репозитория; по умолчанию 8765)
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("API_DATA_DIR", tempfile.mkdtemp(prefix="supplier-scout-stub-"))
os.environ["ALLOWED_ORIGINS"] = "*"

import uvicorn  # noqa: E402

from api import assistant, jobs  # noqa: E402

ANSWER = {
    "place": "бабл-ти в торговом центре",
    "question": None,
    "needs": [
        {"label": "Молоко и сливки", "why": "для молочного чая", "terms": ["молоко 3,2%", "сливки 10%", "молоко сгущенное"]},
        {"label": "Чай", "why": "основа напитков", "terms": ["чай черный", "чай зеленый", "чай улун"]},
        {"label": "Тапиока", "why": "шарики в напитки", "terms": ["тапиока жемчуг", "шарики тапиоки", "поппинг боба"]},
        {"label": "Стаканы", "why": "тара под напитки", "terms": ["стаканы с купольной крышкой", "стаканы пластиковые 500 мл"]},
        {"label": "Трубочки", "why": "широкие под тапиоку", "terms": ["трубочки широкие", "трубочки для бабл ти"]},
        {"label": "Сиропы", "why": "вкусы", "terms": ["сироп фруктовый", "сироп карамельный"]},
    ],
}
assistant._ask_model = lambda text: ANSWER

DATA = json.loads((ROOT / "data" / "suppliers.json").read_text(encoding="utf-8"))["suppliers"]
CARD = next(s for s in DATA if s.get("live_only") == "site")
STEPS = ["Старт: сайт", "1/4 Сайт: открываю главную", "2/4 Раскладка по полям моделью, цитаты проверяет код",
         "   страниц 4, полей 13, отброшено цитатами 0", "3/4 Реестры по ИНН", "4/4 Сборка карточки и оценок ◇",
         "Готово: расход за запуск 0.00 ₽"]


def fake_run(jid):
    job = jobs._jobs[jid]
    for i, text in enumerate(STEPS):
        time.sleep(0.4)
        with jobs._lock:
            job["steps"].append({"t": i, "text": text})
    with jobs._lock:
        card = dict(CARD, live_only="inn" if job["input"]["inn"] else "site")
        job.update(card=card, state="done", spent_rub=0.0, finished_at=jobs._now())


jobs._run = fake_run

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"stub api on http://127.0.0.1:{port} · data {os.environ['API_DATA_DIR']}", flush=True)
    uvicorn.run("api.main:app", host="127.0.0.1", port=port, log_level="warning")
