// Tiny IndexedDB wrapper. Local cache for the signed-in user; synced stores are queued for the server.
const NAME = 'lodestar', VER = 3;
const STORES = ['areas', 'areaData', 'tracks', 'waypoints', 'routes', 'favorites', 'notes', 'photos', 'kv', 'outbox', 'profile', 'ctrails'];
export const SYNC_STORES = new Set(['favorites', 'tracks', 'waypoints', 'routes', 'notes', 'profile']);
let dbp;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => { const db = r.result; for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' ? 'k' : 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode); let out;
    const r = fn(t); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const listeners = new Set();
export const onLocalChange = fn => listeners.add(fn);
const notify = () => listeners.forEach(f => { try { f(); } catch { } });

export const db = {
  get: (s, id) => tx(s, 'readonly', t => t.objectStore(s).get(id)),
  all: (s) => tx(s, 'readonly', t => t.objectStore(s).getAll()),
  // put/del on synced stores also queue an outbox entry, unless the change came from the server.
  async put(s, v, { remote = false } = {}) {
    if (SYNC_STORES.has(s) && !remote) {
      v.updated = Date.now();
      await tx([s, 'outbox'], 'readwrite', t => { t.objectStore('outbox').put({ id: `${s}|${v.id}`, store: s, itemId: v.id, updated: v.updated, deleted: false }); return t.objectStore(s).put(v); });
      notify(); return;
    }
    return tx(s, 'readwrite', t => t.objectStore(s).put(v));
  },
  async del(s, id, { remote = false } = {}) {
    if (SYNC_STORES.has(s) && !remote) {
      await tx([s, 'outbox'], 'readwrite', t => { t.objectStore('outbox').put({ id: `${s}|${id}`, store: s, itemId: id, updated: Date.now(), deleted: true }); return t.objectStore(s).delete(id); });
      notify(); return;
    }
    return tx(s, 'readwrite', t => t.objectStore(s).delete(id));
  },
  clear: (s) => tx(s, 'readwrite', t => t.objectStore(s).clear()),
  async clearAll() { for (const s of STORES) await this.clear(s); },
  async kvGet(k, d = null) { const r = await this.get('kv', k); return r ? r.v : d; },
  kvSet(k, v) { return this.put('kv', { k, v }); },
};
export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
