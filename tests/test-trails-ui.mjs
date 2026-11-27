// Community trails UI E2E + screenshots (local dev server or URL=...). Passwords random, never printed.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import { testCreds, signUp, deleteAccount } from './auth-helper.mjs';
const URL = process.env.URL || 'http://localhost:8788/';
const BASE = URL.replace(/\/$/, '');
const SHOTS = '/workspace/lodestar-shots/';
const HOME = [-94.7114, 45.3805];
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const opts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, geolocation: { latitude: HOME[1], longitude: HOME[0] }, permissions: ['geolocation'], isMobile: true, hasTouch: true, colorScheme: 'light', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ev = (p, f, a) => p.evaluate(f, a);
const idle = p => ev(p, () => new Promise(r => { const m = window.__lodestar.map; if (m.loaded() && !m.isMoving()) setTimeout(r, 300); else m.once('idle', () => r()); setTimeout(r, 8000); }));
async function page(ctx, tag) { const p = await ctx.newPage(); p.on('pageerror', e => console.log(`[${tag} pageerror]`, e.message)); return p; }

// Seed a second creator via the API so the Community list has a few trails.
async function apiUser(name) {
  const email = `lodestar-e2e-trailsui-${name.split(' ')[0].toLowerCase()}-${Date.now()}@example.com`, password = crypto.randomBytes(9).toString('base64url') + 'a1';
  const r = await fetch(BASE + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lodestar': '1', Origin: BASE }, body: JSON.stringify({ email, password, name }) });
  const cookie = r.headers.get('set-cookie').match(/ls_session=[^;]+/)[0];
  return { email, password, cookie };
}
const apiT = (u, body) => fetch(BASE + '/api/trails', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lodestar': '1', Origin: BASE, Cookie: u.cookie }, body: JSON.stringify(body) }).then(r => r.json());
const wig = (o, n, dx, dy, amp) => Array.from({ length: n }, (_, i) => [+(HOME[0] + o[0] + i * dx + Math.sin(i / 3) * amp).toFixed(6), +(HOME[1] + o[1] + i * dy + Math.cos(i / 4) * amp).toFixed(6)]);

let D, C, V, pc, pv;
try {
  D = await apiUser('Jake T.');
  await apiT(D, { action: 'create', name: 'Rocky Ridge Two-Track', bestFor: ['offroad4wd', 'atv'], difficulty: 2, clearance: 'high', notes: 'Deep ruts after rain. Air down to 20 psi.', shared: true, source: 'recorded', coords: wig([0.018, -0.012], 40, 0.0006, -0.0003, 0.0007) });
  await apiT(D, { action: 'create', name: 'Pine Hollow Horse Loop', bestFor: ['horse', 'hike'], difficulty: 1, clearance: 'any', notes: 'Trailer parking at the north lot.', shared: true, source: 'drawn', coords: wig([-0.022, 0.01], 30, 0.0004, 0.0005, 0.0006) });
  await apiT(D, { action: 'create', name: 'Koronis Snowmobile Connector', bestFor: ['snowmobile'], difficulty: 1, clearance: 'any', notes: 'Groomed Dec–Mar by the local club.', shared: true, source: 'drawn', coords: wig([-0.004, -0.02], 35, 0.0008, 0.0001, 0.0005) });

  // ---- Creator draws, describes and shares a trail ----
  const CC = await browser.newContext(opts); pc = await page(CC, 'C');
  await pc.goto(URL, { waitUntil: 'load' });
  C = await signUp(pc, { ...testCreds('trailsui-c'), name: 'Maya R.' });
  await ev(pc, () => window.__lodestar.map.jumpTo({ center: [-94.7114, 45.3805], zoom: 14 })); await idle(pc);
  await pc.click('#exCreate'); await pc.waitForSelector('#ctNext');
  await ev(pc, () => window.__lodestar.sheet.set('half')); await pc.waitForTimeout(500);
  for (const [x, y] of [[60, 330], [105, 290], [150, 305], [190, 255], [235, 270], [275, 225], [315, 250]]) { await pc.mouse.click(x, y); await pc.waitForTimeout(250); }
  await pc.waitForTimeout(1200); await idle(pc);
  ok(await ev(pc, () => window.__lodestar.st.plan?.pts.length) === 7, 'tapping the map adds trail points');
  await pc.screenshot({ path: SHOTS + 'trail-create-draw.png' });
  await pc.click('#ctNext'); await pc.waitForSelector('#tfName');
  await pc.fill('#tfName', 'Lake Koronis Shoreline Loop');
  await pc.click('[data-bf="bike"]'); await pc.click('[data-bf="walk"]'); await pc.click('[data-bf="run"]');
  await pc.click('[data-df="0"]');
  await pc.fill('#tfNotes', 'Quiet lakeside path with two benches and a great sunset view. Park at the public access on Hwy 55. Can be muddy in April.');
  await pc.waitForTimeout(500);
  await pc.screenshot({ path: SHOTS + 'trail-details-form.png' });
  ok(await pc.isHidden('#tfVeh'), 'vehicle requirement hidden for non-vehicle trails');
  await pc.click('[data-bf="overland"]'); await pc.waitForTimeout(150);
  ok(await pc.isVisible('#tfVeh'), 'vehicle requirement shown once a vehicle use is picked');
  await pc.click('[data-bf="overland"]');
  await pc.click('label.switch:has(#tfShare)'); await pc.waitForTimeout(300);
  ok(/Everyone signed in to Lodestar/.test(await pc.textContent('#tfShareTxt')) && /Maya R\./.test(await pc.textContent('#tfShareTxt')), 'share toggle explains who sees it (display name only)');
  await ev(pc, () => document.querySelector('#tfShare').closest('.group').scrollIntoView({ block: 'center' })); await pc.waitForTimeout(400);
  await pc.screenshot({ path: SHOTS + 'trail-share-toggle.png' });
  await pc.click('#tfSave');
  await pc.waitForSelector('#ctEdit', { timeout: 15000 });
  ok(/Your trail/.test(await pc.textContent('.ct-author')) && /Shared with community/.test(await pc.textContent('.ct-author')), 'saved → detail shows “Your trail · Shared”');
  ok(await pc.isVisible('#ctDel'), 'owner sees Edit + Delete');
  await pc.waitForTimeout(1500); await idle(pc);
  await pc.screenshot({ path: SHOTS + 'trail-owner-detail.png' });
  const myId = await ev(pc, () => window.__lodestar.st.view.args.id);

  // ---- Another user browses the community ----
  const VC = await browser.newContext(opts); pv = await page(VC, 'V');
  await pv.goto(URL, { waitUntil: 'load' });
  V = await signUp(pv, { ...testCreds('trailsui-v'), name: 'Nick' });
  await ev(pv, () => window.__lodestar.map.jumpTo({ center: [-94.7114, 45.3805], zoom: 12.6 })); await idle(pv);
  await pv.click('#exCommunity');
  await pv.waitForFunction(() => /trails? within/.test(document.querySelector('#cmSub')?.textContent || ''), null, { timeout: 15000 });
  await pv.waitForSelector(`[data-ctrail="${myId}"]`, { timeout: 10000 });
  await ev(pv, () => window.__lodestar.sheet.set('half')); await pv.waitForTimeout(1800); await idle(pv);
  await pv.screenshot({ path: SHOTS + 'trail-community-list.png' });
  const listTxt = await pv.textContent('#cmList');
  ok(/Lake Koronis Shoreline Loop/.test(listTxt) && /by Maya R\./.test(listTxt), 'other user sees the shared trail with author name');
  ok(/Rocky Ridge Two-Track/.test(listTxt) && !listTxt.includes('@'), 'community list shows other members\' trails, no emails');
  await pv.click('[data-cbf="snowmobile"]');
  await pv.waitForFunction(() => /within/.test(document.querySelector('#cmSub')?.textContent || '') && document.querySelectorAll('#cmList [data-ctrail]').length === 1, null, { timeout: 10000 }).catch(() => { });
  ok(await pv.locator('#cmList [data-ctrail]').count() === 1 && /Snowmobile/.test(await pv.textContent('#cmList')), 'best-for filter (Snowmobile) narrows the list');
  await pv.click('[data-cbf="all"]'); await pv.waitForSelector(`[data-ctrail="${myId}"]`);
  await pv.click(`[data-ctrail="${myId}"]`);
  await pv.waitForSelector('#ctReport', { timeout: 10000 });
  await pv.waitForFunction(() => document.querySelector('#ctGain')?.textContent !== '…', null, { timeout: 12000 }).catch(() => { });
  await pv.waitForTimeout(1200); await idle(pv);
  await pv.screenshot({ path: SHOTS + 'trail-community-detail.png' });
  ok(/Created by\s*Maya R\./.test(await pv.textContent('.ct-author')), 'detail shows “Created by Maya R.”');
  await ev(pv, () => window.__lodestar.sheet.set('full')); await pv.waitForTimeout(500);
  await ev(pv, () => { const h = [...document.querySelectorAll('#sheetBody h3')].find(x => /Best for/i.test(x.textContent)); h?.scrollIntoView({ block: 'start' }); }); await pv.waitForTimeout(400);
  await pv.screenshot({ path: SHOTS + 'trail-community-detail-2.png' });
  await ev(pv, () => { window.__lodestar.sheet.body.scrollTop = 0; window.__lodestar.sheet.set('half'); }); await pv.waitForTimeout(400);
  ok(await pv.locator('#ctEdit').count() === 0 && await pv.locator('#ctDel').count() === 0, 'non-owner gets no Edit/Delete');
  const hijack = await ev(pv, async id => (await fetch('/api/trails', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lodestar': '1' }, body: JSON.stringify({ action: 'update', id, name: 'Hijacked', bestFor: ['hike'] }) })).status, myId);
  ok(hijack === 404, 'non-owner edit from the browser is refused by the server');
  // save to favorites
  await pv.click('#ctFav'); await pv.waitForTimeout(800);
  ok(await ev(pv, id => window.__lodestar.st.favorites.has('c:' + id), myId), 'community trail saved to favorites');
  // report
  await pv.click('#ctReport'); await pv.waitForSelector('[data-rr]');
  await pv.click('[data-rr="Crosses private land"]'); await pv.fill('#rpText', 'Fence and no-trespassing sign at the east end.');
  await pv.waitForTimeout(250);
  await pv.screenshot({ path: SHOTS + 'trail-report.png' });
  await pv.click('#rpGo'); await pv.waitForSelector('#modalWrap[hidden]', { state: 'attached', timeout: 8000 }).catch(() => { });
  ok(/reported/i.test(await pv.textContent('#toast')), 'report submitted');
  // offline: saved community trail still opens
  await pv.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 }).catch(() => { });
  await ev(pv, () => window.__lodestar.st.viewStack = []);
  await VC.setOffline(true);
  await pv.reload({ waitUntil: 'load' }).catch(() => { });
  await pv.waitForFunction(() => window.__lodestar?.st?.view && !document.body.classList.contains('locked'), null, { timeout: 30000 });
  await pv.waitForTimeout(800);
  await pv.click('[data-tab="saved"]'); await pv.waitForTimeout(500);
  await pv.click('[data-sv="trails"]').catch(() => { }); await pv.waitForTimeout(500);
  const savedHas = await pv.locator(`#svList [data-ctrail="${myId}"]`).count();
  ok(savedHas === 1, 'offline: saved community trail is listed');
  if (savedHas) { await pv.click(`#svList [data-ctrail="${myId}"]`); await pv.waitForSelector('#ctReport', { timeout: 8000 }).catch(() => { }); }
  ok(/Created by\s*Maya R\./.test(await pv.textContent('.ct-author').catch(() => '')), 'offline: community trail opens from the device cache');
  await pv.click('[data-tab="explore"]'); await pv.click('#exCommunity'); await pv.waitForTimeout(800);
  ok(/offline/.test(await pv.textContent('#cmSub')) && await pv.locator('#cmList [data-ctrail]').count() >= 1, 'offline: Community list shows trails cached on this device');
  await VC.setOffline(false); await pv.waitForTimeout(500);

  // ---- owner deletes account → their shared trail disappears for others ----
  await pc.click('[data-back]').catch(() => { });
  await deleteAccount(pc, C.password); C = null;
  ok(true, 'creator deleted their account');
  await pv.reload({ waitUntil: 'load' }); await pv.waitForSelector('#tabbar', { timeout: 20000 });
  const gone = await ev(pv, async id => (await fetch('/api/trails', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lodestar': '1' }, body: JSON.stringify({ action: 'get', id }) })).status, myId);
  ok(gone === 404, 'deleted account’s shared trail is gone for other users');
} catch (e) { console.log('✗ test crashed:', e.message); fails++; }
finally {
  try { if (C && pc) await deleteAccount(pc, C.password); } catch { }
  try { if (V && pv) { await pv.goto(URL); await pv.waitForSelector('#tabbar', { timeout: 20000 }); await deleteAccount(pv, V.password); } } catch { }
  if (D) await fetch(BASE + '/api/auth/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lodestar': '1', Origin: BASE, Cookie: D.cookie }, body: JSON.stringify({ password: D.password }) }).catch(() => { });
  await browser.close();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
