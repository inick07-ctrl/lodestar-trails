// Lodestar — off-grid trail maps. Data is cached on-device and synced privately to the signed-in account.
import * as G from './geo.js';
import { db, uid } from './db.js';
import { acct, restoreSession, verifySession, signIn, signUp, signOut, changePassword, updateName, deleteAccount, recoverPassword, generateRecovery, syncNow, pendingCount } from './account.js';
import { buildStyle, RASTERS } from './style.js';
import { fetchOverpass, difficultyFor, DIFF_LABEL, poisNear, nearestParking } from './trails.js';
import { planDownload, downloadArea, deleteArea, refreshAreaData, MAX_TILES, MAX_AREA_KM2, TILE_CACHE } from './offline.js';
import { $, $$, esc, ICON, toast, modal, confirmBox, promptBox, initSheet, emojiImage } from './ui.js';

const HOME = [-94.7114, 45.3805]; // Paynesville, MN
const S = { // persisted settings
  mode: 'hike', base: 'trail', theme: 'auto', imperial: true, voice: true, wake: true, offRoute: 45, showPois: true, showAreas: true,
};
const st = { // runtime state
  data: { ways: new Map(), trails: new Map(), pois: new Map() }, live: null, areas: [],
  filters: { activity: 'all', diff: -1, len: 'any', dog: false, kid: false, stroller: false, wheelchair: false, fourwd: false },
  query: '', places: [], view: null, viewStack: [], selected: null, pos: null, heading: null, locate: 0, rec: null, nav: null, plan: null,
  favorites: new Map(), wakeLock: null, installEvt: null, loading: false, vehicle: null,
};
let map, sheet;

// ---------------- boot ----------------
async function boot() {
  Object.assign(S, await db.kvGet('settings', {}));
  if (S.mode !== 'hike' && S.mode !== 'drive') S.mode = S.mode === 'gx' ? 'drive' : 'hike'; // migrate old "gx" mode
  G.units.imperial = S.imperial;
  applyTheme();
  registerSW();
  // Accounts are required: nothing loads until someone is signed in on this device.
  const user = await restoreSession();
  if (!user) await authGate();
  else { document.body.classList.remove('locked'); verifySession().then(r => { if (r === 'expired') reauth(user.id); else if (r === 'ok') syncNow(); }); }
  acct.listeners.add((a, kind) => { if (kind === 'data') reloadUserData(); updateSyncUI(); if (a.expired && !$('#auth')) { a.expired = false; reauth(a.user?.id); } });
  document.body.dataset.mode = S.mode;
  st.filters.activity = S.mode === 'drive' ? 'offroad' : 'all';
  sheet = initSheet(onDetent);
  const last = await db.kvGet('lastView', null);
  maplibregl.setWorkerUrl('vendor/maplibre-gl-csp-worker.js');
  map = new maplibregl.Map({
    container: 'map', style: buildStyle({ dark: isDark(), base: S.base }), center: last?.center || HOME, zoom: last?.zoom ?? 12,
    attributionControl: { compact: true }, maxPitch: 60, preserveDrawingBuffer: true, dragRotate: true, fadeDuration: 150,
  });
  map.addControl(new maplibregl.ScaleControl({ unit: S.imperial ? 'imperial' : 'metric', maxWidth: 90 }), 'bottom-left');
  map.touchZoomRotate.enableRotation();
  map.on('style.load', addOverlays);
  map.once('load', () => setTimeout(() => $('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'), 1500));
  map.on('rotate', () => { $('#btnCompass').hidden = Math.abs(map.getBearing()) < 1; $('#compassIco').style.transform = `rotate(${-map.getBearing()}deg)`; });
  map.on('moveend', () => { db.kvSet('lastView', { center: map.getCenter().toArray(), zoom: map.getZoom() }); if (st.view?.name === 'explore') renderList(); if (st.view?.name === 'newArea') updateAreaFrame(); });
  map.on('dragstart', () => { if (st.locate) setLocate(0, true); });
  map.on('click', onMapClick);
  wireChrome();
  await loadAll();
  show('explore');
  online();
  addEventListener('online', online); addEventListener('offline', online);
  if (!user) syncNow();
  resumeRecording();
  maybeInstallHint();
  // first run with nothing cached: load trails around the current view
  map.once('idle', () => { if (!st.data.trails.size && navigator.onLine && map.getZoom() >= 10) loadVisibleTrails(true); });
}
const isDark = () => S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme() { if (S.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = S.theme; }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.theme === 'auto') restyle(); });
function saveSettings() { return db.kvSet('settings', { ...S }); }
function restyle() { applyTheme(); map.setStyle(buildStyle({ dark: isDark(), base: S.base }), { diff: false }); }
function setBase(b) {
  S.base = b; saveSettings();
  const vec = b === 'trail';
  for (const l of map.getStyle().layers) {
    if (l.metadata?.vec) map.setLayoutProperty(l.id, 'visibility', vec ? 'visible' : 'none');
    if (l.id.startsWith('base-')) map.setLayoutProperty(l.id, 'visibility', l.id === 'base-' + b ? 'visible' : 'none');
  }
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(r => { st.swReg = r; }).catch(e => console.warn('SW', e));
}
function online() {
  const p = $('#statusPill');
  if (!navigator.onLine) { p.hidden = false; p.textContent = '● Offline — using saved maps'; }
  else p.hidden = true;
}
function maybeInstallHint() {
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); st.installEvt = e; });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  db.kvGet('installHintShown', false).then(shown => { if (!standalone && ios && !shown) setTimeout(() => { db.kvSet('installHintShown', true); if ($('#modalWrap')?.hidden !== false && !$('#auth')) installHelp(); }, 2500); });
}
function installHelp() {
  modal(`<h2>Add Lodestar to your Home Screen</h2>
  <p class="sub">Installed, Lodestar opens full-screen and keeps working with no signal.</p>
  <ol style="padding-left:20px;line-height:1.7">
   <li>In Safari, tap the <b>Share</b> button <span style="font-size:18px">⬆︎</span> (bottom bar on iPhone).</li>
   <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
   <li>Tap <b>Add</b>, then open Lodestar from your Home Screen.</li>
   <li>Before heading out, use the <b>Offline</b> tab to save the area you'll be in.</li>
  </ol>
  ${st.installEvt ? '<button class="btn primary block" id="doInstall">Install now</button>' : ''}
  <button class="btn block" style="margin-top:8px" data-x>Got it</button>`, (m, close) => {
    m.querySelector('[data-x]').onclick = close;
    const b = m.querySelector('#doInstall'); if (b) b.onclick = async () => { st.installEvt.prompt(); await st.installEvt.userChoice; st.installEvt = null; close(); };
  });
}

// ---------------- data ----------------
async function loadAll() {
  st.areas = await db.all('areas');
  st.favorites = new Map((await db.all('favorites')).map(f => [f.id, f]));
  const datas = await db.all('areaData');
  st.live = await db.kvGet('liveData', null);
  rebuildData(datas);
  st.waypoints = await db.all('waypoints');
  st.vehicle = (await db.get('profile', 'vehicle')) || null;
  refreshOverlays(); updateVehiclePill();
}
// Re-read synced data after a pull from the server and refresh whatever is on screen.
async function reloadUserData() {
  st.favorites = new Map((await db.all('favorites')).map(f => [f.id, f]));
  st.waypoints = await db.all('waypoints');
  st.vehicle = (await db.get('profile', 'vehicle')) || null;
  if (map?.getSource('wpts')) refreshOverlays();
  updateVehiclePill();
  const v = st.view?.name;
  if (v && ['explore', 'saved', 'more'].includes(v) && !document.activeElement?.matches?.('input,textarea,select')) VIEWS[v](st.view.args);
}
function rebuildData(datas) {
  const d = { ways: new Map(), trails: new Map(), pois: new Map() };
  for (const src of [...(datas || st._datas || []), st.live].filter(Boolean)) {
    for (const w of src.ways) d.ways.set(w.id, w);
    for (const t of src.trails) if (!d.trails.has(t.id) || d.trails.get(t.id).len < t.len) d.trails.set(t.id, t);
    for (const p of src.pois) d.pois.set(p.id, p);
  }
  if (datas) st._datas = datas;
  st.data = d;
}
async function loadVisibleTrails(quiet = false) {
  if (!navigator.onLine) { toast('You\'re offline. Showing trails from saved areas.'); return; }
  const b = map.getBounds(); let bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const km2 = G.bboxArea(bbox) / 1e6;
  if (km2 > 900) { // clamp to a ~30 km box around center to be kind to Overpass
    const c = map.getCenter(), dLat = 0.135, dLon = 0.135 / Math.cos(c.lat * Math.PI / 180);
    bbox = [c.lng - dLon, c.lat - dLat, c.lng + dLon, c.lat + dLat];
    if (!quiet) toast('Big area — loading trails near the center of the map.');
  }
  st.loading = true; if (st.view?.name === 'explore') renderExplore();
  try {
    const data = await fetchOverpass(bbox);
    st.live = data; await db.kvSet('liveData', data);
    rebuildData(); refreshOverlays();
    if (!quiet) toast(`${data.trails.length} trails found`);
  } catch (e) { toast('Couldn\'t load trails right now. Try again in a moment.'); console.warn(e); }
  st.loading = false; if (st.view?.name === 'explore') renderExplore();
}
const trailById = id => st.data.trails.get(id) || st.favorites.get(id)?.trail;
function trailSegs(t) {
  const fav = st.favorites.get(t.id);
  const segs = t.wayIds.map(id => st.data.ways.get(id)?.coords).filter(Boolean);
  return segs.length ? segs : (fav?.segs || [t.chain]);
}

// ---------------- map overlays ----------------
const COLORS = () => ({ easy: '#2e9b57', mod: isDark() ? '#5b9cf0' : '#2f6fd6', hard: isDark() ? '#f2f2f2' : '#1d1d1f', oeasy: '#2e9b57', omod: '#e8a317', ohard: '#d64545', faint: isDark() ? 'rgba(200,180,150,.35)' : 'rgba(120,100,70,.35)' });
const POI_EMOJI = { waterfall: '💦', viewpoint: '👀', camp: '⛺', picnic: '🧺', shelter: '🛖', historic: '🏛️', water: '💧', toilets: '🚻', peak: '⛰️', cave: '🕳️', trailhead: '🚩', firepit: '🔥', parking: '🅿️', poi: '📍' };
const POI_LABEL = { waterfall: 'Waterfall', viewpoint: 'Viewpoint', camp: 'Campsite', picnic: 'Picnic area', shelter: 'Shelter', historic: 'Historic site', water: 'Water', toilets: 'Restroom', peak: 'Peak', cave: 'Cave', trailhead: 'Trailhead', firepit: 'Fire pit', parking: 'Parking', poi: 'Point of interest' };
const WPT_ICONS = { camp: '⛺', water: '💧', vehicle: '🚙', hazard: '⚠️', pin: '📍', view: '👀', fish: '🎣', wildlife: '🦌', fuel: '⛽', gate: '🚧' };
const WPT_LABEL = { camp: 'Camp', water: 'Water', vehicle: 'Vehicle', hazard: 'Hazard', pin: 'Pin', view: 'View', fish: 'Fishing', wildlife: 'Wildlife', fuel: 'Fuel', gate: 'Gate' };
const empty = () => ({ type: 'FeatureCollection', features: [] });

function addOverlays() {
  const c = COLORS();
  for (const [k, e] of Object.entries(POI_EMOJI)) if (!map.hasImage('poi-' + k)) map.addImage('poi-' + k, emojiImage(e, isDark() ? '#2a2c2b' : '#fff', '#8a7a62'), { pixelRatio: 2 });
  for (const [k, e] of Object.entries(WPT_ICONS)) if (!map.hasImage('wpt-' + k)) map.addImage('wpt-' + k, emojiImage(e, isDark() ? '#2a2c2b' : '#fff', '#d9822b'), { pixelRatio: 2 });
  for (const s of ['areas', 'ways', 'hl', 'route', 'track', 'pois', 'wpts', 'plan', 'navdone']) if (!map.getSource(s)) map.addSource(s, { type: 'geojson', data: empty() });
  map.addLayer({ id: 'areas-line', type: 'line', source: 'areas', paint: { 'line-color': '#8a7a62', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.8 } });
  const isDrive = S.mode === 'drive';
  map.addLayer({ id: 'ways-faint', type: 'line', source: 'ways', minzoom: 10, filter: isDrive ? ['!', ['get', 'o']] : ['!', ['get', 'h']], paint: { 'line-color': c.faint, 'line-width': 1.5 } });
  map.addLayer({ id: 'ways-case', type: 'line', source: 'ways', minzoom: 9, filter: isDrive ? ['get', 'o'] : ['get', 'h'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': isDark() ? 'rgba(0,0,0,.6)' : 'rgba(255,255,255,.85)', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 7] } });
  const wcol = isDrive ? ['match', ['get', 'do'], 0, c.oeasy, 1, c.omod, c.ohard] : ['match', ['get', 'dh'], 0, c.easy, 1, c.mod, c.hard], ww = ['interpolate', ['linear'], ['zoom'], 10, 1.6, 16, 4];
  map.addLayer({ id: 'ways-line', type: 'line', source: 'ways', minzoom: 9, filter: ['all', isDrive ? ['get', 'o'] : ['get', 'h'], ['get', 'paved']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': wcol, 'line-width': ww } });
  map.addLayer({ id: 'ways-dash', type: 'line', source: 'ways', minzoom: 9, filter: ['all', isDrive ? ['get', 'o'] : ['get', 'h'], ['!', ['get', 'paved']]], layout: { 'line-join': 'round' }, paint: { 'line-color': wcol, 'line-width': ww, 'line-dasharray': [2.2, 1.1] } });
  map.addLayer({ id: 'hl-glow', type: 'line', source: 'hl', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': isDrive ? '#f0a050' : '#4fb477', 'line-width': 12, 'line-opacity': 0.35 } });
  map.addLayer({ id: 'hl-line', type: 'line', source: 'hl', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': isDrive ? '#d9822b' : '#2f7d4f', 'line-width': 5 } });
  map.addLayer({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7c4dff', 'line-width': 5 } });
  map.addLayer({ id: 'navdone-line', type: 'line', source: 'navdone', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#9e9e9e', 'line-width': 5 } });
  map.addLayer({ id: 'track-line', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e5484d', 'line-width': 4.5 } });
  map.addLayer({ id: 'plan-pts', type: 'circle', source: 'plan', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#7c4dff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'pois-sym', type: 'symbol', source: 'pois', minzoom: 12, layout: { 'icon-image': ['concat', 'poi-', ['get', 'kind']], 'icon-size': 0.9, 'icon-allow-overlap': false, 'text-field': ['step', ['zoom'], '', 15, ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': isDark() ? '#ddd' : '#333', 'text-halo-color': isDark() ? '#000' : '#fff', 'text-halo-width': 1.2 } });
  map.addLayer({ id: 'wpts-sym', type: 'symbol', source: 'wpts', layout: { 'icon-image': ['concat', 'wpt-', ['get', 'icon']], 'icon-size': 1, 'icon-allow-overlap': true, 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.7], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': isDark() ? '#fff' : '#222', 'text-halo-color': isDark() ? '#000' : '#fff', 'text-halo-width': 1.4 } });
  refreshOverlays();
  setBase(S.base);
  if (st.selected) highlight(st.selected);
  if (st.nav) drawRoute(st.nav.route.coords);
  if (st.rec) drawTrack();
  if (st.plan) drawPlan();
}
function setSrc(id, data) { const s = map?.getSource(id); if (s) s.setData(data); }
function refreshOverlays() {
  if (!map?.getSource('ways')) return;
  const feats = [];
  for (const w of st.data.ways.values()) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: w.coords }, properties: { id: w.id, h: !!(w.cls.hike || w.cls.walk || w.cls.bike), o: !!w.cls.offroad, dh: w.dh, do: w.do, paved: !!w.paved, name: w.tags.name || '' } });
  setSrc('ways', { type: 'FeatureCollection', features: feats });
  setSrc('pois', { type: 'FeatureCollection', features: S.showPois ? [...st.data.pois.values()].map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { id: p.id, kind: p.kind, name: p.name } })) : [] });
  setSrc('wpts', { type: 'FeatureCollection', features: (st.waypoints || []).map(w => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [w.lon, w.lat] }, properties: { id: w.id, icon: WPT_ICONS[w.icon] ? w.icon : 'pin', name: w.name } })) });
  setSrc('areas', { type: 'FeatureCollection', features: S.showAreas ? st.areas.map(a => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[1]], [a.bbox[2], a.bbox[3]], [a.bbox[0], a.bbox[3]], [a.bbox[0], a.bbox[1]]]] }, properties: { name: a.name } })) : [] });
}
function setMode(m) {
  S.mode = m; saveSettings(); document.body.dataset.mode = m;
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  st.filters.activity = m === 'drive' ? 'offroad' : 'all'; st.filters.diff = -1;
  if (map.getLayer('ways-line')) { // restyle trail overlay
    for (const id of ['ways-faint', 'ways-case', 'ways-line', 'ways-dash', 'hl-glow', 'hl-line']) map.removeLayer(id);
    for (const id of ['route-case', 'route-line', 'navdone-line', 'track-line', 'plan-pts', 'pois-sym', 'wpts-sym', 'areas-line']) map.removeLayer(id);
    addOverlays();
  }
  if (st.view?.name === 'explore') renderExplore();
  updateVehiclePill();
  toast(m === 'drive' ? 'Drive: tracks, dirt & unpaved roads highlighted' : 'Hike: footpaths & trails highlighted', 1800);
}
function highlight(t) {
  st.selected = t;
  setSrc('hl', t ? { type: 'FeatureCollection', features: trailSegs(t).map(c => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {} })) } : empty());
}
function fitTo(bbox, extraBottom = 0) {
  const H = innerHeight, sheetH = sheet.get() === 'full' ? H * 0.5 : sheet.get() === 'half' ? H * 0.52 : 230;
  const wide = innerWidth >= 760;
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: { top: 130, bottom: wide ? 60 : Math.min(H - 220, sheetH + 20 + extraBottom), left: wide ? 440 : 40, right: 70 }, maxZoom: 16, duration: 700 });
}
function onDetent(d) {
  const off = d === 'peek' ? 176 : d === 'half' ? innerHeight * 0.52 - 56 : 176;
  $$('.maplibregl-ctrl-bottom-right, .maplibregl-ctrl-bottom-left').forEach(e => e.style.bottom = `calc(var(--tab-h) + ${Math.round(off)}px)`);
  $('#fabs').style.visibility = d === 'full' && innerWidth < 760 ? 'hidden' : '';
}
function onMapClick(e) {
  if (st.plan) return planClick(e);
  if (st.view?.name === 'newArea') return;
  const pad = 10, box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const w = map.queryRenderedFeatures(box, { layers: ['wpts-sym'] })[0];
  if (w) return show('waypoint', { id: w.properties.id });
  const p = map.queryRenderedFeatures(box, { layers: ['pois-sym'] })[0];
  if (p) return showPoi(st.data.pois.get(p.properties.id));
  const f = map.queryRenderedFeatures(box, { layers: ['ways-line', 'ways-dash', 'ways-faint'] })[0];
  if (f) {
    const wid = f.properties.id; const t = [...st.data.trails.values()].find(t => t.wayIds.includes(wid));
    if (t) return show('trail', { id: t.id });
    const w = st.data.ways.get(wid);
    if (w) return showWay(w);
  }
}
function showPoi(p) {
  if (!p) return;
  new maplibregl.Popup({ closeButton: false, offset: 18 }).setLngLat([p.lon, p.lat]).setHTML(`<b>${POI_EMOJI[p.kind]} ${esc(p.name || POI_LABEL[p.kind])}</b><div class="sub">${esc(POI_LABEL[p.kind])}${p.ele ? ' · ' + G.fmtElev(p.ele) : ''}${st.pos ? ' · ' + G.fmtDist(G.hav(st.pos, [p.lon, p.lat]), true) + ' away' : ''}</div>${p.desc ? `<div class="sub">${esc(p.desc)}</div>` : ''}<div style="margin-top:6px"><a href="#" data-goto>Navigate here</a></div>`).addTo(map)
    .getElement().querySelector('[data-goto]').onclick = (e) => { e.preventDefault(); gotoPoint([p.lon, p.lat], p.name || POI_LABEL[p.kind]); };
}
function showWay(w) {
  const t = w.tags, c = G.pointAlong(w.coords, w.len / 2);
  const kind = t.highway === 'track' ? 'Track' + (t.tracktype ? ` (${t.tracktype.replace('grade', 'grade ')})` : '') : t.highway[0].toUpperCase() + t.highway.slice(1);
  new maplibregl.Popup({ closeButton: false }).setLngLat(c).setHTML(`<b>${esc(t.name || 'Unnamed ' + kind.toLowerCase())}</b><div class="sub">${esc(kind)} · ${G.fmtDist(w.len, true)}${t.surface ? ' · ' + esc(t.surface.replace(/_/g, ' ')) : ''}</div><div class="sub">${S.mode === 'drive' ? '<span class="diff d' + w.do + '">' + DIFF_LABEL[w.do] + '</span>' + (t['4wd_only'] === 'yes' ? ' · 4WD only' : '') : '<span class="diff d' + w.dh + '">' + DIFF_LABEL[w.dh] + '</span>'}</div>`).addTo(map);
}

// ---------------- chrome ----------------
function wireChrome() {
  $$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#vehiclePill').onclick = () => editVehicle();
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  $$('#tabbar button').forEach(b => b.onclick = () => { if (st.plan && b.dataset.tab !== 'saved') endPlan(); st.viewStack = []; show(b.dataset.tab, {}, false); if (sheet.get() === 'peek' && b.dataset.tab !== 'explore') sheet.set('half'); });
  $('#searchForm').onsubmit = e => { e.preventDefault(); $('#q').blur(); doSearch($('#q').value.trim()); };
  $('#q').addEventListener('input', () => { if (!$('#q').value) { st.query = ''; st.places = []; if (st.view?.name === 'explore') renderExplore(); } });
  $('#q').addEventListener('focus', () => { if (st.view?.name !== 'explore') show('explore', {}, false); });
  $('#btnLayers').onclick = layersSheet;
  $('#btnLocate').onclick = () => setLocate(st.locate === 0 ? 1 : st.locate === 1 ? 2 : 0);
  $('#btnCompass').onclick = () => { if (st.locate === 2) setLocate(1); map.easeTo({ bearing: 0, pitch: 0 }); };
  $('#btnWaypoint').onclick = () => editWaypoint(null, st.pos && st.locate ? st.pos : map.getCenter().toArray());
  $('#fileGpx').onchange = importGPXFile;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (st.rec || st.nav)) keepAwake(true); });
}
function setTab(name) { $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === name)); }
const TAB_OF = { explore: 'explore', trail: 'explore', record: 'record', activity: 'saved', saved: 'saved', route: 'saved', waypoint: 'saved', plan: 'saved', offline: 'offline', newArea: 'offline', more: 'more', nav: 'record' };
function show(name, args = {}, push = true) {
  if (push && st.view) st.viewStack.push(st.view);
  if (st.view?.name === 'newArea' && name !== 'newArea') endAreaSelect();
  if (st.view?.name === 'trail' && name !== 'trail' && name !== 'nav') highlight(null);
  st.view = { name, args }; setTab(TAB_OF[name] || 'explore');
  const fn = VIEWS[name]; sheet.body.scrollTop = 0; fn(args);
}
function back() { const v = st.viewStack.pop(); if (v) { if (st.view?.name === 'newArea') endAreaSelect(); if (st.view?.name === 'trail') highlight(null); st.view = v; setTab(TAB_OF[v.name]); VIEWS[v.name](v.args); } else show('explore', {}, false); }
const hdr = (title, opts = {}) => `<div class="hdr">${st.viewStack.length || opts.back ? `<button class="back" data-back aria-label="Back">${ICON.back}</button>` : ''}<h2>${esc(title)}</h2>${opts.right || ''}</div>`;
function paint(html) { sheet.body.innerHTML = html; const b = sheet.body.querySelector('[data-back]'); if (b) b.onclick = back; }

