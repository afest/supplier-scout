"""Сбор логотипов поставщиков с их сайтов (T-542, в репозиторий перенесён в T-543).

Две команды (из корня репозитория; кроме зависимостей конвейера нужен Pillow):
  python scripts/logos/collect.py fetch   — обойти сайты, сложить кандидатов в pipeline/.cache/logos/work/
  python scripts/logos/collect.py build   — применить review.json рядом со скриптом (решения по каждой картинке,
                                            просмотренной глазами), собрать в pipeline/.cache/logos/ папку logos/,
                                            logos.json и обзор.html для просмотра на светлом и тёмном фоне

Правила — как у конвейера: тот же User-Agent, тот же разбор robots.txt (RFC 9309), пауза 1 с на сайт.
Платных сервисов нет, только HTTP к сайтам компаний.

В интерфейс результат перенесён руками (T-541): в web/public/logos/ — только логотипы, которые Павел оставил на ревью
T-542, файл знака (`file`) назван <id>.<расширение>, тяжёлые PNG ужаты до 192 px без перекраски; карта id → файл —
data/logos.json (file, on_dark, source_page, collected_at).
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from html import escape
from pathlib import Path
from urllib.parse import urljoin, urlparse

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

import httpx                                     # noqa: E402
from lxml import etree, html as lxml_html        # noqa: E402
from PIL import Image                            # noqa: E402

from pipeline.config import USER_AGENT           # noqa: E402
from pipeline.fetch import BOT_TOKEN, Robots, _decode, host_of  # noqa: E402

SRC = Path(__file__).resolve().parent            # review.json — ручные решения, в git
HERE = REPO / "pipeline" / ".cache" / "logos"     # кэш кандидатов и сборка — вне git
WORK = HERE / "work"
LOGOS = HERE / "logos"
TODAY = date.today().isoformat()
MAX_BYTES = 3_000_000
MIN_SIDE = 64          # меньше по длинной стороне — фавикон, не берём
ALT_LIMIT = 3          # сколько запасных кандидатов хранить на поставщика

# Логотип задан фоном в таблице стилей: в разметке <img> нет. Адрес найден руками в CSS самого сайта.
MANUAL_CSS = {"plastika": ["https://plastikko.ru/s/logo.png"]}      # /s/s7.css: #logo{background:url(logo.png)}

BAD_NAME = re.compile(r"sprite|banner|slider|slide|placeholder|no-?image|noimage|loader|spinner|1x1|pixel|"
                      r"payment|visa|mastercard|mir\.|sber|yandex-?(?:metrika|pay)|vk-?icon|facebook|telegram|whatsapp",
                      re.I)


class Net:
    def __init__(self):
        self.http = httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30, connect=12),
                                 headers={"User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9"},
                                 verify=True, trust_env=False)
        self.robots: dict[str, Robots] = {}
        self.last: dict[str, float] = {}
        self.lock = threading.Lock()

    def _robots(self, url: str) -> Robots:
        p = urlparse(url)
        key = f"{p.scheme}://{p.netloc}"
        with self.lock:
            if key in self.robots:
                return self.robots[key]
        try:
            r = self.http.get(f"{key}/robots.txt", timeout=12)
            if r.status_code >= 500:
                rb = Robots.disallow_all("robots.txt отвечает ошибкой сервера")
            elif r.status_code == 200 and "text/html" not in r.headers.get("content-type", ""):
                rb = Robots(_decode(r.content, r.headers.get("content-type", "")))
            else:
                rb = Robots("")
        except httpx.HTTPError:
            rb = Robots.disallow_all("robots.txt не открылся")
        with self.lock:
            self.robots[key] = rb
        return rb

    def get(self, url: str):
        """(response|None, ошибка|None). Сначала robots, потом пауза, потом запрос."""
        rb = self._robots(url)
        if not rb.allowed(BOT_TOKEN, url):
            why = getattr(rb, "why", "robots.txt запрещает") if rb.block_all else "robots.txt запрещает"
            return None, f"{why} ({url})"
        host = host_of(url)
        with self.lock:
            wait = self.last.get(host, 0) + max(1.0, min(rb.crawl_delay or 0, 10.0)) - time.time()
            self.last[host] = max(time.time(), self.last.get(host, 0) + 1.0)
        if wait > 0:
            time.sleep(wait)
        err = "нет ответа"
        for attempt in range(3):                      # 5xx и обрывы бывают разовыми — до трёх попыток с паузой
            if attempt:
                time.sleep(4 * attempt)
            try:
                r = self.http.get(url)
            except httpx.HTTPError as e:
                err = f"{type(e).__name__}: {str(e)[:120]}"
                continue
            if r.status_code >= 500:
                err = f"HTTP {r.status_code}"
                continue
            if r.status_code >= 400:
                return None, f"HTTP {r.status_code}"
            return r, None
        return None, err


def site_of(s: dict) -> str:
    w = s.get("website")
    return ((w.get("value") if isinstance(w, dict) else w) or "").strip()


def suppliers() -> list[dict]:
    d = json.loads((REPO / "data" / "suppliers.json").read_text(encoding="utf-8"))
    return [s for s in d["suppliers"] if not s.get("live_only")]


# ---------- разбор страницы ----------
def _cls(el) -> str:
    return " ".join(filter(None, [el.get("class"), el.get("id"), el.get("alt"), el.get("src"), el.get("data-src"),
                                  el.get("title"), el.get("aria-label")])).lower()


def _img_src(img) -> str | None:
    for k in ("src", "data-src", "data-lazy-src", "data-original"):
        v = (img.get(k) or "").strip()
        if v and not v.startswith("data:image/gif"):
            return v
    ss = (img.get("srcset") or img.get("data-srcset") or "").strip()
    if ss:
        return ss.split(",")[0].strip().split(" ")[0]
    return None


def candidates(doc, base: str) -> list[dict]:
    out: list[dict] = []

    def add(kind: str, url: str | None = None, svg: str | None = None, hint: str = ""):
        if url:
            url = urljoin(base, url)
            if not url.startswith("http"):
                return
        out.append({"kind": kind, "url": url, "svg": svg, "hint": hint})

    def inline_svg(el) -> str | None:
        try:
            s = etree.tostring(el, encoding="unicode")
        except Exception:
            return None
        if "<use" in s and "xlink:href=\"#" in s or "<use" in s and "href=\"#" in s:
            return s       # спрайт — может не отрисоваться, проверит просмотр
        return s

    # 1. шапка: логотип-ссылка на главную, элементы с «logo», первая картинка в <header>
    seen = set()
    scopes = []
    for el in doc.iter("img", "svg"):
        c = _cls(el)
        parent = el.getparent()
        chain = []
        p = el
        for _ in range(4):
            p = p.getparent()
            if p is None:
                break
            chain.append(p)
        pc = " ".join(_cls(p) if p.tag in ("a", "div", "span", "p") else "" for p in chain)
        in_header = any(p.tag == "header" for p in chain) or "header" in pc or "head" in pc
        is_logo = "logo" in c or "logo" in pc or "brand" in c
        home_link = parent is not None and parent.tag == "a" and (parent.get("href") or "").rstrip("/") in ("", "/", "#", ".", base.rstrip("/"))
        if is_logo or (in_header and home_link):
            scopes.append((0 if is_logo and in_header else 1 if is_logo else 2, el))
    scopes.sort(key=lambda x: x[0])
    for _, el in scopes:
        if el.tag == "img":
            src = _img_src(el)
            if src and src not in seen and not BAD_NAME.search(src):
                seen.add(src)
                add("header-img", src, hint=(el.get("alt") or "")[:60])
        else:
            s = inline_svg(el)
            if s and len(s) < 400_000:
                add("header-svg", svg=s)
    # 2. JSON-LD
    for sc in doc.iter("script"):
        if (sc.get("type") or "").lower() == "application/ld+json" and sc.text:
            try:
                data = json.loads(sc.text)
            except ValueError:
                continue
            stack = [data]
            while stack:
                x = stack.pop()
                if isinstance(x, list):
                    stack.extend(x)
                elif isinstance(x, dict):
                    lg = x.get("logo")
                    if isinstance(lg, dict):
                        lg = lg.get("url") or lg.get("contentUrl")
                    if isinstance(lg, str):
                        add("jsonld-logo", lg)
                    stack.extend(v for v in x.values() if isinstance(v, (list, dict)))
    # 3. apple-touch-icon, 4. manifest, 5. большие rel=icon
    def size_of(l) -> int:
        m = re.match(r"(\d+)x\d+", (l.get("sizes") or "").lower())
        return int(m.group(1)) if m else 0
    links = list(doc.iter("link"))
    apple = [l for l in links if "apple-touch-icon" in (l.get("rel") or "").lower() and l.get("href")]
    for l in sorted(apple, key=size_of, reverse=True):
        add("apple-touch-icon", l.get("href"))
    for l in links:
        if (l.get("rel") or "").lower() == "manifest" and l.get("href"):
            add("manifest", l.get("href"))
    icons = [l for l in links if (l.get("rel") or "").lower() in ("icon", "shortcut icon") and l.get("href")]
    for l in sorted(icons, key=size_of, reverse=True):
        href = l.get("href")
        if size_of(l) >= MIN_SIDE or href.lower().split("?")[0].endswith(".svg"):
            add("icon", href)
    return out


SVG_CASE = ["viewBox", "preserveAspectRatio", "linearGradient", "radialGradient", "gradientUnits", "gradientTransform",
            "clipPath", "clipPathUnits", "maskUnits", "maskContentUnits", "patternUnits", "patternTransform",
            "patternContentUnits", "stdDeviation", "textLength", "lengthAdjust", "feGaussianBlur", "feOffset", "feFlood",
            "feComposite", "feBlend", "feColorMatrix", "feMerge", "feMergeNode", "feDropShadow", "filterUnits",
            "primitiveUnits", "spreadMethod", "startOffset", "baseFrequency", "numOctaves", "refX", "refY",
            "markerWidth", "markerHeight", "markerUnits", "foreignObject", "textPath", "tableValues", "keyTimes",
            "attributeName", "repeatCount", "calcMode", "xChannelSelector", "yChannelSelector", "surfaceScale"]


def fix_svg_case(s: str) -> str:
    """lxml.html опускает регистр тегов и атрибутов SVG (viewbox, lineargradient) — без этого логотип плывёт."""
    for name in SVG_CASE:
        s = re.sub(re.escape(name), name, s, flags=re.I)
    return s


def raster_info(data: bytes):
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        return im.size, im.format
    except Exception:
        return None, None


def expand_manifest(net: Net, url: str) -> list[str]:
    r, err = net.get(url)
    if err or r is None:
        return []
    try:
        j = r.json()
    except ValueError:
        return []
    icons = j.get("icons") or []

    def sz(i):
        m = re.match(r"(\d+)x", str(i.get("sizes") or ""))
        return int(m.group(1)) if m else 0
    return [urljoin(url, i["src"]) for i in sorted(icons, key=sz, reverse=True) if i.get("src") and sz(i) >= MIN_SIDE]


def check_asset(data: bytes, ctype: str, url: str):
    """(ext, w, h)|None, причина."""
    head = data[:600].lstrip().lower()
    if "svg" in ctype or url.lower().split("?")[0].endswith(".svg") or head.startswith((b"<svg", b"<?xml")):
        if b"<svg" not in data[:4000].lower():
            return None, "не SVG"
        return ("svg", 0, 0), None
    size, fmt = raster_info(data)
    if not size:
        return None, "не картинка"
    w, h = size
    if max(w, h) < MIN_SIDE:
        return None, f"мелкая {w}×{h}"
    ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp", "GIF": "png", "ICO": "ico"}.get(fmt or "", "")
    if ext in ("", "ico"):
        return None, f"формат {fmt}"
    return (ext, w, h), None


def collect_one(net: Net, s: dict) -> dict:
    sid, site = s["id"], site_of(s)
    rec = {"id": sid, "name": s["name"], "site": site, "status": "none", "reason": "", "chosen": None, "alts": [],
           "page": site, "collected_at": TODAY, "tried": []}
    d = WORK / sid
    d.mkdir(parents=True, exist_ok=True)
    for old in d.iterdir():                       # кэш прошлого прогона этого же поставщика
        if old.is_file():
            old.unlink()
    if not site:
        rec["reason"] = "в карточке нет сайта"
        return rec
    r, err = net.get(site)
    if err or r is None:
        rec["reason"] = f"главная не открылась: {err}"
        return rec
    rec["page"] = str(r.url)
    try:
        doc = lxml_html.fromstring(_decode(r.content, r.headers.get("content-type", "")))
    except Exception as e:
        rec["reason"] = f"HTML не разобрался: {e}"
        return rec
    base = str(r.url)
    try:
        bt = doc.find(".//base")
        if bt is not None and bt.get("href"):
            base = urljoin(base, bt.get("href"))
    except Exception:
        pass
    cands = candidates(doc, base)
    for u in MANUAL_CSS.get(sid, []):             # логотип лежит в CSS-фоне #logo — в HTML его нет
        cands.append({"kind": "css-background", "url": u, "svg": None, "hint": "CSS #logo"})
    expanded = []
    for c in cands:
        if c["kind"] == "manifest" and c["url"]:
            for u in expand_manifest(net, c["url"])[:2]:
                expanded.append({"kind": "manifest-icon", "url": u, "svg": None, "hint": ""})
        else:
            expanded.append(c)
    seen_hash, seen_url, n = set(), set(), 0
    for c in expanded:
        if len(rec["alts"]) + (1 if rec["chosen"] else 0) >= ALT_LIMIT + 1:
            break
        if c["svg"]:
            svg = c["svg"]
            svg = fix_svg_case(svg)
            if "xmlns=" not in svg[:300]:
                svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
            data, ext, wh, ctype = svg.encode("utf-8"), "svg", (0, 0), "image/svg+xml"
            if len(data) < 300:
                rec["tried"].append({"kind": c["kind"], "why": "пустой svg"})
                continue
            src_url = None
        else:
            u = c["url"]
            if u in seen_url:
                continue
            seen_url.add(u)
            ra, e = net.get(u)
            if e or ra is None:
                rec["tried"].append({"kind": c["kind"], "url": u, "why": e})
                continue
            data, ctype = ra.content, ra.headers.get("content-type", "").lower()
            if len(data) > MAX_BYTES:
                rec["tried"].append({"kind": c["kind"], "url": u, "why": "больше 3 МБ"})
                continue
            chk, why = check_asset(data, ctype, u)
            if not chk:
                rec["tried"].append({"kind": c["kind"], "url": u, "why": why})
                continue
            ext, w, h = chk
            wh = (w, h)
            src_url = str(ra.url)
        if ext == "png" and raster_info(data)[1] == "GIF":    # GIF складываем как PNG, первый кадр
            buf = io.BytesIO()
            Image.open(io.BytesIO(data)).convert("RGBA").save(buf, "PNG")
            data = buf.getvalue()
        hsh = hashlib.sha1(data).hexdigest()
        if hsh in seen_hash:
            continue
        seen_hash.add(hsh)
        n += 1
        fn = f"{n}-{c['kind']}.{ext}"
        (d / fn).write_bytes(data)
        item = {"file": f"work/{sid}/{fn}", "kind": c["kind"], "url": src_url, "w": wh[0], "h": wh[1], "hint": c["hint"]}
        if rec["chosen"] is None:
            rec["chosen"] = item
            rec["status"] = "found"
        else:
            rec["alts"].append(item)
    if rec["chosen"] is None:
        rec["reason"] = "кандидатов нет: " + ("; ".join(f"{t['kind']} {t.get('why')}" for t in rec["tried"][:4]) or "на главной не нашлось логотипа")
    return rec


def cmd_fetch():
    net = Net()
    sup = suppliers()
    print(f"поставщиков без live_only: {len(sup)}", flush=True)
    res = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, rec in enumerate(ex.map(lambda s: collect_one(net, s), sup), 1):
            res.append(rec)
            c = rec["chosen"]
            print(f"{i:2}/{len(sup)} {rec['id']:28} {rec['status']:6} {(c['kind'] + ' ' + str(c['w']) + 'x' + str(c['h'])) if c else rec['reason'][:70]}",
                  flush=True)
    (HERE / "work").mkdir(parents=True, exist_ok=True)
    (WORK / "candidates.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("готово: work/candidates.json")


# ---------- сборка результата ----------
def cmd_build():
    cands = {r["id"]: r for r in json.loads((WORK / "candidates.json").read_text(encoding="utf-8"))}
    rp = SRC / "review.json"
    review = json.loads(rp.read_text(encoding="utf-8")) if rp.exists() else {}
    LOGOS.mkdir(exist_ok=True)
    for f in LOGOS.iterdir():
        f.unlink()
    out = {}
    for s in suppliers():
        r = cands.get(s["id"])
        rv = review.get(s["id"], {})
        e = {"name": s["name"], "site": site_of(s), "file": None, "kind": None, "source_page": r["page"] if r else None,
             "asset_url": None, "collected_at": TODAY, "status": "none", "reason": ""}
        item = None
        pool = ([r["chosen"]] + r["alts"]) if r and r["chosen"] else []
        if pool:
            pick = rv.get("pick", 0)       # 0 — первый кандидат, 1.. — запасные
            item = pool[pick] if pick < len(pool) else None
        if rv.get("reject"):
            e.update(status="rejected", reason=rv["reject"])
            item = None
            if r and r["chosen"]:
                e["rejected_kind"] = r["chosen"]["kind"]
        elif item:
            ext = Path(item["file"]).suffix
            dst = LOGOS / f"{s['id']}{ext}"
            dst.write_bytes((HERE / item["file"]).read_bytes())
            e.update(file=f"logos/{dst.name}", kind=item["kind"], asset_url=item["url"], status="found",
                     reason=rv.get("note", ""), on_dark=bool(rv.get("on_dark")))
            sq = rv.get("square")
            if sq is not None and sq < len(pool):       # квадратный знак той же компании — для аватара 40 px
                m = pool[sq]
                mdst = LOGOS / f"{s['id']}--mark{Path(m['file']).suffix}"
                mdst.write_bytes((HERE / m["file"]).read_bytes())
                # решение Павла 15.10: где у компании есть отдельный знак — в аватар идёт он, слово остаётся запасным
                e.update(file_wide=e["file"], file=f"logos/{mdst.name}", kind=m["kind"], asset_url=m["url"],
                         wide_kind=item["kind"], wide_url=item["url"])
                e["on_dark"] = False                    # знак цветной, белым бывает только слово
        else:
            e["reason"] = rv.get("none_reason") or (r or {}).get("reason") or "не искали"
        out[s["id"]] = e
    (HERE / "logos.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    found = [k for k, v in out.items() if v["status"] == "found"]
    rej = [k for k, v in out.items() if v["status"] == "rejected"]
    none = [k for k, v in out.items() if v["status"] == "none"]
    print(f"найдено {len(found)} из {len(out)}, отбраковано {len(rej)}, без логотипа {len(none)}")
    write_overview(out)


def write_overview(out: dict):
    tiles, nologo = [], []
    for sid, e in out.items():
        if e["file"]:
            src = e["kind"]
            host = host_of(e["site"] or "")
            dk = " dk" if e.get("on_dark") else ""
            mark = (f'<div class="av s40"><img src="{escape(e["file_wide"])}" alt=""></div>' if e.get("file_wide") else "")
            note = f'<span class="note">{escape(e["reason"])}</span>' if e.get("reason") else ""
            tiles.append(f'<figure class="t"><div class="row"><div class="av s56{dk}"><img src="{escape(e["file"])}" alt=""></div>'
                         f'<div class="av s40{dk}"><img src="{escape(e["file"])}" alt=""></div>{mark}</div>'
                         f'<figcaption><b>{escape(e["name"])}</b><span>{escape(host)}</span>'
                         f'<span class="src">{escape(src)}{" · знак; слово — третья плитка, запасное" if mark else ""}</span>{note}</figcaption></figure>')
        else:
            why = e["reason"] or "—"
            nologo.append(f'<li><b>{escape(e["name"])}</b> <span>{escape(host_of(e["site"] or ""))}</span> — '
                          f'{"отбраковано: " if e["status"] == "rejected" else ""}{escape(why)}</li>')
    page = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Логотипы поставщиков — обзор</title>
<style>
:root{{--bg:#FFFFFF;--surface:#F7F7F7;--line:#E6E6E6;--ink:#222222;--muted:#6B6B6B;--accent:#EB4425;--r-lg:20px;--r-md:14px;--font:"Onest",system-ui,-apple-system,"Segoe UI",sans-serif}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:15px;line-height:1.5;padding:32px 24px 64px;max-width:1280px;margin-inline:auto}}
h1{{font-weight:300;font-size:36px;line-height:1.1;margin:0 0 8px}}h2{{font-weight:500;font-size:18px;margin:48px 0 16px}}
.lead{{color:var(--muted);margin:0 0 32px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}}
.t{{margin:0;background:var(--surface);border-radius:var(--r-lg);padding:16px;display:flex;flex-direction:column;gap:12px}}
.row{{display:flex;gap:12px;align-items:center}}
.av{{background:var(--bg);border:1px solid var(--line);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none}}
.av img{{width:100%;height:100%;object-fit:contain;padding:4px}}
.s56{{width:56px;height:56px}}.s40{{width:40px;height:40px;border-radius:10px}}
.av.dk{{background:#2A3A54;border-color:#2A3A54}}.note{{font-size:12px}}
.modes{{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 32px;position:sticky;top:0;background:var(--bg);padding:12px 0;z-index:2}}
.modes button{{font:inherit;font-size:13px;padding:8px 16px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}}
.modes button[aria-pressed=true]{{background:var(--ink);color:#fff;border-color:var(--ink)}}
.av{{position:relative}}.av::after{{content:"";position:absolute;inset:0;background:var(--tint,transparent);mix-blend-mode:lighten;pointer-events:none;border-radius:inherit;opacity:var(--tint-on,0)}}
body[data-mode=gray]{{--tint-on:0}}body[data-mode=gray] .av img{{filter:grayscale(1)}}
body[data-mode=ink]{{--tint:#222222;--tint-on:1}}body[data-mode=ink] .av img{{filter:grayscale(1) contrast(1.15)}}
body[data-mode=accent]{{--tint:#EB4425;--tint-on:1}}body[data-mode=accent] .av img{{filter:grayscale(1) contrast(1.15)}}
body[data-mode=navy]{{--tint:#2A3A54;--tint-on:1}}body[data-mode=navy] .av img{{filter:grayscale(1) contrast(1.15)}}
body[data-mode] .av.dk{{background:var(--bg);border-color:var(--line)}}body[data-mode] .av.dk img{{filter:grayscale(1) invert(1)}}
figcaption{{display:flex;flex-direction:column;font-size:13px;line-height:1.45}}figcaption span{{color:var(--muted)}}.src{{font-size:11px}}
ul{{padding-left:20px}}li{{margin:4px 0}}li span{{color:var(--muted)}}
</style></head><body>
<h1>Логотипы поставщиков</h1>
<p class="lead">Собрано {TODAY}. Плитки показаны в размере аватара карточки: 56 и 40 px на фоне сайта. Найдено {len(tiles)}, без логотипа {len(nologo)} (там будет монограмма).</p>
<div class="modes" id="modes"><button data-m="" aria-pressed="true">Как есть</button><button data-m="gray" aria-pressed="false">Чёрно-белые</button><button data-m="ink" aria-pressed="false">Графит #222</button><button data-m="navy" aria-pressed="false">Синий #2A3A54</button><button data-m="accent" aria-pressed="false">Акцент #EB4425</button></div>
<div class="grid">{''.join(tiles)}</div>
<h2>Без логотипа — будет монограмма ({len(nologo)})</h2>
<ul>{''.join(nologo)}</ul>
<script>
document.getElementById("modes").addEventListener("click",function(e){{var b=e.target.closest("button");if(!b)return;
document.querySelectorAll("#modes button").forEach(function(x){{x.setAttribute("aria-pressed",x===b?"true":"false")}});
if(b.dataset.m)document.body.dataset.mode=b.dataset.m;else document.body.removeAttribute("data-mode");}});
</script>
</body></html>"""
    (HERE / "обзор.html").write_text(page, encoding="utf-8")
    print("обзор.html записан")


if __name__ == "__main__":
    {"fetch": cmd_fetch, "build": cmd_build}[sys.argv[1] if len(sys.argv) > 1 else "fetch"]()
