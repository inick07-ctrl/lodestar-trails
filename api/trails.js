// Lodestar community trails API. Every call needs a signed-in session.
// Writes are owner-only (enforced in SQL with owner_id = session user). Authors are shown by display name only — never email.
import { ensureSchema, sql, send, fail, readJson, checkWrite, currentUser, rateLimit, newId } from '../lib/server.js';

export const BEST_FOR = ['hike', 'bike', 'offroad4wd', 'overland', 'atv', 'horse', 'snowmobile', 'run', 'walk'];
const CLEARANCE = ['any', 'awd', 'high', '4wd'];
export const LIMITS = { name: 80, notes: 2000, points: 5000, minPoints: 2, maxLenM: 500_000, body: 400_000, bestFor: 6, reason: 300 };
const HIDE_AT_REPORTS = 5;

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const R = 6371008.8, rad = d => d * Math.PI / 180;
function hav(a, b) { const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }

// Returns { coords, len, bbox } or an error string.
function cleanCoords(raw) {
  if (!Array.isArray(raw)) return 'Trail geometry is missing.';
  if (raw.length < LIMITS.minPoints) return 'Add at least two points.';
  if (raw.length > LIMITS.points) return `Trail has too many points (max ${LIMITS.points}).`;
  const coords = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return 'Trail geometry is invalid.';
    const lon = +p[0], lat = +p[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -85 || lat > 85) return 'Trail geometry is invalid.';
    const c = [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
    const last = coords[coords.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
  }
  if (coords.length < 2) return 'Add at least two different points.';
  let len = 0; for (let i = 1; i < coords.length; i++) { const d = hav(coords[i - 1], coords[i]); if (d > 100_000) return 'Points are too far apart.'; len += d; }
  if (len < 20) return 'Trail is too short.';
  if (len > LIMITS.maxLenM) return 'Trail is too long (max 500 km).';
  const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
  return { coords, len, bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] };
}
function preview(coords, max = 160) {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1), out = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}
function cleanMeta(b) {
  const name = clean(b.name, LIMITS.name);
  if (!name) return 'Give your trail a name.';
  if (String(b.name ?? '').trim().length > LIMITS.name) return `Name is too long (max ${LIMITS.name}).`;
  if (String(b.notes ?? '').length > LIMITS.notes) return `Notes are too long (max ${LIMITS.notes} characters).`;
  const bf = [...new Set((Array.isArray(b.bestFor) ? b.bestFor : []).filter(x => BEST_FOR.includes(x)))].slice(0, LIMITS.bestFor);
  if (!bf.length) return 'Pick at least one thing this trail is best for.';
  const difficulty = Number.isInteger(+b.difficulty) && +b.difficulty >= 0 && +b.difficulty <= 3 ? +b.difficulty : 1;
  const clearance = CLEARANCE.includes(b.clearance) ? b.clearance : 'any';
  return { name, notes: clean(b.notes, LIMITS.notes), bestFor: bf, difficulty, clearance, shared: b.shared === true, source: b.source === 'recorded' ? 'recorded' : 'drawn' };
}
const author = n => (n && n.trim()) || 'Lodestar member';
function out(r, me, full = false) {
  const t = {
    id: r.id, name: r.name, bestFor: r.best_for, difficulty: r.difficulty, clearance: r.clearance, notes: r.notes, shared: r.shared, source: r.source,
    len: Number(r.len_m), bbox: [r.min_lon, r.min_lat, r.max_lon, r.max_lat], start: [r.start_lon, r.start_lat],
    author: author(r.author_name), mine: r.owner_id === me, created: Number(r.created), updated: Number(r.updated),
    preview: r.preview,
  };
  if (full) t.coords = r.coords;
  if (t.mine) t.reports = r.report_count;
  return t;
}

