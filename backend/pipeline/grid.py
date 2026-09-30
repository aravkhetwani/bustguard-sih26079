"""Build the analysis grid from real boundary data (India point-of-view Natural Earth)."""
import json
import numpy as np
from shapely.geometry import shape, Point, mapping
from shapely.ops import unary_union
from shapely.prepared import prep

from config import GEO, BBOX, GRID_STEP_DEG, COAST_BUFFER_DEG, NE_INDIA_URL, NE_STATES_URL


def _download(url, path):
    import requests
    if path.exists() and path.stat().st_size > 1000:
        return
    print(f"downloading {url}")
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    path.write_bytes(r.content)


def build():
    GEO.mkdir(parents=True, exist_ok=True)
    p_c = GEO / "ne_10m_admin_0_countries_ind.geojson"
    p_s = GEO / "ne_10m_admin_1_states_provinces.geojson"
    _download(NE_INDIA_URL, p_c)
    _download(NE_STATES_URL, p_s)

    countries = json.loads(p_c.read_text(encoding="utf-8"))
    india = [f for f in countries["features"]
             if f["properties"].get("ADM0_A3") == "IND" or f["properties"].get("ISO_A3") == "IND"
             or f["properties"].get("NAME") == "India"]
    if not india:
        raise RuntimeError("India not found in country file")
    geom = unary_union([shape(f["geometry"]) for f in india])

    states = json.loads(p_s.read_text(encoding="utf-8"))
    st = [(f["properties"].get("name"), shape(f["geometry"])) for f in states["features"]
          if f["properties"].get("admin") == "India"]

    # simplified outline for the front end
    outline = geom.simplify(0.02, preserve_topology=True)
    (GEO / "india_outline.geojson").write_text(json.dumps(
        {"type": "Feature", "properties": {"name": "India"}, "geometry": mapping(outline)}), encoding="utf-8")

    buffered = prep(geom.buffer(COAST_BUFFER_DEG))
    lats = np.arange(BBOX["lat_min"], BBOX["lat_max"] + 1e-9, GRID_STEP_DEG)
    lons = np.arange(BBOX["lon_min"], BBOX["lon_max"] + 1e-9, GRID_STEP_DEG)
    pts = []
    for la in lats:
        for lo in lons:
            p = Point(lo, la)
            if not buffered.contains(p):
                continue
            name = None
            for n, g in st:
                if g.contains(p):
                    name = n
                    break
            if name is None:      # coastal / offshore centre: nearest state
                name = min(st, key=lambda t: t[1].distance(p))[0]
            pts.append({"lat": round(float(la), 3), "lon": round(float(lo), 3), "state": name})
    for i, p in enumerate(pts):
        p["id"] = i
    out = {"step": GRID_STEP_DEG, "points": pts}
    (GEO / "grid.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"grid: {len(pts)} cells at {GRID_STEP_DEG} deg")
    return out


def load():
    return json.loads((GEO / "grid.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    build()
