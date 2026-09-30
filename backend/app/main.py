"""BustGuard API. Every value returned comes from stored pipeline output or a live public API call."""
import concurrent.futures as cf
import datetime as dt
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import (GEO, REPORTS, LEADS, VARIABLES, FORECAST_URL, ENSEMBLE_URL, PREV_RUNS_URL, ARCHIVE_URL, TZ,
                    NINO34_URL, DB_PATH)
from pipeline.store import connect
from pipeline.http import get_json

FRONT = Path(__file__).resolve().parents[2] / "frontend"
app = FastAPI(title="BustGuard API", version="0.1")

_cache = {}


def cached(key, ttl, fn):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (now, val)
    return val


def grid():
    return json.loads((GEO / "grid.json").read_text(encoding="utf-8"))


def db():
    """Per-request read-only connection, always closed so the pipeline can write between requests."""
    if not DB_PATH.exists():
        raise HTTPException(503, "No predictions stored yet. Run the inference pipeline first.")
    con = connect(read_only=True)
    try:
        yield con
    finally:
        con.close()


def latest_issue(con):
    r = con.execute("SELECT max(issue_date) FROM predictions").fetchone()[0]
    if r is None:
        raise HTTPException(503, "No predictions stored yet. Run the inference pipeline first.")
    return r


def metrics():
    p = REPORTS / "metrics.json"
    if not p.exists():
        raise HTTPException(503, "Model metrics not found. Run the training pipeline first.")
    return json.loads(p.read_text(encoding="utf-8"))


@app.get("/api/meta")
def meta(con=Depends(db)):
    issue = latest_issue(con)
    n = con.execute("SELECT count(*) FROM predictions WHERE issue_date = ?", [issue]).fetchone()[0]
    ver = con.execute("SELECT any_value(model_version) FROM predictions WHERE issue_date = ?", [issue]).fetchone()[0]
    stamp = con.execute("SELECT max(created_at) FROM predictions WHERE issue_date = ?", [issue]).fetchone()[0]
    m = metrics()
    g = grid()
    return {"issue_date": str(issue), "predictions": n, "model_version": ver, "generated_at": str(stamp),
            "leads": LEADS, "variables": VARIABLES, "cells": len(g["points"]), "grid_step": g["step"],
            "test_period": m["tmax"]["periods"], "tiers": {k: v["tiers"] for k, v in m.items()}}


@app.get("/api/geo")
def geo():
    outline = json.loads((GEO / "india_outline.geojson").read_text(encoding="utf-8"))
    return {"outline": outline, "grid": grid()}


@app.get("/api/risk")
def risk(variable: str = Query("tmax"), lead: int = Query(3), con=Depends(db)):
    if variable not in VARIABLES or lead not in LEADS:
        raise HTTPException(400, "unknown variable or lead")
    issue = latest_issue(con)
    df = con.execute("""SELECT point_id, valid_date, forecast, p_cal, tier, err_q10, err_q50, err_q90, bust_thr
                        FROM predictions WHERE issue_date = ? AND variable = ? AND lead = ?""",
                     [issue, variable, lead]).fetchdf()
    g = {p["id"]: p for p in grid()["points"]}
    cells = []
    for r in df.itertuples():
        p = g[r.point_id]
        cells.append({"id": int(r.point_id), "lat": p["lat"], "lon": p["lon"], "state": p["state"],
                      "valid_date": str(r.valid_date)[:10], "forecast": round(float(r.forecast), 1),
                      "p": round(float(r.p_cal), 4), "tier": r.tier, "q10": round(float(r.err_q10), 2),
                      "q50": round(float(r.err_q50), 2), "q90": round(float(r.err_q90), 2),
                      "thr": None if pd.isna(r.bust_thr) else round(float(r.bust_thr), 2)})
    states = {}
    for c in cells:
        s = states.setdefault(c["state"], {"state": c["state"], "n": 0, "p_sum": 0.0, "high": 0, "elevated": 0, "max_p": 0})
        s["n"] += 1
        s["p_sum"] += c["p"]
        s["high"] += c["tier"] == "high"
        s["elevated"] += c["tier"] == "elevated"
        s["max_p"] = max(s["max_p"], c["p"])
    ranking = sorted(({"state": s["state"], "mean_p": round(s["p_sum"] / s["n"], 4), "max_p": round(s["max_p"], 4),
                       "cells": s["n"], "high": s["high"], "elevated": s["elevated"]} for s in states.values()),
                     key=lambda d: (-d["high"], -d["mean_p"]))
    counts = {t: sum(1 for c in cells if c["tier"] == t) for t in ("low", "elevated", "high")}
    m = metrics()[variable]
    return {"issue_date": str(issue), "variable": variable, "lead": lead, "cells": cells, "ranking": ranking,
            "counts": counts, "base_rate": m["lightgbm_calibrated"]["base_rate"], "tiers": m["tiers"]}


