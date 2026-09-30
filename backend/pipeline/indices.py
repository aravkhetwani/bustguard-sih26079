"""Climate-driver indices from NOAA PSL (ENSO Nino3.4, Indian Ocean Dipole)."""
import numpy as np
import pandas as pd

from config import NINO34_URL, DMI_URL, RAW
from pipeline.http import get_text


def _parse_psl(text, missing):
    rows = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 13 and parts[0].isdigit() and 1800 < int(parts[0]) < 2100:
            vals = [float(x) for x in parts[1:]]
            rows[int(parts[0])] = [np.nan if (v <= missing or v == -9999.0) else v for v in vals]
    idx, vals = [], []
    for y, v in sorted(rows.items()):
        for m, x in enumerate(v, start=1):
            idx.append(pd.Timestamp(y, m, 1))
            vals.append(x)
    return pd.Series(vals, index=pd.DatetimeIndex(idx))


def fetch():
    RAW.mkdir(parents=True, exist_ok=True)
    nino = _parse_psl(get_text(NINO34_URL), -99.0)
    dmi = _parse_psl(get_text(DMI_URL), -9000.0)
    df = pd.DataFrame({"nino34": nino, "dmi": dmi}).sort_index()
    df = df.loc["2020-01-01":]
    df.to_parquet(RAW / "indices_monthly.parquet")
    return df


def load():
    p = RAW / "indices_monthly.parquet"
    return pd.read_parquet(p) if p.exists() else fetch()


def asof(issue_dates):
    """Latest index value published before each issue date (previous complete month, forward-filled)."""
    df = load().ffill()
    idx = pd.DatetimeIndex(issue_dates)
    key = (idx.to_period("M") - 1).to_timestamp()
    out = df.reindex(key, method="ffill")
    out.index = idx
    return out


if __name__ == "__main__":
    d = fetch()
    print(d.tail(6))
