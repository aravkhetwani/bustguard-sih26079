import { getVerification } from "./api.js";
import { icon } from "./icons.js";
import { h, pct, fmt, countUp, errorBox, dateLabel } from "./util.js";

const d3 = window.d3;
const INK = "#0F1B25", TEAL = "#0B6472", RED = "#E4572E", GRID = "#E4DECF";

const FEATURE_LABELS = {
  lead: "Lead time", forecast: "Forecast level", gfs_jump: "Run-to-run change", gfs_lag_std: "Run-to-run spread",
  gfs_lag_range: "Run-to-run range", jma_gap: "GFS vs JMA gap", ecmwf_gap: "GFS vs ECMWF gap", mm_std: "Model spread",
  mm_range: "Model range", anomaly: "Departure from normal", anomaly_z: "Departure (std units)", abs_anomaly_z: "Extremeness",
  recent_mae: "Recent local error", recent_bias: "Recent local bias", nino34: "ENSO state", dmi: "Indian Ocean Dipole",
  doy_sin: "Season (sin)", doy_cos: "Season (cos)", lat: "Latitude", lon: "Longitude", elevation: "Elevation",
};

function svgIn(host, W, H) {
  return d3.select(host).html("").append("svg").attr("viewBox", `0 0 ${W} ${H}`);
}

