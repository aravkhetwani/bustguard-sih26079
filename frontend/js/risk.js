import { getRisk } from "./api.js";
import { RiskMap, makeScale } from "./map.js";
import { icon } from "./icons.js";
import { h, pct, fmt, countUp, dateLabel, errorBox } from "./util.js";

const d3 = window.d3;
let map = null;

export async function renderRisk(ctx) {
  const { root, state, meta } = ctx;
  root.innerHTML = "";
  const varLabel = meta.variables[state.variable];
  const view = h(`
    <div class="risk-grid view-enter">
      <section class="card map-card">
        <div class="map-head">
          <div>
            <div class="eyebrow">Bust probability · issued ${dateLabel(meta.issue_date)}</div>
            <h2 id="map-title">${varLabel}, day ${state.lead}</h2>
            <p id="map-sub">Chance that the GFS forecast for this day misses by more than the locally learned threshold.</p>
          </div>
          <div class="legend" id="legend"></div>
        </div>
        <div class="map-wrap" id="map-wrap"><div class="attrib">Forecasts and ERA5: Open-Meteo (CC BY 4.0) · Boundaries: Natural Earth, India point of view</div></div>
        <div class="map-foot" id="map-foot"></div>
      </section>
      <aside class="side">
        <section class="card rank-card">
          <div class="card-h"><h3>Regions to watch</h3><span class="sub" id="rank-sub"></span></div>
          <div class="rank-list" id="rank-list"></div>
        </section>
        <div class="card hint-card">${icon("info", 18)}<div>
          <b>How to read this.</b> Colour is the calibrated chance the forecast will bust. Select any cell for the reasons, the expected size of the miss and the live ensemble.
        </div></div>
      </aside>
    </div>`);
  root.appendChild(view);

  if (map) map.destroy();
  map = new RiskMap(view.querySelector("#map-wrap"), {
    onSelect: (id) => ctx.openCell(id),
    variableLabel: () => varLabel,
  });
  ctx.map = map;
  await refresh(ctx);
}

export async function refresh(ctx) {
  const { state, meta } = ctx;
  const root = ctx.root;
  const title = root.querySelector("#map-title");
  if (!title) return;
  const varLabel = meta.variables[state.variable];
  let data;
  try {
    data = await getRisk(state.variable, state.lead);
  } catch (e) {
    root.querySelector("#map-wrap").insertAdjacentHTML("beforeend", `<div style="position:absolute;inset:20px">${errorBox(e.message)}</div>`);
    return;
  }
  ctx.risk = data;
  title.textContent = `${varLabel}, day ${state.lead}`;
  const valid = data.cells[0]?.valid_date;
  root.querySelector("#map-sub").textContent =
    `Valid ${valid ? dateLabel(valid) : ""}. Chance that the GFS forecast misses by more than the locally learned bust threshold.`;

  const dataMax = d3.max(data.cells, (c) => c.p) || 0.3;
  const scale = makeScale(data.tiers, dataMax);
  ctx.scale = scale;
  map.setData(data.cells, scale, state.cell);
  renderLegend(root.querySelector("#legend"), scale, data);
  renderFoot(root.querySelector("#map-foot"), data);
  renderRanking(ctx, data, scale);
}

function renderLegend(el, scale, data) {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((f) => `${scale.color(f * scale.top)} ${f * 100}%`).join(",");
  const pos = (v) => `${(v / scale.top) * 100}%`;
  el.innerHTML = `
    <div class="bar" style="background:linear-gradient(90deg,${stops})"></div>
    <div class="ticks">
      <span class="tick r" style="left:${pos(data.tiers.elevated)}">elevated<br>${pct(data.tiers.elevated)}</span>
      <span class="tick l" style="left:${pos(data.tiers.high)}">high<br>${pct(data.tiers.high)}</span>
      <span class="tick r" style="left:100%">${pct(scale.top)}</span>
    </div>`;
}

function renderFoot(el, data) {
  el.innerHTML = `
    <div class="stat"><div class="n" data-c="${data.counts.high}">0</div><div class="l">High-risk cells</div></div>
    <div class="stat"><div class="n" data-c="${data.counts.elevated}">0</div><div class="l">Elevated cells</div></div>
    <div class="stat"><div class="n" data-c="${data.counts.low}">0</div><div class="l">Low-risk cells</div></div>
    <div class="stat" style="margin-left:auto"><div class="n">${pct(data.base_rate, 1)}<small> base rate</small></div>
      <div class="l">Share of forecasts that busted in the held-out test period. By construction about one in ten.</div></div>`;
  el.querySelectorAll("[data-c]").forEach((n) => countUp(n, +n.dataset.c, { dur: 700 }));
}

function renderRanking(ctx, data, scale) {
  const { state } = ctx;
  const list = ctx.root.querySelector("#rank-list");
  ctx.root.querySelector("#rank-sub").textContent = `Day ${state.lead} · by high-risk cells`;
  const rows = data.ranking.slice(0, 14);
  const maxMean = d3.max(rows, (r) => r.mean_p) || 0.1;
  list.innerHTML = rows.map((r, i) => `
    <div class="rank-row" data-state="${r.state}" tabindex="0" role="button">
      <div class="i">${String(i + 1).padStart(2, "0")}</div>
      <div>
        <div class="nm">${r.state}</div>
        <div class="meta">${r.high} high · ${r.elevated} elevated · ${r.cells} cells</div>
        <div class="bar"><i style="background:${scale.color(r.mean_p)}" data-w="${(r.mean_p / maxMean) * 100}"></i></div>
      </div>
      <div class="pv">${pct(r.mean_p, 0)}</div>
    </div>`).join("");
  requestAnimationFrame(() => list.querySelectorAll(".bar i").forEach((b, i) => setTimeout(() => (b.style.width = `${b.dataset.w}%`), i * 40)));
  list.querySelectorAll(".rank-row").forEach((row) => {
    const name = row.dataset.state;
    row.addEventListener("mouseenter", () => map.focusState(name));
    row.addEventListener("mouseleave", () => map.focusState(null));
    const open = () => {
      const top = data.cells.filter((c) => c.state === name).sort((a, b) => b.p - a.p)[0];
      if (top) ctx.openCell(top.id);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  });
}

export function destroyRisk() { if (map) { map.destroy(); map = null; } }
