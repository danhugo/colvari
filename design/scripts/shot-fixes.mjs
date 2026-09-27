// One-off screenshot script for critique-views.md fixes (t_7ffd00b5). Not app/ code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Resolve a locally-available Playwright install (this repo has no package.json dependency on it).
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const found = execSync("find /Users/d/.npm/_npx -maxdepth 3 -type d -name playwright 2>/dev/null | head -1").toString().trim();
  ({ chromium } = await import(path.join(found, 'index.mjs')));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proto = path.join(__dirname, '..', 'prototype');
const shots = path.join(__dirname, '..', 'shots');

const browser = await chromium.launch();

async function shot(file, theme, out, { bigDemo = false, timeline = false, scrollUp = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('file://' + path.join(proto, file));
  await page.evaluate((t) => document.documentElement.dataset.theme = t, theme);
  if (bigDemo) {
    await page.click('#scaleToggle');
    await page.waitForTimeout(300);
  }
  if (timeline) {
    await page.click('.tab[data-tab="timeline"]');
    await page.waitForTimeout(150);
  }
  if (scrollUp) {
    await page.evaluate(() => { document.querySelector('#wrap').scrollTop = 0; });
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: path.join(shots, out) });
  await page.close();
}

await shot('overview.html', 'dark', 'after-fix-graph24-dark.png', { bigDemo: true });
await shot('overview.html', 'light', 'after-fix-graph24-light.png', { bigDemo: true });
await shot('overview.html', 'dark', 'after-fix-timeline-dark.png', { timeline: true });
await shot('overview.html', 'light', 'after-fix-overview-fit-light.png', {});
await shot('logs.html', 'dark', 'after-fix-logs-dark.png', { scrollUp: true });
await shot('logs.html', 'light', 'after-fix-logs-light.png', { scrollUp: true });

await browser.close();
console.log('done');
