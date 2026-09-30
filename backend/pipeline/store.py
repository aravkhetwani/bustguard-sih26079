"""DuckDB store for live predictions and their verified outcomes."""
import duckdb
from config import DB_PATH

DDL = [
    """CREATE TABLE IF NOT EXISTS predictions (
        issue_date DATE, point_id INTEGER, variable VARCHAR, lead INTEGER, valid_date DATE,
        forecast DOUBLE, p_raw DOUBLE, p_cal DOUBLE, tier VARCHAR,
        err_q10 DOUBLE, err_q50 DOUBLE, err_q90 DOUBLE, bust_thr DOUBLE,
        drivers VARCHAR, model_version VARCHAR, created_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (issue_date, point_id, variable, lead))""",
    """CREATE TABLE IF NOT EXISTS outcomes (
        issue_date DATE, point_id INTEGER, variable VARCHAR, lead INTEGER, valid_date DATE,
        truth DOUBLE, abs_err DOUBLE, busted BOOLEAN, verified_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (issue_date, point_id, variable, lead))""",
]


def connect(read_only=False):
    con = duckdb.connect(str(DB_PATH), read_only=read_only)
    if not read_only:
        for d in DDL:
            con.execute(d)
    return con