// ---------------- explore ----------------
function filteredTrails() {
  const f = st.filters, c = st.pos && st.locate ? st.pos : map.getCenter().toArray(), q = st.query.toLowerCase();
  const bounds = map.getBounds(); const vb = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  let list = [...st.data.trails.values()].filter(t => {
    if (q) { if (!t.name.toLowerCase().includes(q)) return false; }
    else if (!G.bboxIntersects(t.bbox, vb)) return false;
    if (S.mode === 'drive' ? !t.activities.offroad : !(t.activities.hike || t.activities.walk || t.activities.bike || t.activities.run)) return false;
    if (f.activity !== 'all' && !t.activities[f.activity]) return false;
    const d = difficultyFor(t, S.mode, f.activity === 'all' ? null : f.activity);
    if (f.diff >= 0 && d !== f.diff) return false;
    const mi = t.len / 1609.344;
    if (f.len === 's' && mi > 2) return false; if (f.len === 'm' && (mi < 2 || mi > 5)) return false; if (f.len === 'l' && (mi < 5 || mi > 10)) return false; if (f.len === 'xl' && mi < 10) return false;
    if (f.dog && t.dog === 'no') return false; if (f.kid && !t.kid) return false; if (f.stroller && !t.stroller) return false;
    if (f.wheelchair && !(t.wheelchair === 'yes' || t.wheelchair === 'likely')) return false;
    if (f.fourwd && !t.fourwd && t.diffOff < 2) return false;
    if (f.fits && st.vehicle && !fitsVehicle(t)) return false;
    return true;
  });
  for (const t of list) { t._d = G.hav(c, t.start || t.center); }
  list.sort((a, b) => (a.name.startsWith('Unnamed') - b.name.startsWith('Unnamed')) || a._d - b._d);
  return list;
}
const chip = (label, on, attrs) => `<button class="chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;
function renderExplore() {
  const f = st.filters, drv = S.mode === 'drive';
  const acts = drv ? [] : [['all', 'All'], ['hike', '🥾 Hike'], ['walk', '🚶 Walk'], ['run', '🏃 Run'], ['bike', '🚲 Bike']];
  paint(`
    <div class="peek-row" style="margin-bottom:8px"><div><div style="font-weight:700;font-size:20px;letter-spacing:-.02em" id="exTitle">${drv ? 'Drive routes' : 'Trails'} nearby</div>${drv ? `<div class="sub drive-sub">${st.vehicle ? '🚙 Driving: ' + esc(vehicleName(st.vehicle)) : '<a href="#" id="exAddVeh">Add your vehicle</a> to flag routes that need 4WD'}</div>` : ''}<div class="sub" id="exSub"></div></div>
      <button class="btn" id="btnArea" style="height:36px;font-size:14px;padding:0 12px">${st.loading ? 'Loading…' : '↻ Search area'}</button></div>
    <div class="chips">${drv ? (st.vehicle ? chip('✓ Fits my vehicle', f.fits, 'data-flag="fits"') : '') + chip('⛰️ 4WD / hard', f.fourwd, 'data-flag="fourwd"') : ''}${acts.map(([k, l]) => chip(l, f.activity === k, `data-act="${k}"`)).join('')}
      ${[[-1, 'Any difficulty'], [0, 'Easy'], [1, 'Moderate'], [2, 'Hard']].map(([k, l]) => chip(l, f.diff === k, `data-diff="${k}"`)).join('')}</div>
    <div class="chips">${[['any', 'Any length'], ['s', '< 2 mi'], ['m', '2–5 mi'], ['l', '5–10 mi'], ['xl', '10+ mi']].map(([k, l]) => chip(G.units.imperial ? l : l.replace('2 mi', '3 km').replace('2–5 mi', '3–8 km').replace('5–10 mi', '8–16 km').replace('10+ mi', '16+ km'), f.len === k, `data-len="${k}"`)).join('')}
      ${drv ? '' : [['dog', '🐕 Dogs OK'], ['kid', '🧒 Kid-friendly'], ['stroller', '👶 Stroller'], ['wheelchair', '♿️ Wheelchair']].map(([k, l]) => chip(l, f[k], `data-flag="${k}"`)).join('')}</div>
    <div class="legend">${drv ? '<span><i style="background:#2e9b57"></i>Easy</span><span><i style="background:#e8a317"></i>Moderate</span><span><i style="background:#d64545"></i>Hard / 4WD</span>' : `<span><i style="background:#2e9b57"></i>Easy</span><span><i style="background:${COLORS().mod}"></i>Moderate</span><span><i style="background:${COLORS().hard}"></i>Hard</span>`}<span>dashed = unpaved</span></div>
    <div id="places"></div>
    <div class="list" id="trailList"></div>
    <p class="muted" style="margin-top:18px">Trail data © OpenStreetMap contributors. Conditions change — check local rules, closures, and land ownership before you go. Offroad: stay on legal routes.</p>`);
  $('#btnArea').onclick = () => loadVisibleTrails();
  const av = $('#exAddVeh'); if (av) av.onclick = e => { e.preventDefault(); editVehicle(); };
  $$('[data-act]').forEach(b => b.onclick = () => { f.activity = b.dataset.act; renderExplore(); });
  $$('[data-diff]').forEach(b => b.onclick = () => { f.diff = +b.dataset.diff; renderExplore(); });
  $$('[data-len]').forEach(b => b.onclick = () => { f.len = b.dataset.len; renderExplore(); });
  $$('[data-flag]').forEach(b => b.onclick = () => { f[b.dataset.flag] = !f[b.dataset.flag]; renderExplore(); });
  renderPlaces(); renderList();
}
function renderPlaces() {
  const el = $('#places'); if (!el) return;
  if (!st.places.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<h3>Places</h3><div class="list">${st.places.map((p, i) => `<button class="card" data-place="${i}"><div class="thumb place-ico">${p.icon || '📍'}</div><div class="body"><div class="title">${esc(p.name)}</div><div class="meta">${esc(p.sub || '')}</div></div>${ICON.chev}</button>`).join('')}</div><h3>Trails</h3>`;
  $$('[data-place]', el).forEach(b => b.onclick = () => gotoPlace(st.places[+b.dataset.place]));
}
function trailCard(t) {
  const d = difficultyFor(t, S.mode, st.filters.activity === 'all' ? null : st.filters.activity);
  const fav = st.favorites.has(t.id);
  const act = t.activities.offroad && S.mode === 'drive' ? '🚙' : t.activities.hike ? '🥾' : t.activities.bike ? '🚲' : '🚶';
  return `<button class="card" data-trail="${esc(t.id)}"><div class="thumb">${act}</div><div class="body"><div class="title">${fav ? '♥︎ ' : ''}${esc(t.name)}</div>
   <div class="meta"><span class="diff d${d}">${DIFF_LABEL[d]}</span><i class="dot"></i><span>${G.fmtDist(t.len)}</span>${S.mode === 'drive' && t.fourwd ? '<i class="dot"></i><span class="tag4">4WD</span>' : ''}${S.mode === 'drive' && st.vehicle && !fitsVehicle(t) ? '<i class="dot"></i><span class="tagwarn">⚠︎ Check vehicle</span>' : ''}${t._d != null ? `<i class="dot"></i><span>${G.fmtDist(t._d)} away</span>` : ''}</div></div>${ICON.chev}</button>`;
}
function renderList() {
  const el = $('#trailList'); if (!el) return;
  const list = filteredTrails();
  const sub = $('#exSub');
  if (sub) sub.textContent = st.query ? `${list.length} matching “${st.query}”` : `${list.length} in view${navigator.onLine ? '' : ' · offline'}`;
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="big">${S.mode === 'drive' ? '🚙' : '🥾'}</div>${st.data.trails.size ? 'No trails match here. Try zooming out, moving the map, or clearing filters.' : navigator.onLine ? 'Tap <b>Search area</b> to load trails for the map view.' : 'No saved trail data here yet. Save areas from the <b>Offline</b> tab while you have signal.'}</div>`;
    return;
  }
  el.innerHTML = list.slice(0, 60).map(trailCard).join('') + (list.length > 60 ? `<p class="muted">Showing 60 of ${list.length}. Zoom in or filter to narrow down.</p>` : '');
  $$('[data-trail]', el).forEach(b => b.onclick = () => show('trail', { id: b.dataset.trail }));
}
async function doSearch(q) {
  st.query = ''; st.places = [];
  if (!q) { renderExplore(); return; }
  const ql = q.toLowerCase();
  const local = [...st.data.trails.values()].filter(t => t.name.toLowerCase().includes(ql));
  for (const p of st.data.pois.values()) if (p.name && p.name.toLowerCase().includes(ql)) st.places.push({ name: p.name, sub: POI_LABEL[p.kind] + ' · saved data', icon: POI_EMOJI[p.kind], center: [p.lon, p.lat] });
  for (const w of st.waypoints || []) if (w.name.toLowerCase().includes(ql)) st.places.push({ name: w.name, sub: 'Your waypoint', icon: WPT_ICONS[w.icon] || '📍', center: [w.lon, w.lat] });
  for (const a of st.areas) if (a.name.toLowerCase().includes(ql)) st.places.push({ name: a.name, sub: 'Offline area', icon: '⬇︎', bbox: a.bbox });
  if (local.length) st.query = q;
  show('explore', {}, false);
  if (navigator.onLine) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=us,ca&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' } });
      const js = await r.json();
      for (const p of js) st.places.push({ name: p.name || p.display_name.split(',')[0], sub: p.display_name.split(',').slice(1, 4).join(',').trim(), icon: /park|nature|forest|wood/.test(p.type + p.class) ? '🌲' : p.class === 'highway' ? '🛣️' : p.class === 'place' ? '🏘️' : '📍', center: [+p.lon, +p.lat], bbox: p.boundingbox ? [+p.boundingbox[2], +p.boundingbox[0], +p.boundingbox[3], +p.boundingbox[1]] : null });
    } catch { }
  } else if (!st.places.length && !local.length) toast('Offline: search covers saved trails, places and waypoints.');
  renderPlaces(); renderList();
  if (sheet.get() === 'peek') sheet.set('half');
}
function gotoPlace(p) {
  if (p.bbox && G.bboxArea(p.bbox) > 2e5) fitTo(p.bbox); else map.flyTo({ center: p.center, zoom: 13.5, duration: 900 });
  st.places = []; st.query = ''; $('#q').value = '';
  map.once('moveend', () => { if (navigator.onLine) loadVisibleTrails(true); renderExplore(); });
  sheet.set('peek');
}

// ---------------- trail detail ----------------
const CONDITIONS = ['Dry', 'Muddy', 'Wet', 'Snow', 'Icy', 'Flooded', 'Overgrown', 'Downed trees', 'Rutted', 'Washed out', 'Bugs', 'Closed'];
function renderTrail({ id }) {
  const t = trailById(id); if (!t) return show('explore', {}, false);
  highlight(t);
  const act = st.filters.activity === 'all' ? (S.mode === 'drive' ? 'offroad' : 'hike') : st.filters.activity;
  const d = difficultyFor(t, S.mode, S.mode === 'drive' ? 'offroad' : null), fav = st.favorites.has(t.id);
  const acts = Object.entries(t.activities).filter(([, v]) => v).map(([k]) => ({ hike: '🥾 Hike', walk: '🚶 Walk', run: '🏃 Run', bike: '🚲 Bike', offroad: '🚙 Drive' }[k]));
  const surf = Object.entries(t.surface).sort((a, b) => b[1] - a[1]);
  const SC = { asphalt: '#6b6b70', paved: '#6b6b70', concrete: '#8e8e93', gravel: '#b59a6b', fine_gravel: '#c8b08a', compacted: '#a7926d', dirt: '#8a6a45', ground: '#8a6a45', grass: '#7fb069', sand: '#e0c68a', unknown: '#c7c7cc', wood: '#a0522d' };
  const segs = trailSegs(t);
  const pois = poisNear([...st.data.pois.values()], segs);
  const dogTxt = { yes: '🐕 Dogs allowed', leashed: '🐕 Dogs on leash', no: '🚫 No dogs', unknown: '' }[t.dog];
  paint(`${hdr(t.name, { back: true })}
    <div class="sub"><span class="diff d${d}">${DIFF_LABEL[d]}</span> · ${G.fmtDist(t.len)} · Est. ${fmtHM(G.estTime(t.len, 0, act))}${t._d != null ? ' · ' + G.fmtDist(t._d) + ' away' : ''}</div>
    <div class="actions">
      <button class="act primary" id="tNav"><i>${ICON.nav}</i>Start</button>
      <button class="act" id="tDir"><i>${ICON.car}</i>Directions</button>
      <button class="act${fav ? ' on' : ''}" id="tFav"><i>${fav ? ICON.heartF : ICON.heart}</i>${fav ? 'Saved' : 'Save'}</button>
      <button class="act" id="tShare"><i>${ICON.share}</i>Share</button>
    </div>
    <div class="stats"><div class="stat"><span>Length</span><b>${G.fmtDist(t.len)}</b></div><div class="stat"><span>Elev. gain</span><b id="tGain">…</b></div><div class="stat"><span>Est. time</span><b id="tTime">${fmtHM(G.estTime(t.len, 0, act))}</b></div></div>
    <canvas class="profile" id="tProf"></canvas><div class="muted" id="tProfNote"></div>
    <div class="badges">${acts.map(a => `<span class="badge good">${a}</span>`).join('')}
      ${dogTxt ? `<span class="badge${t.dog === 'no' ? ' warn' : ''}">${dogTxt}</span>` : ''}${t.kid ? '<span class="badge good">🧒 Kid-friendly</span>' : ''}${t.stroller ? '<span class="badge good">👶 Stroller-friendly</span>' : ''}
      ${t.wheelchair === 'yes' ? '<span class="badge good">♿️ Wheelchair accessible</span>' : t.wheelchair === 'likely' ? '<span class="badge">♿️ Likely accessible (paved)</span>' : ''}
      ${t.lit ? '<span class="badge">💡 Lit</span>' : ''}${t.fourwd ? '<span class="badge warn">⛰️ 4WD only</span>' : ''}${S.mode === 'drive' && st.vehicle ? (fitsVehicle(t) ? `<span class="badge">✓ Suits your ${esc(st.vehicle.nickname || st.vehicle.model || 'vehicle')}</span>` : `<span class="badge warn">⚠︎ ${t.fourwd ? 'Needs 4WD' : 'Rough — high clearance or 4WD advised'}</span>`) : ''}${t.seasonal ? `<span class="badge warn">Seasonal: ${esc(t.seasonal)}</span>` : ''}</div>
    <h3>Surface</h3><div class="surfbar">${surf.map(([k, v]) => `<i style="width:${(v / t.len * 100).toFixed(1)}%;background:${SC[k] || '#aaa'}"></i>`).join('')}</div>
    <div class="legend">${surf.slice(0, 5).map(([k, v]) => `<span><i style="background:${SC[k] || '#aaa'}"></i>${esc(k.replace(/_/g, ' '))} ${Math.round(v / t.len * 100)}%</span>`).join('')}</div>
    ${pois.length ? `<h3>Along the trail</h3><div class="list">${pois.slice(0, 12).map(p => `<button class="card" data-poi="${p.id}"><div class="thumb">${POI_EMOJI[p.kind]}</div><div class="body"><div class="title">${esc(p.name || POI_LABEL[p.kind])}</div><div class="meta">${POI_LABEL[p.kind]}${p.ele ? ' · ' + G.fmtElev(p.ele) : ''}</div></div></button>`).join('')}</div>` : ''}
    <h3>Your notes & conditions <span style="text-transform:none;font-weight:400">(private, on this device)</span></h3>
    <div id="tNotes"></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="tAddNote">${ICON.pencil} Add note</button><button class="btn" id="tAddPhoto">${ICON.camera} Add photo</button></div>
    <h3>More</h3>
    <div class="row"><button class="btn" id="tDl">${ICON.dl} Save offline</button><button class="btn" id="tPlan">${ICON.route} Plan from here</button></div>
    <h3>Details</h3>
    <dl class="kv">${t.operator ? `<dt>Managed by</dt><dd>${esc(t.operator)}</dd>` : ''}${t.access ? `<dt>Access</dt><dd>${esc(t.access)}</dd>` : ''}
      <dt>Difficulty</dt><dd>${S.mode === 'drive' ? 'Offroad: ' + DIFF_LABEL[t.diffOff] : 'Hiking: ' + DIFF_LABEL[t.diffHike]}</dd>
      <dt>Trailhead</dt><dd>${t.start[1].toFixed(5)}, ${t.start[0].toFixed(5)}</dd>
      ${t.website ? `<dt>Website</dt><dd><a href="${esc(t.website)}" target="_blank" rel="noopener">Open</a></dd>` : ''}</dl>
    ${t.description ? `<p class="sub">${esc(t.description)}</p>` : ''}
    <p class="muted">Difficulty is estimated from OpenStreetMap tags (sac_scale, tracktype, smoothness, 4wd_only). Trail data © OpenStreetMap contributors.</p>`);
  if (sheet.get() === 'peek') sheet.set('half');
  fitTo(t.bbox);
  $('#tNav').onclick = () => startNav({ name: t.name, coords: t.chain, trailId: t.id });
  $('#tDir').onclick = () => directions(t);
  $('#tFav').onclick = () => toggleFav(t);
  $('#tShare').onclick = () => shareTrail(t);
  $('#tAddNote').onclick = () => noteEditor('trail:' + t.id, () => renderTrail({ id }));
  $('#tAddPhoto').onclick = () => addPhoto('trail:' + t.id, () => renderNotes('trail:' + t.id, $('#tNotes')));
  $('#tDl').onclick = () => { const p = 0.01; show('newArea', { bbox: [t.bbox[0] - p, t.bbox[1] - p, t.bbox[2] + p, t.bbox[3] + p], name: t.name }); };
  $('#tPlan').onclick = () => { show('plan', {}); planAdd(t.start); };
  $$('[data-poi]').forEach(b => b.onclick = () => { const p = st.data.pois.get(b.dataset.poi); map.flyTo({ center: [p.lon, p.lat], zoom: 16 }); showPoi(p); });
  renderNotes('trail:' + t.id, $('#tNotes'));
  G.profile(t.chain).then(pr => {
    if (st.view?.name !== 'trail' || st.view.args.id !== id) return;
    if (!pr) { $('#tGain').textContent = '–'; $('#tProfNote').textContent = 'Elevation needs terrain data: go online once or save this area offline.'; $('#tProf').style.display = 'none'; return; }
    $('#tGain').textContent = G.fmtElev(pr.gain); $('#tTime').textContent = fmtHM(G.estTime(t.len, pr.gain, act));
    drawProfile($('#tProf'), pr);
    $('#tProfNote').textContent = `Low ${G.fmtElev(pr.min)} · High ${G.fmtElev(pr.max)} · Elevation from AWS Terrain Tiles (approx.)`;
  });
}
const fmtHM = s => { s = Math.round(s / 60); return s < 60 ? s + ' min' : Math.floor(s / 60) + ' h ' + (s % 60) + ' m'; };
function drawProfile(cv, pr, color) {
  const dpr = devicePixelRatio || 1, W = cv.clientWidth || 340, H = cv.clientHeight || 130; cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext('2d'); x.scale(dpr, dpr);
  const pad = { l: 44, r: 8, t: 10, b: 20 }, pts = pr.pts, L = pts[pts.length - 1].d, lo = pr.min - 3, hi = Math.max(pr.max + 3, lo + 15);
  const X = d => pad.l + d / L * (W - pad.l - pad.r), Y = e => pad.t + (1 - (e - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const css = getComputedStyle(document.body), acc = color || css.getPropertyValue('--accent').trim() || '#2f7d4f';
  x.font = '11px ' + css.fontFamily; x.fillStyle = css.getPropertyValue('--text2'); x.strokeStyle = css.getPropertyValue('--line'); x.lineWidth = 1;
  for (const e of [lo, (lo + hi) / 2, hi]) { x.beginPath(); x.moveTo(pad.l, Y(e)); x.lineTo(W - pad.r, Y(e)); x.stroke(); x.fillText(G.fmtElev(e), 2, Y(e) + 4); }
  x.fillText('0', pad.l, H - 5); const lt = G.fmtDist(L); x.fillText(lt, W - pad.r - x.measureText(lt).width, H - 5);
  const g = x.createLinearGradient(0, pad.t, 0, H - pad.b); g.addColorStop(0, acc + '66'); g.addColorStop(1, acc + '08');
  x.beginPath(); x.moveTo(X(0), Y(pts[0].e)); for (const p of pts) x.lineTo(X(p.d), Y(p.e)); x.lineTo(X(L), H - pad.b); x.lineTo(X(0), H - pad.b); x.closePath(); x.fillStyle = g; x.fill();
  x.beginPath(); for (const [i, p] of pts.entries()) i ? x.lineTo(X(p.d), Y(p.e)) : x.moveTo(X(p.d), Y(p.e)); x.strokeStyle = acc; x.lineWidth = 2.2; x.stroke();
}
async function toggleFav(t) {
  if (st.favorites.has(t.id)) { await db.del('favorites', t.id); st.favorites.delete(t.id); toast('Removed from saved'); }
  else { const f = { id: t.id, trail: { ...t, _d: undefined }, segs: trailSegs(t), saved: Date.now() }; await db.put('favorites', f); st.favorites.set(t.id, f); toast('Saved to your trails ♥︎'); }
  if (st.view?.name === 'trail') renderTrail(st.view.args);
}
function directions(t) {
  const p = nearestParking([...st.data.pois.values()], t.start), dest = p ? [p.lon, p.lat] : t.start, ll = `${dest[1].toFixed(6)},${dest[0].toFixed(6)}`;
  modal(`<h2>Directions to trailhead</h2><p class="sub">${p ? 'To ' + esc(p.name || POI_LABEL[p.kind]) + ' near the start of ' : 'To the start of '}${esc(t.name)}. Driving directions open in your maps app (needs signal for routing).</p>
   <div class="list"><a class="btn block" href="https://maps.apple.com/?daddr=${ll}&dirflg=d" target="_blank" rel="noopener">Apple Maps</a>
   <a class="btn block" href="https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving" target="_blank" rel="noopener">Google Maps</a>
   <button class="btn block" id="dGo">Lodestar compass guidance (offline)</button>
   <button class="btn block" id="dCopy">Copy coordinates</button></div>`, (m, close) => {
    m.querySelector('#dGo').onclick = () => { close(); gotoPoint(dest, 'Trailhead: ' + t.name); };
    m.querySelector('#dCopy').onclick = async () => { try { await navigator.clipboard.writeText(ll); toast('Copied ' + ll); } catch { toast(ll); } close(); };
  });
}

// ---------------- notes, reviews & photos (private) ----------------
async function renderNotes(parent, el) {
  if (!el) return;
  const notes = (await db.all('notes')).filter(n => n.parent === parent).sort((a, b) => b.created - a.created);
  const photos = (await db.all('photos')).filter(p => p.parent === parent).sort((a, b) => b.created - a.created);
  el.innerHTML = (photos.length ? `<div class="photos">${photos.map(p => `<img data-ph="${p.id}" alt="Photo" src="${URL.createObjectURL(p.blob)}">`).join('')}</div>` : '')
    + (notes.length ? notes.map(n => `<div class="note" data-note="${n.id}"><div class="when">${new Date(n.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}${n.rating ? ' · ' + '★'.repeat(n.rating) + '☆'.repeat(5 - n.rating) : ''}</div>${n.conditions?.length ? `<div class="badges">${n.conditions.map(c => `<span class="badge">${esc(c)}</span>`).join('')}</div>` : ''}${n.text ? `<div>${esc(n.text)}</div>` : ''}</div>`).join('') : (photos.length ? '' : '<p class="muted">No notes yet. Add conditions, a rating, or photos — they stay on this device.</p>'));
  $$('[data-note]', el).forEach(d => d.onclick = () => noteEditor(parent, () => renderNotes(parent, el), notes.find(n => n.id === d.dataset.note)));
  $$('[data-ph]', el).forEach(img => img.onclick = () => photoViewer(photos.find(p => p.id === img.dataset.ph), () => renderNotes(parent, el)));
}
function noteEditor(parent, done, note = null) {
  const n = note || { id: uid('n'), parent, rating: 0, text: '', conditions: [], created: Date.now() };
  modal(`<h2>${note ? 'Edit note' : 'Add note'}</h2>
   <div class="field"><span>Your rating</span><div class="stars">${[1, 2, 3, 4, 5].map(i => `<button data-star="${i}" class="${i <= n.rating ? 'on' : ''}">★</button>`).join('')}</div></div>
   <div class="field"><span>Conditions</span><div class="chips" style="flex-wrap:wrap;margin:0;padding:0">${CONDITIONS.map(c => chip(c, n.conditions.includes(c), `data-cond="${esc(c)}"`)).join('')}</div></div>
   <div class="field"><span>Notes</span><textarea class="input" id="nText" placeholder="Parking, water, gates, what to bring next time…">${esc(n.text)}</textarea></div>
   <div class="row">${note ? '<button class="btn danger" id="nDel">Delete</button>' : '<button class="btn" data-x>Cancel</button>'}<button class="btn primary" id="nSave">Save</button></div>`, (m, close) => {
    $$('[data-star]', m).forEach(b => b.onclick = () => { n.rating = n.rating === +b.dataset.star ? 0 : +b.dataset.star; $$('[data-star]', m).forEach(s => s.classList.toggle('on', +s.dataset.star <= n.rating)); });
    $$('[data-cond]', m).forEach(b => b.onclick = () => { const c = b.dataset.cond; n.conditions = n.conditions.includes(c) ? n.conditions.filter(x => x !== c) : [...n.conditions, c]; b.classList.toggle('on'); });
    m.querySelector('[data-x]')?.addEventListener('click', close);
    m.querySelector('#nDel')?.addEventListener('click', async () => { await db.del('notes', n.id); close(); done?.(); });
    m.querySelector('#nSave').onclick = async () => { n.text = m.querySelector('#nText').value.trim(); n.updated = Date.now(); await db.put('notes', n); close(); toast('Note saved on this device'); done?.(); };
  });
}
function addPhoto(parent, done) {
  const inp = $('#filePhoto'); inp.value = '';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const bmp = await createImageBitmap(f); const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
      const pos = st.pos ? { lon: st.pos[0], lat: st.pos[1] } : null;
      await db.put('photos', { id: uid('p'), parent, blob, created: Date.now(), ...pos });
      toast('Photo saved on this device'); done?.();
    } catch (e) { toast('Couldn\'t read that photo'); }
  };
  inp.click();
}
function photoViewer(p, done) {
  const url = URL.createObjectURL(p.blob);
  modal(`<img src="${url}" style="width:100%;border-radius:14px;display:block" alt="Photo"><p class="muted">${new Date(p.created).toLocaleString()}</p><div class="row"><button class="btn danger" id="phDel">Delete</button><button class="btn" id="phShare">${ICON.share} Share</button><button class="btn" data-x>Close</button></div>`, (m, close) => {
    m.querySelector('[data-x]').onclick = close;
    m.querySelector('#phDel').onclick = async () => { await db.del('photos', p.id); close(); done?.(); };
    m.querySelector('#phShare').onclick = () => shareFiles([new File([p.blob], 'lodestar-photo.jpg', { type: 'image/jpeg' })], 'Photo from Lodestar');
  });
}

// ---------------- share ----------------
async function shareFiles(files, title, text = '') {
  try {
    if (navigator.canShare?.({ files })) { await navigator.share({ files, title, text }); return true; }
  } catch (e) { if (e.name === 'AbortError') return false; }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  toast('Saved ' + files.map(f => f.name).join(', ')); return true;
}
const slug = s => (s || 'lodestar').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lodestar';
function shareTrail(t) {
  shareSheet(t.name, `${t.name} — ${G.fmtDist(t.len)}, ${DIFF_LABEL[difficultyFor(t, S.mode)]}. Trailhead: ${t.start[1].toFixed(5)}, ${t.start[0].toFixed(5)}`,
    () => new File([G.toGPX({ name: t.name, routes: [{ name: t.name, coords: t.chain }] })], slug(t.name) + '.gpx', { type: 'application/gpx+xml' }),
    () => snapshotCard(t.bbox, t.name, [['Length', G.fmtDist(t.len)], ['Difficulty', DIFF_LABEL[difficultyFor(t, S.mode)]], ['Gain', $('#tGain')?.textContent || '–']]),
    `https://maps.apple.com/?ll=${t.start[1].toFixed(6)},${t.start[0].toFixed(6)}&q=${encodeURIComponent(t.name)}`);
}
function shareSheet(title, text, gpxFn, imgFn, link) {
  modal(`<h2>Share</h2><p class="sub">Uses your phone's share sheet. Nothing is uploaded by Lodestar.</p><div class="list">
   <button class="btn block" id="sGpx">Share GPX file</button><button class="btn block" id="sImg">Share map image</button><button class="btn block" id="sTxt">Share text & location link</button><button class="btn block" data-x>Cancel</button></div>`, (m, close) => {
    m.querySelector('[data-x]').onclick = close;
    m.querySelector('#sGpx').onclick = async () => { close(); await shareFiles([gpxFn()], title, text); };
    m.querySelector('#sImg').onclick = async () => { close(); toast('Preparing image…'); const f = await imgFn(); if (f) await shareFiles([f], title, text); };
    m.querySelector('#sTxt').onclick = async () => { close(); try { if (navigator.share) await navigator.share({ title, text, url: link }); else { await navigator.clipboard.writeText(text + ' ' + link); toast('Copied to clipboard'); } } catch { } };
  });
}
async function snapshotCard(bbox, title, stats) {
  const prev = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing() };
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 0, bearing: 0 });
  await new Promise(r => { map.once('idle', r); setTimeout(r, 6000); });
  const src = map.getCanvas(); const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  x.fillStyle = isDark() ? '#151816' : '#f4f2ec'; x.fillRect(0, 0, W, H);
  const s = Math.max(W / src.width, 1050 / src.height), sw = W / s, sh = 1050 / s;
  x.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, W, 1050);
  x.fillStyle = isDark() ? '#f2f2f4' : '#1c1c1e'; x.font = '700 56px -apple-system, system-ui, sans-serif'; x.fillText(title.slice(0, 30), 50, 1135);
  x.font = '600 34px -apple-system, system-ui, sans-serif';
  stats.forEach(([k, v], i) => { x.fillStyle = isDark() ? '#a1a1a8' : '#6b6b70'; x.fillText(k.toUpperCase(), 50 + i * 330, 1210); x.fillStyle = isDark() ? '#f2f2f4' : '#1c1c1e'; x.font = '700 44px -apple-system, system-ui, sans-serif'; x.fillText(v, 50 + i * 330, 1265); x.font = '600 34px -apple-system, system-ui, sans-serif'; });
  x.fillStyle = S.mode === 'drive' ? '#d9822b' : '#2f7d4f'; x.font = '700 30px -apple-system, system-ui, sans-serif'; x.fillText('✦ Lodestar', W - 230, 1320);
  x.fillStyle = '#8e8e93'; x.font = '22px -apple-system, system-ui, sans-serif'; x.fillText('Map data © OpenStreetMap contributors', 50, 1320);
  map.jumpTo(prev);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return blob ? new File([blob], slug(title) + '.png', { type: 'image/png' }) : null;
}

