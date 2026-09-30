import { getGeo } from "./api.js";
import { pct, fmt } from "./util.js";

const d3 = window.d3;
export const RISK_COLORS = ["#E9E3D2", "#F0C36A", "#E4572E", "#7A1C2B"];

export function makeScale(tiers, dataMax) {
  const top = Math.max(tiers.high * 2.1, dataMax * 1.02, tiers.high + 0.05);
  const domain = [0, tiers.elevated, tiers.high, top];
  return {
    domain,
    top,
    color: d3.scaleLinear().domain(domain).range(RISK_COLORS).interpolate(d3.interpolateLab).clamp(true),
  };
}

export class RiskMap {
  constructor(container, { onSelect, variableLabel }) {
    this.el = container;
    this.onSelect = onSelect;
    this.variableLabel = variableLabel;
    this.cells = [];
    this.scale = null;
    this.selected = null;
    this.first = true;
    this.svg = d3.select(container).append("svg").attr("role", "img")
      .attr("aria-label", "Map of India showing forecast bust risk by grid cell");
    this.tip = document.createElement("div");
    this.tip.className = "tooltip";
    container.appendChild(this.tip);
    this.ready = getGeo().then((g) => { this.geo = g; this.build(); });
    this.ro = new ResizeObserver(() => this.geo && this.build(true));
    this.ro.observe(container);
  }

  build(resize = false) {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (w < 50 || h < 50) return;
    const outline = this.geo.outline;
    this.proj = d3.geoMercator().fitExtent([[26, 18], [w - 26, h - 22]], outline);
    const path = d3.geoPath(this.proj);
    const svg = this.svg.attr("viewBox", `0 0 ${w} ${h}`);
    svg.selectAll("*").remove();
    const defs = svg.append("defs");
    defs.append("clipPath").attr("id", "clip-india").append("path").attr("d", path(outline));
    defs.append("filter").attr("id", "soft").append("feDropShadow")
      .attr("dx", 0).attr("dy", 6).attr("stdDeviation", 7).attr("flood-color", "#0F1B25").attr("flood-opacity", 0.16);

    // graticule
    const grat = d3.geoGraticule().extent([[64, 2], [102, 42]]).step([5, 5]);
    svg.append("path").attr("class", "graticule").attr("d", path(grat()));
    const gl = svg.append("g");
    [10, 20, 30].forEach((lat) => {
      const [x, y] = this.proj([66.6, lat]);
      gl.append("text").attr("class", "glab").attr("x", x).attr("y", y - 3).text(`${lat}°N`);
    });
    [70, 80, 90].forEach((lon) => {
      const [x, y] = this.proj([lon, 5.6]);
      gl.append("text").attr("class", "glab").attr("x", x - 9).attr("y", y).text(`${lon}°E`);
    });

    // land base (shadow) then cells clipped to the outline
    svg.append("path").attr("d", path(outline)).attr("fill", "#F8F5EC").attr("filter", "url(#soft)");
    this.cellLayer = svg.append("g").attr("clip-path", "url(#clip-india)");
    svg.append("path").attr("class", "outline").attr("d", path(outline));
    this.half = this.geo.grid.step / 2;
    this.draw(resize);
  }

  rectPath(c) {
    const p = (lo, la) => this.proj([lo, la]);
    const a = p(c.lon - this.half, c.lat + this.half), b = p(c.lon + this.half, c.lat + this.half);
    const d = p(c.lon + this.half, c.lat - this.half), e = p(c.lon - this.half, c.lat - this.half);
    return `M${a[0]},${a[1]}L${b[0]},${b[1]}L${d[0]},${d[1]}L${e[0]},${e[1]}Z`;
  }

  setData(cells, scale, selectedId = null) {
    this.cells = cells;
    this.scale = scale;
    this.selected = selectedId;
    this.ready.then(() => this.draw(false));
  }

  draw(resize) {
    if (!this.cellLayer || !this.scale) return;
    const animateIn = this.first && !resize;
    const sel = this.cellLayer.selectAll("g.cell").data(this.cells, (d) => d.id);
    sel.exit().remove();
    const enter = sel.enter().append("g").attr("class", "cell").attr("tabindex", 0)
      .attr("role", "button").style("opacity", animateIn ? 0 : 1);
    enter.append("path").attr("stroke", "rgba(15,27,37,.16)").attr("stroke-width", 0.8);
    const all = enter.merge(sel);
    all.attr("aria-label", (d) => `${d.state}, ${pct(d.p, 1)} bust risk`)
      .on("click", (_, d) => this.onSelect(d.id))
      .on("keydown", (ev, d) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.onSelect(d.id); } })
      .on("mouseenter", (ev, d) => this.showTip(ev, d))
      .on("mousemove", (ev, d) => this.moveTip(ev))
      .on("mouseleave", () => this.tip.classList.remove("on"));
    all.select("path").attr("d", (d) => this.rectPath(d));
    const t = all.select("path").transition().duration(resize ? 0 : 750).ease(d3.easeCubicOut)
      .attr("fill", (d) => this.scale.color(d.p));
    if (!resize) t.delay((d) => (animateIn ? (37.5 - d.lat) * 26 + (d.lon - 68) * 6 : 0));
    if (animateIn) {
      enter.transition().duration(600).delay((d) => (37.5 - d.lat) * 26 + (d.lon - 68) * 6).style("opacity", 1);
      this.first = false;
    }
    all.classed("sel", (d) => d.id === this.selected);
    all.filter((d) => d.id === this.selected).raise();
  }

  select(id) {
    this.selected = id;
    if (this.cellLayer) {
      this.cellLayer.selectAll("g.cell").classed("sel", (d) => d.id === id)
        .filter((d) => d.id === id).raise();
    }
  }

  focusState(name) {
    if (!this.cellLayer) return;
    this.cellLayer.selectAll("g.cell").classed("dim", (d) => !!name && d.state !== name);
  }

  showTip(ev, d) {
    this.tip.innerHTML = `<div class="t1">${d.state}</div><div class="t2">${d.lat.toFixed(1)}°N · ${d.lon.toFixed(1)}°E</div>
      <div class="row"><span>Bust risk</span><b>${pct(d.p, 1)}</b></div>
      <div class="row"><span>Tier</span><b style="text-transform:capitalize">${d.tier}</b></div>
      <div class="row"><span>${this.variableLabel()}</span><b>${fmt(d.forecast)}°C</b></div>
      <div class="row"><span>Typical miss</span><b>±${fmt(d.q50, 1)}°C</b></div>`;
    this.tip.classList.add("on");
    this.moveTip(ev);
  }

  moveTip(ev) {
    const r = this.el.getBoundingClientRect();
    let x = ev.clientX - r.left + 16, y = ev.clientY - r.top + 14;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 16;
    if (y + th > r.height - 8) y = ev.clientY - r.top - th - 14;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  destroy() { this.ro.disconnect(); this.el.innerHTML = ""; }
}
