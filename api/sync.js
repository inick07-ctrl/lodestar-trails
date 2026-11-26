// Lodestar sync API: push local changes, pull changes since a cursor. Per-user isolation by session.
import { ensureSchema, rawSql, sql, send, fail, readJson, checkWrite, currentUser } from '../lib/server.js';

const STORES = new Set(['favorites', 'tracks', 'waypoints', 'routes', 'notes', 'profile']);
const MAX_ITEMS = 400, MAX_ITEM_BYTES = 2_000_000, PULL_LIMIT = 300;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!checkWrite(req, res)) return;
    const u = await currentUser(req);
    if (!u) return fail(res, 401, 'Not signed in');
    const body = await readJson(req, 4_200_000);
    if (!body) return fail(res, 413, 'Request too large or invalid');
    const since = Number.isFinite(+body.since) && +body.since > 0 ? Math.floor(+body.since) : 0;
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (changes.length > MAX_ITEMS) return fail(res, 400, 'Too many changes in one request');

    const q = rawSql(), now = Date.now(), accepted = [];
    const stmts = [];
    for (const c of changes) {
      if (!c || !STORES.has(c.store) || typeof c.id !== 'string' || !c.id || c.id.length > 160) continue;
      const updated = Math.floor(+c.updated);
      if (!Number.isFinite(updated) || updated <= 0 || updated > now + 864e5) continue;
      const deleted = !!c.deleted;
      let data = null;
      if (!deleted) {
        if (!c.data || typeof c.data !== 'object') continue;
        data = JSON.stringify({ ...c.data, id: c.id });
        if (data.length > MAX_ITEM_BYTES) continue;
      }
      stmts.push(q`INSERT INTO items (user_id, store, id, updated, deleted, data, server_ts)
        VALUES (${u.id}, ${c.store}, ${c.id}, ${updated}, ${deleted}, ${data}::jsonb, nextval('items_seq'))
        ON CONFLICT (user_id, store, id) DO UPDATE SET updated = EXCLUDED.updated, deleted = EXCLUDED.deleted, data = EXCLUDED.data, server_ts = EXCLUDED.server_ts
        WHERE items.updated <= EXCLUDED.updated`);
      accepted.push(`${c.store}|${c.id}`);
    }
    if (stmts.length) await q.transaction(stmts);

    // server_ts comes from a sequence, so it strictly increases and works as a keyset cursor.
    const from = since;
    const rows = await sql`SELECT store, id, updated, deleted, data, server_ts FROM items
      WHERE user_id = ${u.id} AND server_ts > ${from} ORDER BY server_ts, store, id LIMIT ${PULL_LIMIT + 1}`;
    const more = rows.length > PULL_LIMIT;
    const items = rows.slice(0, PULL_LIMIT).map(r => ({ store: r.store, id: r.id, updated: Number(r.updated), deleted: r.deleted, data: r.deleted ? null : r.data, ts: Number(r.server_ts) }));
    const cursor = items.length ? items[items.length - 1].ts : since;
    return send(res, 200, { accepted, items, cursor, more, serverTime: now });
  } catch (e) {
    console.error('sync error', e?.message);
    return fail(res, 500, 'Sync failed. Will retry.');
  }
}
