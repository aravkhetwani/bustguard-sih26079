"""Turn SHAP contributions into plain-language reasons a forecaster can read."""
import math

LABELS = {
    "lead": "Lead time", "forecast": "Forecast level", "gfs_jump": "Run-to-run change",
    "gfs_lag_std": "Run-to-run spread", "gfs_lag_range": "Run-to-run range", "jma_gap": "GFS vs JMA gap",
    "ecmwf_gap": "GFS vs ECMWF gap", "mm_std": "Model spread", "mm_range": "Model range",
    "anomaly": "Departure from normal", "anomaly_z": "Departure from normal", "abs_anomaly_z": "Extremeness",
    "recent_mae": "Recent local error", "recent_bias": "Recent local bias", "nino34": "ENSO state",
    "dmi": "Indian Ocean Dipole", "doy_sin": "Time of year", "doy_cos": "Time of year",
    "lat": "Location", "lon": "Location", "elevation": "Elevation",
}


def _fmt(v, nd=1):
    return "n/a" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:.{nd}f}"


def phrase(feature, value, raises, unit="°C"):
    up = raises
    v = value
    if feature == "gfs_lag_std":
        return (f"Successive GFS runs disagree by about {_fmt(v)}{unit} for this day" if up
                else f"Successive GFS runs agree closely (spread {_fmt(v)}{unit})")
    if feature == "gfs_lag_range":
        return (f"GFS runs for this day span {_fmt(v)}{unit}" if up else f"GFS runs for this day span only {_fmt(v)}{unit}")
    if feature == "gfs_jump":
        return (f"The newest GFS run moved {_fmt(v)}{unit} from the previous one" if up
                else f"The newest GFS run is stable ({_fmt(v)}{unit} change)")
    if feature == "jma_gap":
        return (f"GFS and JMA differ by {_fmt(abs(v) if v is not None else None)}{unit}" if up
                else f"GFS and JMA agree within {_fmt(abs(v) if v is not None else None)}{unit}")
    if feature == "ecmwf_gap":
        return (f"GFS and ECMWF differ by {_fmt(abs(v) if v is not None else None)}{unit}" if up
                else f"GFS and ECMWF agree within {_fmt(abs(v) if v is not None else None)}{unit}")
    if feature == "mm_std":
        return (f"The models disagree with a spread of {_fmt(v)}{unit}" if up else f"The models are tightly clustered (spread {_fmt(v)}{unit})")
    if feature == "mm_range":
        return (f"Warmest and coolest model differ by {_fmt(v)}{unit}" if up else f"Warmest and coolest model differ by only {_fmt(v)}{unit}")
    if feature == "anomaly":
        d = "n/a" if v is None else f"{abs(v):.1f}{unit} {'above' if v >= 0 else 'below'}"
        return f"Forecast is {d} the seasonal norm"
    if feature == "anomaly_z":
        d = "n/a" if v is None else f"{abs(v):.1f} standard deviations {'above' if v >= 0 else 'below'}"
        return f"Forecast is {d} the seasonal norm"
    if feature == "abs_anomaly_z":
        return (f"Forecast is unusual for the season ({_fmt(v)} standard deviations)" if up
                else f"Forecast is close to seasonal norms ({_fmt(v)} standard deviations)")
    if feature == "recent_mae":
        return (f"GFS has recently missed here by about {_fmt(v)}{unit}" if up
                else f"GFS has recently been accurate here ({_fmt(v)}{unit} average miss)")
    if feature == "recent_bias":
        return f"Recent GFS bias at this location is {_fmt(v)}{unit}"
    if feature == "nino34":
        return f"ENSO background state (Nino 3.4 anomaly {_fmt(v)})"
    if feature == "dmi":
        return f"Indian Ocean Dipole background state (DMI {_fmt(v)})"
    if feature == "lead":
        return "Longer lead time adds uncertainty" if up else "Shorter lead time limits uncertainty"
    if feature == "forecast":
        return f"Forecast temperature level ({_fmt(v)}{unit})"
    if feature in ("doy_sin", "doy_cos"):
        return "Time of year (seasonal regime)"
    if feature in ("lat", "lon"):
        return "Regional forecast reliability differs across India"
    if feature == "elevation":
        return f"Terrain effects at {_fmt(v, 0)} m elevation"
    return LABELS.get(feature, feature)


CONTEXT = {"lead", "forecast", "doy_sin", "doy_cos", "lat", "lon", "elevation", "nino34", "dmi"}


def top_drivers(features, row_values, shap_values, k=4):
    """Rank forecast-signal drivers first (spread, gaps, jumps, extremeness, recent skill);
    background context (season, place, ENSO) fills remaining slots."""
    def clean(v):
        return None if (v is None or (isinstance(v, float) and math.isnan(v))) else float(v)
    pairs = sorted(zip(features, row_values, shap_values), key=lambda t: -abs(t[2]))
    signal = [p for p in pairs if p[0] not in CONTEXT]
    context = [p for p in pairs if p[0] in CONTEXT]
    ordered = signal[:3] + context[:1] + signal[3:] + context[1:]
    seen, out = set(), []
    for f, v, s in ordered:
        label = LABELS.get(f, f)
        if label in seen:
            continue
        seen.add(label)
        raises = s > 0
        out.append({"feature": f, "label": label, "shap": float(s), "effect": "raises" if raises else "lowers",
                    "value": clean(v), "text": phrase(f, clean(v), raises)})
        if len(out) >= k:
            break
    return out
