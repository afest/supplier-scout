"""Копия набора для сервера без ИП (их узнаём по 12-значному ИНН): пока ПДн ИП не вычищены из набора (T-535).

python scripts/server_set.py <data/suppliers.json> <куда записать>
"""
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    d = json.load(f)
before = len(d["suppliers"])
d["suppliers"] = [s for s in d["suppliers"] if len(str((s.get("inn") or {}).get("value") or "")) != 12]
with open(dst, "w", encoding="utf-8", newline="\n") as f:
    json.dump(d, f, ensure_ascii=False, indent=1)
print(f"набор для сервера: {len(d['suppliers'])} из {before} поставщиков, без ИП")
