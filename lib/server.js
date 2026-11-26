// Shared server helpers for Lodestar API routes (Vercel Node functions).
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

let _sql;
export function sql(strings, ...vals) {
  _sql ||= neon(process.env.DATABASE_URL);
  return _sql(strings, ...vals);
}
export function rawSql() { _sql ||= neon(process.env.DATABASE_URL); return _sql; }

let schemaReady = null;
export function ensureSchema() {
  return schemaReady ||= (async () => {
    const q = rawSql();
    await q`CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL DEFAULT '',
      pw_hash text NOT NULL, created bigint NOT NULL, pw_changed bigint NOT NULL)`;
    await q`CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created bigint NOT NULL, expires bigint NOT NULL, last_seen bigint NOT NULL)`;
    await q`CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`;
    await q`CREATE SEQUENCE IF NOT EXISTS items_seq`;
    await q`CREATE TABLE IF NOT EXISTS items (
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, store text NOT NULL, id text NOT NULL,
      updated bigint NOT NULL, deleted boolean NOT NULL DEFAULT false, data jsonb, server_ts bigint NOT NULL,
      PRIMARY KEY (user_id, store, id))`;
    await q`CREATE INDEX IF NOT EXISTS items_user_ts ON items(user_id, server_ts)`;
    await q`CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, count int NOT NULL, reset bigint NOT NULL)`;
  })().catch(e => { schemaReady = null; throw e; });
}

// ---------- HTTP helpers ----------
export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
export const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra });

export async function readJson(req, limit = 4_000_000) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return null; } }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return null; }
}

// CSRF defence for state-changing requests: JSON + custom header + same-origin.
export function checkWrite(req, res) {
  if (req.method !== 'POST') { fail(res, 405, 'Method not allowed'); return false; }
  if (req.headers['x-lodestar'] !== '1' || !String(req.headers['content-type'] || '').includes('application/json')) { fail(res, 400, 'Bad request'); return false; }
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try { if (new URL(origin).host !== host) { fail(res, 403, 'Cross-site request blocked'); return false; } } catch { fail(res, 403, 'Bad origin'); return false; }
  }
  return true;
}
export function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 64);
}

// ---------- validation ----------
export function cleanEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}
export function cleanName(v) { return String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60); }
export function checkPassword(p) {
  if (typeof p !== 'string') return 'Password is required.';
  if (p.length < 8) return 'Use at least 8 characters.';
  if (p.length > 128) return 'Password is too long.';
  return null;
}

// ---------- sessions ----------
const COOKIE = 'ls_session';
const SESSION_DAYS = 90;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (p = '') => p + crypto.randomBytes(12).toString('base64url');

export async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url'), now = Date.now(), exp = now + SESSION_DAYS * 864e5;
  await sql`INSERT INTO sessions (token_hash, user_id, created, expires, last_seen) VALUES (${sha(token)}, ${userId}, ${now}, ${exp}, ${now})`;
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export function clearCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); }
function readToken(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)ls_session=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}
export async function currentUser(req) {
  const token = readToken(req); if (!token) return null;
  const now = Date.now();
  const rows = await sql`SELECT u.id, u.email, u.name, u.created, s.token_hash, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${sha(token)} AND s.expires > ${now}`;
  const r = rows[0]; if (!r) return null;
  if (now - Number(r.last_seen) > 864e5) await sql`UPDATE sessions SET last_seen = ${now} WHERE token_hash = ${r.token_hash}`;
  return { id: r.id, email: r.email, name: r.name, created: Number(r.created), tokenHash: r.token_hash };
}
export const publicUser = u => ({ id: u.id, email: u.email, name: u.name, created: Number(u.created) });

// ---------- rate limiting (fixed window, stored in Postgres) ----------
export async function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const rows = await sql`INSERT INTO rate_limits (key, count, reset) VALUES (${key}, 1, ${now + windowMs})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset < ${now} THEN 1 ELSE rate_limits.count + 1 END,
      reset = CASE WHEN rate_limits.reset < ${now} THEN ${now + windowMs} ELSE rate_limits.reset END
    RETURNING count, reset`;
  const { count, reset } = rows[0];
  if (Math.random() < 0.02) sql`DELETE FROM rate_limits WHERE reset < ${now - 864e5}`.catch(() => {});
  return { ok: count <= max, retryAfter: Math.max(1, Math.ceil((Number(reset) - now) / 1000)) };
}