// ---------------- GPS, follow & heading ----------------
let watchId = null, meMarker = null, orientOn = false;
function needGPS() { return st.locate > 0 || st.rec || st.nav; }
function ensureGPS() {
  if (!('geolocation' in navigator)) { toast('Location isn\'t available on this device'); return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onPos, err => {
    if (err.code === 1) { toast('Location permission denied. Enable it in Settings › Safari › Location.'); setLocate(0, true); }
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}
function maybeStopGPS() { if (!needGPS() && watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
function onPos(p) {
  const c = p.coords, pos = [c.longitude, c.latitude];
  st.pos = pos; st.posAcc = c.accuracy; st.posAlt = c.altitude; st.posSpeed = c.speed;
  if (c.heading != null && !isNaN(c.heading) && (c.speed || 0) > 1) st.gpsHeading = c.heading;
  if (!meMarker) { const el = document.createElement('div'); el.className = 'me'; el.innerHTML = '<div class="cone"></div><div class="dotm"></div>'; meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(pos).addTo(map); }
  meMarker.setLngLat(pos); updateHeadingMarker();
  if (st.locate === 1) map.easeTo({ center: pos, duration: 500 });
  if (st.locate === 2) map.easeTo({ center: pos, bearing: st.heading ?? st.gpsHeading ?? map.getBearing(), duration: 500 });
  if (st.rec && !st.rec.paused) recPoint(p);
  if (st.nav) navUpdate(pos);
  if (st._firstFix) { st._firstFix = false; map.easeTo({ center: pos, zoom: Math.max(map.getZoom(), 14) }); }
}
function updateHeadingMarker() {
  if (!meMarker) return; const h = st.heading ?? st.gpsHeading; const el = meMarker.getElement();
  el.classList.toggle('has-heading', h != null); if (h != null) meMarker.setRotation(h);
}
function onOrient(e) {
  let h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
  if (h == null) return; st.heading = h; updateHeadingMarker();
  if (st.locate === 2 && (!st._lastRot || performance.now() - st._lastRot > 250)) { st._lastRot = performance.now(); map.easeTo({ bearing: h, duration: 240 }); }
}
async function startCompass() {
  if (orientOn) return;
  try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return; } } catch { return; }
  addEventListener('deviceorientationabsolute', onOrient); addEventListener('deviceorientation', onOrient); orientOn = true;
}
function setLocate(v, silent = false) {
  st.locate = v; const b = $('#btnLocate');
  b.classList.toggle('on', v === 1); b.classList.toggle('heading', v === 2);
  if (v > 0) { ensureGPS(); startCompass(); if (st.pos) map.easeTo({ center: st.pos, zoom: Math.max(map.getZoom(), 14), ...(v === 2 && (st.heading ?? st.gpsHeading) != null ? { bearing: st.heading ?? st.gpsHeading } : {}) }); else st._firstFix = true; if (!silent) toast(v === 1 ? 'Following your location' : 'Heading up — map turns with you', 1500); }
  else { if (map.getBearing() && !silent) map.easeTo({ bearing: 0 }); maybeStopGPS(); }
}
async function keepAwake(on) {
  try {
    if (on && S.wake && 'wakeLock' in navigator && !st.wakeLock) { st.wakeLock = await navigator.wakeLock.request('screen'); st.wakeLock.addEventListener('release', () => { st.wakeLock = null; }); }
    if (!on && st.wakeLock) { await st.wakeLock.release(); st.wakeLock = null; }
  } catch { }
}
function speak(text) {
  if (!S.voice || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1; speechSynthesis.speak(u); } catch { }
}
const buzz = p => { try { navigator.vibrate?.(p); } catch { } };

// ---------------- recording ----------------
const ACTS = { hike: '🥾 Hike', walk: '🚶 Walk', run: '🏃 Run', bike: '🚲 Bike', offroad: '🚙 Drive' };
function renderRecord() {
  const r = st.rec;
  if (!r) {
    const def = S.mode === 'drive' ? 'offroad' : 'hike'; st._recAct = st._recAct || def;
    const n = Object.keys(ACTS).length, i = Object.keys(ACTS).indexOf(st._recAct);
    paint(`${hdr('Record')}
      <p class="sub">Tracks distance, time, speed and elevation using GPS — works with no cell signal. Keep Lodestar open on screen while recording.</p>
      <div class="field"><span>Activity</span><div class="seg seg3 small" style="--n:${n};--i:${i}">${Object.entries(ACTS).map(([k, l]) => `<button data-ract="${k}" class="${k === st._recAct ? 'on' : ''}">${l.split(' ')[0]}</button>`).join('')}<i class="seg-thumb"></i></div><div class="muted" style="margin-top:4px">${ACTS[st._recAct]}</div></div>
      <button class="btn primary block" id="rStart" style="margin-top:8px;height:54px;font-size:17px">${ICON.play} Start recording</button>
      <div class="row" style="margin-top:10px"><button class="btn" id="rPlan">${ICON.route} Plan a route</button><button class="btn" id="rImport">Import GPX</button></div>
      <h3>Recent activities</h3><div class="list" id="rRecent"></div>`);
    $$('[data-ract]').forEach(b => b.onclick = () => { st._recAct = b.dataset.ract; renderRecord(); });
    $('#rStart').onclick = () => startRecording(st._recAct);
    $('#rPlan').onclick = () => show('plan', {});
    $('#rImport').onclick = () => $('#fileGpx').click();
    db.all('tracks').then(ts => { const el = $('#rRecent'); if (!el) return; ts.sort((a, b) => b.created - a.created); el.innerHTML = ts.slice(0, 5).map(activityCard).join('') || '<p class="muted">No activities yet.</p>'; $$('[data-track]', el).forEach(b => b.onclick = () => show('activity', { id: b.dataset.track })); });
    return;
  }
  paint(`${hdr(r.paused ? 'Paused' : 'Recording')}
    <div class="row" style="margin-bottom:4px">${r.paused ? `<button class="btn primary" id="rResume">${ICON.play} Resume</button>` : `<button class="btn" id="rPause">${ICON.pause} Pause</button>`}<button class="btn danger" id="rStop">${ICON.stop} Finish</button></div>
    <div class="stats big"><div class="stat"><span>Distance</span><b id="rsD">–</b></div><div class="stat"><span>Moving</span><b id="rsT">–</b></div><div class="stat"><span>${r.activity === 'run' ? 'Pace' : 'Speed'}</span><b id="rsS">–</b></div></div>
    <div class="stats"><div class="stat"><span>Elapsed</span><b id="rsE">–</b></div><div class="stat"><span>Elev. gain</span><b id="rsG">–</b></div><div class="stat"><span>Altitude</span><b id="rsA">–</b></div></div>
    <div class="stats"><div class="stat"><span>Avg speed</span><b id="rsV">–</b></div><div class="stat"><span>Max speed</span><b id="rsM">–</b></div><div class="stat"><span>GPS ±</span><b id="rsAcc">–</b></div></div>
    <div class="row" style="margin-top:4px"><button class="btn" id="rWpt">📍 Waypoint here</button><button class="btn" id="rPhoto">${ICON.camera} Photo</button></div>
    <p class="muted" style="margin-top:12px">iPhone tip: web apps can't record with the screen locked. Lodestar keeps the screen awake while recording; lower brightness to save battery.</p>`);
  $('#rPause')?.addEventListener('click', () => { r.paused = true; r.segments.push([]); saveLiveRec(); renderRecord(); updateHud(); });
  $('#rResume')?.addEventListener('click', () => { r.paused = false; r.refEle = null; saveLiveRec(); renderRecord(); updateHud(); });
  $('#rStop').onclick = finishRecording;
  $('#rWpt').onclick = () => editWaypoint(null, st.pos || map.getCenter().toArray());
  $('#rPhoto').onclick = () => addPhoto('track:' + r.id, () => toast('Photo attached to this activity'));
  updateRecStats();
}
function startRecording(activity, silent) {
  st.rec = { id: uid('t'), activity, started: Date.now(), segments: [[]], paused: false, dist: 0, moving: 0, gain: 0, loss: 0, maxSpd: 0, refEle: null, last: null };
  ensureGPS(); keepAwake(true); if (!st.locate) setLocate(1, true);
  saveLiveRec(); updateHud(); drawTrack();
  if (!silent) { toast('Recording started'); if (st.view?.name === 'record') renderRecord(); }
  st._recTimer = setInterval(() => { updateHud(); if (st.view?.name === 'record') updateRecStats(); }, 1000);
}
function recPoint(p) {
  const r = st.rec, c = p.coords; if (c.accuracy > 40) return;
  const pt = { lon: +c.longitude.toFixed(7), lat: +c.latitude.toFixed(7), ele: c.altitude != null ? +c.altitude.toFixed(1) : null, t: p.timestamp || Date.now(), acc: Math.round(c.accuracy) };
  const seg = r.segments[r.segments.length - 1], last = seg[seg.length - 1];
  if (last) {
    const d = G.hav([last.lon, last.lat], [pt.lon, pt.lat]), dt = (pt.t - last.t) / 1000;
    if (d < Math.max(3, c.accuracy * 0.4) && dt < 30) return; // jitter
    const spd = c.speed != null && c.speed >= 0 ? c.speed : d / Math.max(dt, 0.5);
    if (spd > 70) return; // GPS glitch
    r.dist += d; if (spd > 0.4 && dt < 120) r.moving += dt; r.maxSpd = Math.max(r.maxSpd, spd);
  }
  if (pt.ele != null && (c.altitudeAccuracy == null || c.altitudeAccuracy < 25)) {
    if (r.refEle == null) r.refEle = pt.ele; else if (pt.ele - r.refEle > 4) { r.gain += pt.ele - r.refEle; r.refEle = pt.ele; } else if (r.refEle - pt.ele > 4) { r.loss += r.refEle - pt.ele; r.refEle = pt.ele; }
  }
  seg.push(pt); r.last = pt;
  if (seg.length % 5 === 0) saveLiveRec();
  drawTrack();
}
function updateRecStats() {
  const r = st.rec; if (!r || !$('#rsD')) return;
  const el = (Date.now() - r.started) / 1000, sp = st.posSpeed ?? 0;
  $('#rsD').textContent = G.fmtDist(r.dist, true); $('#rsT').textContent = G.fmtDur(r.moving); $('#rsE').textContent = G.fmtDur(el);
  $('#rsS').textContent = r.activity === 'run' ? G.fmtPace(sp) : G.fmtSpeed(r.paused ? 0 : sp);
  $('#rsG').textContent = G.fmtElev(r.gain); $('#rsA').textContent = st.posAlt != null ? G.fmtElev(st.posAlt) : '–';
  $('#rsV').textContent = G.fmtSpeed(r.moving ? r.dist / r.moving : 0); $('#rsM').textContent = G.fmtSpeed(r.maxSpd); $('#rsAcc').textContent = st.posAcc != null ? G.fmtShortDist(st.posAcc) : '–';
}
function updateHud() {
  const h = $('#recHud'), r = st.rec;
  if (!r || st.nav) { h.hidden = true; return; }
  h.hidden = false; h.classList.toggle('paused', r.paused);
  h.innerHTML = `<i class="live"></i><span>${G.fmtDist(r.dist, true)}</span><span>${G.fmtDur(r.moving)}</span>`;
  h.onclick = () => show('record', {}, false);
}
function drawTrack(segs) {
  const s = segs || st.rec?.segments || [];
  setSrc('track', { type: 'FeatureCollection', features: s.filter(x => x.length > 1).map(x => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: x.map(p => [p.lon, p.lat]) }, properties: {} })) });
}
let liveSaveT;
function saveLiveRec() { clearTimeout(liveSaveT); liveSaveT = setTimeout(() => db.kvSet('liveRec', st.rec), 200); }
async function resumeRecording() {
  const r = await db.kvGet('liveRec', null);
  if (!r || !r.segments) return;
  const ok = await confirmBox('Resume recording?', `An unfinished ${ACTS[r.activity] || 'activity'} from ${new Date(r.started).toLocaleString()} was found (${G.fmtDist(r.dist, true)}).`, 'Resume');
  if (ok) { startRecording(r.activity, true); Object.assign(st.rec, r, { paused: true }); st.rec.segments.push([]); drawTrack(); updateHud(); show('record', {}, false); toast('Recording restored — tap Resume'); }
  else { const ok2 = await confirmBox('Save it instead?', 'Save the unfinished activity to your list, or discard it.', 'Save'); if (ok2) { st.rec = r; await saveRecording(r, 'Recovered ' + (ACTS[r.activity] || 'activity')); st.rec = null; } await db.kvSet('liveRec', null); }
}
async function finishRecording() {
  const r = st.rec; r.paused = true;
  const segs = r.segments.filter(s => s.length > 1);
  if (!segs.length) { if (await confirmBox('Discard recording?', 'No GPS points were recorded yet.', 'Discard', true)) stopRecording(); else r.paused = false; return; }
  const defName = `${ACTS[r.activity].split(' ')[1]} · ${new Date(r.started).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  modal(`<h2>Save activity</h2><div class="stats"><div class="stat"><span>Distance</span><b>${G.fmtDist(r.dist, true)}</b></div><div class="stat"><span>Moving</span><b>${G.fmtDur(r.moving)}</b></div><div class="stat"><span>Gain</span><b>${G.fmtElev(r.gain)}</b></div></div>
    <div class="field"><span>Name</span><input class="input" id="aName" value="${esc(st.nav?.route?.name ? st.nav.route.name : defName)}"></div>
    <div class="field"><span>Notes (private)</span><textarea class="input" id="aNotes" placeholder="How was it?"></textarea></div>
    <div class="row"><button class="btn danger" id="aDiscard">Discard</button><button class="btn" id="aKeep">Keep recording</button><button class="btn primary" id="aSave">Save</button></div>`, (m, close) => {
    m.querySelector('#aKeep').onclick = () => { r.paused = false; close(); renderRecord(); };
    m.querySelector('#aDiscard').onclick = async () => { close(); if (await confirmBox('Discard this activity?', 'This can\'t be undone.', 'Discard', true)) stopRecording(); else { r.paused = false; } };
    m.querySelector('#aSave').onclick = async () => { const id = await saveRecording(r, m.querySelector('#aName').value.trim() || defName, m.querySelector('#aNotes').value.trim()); close(); stopRecording(); show('activity', { id }); };
  });
}
async function saveRecording(r, name, notes = '') {
  const segments = r.segments.filter(s => s.length > 1);
  const stats = { dist: r.dist, moving: r.moving, elapsed: ((segments.at(-1)?.at(-1)?.t || Date.now()) - r.started) / 1000, gain: r.gain, loss: r.loss, maxSpd: r.maxSpd, avgSpd: r.moving ? r.dist / r.moving : 0 };
  const t = { id: r.id, name, activity: r.activity, created: r.started, segments, stats, notes, source: 'recorded' };
  await db.put('tracks', t); toast('Activity saved'); return t.id;
}
function stopRecording() {
  clearInterval(st._recTimer); st.rec = null; db.kvSet('liveRec', null); updateHud(); drawTrack([]);
  if (!st.nav) keepAwake(false); maybeStopGPS(); if (st.view?.name === 'record') renderRecord();
}

// ---------------- navigation (follow a route) ----------------
const ARROW = { start: '⬆︎', 'bear-left': '↖︎', 'bear-right': '↗︎', 'turn-left': '⬅︎', 'turn-right': '➡︎', 'sharp-left': '↙︎', 'sharp-right': '↘︎', arrive: '🏁' };
function drawRoute(coords) { setSrc('route', coords ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} } : empty()); }
async function startNav(route, opts = {}) {
  if (!route.coords || route.coords.length < 2) return toast('This route has no geometry to follow');
  let coords = route.coords.slice();
  // start from whichever end is closer to you
  if (st.pos && !opts.keepDir && G.hav(st.pos, coords.at(-1)) < G.hav(st.pos, coords[0])) coords.reverse();
  const r = { ...route, coords, len: G.lineLength(coords) };
  st.nav = { route: r, cues: G.buildCues(coords, route.name), off: 0, offAlerted: false, spoken: {}, along: 0, started: Date.now() };
  document.body.classList.add('navigating');
  drawRoute(coords); setSrc('navdone', empty()); highlight(null);
  ensureGPS(); keepAwake(true); setLocate(1, true);
  fitTo(G.bboxOf(coords));
  show('nav', {}, false); sheet.set('peek');
  const recToo = opts.record ?? !st.rec;
  if (recToo && !st.rec) startRecording(route.activity || (S.mode === 'drive' ? 'offroad' : 'hike'), true);
  renderBanner(); speak(st.nav.cues[0]?.text || 'Route started');
  if (st.pos) navUpdate(st.pos);
}
function navUpdate(pos) {
  const n = st.nav; if (!n) return;
  const c = n.route.coords, near = G.nearestOnLine(pos, c), thr = S.mode === 'drive' ? Math.max(S.offRoute, 60) : S.offRoute;
  n.dist = near.dist; n.along = Math.max(near.along, n.along - 30); n.remain = Math.max(0, n.route.len - near.along); n.toNear = near.point;
  if (near.dist > thr + (st.posAcc > 30 ? st.posAcc / 2 : 0)) { n.off++; } else { if (n.offAlerted) { speak('Back on route'); toast('Back on route ✓'); } n.off = 0; n.offAlerted = false; }
  if (n.off >= 3 && !n.offAlerted) { n.offAlerted = true; buzz([300, 120, 300]); speak(`Off route. The trail is ${G.fmtShortDist(near.dist)} to the ${compassWord(G.bearing(pos, near.point))}`); }
  // done portion
  const doneCoords = c.slice(0, near.idx + 1).concat([near.point]);
  setSrc('navdone', doneCoords.length > 1 ? { type: 'Feature', geometry: { type: 'LineString', coordinates: doneCoords }, properties: {} } : empty());
  const next = n.cues.find(q => q.at > near.along + 8) || n.cues.at(-1);
  n.next = next; n.toNext = Math.max(0, next.at - near.along);
  if (!n.offAlerted) {
    const key = next.at.toFixed(0);
    if (n.toNext < 160 && n.toNext > 60 && !n.spoken[key + 'a']) { n.spoken[key + 'a'] = 1; speak(`In ${G.fmtShortDist(n.toNext)}, ${next.text.toLowerCase()}`); }
    if (n.toNext <= 30 && !n.spoken[key + 'b']) { n.spoken[key + 'b'] = 1; buzz(150); speak(next.text); }
  }
  if (n.remain < 25 && near.along > n.route.len - 40 && !n.arrived) { n.arrived = true; buzz([200, 100, 200, 100, 400]); speak('You have arrived'); toast('🏁 You\'ve arrived'); }
  renderBanner(); if (st.view?.name === 'nav') updateNavStats();
}
const compassWord = b => ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(b / 45) % 8];
function renderBanner() {
  const n = st.nav, b = $('#navBanner'); if (!n) { b.hidden = true; return; }
  b.hidden = false;
  if (n.offAlerted && st.pos) { b.classList.add('off'); b.innerHTML = `<div class="arrow">⚠️</div><div><div class="d">Off route</div><div class="t">Trail is ${G.fmtShortDist(n.dist)} ${compassWord(G.bearing(st.pos, n.toNear))}</div></div>`; return; }
  b.classList.remove('off');
  const q = n.next || n.cues[0];
  b.innerHTML = `<div class="arrow">${ARROW[q.type] || '⬆︎'}</div><div><div class="d">${n.toNext != null ? G.fmtShortDist(n.toNext) : 'Start'}</div><div class="t">${esc(n.arrived ? 'You\'ve arrived' : q.text)}</div></div>`;
}
function renderNav() {
  const n = st.nav; if (!n) return show('explore', {}, false);
  paint(`<div class="peek-row"><div style="min-width:0"><div style="font-weight:700;font-size:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n.route.name || 'Route')}</div><div class="sub" id="nvSub">Following route</div></div><button class="btn danger" id="nvEnd" style="height:38px">End</button></div>
    <div class="stats"><div class="stat"><span>Remaining</span><b id="nvR">–</b></div><div class="stat"><span>ETA</span><b id="nvE">–</b></div><div class="stat"><span>Done</span><b id="nvD">–</b></div></div>
    <div class="row"><button class="btn" id="nvRev">⇅ Reverse</button><button class="btn" id="nvRec">${st.rec ? '● Recording' : 'Record'}</button><button class="btn" id="nvVoice">${S.voice ? '🔊 Voice' : '🔇 Muted'}</button></div>
    <h3>Turn cues</h3><div class="list cue-list">${n.cues.map(q => `<div class="card"><div class="thumb" style="width:36px;height:36px;font-size:18px">${ARROW[q.type] || '•'}</div><div class="body"><div class="title" style="font-size:14.5px">${esc(q.text)}</div><div class="meta">at ${G.fmtDist(q.at, true)}</div></div></div>`).join('')}</div>`);
  $('#nvEnd').onclick = endNav;
  $('#nvRev').onclick = () => { const r = st.nav.route; startNav({ ...r, coords: r.coords.slice().reverse() }, { keepDir: true, record: false }); };
  $('#nvRec').onclick = () => { if (!st.rec) { startRecording(S.mode === 'drive' ? 'offroad' : 'hike'); renderNav(); } else show('record', {}, true); };
  $('#nvVoice').onclick = () => { S.voice = !S.voice; saveSettings(); renderNav(); };
  updateNavStats();
}
function updateNavStats() {
  const n = st.nav; if (!n || !$('#nvR')) return;
  const rem = n.remain ?? n.route.len, spd = (st.posSpeed > 0.5 ? st.posSpeed : null) || { offroad: 4, bike: 4.5, run: 2.7 }[n.route.activity] || (S.mode === 'drive' ? 4 : 1.25);
  $('#nvR').textContent = G.fmtDist(rem, true); $('#nvD').textContent = Math.round((1 - rem / n.route.len) * 100) + '%';
  $('#nvE').textContent = new Date(Date.now() + rem / spd * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!st.pos) $('#nvSub').textContent = 'Waiting for GPS…'; else if (n.offAlerted) $('#nvSub').textContent = 'Off route'; else $('#nvSub').textContent = `${G.fmtShortDist(n.dist || 0)} from route`;
}
async function endNav() {
  const wasRec = !!st.rec; st.nav = null; document.body.classList.remove('navigating'); renderBanner(); drawRoute(null); setSrc('navdone', empty());
  if (wasRec) { if (await confirmBox('Save your activity?', 'You were recording while navigating.', 'Save')) { show('record', {}, false); finishRecording(); return; } else stopRecording(); }
  keepAwake(false); updateHud(); show('explore', {}, false);
}
function gotoPoint(dest, name) {
  const from = st.pos;
  if (!from) { toast('Waiting for GPS…'); setLocate(1); const t = setInterval(() => { if (st.pos) { clearInterval(t); gotoPoint(dest, name); } }, 1000); setTimeout(() => clearInterval(t), 30000); return; }
  startNav({ name: name || 'Go to point', coords: [from, dest] }, { keepDir: true, record: false });
}

// ---------------- waypoints ----------------
function editWaypoint(w, at) {
  const isNew = !w; w = w || { id: uid('w'), name: '', icon: S.mode === 'drive' ? 'vehicle' : 'pin', notes: '', lon: +at[0].toFixed(6), lat: +at[1].toFixed(6), created: Date.now(), ele: st.posAlt ?? null };
  modal(`<h2>${isNew ? 'New waypoint' : 'Edit waypoint'}</h2><p class="muted">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}${isNew ? (st.pos && st.locate ? ' · your location' : ' · map center') : ''}</p>
   <div class="field"><span>Icon</span><div class="icons">${Object.entries(WPT_ICONS).map(([k, e]) => `<button data-ic="${k}" class="${k === w.icon ? 'on' : ''}" title="${WPT_LABEL[k]}">${e}</button>`).join('')}</div></div>
   <div class="field"><span>Name</span><input class="input" id="wName" value="${esc(w.name)}" placeholder="${WPT_LABEL[w.icon]}"></div>
   <div class="field"><span>Notes</span><textarea class="input" id="wNotes" placeholder="Details, directions, hazards…">${esc(w.notes)}</textarea></div>
   <div class="row">${isNew ? '<button class="btn" data-x>Cancel</button>' : '<button class="btn danger" id="wDel">Delete</button>'}<button class="btn primary" id="wSave">Save</button></div>`, (m, close) => {
    $$('[data-ic]', m).forEach(b => b.onclick = () => { w.icon = b.dataset.ic; $$('[data-ic]', m).forEach(x => x.classList.toggle('on', x === b)); m.querySelector('#wName').placeholder = WPT_LABEL[w.icon]; });
    m.querySelector('[data-x]')?.addEventListener('click', close);
    m.querySelector('#wDel')?.addEventListener('click', async () => { await db.del('waypoints', w.id); st.waypoints = await db.all('waypoints'); refreshOverlays(); close(); back(); });
    m.querySelector('#wSave').onclick = async () => { w.name = m.querySelector('#wName').value.trim() || WPT_LABEL[w.icon]; w.notes = m.querySelector('#wNotes').value.trim(); await db.put('waypoints', w); st.waypoints = await db.all('waypoints'); refreshOverlays(); close(); toast('Waypoint saved'); if (st.view?.name === 'waypoint') renderWaypoint({ id: w.id }); if (st.view?.name === 'saved') renderSaved(st.view.args); };
  });
}
function renderWaypoint({ id }) {
  const w = (st.waypoints || []).find(x => x.id === id); if (!w) return back();
  paint(`${hdr(w.name, { back: true })}<div class="sub">${WPT_ICONS[w.icon] || '📍'} ${WPT_LABEL[w.icon] || 'Waypoint'} · ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}${w.ele != null ? ' · ' + G.fmtElev(w.ele) : ''}</div>
    ${st.pos ? `<div class="sub">${G.fmtDist(G.hav(st.pos, [w.lon, w.lat]), true)} ${compassWord(G.bearing(st.pos, [w.lon, w.lat]))} of you</div>` : ''}
    ${w.notes ? `<div class="note">${esc(w.notes)}</div>` : ''}
    <div class="actions"><button class="act primary" id="wGo"><i>${ICON.nav}</i>Go</button><button class="act" id="wEdit"><i>${ICON.pencil}</i>Edit</button><button class="act" id="wShare"><i>${ICON.share}</i>Share</button><button class="act" id="wPhoto"><i>${ICON.camera}</i>Photo</button></div>
    <div id="wNotesEl"></div><p class="muted">Saved ${new Date(w.created).toLocaleString()}</p>`);
  map.flyTo({ center: [w.lon, w.lat], zoom: Math.max(map.getZoom(), 15) });
  $('#wGo').onclick = () => gotoPoint([w.lon, w.lat], w.name);
  $('#wEdit').onclick = () => editWaypoint(w);
  $('#wShare').onclick = () => shareFiles([new File([G.toGPX({ name: w.name, waypoints: [w] })], slug(w.name) + '.gpx', { type: 'application/gpx+xml' })], w.name, `${w.name}: ${w.lat.toFixed(6)}, ${w.lon.toFixed(6)}`);
  $('#wPhoto').onclick = () => addPhoto('wpt:' + w.id, () => renderNotes('wpt:' + w.id, $('#wNotesEl')));
  renderNotes('wpt:' + w.id, $('#wNotesEl'));
}

// ---------------- plan your own route (snaps along trails) ----------------
let graph = null, graphSig = '';
function buildGraph() {
  const sig = st.data.ways.size + ':' + (st.live?.fetched || 0) + ':' + st.areas.length;
  if (graph && graphSig === sig) return graph;
  const nodes = new Map(), coords = [], adj = [];
  const key = c => c[0].toFixed(6) + ',' + c[1].toFixed(6);
  const idx = c => { const k = key(c); let i = nodes.get(k); if (i == null) { i = coords.length; nodes.set(k, i); coords.push(c); adj.push([]); } return i; };
  const drv = S.mode === 'drive';
  for (const w of st.data.ways.values()) {
    if (drv ? !w.cls.offroad : !(w.cls.hike || w.cls.walk || w.cls.bike)) continue;
    let prev = idx(w.coords[0]);
    for (let i = 1; i < w.coords.length; i++) { const cur = idx(w.coords[i]), d = G.hav(w.coords[i - 1], w.coords[i]); adj[prev].push([cur, d]); adj[cur].push([prev, d]); prev = cur; }
  }
  graph = { coords, adj }; graphSig = sig + drv; return graph;
}
function nearestNode(g, p, maxD = 80) { let bi = -1, bd = maxD; for (let i = 0; i < g.coords.length; i++) { const c = g.coords[i]; if (Math.abs(c[1] - p[1]) > 0.002) continue; const d = G.hav(p, c); if (d < bd) { bd = d; bi = i; } } return bi; }
function shortest(g, a, b) {
  if (a === b) return [g.coords[a]];
  const dist = new Float64Array(g.coords.length).fill(Infinity), prev = new Int32Array(g.coords.length).fill(-1); dist[a] = 0;
  const heap = [[0, a]]; const push = x => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break;[heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break;[heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  let n = 0;
  while (heap.length && n++ < 400000) { const [d, u] = pop(); if (u === b) break; if (d > dist[u]) continue; for (const [v, w] of g.adj[u]) { const nd = d + w; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); } } }
  if (prev[b] < 0) return null;
  const path = []; for (let u = b; u !== -1; u = prev[u]) path.push(g.coords[u]); return path.reverse();
}
function renderPlan() {
  if (!st.plan) st.plan = { pts: [], legs: [], snap: true, name: '' };
  const p = st.plan, coords = planCoords(), L = G.lineLength(coords);
  $('#crosshair').hidden = true;
  paint(`${hdr('Plan a route', { back: true })}
    <p class="sub">Tap the map to add points. ${p.snap ? 'Lodestar routes along mapped trails between points when it can.' : 'Points are joined with straight lines.'}</p>
    <div class="stats"><div class="stat"><span>Distance</span><b>${G.fmtDist(L, true)}</b></div><div class="stat"><span>Points</span><b>${p.pts.length}</b></div><div class="stat"><span>Gain</span><b id="plG">–</b></div></div>
    <canvas class="profile" id="plProf" style="${coords.length > 1 ? '' : 'display:none'}"></canvas>
    <div class="group" style="margin:8px 0"><div><label>Snap to trails</label><label class="switch"><input type="checkbox" id="plSnap" ${p.snap ? 'checked' : ''}><i></i></label></div></div>
    <div class="row"><button class="btn" id="plUndo" ${p.pts.length ? '' : 'disabled'}>↶ Undo</button><button class="btn" id="plClear" ${p.pts.length ? '' : 'disabled'}>Clear</button><button class="btn" id="plMe" ${st.pos ? '' : 'disabled'}>+ My spot</button></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="plSave" ${coords.length > 1 ? '' : 'disabled'}>Save route</button><button class="btn primary" id="plGo" ${coords.length > 1 ? '' : 'disabled'}>${ICON.nav} Follow</button></div>`);
  $('#plSnap').onchange = e => { p.snap = e.target.checked; recomputePlan(); };
  $('#plUndo').onclick = () => { p.pts.pop(); p.legs.pop(); drawPlan(); renderPlan(); };
  $('#plClear').onclick = () => { p.pts = []; p.legs = []; drawPlan(); renderPlan(); };
  $('#plMe').onclick = () => planAdd(st.pos);
  $('#plSave').onclick = async () => { const name = await promptBox('Route name', p.name || 'My route'); if (name == null) return; const r = { id: p.id || uid('r'), name: name || 'My route', coords: planCoords(), pts: p.pts, created: Date.now(), mode: S.mode }; await db.put('routes', r); p.id = r.id; p.name = r.name; toast('Route saved'); };
  $('#plGo').onclick = () => { const c = planCoords(), name = p.name || 'Planned route'; endPlan(); startNav({ name, coords: c }, { keepDir: true }); };
  if (coords.length > 1) G.profile(coords).then(pr => { if (pr && $('#plProf')) { drawProfile($('#plProf'), pr, '#7c4dff'); $('#plG').textContent = G.fmtElev(pr.gain); } });
  if (sheet.get() === 'full') sheet.set('half');
}
function planCoords() { const p = st.plan; if (!p || !p.pts.length) return []; let c = [p.pts[0]]; for (const leg of p.legs) c = c.concat(leg.slice(1)); return c; }
function leg(a, b) {
  if (!st.plan.snap) return [a, b];
  const g = buildGraph(); const na = nearestNode(g, a), nb = nearestNode(g, b);
  if (na < 0 || nb < 0) return [a, b];
  const path = shortest(g, na, nb);
  if (!path) return [a, b];
  return [a, ...path, b];
}
function planAdd(pt) { const p = st.plan || (st.plan = { pts: [], legs: [], snap: true }); if (p.pts.length) p.legs.push(leg(p.pts.at(-1), pt)); p.pts.push(pt); drawPlan(); if (st.view?.name === 'plan') renderPlan(); }
function recomputePlan() { const p = st.plan; p.legs = []; for (let i = 1; i < p.pts.length; i++) p.legs.push(leg(p.pts[i - 1], p.pts[i])); drawPlan(); renderPlan(); }
function planClick(e) { planAdd([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]); }
function drawPlan() {
  const c = planCoords(), p = st.plan;
  setSrc('route', c.length > 1 ? { type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {} } : empty());
  setSrc('plan', { type: 'FeatureCollection', features: (p?.pts || []).map(x => ({ type: 'Feature', geometry: { type: 'Point', coordinates: x }, properties: {} })) });
}
function endPlan() { st.plan = null; setSrc('plan', empty()); if (!st.nav) drawRoute(null); }

// ---------------- saved ----------------
function activityCard(t) {
  return `<button class="card" data-track="${t.id}"><div class="thumb">${(ACTS[t.activity] || '📍').split(' ')[0]}</div><div class="body"><div class="title">${esc(t.name)}</div><div class="meta"><span>${G.fmtDist(t.stats?.dist, true)}</span><i class="dot"></i><span>${G.fmtDur(t.stats?.moving || 0)}</span><i class="dot"></i><span>${new Date(t.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div></div>${ICON.chev}</button>`;
}
async function renderSaved(args = {}) {
  const tab = args.tab || st._savedTab || 'trails'; st._savedTab = tab;
  const tabs = [['trails', 'Trails'], ['activities', 'Activities'], ['routes', 'Routes'], ['waypoints', 'Waypoints']];
  const i = tabs.findIndex(t => t[0] === tab);
  paint(`${hdr('Saved', { right: `<button class="btn" id="svImport" style="height:34px;font-size:14px;padding:0 12px">Import GPX</button>` })}
    <div class="seg seg3 small seg-wrap" style="--n:4;--i:${i}">${tabs.map(([k, l]) => `<button data-sv="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}<i class="seg-thumb"></i></div>
    <div class="list" id="svList"></div>`);
  $$('[data-sv]').forEach(b => b.onclick = () => renderSaved({ tab: b.dataset.sv }));
  $('#svImport').onclick = () => $('#fileGpx').click();
  const el = $('#svList');
  if (tab === 'trails') {
    const favs = [...st.favorites.values()].sort((a, b) => b.saved - a.saved);
    el.innerHTML = favs.map(f => trailCard(f.trail)).join('') || `<div class="empty"><div class="big">♡</div>Tap <b>Save</b> on any trail to keep it here — even outside your offline areas.</div>`;
    $$('[data-trail]', el).forEach(b => b.onclick = () => show('trail', { id: b.dataset.trail }));
  } else if (tab === 'activities') {
    const ts = (await db.all('tracks')).sort((a, b) => b.created - a.created);
    el.innerHTML = ts.map(activityCard).join('') || `<div class="empty"><div class="big">●</div>Record a hike or a drive from the <b>Record</b> tab, or import a GPX file.</div>`;
    $$('[data-track]', el).forEach(b => b.onclick = () => show('activity', { id: b.dataset.track }));
  } else if (tab === 'routes') {
    const rs = (await db.all('routes')).sort((a, b) => b.created - a.created);
    el.innerHTML = `<button class="btn primary block" id="svPlan">${ICON.plus} Plan a new route</button>` + rs.map(r => `<button class="card" data-route="${r.id}"><div class="thumb" style="background:rgba(124,77,255,.14)">〰️</div><div class="body"><div class="title">${esc(r.name)}</div><div class="meta">${G.fmtDist(G.lineLength(r.coords), true)} · ${new Date(r.created).toLocaleDateString()}</div></div>${ICON.chev}</button>`).join('');
    $('#svPlan').onclick = () => show('plan', {});
    $$('[data-route]', el).forEach(b => b.onclick = () => show('route', { id: b.dataset.route }));
  } else {
    const ws = (st.waypoints || []).slice().sort((a, b) => b.created - a.created);
    el.innerHTML = `<button class="btn block" id="svWpt">${ICON.plus} New waypoint at map center</button>` + ws.map(w => `<button class="card" data-wpt="${w.id}"><div class="thumb">${WPT_ICONS[w.icon] || '📍'}</div><div class="body"><div class="title">${esc(w.name)}</div><div class="meta">${WPT_LABEL[w.icon] || ''}${st.pos ? ' · ' + G.fmtDist(G.hav(st.pos, [w.lon, w.lat]), true) + ' away' : ''}</div></div>${ICON.chev}</button>`).join('')
      + (ws.length ? `<button class="btn block" id="svWptExp" style="margin-top:6px">${ICON.share} Export all waypoints (GPX)</button>` : '');
    $('#svWpt').onclick = () => editWaypoint(null, map.getCenter().toArray());
    $('#svWptExp')?.addEventListener('click', () => shareFiles([new File([G.toGPX({ name: 'Lodestar waypoints', waypoints: ws })], 'lodestar-waypoints.gpx', { type: 'application/gpx+xml' })], 'Waypoints'));
    $$('[data-wpt]', el).forEach(b => b.onclick = () => show('waypoint', { id: b.dataset.wpt }));
  }
}
async function renderActivity({ id }) {
  const t = await db.get('tracks', id); if (!t) return back();
  const s = t.stats || G.trackStats(t.segments), all = t.segments.flat(), coords = all.map(p => [p.lon, p.lat]);
  drawTrack(t.segments); if (coords.length > 1) fitTo(G.bboxOf(coords));
  paint(`${hdr(t.name, { back: true })}<div class="sub">${ACTS[t.activity] || 'Activity'} · ${new Date(t.created).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
    <div class="stats"><div class="stat"><span>Distance</span><b>${G.fmtDist(s.dist, true)}</b></div><div class="stat"><span>Moving</span><b>${G.fmtDur(s.moving)}</b></div><div class="stat"><span>Elapsed</span><b>${G.fmtDur(s.elapsed)}</b></div></div>
    <div class="stats"><div class="stat"><span>Gain</span><b>${G.fmtElev(s.gain)}</b></div><div class="stat"><span>${t.activity === 'run' ? 'Avg pace' : 'Avg speed'}</span><b>${t.activity === 'run' ? G.fmtPace(s.avgSpd) : G.fmtSpeed(s.avgSpd)}</b></div><div class="stat"><span>Max speed</span><b>${G.fmtSpeed(s.maxSpd)}</b></div></div>
    <canvas class="profile" id="acProf"></canvas>
    <div class="actions"><button class="act primary" id="acFollow"><i>${ICON.nav}</i>Follow</button><button class="act" id="acShare"><i>${ICON.share}</i>Share</button><button class="act" id="acRename"><i>${ICON.pencil}</i>Rename</button><button class="act" id="acDel"><i>${ICON.trash}</i>Delete</button></div>
    ${t.notes ? `<div class="note">${esc(t.notes)}</div>` : ''}
    <h3>Notes & photos (private)</h3><div id="acNotes"></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="acNote">${ICON.pencil} Add note</button><button class="btn" id="acPhoto">${ICON.camera} Add photo</button></div>`);
  const ele = all.filter(p => p.ele != null);
  if (ele.length > all.length * 0.6 && ele.length > 3) { let d = 0; const pts = []; for (let i = 0; i < all.length; i++) { if (i) d += G.hav([all[i - 1].lon, all[i - 1].lat], [all[i].lon, all[i].lat]); if (all[i].ele != null) pts.push({ d, e: all[i].ele }); } const es = pts.map(p => p.e); drawProfile($('#acProf'), { pts, min: Math.min(...es), max: Math.max(...es) }, '#e5484d'); }
  else if (coords.length > 1) G.profile(coords).then(pr => pr ? drawProfile($('#acProf'), pr, '#e5484d') : ($('#acProf').style.display = 'none'));
  $('#acFollow').onclick = () => startNav({ name: t.name, coords, activity: t.activity }, {});
  $('#acShare').onclick = () => shareSheet(t.name, `${t.name}: ${G.fmtDist(s.dist, true)} in ${G.fmtDur(s.moving)}, ${G.fmtElev(s.gain)} gain`, () => new File([G.toGPX({ name: t.name, tracks: [t] })], slug(t.name) + '.gpx', { type: 'application/gpx+xml' }),
    () => snapshotCard(G.bboxOf(coords), t.name, [['Distance', G.fmtDist(s.dist, true)], ['Time', G.fmtDur(s.moving)], ['Gain', G.fmtElev(s.gain)]]), `https://maps.apple.com/?ll=${coords[0][1]},${coords[0][0]}`);
  $('#acRename').onclick = async () => { const n = await promptBox('Rename activity', t.name); if (n) { t.name = n; await db.put('tracks', t); renderActivity({ id }); } };
  $('#acDel').onclick = async () => { if (await confirmBox('Delete activity?', 'This removes it from this device.', 'Delete', true)) { await db.del('tracks', id); drawTrack([]); back(); } };
  $('#acNote').onclick = () => noteEditor('track:' + id, () => renderNotes('track:' + id, $('#acNotes')));
  $('#acPhoto').onclick = () => addPhoto('track:' + id, () => renderNotes('track:' + id, $('#acNotes')));
  renderNotes('track:' + id, $('#acNotes'));
}
async function renderRoute({ id }) {
  const r = await db.get('routes', id); if (!r) return back();
  drawRoute(r.coords); fitTo(G.bboxOf(r.coords));
  paint(`${hdr(r.name, { back: true })}<div class="sub">${G.fmtDist(G.lineLength(r.coords), true)} · planned ${new Date(r.created).toLocaleDateString()}</div>
    <canvas class="profile" id="rtProf"></canvas>
    <div class="actions"><button class="act primary" id="rtGo"><i>${ICON.nav}</i>Follow</button><button class="act" id="rtEdit"><i>${ICON.pencil}</i>Edit</button><button class="act" id="rtShare"><i>${ICON.share}</i>Share</button><button class="act" id="rtDel"><i>${ICON.trash}</i>Delete</button></div>`);
  G.profile(r.coords).then(pr => pr ? drawProfile($('#rtProf'), pr, '#7c4dff') : ($('#rtProf').style.display = 'none'));
  $('#rtGo').onclick = () => startNav({ name: r.name, coords: r.coords });
  $('#rtEdit').onclick = () => { st.plan = { id: r.id, name: r.name, pts: r.pts || [r.coords[0], r.coords.at(-1)], legs: [], snap: !!r.pts }; if (r.pts) recomputePlan(); else st.plan.legs = [r.coords]; show('plan', {}); drawPlan(); };
  $('#rtShare').onclick = () => shareFiles([new File([G.toGPX({ name: r.name, routes: [r] })], slug(r.name) + '.gpx', { type: 'application/gpx+xml' })], r.name);
  $('#rtDel').onclick = async () => { if (await confirmBox('Delete route?', '', 'Delete', true)) { await db.del('routes', id); drawRoute(null); back(); } };
}
async function importGPXFile(e) {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const g = G.parseGPX(await f.text()); let n = 0, lastTrack = null;
    for (const t of g.tracks) { const segs = t.segments; const stats = G.trackStats(segs); const id = uid('t'); await db.put('tracks', { id, name: t.name, activity: ({ hiking: 'hike', walking: 'walk', running: 'run', cycling: 'bike', biking: 'bike', driving: 'offroad' }[t.activity?.toLowerCase()] || (ACTS[t.activity] ? t.activity : 'hike')), created: segs[0]?.[0]?.t || Date.now(), segments: segs, stats, source: 'gpx' }); n++; lastTrack = id; }
    for (const r of g.routes) if (r.coords.length > 1) { await db.put('routes', { id: uid('r'), name: r.name, coords: r.coords, created: Date.now() }); n++; }
    for (const w of g.waypoints) { await db.put('waypoints', { id: uid('w'), name: w.name, notes: w.notes, icon: Object.keys(WPT_ICONS).find(k => (w.icon || '').toLowerCase().includes(k)) || 'pin', lon: w.lon, lat: w.lat, ele: w.ele, created: Date.now() }); n++; }
    st.waypoints = await db.all('waypoints'); refreshOverlays();
    toast(`Imported ${g.tracks.length} track(s), ${g.routes.length} route(s), ${g.waypoints.length} waypoint(s)`);
    if (g.tracks.length === 1 && lastTrack) show('activity', { id: lastTrack }); else show('saved', { tab: g.tracks.length ? 'activities' : g.routes.length ? 'routes' : 'waypoints' }, false);
  } catch (err) { toast('Couldn\'t import: ' + err.message); }
}

// ---------------- offline areas ----------------
async function renderOffline() {
  st.areas = await db.all('areas');
  let est = null; try { est = await navigator.storage?.estimate?.(); } catch { }
  let persisted = false; try { persisted = await navigator.storage?.persisted?.(); } catch { }
  paint(`${hdr('Offline maps')}
    <p class="sub">Save maps, trails and terrain for places you'll be without signal. GPS works offline; saved areas show up even in airplane mode.</p>
    <button class="btn primary block" id="ofNew">${ICON.dl} Save a new area</button>
    <div class="list" id="ofList" style="margin-top:12px">${st.areas.sort((a, b) => b.saved - a.saved).map(a => `<div class="card" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;gap:12px;align-items:center"><div class="thumb">🗺️</div><div class="body"><div class="title">${esc(a.name)}</div><div class="meta">${G.fmtBytes(a.bytes || 0)} · z${a.minZ}–${a.maxZ} · ${a.tiles.toLocaleString()} tiles${a.layers.topo ? ' · Topo' : ''}${a.layers.sat ? ' · Satellite' : ''}</div><div class="meta">${a.hasData ? '✓ Trails & POIs' : '⚠︎ No trail data'} · saved ${new Date(a.saved).toLocaleDateString()}${a.failed ? ` · ${a.failed} tiles missing` : ''}</div></div></div>
      <div class="row" style="margin-top:10px"><button class="btn" data-view="${a.id}" style="height:38px">View</button><button class="btn" data-refresh="${a.id}" style="height:38px">Update trails</button><button class="btn danger" data-del="${a.id}" style="height:38px">Delete</button></div></div>`).join('') || '<div class="empty"><div class="big">🗺️</div>No offline areas yet.<br>Try saving the area around a park or trail system before your trip.</div>'}</div>
    <h3>Storage</h3><div class="group">
      <div><label>Used by Lodestar</label><span class="val">${est ? G.fmtBytes(est.usage || 0) : '–'}</span></div>
      <div><label>Available to this app</label><span class="val">${est?.quota ? G.fmtBytes(est.quota) : '–'}</span></div>
      <div><label>Protected from auto-cleanup</label><span class="val">${persisted ? 'Yes' : 'Not yet'}</span></div></div>
    <p class="muted">iPhone: Safari may clear website data for apps not opened in a few weeks. Installing Lodestar to your Home Screen and opening it regularly keeps saved maps safe. Re-check your areas before a big trip.</p>`);
  $('#ofNew').onclick = () => show('newArea', {});
  $$('[data-view]').forEach(b => b.onclick = () => { const a = st.areas.find(x => x.id === b.dataset.view); fitTo(a.bbox); sheet.set('peek'); });
  $$('[data-del]').forEach(b => b.onclick = async () => { const a = st.areas.find(x => x.id === b.dataset.del); if (!(await confirmBox('Delete offline area?', `${a.name} (${G.fmtBytes(a.bytes || 0)}) will be removed from this device.`, 'Delete', true))) return; await deleteArea(a.id); await loadAll(); renderOffline(); toast('Area deleted'); });
  $$('[data-refresh]').forEach(b => b.onclick = async () => { if (!navigator.onLine) return toast('Needs a connection'); b.textContent = 'Updating…'; b.disabled = true; try { await refreshAreaData(st.areas.find(x => x.id === b.dataset.refresh)); await loadAll(); toast('Trail data updated'); } catch { toast('Update failed — try again later'); } renderOffline(); });
}
let areaFrameEl = null, drawnBox = null;
function areaFrameRect() {
  const top = ($('#topbar').getBoundingClientRect().bottom || 100) + 14, sh = $('#sheet').getBoundingClientRect().top;
  const wide = innerWidth >= 760, left = wide ? 430 : 18, right = innerWidth - (wide ? 76 : 70);
  return { left, top, right, bottom: Math.max(top + 120, sh - 14) };
}
function frameToBbox(r) {
  const rect = map.getContainer().getBoundingClientRect();
  const a = map.unproject([r.left - rect.left, r.bottom - rect.top]), b = map.unproject([r.right - rect.left, r.top - rect.top]);
  return [+Math.min(a.lng, b.lng).toFixed(5), +Math.min(a.lat, b.lat).toFixed(5), +Math.max(a.lng, b.lng).toFixed(5), +Math.max(a.lat, b.lat).toFixed(5)];
}
function updateAreaFrame() {
  if (!areaFrameEl) { areaFrameEl = document.createElement('div'); areaFrameEl.className = 'areaframe'; document.body.appendChild(areaFrameEl); }
  let r;
  if (st.view.args.bbox && !st._areaMoved) { const b = st.view.args.bbox, p1 = map.project([b[0], b[3]]), p2 = map.project([b[2], b[1]]); const cr = map.getContainer().getBoundingClientRect(); r = { left: p1.x + cr.left, top: p1.y + cr.top, right: p2.x + cr.left, bottom: p2.y + cr.top }; }
  else if (drawnBox) { const p1 = map.project([drawnBox[0], drawnBox[3]]), p2 = map.project([drawnBox[2], drawnBox[1]]); r = { left: p1.x, top: p1.y, right: p2.x, bottom: p2.y }; }
  else r = areaFrameRect();
  Object.assign(areaFrameEl.style, { left: r.left + 'px', top: r.top + 'px', width: (r.right - r.left) + 'px', height: (r.bottom - r.top) + 'px' });
  st._areaBbox = st.view.args.bbox && !st._areaMoved ? st.view.args.bbox : drawnBox || frameToBbox(r);
  updateEstimate();
}
function endAreaSelect() { areaFrameEl?.remove(); areaFrameEl = null; drawnBox = null; st._areaMoved = false; $('#drawLayer').hidden = true; }
function renderNewArea(args) {
  const a = st._newArea = st._newArea && st._newArea.fresh === args ? st._newArea : { fresh: args, name: args.name || '', detail: 15, topo: false, sat: false };
  paint(`${hdr('Save area offline', { back: true })}
    <p class="sub" id="naHint">${args.bbox ? 'The highlighted box will be saved. Move the map to pick a different spot.' : 'Pan and zoom so the box covers where you\'re going, or draw your own box.'}</p>
    <div class="field"><span>Name</span><input class="input" id="naName" placeholder="e.g. Glacial Lakes State Park" value="${esc(a.name)}"></div>
    <div class="field"><span>Detail</span><div class="seg seg3 small" style="--n:3;--i:${[13, 15, 16].indexOf(a.detail)}"><button data-det="13" class="${a.detail === 13 ? 'on' : ''}">Overview</button><button data-det="15" class="${a.detail === 15 ? 'on' : ''}">Trail</button><button data-det="16" class="${a.detail === 16 ? 'on' : ''}">Max</button><i class="seg-thumb"></i></div></div>
    <div class="group">
      <div><label>Lodestar trail map + terrain<div class="muted">Always included · street, trail & hillshade</div></label><span class="val">✓</span></div>
      <div><label>USGS Topo<div class="muted">Contours, public land (US)</div></label><label class="switch"><input type="checkbox" id="naTopo" ${a.topo ? 'checked' : ''}><i></i></label></div>
      <div><label>Satellite (USGS imagery)<div class="muted">US coverage · bigger download</div></label><label class="switch"><input type="checkbox" id="naSat" ${a.sat ? 'checked' : ''}><i></i></label></div>
    </div>
    <div class="stats" style="margin-top:12px"><div class="stat"><span>Area</span><b id="naKm">–</b></div><div class="stat"><span>Tiles</span><b id="naTiles">–</b></div><div class="stat"><span>Est. size</span><b id="naSize">–</b></div></div>
    <div class="muted" id="naWarn"></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="naDraw">✏️ Draw box</button><button class="btn primary" id="naGo">${ICON.dl} Download</button></div>
    <div id="naProg" hidden><div class="progress"><i id="naBar"></i></div><div class="row"><div class="sub" id="naStatus">Starting…</div><button class="btn danger" id="naCancel" style="flex:none;height:36px">Cancel</button></div></div>`);
  sheet.set('half');
  if (args.bbox && !st._areaInit) { st._areaInit = true; fitTo(args.bbox); map.once('moveend', () => { st._areaMoved = false; updateAreaFrame(); setTimeout(() => map.once('movestart', () => { st._areaMoved = true; }), 50); }); }
  setTimeout(updateAreaFrame, 420);
  $('#naName').oninput = e => { a.name = e.target.value; };
  $$('[data-det]').forEach(b => b.onclick = () => { a.detail = +b.dataset.det; renderNewArea(args); });
  $('#naTopo').onchange = e => { a.topo = e.target.checked; updateEstimate(); };
  $('#naSat').onchange = e => { a.sat = e.target.checked; updateEstimate(); };
  $('#naDraw').onclick = startDrawBox;
  $('#naGo').onclick = runDownload;
}
function updateEstimate() {
  const a = st._newArea, b = st._areaBbox; if (!a || !b || !$('#naTiles')) return;
  const plan = planDownload(b, 10, a.detail, { vector: true, dem: true, topo: a.topo, sat: a.sat });
  $('#naKm').textContent = G.units.imperial ? Math.round(plan.km2 * 0.386102).toLocaleString() + ' mi²' : Math.round(plan.km2).toLocaleString() + ' km²';
  $('#naTiles').textContent = plan.tiles.toLocaleString(); $('#naSize').textContent = '~' + G.fmtBytes(plan.bytes);
  const tooBig = plan.tiles > MAX_TILES || plan.km2 > MAX_AREA_KM2;
  $('#naWarn').innerHTML = tooBig ? `<span style="color:var(--danger)">Too big for one download (limit ${MAX_TILES.toLocaleString()} tiles / ${G.units.imperial ? Math.round(MAX_AREA_KM2 * 0.386) + ' mi²' : MAX_AREA_KM2 + ' km²'}). Zoom in, draw a smaller box, or lower the detail.</span>` : 'Downloads are limited to keep things fair to the free map servers. Wi-Fi recommended.';
  $('#naGo').disabled = tooBig || !navigator.onLine;
  if (!navigator.onLine) $('#naWarn').textContent = 'Connect to the internet to download.';
}
function startDrawBox() {
  const layer = $('#drawLayer'), rect = $('#drawRect'); layer.hidden = false; rect.style.display = 'none'; toast('Drag on the map to draw a box', 2000);
  let sx, sy;
  layer.onpointerdown = e => { sx = e.clientX; sy = e.clientY; rect.style.display = 'block'; Object.assign(rect.style, { left: sx + 'px', top: sy + 'px', width: 0, height: 0 }); layer.setPointerCapture(e.pointerId); };
  layer.onpointermove = e => { if (sx == null) return; Object.assign(rect.style, { left: Math.min(sx, e.clientX) + 'px', top: Math.min(sy, e.clientY) + 'px', width: Math.abs(e.clientX - sx) + 'px', height: Math.abs(e.clientY - sy) + 'px' }); };
  layer.onpointerup = e => {
    if (sx == null) return; const r = { left: Math.min(sx, e.clientX), top: Math.min(sy, e.clientY), right: Math.max(sx, e.clientX), bottom: Math.max(sy, e.clientY) }; sx = null;
    layer.hidden = true; rect.style.display = 'none';
    if (r.right - r.left < 20 || r.bottom - r.top < 20) return;
    drawnBox = frameToBbox(r); st.view.args = { ...st.view.args, bbox: null }; st._areaMoved = true; updateAreaFrame();
  };
}
let dlCtrl = null;
async function runDownload() {
  const a = st._newArea, bbox = st._areaBbox; if (!bbox) return;
  const name = a.name.trim() || `Area near ${((bbox[1] + bbox[3]) / 2).toFixed(3)}, ${((bbox[0] + bbox[2]) / 2).toFixed(3)}`;
  $('#naProg').hidden = false; $('#naGo').disabled = true; $('#naDraw').disabled = true;
  dlCtrl = new AbortController(); $('#naCancel').onclick = () => dlCtrl.abort();
  keepAwake(true);
  try {
    const rec = await downloadArea({ id: uid('a'), name, bbox, minZ: 10, maxZ: a.detail, layers: { vector: true, dem: true, topo: a.topo, sat: a.sat } }, p => {
      const bar = $('#naBar'); if (!bar) return; bar.style.width = (p.done / p.total * 100).toFixed(1) + '%';
      $('#naStatus').textContent = `${p.stage}: ${p.done.toLocaleString()} / ${p.total.toLocaleString()} · ${G.fmtBytes(p.bytes)}`;
    }, dlCtrl.signal);
    await loadAll(); st._newArea = null; st._areaInit = false;
    toast(`Saved “${rec.name}” · ${G.fmtBytes(rec.bytes)}${rec.hasData ? '' : ' (trail data unavailable — tap Update trails later)'}`, 4000);
    st.viewStack = []; show('offline', {}, false);
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Download cancelled' : (e.message || 'Download failed'));
    if ($('#naProg')) { $('#naProg').hidden = true; $('#naGo').disabled = false; $('#naDraw').disabled = false; }
  }
  if (!st.rec && !st.nav) keepAwake(false);
}

// ---------------- layers ----------------
function layersSheet() {
  const bases = [['trail', 'Lodestar', 'Trails, roads & terrain · offline'], ['topo', 'USGS Topo', 'Contours & public land · offline'], ['sat', 'Satellite', 'USGS imagery · offline'], ['sathyb', 'Satellite + labels', 'USGS imagery & topo · online cache'], ['otm', 'OpenTopoMap', 'Topo · online only']];
  modal(`<h2>Map style</h2><div class="list">${bases.map(([k, n, d]) => `<button class="card${S.base === k ? '' : ''}" data-base="${k}" style="${S.base === k ? 'outline:2px solid var(--accent)' : ''}"><div class="thumb">${{ trail: '🧭', topo: '⛰️', sat: '🛰️', sathyb: '🛰️', otm: '🗻' }[k]}</div><div class="body"><div class="title">${n}</div><div class="meta">${d}</div></div>${S.base === k ? '✓' : ''}</button>`).join('')}</div>
   <h3>Overlays</h3><div class="group"><div><label>Points of interest</label><label class="switch"><input type="checkbox" id="lyPoi" ${S.showPois ? 'checked' : ''}><i></i></label></div><div><label>Offline area outlines</label><label class="switch"><input type="checkbox" id="lyAreas" ${S.showAreas ? 'checked' : ''}><i></i></label></div></div>
   <button class="btn block" style="margin-top:12px" data-x>Done</button>`, (m, close) => {
    $$('[data-base]', m).forEach(b => b.onclick = () => { setBase(b.dataset.base); close(); if (b.dataset.base === 'otm' && !navigator.onLine) toast('OpenTopoMap needs a connection'); });
    m.querySelector('#lyPoi').onchange = e => { S.showPois = e.target.checked; saveSettings(); refreshOverlays(); };
    m.querySelector('#lyAreas').onchange = e => { S.showAreas = e.target.checked; saveSettings(); refreshOverlays(); };
    m.querySelector('[data-x]').onclick = close;
  });
}


function recoveryMarkup(code, heading = 'Your recovery code') {
  return `<h2 class="recov-h">${esc(heading)}</h2>
    <p class="recov-lead">Lodestar can't email a reset. This code is the only way to recover your account if you forget your password. We'll only show it once — save it in a safe place now.</p>
    <div class="recov-code" id="recovCode">${esc(code)}</div>
    <button type="button" class="btn recov-copy" id="recovCopy">Copy</button>
    <label class="recov-save"><input type="checkbox" id="recovSaved"> I've saved this code in a safe place</label>
    <button type="button" class="auth-btn recov-go" id="recovGo" disabled>Continue</button>`;
}
function wireRecovery(root, code, onDone) {
  const go = root.querySelector('#recovGo'), saved = root.querySelector('#recovSaved');
  saved.onchange = () => { go.disabled = !saved.checked; };
  root.querySelector('#recovCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(code); }
    catch { const t = document.createElement('textarea'); t.value = code; t.style.position = 'fixed'; t.style.left = '-9999px'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } finally { t.remove(); } }
    root.querySelector('#recovCopy').textContent = 'Copied';
    toast('Recovery code copied');
  };
  go.onclick = () => onDone();
}
function presentRecovery(host, code, heading) {
  return new Promise(resolve => {
    const inner = host.querySelector('.auth-inner') || host;
    inner.innerHTML = `<img src="icons/icon-192.png" alt="" class="auth-logo" width="76" height="76">
      <h1>Lodestar</h1>${recoveryMarkup(code, heading)}`;
    wireRecovery(inner, code, resolve);
  });
}
function showRecoveryModal(code, heading) {
  return new Promise(resolve => {
    modal(`<div class="recov-modal">${recoveryMarkup(code, heading)}</div>`, (m, close) => {
      wireRecovery(m, code, () => { close(); resolve(); });
    }, { sticky: true });
  });
}
function generateRecoveryBox() {
  modal(`<h2>Generate a new recovery code</h2><p class="sub">This replaces any code you already have. Enter your current password, then save the new code — we'll only show it once.</p>
    <div class="group form"><div><label for="rcPw">Password</label><input class="input" id="rcPw" type="password" autocomplete="current-password" maxlength="128"></div></div>
    <p class="err-line" id="rcErr" hidden></p>
    <button type="button" class="btn primary block" id="rcGo" style="margin-top:12px">Generate code</button><button type="button" class="btn block" style="margin-top:8px" data-x>Cancel</button>`, (m, close) => {
    m.querySelector('[data-x]').onclick = close;
    m.querySelector('#rcGo').onclick = async () => {
      const er = m.querySelector('#rcErr'), btn = m.querySelector('#rcGo'), pw = m.querySelector('#rcPw').value;
      if (!navigator.onLine) { er.textContent = 'You need a connection to generate a recovery code.'; er.hidden = false; return; }
      btn.disabled = true;
      try {
        const code = await generateRecovery(pw);
        m.innerHTML = `<div class="recov-modal">${recoveryMarkup(code, 'Your new recovery code')}</div>`;
        wireRecovery(m, code, () => { close(); if (st.view?.name === 'more') renderMore(); });
      } catch (e) { er.textContent = e.message; er.hidden = false; btn.disabled = false; }
    };
  }, { sticky: true });
}

