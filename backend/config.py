"""Central configuration. Parameters only: no weather values live here."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW = DATA / "raw"
GEO = DATA / "geo"
INTERIM = DATA / "interim"
FEATURES = DATA / "features"
MODELS = DATA / "models"
REPORTS = DATA / "reports"
DB_PATH = DATA / "bustguard.duckdb"

# --- external endpoints (all anonymous / public) ---------------------------------
PREV_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
NINO34_URL = "https://psl.noaa.gov/data/timeseries/month/data/nino34.long.anom.data"
DMI_URL = "https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data"
NE_INDIA_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
                "master/geojson/ne_10m_admin_0_countries_ind.geojson")
NE_STATES_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
                 "master/geojson/ne_10m_admin_1_states_provinces.geojson")

TZ = "Asia/Kolkata"

# --- domain ----------------------------------------------------------------------
GRID_STEP_DEG = 2.5
BBOX = dict(lat_min=6.0, lat_max=37.5, lon_min=68.0, lon_max=98.0)
COAST_BUFFER_DEG = 0.6          # keep coastal cells whose centre is just offshore

PRIMARY_MODEL = "gfs_seamless"   # the forecast being judged (longest archive)
SIGNAL_MODELS = ["jma_seamless", "ecmwf_ifs025"]   # disagreement signals
ALL_MODELS = [PRIMARY_MODEL] + SIGNAL_MODELS
LEADS = [3, 4, 5, 6, 7]         # forecast lead in days (previous_dayN API limit is 7)
MAX_PREV_DAY = 7
VARIABLES = {"tmax": "Maximum temperature", "tmin": "Minimum temperature"}

HISTORY_START = "2023-01-01"
# split dates by valid date (time-block, no shuffling)
TRAIN_END = "2024-06-30"
CALIB_END = "2024-12-31"        # test period = everything after
MIN_HOURS_PER_DAY = 20

BUST_QUANTILE = 0.90            # learned per point x variable x lead x season
SEASONS = {12: "winter", 1: "winter", 2: "winter",
           3: "premonsoon", 4: "premonsoon", 5: "premonsoon",
           6: "monsoon", 7: "monsoon", 8: "monsoon", 9: "monsoon",
           10: "postmonsoon", 11: "postmonsoon"}
