import { getMeta, getGeo } from "./api.js";
import { icon } from "./icons.js";
import { $, h, segmented, dateLabel, errorBox } from "./util.js";
import { renderRisk, refresh as refreshRisk, destroyRisk } from "./risk.js";
import { renderVerification } from "./verification.js";
import { renderMethod } from "./method.js";
import { initDrawer, openDrawer, closeDrawer, refreshDrawer } from "./drawer.js";

const VIEWS = {
  risk: { title: "Risk map", sub: "Where the forecast is most likely to miss", icon: "map", label: "Map" },
  verification: { title: "Verification", sub: "How well the warnings hold up against ERA5", icon: "shield-check", label: "Proof" },
  method: { title: "Method and sources", sub: "How the warnings are made, and their limits", icon: "book-open", label: "Method" },
};

const ctx = { root: $("#view"), state: { view: "risk", variable: "tmax", lead: 3, cell: null }, meta: null, geo: null, map: null };
let controls = {};

function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const q = new URLSearchParams(qs || "");
  const view = VIEWS[path] ? path : "risk";
  const variable = ["tmax", "tmin"].includes(q.get("var")) ? q.get("var") : ctx.state.variable;
  const lead = [3, 4, 5, 6, 7].includes(+q.get("lead")) ? +q.get("lead") : ctx.state.lead;
  const cell = q.get("cell") !== null && q.get("cell") !== "" ? +q.get("cell") : null;
  return { view, variable, lead, cell };
}

function writeHash() {
  const s = ctx.state;
  const q = new URLSearchParams({ var: s.variable, lead: s.lead });
  if (s.view === "risk" && s.cell !== null) q.set("cell", s.cell);
  history.replaceState(null, "", `#/${s.view}?${q}`);
}

function buildNav() {
  $("#nav").innerHTML = Object.entries(VIEWS).map(([k, v]) => `
    <button class="nav-btn" data-v="${k}" aria-current="${ctx.state.view === k ? "page" : "false"}" title="${v.title}">
      ${icon(v.icon, 22, 1.7)}<span>${v.label}</span></button>`).join("");
  $("#nav").querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => go(b.dataset.v)));
  $("#rail-foot").innerHTML = ctx.meta ? `MODEL<br><b>${ctx.meta.model_version.replace("bustguard-", "")}</b><br><br>ISSUED<br><b>${ctx.meta.issue_date.slice(5)}</b>` : "";
}

function buildTopbar() {
  const v = VIEWS[ctx.state.view];
  const bar = $("#topbar");
  bar.innerHTML = `
    <div class="title-block"><h1>${v.title}</h1><p>${v.sub}</p></div>
    <div class="spacer"></div><div class="controls" id="controls"></div>
    <div class="status-pill ${ctx.meta ? "" : "err"}" id="status"><span class="dot"></span>${ctx.meta
      ? `Run of <b>${dateLabel(ctx.meta.issue_date)}</b> · ${ctx.meta.cells} cells` : "No run available"}</div>`;
  const c = $("#controls");
  controls = {};
  const varSeg = segmented({
    aria: "Variable", value: ctx.state.variable, cls: "",
    options: Object.entries(ctx.meta.variables).map(([k, l]) => ({ value: k, html: `${icon(k === "tmax" ? "thermometer-sun" : "thermometer-snowflake", 16)}${l}` })),
    onChange: (val) => setVariable(val),
  });
  controls.variable = varSeg;
  if (ctx.state.view !== "method") c.appendChild(h(`<div><div class="ctl-label">Variable</div></div>`)).appendChild(varSeg);
  if (ctx.state.view === "risk") {
    const issue = new Date(ctx.meta.issue_date + "T00:00:00Z");
    const leadSeg = segmented({
      aria: "Lead time", value: ctx.state.lead, cls: "leads",
      options: ctx.meta.leads.map((l) => {
        const d = new Date(issue.getTime() + l * 864e5).toISOString().slice(0, 10);
        return { value: l, html: `<span class="d">Day ${l}</span><span class="s">${dateLabel(d)}</span>` };
      }),
      onChange: (val) => setLead(+val),
    });
    controls.lead = leadSeg;
    c.appendChild(h(`<div><div class="ctl-label">Lead time</div></div>`)).appendChild(leadSeg);
  }
}

async function mount() {
  const s = ctx.state;
  buildNav();
  buildTopbar();
  closeDrawer();
  destroyRisk();
  ctx.map = null;
  document.title = `${VIEWS[s.view].title} · BustGuard`;
  if (s.view === "risk") {
    await renderRisk(ctx);
    if (s.cell !== null) ctx.openCell(s.cell, true);
  } else if (s.view === "verification") await renderVerification(ctx);
  else await renderMethod(ctx);
  ctx.root.scrollTop = 0;
}

function go(view) {
  if (ctx.state.view === view) return;
  ctx.state.view = view;
  ctx.state.cell = null;
  writeHash();
  mount();
}

async function setVariable(val) {
  ctx.state.variable = val;
  writeHash();
  if (ctx.state.view === "risk") {
    await refreshRisk(ctx);
    if (ctx.state.cell !== null) openDrawer(ctx, ctx.state.cell);
  } else if (ctx.state.view === "verification") await renderVerification(ctx);
}

async function setLead(val) {
  ctx.state.lead = val;
  controls.lead && controls.lead.set(val);
  writeHash();
  await refreshRisk(ctx);
  refreshDrawer();
}

ctx.setLead = setLead;
ctx.openCell = (id, silent) => {
  ctx.state.cell = id;
  ctx.map && ctx.map.select(id);
  writeHash();
  openDrawer(ctx, id);
};
ctx.closeCell = () => {
  ctx.state.cell = null;
  ctx.map && ctx.map.select(null);
  closeDrawer();
  writeHash();
};

async function boot() {
  Object.assign(ctx.state, parseHash());
  try {
    [ctx.meta, ctx.geo] = await Promise.all([getMeta(), getGeo()]);
  } catch (e) {
    $("#topbar").innerHTML = `<div class="title-block"><h1>BustGuard</h1><p>Forecast reliability console</p></div>`;
    ctx.root.innerHTML = `<div style="max-width:640px;margin:40px auto">${errorBox(`${e.message}. The backend has no stored run yet. Run the pipeline (ingest, train, infer) and reload.`)}</div>`;
    buildNav();
    return;
  }
  initDrawer(ctx.closeCell);
  window.addEventListener("hashchange", () => {
    const n = parseHash();
    const changedView = n.view !== ctx.state.view;
    Object.assign(ctx.state, n);
    if (changedView) mount();
  });
  mount();
}

boot();
