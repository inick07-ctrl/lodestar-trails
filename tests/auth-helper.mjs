// Shared sign-up / sign-in / delete helpers for Playwright tests.
// Passwords are random and never printed. Test emails use the lodestar-e2e- prefix so cleanup can find them.
import crypto from 'node:crypto';

export function testCreds(tag = 'e2e') {
  return {
    email: `lodestar-e2e-${tag}-${Date.now()}@example.com`,
    password: crypto.randomBytes(9).toString('base64url') + 'a1',
    name: 'Test',
  };
}

async function dismissHint(page) {
  await page.waitForSelector('#modal [data-x]', { timeout: 6000 }).then(() => page.click('#modal [data-x]')).catch(() => { });
}

export async function signUp(page, creds = testCreds()) {
  await page.waitForSelector('#auth .auth-inner', { timeout: 30000 });
  await page.click('[data-am="signup"]');
  if (creds.name) await page.fill('#aName', creds.name);
  await page.fill('#aEmail', creds.email);
  await page.fill('#aPass', creds.password);
  await page.click('#aGo');
  await page.waitForSelector('#auth', { state: 'detached', timeout: 25000 });
  await dismissHint(page);
  return creds;
}

export async function signIn(page, { email, password }) {
  await page.waitForSelector('#auth .auth-inner', { timeout: 30000 });
  await page.fill('#aEmail', email);
  await page.fill('#aPass', password);
  await page.click('#aGo');
  await page.waitForSelector('#auth', { state: 'detached', timeout: 25000 });
  await dismissHint(page);
}

export async function deleteAccount(page, password) {
  await page.click('[data-tab="more"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__lodestar?.sheet?.set('full'));
  await page.waitForSelector('#pDelete', { timeout: 8000 });
  await page.click('#pDelete');
  await page.fill('#daPw', password);
  await page.click('#daGo');
  await page.waitForSelector('#auth .auth-inner', { timeout: 25000 });
}
