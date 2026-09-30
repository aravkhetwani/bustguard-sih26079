"""Pull archived forecasts (Open-Meteo Previous Runs) and ERA5 truth (Open-Meteo Archive).

Everything is cached chunk-by-chunk as Parquet so an interrupted run resumes without
re-spending API quota.
"""
import datetime as dt
import sys
import pandas as pd

from config import (RAW, PREV_RUNS_URL, ARCHIVE_URL, TZ, ALL_MODELS, MAX_PREV_DAY, LEADS,
                    HISTORY_START, MIN_HOURS_PER_DAY)
from pipeline.http import get_json
from pipeline import grid as gridmod

BATCH = 6                # locations per request
CHUNK_DAYS = 190         # days per request


def _daterange_chunks(start, end, step):
    s = dt.date.fromisoformat(start)
    e = dt.date.fromisoformat(end)
    while s <= e:
        t = min(s + dt.timedelta(days=step - 1), e)
        yield s.isoformat(), t.isoformat()
        s = t + dt.timedelta(days=1)


def _hourly_to_daily(times, values):
    """Local-day max/min from hourly values, requiring a (nearly) complete day."""
    s = pd.Series(values, index=pd.to_datetime(times), dtype="float64")
    g = s.groupby(s.index.date)
    out = pd.DataFrame({"tmax": g.max(), "tmin": g.min(), "n": g.count()})
    out.loc[out["n"] < MIN_HOURS_PER_DAY, ["tmax", "tmin"]] = float("nan")
    out.index = pd.to_datetime(out.index)
    return out[["tmax", "tmin"]]


def fetch_forecast_chunk(points, start, end):
    lead_vars = [f"temperature_2m_previous_day{n}" for n in range(min(LEADS), MAX_PREV_DAY + 1)]
    # ECMWF's open archive of previous runs starts in 2024; skip it earlier to save API quota
    models = [m for m in ALL_MODELS if not (m == "ecmwf_ifs025" and end < "2024-01-01")]
    params = dict(latitude=",".join(str(p["lat"]) for p in points),
                  longitude=",".join(str(p["lon"]) for p in points),
                  hourly=",".join(lead_vars), models=",".join(models),
                  start_date=start, end_date=end, timezone=TZ)
    res = get_json(PREV_RUNS_URL, params, pause=1.0)
    res = res if isinstance(res, list) else [res]
    rows = []
    for p, r in zip(points, res):
        h = r["hourly"]
        elev = r.get("elevation")
        for key, vals in h.items():
            if key == "time" or "previous_day" not in key:
                continue
            # key looks like temperature_2m_previous_day5_gfs_seamless
            head, model = key.split("_previous_day")[1].split("_", 1)
            day = int(head)
            d = _hourly_to_daily(h["time"], vals)
            d["point_id"] = p["id"]
            d["model"] = model
            d["prev_day"] = day
            d["elevation"] = elev
            rows.append(d.reset_index(names="date"))
    return pd.concat(rows, ignore_index=True)


def ingest_forecasts(end_date):
    grid = gridmod.load()["points"]
    (RAW / "forecast").mkdir(parents=True, exist_ok=True)
    batches = [grid[i:i + BATCH] for i in range(0, len(grid), BATCH)]
    total = len(batches) * len(list(_daterange_chunks(HISTORY_START, end_date, CHUNK_DAYS)))
    done = 0
    for bi, pts in enumerate(batches):
        for s, e in _daterange_chunks(HISTORY_START, end_date, CHUNK_DAYS):
            done += 1
            f = RAW / "forecast" / f"b{bi:02d}_{s}_{e}.parquet"
            if f.exists():
                continue
            print(f"[{done}/{total}] forecast batch {bi} {s}..{e}", flush=True)
            df = fetch_forecast_chunk(pts, s, e)
            df.to_parquet(f)


def fetch_truth_chunk(points, start, end):
    params = dict(latitude=",".join(str(p["lat"]) for p in points),
                  longitude=",".join(str(p["lon"]) for p in points),
                  daily="temperature_2m_max,temperature_2m_min", models="era5",
                  start_date=start, end_date=end, timezone=TZ)
    res = get_json(ARCHIVE_URL, params, pause=1.0)
    res = res if isinstance(res, list) else [res]
    rows = []
    for p, r in zip(points, res):
        d = r["daily"]
        rows.append(pd.DataFrame({"date": pd.to_datetime(d["time"]), "point_id": p["id"],
                                  "tmax_truth": d["temperature_2m_max"],
                                  "tmin_truth": d["temperature_2m_min"]}))
    return pd.concat(rows, ignore_index=True)


def ingest_truth(end_date):
    grid = gridmod.load()["points"]
    (RAW / "truth").mkdir(parents=True, exist_ok=True)
    for bi in range(0, len(grid), 10):
        pts = grid[bi:bi + 10]
        for s, e in _daterange_chunks(HISTORY_START, end_date, 400):
            f = RAW / "truth" / f"b{bi // 10:02d}_{s}_{e}.parquet"
            if f.exists():
                continue
            print(f"truth batch {bi // 10} {s}..{e}", flush=True)
            fetch_truth_chunk(pts, s, e).to_parquet(f)


if __name__ == "__main__":
    today = dt.date.today()
    fc_end = (today - dt.timedelta(days=1)).isoformat()      # forecasts verified for past valid dates
    truth_end = (today - dt.timedelta(days=6)).isoformat()   # ERA5 latency ~5 days
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("truth", "all"):
        ingest_truth(truth_end)
    if what in ("forecast", "all"):
        ingest_forecasts(fc_end)
