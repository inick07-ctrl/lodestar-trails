// Tiny IndexedDB wrapper. Everything stays on this device.
const NAME = 'lodestar', VER = 1;
const STORES = ['areas', 'areaData', 'tracks', 'waypoints', 'routes', 'favorites', 'notes', 'photos', 'kv'];
let dbp;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => { const db = r.result; for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' ? 'k' : 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store); let out;
    const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
export const db = {
  get: (s, id) => tx(s, 'readonly', st => st.get(id)),
  all: (s) => tx(s, 'readonly', st => st.getAll()),
  put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
  del: (s, id) => tx(s, 'readwrite', st => st.delete(id)),
  clear: (s) => tx(s, 'readwrite', st => st.clear()),
  async kvGet(k, d = null) { const r = await this.get('kv', k); return r ? r.v : d; },
  kvSet(k, v) { return this.put('kv', { k, v }); },
};
export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
