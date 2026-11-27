// Community trails: user-created trails, private or shared with every signed-in Lodestar user.
// The server enforces ownership; this module only calls the API and keeps an on-device cache (store "ctrails")
// so trails you've viewed or created still open offline. The cache is wiped on sign-out with the rest of local data.
import { db, uid } from './db.js';
import { api } from './account.js';

export const BEST_FOR = {
  hike: ['🥾', 'Hiking'], bike: ['🚲', 'Biking'], offroad4wd: ['🚙', 'Off-road 4WD'], overland: ['🏕️', 'Overlanding'],
  atv: ['🛻', 'ATV / UTV'], horse: ['🐎', 'Horseback'], snowmobile: ['🛷', 'Snowmobile'], run: ['🏃', 'Trail running'], walk: ['🚶', 'Walking'],
};
export const VEHICLE_USES = ['offroad4wd', 'overland', 'atv'];
export const CT_DIFF = ['Easy', 'Moderate', 'Hard', 'Expert'];
export const CLEARANCE = { any: 'Any vehicle', awd: 'AWD or better', high: 'High clearance', '4wd': '4WD required' };
export const CT_LIMITS = { name: 80, notes: 2000, points: 5000 };

const call = (action, body = {}) => api('trails', { method: 'POST', body: { action, ...body } });
const isNetErr = e => e && e.status == null;
const R = 6371008.8, rad = d => d * Math.PI / 180;
export function hav(a, b) { const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }

// Thin a long line to <= max points (for drawing/uploading recordings).
export function thin(coords, max = CT_LIMITS.points) {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1), out = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}
export const geometry = t => t.coords || t.preview || [];

async function cachePut(t) {
  const cur = await db.get('ctrails', t.id);
  // a list result has only a preview; keep cached full coords if the trail hasn't changed since
  if (!t.coords && cur?.coords && cur.updated === t.updated) t = { ...t, coords: cur.coords };
  await db.put('ctrails', { ...t, cachedAt: Date.now() });
  return t;
}
export const cached = () => db.all('ctrails');
export const cachedOne = id => db.get('ctrails', id);

export async function listNear(near, { radiusKm = 80, bestFor = null } = {}) {
  if (navigator.onLine) {
    try {
      const { trails } = await call('list', { near, radiusKm, bestFor });
      const out = []; for (const t of trails) out.push(await cachePut(t));
      // drop cached shared trails from other people in this window that no longer exist / were hidden
      const ids = new Set(trails.map(t => t.id));
      for (const c of await cached()) if (!c.mine && !c._pending && !ids.has(c.id) && hav(near, c.start) < radiusKm * 1000 && (!bestFor || c.bestFor.includes(bestFor))) await db.del('ctrails', c.id);
      return { trails: [...out, ...(await cached()).filter(c => c._pending)], offline: false };
    } catch (e) { if (!isNetErr(e)) throw e; }
  }
  const all = (await cached()).filter(c => hav(near, c.start) < radiusKm * 1000 && (!bestFor || c.bestFor.includes(bestFor)));
  return { trails: all, offline: true };
}
export async function getTrail(id) {
  const local = await cachedOne(id);
  if (local?._pending || !navigator.onLine) return local || null;
  try { const { trail } = await call('get', { id }); return await cachePut(trail); }
  catch (e) {
    if (isNetErr(e)) return local || null;
    if (e.status === 404) { await db.del('ctrails', id); const err = new Error(e.message); err.status = 404; throw err; }
    throw e;
  }
}
export async function createTrail(d) {
  const body = { name: d.name, bestFor: d.bestFor, difficulty: d.difficulty, clearance: d.clearance, notes: d.notes, shared: !!d.shared, source: d.source, coords: d.coords };
  if (!navigator.onLine) return queueLocal(body);
  try { const { trail } = await call('create', body); return await cachePut(trail); }
  catch (e) { if (isNetErr(e)) return queueLocal(body); throw e; }
}
async function queueLocal(body) {
  const lons = body.coords.map(c => c[0]), lats = body.coords.map(c => c[1]);
  let len = 0; for (let i = 1; i < body.coords.length; i++) len += hav(body.coords[i - 1], body.coords[i]);
  const t = { ...body, id: uid('pend_'), _pending: true, mine: true, author: 'You', len, start: body.coords[0], bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], preview: thin(body.coords, 160), created: Date.now(), updated: Date.now() };
  await db.put('ctrails', t); return t;
}
export async function updateTrail(id, d) {
  if (id.startsWith('pend_')) { const cur = await cachedOne(id); const t = { ...cur, ...d, updated: Date.now() }; await db.put('ctrails', t); return t; }
  const { trail } = await call('update', { id, name: d.name, bestFor: d.bestFor, difficulty: d.difficulty, clearance: d.clearance, notes: d.notes, shared: !!d.shared, ...(d.coords ? { coords: d.coords } : {}) });
  return cachePut(trail);
}
export async function deleteTrail(id) {
  if (!id.startsWith('pend_')) await call('delete', { id });
  await db.del('ctrails', id);
}
export const reportTrail = (id, reason) => call('report', { id, reason });
export async function myTrails() {
  const { trails } = await call('mine');
  for (const t of trails) await cachePut(t);
  return trails;
}
// Upload trails created while offline. Returns [{from, to}] id changes.
let flushing = null;
export function flushPending() {
  return flushing ||= (async () => {
    const moved = [];
    if (!navigator.onLine) return moved;
    for (const p of (await cached()).filter(c => c._pending)) {
      try {
        const { trail } = await call('create', { name: p.name, bestFor: p.bestFor, difficulty: p.difficulty, clearance: p.clearance, notes: p.notes, shared: !!p.shared, source: p.source, coords: p.coords });
        await cachePut(trail); await db.del('ctrails', p.id); moved.push({ from: p.id, to: trail.id });
      } catch (e) { if (isNetErr(e) || e.status === 401 || e.status === 429 || e.status >= 500) break; p._error = e.message; await db.put('ctrails', p); }
    }
    return moved;
  })().finally(() => { flushing = null; });
}
// Does this trail suit the user's vehicle? null when no vehicle or not a vehicle trail.
export function ctFits(t, v) {
  if (!v || !t.clearance || t.clearance === 'any') return v ? true : null;
  if (t.clearance === '4wd') return !!v.fourwd;
  if (t.clearance === 'high') return !!(v.clearance || v.fourwd);
  if (t.clearance === 'awd') return !!(v.awd || v.fourwd);
  return true;
}
