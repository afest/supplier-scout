"""Шаг 5. Проверка по ИНН в государственных реестрах — бесплатно, без ключей.

ФНС «Прозрачный бизнес» (статус, возраст, ОКВЭД, выручка, численность, налоговый режим, флаги),
Росаккредитация (декларации по ИНН заявителя), «Честный знак» (группы маркировки), Федресурс (банкротство).
API этих сайтов недокументированные: ответы кэшируются на неделю, запросы идут по одному с паузой.
"""
from __future__ import annotations

import json
import re
import time
from datetime import date, datetime, timedelta

import httpx

from .config import CACHE, CACHE_TTL_REGISTRY_DAYS

REG_DIR = CACHE / "registries"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}

# Не секрет: общая учётная запись «anonymous», под которой открытый реестр pub.fsa.gov.ru пускает любого посетителя
# без регистрации. Вынесена сюда, чтобы сканер секретов видел пояснение, а не голую строку пароля в запросе.
FSA_ANONYMOUS_LOGIN = {"username": "anonymous", "password": "hrgesf7HDR67Bd"}  # gitleaks:allow

FSA_STATUS = {6: "действует", 16: "действует", 3: "действует", 14: "прекращена", 15: "приостановлена", 19: "приостановлена",
              11: "недействительна", 1: "архивная", 5: "действует", 10: "действует"}
CRPT_GROUPS = {"milk": "Молочная продукция", "seafood": "Морепродукты", "frozen": "Замороженная продукция", "water": "Вода",
               "grocery": "Бакалея", "conserve": "Консервы", "softdrinks": "Безалкогольные напитки", "sweets": "Кондитерские изделия",
               "meat": "Мясная продукция", "vegetableoil": "Растительные масла", "petfood": "Корма для животных",
               "chemistry": "Бытовая химия", "bio": "БАД", "beer": "Пиво", "nabeer": "Безалкогольное пиво"}
OPF = {"12300": "ООО", "50102": "ИП", "12267": "АО", "12247": "АО", "12200": "АО"}


class Captcha(RuntimeError):
    """Реестр попросил капчу — не обходим: запрос не кэшируется и повторяется в следующем прогоне."""


