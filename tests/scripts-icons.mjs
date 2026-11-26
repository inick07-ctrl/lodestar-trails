import { chromium } from 'playwright-core';
import fs from 'fs';
const svg = fs.readFileSync('../public/icons/logo.svg', 'utf8');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage();
for (const [name, size, pad, bg] of [['icon-192', 192, 0], ['icon-512', 512, 0], ['apple-touch-icon', 180, 0, '#1f5a38'], ['icon-maskable-512', 512, 0.12, '#2a7348']]) {
  await p.setViewportSize({ width: size, height: size });
  const inner = svg.replace('<svg ', `<svg width="${size * (1 - 2 * pad)}" height="${size * (1 - 2 * pad)}" `).replace(bg ? 'rx="112"' : '__', bg ? 'rx="0"' : '__');
  await p.setContent(`<html><body style="margin:0;background:${bg || 'transparent'};display:grid;place-items:center;width:${size}px;height:${size}px">${inner}</body></html>`);
  await p.screenshot({ path: `../public/icons/${name}.png`, omitBackground: !bg });
}
await b.close();
