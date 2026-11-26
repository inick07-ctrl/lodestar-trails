// Geometry, units, tile math, GPX, DEM helpers. No network calls except DEM tile fetch.
export const R = 6371008.8;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

export function hav(a, b) { // [lon,lat]
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function lineLength(c) { let d = 0; for (let i = 1; i < c.length; i++) d += hav(c[i - 1], c[i]); return d; }
export function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export function bboxOf(coords) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of coords) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
}
export function bboxArea(b) { return hav([b[0], b[1]], [b[2], b[1]]) * hav([b[0], b[1]], [b[0], b[3]]); }
export function bboxIntersects(a, b) { return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]); }

// Project point onto polyline: returns {dist, along, idx, point}
export function nearestOnLine(p, c) {
  const k = Math.cos(rad(p[1])) * 111320, m = 110540;
  let best = { dist: Infinity, along: 0, idx: 0, point: c[0] }, acc = 0;
  for (let i = 1; i < c.length; i++) {
    const ax = (c[i - 1][0] - p[0]) * k, ay = (c[i - 1][1] - p[1]) * m;
    const bx = (c[i][0] - p[0]) * k, by = (c[i][1] - p[1]) * m;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x, y), seg = Math.sqrt(L2);
    if (d < best.dist) best = { dist: d, along: acc + t * seg, idx: i - 1, point: [p[0] + x / k, p[1] + y / m] };
    acc += seg;
  }
  return best;
}

