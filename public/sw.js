// Lodestar service worker: offline app shell + offline map tiles. Never caches /api (account data). No analytics, no tracking.
const VERSION = 'ls-shell-v5';
const TILE_CACHE = 'ls-tiles-v1';
const RUNTIME = 'ls-runtime-v1';
const RUNTIME_MAX = 3000;
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/geo.js', 'js/db.js', 'js/trails.js', 'js/style.js', 'js/offline.js', 'js/ui.js', 'js/account.js',
  'vendor/maplibre-gl-csp.js', 'vendor/maplibre-gl-csp-worker.js', 'vendor/maplibre-gl.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png', 'icons/favicon-32.png', 'icons/favicon-16.png', 'icons/logo.svg'];
const GLYPHS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'].flatMap(f => ['0-255', '256-511', '8192-8447'].map(r => `https://tiles.openfreemap.org/fonts/${encodeURIComponent(f)}/${r}.pbf`));

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    try { const t = await caches.open(TILE_CACHE); for (const g of GLYPHS) if (!(await t.match(g))) { const r = await fetch(g); if (r.ok) await t.put(g, r); } } catch { }
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ls-shell-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

const VEC_RE = /^https:\/\/tiles\.openfreemap\.org\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf/;
async function matchAny(key) {
  const t = await caches.open(TILE_CACHE); let r = await t.match(key, { ignoreVary: true, ignoreSearch: false });
  if (r) return r;
  const rt = await caches.open(RUNTIME); return rt.match(key, { ignoreVary: true });
}
let putCount = 0;
async function runtimePut(key, res) {
  try {
    const rt = await caches.open(RUNTIME); await rt.put(key, res);
    if (++putCount % 100 === 0) { const ks = await rt.keys(); for (let i = 0; i < ks.length - RUNTIME_MAX; i++) await rt.delete(ks[i]); }
  } catch { }
}
async function tileFirst(req, key, store = true) {
  const hit = await matchAny(key);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok && store) runtimePut(key, r.clone());
    return r;
  } catch (e) {
    return new Response(null, { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = req.url;
  const m = u.match(VEC_RE);
  if (m) return e.respondWith(tileFirst(req, `https://tiles.openfreemap.org/planet/_/${m[1]}/${m[2]}/${m[3]}.pbf`));
  if (u === 'https://tiles.openfreemap.org/planet') {
    return e.respondWith((async () => {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(req, { signal: ctrl.signal }); clearTimeout(to);
        if (r.ok) { const t = await caches.open(TILE_CACHE); await t.put(u, r.clone()); }
        return r;
      } catch { return (await matchAny(u)) || new Response('{}', { status: 504 }); }
    })());
  }
  if (u.startsWith('https://tiles.openfreemap.org/fonts/') || u.startsWith('https://basemap.nationalmap.gov/') || u.startsWith('https://s3.amazonaws.com/elevation-tiles-prod/'))
    return e.respondWith(tileFirst(req, u));
  if (u.startsWith('https://tile.opentopomap.org/')) return; // online only, per provider policy
  const url = new URL(u);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return; // account/sync API: always network, never cached
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const hit = await c.match(key, { ignoreSearch: req.mode === 'navigate' });
      const net = fetch(req).then(r => { if (r.ok && req.mode !== 'navigate') c.put(req, r.clone()); else if (r.ok) c.put('index.html', r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response('Offline', { status: 503 });
    })());
  }
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
