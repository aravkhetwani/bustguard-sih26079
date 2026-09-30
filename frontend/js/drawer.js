import { getPoint, getLive } from "./api.js";
import { icon } from "./icons.js";
import { h, pct, fmt, dateLabel, dowShort, dayShort, errorBox } from "./util.js";
import { makeScale } from "./map.js";

const d3 = window.d3;
const drawer = document.getElementById("drawer");
const scrim = document.getElementById("scrim");
let current = null;   // { ctx, id, data }

const MODEL_STYLE = {
  gfs_seamless: { name: "GFS", color: "#0F1B25" },
  ecmwf_ifs025: { name: "ECMWF IFS", color: "#0B6472" },
  icon_seamless: { name: "ICON", color: "#D9822B" },
  jma_seamless: { name: "JMA", color: "#7B4FA3" },
};

const DRIVER_ICON = {
  gfs_lag_std: "activity", gfs_lag_range: "activity", gfs_jump: "activity",
  jma_gap: "git-compare-arrows", ecmwf_gap: "git-compare-arrows", mm_std: "git-compare-arrows", mm_range: "git-compare-arrows",
  anomaly: "thermometer-sun", anomaly_z: "thermometer-sun", abs_anomaly_z: "thermometer-sun",
  recent_mae: "clock", recent_bias: "clock", nino34: "waves", dmi: "waves", lead: "calendar-days",
  forecast: "thermometer", doy_sin: "calendar-days", doy_cos: "calendar-days", lat: "map-pin", lon: "map-pin", elevation: "map-pin",
};

export function initDrawer(closeCb) {
  scrim.addEventListener("click", closeCb);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer.classList.contains("on")) closeCb(); });
}

export function closeDrawer() {
  drawer.classList.remove("on");
  scrim.classList.remove("on");
  drawer.setAttribute("aria-hidden", "true");
  current = null;
}

export async function openDrawer(ctx, id) {
  const g = ctx.geo.grid.points.find((p) => p.id === id);
  drawer.classList.add("on");
  scrim.classList.add("on");
  drawer.setAttribute("aria-hidden", "false");
  drawer.innerHTML = `
    <div class="dr-head"><div><h2>${g.state}</h2><div class="loc"><span>${g.lat.toFixed(1)}°N · ${g.lon.toFixed(1)}°E</span><span>cell ${id}</span></div></div>
      <div class="spacer"></div><button class="icon-btn" id="dr-close" aria-label="Close">${icon("x", 18)}</button></div>
    <div class="dr-body"><div class="skel" style="height:150px"></div><div class="skel" style="height:64px"></div><div class="skel" style="height:190px"></div><div class="skel" style="height:260px"></div></div>`;
  drawer.querySelector("#dr-close").addEventListener("click", ctx.closeCell);
  drawer.scrollTop = 0;
  current = { ctx, id, data: null };
  let data;
  try {
    data = await getPoint(id, ctx.state.variable);
  } catch (e) {
    if (current && current.id === id) drawer.querySelector(".dr-body").innerHTML = errorBox(e.message);
    return;
  }
  if (!current || current.id !== id) return;
  current.data = data;
  render();
  drawer.querySelector("#dr-close").focus({ preventScroll: true });
}

export function refreshDrawer() { if (current && current.data) render(); }

function leadRow() { return current.data.leads.find((l) => l.lead === current.ctx.state.lead) || current.data.leads[0]; }

function render() {
  const { ctx, data } = current;
  const row = leadRow();
  const meta = ctx.meta;
  const varLabel = meta.variables[data.variable];
  const tiers = meta.tiers[data.variable];
  const scale = ctx.scale || makeScale(tiers, 0.4);

  drawer.innerHTML = `
    <div class="dr-head">
      <div>
        <div class="eyebrow">${varLabel} · day ${row.lead} · valid ${dateLabel(row.valid_date)}</div>
        <h2>${data.state}</h2>
        <div class="loc"><span>${data.lat.toFixed(1)}°N · ${data.lon.toFixed(1)}°E</span><span class="chip ${row.tier}">${row.tier} risk</span></div>
      </div>
      <div class="spacer"></div>
      <button class="icon-btn" id="dr-close" aria-label="Close">${icon("x", 18)}</button>
    </div>
    <div class="dr-body">
      <section class="card risk-hero" id="hero"></section>
      <section><div class="sec-t">${icon("calendar-days", 14)} Risk by lead time</div><div class="leads-strip" id="leads"></div></section>
      <section class="card"><div class="card-h"><h3>Why this warning</h3><span class="sub">largest drivers first</span></div><div id="drivers" style="padding:6px 0 4px"></div></section>
      <section class="card chart-card"><div class="card-h" style="padding:0 4px 6px"><h3>Forecast and live ensemble</h3></div>
        <div id="fchart"></div><div class="legend-row" id="flegend"></div><div class="note" id="fnote"></div></section>
      <section class="callout">${icon("scale", 18)}<div><b>What counts as a bust here.</b> ${row.thr !== null && row.thr !== undefined
          ? `The GFS forecast for ${dateLabel(row.valid_date)} is treated as a bust if it misses the ERA5 value by more than <b>${fmt(row.thr, 1)}°C</b>, the 90th-percentile miss for this location, lead time and season in the training period.`
          : "This location has no training history yet, so no local bust threshold has been learned. The risk score above uses the pooled model."}</div></section>
    </div>`;
  drawer.querySelector("#dr-close").addEventListener("click", ctx.closeCell);
  hero(row, scale, tiers);
  leads(scale);
  drivers(row);
  loadChart(row);
}

