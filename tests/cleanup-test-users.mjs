// Delete leftover Playwright test accounts (emails starting with lodestar-e2e- or lodestar-test-).
// Reads .env.local; never prints secret values or passwords.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');
if (!fs.existsSync(envPath)) { console.error('missing .env.local'); process.exit(1); }
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const { neon } = await import('@neondatabase/serverless');
const q = neon(process.env.DATABASE_URL);
const users = await q`select id from users where email like 'lodestar-e2e-%@example.com' or email like 'lodestar-test-%@example.com'`;
if (users.length) await q`delete from users where id = any(${users.map(u => u.id)})`;
const rates = await q`delete from rate_limits where key like '%lodestar-e2e%' or key like '%lodestar-test%' returning key`;
const left = await q`select
  (select count(*)::int from users where email like 'lodestar-e2e-%@example.com' or email like 'lodestar-test-%@example.com') as test_users,
  (select count(*)::int from users) as users,
  (select count(*)::int from sessions) as sessions,
  (select count(*)::int from items) as items`;
console.log('deleted test users:', users.length, '| rate-limit rows:', rates.length);
console.log('remaining: test users', left[0].test_users, '| all users', left[0].users, '| sessions', left[0].sessions, '| items', left[0].items);
