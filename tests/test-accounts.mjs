// Accounts E2E against the local dev server (tests/dev-server.mjs). Test password is random and never printed.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
const URL = process.env.URL || 'http://localhost:8788/';
const SHOTS = '/workspace/lodestar-shots/';
const PW = crypto.randomBytes(9).toString('base64url') + 'a1', PW2 = crypto.randomBytes(9).toString('base64url') + 'b2';
const EMAIL = `lodestar-e2e-${Date.now()}@example.com`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const opts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, geolocation: { latitude: 45.3805, longitude: -94.7114 }, permissions: ['geolocation'], isMobile: true, hasTouch: true, colorScheme: 'light', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const L = (...a) => console.log(...a);
let fails = 0; const ok = (c, m) => { L(c ? '✓' : '✗', m); if (!c) fails++; };
async function page(ctx, tag) {
  const p = await ctx.newPage();
  p.on('pageerror', e => L(`[${tag} pageerror]`, e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) L(`[${tag} console]`, m.text().slice(0, 200)); });
  return p;
}
const ev = (p, f, a) => p.evaluate(f, a);
const idbCount = (p, s) => ev(p, s => new Promise(r => { const q = indexedDB.open('lodestar'); q.onsuccess = () => { const db = q.result; if (!db.objectStoreNames.contains(s)) return r(-1); const t = db.transaction(s).objectStore(s).count(); t.onsuccess = () => r(t.result); }; q.onerror = () => r(-2); }), s);
try {
  // ---- Device A: first launch shows the auth page ----
  const A = await browser.newContext(opts); const pa = await page(A, 'A');
  await pa.goto(URL, { waitUntil: 'load' });
  await pa.waitForSelector('#auth .auth-inner'); await pa.waitForTimeout(900);
  ok(await pa.isVisible('#auth'), 'auth page shown on first launch');
  ok(!(await pa.isVisible('#tabbar')), 'app chrome hidden behind auth');
  await pa.screenshot({ path: SHOTS + 'auth-signin.png' });
  // sign-in error path
  await pa.fill('#aEmail', EMAIL); await pa.fill('#aPass', 'not-the-password');
  await pa.click('#aGo'); await pa.waitForSelector('#aErr:not([hidden])');
  ok(/incorrect/i.test(await pa.textContent('#aErr')), 'wrong login shows generic error');
  await pa.screenshot({ path: SHOTS + 'auth-signin-error.png' });
  // create account
  await pa.click('[data-am="signup"]'); await pa.waitForTimeout(400);
  await pa.fill('#aName', 'Nick'); await pa.fill('#aEmail', 'nick@example.com'); await pa.fill('#aPass', 'xxxxxxxxxxxx');
  await pa.screenshot({ path: SHOTS + 'auth-signup.png' });
  await pa.fill('#aEmail', EMAIL); await pa.fill('#aPass', PW);
  await pa.click('#aGo');
  await pa.waitForSelector('#auth', { state: 'detached', timeout: 20000 });
  ok(await pa.isVisible('#tabbar'), 'signed up → app unlocked');
  ok(await ev(pa, () => window.__lodestar.acct.user?.email) === EMAIL, 'acct.user set');
  await pa.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 }).catch(() => { });
  await pa.waitForSelector('#modal [data-x]', { timeout: 6000 }).then(() => pa.click('#modal [data-x]')).catch(() => { }); // iOS install hint
  // ---- Profile + My Vehicle ----
  await pa.click('[data-tab="more"]'); await pa.waitForTimeout(700);
  await ev(pa, () => window.__lodestar.sheet.set('full')); await pa.waitForTimeout(500);
  await pa.click('#pVeh'); await pa.waitForSelector('#vYear');
  await pa.fill('#vYear', '2021'); await pa.fill('#vMake', 'Lexus'); await pa.fill('#vModel', 'GX 460'); await pa.fill('#vNick', 'Black GX');
  await pa.click('label.switch:has(#v4)'); await pa.click('label.switch:has(#vC)');
  await pa.waitForTimeout(300);
  await pa.screenshot({ path: SHOTS + 'vehicle-editor.png' });
  await pa.click('#vSave'); await pa.waitForTimeout(800);
  await ev(pa, () => window.__lodestar.sheet.body.scrollTop = 0); await pa.waitForTimeout(2500);
  await pa.screenshot({ path: SHOTS + 'profile-vehicle.png' });
  ok(/2021 Lexus GX 460/.test(await pa.textContent('#pVeh')), 'vehicle shown in profile');
  // ---- Drive mode ----
  await pa.click('[data-tab="explore"]'); await pa.click('[data-mode="drive"]');
  await ev(pa, () => window.__lodestar.sheet.set('half'));
  ok(/Driving\s*2021 Lexus GX 460/.test((await pa.textContent('#vehiclePill')).trim()), 'Drive header pill shows vehicle');
  await pa.waitForFunction(() => window.__lodestar.st.data.trails.size > 0, null, { timeout: 60000 }).catch(() => L('(no trails loaded)'));
  await pa.waitForTimeout(3500);
  await pa.screenshot({ path: SHOTS + 'drive-mode.png' });
  ok(await pa.isVisible('[data-flag="fits"]'), '"Fits my vehicle" filter chip present');
  // favorite a trail (through the app's data layer, as the heart button does)
  const favId = await ev(pa, async () => { const L = window.__lodestar; const t = [...L.st.data.trails.values()][0] || { id: 'test-trail', name: 'Test Trail', len: 1000, center: [-94.7, 45.38] }; await L.db.put('favorites', { id: t.id, name: t.name, len: t.len, center: t.center || t.start, saved: Date.now() }); return t.id; });
  for (let i = 0; i < 40 && await idbCount(pa, 'outbox') !== 0; i++) await pa.waitForTimeout(500);
  ok(await idbCount(pa, 'outbox') === 0, 'favorite + vehicle pushed (outbox empty)');

  // ---- Device B: same account sees synced data ----
  const B = await browser.newContext(opts); const pb = await page(B, 'B');
  await pb.goto(URL); await pb.waitForSelector('#auth .auth-inner');
  await pb.fill('#aEmail', EMAIL); await pb.fill('#aPass', PW); await pb.click('#aGo');
  await pb.waitForSelector('#auth', { state: 'detached', timeout: 20000 });
  await pb.waitForSelector('#modal [data-x]', { timeout: 6000 }).then(() => pb.click('#modal [data-x]')).catch(() => { });
  await pb.waitForFunction(fid => window.__lodestar.st.favorites.has(fid) && window.__lodestar.st.vehicle, favId, { timeout: 20000 }).catch(() => { });
  ok(await ev(pb, fid => window.__lodestar.st.favorites.has(fid), favId), 'device B sees favorite');
  ok(await ev(pb, () => window.__lodestar.st.vehicle?.model) === 'GX 460', 'device B sees vehicle');

  // ---- Device C: a different account can't see A's data ----
  const C = await browser.newContext(opts); const pc = await page(C, 'C');
  const EMAIL_C = EMAIL.replace('e2e-', 'e2e-c-');
  await pc.goto(URL); await pc.waitForSelector('#auth .auth-inner');
  await pc.click('[data-am="signup"]'); await pc.fill('#aEmail', EMAIL_C); await pc.fill('#aPass', PW); await pc.click('#aGo');
  await pc.waitForSelector('#auth', { state: 'detached', timeout: 20000 });
  await pc.waitForSelector('#modal [data-x]', { timeout: 6000 }).then(() => pc.click('#modal [data-x]')).catch(() => { });
  ok(await idbCount(pc, 'favorites') === 0 && !(await ev(pc, () => window.__lodestar.st.vehicle)), 'other account sees none of it');

  // ---- Offline on device A after sign-in ----
  await A.setOffline(true);
  await pa.reload({ waitUntil: 'load' }); await pa.waitForTimeout(2500);
  ok(!(await pa.$('#auth')) && await pa.isVisible('#tabbar'), 'offline reload opens app (cached session, no auth page)');
  ok(await ev(pa, fid => window.__lodestar.st.favorites.has(fid), favId), 'offline: favorites available');
  await ev(pa, () => window.__lodestar.db.put('waypoints', { id: 'w-offline', name: 'Offline camp', icon: 'camp', lon: -94.71, lat: 45.38, created: Date.now(), notes: '' }));
  await pa.waitForTimeout(500);
  ok(await idbCount(pa, 'outbox') === 1, 'offline edit queued');
  await pa.click('[data-tab="more"]'); await pa.waitForTimeout(600);
  await pa.screenshot({ path: SHOTS + 'profile-offline.png' });
  await A.setOffline(false);
  await pa.waitForFunction(() => window.__lodestar.acct.pending === 0 && !window.__lodestar.acct.syncing, null, { timeout: 20000 }).catch(() => { });
  ok(await idbCount(pa, 'outbox') === 0, 'back online → queued edit synced');
  await ev(pb, () => import('/js/account.js').then(m => m.syncNow()));
  await pb.waitForTimeout(800);
  ok(await idbCount(pb, 'waypoints') === 1, 'device B received offline waypoint');

  // ---- Change password on A (UI) ----
  await pa.click('[data-tab="more"]'); await pa.waitForTimeout(500);
  await pa.click('#pPass'); await pa.fill('#cpOld', PW); await pa.fill('#cpNew', PW2); await pa.click('#cpGo');
  await pa.waitForSelector('#cpOld', { state: 'detached', timeout: 15000 }).catch(() => { });
  ok(!(await pa.$('#cpOld')), 'password changed');
  const meB = await ev(pb, () => fetch('/api/auth/me').then(r => r.status));
  ok(meB === 401, 'other device signed out after password change');

  // ---- Sign out on A clears local cache ----
  await pa.click('#pOut'); await pa.waitForTimeout(300);
  await pa.click('#modal .btn.danger, #modal [data-ok]');
  await pa.waitForSelector('#auth .auth-inner', { timeout: 20000 });
  ok(await idbCount(pa, 'favorites') === 0 && await idbCount(pa, 'waypoints') === 0 && await idbCount(pa, 'profile') === 0, 'sign-out wiped local data');
  ok(await ev(pa, async () => !(await caches.keys()).some(k => k.startsWith('ls-tiles') || k.startsWith('ls-runtime'))), 'sign-out cleared tile caches');

  // ---- Delete account via UI (sign back in with new password) ----
  await pa.fill('#aEmail', EMAIL); await pa.fill('#aPass', PW2); await pa.click('#aGo');
  await pa.waitForSelector('#auth', { state: 'detached', timeout: 20000 });
  await pa.waitForFunction(() => window.__lodestar.st.favorites.size > 0, null, { timeout: 15000 }).catch(() => { });
  ok(await ev(pa, () => window.__lodestar.st.favorites.size) > 0, 'sign back in restores data from account');
  await pa.click('[data-tab="more"]'); await pa.waitForTimeout(500);
  await ev(pa, () => window.__lodestar.sheet.set('full'));
  await pa.click('#pDelete'); await pa.fill('#daPw', PW2); await pa.click('#daGo');
  await pa.waitForSelector('#auth .auth-inner', { timeout: 20000 });
  ok(await idbCount(pa, 'favorites') === 0, 'deleted account → local wiped');
  const r = await ev(pa, ([e, p]) => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lodestar': '1' }, body: JSON.stringify({ email: e, password: p }) }).then(r => r.status), [EMAIL, PW2]);
  ok(r === 401, 'deleted account cannot sign in');
  // cleanup account C
  await pc.click('[data-tab="more"]'); await pc.waitForTimeout(400); await ev(pc, () => window.__lodestar.sheet.set('full'));
  await pc.click('#pDelete'); await pc.fill('#daPw', PW); await pc.click('#daGo'); await pc.waitForSelector('#auth .auth-inner', { timeout: 20000 });
  L('cleanup: test account C deleted');
} catch (e) { L('ERROR', e.message); fails++; }
await browser.close();
L(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