// ---------------- account gate ----------------
const AUTH_BG = `<svg class="auth-mtn" viewBox="0 0 400 160" preserveAspectRatio="none" aria-hidden="true"><path d="M0 160V96l52-40 38 28 62-62 54 52 40-30 70 58 44-30 40 26v62Z" fill="#1E3A66"/><path d="M0 160v-34l70-34 48 26 74-48 66 52 52-26 90 40v24Z" fill="#2A4A7A"/></svg>`;
// Shows the full-screen sign-in / create-account page. Resolves with the user once signed in.
function authGate(expired = false) {
  return new Promise(resolve => {
    $('#auth')?.remove();
    const el = document.createElement('div'); el.id = 'auth'; el.className = 'auth'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Sign in to Lodestar');
    let mode = 'signin';
    el.innerHTML = `${AUTH_BG}<div class="auth-inner">
      <img src="icons/icon-192.png" alt="" class="auth-logo" width="76" height="76">
      <h1>Lodestar</h1><p class="auth-tag">Off-grid trail maps for hikes and drives</p>
      ${expired ? '<p class="auth-note warn">Your session ended. Sign in again to keep syncing.</p>' : ''}
      <div class="auth-seg" role="tablist"><button type="button" data-am="signin" class="on">Sign In</button><button type="button" data-am="signup">Create Account</button><i></i></div>
      <form class="auth-card" id="authForm" novalidate>
        <label class="af af-name" hidden><span>Name <em>optional</em></span><input id="aName" type="text" autocomplete="name" maxlength="60" placeholder="What should we call you?"></label>
        <label class="af"><span>Email</span><input id="aEmail" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" required maxlength="254" placeholder="you@example.com"></label>
        <label class="af af-code" hidden><span>Recovery code</span><input id="aCode" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="XXXXX-XXXXX-XXXXX-XXXXX"></label>
        <label class="af af-pass"><span id="aPassLbl">Password</span><div class="pw"><input id="aPass" type="password" autocomplete="current-password" required minlength="8" maxlength="128" placeholder="Required"><button type="button" class="pw-eye" id="aEye" aria-label="Show password">Show</button></div></label>
        <p class="af-hint" id="aHint" hidden>At least 8 characters.</p>
        <p class="auth-err" id="aErr" role="alert" hidden></p>
        <button class="auth-btn" id="aGo" type="submit">Sign In</button>
      </form>
      <button type="button" class="auth-link" id="aForgot">Forgot password?</button>
      <button type="button" class="auth-link" id="aBack" hidden>← Back to Sign In</button>
      <p class="auth-foot" id="aFoot">Your favorites, tracks, waypoints, routes and vehicle sync privately to your account. No ads, no tracking. After you create an account you'll get a recovery code — Lodestar can't email a reset.</p>
      <p class="auth-foot small" id="aOff" ${navigator.onLine ? 'hidden' : ''}>You're offline. Connect once to sign in — after that Lodestar works with no signal.</p>
    </div>`;
    document.body.appendChild(el);
    document.body.classList.add('locked');
    const setMode = m => {
      mode = m; const up = m === 'signup', rec = m === 'recover';
      $$('[data-am]', el).forEach(b => b.classList.toggle('on', b.dataset.am === m));
      el.querySelector('.auth-seg').classList.toggle('right', up);
      el.querySelector('.auth-seg').hidden = rec;
      el.querySelector('.af-name').hidden = !up;
      el.querySelector('.af-code').hidden = !rec;
      $('#aHint').hidden = !(up || rec); $('#aErr').hidden = true;
      $('#aForgot').hidden = m !== 'signin'; $('#aBack').hidden = !rec;
      $('#aPassLbl').textContent = rec ? 'New password' : 'Password';
      $('#aPass').autocomplete = (up || rec) ? 'new-password' : 'current-password';
      $('#aPass').placeholder = rec ? 'Choose a new password' : up ? 'Create a password' : 'Required';
      $('#aGo').textContent = rec ? 'Reset password' : up ? 'Create Account' : 'Sign In';
      $('#aFoot').textContent = rec
        ? "Enter the recovery code you saved when you created your account (or generated in Profile). You'll get a new code after the reset — the old one will no longer work."
        : "Your favorites, tracks, waypoints, routes and vehicle sync privately to your account. No ads, no tracking. After you create an account you'll get a recovery code — Lodestar can't email a reset.";
    };
    el._setMode = setMode;
    $$('[data-am]', el).forEach(b => b.onclick = () => setMode(b.dataset.am));
    $('#aForgot').onclick = () => setMode('recover');
    $('#aBack').onclick = () => setMode('signin');
    $('#aEye').onclick = () => { const i = $('#aPass'), show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('#aEye').textContent = show ? 'Hide' : 'Show'; $('#aEye').setAttribute('aria-label', show ? 'Hide password' : 'Show password'); };
    const onNet = () => { const o = $('#aOff'); if (o) o.hidden = navigator.onLine; };
    addEventListener('online', onNet); addEventListener('offline', onNet);
    const finishAuth = async (u, recoveryCode, welcome) => {
      $('#aPass').value = ''; if ($('#aCode')) $('#aCode').value = '';
      if (recoveryCode) await presentRecovery(el, recoveryCode);
      removeEventListener('online', onNet); removeEventListener('offline', onNet);
      el.classList.add('leaving'); document.body.classList.remove('locked');
      setTimeout(() => el.remove(), 350);
      toast(welcome);
      resolve(u);
    };
    $('#authForm').onsubmit = async e => {
      e.preventDefault();
      const err = $('#aErr'), go = $('#aGo'), email = $('#aEmail').value.trim(), pw = $('#aPass').value, name = $('#aName').value.trim(), code = $('#aCode').value.trim();
      const fail = m => { err.textContent = m; err.hidden = false; };
      err.hidden = true;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
      if (mode === 'recover') {
        if (!code) return fail('Enter your recovery code.');
        if (pw.length < 8) return fail('Use at least 8 characters for your new password.');
      } else if (pw.length < 8) return fail(mode === 'signup' ? 'Use at least 8 characters for your password.' : 'Enter your password.');
      if (!navigator.onLine) return fail(mode === 'recover' ? 'You need a connection to reset your password.' : 'You need a connection to sign in the first time.');
      go.disabled = true; go.textContent = mode === 'signup' ? 'Creating account…' : mode === 'recover' ? 'Resetting…' : 'Signing in…';
      try {
        if (mode === 'signup') {
          const { user: u, recoveryCode } = await signUp(email, pw, name);
          await finishAuth(u, recoveryCode, `Welcome to Lodestar${u.name ? ', ' + u.name : ''}`);
        } else if (mode === 'recover') {
          const { user: u, recoveryCode } = await recoverPassword(email, code, pw);
          await finishAuth(u, recoveryCode, 'Password reset. Save your new recovery code.');
        } else {
          const u = await signIn(email, pw);
          await finishAuth(u, null, `Signed in as ${u.name || u.email}`);
        }
      } catch (x) {
        fail(x.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : x.message || 'Something went wrong. Try again.');
        go.disabled = false; go.textContent = mode === 'signup' ? 'Create Account' : mode === 'recover' ? 'Reset password' : 'Sign In';
      }
    };
    setTimeout(() => $('#aEmail')?.focus({ preventScroll: true }), 300);
  });
}
async function reauth(prevId) {
  const u = await authGate(true);
  if (prevId && u.id !== prevId) return location.reload();
  await reloadUserData(); syncNow();
}

