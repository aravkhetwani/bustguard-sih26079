"""Pipeline entry point.

  python run.py setup     # grid + climate indices (one-off)
  python run.py ingest    # archived forecasts + ERA5 truth (resumable, respects API quota)
  python run.py train     # labels, features, model, calibration, metrics.json
  python run.py daily     # live inference for today + verification of past warnings
  python run.py serve     # API + web app on http://localhost:8000
"""
import subprocess
import sys


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "setup":
        from pipeline import grid, indices
        grid.build()
        indices.fetch()
    elif cmd == "ingest":
        from pipeline import ingest_history as ih
        import datetime as dt
        today = dt.date.today()
        ih.ingest_truth((today - dt.timedelta(days=6)).isoformat())
        ih.ingest_forecasts((today - dt.timedelta(days=1)).isoformat())
    elif cmd == "train":
        from pipeline import build_dataset, train
        build_dataset.main()
        train.main()
    elif cmd == "daily":
        from pipeline import infer, verify, indices
        indices.fetch()
        infer.run()
        verify.run()
    elif cmd == "serve":
        subprocess.run([sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8000"], check=True)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