class Registries:
    PAUSE = {"pb": 5.0}                          # ФНС включает капчу при частых запросах

    def __init__(self, pause: float = 1.0, refresh: set[str] | None = None):
        self.refresh = refresh or set()          # источники, которые перезапросить, не глядя в кэш
        self.http = httpx.Client(trust_env=False, timeout=httpx.Timeout(40, connect=15), headers=UA, follow_redirects=True)
        self.pause = pause
        self._fsa_token = None
        self.blocked: dict[str, str] = {}         # источник → причина, по которой он выключен до конца прогона

    # ---- кэш ----
    def _cached(self, source: str, inn: str, fn):
        path = REG_DIR / source / f"{inn}.json"
        if path.exists() and source not in self.refresh:
            rec = json.loads(path.read_text(encoding="utf-8"))
            fresh = datetime.fromisoformat(rec["fetched_at"]) > datetime.now() - timedelta(days=CACHE_TTL_REGISTRY_DAYS)
            if fresh and not rec.get("error"):          # ошибку из прошлого прогона пробуем снова
                return rec
        if source in self.blocked:
            return {"fetched_at": datetime.now().isoformat(timespec="seconds"), "data": None, "error": self.blocked[source]}
        try:
            data, err = fn(inn), None
        except Captcha as e:
            self.blocked[source] = str(e)
            return {"fetched_at": datetime.now().isoformat(timespec="seconds"), "data": None, "error": str(e)}
        except Exception as e:      # реестр недоступен — поле останется «не найдено» с причиной
            data, err = None, f"{type(e).__name__}: {str(e)[:150]}"
        rec = {"fetched_at": datetime.now().isoformat(timespec="seconds"), "data": data, "error": err}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        time.sleep(self.PAUSE.get(source, self.pause))
        return rec

    def _poll(self, url: str, data: dict, tries: int = 12) -> dict:
        for _ in range(tries):
            time.sleep(1)
            r = self.http.post(url, data=data, headers={"X-Requested-With": "XMLHttpRequest"})
            try:
                j = r.json()
            except ValueError:
                continue
            if isinstance(j, dict) and j and "id" not in j:
                return j
        raise TimeoutError("ФНС не вернула ответ")

    # ---- ФНС «Прозрачный бизнес» ----
    def _pb_task(self, url: str, data: dict, what: str) -> dict:
        """Запрос, ответ на который — id задачи ФНС. Без id ФНС отвечает и без капчи, при частых запросах подряд: в пересборке
        14.10 у Food-Face это падало как KeyError 'id'. Один повтор после паузы, потом понятная причина вместо KeyError."""
        j: object = None
        for attempt in range(2):
            try:
                j = self.http.post(url, headers={"X-Requested-With": "XMLHttpRequest"}, data=data).json()
            except ValueError:
                j = None
            if isinstance(j, dict) and (j.get("captchaRequired") or "captcha" in str(j.get("ERRORS", "")).lower()):
                raise Captcha("ФНС «Прозрачный бизнес» попросила капчу — проверка отложена до следующего прогона")
            if isinstance(j, dict) and j.get("id"):
                return j
            if attempt == 0:
                time.sleep(self.PAUSE["pb"])
        raise RuntimeError(f"ФНС не приняла запрос ({what}), ответ без id: {str(j)[:120]}")

    def _pb(self, inn: str) -> dict | None:
        j = self._pb_task("https://pb.nalog.ru/search-proc.json",
                          {"mode": "search-all", "queryAll": inn, "page": "1", "pageSize": "10", "pbCaptchaToken": "", "token": ""}, "поиск")
        res = self._poll("https://pb.nalog.ru/search-proc.json", {"id": j["id"], "method": "get-response"})
        rows = [x for x in ((res.get("ul") or {}).get("data") or []) + ((res.get("ip") or {}).get("data") or []) if x.get("inn") == inn]
        if not rows:
            return None
        row = rows[0]
        r2 = self._pb_task("https://pb.nalog.ru/company-proc.json", {"token": row["token"], "method": "get-request"}, "карточка")
        card = self._poll("https://pb.nalog.ru/company-proc.json", {"token": r2.get("token", row["token"]), "id": r2["id"], "method": "get-response"})
        return {"row": {k: row.get(k) for k in ("namec", "namep", "okved2main", "okved2mainname", "sulst_name_ex", "pr_liq", "dtogrn", "dtreg", "okopf12", "regionname", "invalid")},
                "card": card}

    def pb(self, inn: str) -> dict:
        return self._cached("pb", inn, self._pb)

    # ---- ФНС, бухотчётность (ГИР БО): запасной путь без капчи для юрлиц ----
    def _bo(self, inn: str) -> dict | None:
        r = self.http.get("https://bo.nalog.gov.ru/advanced-search/organizations/search", params={"query": inn, "page": 0})
        rows = [x for x in r.json().get("content", []) if re.sub(r"\D", "", x.get("inn") or "") == inn]
        if not rows:
            return None
        oid = rows[0]["id"]
        card = self.http.get(f"https://bo.nalog.gov.ru/nbo/organizations/{oid}").json()
        bfo = self.http.get(f"https://bo.nalog.gov.ru/nbo/organizations/{oid}/bfo/").json()
        return {"id": oid, "card": {k: card.get(k) for k in ("shortName", "fullName", "statusCode", "statusDate", "registrationDate",
                                                             "okved2", "okopf", "region", "city", "street", "house", "index")},
                "bfo": [{"period": b.get("period"), "gainSum": b.get("gainSum")} for b in (bfo if isinstance(bfo, list) else [])]}

    def bo(self, inn: str) -> dict:
        return self._cached("bo", inn, self._bo)

    # ---- Росаккредитация: декларации по ИНН заявителя ----
    def _fsa_login(self):
        r = self.http.post("https://pub.fsa.gov.ru/login", json=FSA_ANONYMOUS_LOGIN)
        self._fsa_token = r.headers.get("Authorization")
        if not self._fsa_token:
            raise RuntimeError(f"анонимный вход ФСА: HTTP {r.status_code}")

    def _fsa(self, inn: str) -> dict:
        if not self._fsa_token:
            self._fsa_login()
        # Фильтр — только columnsSearch: с пустыми полями фильтра сайт молча отдаёт свежие декларации всех заявителей.
        body = {"size": 50, "page": 0, "filter": {"columnsSearch": [{"name": "applicantInn", "search": inn, "type": 0}]},
                "columnsSort": [{"column": "declDate", "sort": "DESC"}]}
        r = self.http.post("https://pub.fsa.gov.ru/api/v1/rds/common/declarations/get", json=body,
                           headers={"Authorization": self._fsa_token, "Content-Type": "application/json"})
        if r.status_code == 401:
            self._fsa_login()
            r = self.http.post("https://pub.fsa.gov.ru/api/v1/rds/common/declarations/get", json=body,
                               headers={"Authorization": self._fsa_token, "Content-Type": "application/json"})
        j = r.json()
        items = []
        for it in j.get("items", []):
            if str(it.get("applicantInn")) != inn:       # фильтр ФСА иногда молча не срабатывает — проверяем сами
                continue
            items.append({"id": it.get("id"), "number": it.get("number"), "status_id": it.get("idStatus"),
                          "decl_date": it.get("declDate"), "end_date": it.get("declEndDate"),
                          "product": (it.get("productFullName") or "")[:300], "applicant": it.get("applicantName")})
        return {"total": j.get("total"), "items": items}

    def fsa(self, inn: str) -> dict:
        return self._cached("fsa", inn, self._fsa)

    # ---- «Честный знак»: участник оборота и товарные группы ----
    def _crpt(self, inn: str) -> dict | None:
        r = self.http.get("https://markirovka.crpt.ru/api/v3/true-api/participants", params={"inns": inn})
        rows = r.json()
        row = next((x for x in rows if x.get("inn") == inn), None) if isinstance(rows, list) else None
        return row

    def crpt(self, inn: str) -> dict:
        return self._cached("crpt", inn, self._crpt)

    # ---- Федресурс: банкротство ----
    def _fedresurs(self, inn: str) -> dict:
        h = {"Referer": "https://fedresurs.ru/"}
        r = self.http.get("https://fedresurs.ru/backend/companies", params={"limit": 15, "offset": 0, "searchString": inn, "isActive": "true"}, headers=h)
        rows = [x for x in r.json().get("pageData", []) if x.get("inn") == inn]
        if not rows:
            r = self.http.get("https://fedresurs.ru/backend/persons", params={"limit": 15, "offset": 0, "searchString": inn, "isActive": "true"}, headers=h)
            rows = [x for x in (r.json().get("pageData", []) if r.status_code == 200 else []) if x.get("inn") == inn]
            kind = "persons"
        else:
            kind = "companies"
        if not rows:
            return {"found": False}
        guid = rows[0]["guid"]
        b = self.http.get(f"https://fedresurs.ru/backend/{kind}/{guid}/bankruptcy", headers=h).json()
        cases = (b.get("legalCases") or []) + (b.get("withoutLegalCases") or [])
        return {"found": True, "status": rows[0].get("status"), "bankruptcy_cases": len(cases), "intention": len(b.get("intentionMessages") or [])}

    def fedresurs(self, inn: str) -> dict:
        return self._cached("fedresurs", inn, self._fedresurs)