// ---------------- vehicle ----------------
const vehicleName = v => v ? [v.year, v.make, v.model].filter(Boolean).join(' ') || v.nickname || 'My vehicle' : '';
const vehicleTags = v => v ? [v.fourwd && '4WD', v.awd && 'AWD', v.clearance && 'High clearance'].filter(Boolean) : [];
// Routes marked 4WD need 4WD; hard offroad routes need 4WD or high clearance.
function fitsVehicle(t) { const v = st.vehicle; if (!v) return true; if (t.fourwd && !v.fourwd) return false; if (t.diffOff >= 2 && !v.fourwd && !v.clearance) return false; return true; }
function updateVehiclePill() {
  const p = $('#vehiclePill'); if (!p) return;
  p.hidden = S.mode !== 'drive';
  const v = st.vehicle;
  p.innerHTML = v ? `<small>Driving</small><b>${esc(vehicleName(v))}</b>` : `<small>Drive mode</small><b>Add your vehicle</b>`;
  p.setAttribute('aria-label', v ? `Driving: ${vehicleName(v)}. Edit vehicle` : 'Add your vehicle');
}
function editVehicle() {
  const v = st.vehicle || {}, yr = new Date().getFullYear() + 1;
  modal(`<h2>My Vehicle</h2><p class="sub">Shown in Drive mode and used to flag routes that need 4WD or high clearance. Synced to your account.</p>
    <div class="group form">
      <div><label for="vYear">Year</label><input class="input" id="vYear" type="number" inputmode="numeric" min="1950" max="${yr}" placeholder="2021" value="${esc(v.year || '')}"></div>
      <div><label for="vMake">Make</label><input class="input" id="vMake" maxlength="40" placeholder="e.g. Toyota" value="${esc(v.make || '')}"></div>
      <div><label for="vModel">Model</label><input class="input" id="vModel" maxlength="40" placeholder="e.g. 4Runner" value="${esc(v.model || '')}"></div>
      <div><label for="vNick">Nickname <em class="muted">optional</em></label><input class="input" id="vNick" maxlength="40" placeholder="e.g. The Black Rig" value="${esc(v.nickname || '')}"></div>
    </div>
    <h3>Capability</h3><div class="group">
      <div><label>4WD (low range)</label><label class="switch"><input type="checkbox" id="v4" ${v.fourwd ? 'checked' : ''}><i></i></label></div>
      <div><label>AWD</label><label class="switch"><input type="checkbox" id="vA" ${v.awd ? 'checked' : ''}><i></i></label></div>
      <div><label>High clearance</label><label class="switch"><input type="checkbox" id="vC" ${v.clearance ? 'checked' : ''}><i></i></label></div>
    </div>
    <p class="err-line" id="vErr" hidden></p>
    <button class="btn primary block" id="vSave" style="margin-top:12px">Save vehicle</button>
    ${st.vehicle ? '<button class="btn danger block" id="vDel" style="margin-top:8px">Remove vehicle</button>' : ''}
    <button class="btn block" style="margin-top:8px" data-x>Cancel</button>`, (m, close) => {
    m.querySelector('[data-x]').onclick = close;
    m.querySelector('#vSave').onclick = async () => {
      const year = m.querySelector('#vYear').value.trim(), make = m.querySelector('#vMake').value.trim(), model = m.querySelector('#vModel').value.trim(), nickname = m.querySelector('#vNick').value.trim();
      const er = m.querySelector('#vErr');
      if (year && !(+year >= 1950 && +year <= yr)) { er.textContent = `Year should be between 1950 and ${yr}.`; er.hidden = false; return; }
      if (!make && !model && !nickname) { er.textContent = 'Add at least a make and model (or a nickname).'; er.hidden = false; return; }
      const veh = { id: 'vehicle', year: year ? +year : null, make, model, nickname, fourwd: m.querySelector('#v4').checked, awd: m.querySelector('#vA').checked, clearance: m.querySelector('#vC').checked };
      await db.put('profile', veh); st.vehicle = veh; close(); updateVehiclePill();
      if (st.view && ['explore', 'more', 'trail'].includes(st.view.name)) VIEWS[st.view.name](st.view.args);
      toast('Vehicle saved');
    };
    const d = m.querySelector('#vDel'); if (d) d.onclick = async () => { await db.del('profile', 'vehicle'); st.vehicle = null; st.filters.fits = false; close(); updateVehiclePill(); if (st.view && ['explore', 'more', 'trail'].includes(st.view.name)) VIEWS[st.view.name](st.view.args); toast('Vehicle removed'); };
  });
}

