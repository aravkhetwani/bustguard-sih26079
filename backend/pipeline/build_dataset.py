"""Turn archived forecasts + ERA5 truth into (features, bust label) tables.

Every feature uses only information available at forecast-issue time
(issue date = valid date - lead). Thresholds and climatology come from the TRAIN
period only, so nothing from the test period leaks into labels or features.
"""
import glob
import numpy as np
import pandas as pd

from config import (RAW, FEATURES, MODELS, LEADS, MAX_PREV_DAY, PRIMARY_MODEL, TRAIN_END, CALIB_END,
                    BUST_QUANTILE, SEASONS, VARIABLES)
from pipeline import indices, grid as gridmod


def load_raw():
    fc = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob(str(RAW / "forecast" / "*.parquet")))],
                   ignore_index=True)
    tr = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob(str(RAW / "truth" / "*.parquet")))],
                   ignore_index=True).drop_duplicates(["point_id", "date"])
    fc = fc.drop_duplicates(["point_id", "date", "model", "prev_day"])
    return fc, tr


def _wide(fc, var):
    w = fc.pivot_table(index=["point_id", "date"], columns=["model", "prev_day"], values=var, aggfunc="first")
    return w


def season_of(dates):
    return pd.Series(pd.DatetimeIndex(dates).month, index=None).map(SEASONS).values


def climatology(truth, var):
    """Monthly mean/std of ERA5 truth per point from the TRAIN period only."""
    t = truth[truth["date"] <= TRAIN_END].copy()
    t["month"] = t["date"].dt.month
    c = t.groupby(["point_id", "month"])[f"{var}_truth"].agg(["mean", "std"]).reset_index()
    c.columns = ["point_id", "month", "clim_mean", "clim_std"]
    return c


