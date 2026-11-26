// Accounts + sync. Session cookie is httpOnly; we keep a non-secret copy of the profile locally so the app works offline.
import { db, SYNC_STORES, onLocalChange } from './db.js';

export const acct = { user: null, syncing: false, lastSync: 0, pending: 0, error: '', listeners: new Set() };
const emit = () => acct.listeners.forEach(f => { try { f(acct); } catch { } });

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api/' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json', 'X-Lodestar': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { }
  if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; e.retryAfter = data.retryAfter; throw e; }
  return data;
}

// Local data belongs to one account; wipe it if someone else signs in on this device.
async function adoptUser(user) {
  const owner = await db.kvGet('owner', null);
  if (owner && owner !== user.id) await wipeLocal();
  await db.kvSet('owner', user.id);
  await db.kvSet('session', { user, at: Date.now() });
  acct.user = user; emit();
}
export async function wipeLocal() {
  const settings = await db.kvGet('settings', null);
  await db.clearAll();
  try { for (const k of await caches.keys()) if (!k.startsWith('ls-shell')) await caches.delete(k); } catch { }
  try { localStorage.removeItem('ls-overpass'); } catch { }
  // keep only non-personal display preferences
  if (settings) await db.kvSet('settings', { theme: settings.theme, imperial: settings.imperial });
}

export async function restoreSession() {
  const s = await db.kvGet('session', null);
  acct.user = s?.user || null;
  acct.lastSync = await db.kvGet('lastSync', 0);
  return acct.user;
}
// Returns 'ok' | 'expired' | 'offline'
export async function verifySession() {
  if (!navigator.onLine) return 'offline';
  try { const { user } = await api('auth/me'); await adoptUser(user); return 'ok'; }
  catch (e) { if (e.status === 401) return 'expired'; return 'offline'; }
}
export async function signUp(email, password, name) { const { user } = await api('auth/signup', { method: 'POST', body: { email, password, name } }); await adoptUser(user); await db.kvSet('syncCursor', 0); await queueAllLocal(); return user; }
export async function signIn(email, password) { const { user } = await api('auth/login', { method: 'POST', body: { email, password } }); const prev = await db.kvGet('owner', null); await adoptUser(user); if (prev !== user.id) await db.kvSet('syncCursor', 0); return user; }
export async function signOut() {
  try { await syncNow(); } catch { }
  try { await api('auth/logout', { method: 'POST', body: {} }); } catch { }
  await wipeLocal(); acct.user = null; emit();
}
export async function changePassword(current, next) { await api('auth/password', { method: 'POST', body: { current, next } }); }
export async function updateName(name) { const { user } = await api('auth/profile', { method: 'POST', body: { name } }); await adoptUser(user); return user; }
export async function deleteAccount(password) { await api('auth/delete', { method: 'POST', body: { password } }); await wipeLocal(); acct.user = null; emit(); }

// Queue every local synced item (used right after creating an account on a device with existing data).
async function queueAllLocal() {
  for (const s of SYNC_STORES) for (const v of await db.all(s)) await db.put(s, v);
}

// ---------- sync engine ----------
let timer = null, running = null;
export function scheduleSync(ms = 2500) { clearTimeout(timer); timer = setTimeout(() => syncNow().catch(() => { }), ms); }
export async function pendingCount() { acct.pending = (await db.all('outbox')).length; return acct.pending; }

export function syncNow() {
  if (running) return running;
  running = (async () => {
    if (!acct.user || !navigator.onLine) { await pendingCount(); emit(); return; }
    acct.syncing = true; acct.error = ''; emit();
    try {
      // 1) push in size-limited batches
      let out = await db.all('outbox');
      while (out.length) {
        const batch = [], ids = []; let size = 0;
        for (const o of out) {
          const data = o.deleted ? null : await db.get(o.store, o.itemId);
          const item = { store: o.store, id: o.itemId, updated: o.updated, deleted: o.deleted || !data, data: data || null };
          const len = JSON.stringify(item).length;
          if (len > 1_900_000) { ids.push(o); continue; } // too big to sync (e.g. huge track) — drop from queue
          if (batch.length && (size + len > 3_000_000 || batch.length >= 300)) break;
          batch.push(item); ids.push(o); size += len;
        }
        const cursor = await db.kvGet('syncCursor', 0);
        const res = await api('sync', { method: 'POST', body: { since: cursor, changes: batch } });
        // only remove outbox entries that weren't changed again meanwhile
        for (const o of ids) { const cur = await db.get('outbox', o.id); if (cur && cur.updated === o.updated) await db.del('outbox', o.id); }
        await applyRemote(res.items); await db.kvSet('syncCursor', res.cursor);
        if (res.more) await pullAll();
        out = await db.all('outbox');
        if (!batch.length) break;
      }
      // 2) pull anything newer
      await pullAll();
      acct.lastSync = Date.now(); await db.kvSet('lastSync', acct.lastSync);
    } catch (e) {
      acct.error = e.status === 401 ? 'Session expired — sign in again' : (e.message || 'Sync failed');
      if (e.status === 401) acct.expired = true;
    } finally { acct.syncing = false; await pendingCount(); emit(); running = null; }
  })();
  return running;
}
async function pullAll() {
  for (let i = 0; i < 50; i++) {
    const cursor = await db.kvGet('syncCursor', 0);
    const res = await api('sync', { method: 'POST', body: { since: cursor, changes: [] } });
    await applyRemote(res.items); await db.kvSet('syncCursor', res.cursor);
    if (!res.more) break;
  }
}
async function applyRemote(items) {
  let changed = false;
  for (const it of items || []) {
    if (!SYNC_STORES.has(it.store)) continue;
    const pending = await db.get('outbox', `${it.store}|${it.id}`);
    if (pending && pending.updated > it.updated) continue; // local edit is newer; it will be pushed
    const local = await db.get(it.store, it.id);
    if (local && (local.updated || 0) > it.updated) continue;
    if (it.deleted) { if (local) { await db.del(it.store, it.id, { remote: true }); changed = true; } }
    else { await db.put(it.store, { ...it.data, id: it.id, updated: it.updated }, { remote: true }); changed = true; }
  }
  if (changed) acct.listeners.forEach(f => { try { f(acct, 'data'); } catch { } });
}

onLocalChange(() => { if (acct.user) scheduleSync(); });
addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && acct.user) scheduleSync(800); });
setInterval(() => { if (acct.user && document.visibilityState === 'visible') syncNow().catch(() => { }); }, 90_000);