def _daily(times, values, how):
    s = pd.Series(values, index=pd.to_datetime(times), dtype="float64")
    g = s.groupby(s.index.date)
    return (g.max() if how == "max" else g.min())


def _models_live(lat, lon):
    names = ["gfs_seamless", "ecmwf_ifs025", "icon_seamless", "jma_seamless"]
    r = get_json(FORECAST_URL, dict(latitude=lat, longitude=lon, hourly="temperature_2m", models=",".join(names),
                                    timezone=TZ, forecast_days=8), retries=3)
    out = {}
    for n in names:
        key = f"temperature_2m_{n}"
        if key in r["hourly"] and any(v is not None for v in r["hourly"][key]):
            out[n] = {"tmax": {str(d): None if pd.isna(v) else round(float(v), 1) for d, v in _daily(r["hourly"]["time"], r["hourly"][key], "max").items()},
                      "tmin": {str(d): None if pd.isna(v) else round(float(v), 1) for d, v in _daily(r["hourly"]["time"], r["hourly"][key], "min").items()}}
    return out


def _ensemble_live(lat, lon):
    r = get_json(ENSEMBLE_URL, dict(latitude=lat, longitude=lon, hourly="temperature_2m", models="ecmwf_ifs025",
                                    timezone=TZ, forecast_days=8), retries=3)
    h = r["hourly"]
    keys = [k for k in h if k.startswith("temperature_2m")]
    res = {"model": "ECMWF IFS ensemble", "members": len(keys), "tmax": {}, "tmin": {}}
    for how in ("max", "min"):
        per = {k: _daily(h["time"], h[k], how) for k in keys}
        days = sorted(next(iter(per.values())).index)
        for d in days:
            vals = np.array([per[k].get(d, np.nan) for k in keys], dtype=float)
            vals = vals[~np.isnan(vals)]
            if vals.size < 3:
                continue
            res["tmax" if how == "max" else "tmin"][str(d)] = {
                "min": round(float(vals.min()), 1), "p10": round(float(np.percentile(vals, 10)), 1),
                "p25": round(float(np.percentile(vals, 25)), 1), "p50": round(float(np.percentile(vals, 50)), 1),
                "p75": round(float(np.percentile(vals, 75)), 1), "p90": round(float(np.percentile(vals, 90)), 1),
                "max": round(float(vals.max()), 1), "std": round(float(vals.std()), 2), "n": int(vals.size)}
    return res


@app.get("/api/point/{pid}")
def point(pid: int, variable: str = Query("tmax"), con=Depends(db)):
    if variable not in VARIABLES:
        raise HTTPException(400, "unknown variable")
    g = {p["id"]: p for p in grid()["points"]}
    if pid not in g:
        raise HTTPException(404, "unknown grid point")
    issue = latest_issue(con)
    df = con.execute("""SELECT lead, valid_date, forecast, p_cal, tier, err_q10, err_q50, err_q90, bust_thr, drivers
                        FROM predictions WHERE issue_date = ? AND point_id = ? AND variable = ? ORDER BY lead""",
                     [issue, pid, variable]).fetchdf()
    leads = [{"lead": int(r.lead), "valid_date": str(r.valid_date)[:10], "forecast": round(float(r.forecast), 1),
              "p": round(float(r.p_cal), 4), "tier": r.tier, "q10": round(float(r.err_q10), 2),
              "q50": round(float(r.err_q50), 2), "q90": round(float(r.err_q90), 2),
              "thr": None if pd.isna(r.bust_thr) else round(float(r.bust_thr), 2), "drivers": json.loads(r.drivers)}
             for r in df.itertuples()]
    p = g[pid]
    return {"id": pid, "lat": p["lat"], "lon": p["lon"], "state": p["state"], "variable": variable,
            "issue_date": str(issue), "leads": leads}