async function loadChart(row) {
  const { data } = current;
  const id = data.id;
  const host = drawer.querySelector("#fchart");
  host.innerHTML = `<div class="skel" style="height:250px"></div>`;
  try {
    if (!data.liveData) data.liveData = await getLive(id);
  } catch (e) {
    if (current && current.id === id) host.innerHTML = errorBox(`live forecast service: ${e.message}`);
    return;
  }
  if (!current || current.id !== id) return;
  forecastChart({ ...data, live: data.liveData.live, live_errors: data.liveData.live_errors, fetched_at: data.liveData.fetched_at }, leadRowNow());
}

function leadRowNow() { return leadRow(); }

function hero(row, scale, tiers) {
  const el = drawer.querySelector("#hero");
  const gmax = scale.top;
  const frac = Math.min(1, row.p / gmax);
  const len = Math.PI * 80;
  const col = scale.color(row.p);
  const gid = "gg" + Math.random().toString(36).slice(2, 7);
  const tick = (v) => { const a = Math.PI * (1 - v / gmax); return [100 + 80 * Math.cos(a), 100 - 80 * Math.sin(a), 100 + 92 * Math.cos(a), 100 - 92 * Math.sin(a)]; };
  const t1 = tick(tiers.elevated), t2 = tick(tiers.high);
  const M = Math.max(row.q90, row.thr || 0) * 1.3 || 1;
  const L = (v) => `${Math.min(100, (v / M) * 100)}%`;
  el.innerHTML = `
    <div class="gauge">
      <svg viewBox="0 0 200 116" aria-hidden="true">
        <defs><linearGradient id="${gid}" x1="0" x2="1">${[0, .33, .66, 1].map((f) => `<stop offset="${f * 100}%" stop-color="${scale.color(f * gmax)}"/>`).join("")}</linearGradient></defs>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="#E4DECF" stroke-width="14" stroke-linecap="round"/>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="url(#${gid})" stroke-width="14" stroke-linecap="round" opacity=".28"/>
        <path id="gv" d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 ${len}"/>
        <line x1="${t1[0]}" y1="${t1[1]}" x2="${t1[2]}" y2="${t1[3]}" stroke="#6C7A86" stroke-width="1.5"/>
        <line x1="${t2[0]}" y1="${t2[1]}" x2="${t2[2]}" y2="${t2[3]}" stroke="#6C7A86" stroke-width="1.5"/>
      </svg>
      <div class="gv"><b id="gnum">0%</b><span>BUST PROBABILITY</span></div>
    </div>
    <div class="hero-r">
      <h4>Expected size of the miss</h4>
      <div class="miss">
        <div class="track">
          <div class="axis"></div>
          <div class="rng" style="left:${L(row.q10)};width:calc(${L(row.q90)} - ${L(row.q10)})"></div>
          <div class="med" style="left:${L(row.q50)}"></div>
          ${row.thr ? `<div class="thr" style="left:${L(row.thr)}"><span>bust &gt; ${fmt(row.thr, 1)}°C</span></div>` : ""}
        </div>
        <div class="lab"><span>0°C</span><span>${fmt(row.q10, 1)} to ${fmt(row.q90, 1)}°C (80% range)</span><span>${fmt(M, 1)}°C</span></div>
      </div>
      <p class="note" style="padding:8px 0 0">Typical miss <b>${fmt(row.q50, 1)}°C</b>. Forecast for the day: <b>${fmt(row.forecast, 1)}°C</b>.</p>
    </div>`;
  const path = el.querySelector("#gv");
  const num = el.querySelector("#gnum");
  d3.select(path).transition().duration(1100).ease(d3.easeCubicOut)
    .attrTween("stroke-dasharray", () => (t) => `${len * frac * t} ${len}`);
  d3.select(num).transition().duration(1100).ease(d3.easeCubicOut)
    .tween("text", () => { const i = d3.interpolateNumber(0, row.p * 100); return (t) => { num.textContent = `${i(t).toFixed(1)}%`; }; });
}

