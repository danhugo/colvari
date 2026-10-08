// Shots for t_ee1dc6c4 (merge gate + unblock queue prototype) — static file, no Electron needed.
// Writes 6 PNGs (chat / queue / task-cards x light/dark) into design/screenshots/gate-queue/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  const found = execSync("find /Users/d/.npm/_npx -maxdepth 4 -type d -name playwright 2>/dev/null | head -1").toString().trim();
  ({ chromium } = await import(path.join(found, 'index.mjs')));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.join(here, '..', 'prototype.html');
const out = path.join(here, '..', 'screenshots', 'gate-queue');
const fs = await import('node:fs');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const states = [['', 'chat'], ['&queue=1', 'queue'], ['&view=cards', 'cards']];
for (const theme of ['light', 'dark']) {
  for (const [q, name] of states) {
    await page.goto(`${url}?theme=${theme}${q}`);
    await page.waitForTimeout(350);
    await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(out, `${name}-${theme}.png`) });
    console.log('shot', `${name}-${theme}.png`);
  }
}
await browser.close();
