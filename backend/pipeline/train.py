"""Train, calibrate and evaluate the bust-risk models. Time-block split, no shuffling."""
import json
import joblib
import numpy as np
import pandas as pd
import lightgbm as lgb
import shap
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss, precision_recall_curve, roc_curve
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler

from config import FEATURES, MODELS, REPORTS, VARIABLES, TRAIN_END, CALIB_END

FEATURE_COLS = [
    "lead", "forecast", "gfs_jump", "gfs_lag_std", "gfs_lag_range", "jma_gap", "ecmwf_gap", "mm_std", "mm_range",
    "anomaly", "anomaly_z", "abs_anomaly_z", "recent_mae", "recent_bias", "nino34", "dmi",
    "doy_sin", "doy_cos", "lat", "lon", "elevation",
]
BASELINE_COLS = ["gfs_lag_std"]
MODEL_VERSION = "bustguard-lgbm-0.1"

LGB_PARAMS = dict(n_estimators=350, learning_rate=0.03, num_leaves=15, min_child_samples=60,
                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=5.0,
                  random_state=7)


def ece(y, p, bins=10):
    qs = np.quantile(p, np.linspace(0, 1, bins + 1))
    qs[-1] += 1e-9
    e = 0.0
    for lo, hi in zip(qs[:-1], qs[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum():
            e += m.mean() * abs(y[m].mean() - p[m].mean())
    return float(e)


def reliability(y, p, bins=10):
    qs = np.quantile(p, np.linspace(0, 1, bins + 1))
    qs[-1] += 1e-9
    out = []
    for lo, hi in zip(qs[:-1], qs[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum():
            out.append({"p_mean": float(p[m].mean()), "obs_rate": float(y[m].mean()), "n": int(m.sum())})
    return out


def lift_at(y, p, frac=0.10):
    k = max(1, int(len(y) * frac))
    idx = np.argsort(-p)[:k]
    prec = float(y[idx].mean())
    return {"frac": frac, "precision": prec, "recall": float(y[idx].sum() / max(1, y.sum())),
            "lift": float(prec / max(1e-9, y.mean()))}


def metrics(y, p):
    return {"n": int(len(y)), "base_rate": float(y.mean()), "roc_auc": float(roc_auc_score(y, p)),
            "pr_auc": float(average_precision_score(y, p)), "brier": float(brier_score_loss(y, p)),
            "ece": ece(y, p), "top10": lift_at(y, p, 0.10), "top20": lift_at(y, p, 0.20)}


def train_var(var):
    df = pd.read_parquet(FEATURES / f"{var}.parquet")
    lab = df[df["split"].isin(["train", "calib", "test"]) & df["bust"].notna()].copy()
    tr, ca, te = (lab[lab.split == s] for s in ("train", "calib", "test"))
    print(f"[{var}] train {len(tr)}  calib {len(ca)}  test {len(te)}  base rates "
          f"{tr.bust.mean():.3f}/{ca.bust.mean():.3f}/{te.bust.mean():.3f}", flush=True)

    # 1) baseline: logistic regression on lagged-run spread only
    base = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(max_iter=500))
    base.fit(tr[BASELINE_COLS], tr["bust"])

    # 2) main: LightGBM classifier + isotonic calibration on the calibration block
    clf = lgb.LGBMClassifier(verbose=-1, **LGB_PARAMS)
    clf.fit(tr[FEATURE_COLS], tr["bust"])
    raw_ca = clf.predict_proba(ca[FEATURE_COLS])[:, 1]
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw_ca, ca["bust"])

    # 3) expected absolute-error range: quantile regressors
    q = {}
    for a in (0.1, 0.5, 0.9):
        m = lgb.LGBMRegressor(objective="quantile", alpha=a, verbose=-1, **LGB_PARAMS)
        m.fit(tr[FEATURE_COLS], tr["abs_err"])
        q[a] = m

    # ---- evaluation on the untouched test block --------------------------------
    p_raw = clf.predict_proba(te[FEATURE_COLS])[:, 1]
    p_cal = iso.predict(p_raw)
    p_base = base.predict_proba(te[BASELINE_COLS])[:, 1]
    y = te["bust"].values.astype(int)
    res = {"variable": var, "label": VARIABLES[var], "model_version": MODEL_VERSION,
           "periods": {"train_end": TRAIN_END, "calib_end": CALIB_END,
                       "test_start": str(te["date"].min().date()), "test_end": str(te["date"].max().date())},
           "counts": {"train": int(len(tr)), "calib": int(len(ca)), "test": int(len(te))},
           "lightgbm_calibrated": metrics(y, p_cal), "lightgbm_raw": metrics(y, p_raw),
           "baseline_spread_only": metrics(y, p_base)}
    res["reliability"] = {"calibrated": reliability(y, p_cal), "raw": reliability(y, p_raw),
                          "baseline": reliability(y, p_base)}
    pr, rc, _ = precision_recall_curve(y, p_cal)
    fpr, tpr, _ = roc_curve(y, p_cal)
    step_pr = max(1, len(pr) // 120)
    step_roc = max(1, len(fpr) // 120)
    res["pr_curve"] = [{"recall": float(r), "precision": float(p)} for p, r in zip(pr[::step_pr], rc[::step_pr])]
    res["roc_curve"] = [{"fpr": float(a), "tpr": float(b)} for a, b in zip(fpr[::step_roc], tpr[::step_roc])]

    # interval coverage of the quantile models
    q10, q90 = q[0.1].predict(te[FEATURE_COLS]), q[0.9].predict(te[FEATURE_COLS])
    inside = ((te["abs_err"].values >= q10) & (te["abs_err"].values <= q90)).mean()
    res["error_range"] = {"nominal_coverage": 0.8, "empirical_coverage": float(inside),
                          "mean_q50": float(q[0.5].predict(te[FEATURE_COLS]).mean()),
                          "mean_abs_err": float(te["abs_err"].mean())}

    te = te.assign(p_cal=p_cal, p_raw=p_raw, p_base=p_base)
    res["by_lead"] = {}
    for L, g in te.groupby("lead"):
        if g["bust"].nunique() > 1:
            res["by_lead"][int(L)] = metrics(g["bust"].values.astype(int), g["p_cal"].values)
    res["by_season"] = {}
    for s, g in te.groupby("season"):
        if g["bust"].nunique() > 1:
            res["by_season"][s] = metrics(g["bust"].values.astype(int), g["p_cal"].values)

    # risk tiers from the calibration block distribution (elevated: top 30 %, high: top 10 %)
    cal_scores = iso.predict(raw_ca)
    tiers = {"elevated": float(np.quantile(cal_scores, 0.70)), "high": float(np.quantile(cal_scores, 0.90))}
    res["tiers"] = tiers
    hi = te["p_cal"] >= tiers["high"]
    res["tier_check"] = {
        "high": {"share": float(hi.mean()), "bust_rate": float(te.loc[hi, "bust"].mean()) if hi.any() else None},
        "rest": {"bust_rate": float(te.loc[~hi, "bust"].mean())},
        "base_rate": float(te["bust"].mean())}

    # rolling backtest by month: warnings (top tier) vs what actually happened
    te["ym"] = te["date"].dt.to_period("M").astype(str)
    bt = []
    for ym, g in te.groupby("ym"):
        fl = g["p_cal"] >= tiers["high"]
        bt.append({"month": ym, "n": int(len(g)), "flagged": int(fl.sum()),
                   "flagged_busts": int(g.loc[fl, "bust"].sum()), "all_busts": int(g["bust"].sum()),
                   "precision": float(g.loc[fl, "bust"].mean()) if fl.any() else None,
                   "base_rate": float(g["bust"].mean())})
    res["backtest_monthly"] = bt

    # SHAP importance on a test sample
    expl = shap.TreeExplainer(clf)
    samp = te.sample(min(2500, len(te)), random_state=1)
    sv = expl.shap_values(samp[FEATURE_COLS])
    sv = sv[1] if isinstance(sv, list) else sv
    imp = np.abs(sv).mean(axis=0)
    res["shap_importance"] = sorted([{"feature": f, "mean_abs_shap": float(v)} for f, v in zip(FEATURE_COLS, imp)],
                                    key=lambda d: -d["mean_abs_shap"])

    MODELS.mkdir(parents=True, exist_ok=True)
    joblib.dump({"clf": clf, "iso": iso, "q10": q[0.1], "q50": q[0.5], "q90": q[0.9], "baseline": base,
                 "features": FEATURE_COLS, "tiers": tiers, "version": MODEL_VERSION}, MODELS / f"{var}.joblib")
    print(f"[{var}] PR-AUC {res['lightgbm_calibrated']['pr_auc']:.3f} (baseline {res['baseline_spread_only']['pr_auc']:.3f}, "
          f"base rate {res['lightgbm_calibrated']['base_rate']:.3f}) | ROC-AUC {res['lightgbm_calibrated']['roc_auc']:.3f} | "
          f"lift@10% {res['lightgbm_calibrated']['top10']['lift']:.2f}", flush=True)
    return res


def main():
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = {v: train_var(v) for v in VARIABLES}
    (REPORTS / "metrics.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("wrote metrics.json")


if __name__ == "__main__":
    main()