function leads(scale) {
  const el = drawer.querySelector("#leads");
  const { ctx, data } = current;
  el.innerHTML = data.leads.map((l) => `
    <button class="lead-tile" data-l="${l.lead}" aria-pressed="${l.lead === ctx.state.lead}">
      <div class="d">Day ${l.lead}</div><div class="v">${pct(l.p, 0)}</div>
      <div class="b"><i style="background:${scale.color(l.p)}" data-w="${Math.min(100, (l.p / scale.top) * 100)}"></i></div>
    </button>`).join("");
  requestAnimationFrame(() => el.querySelectorAll(".b i").forEach((b) => (b.style.width = `${b.dataset.w}%`)));
  el.querySelectorAll(".lead-tile").forEach((b) => b.addEventListener("click", () => ctx.setLead(+b.dataset.l)));
}

function drivers(row) {
  const el = drawer.querySelector("#drivers");
  const maxS = d3.max(row.drivers, (d) => Math.abs(d.shap)) || 1;
  el.innerHTML = row.drivers.map((d) => `
    <div class="drv">
      <div class="di ${d.effect}">${icon(DRIVER_ICON[d.feature] || "activity", 16, 2)}</div>
      <div><div class="dt">${d.text}</div>
        <div class="dl"><span>${d.effect === "raises" ? "raises risk" : "lowers risk"}</span>
          <span class="mag"><i style="background:${d.effect === "raises" ? "#E4572E" : "#2E7D5B"}" data-w="${(Math.abs(d.shap) / maxS) * 100}"></i></span></div></div>
    </div>`).join("");
  requestAnimationFrame(() => el.querySelectorAll(".mag i").forEach((b, i) => setTimeout(() => (b.style.width = `${b.dataset.w}%`), 120 + i * 90)));
}

