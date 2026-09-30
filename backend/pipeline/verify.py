"""Score stored live warnings against ERA5 once the verifying day is available."""
import datetime as dt
import pandas as pd

from config import VARIABLES, ARCHIVE_URL, TZ
from pipeline import grid as gridmod
from pipeline.http import get_json
from pipeline.store import connect

TRUTH_LAG_DAYS = 6


def run():
    con = connect()
    cutoff = dt.date.today() - dt.timedelta(days=TRUTH_LAG_DAYS)
    todo = con.execute("""
        SELECT p.issue_date, p.point_id, p.variable, p.lead, p.valid_date, p.forecast, p.bust_thr
        FROM predictions p LEFT JOIN outcomes o
          ON o.issue_date = p.issue_date AND o.point_id = p.point_id AND o.variable = p.variable AND o.lead = p.lead
        WHERE o.issue_date IS NULL AND p.valid_date <= ?""", [cutoff]).fetchdf()
    if todo.empty:
        print("nothing to verify yet (needs valid date + ERA5 latency)")
        return
    grid = {p["id"]: p for p in gridmod.load()["points"]}
    rows = []
    for pid, g in todo.groupby("point_id"):
        p = grid[int(pid)]
        r = get_json(ARCHIVE_URL, dict(latitude=p["lat"], longitude=p["lon"], models="era5", timezone=TZ,
                                       daily="temperature_2m_max,temperature_2m_min",
                                       start_date=str(g["valid_date"].min()), end_date=str(g["valid_date"].max())), pause=0.4)
        d = pd.DataFrame({"valid_date": pd.to_datetime(r["daily"]["time"]).date,
                          "tmax": r["daily"]["temperature_2m_max"], "tmin": r["daily"]["temperature_2m_min"]})
        for _, x in g.iterrows():
            t = d[d["valid_date"] == x["valid_date"]]
            if t.empty:
                continue
            truth = t.iloc[0]["tmax" if x["variable"] == "tmax" else "tmin"]
            if pd.isna(truth):
                continue
            ae = abs(float(x["forecast"]) - float(truth))
            rows.append((x["issue_date"], int(x["point_id"]), x["variable"], int(x["lead"]), x["valid_date"],
                         float(truth), ae, bool(ae > x["bust_thr"]) if pd.notna(x["bust_thr"]) else None))
    con.executemany("INSERT OR REPLACE INTO outcomes (issue_date, point_id, variable, lead, valid_date, truth, abs_err, busted) "
                    "VALUES (?,?,?,?,?,?,?,?)", rows)
    print(f"verified {len(rows)} predictions")
    con.close()


if __name__ == "__main__":
    run()
