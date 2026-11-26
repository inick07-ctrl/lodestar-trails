// Trail + POI data from OpenStreetMap via the public Overpass API (ODbL, © OSM contributors).
import { lineLength, bboxOf, chainSegments, hav, nearestOnLine } from './geo.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UNPAVED = 'unpaved|gravel|dirt|ground|compacted|sand|fine_gravel|grass|mud|earth|rock|pebblestone|woodchips|gravel;ground';
const PAVED = new Set(['asphalt', 'concrete', 'paved', 'paving_stones', 'concrete:plates', 'concrete:lanes', 'chipseal', 'metal', 'wood']);
const SMOOTHISH = new Set(['compacted', 'fine_gravel']);

export function overpassQuery(b) {
  const bb = `${b[1]},${b[0]},${b[3]},${b[2]}`;
  return `[out:json][timeout:90];
(
 way["highway"~"^(path|footway|bridleway|track|cycleway|steps|pedestrian)$"]["footway"!~"^(sidewalk|crossing)$"](${bb});
 way["highway"~"^(unclassified|service|residential|tertiary|secondary)$"]["surface"~"^(${UNPAVED})$"](${bb});
 way["4wd_only"="yes"](${bb});
)->.w;
relation["route"~"^(hiking|foot|bicycle|mtb|running|nordic_walking|walking)$"](${bb})->.r;
way(r.r)(${bb})->.rw;
(.w; .rw;);
out body geom qt;
.r out body qt;
(
 nwr["waterway"="waterfall"](${bb});
 nwr["tourism"~"^(viewpoint|camp_site|picnic_site|wilderness_hut|alpine_hut)$"](${bb});
 nwr["historic"~"^(monument|memorial|ruins|archaeological_site|fort|battlefield|castle|wreck|mine|building|manor|church|marker)$"](${bb});
 node["amenity"~"^(drinking_water|water_point|toilets|shelter)$"](${bb});
 node["natural"~"^(spring|peak|cave_entrance)$"](${bb});
 node["highway"="trailhead"](${bb});
 nwr["leisure"="firepit"](${bb});
 nwr["amenity"="parking"]["access"!~"private|no"]["parking"!~"underground|multi-storey"](${bb});
);
out tags center qt;`;
}

export async function fetchOverpass(bbox, signal) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  let lastErr; const pref = localStorage.getItem('ls-overpass');
  const eps = pref && ENDPOINTS.includes(pref) ? [pref, ...ENDPOINTS.filter(e => e !== pref)] : ENDPOINTS;
  for (const [i, ep] of eps.entries()) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), i === 0 ? 25000 : 60000);
      signal?.addEventListener('abort', () => ctrl.abort());
      const r = await fetch(ep, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) { lastErr = new Error('Overpass ' + r.status); continue; }
      const json = await r.json();
      localStorage.setItem('ls-overpass', ep);
      return processOSM(json, bbox);
    } catch (e) { if (signal?.aborted) throw e; lastErr = e; }
  }
  throw lastErr || new Error('Trail data unavailable');
}

const KEEP = ['highway', 'name', 'ref', 'surface', 'tracktype', 'smoothness', 'sac_scale', 'mtb:scale', 'trail_visibility', '4wd_only', 'access', 'motor_vehicle', 'vehicle', 'motorcar', 'foot', 'bicycle', 'horse', 'dog', 'wheelchair', 'incline', 'width', 'operator', 'description', 'website', 'seasonal', 'snowmobile', 'atv', 'lit', 'footway'];

function wayClass(t) {
  const hw = t.highway, no = v => v === 'no' || v === 'private';
  const pathy = ['path', 'footway', 'bridleway', 'steps', 'pedestrian', 'cycleway'].includes(hw);
  const unpavedRoad = ['unclassified', 'service', 'residential', 'tertiary', 'secondary'].includes(hw);
  const foot = !no(t.foot) && !no(t.access) || t.foot === 'yes' || t.foot === 'designated';
  const vehicleOk = !no(t.motor_vehicle) && !no(t.vehicle) && !no(t.motorcar) && !no(t.access);
  const offroad = (hw === 'track' || unpavedRoad || t['4wd_only'] === 'yes') && vehicleOk && !pathy;
  const hike = foot && (pathy || hw === 'track');
  const bike = hw === 'cycleway' || ['yes', 'designated', 'permissive'].includes(t.bicycle) || !!t['mtb:scale'] || (hw === 'track' && !no(t.bicycle)) || (hw === 'path' && !no(t.bicycle) && t.bicycle !== undefined);
  const easyFoot = !t.sac_scale || t.sac_scale === 'hiking';
  return { hike, bike, walk: hike && easyFoot, run: hike && easyFoot && hw !== 'steps', offroad };
}
function diffHike(t) {
  let d = { hiking: 0, mountain_hiking: 1, demanding_mountain_hiking: 2, alpine_hiking: 2, demanding_alpine_hiking: 2, difficult_alpine_hiking: 2 }[t.sac_scale] ?? 0;
  if (['bad', 'horrible', 'no'].includes(t.trail_visibility)) d++;
  if (t['mtb:scale'] && +t['mtb:scale'][0] >= 3) d = Math.max(d, 2);
  return Math.min(2, d);
}
function diffOff(t) {
  let d = { grade1: 0, grade2: 0, grade3: 1, grade4: 1, grade5: 2 }[t.tracktype];
  if (d == null) d = t.highway === 'track' ? 1 : 0;
  if (t['4wd_only'] === 'yes') d = 2;
  if (t.smoothness === 'very_bad') d = Math.max(d, 1);
  if (['horrible', 'very_horrible', 'impassable'].includes(t.smoothness)) d = 2;
  if (['sand', 'mud', 'rock'].includes(t.surface)) d = Math.min(2, d + 1);
  return d;
}