function forecastChart(data, row) {
  const host = drawer.querySelector("#fchart");
  const legend = drawer.querySelector("#flegend");
  const note = drawer.querySelector("#fnote");
  const v = data.variable;
  const ens = data.live.ensemble ? data.live.ensemble[v] : null;
  const models = data.live.models || null;
  const errs = Object.entries(data.live_errors || {});
  if (!ens && !models) {
    host.innerHTML = errorBox(`Live forecast APIs did not respond (${errs.map(([k, m]) => `${k}: ${m}`).join("; ") || "unknown"}). No values are shown rather than placeholders.`);
    return;
  }
  const days = ens ? Object.keys(ens).sort() : Object.keys(models[Object.keys(models)[0]][v]).sort();
  const W = 548, H = 250, m = { l: 36, r: 12, t: 12, b: 26 };
  const x = d3.scalePoint().domain(days).range([m.l, W - m.r]).padding(0.4);
  const vals = [];
  if (ens) days.forEach((d) => ens[d] && vals.push(ens[d].min, ens[d].max));
  if (models) Object.values(models).forEach((mm) => days.forEach((d) => mm[v][d] != null && vals.push(mm[v][d])));
  const y = d3.scaleLinear().domain([d3.min(vals) - 1.2, d3.max(vals) + 1.2]).nice().range([H - m.b, m.t]);

  const svg = d3.select(host).html("").append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
    .attr("aria-label", `Eight-day ${data.variable === "tmax" ? "maximum" : "minimum"} temperature forecast with ensemble spread`);
  const clipId = "fc" + Math.random().toString(36).slice(2, 7);
  const clip = svg.append("defs").append("clipPath").attr("id", clipId).append("rect")
    .attr("x", 0).attr("y", 0).attr("height", H).attr("width", 0);
  clip.transition().duration(1300).ease(d3.easeCubicInOut).attr("width", W);

  svg.append("g").attr("class", "axis gl").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(6))
    .select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickSize(0).tickPadding(8).tickFormat((d) => `${dowShort(d)} ${dayShort(d).split(" ")[0]}`))
    .select(".domain").remove();

  // highlight the selected lead's valid day
  const selX = x(row.valid_date);
  if (selX !== undefined) {
    svg.append("rect").attr("x", selX - 20).attr("y", m.t).attr("width", 40).attr("height", H - m.t - m.b)
      .attr("fill", "#0B6472").attr("opacity", 0.07).attr("rx", 8);
  }

  const g = svg.append("g").attr("clip-path", `url(#${clipId})`);
  if (ens) {
    const band = (lo, hi, fill, op) => g.append("path").attr("fill", fill).attr("opacity", op)
      .attr("d", d3.area().defined((d) => ens[d]).x((d) => x(d)).y0((d) => y(ens[d][lo])).y1((d) => y(ens[d][hi])).curve(d3.curveMonotoneX)(days));
    band("min", "max", "#0B6472", 0.10);
    band("p10", "p90", "#0B6472", 0.16);
    band("p25", "p75", "#0B6472", 0.26);
    g.append("path").attr("fill", "none").attr("stroke", "#0B6472").attr("stroke-width", 1.4).attr("stroke-dasharray", "4 3")
      .attr("d", d3.line().defined((d) => ens[d]).x((d) => x(d)).y((d) => y(ens[d].p50)).curve(d3.curveMonotoneX)(days));
  }
  if (models) {
    Object.entries(models).forEach(([k, mm]) => {
      const st = MODEL_STYLE[k] || { color: "#888" };
      const p = g.append("path").attr("fill", "none").attr("stroke", st.color).attr("stroke-width", k === "gfs_seamless" ? 2.4 : 1.7)
        .attr("stroke-linejoin", "round").attr("stroke-linecap", "round")
        .attr("d", d3.line().defined((d) => mm[v][d] != null).x((d) => x(d)).y((d) => y(mm[v][d])).curve(d3.curveMonotoneX)(days));
      const L = p.node().getTotalLength();
      p.attr("stroke-dasharray", `${L} ${L}`).attr("stroke-dashoffset", L).transition().duration(1200).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0);
    });
  }

  // hover guide
  const guide = svg.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "#0F1B25").attr("stroke-opacity", 0).attr("stroke-dasharray", "2 3");
  const tip = h(`<div class="tooltip" style="position:absolute"></div>`);
  host.style.position = "relative";
  host.appendChild(tip);
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("mousemove", (ev) => {
      const r = host.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const day = days.reduce((a, b) => (Math.abs(x(b) - px) < Math.abs(x(a) - px) ? b : a));
      guide.attr("x1", x(day)).attr("x2", x(day)).attr("stroke-opacity", 0.5);
      let html = `<div class="t1">${dateLabel(day)}</div><div class="t2">${data.variable === "tmax" ? "max" : "min"} temperature</div>`;
      if (ens && ens[day]) html += `<div class="row"><span>Ensemble median</span><b>${fmt(ens[day].p50)}°C</b></div><div class="row"><span>Ensemble range</span><b>${fmt(ens[day].min)} to ${fmt(ens[day].max)}</b></div><div class="row"><span>Spread (sd)</span><b>${fmt(ens[day].std, 2)}°C</b></div>`;
      if (models) Object.entries(models).forEach(([k, mm]) => { if (mm[v][day] != null) html += `<div class="row"><span>${(MODEL_STYLE[k] || { name: k }).name}</span><b>${fmt(mm[v][day])}°C</b></div>`; });
      tip.innerHTML = html;
      tip.classList.add("on");
      let left = (x(day) / W) * r.width + 12;
      if (left + 190 > r.width) left -= 210;
      tip.style.left = `${left}px`;
      tip.style.top = "8px";
    })
    .on("mouseleave", () => { guide.attr("stroke-opacity", 0); tip.classList.remove("on"); });

  legend.innerHTML = [
    ...(models ? Object.keys(models).map((k) => `<span><i style="background:${(MODEL_STYLE[k] || {}).color}"></i>${(MODEL_STYLE[k] || { name: k }).name}</span>`) : []),
    ...(ens ? [`<span><i class="band" style="background:#0B6472"></i>Ensemble 25–75%, 10–90%, range</span>`] : []),
  ].join("");
  const stamp = (data.fetched_at || new Date().toISOString()).slice(11, 16);
  note.textContent = ens
    ? `Ensemble: ECMWF IFS, ${data.live.ensemble.members} members. Live from Open-Meteo at ${stamp} UTC. Spread is shown for context and is not an input to the trained model.`
    : `Ensemble unavailable right now (${errs.map(([k, m]) => `${k}: ${m}`).join("; ")}).`;
}
