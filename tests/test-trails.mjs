// Community trails API tests: create, share, visibility, owner-only edits, reports, limits, rate limit, delete-account cascade.
// Runs against the local dev server (tests/dev-server.mjs) or URL=... . Passwords are random and never printed.
import crypto from 'node:crypto';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const BASE = (process.env.URL || 'http://localhost:8788/').replace(/\/$/, '');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const { neon } = await import('@neondatabase/serverless');
const q = neon(process.env.DATABASE_URL);

let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const HOME = [-94.7114, 45.3805];
const line = (n = 12, dx = 0.0009, dy = 0.0004, o = [0, 0]) => Array.from({ length: n }, (_, i) => [+(HOME[0] + o[0] + i * dx).toFixed(6), +(HOME[1] + o[1] + Math.sin(i / 2) * dy + i * 0.0002).toFixed(6)]);

async function req(path, body, { cookie, headers = {}, raw } = {}) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lodestar': '1', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(body) });
  let data = {}; const text = await r.text(); try { data = JSON.parse(text); } catch { }
  return { status: r.status, data, text, setCookie: r.headers.get('set-cookie') };
}
async function signup(tag, name) {
  const email = `lodestar-e2e-trails-${tag}-${Date.now()}@example.com`, password = crypto.randomBytes(9).toString('base64url') + 'a1';
  const r = await req('/api/auth/signup', { email, password, name });
  if (r.status !== 200 && r.status !== 201) throw new Error(`signup ${tag} failed: ${r.status} ${r.data.error || ''}`);
  const cookie = r.setCookie.match(/ls_session=[^;]+/)[0];
  return { email, password, cookie, id: r.data.user.id, name };
}
const T = (u, action, body = {}) => req('/api/trails', { action, ...body }, { cookie: u.cookie });
const base = { bestFor: ['hike'], difficulty: 1, clearance: 'any', notes: 'Park at the gravel lot.', source: 'drawn' };