# ---------- разбор в поля контракта ----------

def company_from_pb(pb: dict, fed: dict | None, okved_prefixes: list[str]) -> dict | None:
    if not pb or not pb.get("data"):
        return None
    row, card = pb["data"]["row"], pb["data"]["card"]
    v = card.get("vyp", {})
    status_txt = (row.get("sulst_name_ex") or v.get("sulst_name_ex") or "").lower()
    if card.get("liquidated"):
        status = "liquidated"
    elif "ликвид" in status_txt or "прекращ" in status_txt:
        status = "liquidating"
    else:
        status = "active"
    if fed and fed.get("data") and fed["data"].get("bankruptcy_cases"):
        status = "bankrupt"
    okved = v.get("КодОКВЭД") or row.get("okved2main") or ""
    flags = []
    if float(v.get("invalid") or row.get("invalid") or 0):
        flags.append("недостоверные сведения")
    if card.get("masaddress"):
        flags.append("массовый адрес")
    arrears = sorted(card.get("arrear") or [], key=lambda a: (a.get("yearcode", 0), a.get("periodcode", 0)), reverse=True)
    if arrears and not arrears[0].get("empty"):
        flags.append("недоимка по налогам")
    if float(v.get("pr_otch") or 0):
        flags.append("не сдаёт отчётность")
    revenue = [{"year": int(f["yearcode"]), "mln": round(f["revenue"] / 1e6)} for f in card.get("form1") or []
               if not f.get("empty") and f.get("revenue") is not None]
    staff = next((int(s["sschr"]) for s in sorted(card.get("sschr") or [], key=lambda s: -s.get("yearcode", 0)) if s.get("sschr") is not None), None)
    name = v.get("НаимЮЛСокр") or row.get("namec") or ""
    form = OPF.get(str(row.get("okopf12") or v.get("okopf12") or "").split(".")[0])
    if not form:
        form = "ИП" if len(v.get("ИНН", "") or "") == 12 else "АО" if "АО" in name.split()[:1] else "ООО"
    reg = v.get("ДатаОГРН") or row.get("dtogrn") or ""
    if reg and "." in reg:
        d, m, y = reg.split(".")
        reg = f"{y}-{m}-{d}"
    return {
        "legal_name": " ".join(name.split()),
        "address": v.get("АдресРФ"),
        "region": row.get("regionname"),
        "company": {"form": form, "status": status, "registered_at": reg, "okved_main": okved,
                    "okved_title": v.get("НаимОКВЭД") or row.get("okved2mainname") or "",
                    "okved_match": any(okved.startswith(p) for p in okved_prefixes),
                    "revenue": sorted(revenue, key=lambda r: r["year"])[-3:], "staff": staff, "flags": flags},
        "tax_regime": ("usn" if float(v.get("usn") or 0) or float(v.get("ausn") or 0) else
                       "general" if not float(v.get("hastaxmode") or 0) else None),
    }


