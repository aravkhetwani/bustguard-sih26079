"""HTTP helper with retry / back-off for the Open-Meteo free tier."""
import time
import requests

_session = requests.Session()
_session.headers["User-Agent"] = "BustGuard/0.1 (SIH26079 research prototype)"


def get_json(url, params=None, retries=14, timeout=120, pause=0.0):
    last = None
    for attempt in range(retries):
        try:
            r = _session.get(url, params=params, timeout=timeout)
            if r.status_code == 200:
                if pause:
                    time.sleep(pause)
                return r.json()
            last = f"HTTP {r.status_code}: {r.text[:200]}"
            if r.status_code == 429 or "limit" in r.text.lower():
                low = r.text.lower()
                wait = 65 if "minutely" in low else (600 if "hourly" in low else (3600 if "daily" in low else 65))
                print(f"  rate-limited, waiting {wait}s ({last[:90]})", flush=True)
                time.sleep(wait)
                if "minutely" not in low:
                    attempt = max(0, attempt - 1)      # quota resets on its own; keep waiting
                continue
            if r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(last)
        except requests.RequestException as e:
            last = repr(e)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"giving up on {url}: {last}")


def get_text(url, timeout=120):
    r = _session.get(url, timeout=timeout)
    r.raise_for_status()
    return r.text