export function processOSM(json, bbox) {
  const ways = new Map(), rels = [], pois = [];
  for (const e of json.elements) {
    if (e.type === 'way' && e.geometry && !e.center) {
      const tags = {}; for (const k of KEEP) if (e.tags?.[k] != null) tags[k] = e.tags[k];
      const coords = e.geometry.filter(Boolean).map(g => [+g.lon.toFixed(6), +g.lat.toFixed(6)]);
      if (coords.length < 2) continue;
      const cls = wayClass(tags);
      ways.set(e.id, { id: e.id, coords, nodes: e.nodes || [], tags, cls, dh: diffHike(tags), do: diffOff(tags), len: lineLength(coords), paved: PAVED.has(tags.surface) || (!tags.surface && ['cycleway', 'pedestrian'].includes(tags.highway)) });
    } else if (e.type === 'relation' && e.members) {
      rels.push({ id: e.id, tags: e.tags || {}, members: e.members.filter(m => m.type === 'way').map(m => m.ref) });
    } else if (e.tags && (e.lat != null || e.center)) {
      const lat = e.lat ?? e.center.lat, lon = e.lon ?? e.center.lon, t = e.tags;
      const kind = t.waterway === 'waterfall' ? 'waterfall' : t.tourism === 'viewpoint' ? 'viewpoint' : t.tourism === 'camp_site' ? 'camp' : t.tourism === 'picnic_site' ? 'picnic'
        : /hut/.test(t.tourism || '') || t.amenity === 'shelter' ? 'shelter' : t.historic ? 'historic' : ['drinking_water', 'water_point'].includes(t.amenity) || t.natural === 'spring' ? 'water'
        : t.amenity === 'toilets' ? 'toilets' : t.natural === 'peak' ? 'peak' : t.natural === 'cave_entrance' ? 'cave' : t.highway === 'trailhead' ? 'trailhead' : t.leisure === 'firepit' ? 'firepit' : t.amenity === 'parking' ? 'parking' : 'poi';
      pois.push({ id: e.type[0] + e.id, kind, name: t.name || '', lon: +lon.toFixed(6), lat: +lat.toFixed(6), ele: t.ele ? +t.ele : null, desc: t.description || t.inscription || '', website: t.website || '' });
    }
  }
  // drop parking that isn't near a trail (keeps the map tidy)
  const allWays = [...ways.values()];
  const keptPois = pois.filter(p => p.kind !== 'parking' || allWays.some(w => (w.cls.hike || w.cls.offroad) && nearestOnLine([p.lon, p.lat], w.coords).dist < 120));
  const trails = buildTrails(ways, rels);
  return { bbox, fetched: Date.now(), ways: allWays.map(w => ({ id: w.id, coords: w.coords, tags: w.tags, cls: w.cls, dh: w.dh, do: w.do, len: w.len, paved: w.paved })), trails, pois: keptPois };
}

function buildTrails(ways, rels) {
  const used = new Set(), trails = [];
  for (const r of rels) {
    const ws = r.members.map(id => ways.get(id)).filter(Boolean);
    if (!ws.length) continue;
    ws.forEach(w => used.add(w.id));
    const rt = r.tags.route;
    const act = { hike: ['hiking', 'foot', 'walking', 'nordic_walking'].includes(rt), walk: ['hiking', 'foot', 'walking'].includes(rt), run: ['running', 'foot'].includes(rt), bike: ['bicycle', 'mtb'].includes(rt) };
    trails.push(makeTrail('r' + r.id, r.tags.name || r.tags.ref || 'Unnamed route', ws, act, r.tags));
  }
  // union-find groups over shared nodes: named by name, unnamed by family
  const parent = new Map(), find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const groupKey = w => (w.tags.name ? 'n:' + w.tags.name : 'u:' + (w.cls.offroad ? 'v' : 'f'));
  const nodeIdx = new Map();
  for (const w of ways.values()) {
    if (used.has(w.id) || !(w.cls.hike || w.cls.offroad || w.cls.bike)) continue;
    parent.set(w.id, w.id);
    const gk = groupKey(w);
    for (const n of w.nodes) { const k = gk + '|' + n; if (nodeIdx.has(k)) parent.set(find(w.id), find(nodeIdx.get(k))); else nodeIdx.set(k, w.id); }
  }
  const groups = new Map();
  for (const id of parent.keys()) { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(ways.get(id)); }
  for (const [root, ws] of groups) {
    const name = ws[0].tags.name;
    const len = ws.reduce((a, w) => a + w.len, 0);
    if (!name && len < 400) continue;
    if (name && len < 150) continue;
    const act = {}; for (const w of ws) for (const k in w.cls) act[k] = act[k] || w.cls[k];
    const label = name || (act.offroad ? 'Unnamed track' : act.bike && !act.hike ? 'Unnamed bike path' : 'Unnamed path');
    const t = makeTrail('u' + Math.min(...ws.map(w => w.id)), label, ws, act, {});
    if (name) t.id = 'n:' + name + '@' + t.center[0].toFixed(2) + ',' + t.center[1].toFixed(2);
    trails.push(t);
  }
  return trails;
}

