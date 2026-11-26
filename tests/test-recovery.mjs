// Recovery-code password reset E2E. Passwords and codes are random and never printed.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import { testCreds, signUp, confirmRecovery, deleteAccount } from './auth-helper.mjs';
const URL = process.env.URL || 'http://localhost:8788/';
const SHOTS = '/workspace/lodestar-shots/';
const PW2 = crypto.randomBytes(9).toString('base64url') + 'c3';
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
try {
  const A = await browser.newContext(opts); const pa = await page(A, 'A');
  await pa.goto(URL, { waitUntil: 'load' });
  await pa.waitForSelector('#auth .auth-inner');
  ok(await pa.isVisible('#aForgot'), 'Forgot password? link on sign-in');
  await pa.click('#aForgot'); await pa.waitForTimeout(400);
  ok(await pa.isVisible('#aCode') && /Reset password/.test(await pa.textContent('#aGo')), 'forgot-password form shown');
  await pa.screenshot({ path: SHOTS + 'auth-forgot.png' });
  await pa.click('#aBack'); await pa.waitForTimeout(300);

  const creds = testCreds('recov');
  await pa.click('[data-am="signup"]');
  await pa.fill('#aName', 'Nick'); await pa.fill('#aEmail', creds.email); await pa.fill('#aPass', creds.password);
  await pa.click('#aGo');
  await pa.waitForSelector('#recovCode', { timeout: 25000 });
  ok(!(await pa.locator('#recovGo').isEnabled()), 'Continue disabled until the code is confirmed saved');
  await pa.waitForTimeout(400);
  await pa.screenshot({ path: SHOTS + 'auth-recovery.png' });
  const code1 = (await pa.textContent('#recovCode')).trim();
  ok(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(code1), 'recovery code is 4 groups of 5');
  await pa.click('#recovSaved'); await pa.click('#recovGo');
  await pa.waitForSelector('#auth', { state: 'detached', timeout: 25000 });
  await pa.waitForSelector('#modal [data-x]', { timeout: 6000 }).then(() => pa.click('#modal [data-x]')).catch(() => { });
  ok(await pa.isVisible('#tabbar'), 'entered app after saving recovery code');

  // Device B stays signed in until the reset
  const B = await browser.newContext(opts); const pb = await page(B, 'B');
  await pb.goto(URL);
  await pb.waitForSelector('#auth .auth-inner');
  await pb.fill('#aEmail', creds.email); await pb.fill('#aPass', creds.password); await pb.click('#aGo');
  await pb.waitForSelector('#auth', { state: 'detached', timeout: 25000 });
  await pb.waitForSelector('#modal [data-x]', { timeout: 6000 }).then(() => pb.click('#modal [data-x]')).catch(() => { });

  // Sign out A so we can use Forgot password
  await pa.click('[data-tab="more"]'); await pa.waitForTimeout(400);
  await pa.click('#pOut'); await pa.waitForTimeout(300);
  await pa.click('#modal .btn.danger, #modal [data-ok]');
  await pa.waitForSelector('#auth .auth-inner', { timeout: 20000 });

  // Wrong recovery code → generic error
  await pa.click('#aForgot');
  await pa.fill('#aEmail', creds.email); await pa.fill('#aCode', 'AAAAA-AAAAA-AAAAA-AAAAA'); await pa.fill('#aPass', PW2);
  await pa.click('#aGo'); await pa.waitForSelector('#aErr:not([hidden])');
  ok(/Email or recovery code is incorrect/i.test(await pa.textContent('#aErr')), 'wrong code shows generic error');

  // Correct code resets the password and issues a new code
  await pa.fill('#aCode', code1); await pa.fill('#aPass', PW2); await pa.click('#aGo');
  await pa.waitForSelector('#recovCode', { timeout: 25000 });
  const code2 = (await pa.textContent('#recovCode')).trim();
  ok(code2 && code2 !== code1, 'a fresh recovery code is shown after reset');
  await pa.screenshot({ path: SHOTS + 'auth-recovery-after-reset.png' });
  await pa.click('#recovSaved'); await pa.click('#recovGo');
  await pa.waitForSelector('#auth', { state: 'detached', timeout: 25000 });
  ok(await pa.isVisible('#tabbar'), 'signed in after password reset');

  const meB = await pb.evaluate(() => fetch('/api/auth/me').then(r => r.status));
  ok(meB === 401, 'other device signed out after recovery reset');

  // Old password and old recovery code no longer work
  await pa.click('[data-tab="more"]'); await pa.waitForTimeout(400);
  await pa.click('#pOut'); await pa.waitForTimeout(300);
  await pa.click('#modal .btn.danger, #modal [data-ok]');
  await pa.waitForSelector('#auth .auth-inner', { timeout: 20000 });
  await pa.fill('#aEmail', creds.email); await pa.fill('#aPass', creds.password); await pa.click('#aGo');
  await pa.waitForSelector('#aErr:not([hidden])');
  ok(/incorrect/i.test(await pa.textContent('#aErr')), 'old password is rejected');
  await pa.click('#aForgot');
  await pa.waitForSelector('#aCode:not([hidden])');
  await pa.fill('#aEmail', creds.email); await pa.fill('#aCode', code1); await pa.fill('#aPass', PW2 + 'x');
  await pa.click('#aGo'); await pa.waitForSelector('#aErr:not([hidden])');
  const recovErr = (await pa.textContent('#aErr')).trim();
  ok(/Email or recovery code is incorrect/i.test(recovErr), 'old recovery code is rejected' + ( /incorrect/i.test(recovErr) ? '' : ` (got: ${recovErr})`));

  // New password signs in; generate a newer code from Profile
  await pa.click('#aBack'); await pa.fill('#aEmail', creds.email); await pa.fill('#aPass', PW2); await pa.click('#aGo');
  await pa.waitForSelector('#auth', { state: 'detached', timeout: 25000 });
  await pa.waitForSelector('#modal [data-x]', { timeout: 6000 }).then(() => pa.click('#modal [data-x]')).catch(() => { });
  await pa.click('[data-tab="more"]'); await pa.waitForTimeout(500);
  await pa.evaluate(() => window.__lodestar.sheet.set('full'));
  ok(await pa.isVisible('#pRecovery'), 'Profile has Generate new recovery code');
  await pa.click('#pRecovery'); await pa.waitForSelector('#rcPw'); await pa.fill('#rcPw', PW2); await pa.click('#rcGo');
  try { await pa.waitForSelector('#recovCode', { timeout: 20000 }); }
  catch (e) { L('profile generate failed:', await pa.locator('#rcErr').textContent().catch(() => ''), 'modal:', (await pa.locator('#modal').textContent().catch(() => '')).slice(0, 300)); throw e; }
  const code3 = (await pa.textContent('#recovCode')).trim();
  ok(code3 && code3 !== code2, 'Profile issued a new recovery code');
  await pa.screenshot({ path: SHOTS + 'profile-recovery.png' });
  await pa.click('#recovSaved'); await pa.click('#recovGo');
  await pa.waitForTimeout(400);

  await deleteAccount(pa, PW2);
  ok(await pa.isVisible('#auth'), 'test account deleted');
} catch (e) { L('ERROR', e.message); fails++; }
await browser.close();
L(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
