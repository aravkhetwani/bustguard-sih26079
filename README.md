# BustGuard

Calibrated, explained warnings for medium-range forecasts that are likely to **bust**, verified against ERA5.
Prototype for SIH 2026, problem statement SIH26079 (Ministry of Earth Sciences).

Every number in the app comes from a public API or from a model trained on that data. There is no bundled sample data and no mock data. If a source is unreachable the interface says so instead of filling the gap.

## What it does

For each of 66 cells over India (2.5 degree grid), each variable (daily maximum and minimum temperature) and each lead time (day 3 to day 7), it estimates:

* the calibrated probability that the GFS forecast will miss ERA5 by more than a locally learned threshold (a "bust"),
* the expected size of the miss (10th, 50th and 90th percentile),
* the top reasons, as plain-language SHAP drivers,
* the live ECMWF ensemble and four global models side by side, for context.

The Verification page shows held-out backtest metrics. Live warnings are stored and scored against ERA5 as soon as the verifying day is published.

## Data sources (all anonymous)

| Purpose | Source |
|---|---|
| Archived and live forecasts (GFS, JMA, ECMWF IFS) | Open-Meteo Previous Runs and Forecast APIs |
| Live ensemble spread | Open-Meteo Ensemble API (ECMWF IFS, 51 members) |
| Verifying truth | ERA5 through the Open-Meteo Archive API |
| Climate drivers | NOAA PSL Nino 3.4 and Dipole Mode Index |
| Boundaries | Natural Earth 10 m, India point of view |
| Health checks | Also NOAA GFS on AWS S3 and ARCO-ERA5 on Google Cloud |

Open-Meteo data is CC BY 4.0 and its free API is for non-commercial use.

## Run it

```bash
pip install -r requirements.txt
cd backend
python run.py setup      # grid and climate indices
python run.py ingest     # archived forecasts + truth (resumable, respects the free-tier quota)
python run.py train      # labels, features, LightGBM, calibration, metrics
python run.py daily      # live inference for today and verification of past warnings
python run.py serve      # http://localhost:8000
```

Run `python run.py daily` once a day after the 00 UTC model run.

## Method in brief

* **Bust label.** Error is GFS minus ERA5 for the same local day. A bust is an absolute error above the 90th percentile for that cell, lead time and season, learned on the training period only.
* **Features (known at issue time).** Spread and range across successive GFS runs for the same day, run-to-run change, GFS vs JMA and ECMWF gaps, model spread, departure from the seasonal norm, recent local error, ENSO and IOD, season, location.
* **Model.** LightGBM classifier, isotonic calibration on a separate block of time, quantile regressors for the size of the miss, TreeSHAP for reasons.
* **Split.** Train to 2024-06-30, calibrate to 2024-12-31, test from 2025-01-01. No shuffling.

## Limitations

* The judged forecast is the GFS. ECMWF and JMA are disagreement signals.
* The live ensemble is displayed but is not a model input, because no archive of past ensembles is available.
* Truth is the ERA5 reanalysis, not station observations.
* Temperature only. Rainfall and cyclone tracks are not covered yet.
* MJO is not used because the public RMM feed stopped updating in early 2024.
* About two years of testing limits regime and seasonal coverage.

## Layout

```
backend/
  config.py                 parameters only
  pipeline/                 grid, ingest, indices, build_dataset, train, infer, verify, explain, store
  app/main.py               FastAPI: /api/meta /geo /risk /point/{id} /verification /health
  run.py                    entry point
frontend/                   static app (D3), served by FastAPI
```