def company_from_bo(bo: dict, fed: dict | None, okved_prefixes: list[str], why_no_flags: str) -> dict | None:
    """Карточка компании из бухотчётности ФНС, когда «Прозрачный бизнес» недоступен: флагов и налогового режима там нет."""
    if not bo or not bo.get("data"):
        return None
    card = bo["data"]["card"]
    code = (card.get("statusCode") or "").upper()
    status = ("bankrupt" if "BANKRUPT" in code else "liquidated" if code in ("LIQUIDATED", "INACTIVE", "TERMINATED")
              else "liquidating" if "LIQUIDAT" in code or "REORGANIZ" in code else "active")
    if fed and fed.get("data") and fed["data"].get("bankruptcy_cases"):
        status = "bankrupt"
    okved = (card.get("okved2") or {}).get("id") or ""
    opf = str((card.get("okopf") or {}).get("id") or "")
    revenue = sorted(({"year": int(b["period"]), "mln": round(b["gainSum"] / 1000)} for b in bo["data"]["bfo"]
                      if b.get("period") and b.get("gainSum") is not None), key=lambda r: r["year"])[-3:]
    addr = ", ".join(x for x in (card.get("index"), card.get("region"), card.get("city"), card.get("street"), card.get("house")) if x)
    return {
        "legal_name": " ".join((card.get("shortName") or "").split()),
        "address": addr or None,
        "region": card.get("region"),
        "company": {"form": OPF.get(opf, "ООО"), "status": status, "registered_at": card.get("registrationDate") or "",
                    "okved_main": okved, "okved_title": (card.get("okved2") or {}).get("name") or "",
                    "okved_match": any(okved.startswith(p) for p in okved_prefixes),
                    "revenue": revenue, "staff": None, "flags": [f"не проверены — {why_no_flags}"]},
        "tax_regime": None,
    }


def declarations_from_fsa(fsa: dict, limit: int = 8) -> list[dict] | None:
    if not fsa or fsa.get("data") is None:
        return None
    out = []
    today = date.today().isoformat()
    for it in fsa["data"]["items"]:
        st = FSA_STATUS.get(it["status_id"], "прекращена")
        if st == "действует" and it.get("end_date") and it["end_date"][:10] < today:
            st = "прекращена"
        if st not in ("действует", "прекращена"):
            st = "прекращена"
        out.append({"number": it["number"], "status": st, "product": it["product"], "valid_to": (it.get("end_date") or "")[:10],
                    "url": f"https://pub.fsa.gov.ru/rds/declaration/view/{it['id']}/common"})
    out.sort(key=lambda d: (d["status"] != "действует", -int(d["valid_to"].replace("-", "") or 0)))
    return out[:limit]


def marking_from_crpt(crpt: dict) -> list[str] | None:
    if not crpt or crpt.get("error"):
        return None
    row = crpt.get("data")
    if not row or not row.get("is_registered"):
        return []
    return [CRPT_GROUPS[g] for g in row.get("productGroups") or [] if g in CRPT_GROUPS]
