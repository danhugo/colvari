// Before/after contrast shots for t_c42012a8 (design/scripts/contrast-check.mjs has the numbers).
// "Before" re-injects the critique-era token values (design/critique.md table) over the live
// prototype; "after" is the current tokens.css. Not app/ code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const found = execSync("find /Users/d/.npm/_npx -maxdepth 3 -type d -name playwright 2>/dev/null | head -1").toString().trim();
  ({ chromium } = await import(path.join(found, 'index.mjs')));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(__dirname, '..', 'shots');

// critique-era values: muted grey, bright names, amber/red status text, white ink on fills
const BEFORE = `
  --fg-muted:#7d8394; --success:#12a150; --edge:#8a90a0;
  --accent-text:#4f5bff; --success-text:#12a150; --warning-text:#d98a00; --warning-strong:#d98a00;
  --fg-on-accent:#ffffff;
  --agent-1-text:#6d5dfc; --agent-2-text:#f25f8f; --agent-3-text:#10a37f; --agent-4-text:#f08c1a;
  --agent-5-text:#1e9bf0; --agent-6-text:#c24fe0; --agent-7-text:#e2574c; --agent-8-text:#14b8a6;
`;
const BEFORE_DARK = `
  --fg-muted:#7b8193; --fg-on-accent:#ffffff;
  --agent-1-text:#8f83ff; --agent-2-text:#ff7fa8; --agent-3-text:#34c79c; --agent-4-text:#ffa94d;
  --agent-5-text:#4db5ff; --agent-6-text:#d57ef0; --agent-7-text:#ff7a70; --agent-8-text:#3dd6c3;
`;

const browser = await chromium.launch();
const proto = 'file://' + path.join(__dirname, '..', 'prototype.html');

async function shot(out, theme, before) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(proto);
  await page.evaluate((t) => document.documentElement.dataset.theme = t, theme);
  if (before) {
    await page.evaluate((css) => {
      const s = document.createElement('style');
      s.textContent = `:root, [data-theme="dark"] { ${css} }
        *{animation:none!important;transition:none!important}`;
      document.head.append(s);
    }, theme === 'dark' ? BEFORE_DARK : BEFORE);
  } else {
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = '*{animation:none!important;transition:none!important}';
      document.head.append(s);
    });
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, out) });
  await page.close();
}

await shot('contrast-before-light.png', 'light', true);
await shot('contrast-after-light.png', 'light', false);
await shot('contrast-before-dark.png', 'dark', true);
await shot('contrast-after-dark.png', 'dark', false);
await browser.close();
console.log('done');