function axes(svg, x, y, W, H, m, { xfmt, yfmt, xlabel, ylabel, xticks = 5, yticks = 5 } = {}) {
  svg.append("g").attr("class", "axis gl").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(yticks).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(yticks).tickSize(0).tickPadding(8).tickFormat(yfmt || d3.format(".0%"))).select(".domain").remove();
  const xa = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`);
  xa.call(x.bandwidth ? d3.axisBottom(x).tickSize(0).tickPadding(8) : d3.axisBottom(x).ticks(xticks).tickSize(0).tickPadding(8).tickFormat(xfmt || d3.format(".0%")));
  xa.select(".domain").attr("stroke", "#CFC8B5");
  if (xlabel) svg.append("text").attr("class", "axis").attr("x", (W + m.l - m.r) / 2).attr("y", H - 2).attr("text-anchor", "middle").append("tspan").text(xlabel).attr("fill", "#6C7A86").attr("font-family", "IBM Plex Mono").attr("font-size", 10);
  if (ylabel) svg.append("text").attr("transform", `translate(12,${(H - m.b + m.t) / 2}) rotate(-90)`).attr("text-anchor", "middle").attr("fill", "#6C7A86").attr("font-family", "IBM Plex Mono").attr("font-size", 10).text(ylabel);
}

function drawLine(svg, data, x, y, color, width = 2.2, dash = null) {
  const path = svg.append("path").datum(data).attr("fill", "none").attr("stroke", color).attr("stroke-width", width)
    .attr("stroke-linejoin", "round").attr("stroke-linecap", "round")
    .attr("d", d3.line().x((d) => x(d[0])).y((d) => y(d[1])));
  const L = path.node().getTotalLength();
  if (dash) { path.attr("stroke-dasharray", dash); }
  else { path.attr("stroke-dasharray", `${L} ${L}`).attr("stroke-dashoffset", L).transition().duration(1200).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0); }
  return path;
}

function reliabilityChart(host, m) {
  const W = 520, H = 320, mg = { l: 48, r: 14, t: 12, b: 40 };
  const cal = m.reliability.calibrated, raw = m.reliability.raw;
  const max = Math.max(d3.max(cal, (d) => Math.max(d.p_mean, d.obs_rate)), d3.max(raw, (d) => Math.max(d.p_mean, d.obs_rate))) * 1.12;
  const x = d3.scaleLinear().domain([0, max]).range([mg.l, W - mg.r]);
  const y = d3.scaleLinear().domain([0, max]).range([H - mg.b, mg.t]);
  const svg = svgIn(host, W, H);
  axes(svg, x, y, W, H, mg, { xlabel: "Predicted probability", ylabel: "Observed frequency" });
  svg.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(max)).attr("y2", y(max)).attr("stroke", "#9A9581").attr("stroke-dasharray", "4 4");
  svg.append("text").attr("x", x(max) - 6).attr("y", y(max) + 14).attr("text-anchor", "end").attr("font-size", 10).attr("fill", "#9A9581").attr("font-family", "IBM Plex Mono").text("perfect calibration");
  drawLine(svg, raw.map((d) => [d.p_mean, d.obs_rate]), x, y, "#B9B3A0", 1.6, "3 3");
  drawLine(svg, cal.map((d) => [d.p_mean, d.obs_rate]), x, y, TEAL, 2.6);
  const r = d3.scaleSqrt().domain([0, d3.max(cal, (d) => d.n)]).range([3, 9]);
  svg.selectAll("circle.c").data(cal).enter().append("circle").attr("cx", (d) => x(d.p_mean)).attr("cy", (d) => y(d.obs_rate))
    .attr("r", 0).attr("fill", TEAL).attr("stroke", "#fff").attr("stroke-width", 1.5)
    .transition().delay((_, i) => 400 + i * 60).duration(500).attr("r", (d) => r(d.n));
  const lg = svg.append("g").attr("transform", `translate(${mg.l + 10},${mg.t + 8})`);
  [[TEAL, "Calibrated model", ""], ["#B9B3A0", "Before calibration", "3 3"]].forEach(([c, t, dsh], i) => {
    lg.append("line").attr("x1", 0).attr("x2", 18).attr("y1", i * 16).attr("y2", i * 16).attr("stroke", c).attr("stroke-width", 2.4).attr("stroke-dasharray", dsh);
    lg.append("text").attr("x", 24).attr("y", i * 16 + 3.5).attr("font-size", 11).attr("fill", INK).text(t);
  });
}

function prChart(host, m) {
  const W = 520, H = 320, mg = { l: 48, r: 14, t: 12, b: 40 };
  const pr = m.pr_curve.slice().sort((a, b) => a.recall - b.recall);
  const x = d3.scaleLinear().domain([0, 1]).range([mg.l, W - mg.r]);
  const y = d3.scaleLinear().domain([0, Math.min(1, d3.max(pr, (d) => d.precision) * 1.1)]).range([H - mg.b, mg.t]);
  const svg = svgIn(host, W, H);
  axes(svg, x, y, W, H, mg, { xlabel: "Recall (share of busts caught)", ylabel: "Precision" });
  const base = m.lightgbm_calibrated.base_rate;
  svg.append("line").attr("x1", x(0)).attr("x2", x(1)).attr("y1", y(base)).attr("y2", y(base)).attr("stroke", "#9A9581").attr("stroke-dasharray", "4 4");
  svg.append("text").attr("x", x(1) - 4).attr("y", y(base) - 6).attr("text-anchor", "end").attr("font-size", 10).attr("fill", "#9A9581").attr("font-family", "IBM Plex Mono").text(`no skill = base rate ${pct(base, 1)}`);
  const area = svg.append("path").datum(pr).attr("fill", TEAL).attr("opacity", 0)
    .attr("d", d3.area().x((d) => x(d.recall)).y0(y(0)).y1((d) => y(d.precision)));
  area.transition().delay(600).duration(800).attr("opacity", 0.10);
  drawLine(svg, pr.map((d) => [d.recall, d.precision]), x, y, TEAL, 2.6);
  const g = svg.append("g").attr("transform", `translate(${x(0.42)},${y(d3.max(pr, (d) => d.precision) * 0.96)})`);
  g.append("text").attr("font-family", "Fraunces").attr("font-size", 26).attr("font-weight", 600).attr("fill", INK).text(`PR-AUC ${fmt(m.lightgbm_calibrated.pr_auc, 2)}`);
  g.append("text").attr("y", 18).attr("font-size", 11).attr("fill", "#6C7A86").text(`spread-only baseline ${fmt(m.baseline_spread_only.pr_auc, 2)}`);
}

function backtestChart(host, m) {
  const rows = m.backtest_monthly;
  const W = 760, H = 300, mg = { l: 48, r: 14, t: 16, b: 44 };
  const x = d3.scaleBand().domain(rows.map((r) => r.month)).range([mg.l, W - mg.r]).padding(0.28);
  const ymax = Math.max(d3.max(rows, (r) => r.precision || 0), d3.max(rows, (r) => r.base_rate)) * 1.15;
  const y = d3.scaleLinear().domain([0, ymax]).range([H - mg.b, mg.t]);
  const svg = svgIn(host, W, H);
  axes(svg, x, y, W, H, mg, { yfmt: d3.format(".0%") });
  svg.selectAll(".tick text").filter(function (_, i) { return i % 2 === 1 && rows.length > 12; }).attr("opacity", 0);
  const bars = svg.selectAll("rect.b").data(rows.filter((r) => r.precision !== null)).enter().append("rect")
    .attr("x", (d) => x(d.month)).attr("width", x.bandwidth()).attr("y", y(0)).attr("height", 0).attr("rx", 4).attr("fill", RED);
  bars.transition().delay((_, i) => 200 + i * 50).duration(700).ease(d3.easeCubicOut)
    .attr("y", (d) => y(d.precision)).attr("height", (d) => y(0) - y(d.precision));
  bars.append("title").text((d) => `${d.month}: ${d.flagged_busts} of ${d.flagged} high-tier warnings busted (${pct(d.precision, 0)}); base rate ${pct(d.base_rate, 0)}`);
  const line = d3.line().x((d) => x(d.month) + x.bandwidth() / 2).y((d) => y(d.base_rate));
  const p = svg.append("path").datum(rows).attr("d", line).attr("fill", "none").attr("stroke", INK).attr("stroke-width", 2).attr("stroke-dasharray", "5 4");
  p.attr("opacity", 0).transition().delay(500).duration(600).attr("opacity", 1);
  const lg = svg.append("g").attr("transform", `translate(${mg.l + 8},${mg.t})`);
  lg.append("rect").attr("width", 12).attr("height", 12).attr("rx", 3).attr("fill", RED);
  lg.append("text").attr("x", 18).attr("y", 10).attr("font-size", 11).attr("fill", INK).text("Share of high-tier warnings that busted");
  lg.append("line").attr("x1", 250).attr("x2", 272).attr("y1", 6).attr("y2", 6).attr("stroke", INK).attr("stroke-width", 2).attr("stroke-dasharray", "5 4");
  lg.append("text").attr("x", 278).attr("y", 10).attr("font-size", 11).attr("fill", INK).text("Base rate that month");
}

function leadChart(host, m) {
  const leads = Object.keys(m.by_lead).map(Number).sort((a, b) => a - b);
  const W = 520, H = 280, mg = { l: 48, r: 14, t: 14, b: 40 };
  const x = d3.scaleBand().domain(leads.map((l) => `Day ${l}`)).range([mg.l, W - mg.r]).padding(0.34);
  const ymax = d3.max(leads, (l) => m.by_lead[l].pr_auc) * 1.2;
  const y = d3.scaleLinear().domain([0, ymax]).range([H - mg.b, mg.t]);
  const svg = svgIn(host, W, H);
  axes(svg, x, y, W, H, mg, { yfmt: d3.format(".0%") });
  const bars = svg.selectAll("rect").data(leads).enter().append("rect").attr("x", (l) => x(`Day ${l}`)).attr("width", x.bandwidth())
    .attr("y", y(0)).attr("height", 0).attr("rx", 5).attr("fill", TEAL);
  bars.transition().delay((_, i) => 150 + i * 80).duration(750).ease(d3.easeCubicOut).attr("y", (l) => y(m.by_lead[l].pr_auc)).attr("height", (l) => y(0) - y(m.by_lead[l].pr_auc));
  svg.selectAll("text.v").data(leads).enter().append("text").attr("x", (l) => x(`Day ${l}`) + x.bandwidth() / 2).attr("y", (l) => y(m.by_lead[l].pr_auc) - 7)
    .attr("text-anchor", "middle").attr("font-size", 11).attr("font-weight", 600).attr("fill", INK).attr("opacity", 0).text((l) => fmt(m.by_lead[l].pr_auc, 2))
    .transition().delay((_, i) => 700 + i * 80).attr("opacity", 1);
  svg.selectAll("line.br").data(leads).enter().append("line").attr("x1", (l) => x(`Day ${l}`) - 4).attr("x2", (l) => x(`Day ${l}`) + x.bandwidth() + 4)
    .attr("y1", (l) => y(m.by_lead[l].base_rate)).attr("y2", (l) => y(m.by_lead[l].base_rate)).attr("stroke", INK).attr("stroke-width", 2).attr("stroke-dasharray", "4 3");
  const lg = svg.append("g").attr("transform", `translate(${W - 200},${mg.t})`);
  lg.append("rect").attr("width", 12).attr("height", 12).attr("rx", 3).attr("fill", TEAL);
  lg.append("text").attr("x", 18).attr("y", 10).attr("font-size", 11).text("PR-AUC");
  lg.append("line").attr("x1", 70).attr("x2", 92).attr("y1", 6).attr("y2", 6).attr("stroke", INK).attr("stroke-width", 2).attr("stroke-dasharray", "4 3");
  lg.append("text").attr("x", 98).attr("y", 10).attr("font-size", 11).text("Base rate");
}

function importanceChart(host, m) {
  const rows = m.shap_importance.slice(0, 9);
  const W = 520, H = 280, mg = { l: 150, r: 20, t: 8, b: 26 };
  const y = d3.scaleBand().domain(rows.map((r) => FEATURE_LABELS[r.feature] || r.feature)).range([mg.t, H - mg.b]).padding(0.28);
  const x = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.mean_abs_shap) * 1.1]).range([mg.l, W - mg.r]);
  const svg = svgIn(host, W, H);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${mg.l},0)`).call(d3.axisLeft(y).tickSize(0).tickPadding(10)).select(".domain").remove();
  svg.selectAll("text").attr("font-size", 11.5).attr("fill", INK).attr("font-family", "IBM Plex Sans");
  const bars = svg.selectAll("rect").data(rows).enter().append("rect").attr("x", mg.l).attr("y", (r) => y(FEATURE_LABELS[r.feature] || r.feature))
    .attr("height", y.bandwidth()).attr("width", 0).attr("rx", 4).attr("fill", (_, i) => (i < 3 ? RED : "#D9A48F"));
  bars.transition().delay((_, i) => 100 + i * 70).duration(800).ease(d3.easeCubicOut).attr("width", (r) => x(r.mean_abs_shap) - mg.l);
  svg.append("text").attr("x", (W + mg.l) / 2).attr("y", H - 4).attr("text-anchor", "middle").attr("font-size", 10).attr("fill", "#6C7A86").attr("font-family", "IBM Plex Mono").text("Mean absolute SHAP value, test period");
}