async function limited(res, key, max, win) {
  const r = await rateLimit(key, max, win);
  if (!r.ok) { fail(res, 429, 'You\'re doing that too often. Please wait a bit and try again.', { retryAfter: r.retryAfter }); return true; }
  return false;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!checkWrite(req, res)) return;
    const u = await currentUser(req);
    if (!u) return fail(res, 401, 'Not signed in');
    const body = await readJson(req, LIMITS.body);
    if (!body) return fail(res, 413, 'Trail is too large.');
    const action = String(body.action || '');
    const now = Date.now();

    if (action === 'list') {
      if (await limited(res, `ct:list:${u.id}`, 120, 60e3)) return;
      const lon = +body.near?.[0], lat = +body.near?.[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return fail(res, 400, 'Location required.');
      const km = Math.min(Math.max(+body.radiusKm || 80, 1), 400);
      const dLat = km / 111.32, dLon = km / (111.32 * Math.max(0.05, Math.cos(rad(lat))));
      const bf = BEST_FOR.includes(body.bestFor) ? body.bestFor : null;
      const rows = await sql`SELECT t.id, t.owner_id, t.name, t.best_for, t.difficulty, t.clearance, t.notes, t.shared, t.source, t.len_m, t.min_lon, t.min_lat, t.max_lon, t.max_lat,
          t.start_lon, t.start_lat, t.report_count, t.created, t.updated, t.preview, u.name AS author_name
        FROM community_trails t JOIN users u ON u.id = t.owner_id
        WHERE (t.owner_id = ${u.id} OR (t.shared AND t.report_count < ${HIDE_AT_REPORTS}))
          AND t.max_lat >= ${lat - dLat} AND t.min_lat <= ${lat + dLat} AND t.max_lon >= ${lon - dLon} AND t.min_lon <= ${lon + dLon}
          AND (${bf}::text IS NULL OR ${bf}::text = ANY(t.best_for))
        ORDER BY ((t.start_lat - ${lat}) * (t.start_lat - ${lat}) + (t.start_lon - ${lon}) * (t.start_lon - ${lon}) * ${Math.cos(rad(lat)) ** 2}) LIMIT 150`;
      return send(res, 200, { trails: rows.map(r => out(r, u.id)) });
    }

    if (action === 'mine') {
      const rows = await sql`SELECT t.*, u.name AS author_name FROM community_trails t JOIN users u ON u.id = t.owner_id WHERE t.owner_id = ${u.id} ORDER BY t.updated DESC LIMIT 500`;
      return send(res, 200, { trails: rows.map(r => out(r, u.id, true)) });
    }

    if (action === 'get') {
      const id = clean(body.id, 64);
      const rows = await sql`SELECT t.*, u.name AS author_name FROM community_trails t JOIN users u ON u.id = t.owner_id
        WHERE t.id = ${id} AND (t.owner_id = ${u.id} OR (t.shared AND t.report_count < ${HIDE_AT_REPORTS}))`;
      if (!rows[0]) return fail(res, 404, 'This trail isn\'t available. It may be private or deleted.');
      return send(res, 200, { trail: out(rows[0], u.id, true) });
    }

    if (action === 'create') {
      if (await limited(res, `ct:create:${u.id}`, 20, 3600e3)) return;
      if (await limited(res, `ct:createday:${u.id}`, 60, 864e5)) return;
      const meta = cleanMeta(body); if (typeof meta === 'string') return fail(res, 400, meta);
      const g = cleanCoords(body.coords); if (typeof g === 'string') return fail(res, 400, g);
      const count = await sql`SELECT count(*)::int AS n FROM community_trails WHERE owner_id = ${u.id}`;
      if (count[0].n >= 500) return fail(res, 400, 'You\'ve reached the limit of 500 trails.');
      const id = newId('ct_');
      const rows = await sql`INSERT INTO community_trails (id, owner_id, name, best_for, difficulty, clearance, notes, shared, source, coords, preview, len_m,
          min_lon, min_lat, max_lon, max_lat, start_lon, start_lat, created, updated)
        VALUES (${id}, ${u.id}, ${meta.name}, ${meta.bestFor}, ${meta.difficulty}, ${meta.clearance}, ${meta.notes}, ${meta.shared}, ${meta.source},
          ${JSON.stringify(g.coords)}::jsonb, ${JSON.stringify(preview(g.coords))}::jsonb, ${g.len}, ${g.bbox[0]}, ${g.bbox[1]}, ${g.bbox[2]}, ${g.bbox[3]},
          ${g.coords[0][0]}, ${g.coords[0][1]}, ${now}, ${now})
        RETURNING *`;
      return send(res, 200, { trail: out({ ...rows[0], author_name: u.name }, u.id, true) });
    }

    if (action === 'update') {
      if (await limited(res, `ct:update:${u.id}`, 120, 3600e3)) return;
      const id = clean(body.id, 64);
      const meta = cleanMeta(body); if (typeof meta === 'string') return fail(res, 400, meta);
      let rows;
      if (body.coords != null) {
        const g = cleanCoords(body.coords); if (typeof g === 'string') return fail(res, 400, g);
        rows = await sql`UPDATE community_trails SET name = ${meta.name}, best_for = ${meta.bestFor}, difficulty = ${meta.difficulty}, clearance = ${meta.clearance},
            notes = ${meta.notes}, shared = ${meta.shared}, coords = ${JSON.stringify(g.coords)}::jsonb, preview = ${JSON.stringify(preview(g.coords))}::jsonb, len_m = ${g.len},
            min_lon = ${g.bbox[0]}, min_lat = ${g.bbox[1]}, max_lon = ${g.bbox[2]}, max_lat = ${g.bbox[3]}, start_lon = ${g.coords[0][0]}, start_lat = ${g.coords[0][1]}, updated = ${now}
          WHERE id = ${id} AND owner_id = ${u.id} RETURNING *`;
      } else {
        rows = await sql`UPDATE community_trails SET name = ${meta.name}, best_for = ${meta.bestFor}, difficulty = ${meta.difficulty}, clearance = ${meta.clearance},
            notes = ${meta.notes}, shared = ${meta.shared}, updated = ${now}
          WHERE id = ${id} AND owner_id = ${u.id} RETURNING *`;
      }
      // Same answer whether the trail doesn't exist or belongs to someone else.
      if (!rows[0]) return fail(res, 404, 'Only the person who created this trail can change it.');
      return send(res, 200, { trail: out({ ...rows[0], author_name: u.name }, u.id, true) });
    }

    if (action === 'delete') {
      if (await limited(res, `ct:update:${u.id}`, 120, 3600e3)) return;
      const id = clean(body.id, 64);
      const rows = await sql`DELETE FROM community_trails WHERE id = ${id} AND owner_id = ${u.id} RETURNING id`;
      if (!rows[0]) return fail(res, 404, 'Only the person who created this trail can delete it.');
      return send(res, 200, { ok: true });
    }

    if (action === 'report') {
      if (await limited(res, `ct:report:${u.id}`, 20, 3600e3)) return;
      const id = clean(body.id, 64), reason = clean(body.reason, LIMITS.reason);
      const t = await sql`SELECT owner_id FROM community_trails WHERE id = ${id} AND shared`;
      if (!t[0]) return fail(res, 404, 'This trail isn\'t available.');
      if (t[0].owner_id === u.id) return fail(res, 400, 'You can\'t report your own trail.');
      await sql`INSERT INTO trail_reports (trail_id, reporter_id, reason, created) VALUES (${id}, ${u.id}, ${reason}, ${now}) ON CONFLICT (trail_id, reporter_id) DO NOTHING`;
      await sql`UPDATE community_trails SET report_count = (SELECT count(*) FROM trail_reports WHERE trail_id = ${id}) WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }

    return fail(res, 404, 'Not found');
  } catch (e) {
    console.error('trails error', e?.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}
