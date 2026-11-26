import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'public/icons');
const svg = fs.readFileSync(path.join(icons, 'logo.svg'), 'utf8');
// Full-bleed square for OS-masked icons (iOS/Android apply their own rounded mask).
const square = svg.replace(/rx="114"/g, 'rx="0"');

const jobs = [
  // [name, size, svg, background (always opaque for app icons)]
  ['icon-192', 192, square],
  ['icon-512', 512, square],
  ['icon-maskable-512', 512, square],
  ['apple-touch-icon', 180, square],
  ['favicon-32', 32, svg],
  ['favicon-16', 16, svg],
];

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage();
for (const [name, size, markup] of jobs) {
  await p.setViewportSize({ width: size, height: size });
  // Scale the SVG to the canvas exactly; no extra padding (the star already has ~20% inset).
  const scaled = markup.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await p.setContent(`<!doctype html><html><head><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;background:#0B1A33;overflow:hidden}</style></head><body>${scaled}</body></html>`);
  await p.screenshot({ path: path.join(icons, `${name}.png`), omitBackground: false });
}
await b.close();
console.log('wrote', jobs.map(j => j[0]).join(', '));
