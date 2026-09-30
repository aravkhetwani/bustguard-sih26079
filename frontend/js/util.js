// Small shared helpers: formatting, DOM, count-up, segmented controls.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const pct = (p, d = 0) => `${(p * 100).toFixed(d)}%`;
export const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "n/a" : Number(v).toFixed(d));

const DOW = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const DM = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const dateLabel = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  return `${DOW.format(d)} ${DM.format(d)}`;
};
export const dayShort = (iso) => DM.format(new Date(iso + "T00:00:00Z"));
export const dowShort = (iso) => DOW.format(new Date(iso + "T00:00:00Z"));

export function countUp(el, to, { dur = 900, fmt: f = (v) => v.toFixed(0), from = 0 } = {}) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = f(to); return; }
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    el.textContent = f(from + (to - from) * ease(k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Segmented control with a sliding thumb. options: [{value,label,sub?,icon?}] */
export function segmented({ options, value, onChange, cls = "", aria = "" }) {
  const root = h(`<div class="seg ${cls}" role="group" aria-label="${aria}"><span class="thumb"></span></div>`);
  const thumb = root.firstElementChild;
  const btns = options.map((o) => {
    const b = h(`<button type="button" data-v="${o.value}">${o.html || o.label}</button>`);
    b.addEventListener("click", () => { if (String(o.value) !== String(current)) { set(o.value); onChange(o.value); } });
    root.appendChild(b);
    return b;
  });
  let current = value;
  function place(animate = true) {
    const b = btns.find((x) => x.dataset.v === String(current));
    if (!b) return;
    if (!animate) thumb.style.transition = "none";
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft - 3}px)`;
    if (!animate) { thumb.offsetWidth; thumb.style.transition = ""; }
  }
  function set(v) {
    current = v;
    btns.forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === String(v)));
    place();
  }
  root.set = set;
  root.place = place;
  requestAnimationFrame(() => { set(value); place(false); });
  return root;
}

export function errorBox(msg) {
  return `<div class="err-note"><b>Data unavailable.</b> ${msg}</div>`;
}