// ---------------- profile / settings ----------------
function syncLine() {
  if (acct.syncing) return '<span class="sync-dot spin"></span>Syncing…';
  if (acct.error) return `<span class="sync-dot bad"></span>${esc(acct.error)}`;
  if (!navigator.onLine) return `<span class="sync-dot off"></span>Offline${acct.pending ? ` · ${acct.pending} change${acct.pending > 1 ? 's' : ''} waiting` : ' · saved on this device'}`;
  if (acct.pending) return `<span class="sync-dot off"></span>${acct.pending} change${acct.pending > 1 ? 's' : ''} waiting to sync`;
  return `<span class="sync-dot ok"></span>${acct.lastSync ? 'Synced ' + ago(acct.lastSync) : 'Ready to sync'}`;
}
function ago(t) { const s = (Date.now() - t) / 1000; return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); }
function updateSyncUI() { const e = $('#syncLine'); if (e) e.innerHTML = syncLine(); }
function renderMore() {
  const themeI = ['auto', 'light', 'dark'].indexOf(S.theme), u = acct.user || {}, v = st.vehicle;
  const initial = esc((u.name || u.email || '?').trim()[0].toUpperCase());
  pendingCount().then(updateSyncUI);
  paint(`${hdr('Profile')}
    <div class="acct-card">
      <div class="avatar">${initial}</div>
      <div class="acct-id"><div class="acct-name">${esc(u.name || 'Lodestar explorer')}</div><div class="acct-mail">${esc(u.email || '')}</div><div class="acct-sync" id="syncLine">${syncLine()}</div></div>
      <button class="btn" id="pSync" style="height:34px;font-size:13.5px;padding:0 12px">Sync now</button>
    </div>
    <h3>My Vehicle</h3><div class="group">
      <button id="pVeh" class="veh-row"><span class="veh-ico">🚙</span><span class="veh-txt">${v ? `<b>${esc(vehicleName(v))}</b><small>${esc([v.nickname && v.nickname !== vehicleName(v) ? '“' + v.nickname + '”' : '', ...vehicleTags(v)].filter(Boolean).join(' · ') || 'Tap to add capability')}</small>` : '<b>Add your vehicle</b><small>Year, make, model · 4WD / AWD / clearance</small>'}</span>${ICON.chev}</button>
    </div>
    <h3>Account</h3><div class="group">
      <button id="pName"><label>Name</label><span class="muted">${esc(u.name || 'Add')}</span>${ICON.chev}</button>
      <button id="pPass"><label>Change password</label>${ICON.chev}</button>
      <button id="pRecovery"><label>${u.hasRecovery ? 'Generate new recovery code' : 'Generate recovery code'}</label>${ICON.chev}</button>
      <button id="pOut"><label class="red">Sign out</label></button>
    </div>
    <h3>Settings</h3>
    <div class="group">
      <div><label>Appearance</label><div class="seg seg3 small" style="--n:3;--i:${themeI};width:190px"><button data-th="auto" class="${S.theme === 'auto' ? 'on' : ''}">Auto</button><button data-th="light" class="${S.theme === 'light' ? 'on' : ''}">Light</button><button data-th="dark" class="${S.theme === 'dark' ? 'on' : ''}">Dark</button><i class="seg-thumb"></i></div></div>
      <div><label>Units</label><div class="seg seg3 small" style="--n:2;--i:${S.imperial ? 0 : 1};width:190px"><button data-units="1" class="${S.imperial ? 'on' : ''}">mi / ft</button><button data-units="0" class="${!S.imperial ? 'on' : ''}">km / m</button><i class="seg-thumb"></i></div></div>
      <div><label>Voice cues</label><label class="switch"><input type="checkbox" id="mVoice" ${S.voice ? 'checked' : ''}><i></i></label></div>
      <div><label>Keep screen awake while recording</label><label class="switch"><input type="checkbox" id="mWake" ${S.wake ? 'checked' : ''}><i></i></label></div>
      <div><label>Off-route alert distance</label><select class="input" id="mOff" style="width:120px;padding:8px 10px">${[30, 45, 75, 120].map(x => `<option value="${x}" ${S.offRoute === x ? 'selected' : ''}>${G.fmtShortDist(x)}</option>`).join('')}</select></div>
    </div>
    <h3>App</h3><div class="group">
      <button id="mInstall"><label>Install on iPhone / Home Screen</label>${ICON.chev}</button>
      <button id="mExport"><label>Export everything (GPX)</label>${ICON.chev}</button>
      <button id="mBackup"><label>Backup data (JSON)</label>${ICON.chev}</button>
      <button id="mRestore"><label>Restore backup</label>${ICON.chev}</button>
      <button id="mUpdate"><label>Check for app update</label>${ICON.chev}</button>
    </div>
    <h3>Privacy</h3><div class="note">Your favorites, tracks, waypoints, planned routes, notes and vehicle are private to your account — nobody else can see or change them. They're cached on this device so Lodestar works with no signal, and erased from the device when you sign out. Photos stay on this device only. No ads, no analytics, no tracking. Map tiles, trail data (OpenStreetMap/Overpass), terrain and place search (Nominatim) come from free public services that never receive your recordings.</div>
    <h3>Map data & credits</h3><p class="muted">Trail & map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL). Vector tiles by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> / OpenMapTiles. Topo & satellite: USGS The National Map (public domain). Terrain: AWS Terrain Tiles (Mapzen; USGS, NASA SRTM and others). OpenTopoMap (CC-BY-SA, online only). Place search: Nominatim. Map engine: MapLibre GL JS.</p>
    <p class="muted">Lodestar is not affiliated with AllTrails or onX. Always carry a backup map, check closures & land ownership, and stay on legal routes.</p>
    <button class="btn block" id="mClear" style="margin-top:8px">Delete offline maps from this device</button>
    <button class="btn danger block" id="pDelete" style="margin-top:8px">Delete account</button>
    <p class="muted" style="text-align:center;margin-top:14px">✦ Lodestar v1.1</p>
    <input type="file" id="fileBackup" accept="application/json,.json" hidden>`);
  $('#pSync').onclick = async () => { if (!navigator.onLine) return toast('You\'re offline — changes will sync when you reconnect'); await syncNow(); toast(acct.error || 'Up to date'); };
  $('#pVeh').onclick = () => editVehicle();
  $('#pName').onclick = async () => { const n = await promptBox('Your name', u.name || '', 'Name (optional)'); if (n == null) return; try { await updateName(n.trim()); renderMore(); toast('Name updated'); } catch (e) { toast(e.message); } };
  $('#pPass').onclick = changePasswordBox;
  $('#pRecovery').onclick = generateRecoveryBox;
  $('#pOut').onclick = async () => {
    if (!(await confirmBox('Sign out?', `Your data stays safe in your account. Lodestar will erase it — and offline maps — from this device.${acct.pending ? ` ${acct.pending} unsynced change${acct.pending > 1 ? 's' : ''} will be lost if you're offline.` : ''}`, 'Sign Out', true))) return;
    if (st.rec) { toast('Stop recording before signing out'); return; }
    await signOut(); location.reload();
  };
  $('#pDelete').onclick = deleteAccountBox;
  $$("[data-th]").forEach(b => b.onclick = () => { S.theme = b.dataset.th; saveSettings(); restyle(); renderMore(); });
  $$('[data-units]').forEach(b => b.onclick = () => { S.imperial = b.dataset.units === '1'; G.units.imperial = S.imperial; saveSettings(); renderMore(); toast('Units updated'); });
  $('#mVoice').onchange = e => { S.voice = e.target.checked; saveSettings(); };
  $('#mWake').onchange = e => { S.wake = e.target.checked; saveSettings(); };
  $('#mOff').onchange = e => { S.offRoute = +e.target.value; saveSettings(); };
  $('#mInstall').onclick = installHelp;
  $('#mExport').onclick = async () => { const [tracks, routes] = await Promise.all([db.all('tracks'), db.all('routes')]); shareFiles([new File([G.toGPX({ name: 'Lodestar export', tracks, routes, waypoints: st.waypoints || [] })], 'lodestar-export.gpx', { type: 'application/gpx+xml' })], 'Lodestar export'); };
  $('#mBackup').onclick = async () => { const out = { app: 'lodestar', v: 1, at: new Date().toISOString() }; for (const s of ['tracks', 'waypoints', 'routes', 'favorites', 'notes']) out[s] = await db.all(s); out.settings = S; shareFiles([new File([JSON.stringify(out)], `lodestar-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' })], 'Lodestar backup'); };
  $('#mRestore').onclick = () => $('#fileBackup').click();
  $('#fileBackup').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); if (d.app !== 'lodestar') throw 0; for (const s of ['tracks', 'waypoints', 'routes', 'favorites', 'notes']) for (const v of d[s] || []) await db.put(s, v); await loadAll(); toast('Backup restored'); } catch { toast('That isn\'t a Lodestar backup'); } };
  $('#mUpdate').onclick = async () => { if (!st.swReg) return toast('Offline support not active'); await st.swReg.update(); toast('Checking… reload the app to use the latest version'); };
  $('#mClear').onclick = async () => {
    if (!(await confirmBox('Delete offline maps?', 'Removes saved map areas and cached tiles from this device. Your account data is not affected.', 'Delete', true))) return;
    for (const a of await db.all('areas')) await deleteArea(a.id).catch(() => { });
    await db.clear('areas'); await db.clear('areaData');
    for (const k of await caches.keys()) if (!k.startsWith('ls-shell')) await caches.delete(k);
    st.areas = []; rebuildData([]); refreshOverlays(); toast('Offline maps deleted');
  };
}
function changePasswordBox() {
  modal(`<h2>Change password</h2><p class="sub">You'll stay signed in here; other devices will be signed out.</p>
    <div class="group form">
      <div><label for="cpOld">Current</label><input class="input" id="cpOld" type="password" autocomplete="current-password" maxlength="128"></div>
      <div><label for="cpNew">New</label><input class="input" id="cpNew" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="8+ characters"></div>
    </div><p class="err-line" id="cpErr" hidden></p>
    <button class="btn primary block" id="cpGo" style="margin-top:12px">Update password</button><button class="btn block" style="margin-top:8px" data-x>Cancel</button>`, (m, close) => {
    m.querySelector('[data-x]').onclick = close;
    m.querySelector('#cpGo').onclick = async () => {
      const o = m.querySelector('#cpOld').value, n = m.querySelector('#cpNew').value, er = m.querySelector('#cpErr');
      if (n.length < 8) { er.textContent = 'New password needs at least 8 characters.'; er.hidden = false; return; }
      if (!navigator.onLine) { er.textContent = 'You need a connection to change your password.'; er.hidden = false; return; }
      try { await changePassword(o, n); close(); toast('Password updated'); } catch (e) { er.textContent = e.message; er.hidden = false; }
    };
  });
}
function deleteAccountBox() {
  modal(`<h2>Delete account?</h2><p class="sub">This permanently deletes your Lodestar account and everything synced to it — favorites, tracks, waypoints, routes, notes and vehicle — and erases this device's copy. This can't be undone.</p>
    <div class="group form"><div><label for="daPw">Password</label><input class="input" id="daPw" type="password" autocomplete="current-password" maxlength="128"></div></div>
    <p class="err-line" id="daErr" hidden></p>
    <button class="btn danger block" id="daGo" style="margin-top:12px">Delete account permanently</button><button class="btn block" style="margin-top:8px" data-x>Cancel</button>`, (m, close) => {
    m.querySelector('[data-x]').onclick = close;
    m.querySelector('#daGo').onclick = async () => {
      const er = m.querySelector('#daErr');
      if (!navigator.onLine) { er.textContent = 'You need a connection to delete your account.'; er.hidden = false; return; }
      try { await deleteAccount(m.querySelector('#daPw').value); location.reload(); } catch (e) { er.textContent = e.message; er.hidden = false; }
    };
  });
}

const VIEWS = { explore: renderExplore, trail: renderTrail, record: renderRecord, saved: renderSaved, activity: renderActivity, route: renderRoute, waypoint: renderWaypoint, plan: renderPlan, offline: renderOffline, newArea: renderNewArea, more: renderMore, nav: renderNav };
window.addEventListener('error', e => console.error('Lodestar error:', e.message));
boot();
// expose for debugging/tests
window.__lodestar = { st, S, acct, get map() { return map; }, get sheet() { return sheet; }, db, G };
