// Lodestar auth API: signup, login, logout, me, password, delete.
import bcrypt from 'bcryptjs';
import { ensureSchema, sql, send, fail, readJson, checkWrite, clientIp, cleanEmail, cleanName, checkPassword, createSession, clearCookie, currentUser, publicUser, rateLimit, newId } from '../../lib/server.js';

const COST = 11;
// Used so unknown-email logins take the same time as real ones.
const DUMMY_HASH = bcrypt.hashSync('lodestar-timing-dummy', COST);

async function limited(res, key, max, win, msg = 'Too many attempts. Please wait a few minutes and try again.') {
  const r = await rateLimit(key, max, win);
  if (!r.ok) { fail(res, 429, msg, { retryAfter: r.retryAfter }); return true; }
  return false;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const action = String(req.query?.action || '').toLowerCase();
    const ip = clientIp(req);

    if (action === 'me') {
      if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
      const u = await currentUser(req);
      return u ? send(res, 200, { user: publicUser(u) }) : fail(res, 401, 'Not signed in');
    }
    if (!checkWrite(req, res)) return;
    const body = await readJson(req, 20_000);
    if (!body) return fail(res, 400, 'Invalid request body');

    if (action === 'signup') {
      if (await limited(res, `signup:ip:${ip}`, 8, 3600e3)) return;
      const email = cleanEmail(body.email), name = cleanName(body.name), pwErr = checkPassword(body.password);
      if (!email) return fail(res, 400, 'Enter a valid email address.');
      if (pwErr) return fail(res, 400, pwErr);
      const exists = await sql`SELECT 1 FROM users WHERE email = ${email}`;
      if (exists.length) return fail(res, 409, 'An account with this email already exists. Try signing in.');
      const id = newId('u_'), now = Date.now(), hash = await bcrypt.hash(body.password, COST);
      try { await sql`INSERT INTO users (id, email, name, pw_hash, created, pw_changed) VALUES (${id}, ${email}, ${name}, ${hash}, ${now}, ${now})`; }
      catch (e) { if (String(e.message).includes('duplicate')) return fail(res, 409, 'An account with this email already exists. Try signing in.'); throw e; }
      await createSession(res, id);
      return send(res, 201, { user: { id, email, name, created: now } });
    }

    if (action === 'login') {
      const email = cleanEmail(body.email);
      if (await limited(res, `login:ip:${ip}`, 20, 900e3)) return;
      if (email && await limited(res, `login:email:${email}`, 8, 900e3)) return;
      if (!email || typeof body.password !== 'string' || body.password.length > 128) { await bcrypt.compare('x', DUMMY_HASH); return fail(res, 401, 'Email or password is incorrect.'); }
      const rows = await sql`SELECT id, email, name, created, pw_hash FROM users WHERE email = ${email}`;
      const u = rows[0];
      const ok = await bcrypt.compare(body.password, u ? u.pw_hash : DUMMY_HASH);
      if (!u || !ok) return fail(res, 401, 'Email or password is incorrect.');
      await createSession(res, u.id);
      return send(res, 200, { user: publicUser(u) });
    }

    if (action === 'logout') {
      const u = await currentUser(req);
      if (u) await sql`DELETE FROM sessions WHERE token_hash = ${u.tokenHash}`;
      clearCookie(res);
      return send(res, 200, { ok: true });
    }

    // Everything below needs a signed-in user.
    const u = await currentUser(req);
    if (!u) return fail(res, 401, 'Not signed in');

    if (action === 'password') {
      if (await limited(res, `pw:user:${u.id}`, 8, 900e3)) return;
      const pwErr = checkPassword(body.next);
      if (pwErr) return fail(res, 400, pwErr);
      const rows = await sql`SELECT pw_hash FROM users WHERE id = ${u.id}`;
      if (typeof body.current !== 'string' || !(await bcrypt.compare(body.current, rows[0].pw_hash))) return fail(res, 401, 'Current password is incorrect.');
      const hash = await bcrypt.hash(body.next, COST), now = Date.now();
      await sql`UPDATE users SET pw_hash = ${hash}, pw_changed = ${now} WHERE id = ${u.id}`;
      // Sign out every other device.
      await sql`DELETE FROM sessions WHERE user_id = ${u.id} AND token_hash <> ${u.tokenHash}`;
      return send(res, 200, { ok: true });
    }

    if (action === 'delete') {
      if (await limited(res, `del:user:${u.id}`, 8, 900e3)) return;
      const rows = await sql`SELECT pw_hash FROM users WHERE id = ${u.id}`;
      if (typeof body.password !== 'string' || !(await bcrypt.compare(body.password, rows[0].pw_hash))) return fail(res, 401, 'Password is incorrect.');
      await sql`DELETE FROM users WHERE id = ${u.id}`; // sessions + items cascade
      clearCookie(res);
      return send(res, 200, { ok: true });
    }

    if (action === 'profile') {
      const name = cleanName(body.name);
      await sql`UPDATE users SET name = ${name} WHERE id = ${u.id}`;
      return send(res, 200, { user: { ...publicUser(u), name } });
    }

    return fail(res, 404, 'Not found');
  } catch (e) {
    console.error('auth error', e?.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}
