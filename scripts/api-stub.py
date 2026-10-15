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

from api import assistant, budget, jobs  # noqa: E402

# заглушка не тратит, поэтому и дневной потолок не смотрит в журнал Kie этой копии: там расход пересборок конвейера
budget.spent_today_rub = lambda: 0.0

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
# Описание, на которое модель задаёт уточняющий вопрос (T-544): вопрос, варианты ответа и варианты закупки приходят вместе.
# После ответа — уточнённые варианты; на ответ «Ещё не решили» заглушка, как непослушная модель, спрашивает ещё раз —
# интерфейс должен показать второй вопрос текстом, без кнопок.
DONUT_NEEDS = [
    {"label": "Стаканы", "why": "кофе к пончикам", "terms": ["стаканы бумажные", "стаканы для кофе"]},
    {"label": "Пакеты", "why": "пончики с собой", "terms": ["пакеты бумажные", "пакет крафт"]},
    {"label": "Сахарная пудра", "why": "посыпка", "terms": ["сахарная пудра", "сахар пудра"]},
]
QUESTION = {"place": "пончиковая", "question": "Пончики жарите на месте или привозите готовыми?",
            "answers": ["Жарим на месте", "Привозим готовыми", "Вариант ответа длиннее тридцати знаков", "жарим на месте"],
            "needs": DONUT_NEEDS}
FRY = {"place": "пончиковая с фритюром", "question": None, "answers": [],
       "needs": DONUT_NEEDS + [{"label": "Масло фритюрное", "why": "жарка пончиков", "terms": ["масло фритюрное", "масло подсолнечное"]},
                               {"label": "Мука", "why": "тесто", "terms": ["мука пшеничная"]}]}
READY = {"place": "пончиковая без кухни", "question": None, "answers": [], "needs": DONUT_NEEDS}
SEEN: list[str] = []          # что пришло модели — для проверки склейки и обрезки на сервере


def fake_model(text: str) -> dict:
    SEEN.append(text)
    t = text.lower()
    if "пончик" not in t:
        return ANSWER
    if "уточнение:" not in t:
        return QUESTION
    if "не решили" in t:
        return dict(FRY, question="А кофе тоже будет?", answers=["Да", "Нет"])
    return FRY if "жарим" in t else READY


assistant._ask_model = fake_model

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

from api.main import app  # noqa: E402


@app.get("/_stub/seen")
def stub_seen():
    """Только у заглушки: тексты, которые дошли до модели, — проверка склейки и серверной обрезки."""
    return {"texts": SEEN}

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"stub api on http://127.0.0.1:{port} · data {os.environ['API_DATA_DIR']}", flush=True)
    uvicorn.run("api.main:app", host="127.0.0.1", port=port, log_level="warning")
