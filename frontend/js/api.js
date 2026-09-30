// Thin API client. Failures surface to the UI; nothing is ever substituted with placeholder data.
const cache = new Map();

export async function api(path, { ttl = 0 } = {}) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const r = await fetch(`/api${path}`);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const v = await r.json();
  if (ttl) cache.set(path, { t: Date.now(), v });
  return v;
}

export const getMeta = () => api("/meta", { ttl: 60_000 });
export const getGeo = () => api("/geo", { ttl: 3_600_000 });
export const getRisk = (variable, lead) => api(`/risk?variable=${variable}&lead=${lead}`, { ttl: 60_000 });
export const getPoint = (id, variable) => api(`/point/${id}?variable=${variable}`, { ttl: 120_000 });
export const getVerification = () => api("/verification", { ttl: 60_000 });
export const getHealth = (fresh = false) => api("/health", { ttl: fresh ? 0 : 30_000 });
export const getLive = (id) => api(`/live/${id}`, { ttl: 600_000 });