let A, B;
try {
  A = await signup('a', 'Maya R.'); B = await signup('b', 'Jake T.');

  // ---- security basics ----
  ok((await req('/api/trails', { action: 'list', near: HOME })).status === 401, 'not signed in → 401');
  ok((await req('/api/trails', { action: 'list', near: HOME }, { cookie: A.cookie, headers: { 'X-Lodestar': '' } })).status === 400, 'missing CSRF header → 400');
  ok((await req('/api/trails', { action: 'list', near: HOME }, { cookie: A.cookie, headers: { Origin: 'https://evil.example' } })).status === 403, 'cross-site Origin → 403');
  const g = await fetch(BASE + '/api/trails', { headers: { Cookie: A.cookie } });
  ok(g.status === 405, 'GET → 405');

  // ---- create ----
  const priv = await T(A, 'create', { ...base, name: 'Maya private loop', coords: line(), shared: false });
  ok(priv.status === 200 && priv.data.trail.shared === false && priv.data.trail.mine === true, 'create private trail');
  const pub = await T(A, 'create', { ...base, name: 'Koronis Ridge Trail', bestFor: ['hike', 'bike', 'bogus'], coords: line(30, 0.0007, 0.0006, [0.004, 0.003]), shared: true });
  ok(pub.status === 200 && pub.data.trail.shared === true, 'create shared trail');
  ok(JSON.stringify(pub.data.trail.bestFor) === '["hike","bike"]', 'unknown best-for values are dropped');
  ok(pub.data.trail.len > 100 && pub.data.trail.coords.length === 30, 'length + geometry stored');
  const veh = await T(A, 'create', { ...base, name: 'Two-track to the lake', bestFor: ['offroad4wd', 'overland'], clearance: 'high', coords: line(10, 0.001, 0.0003, [-0.01, -0.006]), shared: true });
  ok(veh.status === 200 && veh.data.trail.clearance === 'high', 'vehicle clearance requirement stored');
  const pid = priv.data.trail.id, sid = pub.data.trail.id;

  // ---- visibility to another user ----
  const listB = await T(B, 'list', { near: HOME, radiusKm: 30 });
  const idsB = listB.data.trails.map(t => t.id);
  ok(listB.status === 200 && idsB.includes(sid), 'other user sees the shared trail in Community');
  ok(!idsB.includes(pid), 'other user does NOT see the private trail');
  const seen = listB.data.trails.find(t => t.id === sid);
  ok(seen.author === 'Maya R.' && seen.mine === false, 'author shown by display name, mine=false');
  ok(!listB.text.includes('@') && !('owner_id' in seen) && !('email' in seen), 'no emails or owner ids in community responses');
  ok(!('coords' in seen) && seen.preview.length >= 2, 'list returns light preview geometry');
  const filt = await T(B, 'list', { near: HOME, radiusKm: 30, bestFor: 'offroad4wd' });
  ok(filt.data.trails.every(t => t.bestFor.includes('offroad4wd')) && filt.data.trails.some(t => t.id === veh.data.trail.id) && !filt.data.trails.some(t => t.id === sid), 'best-for filter works');
  const far = await T(B, 'list', { near: [-105.0, 39.7], radiusKm: 50 });
  ok(!far.data.trails.some(t => t.id === sid), 'distance filter excludes far-away trails');
  const getB = await T(B, 'get', { id: sid });
  ok(getB.status === 200 && getB.data.trail.coords.length === 30 && !('reports' in getB.data.trail), 'other user can open the full shared trail');
  ok((await T(B, 'get', { id: pid })).status === 404, 'other user gets 404 for a private trail');

  // ---- non-owner can't change or delete ----
  const upB = await T(B, 'update', { ...base, id: sid, name: 'Hijacked', coords: line(3), shared: true });
  ok(upB.status === 404, 'non-owner update → refused');
  const delB = await T(B, 'delete', { id: sid });
  ok(delB.status === 404, 'non-owner delete → refused');
  const after = await T(A, 'get', { id: sid });
  ok(after.status === 200 && after.data.trail.name === 'Koronis Ridge Trail' && after.data.trail.coords.length === 30, 'trail unchanged after non-owner attempts');

  // ---- owner edits ----
  const upA = await T(A, 'update', { ...base, id: sid, name: 'Koronis Ridge Trail (north loop)', bestFor: ['hike', 'bike'], shared: true, notes: 'Updated by owner' });
  ok(upA.status === 200 && upA.data.trail.name.includes('north loop') && upA.data.trail.coords.length === 30, 'owner can edit metadata (geometry kept)');
  ok((await T(B, 'get', { id: sid })).data.trail.name.includes('north loop'), 'other user sees the owner\'s edit');
  const unshare = await T(A, 'update', { ...base, id: pid, name: 'Maya private loop', shared: true });
  ok(unshare.status === 200 && (await T(B, 'get', { id: pid })).status === 200, 'owner can switch private → shared');
  await T(A, 'update', { ...base, id: pid, name: 'Maya private loop', shared: false });
  ok((await T(B, 'get', { id: pid })).status === 404, 'owner can switch back to private');
  const mine = await T(A, 'mine');
  ok(mine.status === 200 && mine.data.trails.length === 3 && mine.data.trails.every(t => t.mine), '“mine” lists all of the owner\'s trails');

  // ---- report ----
  ok((await T(B, 'report', { id: sid, reason: 'Crosses private land' })).status === 200, 'other user can report a shared trail');
  ok((await T(B, 'report', { id: sid, reason: 'again' })).status === 200, 'reporting twice is idempotent');
  ok((await T(A, 'report', { id: sid })).status === 400, 'owner can\'t report own trail');
  ok((await T(B, 'report', { id: pid })).status === 404, 'can\'t report a private trail');
  const rc = await T(A, 'get', { id: sid });
  ok(rc.data.trail.reports === 1, 'owner sees one report count (one per user)');
  const flags = await q`SELECT count(*)::int AS n FROM trail_reports WHERE trail_id = ${sid}`;
  ok(flags[0].n === 1, 'report flag stored in trail_reports');

  // ---- limits ----
  const bad = async (body, msg, status = 400) => { const r = await T(A, 'create', { ...base, coords: line(), shared: false, name: 'x', ...body }); ok(r.status === status, `${msg} → ${status}${r.status !== status ? ' (got ' + r.status + ')' : ''}`); };
  await bad({ name: 'x'.repeat(81) }, 'name over 80 chars');
  await bad({ name: '   ' }, 'blank name');
  await bad({ notes: 'n'.repeat(2001) }, 'notes over 2000 chars');
  await bad({ bestFor: [] }, 'no best-for');
  await bad({ coords: [[HOME[0], HOME[1]]] }, 'single point');
  await bad({ coords: [[200, 45], [201, 46]] }, 'out-of-range coordinates');
  await bad({ coords: [['a', 'b'], [1, 2]] }, 'non-numeric coordinates');
  await bad({ coords: Array.from({ length: 5001 }, (_, i) => [HOME[0] + i * 1e-5, HOME[1]]) }, 'more than 5000 points');
  await bad({ coords: [[-94, 45], [-90, 45]] }, 'huge jump between points');
  const big = await req('/api/trails', null, { cookie: A.cookie, raw: JSON.stringify({ action: 'create', ...base, name: 'big', notes: 'z'.repeat(450_000), coords: line() }) });
  ok(big.status === 413, 'request body over 400 KB → 413');
  const xss = await T(A, 'create', { ...base, name: '<img src=x onerror=alert(1)>', coords: line(4), shared: false });
  ok(xss.status === 200 && xss.data.trail.name === '<img src=x onerror=alert(1)>', 'HTML stored as plain text (UI escapes it)');
  await T(A, 'delete', { id: xss.data.trail.id });

  // ---- rate limit on create (20 / hour per user) ----
  let created = 0, limited = false;
  for (let i = 0; i < 22; i++) {
    const r = await T(B, 'create', { ...base, name: 'rate ' + i, coords: line(3, 0.001, 0, [0.02 + i * 0.001, 0]), shared: false });
    if (r.status === 200) created++; else if (r.status === 429) { limited = true; break; }
  }
  ok(limited && created === 20, `create is rate-limited after 20/hour (created ${created})`);

  // ---- owner delete ----
  ok((await T(A, 'delete', { id: veh.data.trail.id })).status === 200, 'owner can delete own trail');
  ok((await T(B, 'get', { id: veh.data.trail.id })).status === 404, 'deleted trail is gone for everyone');

  // ---- delete-account cascade ----
  const before = await q`SELECT count(*)::int AS n FROM community_trails WHERE owner_id = ${A.id}`;
  ok(before[0].n === 2, 'owner has 2 trails before account deletion');
  const del = await req('/api/auth/delete', { password: A.password }, { cookie: A.cookie });
  ok(del.status === 200, 'account deleted');
  const left = await q`SELECT count(*)::int AS n FROM community_trails WHERE owner_id = ${A.id}`;
  const leftRep = await q`SELECT count(*)::int AS n FROM trail_reports WHERE trail_id = ${sid}`;
  ok(left[0].n === 0 && leftRep[0].n === 0, 'deleting the account removed their shared trails (and reports on them)');
  ok((await T(B, 'get', { id: sid })).status === 404, 'other users can no longer open them');
  A = null;
} catch (e) { console.log('✗ test crashed:', e.message); fails++; }
finally {
  for (const u of [A, B].filter(Boolean)) await req('/api/auth/delete', { password: u.password }, { cookie: u.cookie }).catch(() => { });
  const leftover = await q`SELECT count(*)::int AS n FROM users WHERE email LIKE 'lodestar-e2e-trails-%'`;
  console.log('cleanup: test users left', leftover[0].n);
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