export async function renderVerification(ctx) {
  const { root, state } = ctx;
  root.innerHTML = `<div class="v-grid view-enter"><div class="skel span-12" style="height:140px;grid-column:1/-1"></div></div>`;
  let v;
  try { v = await getVerification(); } catch (e) { root.innerHTML = errorBox(e.message); return; }
  const m = v.metrics[state.variable];
  const cal = m.lightgbm_calibrated, base = m.baseline_spread_only, raw = m.lightgbm_raw;
  const tc = m.tier_check;
  const live = v.live || {};
  const firstEta = live.first_issue ? new Date(new Date(live.first_issue + "T00:00:00Z").getTime() + (3 + 6) * 864e5).toISOString().slice(0, 10) : null;

  root.innerHTML = "";
  const view = h(`
  <div class="v-grid view-enter">
    <div class="kpis">
      <div class="card kpi"><div class="k-l">PR-AUC</div><div class="k-n" data-n="${cal.pr_auc}" data-d="2">0</div>
        <div class="k-s">Spread-only baseline <b>${fmt(base.pr_auc, 2)}</b> · random <b>${fmt(cal.base_rate, 2)}</b></div></div>
      <div class="card kpi"><div class="k-l">Lift, top 10% of warnings</div><div class="k-n"><span data-n="${cal.top10.lift}" data-d="1">0</span>×</div>
        <div class="k-s"><b>${pct(cal.top10.precision, 0)}</b> of them busted, against <b>${pct(cal.base_rate, 0)}</b> overall</div></div>
      <div class="card kpi"><div class="k-l">ROC-AUC</div><div class="k-n" data-n="${cal.roc_auc}" data-d="2">0</div>
        <div class="k-s">Baseline <b>${fmt(base.roc_auc, 2)}</b> · ${cal.n.toLocaleString()} held-out forecasts</div></div>
      <div class="card kpi"><div class="k-l">Calibration error (ECE)</div><div class="k-n" data-n="${cal.ece * 100}" data-d="1" data-suf="%">0</div>
        <div class="k-s">Before calibration <b>${pct(raw.ece, 1)}</b> · Brier <b>${fmt(cal.brier, 3)}</b></div></div>
    </div>

    <div class="card v-card span-6"><h3>Are the probabilities honest?</h3><div class="sub">Predicted bust probability against how often busts actually occurred. On the diagonal is ideal.</div><div id="ch-rel"></div></div>
    <div class="card v-card span-6"><h3>How many busts do we catch?</h3><div class="sub">Precision against recall across warning thresholds, on data the model never saw.</div><div id="ch-pr"></div></div>

    <div class="card v-card span-8"><h3>Rolling backtest by month</h3>
      <div class="sub">High-tier warnings issued in ${m.periods.test_start} to ${m.periods.test_end}, scored against ERA5 once the day passed.</div><div id="ch-bt"></div></div>
    <div class="card v-card span-4" style="display:flex;flex-direction:column;justify-content:center;gap:14px">
      <div class="eyebrow">High-tier check</div>
      <div><div style="font-family:var(--serif);font-size:44px;font-weight:600;line-height:1"><span data-n="${(tc.high.bust_rate || 0) * 100}" data-d="0" data-suf="%">0</span></div>
        <div style="font-size:13px;color:var(--ink-2);margin-top:6px">of forecasts flagged <b>high risk</b> (${pct(tc.high.share, 0)} of all) busted.</div></div>
      <div><div style="font-family:var(--serif);font-size:30px;font-weight:600;line-height:1;color:var(--ink-3)"><span data-n="${tc.rest.bust_rate * 100}" data-d="0" data-suf="%">0</span></div>
        <div style="font-size:13px;color:var(--ink-2);margin-top:6px">of all other forecasts busted.</div></div>
      <div class="note" style="padding:0">Chosen from the calibration block only: elevated is the top 30% of scores, high the top 10%.</div>
    </div>

    <div class="card v-card span-6"><h3>Skill by lead time</h3><div class="sub">Later leads are harder; the dashed line is the no-skill level.</div><div id="ch-lead"></div></div>
    <div class="card v-card span-6"><h3>What the model relies on</h3><div class="sub">Global SHAP importance across the test period. Red bars are the top three.</div><div id="ch-imp"></div></div>

    <div class="card live-box span-12">
      <div><div class="eyebrow">Live scoreboard</div><div class="big" data-n="${live.verified || 0}" data-d="0">0</div><div class="lb-l">warnings verified so far</div></div>
      <div style="font-size:13px;color:var(--ink-2)">
        <b>${(live.stored_predictions || 0).toLocaleString()}</b> live warnings stored since ${live.first_issue ? dateLabel(live.first_issue) : "launch"}.
        Each is scored against ERA5 once its day has passed and ERA5 is published, about six days later.
        ${live.verified ? "" : `The first outcomes arrive around <b>${firstEta ? dateLabel(firstEta) : "soon"}</b>. Until then, the held-out backtest above is the evidence.`}
        ${live.by_variable ? `<table class="table" style="margin-top:10px"><thead><tr><th>Variable</th><th class="num">Verified</th><th class="num">Busted</th><th class="num">High-tier hit rate</th></tr></thead><tbody>
          ${live.by_variable.map((r) => `<tr><td>${r.variable}</td><td class="num">${r.n}</td><td class="num">${pct(r.bust_rate, 0)}</td><td class="num">${r.high_hit === null ? "n/a" : pct(r.high_hit, 0)}</td></tr>`).join("")}</tbody></table>` : ""}
      </div>
    </div>

    <div class="callout span-12" style="grid-column:1/-1">${icon("info", 18)}<div><b>Read these numbers with care.</b> The model was trained on ${m.counts.train.toLocaleString()} forecasts up to ${m.periods.train_end}, calibrated on ${m.counts.calib.toLocaleString()} more, and scored on ${m.counts.test.toLocaleString()} forecasts from ${m.periods.test_start}. Truth is the ERA5 reanalysis, not station observations, and the test period covers roughly two years, so seasonal and regime coverage is limited.</div></div>
  </div>`);
  root.appendChild(view);
  view.querySelectorAll("[data-n]").forEach((n) => {
    const d = +n.dataset.d, suf = n.dataset.suf || "";
    countUp(n, +n.dataset.n, { dur: 1000, fmt: (x) => x.toFixed(d) + suf });
  });
  reliabilityChart(view.querySelector("#ch-rel"), m);
  prChart(view.querySelector("#ch-pr"), m);
  backtestChart(view.querySelector("#ch-bt"), m);
  leadChart(view.querySelector("#ch-lead"), m);
  importanceChart(view.querySelector("#ch-imp"), m);
}
