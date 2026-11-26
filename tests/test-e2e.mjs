import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
const URL = process.env.URL || 'http://localhost:8765/';
const PROFILE = process.env.PROFILE || '/tmp/ls-profile';
const SHOTS = '/workspace/lodestar-shots/';
const phase = process.argv[2] || 'online';
const args = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
if (phase === 'offline') args.push('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost');
const ctx = await chromium.launchPersistentContext(PROFILE, { executablePath: '/usr/bin/google-chrome', args, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, geolocation: { latitude: 45.3805, longitude: -94.7114 }, permissions: ['geolocation'], isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
const p = ctx.pages()[0] || await ctx.newPage();
const errs = [];
p.on('pageerror', e => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('[console]', m.text().slice(0, 200)); });
const L = (...a) => console.log(...a);
const wait = ms => p.waitForTimeout(ms);
const ev = (f, a) => p.evaluate(f, a);
async function planAndFollow() {
  // Plan a route (snaps to trails) and follow it
  if (await ev(() => window.__lodestar.st.data.trails.size)) {
    await p.click('[data-tab="explore"]'); await wait(300);
    const t = await ev(() => { const t = [...window.__lodestar.st.data.trails.values()].sort((a, b) => b.len - a.len)[0]; return { a: t.chain[0], b: t.chain[Math.floor(t.chain.length / 2)] }; });
    for (let k = 0; k < 3 && await ev(() => window.__lodestar.st.locate); k++) { await ev(() => window.__lodestar.sheet.set('peek')); await wait(300); await p.click('#btnLocate'); await wait(300); }
    await p.click('[data-tab="saved"]'); await wait(300); await p.click('[data-sv="routes"]'); await wait(300); await p.click('#svPlan'); await wait(500);
    await ev(() => window.__lodestar.sheet.set('peek')); await wait(400);
    for (const c of [t.a, t.b]) { await ev(c => window.__lodestar.map.jumpTo({ center: c, zoom: 15 }), c); await wait(400); L('elAt', await ev(() => { const e = document.elementFromPoint(195, 422); return e.tagName + '.' + e.className + ' plan=' + !!window.__lodestar.st.plan + ' view=' + window.__lodestar.st.view.name; })); await p.mouse.click(195, 422); await wait(600); }
    await ev(() => window.__lodestar.sheet.set('half')); await wait(500);
    L('pts:', JSON.stringify(await ev(() => window.__lodestar.st.plan?.pts)), JSON.stringify(t), await ev(() => window.__lodestar.st.locate));
    L('plan:', await ev(() => document.querySelector('.stat b')?.textContent), await ev(() => window.__lodestar.st.plan?.legs?.[0]?.length));
    await p.screenshot({ path: SHOTS + '15-plan.png' });
    await p.click('#plGo'); await wait(2500);
    L('nav banner:', await ev(() => !document.querySelector('#navBanner').hidden && document.querySelector('#navBanner').innerText.replace(/\n/g, ' ')));
    await p.screenshot({ path: SHOTS + '16-nav.png' });
    await p.click('#nvEnd'); await wait(500); await p.click('[data-x]').catch(() => {}); await wait(500);
  }
}
if (phase === 'online') {
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForFunction(() => navigator.serviceWorker?.controller || window.__swr, null, { timeout: 30000 }).catch(() => {});
  const sw = await ev(async () => { const r = await navigator.serviceWorker.getRegistration(); return { registered: !!r, active: !!r?.active, state: r?.active?.state, controlled: !!navigator.serviceWorker.controller }; });
  L('SW:', JSON.stringify(sw));
  await p.waitForFunction(() => window.__lodestar.st.data.trails.size > 0, null, { timeout: 150000 }).catch(() => L('no trails loaded (overpass?)'));
  L('trails loaded:', await ev(() => window.__lodestar.st.data.trails.size));
  await p.click('#grab'); await wait(800);
  await p.screenshot({ path: SHOTS + '02-explore-half.png' });
  const first = await p.$('[data-trail]');
  if (first) { await first.click(); await wait(5000); await p.screenshot({ path: SHOTS + '03-trail-detail.png' }); await p.click('#grab'); await wait(600); await p.evaluate(() => document.querySelector('#sheetBody').scrollTop = 500); await wait(300); await p.screenshot({ path: SHOTS + '04-trail-detail-full.png' }); }
  // GX mode
  await p.click('[data-tab="explore"]'); await wait(300);
  await p.click('#modeSeg [data-mode="gx"]'); await wait(2500);
  await p.screenshot({ path: SHOTS + '05-gx-mode.png' });
  // dark mode check quickly via settings
  await p.click('[data-tab="more"]'); await wait(500); await p.screenshot({ path: SHOTS + '06-more.png' });
  await p.click('[data-th="dark"]'); await wait(3500); await p.click('[data-tab="explore"]'); await wait(1500); await p.screenshot({ path: SHOTS + '07-dark-gx.png' });
  await p.click('[data-tab="more"]'); await wait(300); await p.click('[data-th="auto"]'); await wait(2500);
  await p.click('#modeSeg [data-mode="hike"]'); await wait(800);
  // Record tab
  await p.click('[data-tab="record"]'); await wait(500); await p.screenshot({ path: SHOTS + '08-record.png' });
  await p.click('#rStart'); await wait(3000); await p.screenshot({ path: SHOTS + '09-recording.png' });
  await p.click('#rStop'); await wait(500); await p.click('#aDiscard').catch(() => {}); await wait(400); await p.click('[data-ok]').catch(() => {}); await wait(400);
  // Waypoint
  await ev(() => window.__lodestar.sheet.set('peek')); await wait(500);
  await p.click('#btnWaypoint'); await wait(400); await p.click('[data-ic="camp"]'); await p.fill('#wName', 'Test camp'); await p.click('#wSave'); await wait(600);
  L('waypoints:', await ev(() => window.__lodestar.st.waypoints.length));
  await planAndFollow();
  // Offline: save a small area near Paynesville
  await ev(() => window.__lodestar.map.jumpTo({ center: [-94.7114, 45.3805], zoom: 12.4 })); await ev(() => document.querySelector('#btnLocate').classList.contains('on') && document.querySelector('#btnLocate').click()); await wait(300); await ev(() => window.__lodestar.map.jumpTo({ center: [-94.7114, 45.3705], zoom: 12.4 }));
  await wait(1500);
  await p.click('[data-tab="offline"]'); await wait(500);
  await p.click('#ofNew'); await wait(1500);
  await p.fill('#naName', 'Paynesville test'); await p.click('label.switch:has(#naTopo)'); await wait(300);
  await p.screenshot({ path: SHOTS + '10-new-area.png' });
  L('estimate:', await ev(() => [document.querySelector('#naTiles').textContent, document.querySelector('#naSize').textContent, JSON.stringify(window.__lodestar.st._areaBbox)]));
  await p.click('#naGo');
  await p.waitForFunction(() => window.__lodestar.st.view?.name === 'offline', null, { timeout: 240000 });
  await wait(800);
  await p.screenshot({ path: SHOTS + '11-offline-list.png' });
  const area = await ev(async () => { const a = (await window.__lodestar.db.all('areas'))[0]; const d = await window.__lodestar.db.get('areaData', a.id); return { name: a.name, tiles: a.tiles, failed: a.failed, bytes: a.bytes, hasData: a.hasData, trails: d?.trails?.length, ways: d?.ways?.length, bbox: a.bbox }; });
  L('area:', JSON.stringify(area));
  const cacheCount = await ev(async () => (await (await caches.open('ls-tiles-v1')).keys()).length);
  L('tile cache entries:', cacheCount);
  await ev(() => window.__lodestar.db.kvSet('liveData', null)); // ensure offline trails come only from the saved area
} else {
  // OFFLINE: local server is stopped and all DNS blocked
  await ctx.setOffline(true);
  let ok = true;
  try { await p.goto(URL, { waitUntil: 'load', timeout: 30000 }); } catch (e) { ok = false; L('navigation failed:', e.message); }
  if (ok) {
    await wait(9000);
    const r = await ev(() => { const { map, st } = window.__lodestar; const feats = map.querySourceFeatures('ofm', { sourceLayer: 'transportation' }).length; const water = map.querySourceFeatures('ofm', { sourceLayer: 'water' }).length; return { online: navigator.onLine, controlled: !!navigator.serviceWorker.controller, tilesLoaded: map.areTilesLoaded(), roadFeatures: feats, waterFeatures: water, trails: st.data.trails.size, areas: st.areas.length, zoom: map.getZoom().toFixed(1), status: document.querySelector('#statusPill').textContent }; });
    L('OFFLINE:', JSON.stringify(r));
    await p.screenshot({ path: SHOTS + '12-offline-reload.png' });
    await p.click('#grab'); await wait(700); await p.screenshot({ path: SHOTS + '13-offline-trails.png' });
    const first = await p.$('[data-trail]'); if (first) { await first.click(); await wait(3500); await p.screenshot({ path: SHOTS + '14-offline-trail-detail.png' }); L('offline gain:', await ev(() => document.querySelector('#tGain')?.textContent)); }
    await planAndFollow();
  }
}
L('page errors:', errs.length);
await ctx.close();
