"""Daily inference: live forecasts -> bust risk, expected error range and reasons."""
import datetime as dt
import json
import joblib
import numpy as np
import pandas as pd
import shap

from config import MODELS, VARIABLES, LEADS
from pipeline import grid as gridmod
from pipeline import ingest_history as ih
from pipeline import build_dataset as bd
from pipeline.explain import top_drivers
from pipeline.store import connect

BATCH = 6


def fetch_live(points, issue):
    frames = []
    for i in range(0, len(points), BATCH):
        frames.append(ih.fetch_forecast_chunk(points[i:i + BATCH], issue.isoformat(),
                                              (issue + dt.timedelta(days=max(LEADS))).isoformat()))
    return pd.concat(frames, ignore_index=True)


def run(issue=None):
    issue = issue or dt.date.today()
    grid = gridmod.load()["points"]
    grid_df = pd.DataFrame(grid)
    live = fetch_live(grid, issue)
    fc, truth = bd.load_raw()
    fc = pd.concat([fc, live], ignore_index=True).drop_duplicates(["point_id", "date", "model", "prev_day"], keep="last")

    con = connect()
    rows_out = []
    for var in VARIABLES:
        bundle = joblib.load(MODELS / f"{var}.joblib")
        feats = bundle["features"]
        df, _, _ = bd.build_var(fc, truth, var, grid_df)
        cur = df[(df["issue_date"] == pd.Timestamp(issue)) & (df["lead"].isin(LEADS))].copy()
        if cur.empty:
            print(f"[{var}] no live rows for {issue}")
            continue
        X = cur[feats]
        p_raw = bundle["clf"].predict_proba(X)[:, 1]
        p_cal = bundle["iso"].predict(p_raw)
        q10, q50, q90 = (np.maximum(0, bundle[k].predict(X)) for k in ("q10", "q50", "q90"))
        lo, hi = bundle["tiers"]["elevated"], bundle["tiers"]["high"]
        tier = np.where(p_cal >= hi, "high", np.where(p_cal >= lo, "elevated", "low"))
        sv = shap.TreeExplainer(bundle["clf"]).shap_values(X)
        sv = sv[1] if isinstance(sv, list) else sv
        for i, (_, r) in enumerate(cur.iterrows()):
            drivers = top_drivers(feats, [r[f] for f in feats], sv[i])
            rows_out.append((issue, int(r["point_id"]), var, int(r["lead"]), r["date"].date(), float(r["forecast"]),
                             float(p_raw[i]), float(p_cal[i]), str(tier[i]), float(q10[i]), float(q50[i]), float(q90[i]),
                             None if pd.isna(r["bust_thr"]) else float(r["bust_thr"]), json.dumps(drivers),
                             bundle["version"]))
        print(f"[{var}] scored {len(cur)} rows; high-risk share {(tier == 'high').mean():.1%}")
    con.execute("DELETE FROM predictions WHERE issue_date = ?", [issue])
    con.executemany("""INSERT INTO predictions (issue_date, point_id, variable, lead, valid_date, forecast, p_raw, p_cal,
                       tier, err_q10, err_q50, err_q90, bust_thr, drivers, model_version)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows_out)
    con.close()
    print(f"stored {len(rows_out)} predictions for issue date {issue}")


if __name__ == "__main__":
    run()