def build_var(fc, truth, var, grid_df):
    w = _wide(fc, var)
    elev = fc.groupby("point_id")["elevation"].first()
    clim = climatology(truth, var)
    tr = truth.set_index(["point_id", "date"])[f"{var}_truth"]
    frames = []
    for L in LEADS:
        cols = {}
        g = lambda m, k: w[(m, k)] if (m, k) in w.columns else pd.Series(np.nan, index=w.index)
        f = g(PRIMARY_MODEL, L)
        lag = [g(PRIMARY_MODEL, k) for k in range(L, min(L + 2, MAX_PREV_DAY) + 1)]
        lagdf = pd.concat(lag, axis=1)
        jma, ecm = g("jma_seamless", L), g("ecmwf_ifs025", L)
        mm = pd.concat([f, jma, ecm], axis=1)
        d = pd.DataFrame(index=w.index)
        d["forecast"] = f
        d["gfs_jump"] = f - g(PRIMARY_MODEL, L + 1) if L + 1 <= MAX_PREV_DAY else np.nan
        d["gfs_lag_std"] = lagdf.std(axis=1, ddof=0).where(lagdf.count(axis=1) >= 2)
        d["gfs_lag_range"] = (lagdf.max(axis=1) - lagdf.min(axis=1)).where(lagdf.count(axis=1) >= 2)
        d["jma_gap"] = f - jma
        d["ecmwf_gap"] = f - ecm
        d["mm_std"] = mm.std(axis=1, ddof=0).where(mm.count(axis=1) >= 2)
        d["mm_range"] = (mm.max(axis=1) - mm.min(axis=1)).where(mm.count(axis=1) >= 2)
        d = d.reset_index()
        d["lead"] = L
        d["truth"] = tr.reindex(pd.MultiIndex.from_frame(d[["point_id", "date"]])).values
        frames.append(d)
    df = pd.concat(frames, ignore_index=True)
    df = df[df["forecast"].notna()].copy()
    df["month"] = df["date"].dt.month
    df["season"] = df["month"].map(SEASONS)
    df["issue_date"] = df["date"] - pd.to_timedelta(df["lead"], unit="D")

    # climatological anomaly / extremeness
    df = df.merge(clim, on=["point_id", "month"], how="left")
    df["anomaly"] = df["forecast"] - df["clim_mean"]
    df["anomaly_z"] = df["anomaly"] / df["clim_std"].replace(0, np.nan)
    df["abs_anomaly_z"] = df["anomaly_z"].abs()

    # static + calendar
    gd = grid_df.set_index("id")
    df["lat"] = df["point_id"].map(gd["lat"])
    df["lon"] = df["point_id"].map(gd["lon"])
    df["elevation"] = df["point_id"].map(elev)
    df["doy_sin"] = np.sin(2 * np.pi * df["date"].dt.dayofyear / 365.25)
    df["doy_cos"] = np.cos(2 * np.pi * df["date"].dt.dayofyear / 365.25)

    # climate drivers as known at issue time
    ind = indices.asof(df["issue_date"].values)
    df["nino34"] = ind["nino34"].values
    df["dmi"] = ind["dmi"].values

    # errors + recent skill known at issue time (truth for valid dates <= issue - 5 days)
    df["err"] = df["forecast"] - df["truth"]
    df["abs_err"] = df["err"].abs()
    parts = []
    for (pid, L), g in df.groupby(["point_id", "lead"]):
        s_abs = g.set_index("date")["abs_err"]
        s_err = g.set_index("date")["err"]
        full = pd.date_range(s_abs.index.min(), s_abs.index.max(), freq="D")
        a = s_abs.reindex(full).rolling(14, min_periods=5).mean().shift(L + 5)
        b = s_err.reindex(full).rolling(14, min_periods=5).mean().shift(L + 5)
        out = pd.DataFrame({"date": full, "point_id": pid, "lead": L, "recent_mae": a.values, "recent_bias": b.values})
        parts.append(out)
    rec = pd.concat(parts, ignore_index=True)
    df = df.merge(rec, on=["point_id", "lead", "date"], how="left")

    # bust threshold learned on TRAIN only: P90 of |error| per point x lead x season
    trn = df[(df["date"] <= TRAIN_END) & df["abs_err"].notna()]
    thr = (trn.groupby(["point_id", "lead", "season"])["abs_err"].quantile(BUST_QUANTILE)
           .rename("bust_thr").reset_index())
    thr_pl = (trn.groupby(["point_id", "lead"])["abs_err"].quantile(BUST_QUANTILE)
              .rename("bust_thr_pl").reset_index())
    df = df.merge(thr, on=["point_id", "lead", "season"], how="left").merge(thr_pl, on=["point_id", "lead"], how="left")
    df["bust_thr"] = df["bust_thr"].fillna(df["bust_thr_pl"])
    df["bust"] = np.where(df["abs_err"].notna(), (df["abs_err"] > df["bust_thr"]).astype(float), np.nan)
    df["split"] = np.where(df["date"] <= TRAIN_END, "train", np.where(df["date"] <= CALIB_END, "calib", "test"))
    df.loc[df["truth"].isna(), "split"] = "live"   # not yet verifiable
    df["variable"] = var
    return df, clim, pd.concat([thr, thr_pl], ignore_index=True)


def main():
    FEATURES.mkdir(parents=True, exist_ok=True)
    MODELS.mkdir(parents=True, exist_ok=True)
    fc, truth = load_raw()
    grid_df = pd.DataFrame(gridmod.load()["points"])
    print("forecast rows", len(fc), "truth rows", len(truth), "range", fc["date"].min(), fc["date"].max())
    for var in VARIABLES:
        df, clim, thr = build_var(fc, truth, var, grid_df)
        df.to_parquet(FEATURES / f"{var}.parquet")
        clim.to_parquet(MODELS / f"{var}_climatology.parquet")
        thr.to_parquet(MODELS / f"{var}_thresholds.parquet")
        vc = df["split"].value_counts().to_dict()
        print(var, len(df), vc, "bust rate (train):", round(df.loc[df.split == "train", "bust"].mean(), 3))


if __name__ == "__main__":
    main()
