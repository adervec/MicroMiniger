// CI smoke test: serve this folder, open it in headless Chrome, and fail if the page throws
// or renders nothing.  Run from the repo root: npm i --no-save playwright-core && node .github/smoke.mjs
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  try {
    if (!file.startsWith(root)) throw 0;
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// SMOKE_HASH picks the screen that carries the font picker, e.g. '#/progress'
await page.goto(`http://localhost:${server.address().port}/${process.env.SMOKE_HASH || ''}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(3000); // let startup code run
const text = (await page.innerText('body')).trim();
// house standard: Atkinson Hyperlegible is the default font (https://adervec.github.io/font.js)
const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
if (!/Atkinson Hyperlegible/.test(font)) errors.push(`default font is "${font}", expected Atkinson Hyperlegible`);
await page.locator('app-font-picker select').first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => errors.push('no <app-font-picker> on the page'));
await browser.close();
server.close();

if (errors.length || text.length < 50) {
  console.log(errors.length ? 'page errors:\n  ' + errors.join('\n  ') : `page rendered almost nothing (${text.length} chars)`);
  process.exit(1);
}
console.log(`smoke ok: no page errors, ${text.length} chars rendered, font ${font.split(',')[0]}`);
