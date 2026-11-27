// Local dev server: static files from public/ + the Vercel-style API handlers. Reads .env.local (never printed).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const auth = (await import(path.join(root, 'api/auth/[action].js'))).default;
const sync = (await import(path.join(root, 'api/sync.js'))).default;
const trails = (await import(path.join(root, 'api/trails.js'))).default;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const PORT = +process.env.PORT || 8788;
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let m;
  if ((m = u.pathname.match(/^\/api\/auth\/([a-z]+)$/))) { req.query = { action: m[1] }; return auth(req, res); }
  if (u.pathname === '/api/sync') { req.query = {}; return sync(req, res); }
  if (u.pathname === '/api/trails') { req.query = {}; return trails(req, res); }
  let f = path.join(root, 'public', decodeURIComponent(u.pathname));
  if (!f.startsWith(path.join(root, 'public'))) { res.statusCode = 403; return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
  if (f.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('dev server on', PORT));