@app.get("/api/live/{pid}")
def live_point(pid: int):
    """Live multi-model forecasts and the live ECMWF ensemble for one cell (slow: two upstream calls)."""
    g = {p["id"]: p for p in grid()["points"]}
    if pid not in g:
        raise HTTPException(404, "unknown grid point")
    p = g[pid]

    def one(name, fn):
        try:
            return name, cached((name, pid), 1800, lambda: fn(p["lat"], p["lon"])), None
        except Exception as e:                       # never fabricate: report the failure
            return name, None, str(e)[:160]

    with cf.ThreadPoolExecutor(2) as ex:
        results = list(ex.map(lambda t: one(*t), (("models", _models_live), ("ensemble", _ensemble_live))))
    live = {n: v for n, v, _ in results}
    errs = {n: e for n, _, e in results if e}
    return {"id": pid, "live": live, "live_errors": errs,
            "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}


@app.get("/api/verification")
def verification():
    m = metrics()
    out = {"metrics": m, "live": None}
    if DB_PATH.exists():
        con = connect(read_only=True)
        n_pred = con.execute("SELECT count(*) FROM predictions").fetchone()[0]
        n_out = con.execute("SELECT count(*) FROM outcomes").fetchone()[0]
        first = con.execute("SELECT min(issue_date), max(issue_date) FROM predictions").fetchone()
        live = {"stored_predictions": n_pred, "verified": n_out,
                "first_issue": str(first[0]) if first[0] else None, "last_issue": str(first[1]) if first[1] else None}
        if n_out:
            r = con.execute("""SELECT p.variable, count(*) n, avg(CASE WHEN o.busted THEN 1 ELSE 0 END) bust_rate,
                               avg(CASE WHEN p.tier='high' THEN CASE WHEN o.busted THEN 1.0 ELSE 0.0 END END) high_hit
                               FROM predictions p JOIN outcomes o USING (issue_date, point_id, variable, lead)
                               GROUP BY 1""").fetchdf()
            live["by_variable"] = json.loads(r.to_json(orient="records"))
        out["live"] = live
        con.close()
    return out


SOURCES = [
    ("Open-Meteo Previous Runs", PREV_RUNS_URL, dict(latitude=28.6, longitude=77.2, hourly="temperature_2m_previous_day3",
                                                      models="gfs_seamless", start_date="2026-09-01", end_date="2026-09-01")),
    ("Open-Meteo Forecast", FORECAST_URL, dict(latitude=28.6, longitude=77.2, hourly="temperature_2m", forecast_days=1)),
    ("Open-Meteo Ensemble", ENSEMBLE_URL, dict(latitude=28.6, longitude=77.2, hourly="temperature_2m", models="ecmwf_ifs025", forecast_days=1)),
    ("ERA5 (Open-Meteo Archive)", ARCHIVE_URL, dict(latitude=28.6, longitude=77.2, daily="temperature_2m_max", models="era5",
                                                     start_date="2026-09-01", end_date="2026-09-01")),
    ("NOAA PSL Nino 3.4", NINO34_URL, None),
    ("NOAA GFS on AWS S3", "https://noaa-gfs-bdp-pds.s3.amazonaws.com/index.html", None),
    ("ARCO-ERA5 (Google Cloud)", "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3/.zmetadata", None),
]


def _ping(item):
    name, url, params = item
    t = time.time()
    try:
        r = requests.get(url, params=params, timeout=15, stream=True, headers={"Range": "bytes=0-2048"} if params is None else None)
        ok = r.status_code in (200, 206)
        r.close()
        return {"name": name, "ok": ok, "status": r.status_code, "ms": int((time.time() - t) * 1000)}
    except Exception as e:
        return {"name": name, "ok": False, "status": None, "error": str(e)[:80], "ms": int((time.time() - t) * 1000)}


@app.get("/api/health")
def health():
    def run():
        with cf.ThreadPoolExecutor(6) as ex:
            res = list(ex.map(_ping, SOURCES))
        return {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "sources": res}
    return cached("health", 60, run)


@app.get("/")
def index():
    return FileResponse(FRONT / "index.html")


app.mount("/", StaticFiles(directory=str(FRONT)), name="static")
