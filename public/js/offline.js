// Offline area downloads: tiles go in the Cache API, trail data in IndexedDB.
import { tilesInBbox, countTiles, DEM_URL, bboxArea } from './geo.js';
import { OFM_TILEJSON, GLYPHS, FONTS, GLYPH_RANGES, RASTERS } from './style.js';
import { fetchOverpass } from './trails.js';
import { db } from './db.js';

export const TILE_CACHE = 'ls-tiles-v1';
export const MAX_TILES = 25000;
export const MAX_AREA_KM2 = 2500;
const VEC_KEY = (z, x, y) => `https://tiles.openfreemap.org/planet/_/${z}/${x}/${y}.pbf`;
const fill = (t, z, x, y) => t.replace('{z}', z).replace('{x}', x).replace('{y}', y);

export function planDownload(bbox, minZ, maxZ, layers) {
  const parts = [];
  if (layers.vector) parts.push({ key: 'vector', z0: Math.min(minZ, 8), z1: Math.min(maxZ, 14), bytes: 22000 });
  if (layers.dem) parts.push({ key: 'dem', z0: Math.min(minZ, 8), z1: Math.min(maxZ, 12), bytes: 70000 });
  for (const k of ['topo', 'sat']) if (layers[k]) parts.push({ key: k, z0: minZ, z1: Math.min(maxZ, RASTERS[k].maxzoom), bytes: RASTERS[k].bytes });
  let tiles = 0, bytes = 0;
  for (const p of parts) { p.n = countTiles(bbox, p.z0, p.z1); tiles += p.n; bytes += p.n * p.bytes; }
  return { parts, tiles, bytes: bytes + 450000 + 300000, km2: bboxArea(bbox) / 1e6 };
}

export async function downloadArea(area, onProgress, signal) {
  const cache = await caches.open(TILE_CACHE);
  const plan = planDownload(area.bbox, area.minZ, area.maxZ, area.layers);
  if (plan.tiles > MAX_TILES) throw new Error(`Too many tiles (${plan.tiles.toLocaleString()}). Shrink the box or lower the max zoom.`);
  const jobs = []; const keys = [];
  // vector tilejson (current version) — stored under the canonical URL
  let vecTpl = null;
  if (area.layers.vector) {
    const r = await fetch(OFM_TILEJSON, { signal }); if (!r.ok) throw new Error('Map tiles unavailable');
    const tj = await r.clone().json(); vecTpl = tj.tiles[0];
    await cache.put(OFM_TILEJSON, r);
    for (const f of FONTS) for (const g of GLYPH_RANGES) { const u = GLYPHS.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', g); jobs.push({ url: u, key: u, shared: true }); }
  }
  for (const p of plan.parts) for (let z = p.z0; z <= p.z1; z++) for (const [, x, y] of tilesInBbox(area.bbox, z)) {
    if (p.key === 'vector') jobs.push({ url: fill(vecTpl, z, x, y), key: VEC_KEY(z, x, y) });
    else if (p.key === 'dem') jobs.push({ url: fill(DEM_URL, z, x, y), key: fill(DEM_URL, z, x, y) });
    else { const u = RASTERS[p.key].url.replace('{z}', z).replace('{y}', y).replace('{x}', x); jobs.push({ url: u, key: u }); }
  }
  let done = 0, bytes = 0, failed = 0; const total = jobs.length + 1;
  onProgress?.({ done, total, bytes, stage: 'Trail data' });
  // trail & POI data first (Overpass)
  let data;
  try { data = await fetchOverpass(area.bbox, signal); }
  catch (e) { if (signal?.aborted) throw e; data = null; }
  done++;
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const j = jobs[i++];
      try {
        const hit = await cache.match(j.key);
        if (hit) { bytes += +(hit.headers.get('content-length') || 0) || 15000; }
        else {
          let r = await fetch(j.url, { signal, mode: 'cors' });
          if (r.status === 404 || r.status === 204) { r = new Response(null, { status: 204 }); }
          if (!r.ok && r.status !== 204) throw new Error(r.status);
          const buf = await r.arrayBuffer(); bytes += buf.byteLength;
          await cache.put(j.key, new Response(buf, { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'content-length': String(buf.byteLength), 'x-ls-saved': String(Date.now()) } }));
        }
        if (!j.shared) keys.push(j.key);
      } catch (e) { if (signal?.aborted) throw e; failed++; }
      done++;
      if (done % 10 === 0 || done === total) onProgress?.({ done, total, bytes, failed, stage: 'Map tiles' });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const rec = { ...area, tiles: keys.length, failed, bytes, saved: Date.now(), hasData: !!data, keys };
  await db.put('areas', rec);
  if (data) await db.put('areaData', { id: area.id, ...data });
  try { await navigator.storage?.persist?.(); } catch { }
  return rec;
}

export async function refreshAreaData(area) {
  const data = await fetchOverpass(area.bbox);
  await db.put('areaData', { id: area.id, ...data });
  await db.put('areas', { ...area, hasData: true });
  return data;
}

export async function deleteArea(id) {
  const areas = await db.all('areas'), me = areas.find(a => a.id === id);
  if (me) {
    const keep = new Set(); for (const a of areas) if (a.id !== id) for (const k of a.keys || []) keep.add(k);
    const cache = await caches.open(TILE_CACHE);
    const del = (me.keys || []).filter(k => !keep.has(k));
    for (let i = 0; i < del.length; i += 200) await Promise.all(del.slice(i, i + 200).map(k => cache.delete(k)));
  }
  await db.del('areas', id); await db.del('areaData', id);
}
