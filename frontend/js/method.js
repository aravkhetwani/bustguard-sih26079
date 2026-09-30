import { getHealth, getVerification } from "./api.js";
import { icon } from "./icons.js";
import { h, errorBox } from "./util.js";

const STEPS = [
  { i: "satellite-dish", t: "Ingest", s: "public APIs", p: "Archived forecasts from the Open-Meteo Previous Runs API (GFS, JMA, ECMWF IFS), ERA5 truth from the Open-Meteo Archive, and ENSO and Indian Ocean Dipole indices from NOAA PSL. Everything is cached as Parquet so every run is reproducible.", tags: ["Open-Meteo", "ERA5", "NOAA PSL"] },
  { i: "tags", t: "Label", s: "what counts as a bust", p: "Error is the GFS forecast minus ERA5 for the same local day. A forecast is a bust when its absolute error exceeds the 90th percentile of that location's errors for the same lead time and season (winter, pre-monsoon, monsoon, post-monsoon), learned on the training period only.", tags: ["|forecast − ERA5|", "P90 per cell, lead, season"] },
  { i: "layers", t: "Featurise", s: "known at issue time", p: "Only information available when the forecast is issued: spread and range across successive GFS runs for the same day, run-to-run change, GFS vs JMA and ECMWF gaps, model spread, departure from the seasonal norm, recent local error, ENSO and IOD state, season and location.", tags: ["lagged-run spread", "model gap", "recent skill", "ENSO · IOD"] },
  { i: "brain-circuit", t: "Predict", s: "calibrated risk", p: "A LightGBM classifier gives the raw bust score, isotonic regression calibrates it on a separate block of time, and quantile regressors give the expected size of the miss. Tiers come from the calibration block: elevated is the top 30% of scores and high the top 10%.", tags: ["LightGBM", "isotonic calibration", "quantile 10 / 50 / 90"] },
  { i: "message-square-text", t: "Explain", s: "SHAP", p: "Each warning lists the features that pushed its score up or down, translated to plain language. Forecast-signal drivers (spread, model gaps, recent skill) are ranked ahead of background context such as season and location.", tags: ["TreeSHAP", "plain-language reasons"] },
  { i: "shield-check", t: "Verify", s: "closing the loop", p: "Held-out backtest metrics come from a time-block split with no shuffling. Live warnings are stored and scored against ERA5 as soon as the verifying day is published, so accuracy is public and accumulates.", tags: ["PR-AUC", "Brier", "reliability", "live scoreboard"] },
];

const LIMITS = [
  "The forecast being judged is the GFS. ECMWF IFS and JMA are used as disagreement signals, not judged themselves.",
  "The live ECMWF ensemble is shown for context but is not a model input: no archive of past ensembles is available, so training uses spread across successive GFS runs instead.",
  "Truth is the ERA5 reanalysis at 0.25 degrees, not station observations. Cross-checking against IMD gridded data is the next step.",
  "Scope is maximum and minimum temperature on a 2.5 degree grid (about 66 cells). Rainfall and cyclone tracks are not yet covered.",
  "Training covers January 2023 to June 2024, calibration the rest of 2024, and testing 2025 onwards. Roughly two years of testing limits regime and seasonal coverage.",
  "Lead times run from day 3 to day 7. At days 6 and 7 fewer successive runs exist, so the spread signal is weaker.",
  "A bust is defined relative to local error (P90), so about one forecast in ten is a bust by construction.",
  "MJO is not used: the public RMM index feed stopped updating in early 2024.",
  "Open-Meteo's free API is for non-commercial use under CC BY 4.0. A deployment would use a licensed feed or self-hosted open data.",
];

export async function renderMethod(ctx) {
  const { root, meta } = ctx;
  root.innerHTML = "";
  const view = h(`
  <div class="m-wrap view-enter">
    <section class="card stepper">
      <div class="eyebrow" style="margin-bottom:16px">Pipeline</div>
      ${STEPS.map((s, i) => `
        <div class="step" style="animation:viewIn .6s var(--ease) ${i * 70}ms both">
          <div class="sn">${icon(s.i, 20, 1.8)}</div>
          <div><h4>${i + 1}. ${s.t} <small>${s.s}</small></h4><p>${s.p}</p><div class="tags">${s.tags.map((t) => `<span>${t}</span>`).join("")}</div></div>
        </div>`).join("")}
    </section>
    <aside style="display:flex;flex-direction:column;gap:16px">
      <section class="card">
        <div class="card-h"><h3>Live data sources</h3><span class="sub" id="hs"></span><div class="spacer"></div>
          <button class="icon-btn" id="hrefresh" aria-label="Re-check sources" style="width:32px;height:32px">${icon("refresh-cw", 15)}</button></div>
        <div id="health" style="padding:8px 0 4px"><div class="skel" style="height:220px;margin:8px 16px"></div></div>
      </section>
      <section class="card" style="padding:16px 18px">
        <div class="sec-t">${icon("cpu", 14)} Model card</div>
        <table class="table"><tbody id="mcard"></tbody></table>
      </section>
    </aside>
    <section class="card" style="padding:18px 22px;grid-column:1/-1">
      <div class="sec-t">${icon("triangle-alert", 14)} Known limitations</div>
      <ul class="limits">${LIMITS.map((l) => `<li>${l}</li>`).join("")}</ul>
    </section>
  </div>`);
  root.appendChild(view);

  const loadHealth = async (fresh) => {
    const box = view.querySelector("#health");
    try {
      const hlt = await getHealth(fresh);
      view.querySelector("#hs").textContent = `checked ${hlt.checked_at.slice(11, 19)} UTC`;
      box.innerHTML = hlt.sources.map((s) => `
        <div class="src-row"><span class="sd ${s.ok ? "ok" : "bad"}"></span>
          <div><div class="sn2">${s.name}</div><div class="sm">${s.ok ? "reachable" : (s.error || "unreachable")}</div></div>
          <div class="sm">${s.ms} ms</div></div>`).join("");
    } catch (e) { box.innerHTML = errorBox(e.message); }
  };
  loadHealth(false);
  view.querySelector("#hrefresh").addEventListener("click", () => loadHealth(true));

  try {
    const v = await getVerification();
    const m = v.metrics.tmax;
    const rows = [
      ["Version", meta.model_version], ["Classifier", "LightGBM, 350 trees"], ["Calibration", "Isotonic"],
      ["Train", `to ${m.periods.train_end}`], ["Calibrate", `to ${m.periods.calib_end}`],
      ["Test", `${m.periods.test_start} to ${m.periods.test_end}`], ["Grid", `${meta.cells} cells · ${meta.grid_step}°`],
      ["Leads", "day 3 to day 7"], ["Issue date", meta.issue_date],
    ];
    view.querySelector("#mcard").innerHTML = rows.map(([k, val]) => `<tr><td style="color:var(--ink-3)">${k}</td><td class="num">${val}</td></tr>`).join("");
  } catch (e) { view.querySelector("#mcard").innerHTML = `<tr><td>${e.message}</td></tr>`; }
}
