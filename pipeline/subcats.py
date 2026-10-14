"""Подкатегории по ассортименту (T-538): поставщик входит в подкатегорию, если у него есть подходящая позиция —
в ассортименте, в товарах с сайта или в названии раздела каталога. Основная категория не важна: стаканы продаёт
упаковщик, а креветки — и рыбный оптовик, и магазин азиатской бакалеи.

Правила — в data/categories.json, у каждой подкатегории: include — хоть один регэксп совпал с названием позиции;
exclude — ни один не совпал (ложные: «сметана в стакане», «вафельный стаканчик»); exclude_group — то же по разделу
каталога, где лежит позиция («Сливки» в разделе «Бакалея» — сухие). Модель не нужна, пересборка из кэша бесплатна.
Старый список search_subcategories — план сбора (поисковые запросы, перечень для модели), здесь не участвует.
"""
from __future__ import annotations

import re
from functools import lru_cache

from .config import load_categories

BASIS_MAX = 5       # позиций-оснований на подкатегорию в карточке


def norm(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").lower().replace("ё", "е")).strip()


def compile_rules(categories: list[dict]) -> list[tuple[str, list, list, list]]:
    return [(s["id"], [re.compile(x) for x in s["include"]], [re.compile(x) for x in s.get("exclude", [])],
             [re.compile(x) for x in s.get("exclude_group", [])])
            for c in categories for s in c["subcategories"]]


@lru_cache(maxsize=1)
def _rules():
    return compile_rules(load_categories()["categories"])


def entries(sup: dict) -> list[tuple[str, str, str]]:
    """(как показать основание, текст для правил, раздел каталога). Порядок — он же порядок оснований в карточке:
    позиции ассортимента, товары с сайта, разделы каталога."""
    items = ((sup.get("assortment") or {}).get("value") or {}).get("items") or []
    out = [(it["name"], norm(it["name"]), norm(it.get("group"))) for it in items]
    out += [(p, norm(p), "") for p in ((sup.get("products") or {}).get("value") or [])]
    out += [(f"раздел «{g}»", norm(g), "") for g in dict.fromkeys(it.get("group") for it in items if it.get("group"))]
    return out


def assign(sup: dict, rules=None) -> tuple[list[str], dict[str, list[str]]]:
    """→ (id подкатегорий из любых категорий, {id: позиции-основания})"""
    ents = entries(sup)
    ids, basis = [], {}
    for sid, inc, exc, gexc in rules if rules is not None else _rules():
        hit = [label for label, text, group in ents
               if any(r.search(text) for r in inc) and not any(r.search(text) for r in exc) and not any(r.search(group) for r in gexc)]
        if hit:
            ids.append(sid)
            basis[sid] = list(dict.fromkeys(hit))[:BASIS_MAX]
    return ids, basis