function makeTrail(id, name, ws, act, rtags) {
  const len = ws.reduce((a, w) => a + w.len, 0);
  const all = ws.flatMap(w => w.coords), bbox = bboxOf(all);
  const anyCls = k => ws.some(w => w.cls[k]);
  const activities = { hike: !!(act.hike || anyCls('hike')), walk: !!(act.walk || anyCls('walk')), run: !!(act.run || anyCls('run')), bike: !!(act.bike || anyCls('bike')), offroad: anyCls('offroad') && !act.hike && !act.bike };
  const wd = (k) => { const s = ws.map(w => [w[k], w.len]).sort((a, b) => b[0] - a[0]); let acc = 0; for (const [d, l] of s) { acc += l; if (acc >= len * 0.15) return d; } return 0; };
  const surf = {}; for (const w of ws) { const s = w.tags.surface || (w.paved ? 'paved' : 'unknown'); surf[s] = (surf[s] || 0) + w.len; }
  const pavedLen = ws.filter(w => w.paved).reduce((a, w) => a + w.len, 0);
  const smoothLen = ws.filter(w => w.paved || SMOOTHISH.has(w.tags.surface)).reduce((a, w) => a + w.len, 0);
  const steps = ws.some(w => w.tags.highway === 'steps');
  const tagVals = k => [...new Set(ws.map(w => w.tags[k]).filter(Boolean))];
  const dogs = tagVals('dog'); const dog = dogs.includes('no') ? 'no' : dogs.includes('leashed') ? 'leashed' : dogs.includes('yes') ? 'yes' : (rtags.dog || 'unknown');
  const wc = tagVals('wheelchair'); const dh = wd('dh');
  const wheelchair = wc.includes('no') ? 'no' : wc.includes('yes') && !steps ? 'yes' : pavedLen >= len * 0.9 && !steps && dh === 0 ? 'likely' : 'unknown';
  const stroller = smoothLen >= len * 0.8 && !steps && dh === 0;
  const chain = chainSegments(ws.map(w => w.coords));
  return {
    id, name, len, bbox, center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], start: chain[0], wayIds: ws.map(w => w.id),
    activities, diffHike: dh, diffOff: wd('do'), diffBike: Math.max(0, ...ws.map(w => w.tags['mtb:scale'] ? Math.min(2, Math.floor(+w.tags['mtb:scale'][0] / 1.5)) : 0)),
    surface: surf, dog, wheelchair, stroller, kid: len <= 5000 && dh === 0 && !steps,
    lit: ws.some(w => w.tags.lit === 'yes'), fourwd: ws.some(w => w.tags['4wd_only'] === 'yes'), seasonal: tagVals('seasonal')[0] || '',
    operator: rtags.operator || tagVals('operator')[0] || '', website: rtags.website || tagVals('website')[0] || '', description: rtags.description || tagVals('description')[0] || '',
    access: tagVals('access').join(', '), chain: chain.length > 1 ? chain : ws[0].coords,
  };
}

export function trailCoords(trail, waysById) { return trail.wayIds.map(id => waysById.get(id)?.coords).filter(Boolean); }

export function difficultyFor(trail, mode, activity) {
  if (activity === 'offroad' || (mode === 'gx' && !activity)) return trail.diffOff;
  if (activity === 'bike') return Math.max(trail.diffBike, trail.diffHike);
  return trail.diffHike;
}
export const DIFF_LABEL = ['Easy', 'Moderate', 'Hard'];

export function poisNear(pois, coords, maxD = 150) {
  const out = [];
  for (const p of pois) {
    if (p.kind === 'parking') continue;
    let best = Infinity; for (const seg of coords) { const n = nearestOnLine([p.lon, p.lat], seg); if (n.dist < best) best = n.dist; if (best < maxD) break; }
    if (best < maxD) out.push(p);
  }
  return out;
}
export function nearestParking(pois, pt) {
  let best = null, bd = 400; for (const p of pois) if (p.kind === 'parking' || p.kind === 'trailhead') { const d = hav(pt, [p.lon, p.lat]); if (d < bd) { bd = d; best = p; } }
  return best;
}
