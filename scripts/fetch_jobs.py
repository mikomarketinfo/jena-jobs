#!/usr/bin/env python3
"""
Ежедневный сборщик вакансий для Jena и округи.

Источники:
  * Bundesagentur für Arbeit (Jobsuche API) — работает без ключа.
  * Adzuna (агрегатор многих бирж: StepStone, Indeed-подобные и др.) — нужен бесплатный ключ
    (секреты ADZUNA_APP_ID и ADZUNA_APP_KEY в репозитории).
  * Jooble (агрегатор) — нужен бесплатный ключ (секрет JOOBLE_KEY).

Логика хранения (data/jobs.json):
  * новая вакансия получает first_seen = сегодня;
  * страница показывает вакансии моложе N дней во вкладке «Новые», остальные — во «Все»;
  * если источник успешно и ПОЛНОСТЬЮ опрошен, а вакансии в нём больше нет — она считается
    истекшей и удаляется. Если источник упал, его вакансии не трогаются.

Только стандартная библиотека Python — без зависимостей.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "search.json"
DATA = ROOT / "data" / "jobs.json"

TODAY = dt.date.today().isoformat()
UA = "jena-jobs-bot/1.0 (+https://github.com)"

AUSBILDUNG_RE = re.compile(r"ausbildung|azubi|auszubildende|duales? studium|umschulung", re.I)
MINIJOB_RE = re.compile(r"mini-?job|geringf[üu]gig|\b5\d\d\s?(€|euro|eur)\b|\b5\d\d[- ]?(€|euro)?[- ]?basis", re.I)
PRAKTIKUM_RE = re.compile(r"praktikum|praktikant|werkstudent", re.I)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http_json(url: str, *, headers=None, data=None, retries=3):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=h)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt * 3)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(2 ** attempt * 3)
    raise last  # type: ignore[misc]


def haversine(lat1, lon1, lat2, lon2):
    if None in (lat1, lon1, lat2, lon2):
        return None
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)), 1)


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9äöüß]+", "", (s or "").lower())


def classify(title: str, extra: str = "") -> tuple[str, list[str]]:
    text = f"{title} {extra}"
    jtype = "ausbildung" if AUSBILDUNG_RE.search(title) else "job"
    wt = []
    if MINIJOB_RE.search(text):
        wt.append("mj")
    if PRAKTIKUM_RE.search(title):
        wt.append("praktikum")
    return jtype, wt


# --------------------------------------------------------------------------- BA
BA_BASES = [
    "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs",
    "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs",
]
BA_HEADERS = {"X-API-Key": "jobboerse-jobsuche"}


def ba_query(base, params, max_pages):
    """Возвращает (список, полностью_ли_пройдено)."""
    out, page, size = [], 1, 100
    while page <= max_pages:
        q = dict(params, page=page, size=size, pav="false")
        url = base + "?" + urllib.parse.urlencode(q)
        res = http_json(url, headers=BA_HEADERS)
        items = res.get("stellenangebote") or []
        out.extend(items)
        total = int(res.get("maxErgebnisse") or 0)
        if not items or page * size >= total:
            return out, True
        page += 1
        time.sleep(0.4)
    return out, False


def fetch_ba(cfg):
    queries = [
        ({"angebotsart": 1}, "job", None),
        ({"angebotsart": 1, "arbeitszeit": "vz"}, "job", "vz"),
        ({"angebotsart": 1, "arbeitszeit": "tz"}, "job", "tz"),
        ({"angebotsart": 1, "arbeitszeit": "mj"}, "job", "mj"),
        ({"angebotsart": 1, "arbeitszeit": "snw"}, "job", "snw"),
        ({"angebotsart": 4}, "ausbildung", None),
        ({"angebotsart": 34}, "job", "praktikum"),
    ]
    keywords = cfg.get("keywords") or [None]
    base_params = {"wo": cfg["location"], "umkreis": cfg["radius_km"]}

    # выбираем рабочую версию API
    base = None
    for b in BA_BASES:
        try:
            http_json(b + "?" + urllib.parse.urlencode(dict(base_params, page=1, size=1)), headers=BA_HEADERS)
            base = b
            break
        except Exception as e:  # noqa: BLE001
            log(f"BA {b}: {e}")
    if not base:
        raise RuntimeError("Jobsuche API недоступен")

    jobs: dict[str, dict] = {}
    complete = True
    for kw in keywords:
        for params, jtype, tag in queries:
            p = dict(base_params, **params)
            if kw:
                p["was"] = kw
            items, done = ba_query(base, p, cfg.get("max_pages_per_query", 40))
            complete &= done
            log(f"BA {p} -> {len(items)}{'' if done else ' (обрезано)'}")
            for it in items:
                ref = it.get("refnr")
                if not ref:
                    continue
                jid = "ba:" + ref
                j = jobs.get(jid)
                if j is None:
                    ort = it.get("arbeitsort") or {}
                    ko = ort.get("koordinaten") or {}
                    title = it.get("titel") or it.get("beruf") or ""
                    j = {
                        "id": jid,
                        "src": "Arbeitsagentur",
                        "title": title,
                        "beruf": it.get("beruf") or "",
                        "employer": it.get("arbeitgeber") or "",
                        "place": " ".join(x for x in [ort.get("plz"), ort.get("ort")] if x),
                        "lat": ko.get("lat"),
                        "lon": ko.get("lon"),
                        "type": jtype,
                        "wt": [],
                        "published": (it.get("aktuelleVeroeffentlichungsdatum") or "")[:10] or None,
                        "start": (it.get("eintrittsdatum") or "")[:10] or None,
                        "url": "https://www.arbeitsagentur.de/jobsuche/jobdetail/" + urllib.parse.quote(ref),
                        "ext": it.get("externeUrl") or None,
                    }
                    jobs[jid] = j
                if jtype == "ausbildung":
                    j["type"] = "ausbildung"
                if tag and tag not in j["wt"]:
                    j["wt"].append(tag)
    return list(jobs.values()), complete


# ----------------------------------------------------------------------- Adzuna
def fetch_adzuna(cfg):
    app_id, app_key = os.getenv("ADZUNA_APP_ID"), os.getenv("ADZUNA_APP_KEY")
    if not (app_id and app_key):
        raise LookupError("нет ключа (ADZUNA_APP_ID / ADZUNA_APP_KEY)")
    jobs, complete = {}, True
    for kw in (cfg.get("keywords") or [None]):
        page = 1
        while True:
            q = {
                "app_id": app_id, "app_key": app_key, "where": cfg["location"],
                "distance": cfg["radius_km"], "results_per_page": 50,
                "content-type": "application/json",
            }
            if kw:
                q["what"] = kw
            url = f"https://api.adzuna.com/v1/api/jobs/de/search/{page}?" + urllib.parse.urlencode(q)
            res = http_json(url)
            items = res.get("results") or []
            for it in items:
                title = it.get("title") or ""
                desc = it.get("description") or ""
                jtype, wt = classify(title, desc)
                ct = it.get("contract_time")
                if ct == "full_time":
                    wt.append("vz")
                elif ct == "part_time":
                    wt.append("tz")
                jid = f"adz:{it.get('id')}"
                jobs[jid] = {
                    "id": jid, "src": "Adzuna", "title": title, "beruf": (it.get("category") or {}).get("label", ""),
                    "employer": (it.get("company") or {}).get("display_name", ""),
                    "place": (it.get("location") or {}).get("display_name", ""),
                    "lat": it.get("latitude"), "lon": it.get("longitude"),
                    "type": jtype, "wt": wt, "published": (it.get("created") or "")[:10] or None,
                    "start": None, "url": it.get("redirect_url"), "ext": None,
                }
            if not items or page * 50 >= int(res.get("count") or 0):
                break
            page += 1
            if page > cfg.get("max_pages_per_query", 40):
                complete = False
                break
            time.sleep(0.5)
    return list(jobs.values()), complete


# ------------------------------------------------------------------------ Jooble
def fetch_jooble(cfg):
    key = os.getenv("JOOBLE_KEY")
    if not key:
        raise LookupError("нет ключа (JOOBLE_KEY)")
    radii = [0, 4, 8, 16, 26, 40, 80]
    radius = next((r for r in radii if r >= cfg["radius_km"]), 80)
    kws = cfg.get("keywords") or ["", "Ausbildung", "Minijob"]
    jobs, complete = {}, True
    for kw in kws:
        page = 1
        while True:
            res = http_json(f"https://jooble.org/api/{key}",
                            data={"keywords": kw, "location": cfg["location"], "radius": str(radius), "page": str(page)})
            items = res.get("jobs") or []
            for it in items:
                title = it.get("title") or ""
                snippet = re.sub(r"<[^>]+>", " ", it.get("snippet") or "")
                jtype, wt = classify(title, snippet + " " + (it.get("type") or ""))
                t = (it.get("type") or "").lower()
                if "vollzeit" in t or "full" in t:
                    wt.append("vz")
                if "teilzeit" in t or "part" in t:
                    wt.append("tz")
                jid = f"joo:{it.get('id')}"
                jobs[jid] = {
                    "id": jid, "src": "Jooble" + (f" / {it['source']}" if it.get("source") else ""),
                    "title": title, "beruf": "", "employer": it.get("company") or "",
                    "place": it.get("location") or "", "lat": None, "lon": None,
                    "type": jtype, "wt": sorted(set(wt)), "published": (it.get("updated") or "")[:10] or None,
                    "start": None, "url": it.get("link"), "ext": None,
                }
            total = int(res.get("totalCount") or 0)
            if not items or len(jobs) >= total or page * 20 >= total:
                break
            page += 1
            if page > cfg.get("max_pages_per_query", 40):
                complete = False
                break
            time.sleep(0.5)
    return list(jobs.values()), complete


SOURCES = {
    "arbeitsagentur": ("Arbeitsagentur", fetch_ba),
    "adzuna": ("Adzuna", fetch_adzuna),
    "jooble": ("Jooble", fetch_jooble),
}


def src_family(job):
    return job["src"].split(" /")[0]


# ------------------------------------------------------------------------- merge
def merge(old: dict, fetched: dict[str, tuple[list, bool]], cfg) -> dict:
    old_jobs = {j["id"]: j for j in old.get("jobs", [])}
    bootstrap = not old_jobs
    center = cfg.get("center") or {}
    result: dict[str, dict] = {}

    # 1) старые вакансии: оставляем, если источник не опрошен полностью или вакансия всё ещё есть
    fresh_ids = {j["id"] for jobs, _ in fetched.values() for j in jobs}
    complete_families = {fam for fam, (_, ok) in fetched.items() if ok}
    removed = 0
    for jid, j in old_jobs.items():
        if jid in fresh_ids:
            continue
        stale = (j.get("last_seen") or TODAY) < (dt.date.today() - dt.timedelta(days=7)).isoformat()
        if src_family(j) in complete_families or stale:
            removed += 1  # истекла (или не встречалась 7 дней) — удаляем
            continue
        result[jid] = j

    # 2) свежие
    for jobs, _ in fetched.values():
        for j in jobs:
            prev = old_jobs.get(j["id"])
            if prev:
                j["first_seen"] = prev.get("first_seen", TODAY)
            elif bootstrap and j.get("published") and j["published"] <= TODAY:
                j["first_seen"] = j["published"]
            else:
                j["first_seen"] = TODAY
            j["last_seen"] = TODAY
            j["dist"] = haversine(center.get("lat"), center.get("lon"), j.get("lat"), j.get("lon"))
            j["wt"] = sorted(set(j.get("wt") or []))
            result[j["id"]] = j

    # 3) дубликаты между биржами: приоритет у Arbeitsagentur
    seen, deduped = {}, []
    prio = {"Arbeitsagentur": 0, "Adzuna": 1, "Jooble": 2}
    for j in result.values():
        j.pop("alt", None)
    for j in sorted(result.values(), key=lambda x: prio.get(src_family(x), 9)):
        k = norm(j["title"]) + "|" + norm(j["employer"])
        if k in seen and norm(j["employer"]):
            first = seen[k]
            alt = first.setdefault("alt", [])
            if j.get("url") and j["url"] not in [a["url"] for a in alt]:
                alt.append({"src": j["src"], "url": j["url"]})
            continue
        seen[k] = j
        deduped.append(j)

    deduped.sort(key=lambda x: (x["first_seen"], x.get("published") or ""), reverse=True)
    log(f"Удалено истекших: {removed}; всего: {len(deduped)}")
    return {"jobs": deduped, "removed_today": removed}


def main():
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    old = json.loads(DATA.read_text(encoding="utf-8")) if DATA.exists() else {}

    fetched, status = {}, {}
    for key, (family, fn) in SOURCES.items():
        if not cfg.get("sources", {}).get(key, True):
            status[family] = {"ok": False, "note": "выключен в config/search.json"}
            continue
        try:
            jobs, complete = fn(cfg)
            fetched[family] = (jobs, complete)
            status[family] = {"ok": True, "count": len(jobs), "complete": complete}
        except LookupError as e:
            status[family] = {"ok": False, "note": str(e)}
            log(f"{family}: пропущен — {e}")
        except Exception as e:  # noqa: BLE001
            status[family] = {"ok": False, "note": f"ошибка: {e}"}
            log(f"{family}: ОШИБКА — {e}")

    if not fetched and old:
        log("Ни один источник не ответил — данные не меняю.")
        old.setdefault("meta", {})["last_attempt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        old["meta"]["sources"] = status
        DATA.write_text(json.dumps(old, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return 0

    merged = merge(old, fetched, cfg)
    out = {
        "meta": {
            "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "location": cfg["location"], "radius_km": cfg["radius_km"], "new_days": cfg.get("new_days", 14),
            "center": cfg.get("center"), "sources": status, "removed_today": merged["removed_today"],
        },
        "jobs": merged["jobs"],
    }
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"Готово: {len(out['jobs'])} вакансий -> {DATA}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