// Douglas-Peucker in meters
export function simplify(c, tol = 10) {
  if (c.length < 3) return c.slice();
  const k = Math.cos(rad(c[0][1])) * 111320, m = 110540;
  const P = c.map(([x, y]) => [x * k, y * m]);
  const keep = new Uint8Array(c.length); keep[0] = keep[c.length - 1] = 1;
  const stack = [[0, c.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let md = 0, mi = -1;
    const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * P[i][0] - dx * P[i][1] + bx * ay - by * ax) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return c.filter((_, i) => keep[i]);
}

// Chain unordered segments into one ordered line (greedy, endpoints within tol m)
export function chainSegments(segs, tol = 40) {
  if (!segs.length) return [];
  const rest = segs.map(s => s.slice()).sort((a, b) => lineLength(b) - lineLength(a));
  let chain = rest.shift();
  let grown = true;
  while (grown && rest.length) {
    grown = false; let bi = -1, bd = tol, how = 0;
    for (let i = 0; i < rest.length; i++) {
      const s = rest[i], h = chain[0], t = chain[chain.length - 1], s0 = s[0], s1 = s[s.length - 1];
      const opts = [[hav(t, s0), 1], [hav(t, s1), 2], [hav(h, s1), 3], [hav(h, s0), 4]];
      for (const [d, w] of opts) if (d < bd) { bd = d; bi = i; how = w; }
    }
    if (bi >= 0) {
      const s = rest.splice(bi, 1)[0];
      if (how === 1) chain = chain.concat(s.slice(1));
      else if (how === 2) chain = chain.concat(s.reverse().slice(1));
      else if (how === 3) chain = s.concat(chain.slice(1));
      else chain = s.reverse().concat(chain.slice(1));
      grown = true;
    }
  }
  return chain;
}

// Point at distance along line
export function pointAlong(c, d) {
  let acc = 0;
  for (let i = 1; i < c.length; i++) {
    const s = hav(c[i - 1], c[i]);
    if (acc + s >= d) { const t = s ? (d - acc) / s : 0; return [c[i - 1][0] + t * (c[i][0] - c[i - 1][0]), c[i - 1][1] + t * (c[i][1] - c[i - 1][1])]; }
    acc += s;
  }
  return c[c.length - 1];
}

// Turn cues from a route
export function buildCues(coords, name = '') {
  const s = simplify(coords, 12), cues = []; let acc = 0;
  const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  if (s.length > 1) cues.push({ at: 0, type: 'start', text: `Head ${dirs[Math.round(bearing(s[0], s[1]) / 45) % 8]}${name ? ' on ' + name : ''}`, pt: s[0] });
  for (let i = 1; i < s.length - 1; i++) {
    acc += hav(s[i - 1], s[i]);
    const b1 = bearing(s[i - 1], s[i]), b2 = bearing(s[i], s[i + 1]);
    let d = ((b2 - b1 + 540) % 360) - 180, a = Math.abs(d);
    if (a < 30 || hav(s[i], s[i + 1]) < 15) continue;
    const side = d > 0 ? 'right' : 'left';
    const verb = a < 60 ? 'Bear' : a < 135 ? 'Turn' : 'Sharp';
    cues.push({ at: acc, type: verb.toLowerCase() + '-' + side, text: `${verb} ${side}`, pt: s[i] });
  }
  acc += s.length > 1 ? hav(s[s.length - 2], s[s.length - 1]) : 0;
  cues.push({ at: lineLength(coords), type: 'arrive', text: 'Arrive at the end of the route', pt: s[s.length - 1] });
  return cues;
}

// ---------- Tiles ----------
export const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
export const lat2y = (lat, z) => { const r = rad(lat); return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
export function tilesInBbox(b, z) {
  const x0 = lon2x(b[0], z), x1 = lon2x(b[2], z), y0 = lat2y(b[3], z), y1 = lat2y(b[1], z), out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}
export function countTiles(b, z0, z1) { let n = 0; for (let z = z0; z <= z1; z++) { n += (lon2x(b[2], z) - lon2x(b[0], z) + 1) * (lat2y(b[1], z) - lat2y(b[3], z) + 1); } return n; }

// ---------- DEM (Terrarium, AWS open data) ----------
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_Z = 12;
const demCache = new Map();
async function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (demCache.has(key)) return demCache.get(key);
  const p = (async () => {
    try {
      const r = await fetch(DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
      const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, 256, 256).data;
    } catch { return null; }
  })();
  demCache.set(key, p); if (demCache.size > 64) demCache.delete(demCache.keys().next().value);
  return p;
}
export async function elevationAt([lon, lat]) {
  const z = DEM_Z, n = 2 ** z, fx = (lon + 180) / 360 * n, r = rad(lat);
  const fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const x = Math.floor(fx), y = Math.floor(fy), d = await demTile(z, x, y);
  if (!d) return null;
  const px = Math.min(255, Math.floor((fx - x) * 256)), py = Math.min(255, Math.floor((fy - y) * 256)), i = (py * 256 + px) * 4;
  return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
}
export async function profile(coords, samples = 120) {
  const L = lineLength(coords); if (!L) return null;
  const n = Math.max(2, Math.min(samples, Math.ceil(L / 10)));
  const pts = []; for (let i = 0; i < n; i++) { const d = L * i / (n - 1); pts.push({ d, p: pointAlong(coords, d) }); }
  const els = await Promise.all(pts.map(q => elevationAt(q.p)));
  const okN = els.filter(e => e != null).length;
  if (okN < els.length * 0.6 || okN < 2) return null;
  // fill gaps (samples outside cached terrain) by nearest known value
  for (let i = 0; i < els.length; i++) if (els[i] == null) { let j = 1; while (els[i] == null && j < els.length) { els[i] = els[i - j] ?? els[i + j] ?? null; j++; } }
  // light smoothing
  const sm = els.map((e, i) => (els[Math.max(0, i - 1)] + e * 2 + els[Math.min(els.length - 1, i + 1)]) / 4);
  let gain = 0, loss = 0; for (let i = 1; i < sm.length; i++) { const dd = sm[i] - sm[i - 1]; if (dd > 0) gain += dd; else loss -= dd; }
  return { pts: pts.map((q, i) => ({ d: q.d, e: sm[i] })), gain, loss, min: Math.min(...sm), max: Math.max(...sm) };
}

// ---------- Units ----------
export const units = { imperial: true };
export function fmtDist(m, precise = false) {
  if (m == null || isNaN(m)) return '–';
  if (units.imperial) { const mi = m / 1609.344; if (mi < 0.1 && precise) return Math.round(m * 3.28084) + ' ft'; return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi'; }
  return m < 1000 && precise ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}
export function fmtShortDist(m) { // for cues
  if (units.imperial) { const ft = m * 3.28084; return ft < 1000 ? Math.round(ft / 10) * 10 + ' ft' : (m / 1609.344).toFixed(1) + ' mi'; }
  return m < 1000 ? Math.round(m / 5) * 5 + ' m' : (m / 1000).toFixed(1) + ' km';
}
export function fmtElev(m) { if (m == null || isNaN(m)) return '–'; return units.imperial ? Math.round(m * 3.28084).toLocaleString() + ' ft' : Math.round(m) + ' m'; }
export function fmtSpeed(ms) { if (ms == null || isNaN(ms)) return '–'; return units.imperial ? (ms * 2.236936).toFixed(1) + ' mph' : (ms * 3.6).toFixed(1) + ' km/h'; }
export function fmtPace(ms) { if (!ms || ms < 0.3) return '–'; const s = (units.imperial ? 1609.344 : 1000) / ms; return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} /${units.imperial ? 'mi' : 'km'}`; }
export function fmtDur(sec) { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }
export function fmtBytes(b) { if (b < 1e6) return Math.round(b / 1e3) + ' KB'; if (b < 1e9) return (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + ' MB'; return (b / 1e9).toFixed(2) + ' GB'; }
// Naismith-ish estimated time (s)
export function estTime(m, gain = 0, activity = 'hike') {
  const spd = { hike: 1.25, walk: 1.3, run: 2.7, bike: 4.5, offroad: 4.0 }[activity] || 1.25;
  return m / spd + (activity === 'offroad' ? 0 : gain / 600 * 3600 * (activity === 'bike' ? 0.5 : 1));
}

// ---------- GPX ----------
const esc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
export function toGPX({ name = 'Lodestar export', tracks = [], routes = [], waypoints = [] }) {
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Lodestar Trails" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>\n`;
  for (const w of waypoints) x += `<wpt lat="${w.lat}" lon="${w.lon}">${w.ele != null ? `<ele>${w.ele.toFixed(1)}</ele>` : ''}<name>${esc(w.name)}</name>${w.notes ? `<desc>${esc(w.notes)}</desc>` : ''}${w.icon ? `<sym>${esc(w.icon)}</sym>` : ''}</wpt>\n`;
  for (const r of routes) { x += `<rte><name>${esc(r.name)}</name>\n`; for (const [lon, lat] of r.coords) x += `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>\n`; x += `</rte>\n`; }
  for (const t of tracks) {
    x += `<trk><name>${esc(t.name)}</name>${t.activity ? `<type>${esc(t.activity)}</type>` : ''}\n`;
    for (const seg of (t.segments || [t.points])) {
      x += '<trkseg>\n';
      for (const p of seg) x += `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}${p.t ? `<time>${new Date(p.t).toISOString()}</time>` : ''}</trkpt>\n`;
      x += '</trkseg>\n';
    }
    x += '</trk>\n';
  }
  return x + '</gpx>\n';
}
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid GPX file');
  const num = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? parseFloat(n.textContent) : null; };
  const txt = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : ''; };
  const pt = el => ({ lat: +el.getAttribute('lat'), lon: +el.getAttribute('lon'), ele: num(el, 'ele'), t: (() => { const s = txt(el, 'time'); return s ? Date.parse(s) : null; })() });
  const out = { name: txt(doc.documentElement.getElementsByTagName('metadata')[0] || doc.documentElement, 'name'), tracks: [], routes: [], waypoints: [] };
  for (const t of doc.getElementsByTagName('trk')) out.tracks.push({ name: txt(t, 'name') || 'Imported track', activity: txt(t, 'type') || '', segments: [...t.getElementsByTagName('trkseg')].map(s => [...s.getElementsByTagName('trkpt')].map(pt)).filter(s => s.length) });
  for (const r of doc.getElementsByTagName('rte')) out.routes.push({ name: txt(r, 'name') || 'Imported route', coords: [...r.getElementsByTagName('rtept')].map(e => [+e.getAttribute('lon'), +e.getAttribute('lat')]) });
  for (const w of doc.getElementsByTagName('wpt')) { if (w.parentNode !== doc.documentElement) continue; const p = pt(w); out.waypoints.push({ ...p, name: txt(w, 'name') || 'Waypoint', notes: txt(w, 'desc') || txt(w, 'cmt'), icon: txt(w, 'sym') }); }
  return out;
}

export function trackStats(segments) {
  let dist = 0, moving = 0, gain = 0, loss = 0, maxSpd = 0, first = null, last = null;
  for (const seg of segments) {
    let ref = null;
    for (let i = 0; i < seg.length; i++) {
      const p = seg[i]; if (!first && p.t) first = p.t; if (p.t) last = p.t;
      if (i) { const q = seg[i - 1], d = hav([q.lon, q.lat], [p.lon, p.lat]); dist += d; if (p.t && q.t) { const dt = (p.t - q.t) / 1000; if (dt > 0 && d / dt > 0.4 && dt < 120) { moving += dt; maxSpd = Math.max(maxSpd, Math.min(d / dt, 60)); } } }
      if (p.ele != null) { if (ref == null) ref = p.ele; else if (p.ele - ref > 3) { gain += p.ele - ref; ref = p.ele; } else if (ref - p.ele > 3) { loss += ref - p.ele; ref = p.ele; } }
    }
  }
  return { dist, moving, elapsed: first && last ? (last - first) / 1000 : 0, gain, loss, maxSpd, avgSpd: moving ? dist / moving : 0 };
}
