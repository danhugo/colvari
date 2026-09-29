// One-off screenshot script for t_f56080f3 (nav icon set + chip on/off). Not app/ code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

let _electron;
try {
  ({ _electron } = await import('playwright'));
} catch {
  const found = execSync("find /Users/d/.npm/_npx -maxdepth 3 -type d -name playwright 2>/dev/null | head -1").toString().trim();
  ({ _electron } = await import(path.join(found, 'index.mjs')));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..', 'app');
const shots = path.join(__dirname, '..', 'screenshots');

const electronApp = await _electron.launch({
  args: [appDir],
  executablePath: '/Users/d/hice/agents-squad/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  env: { ...process.env, SQUAD_HEADLESS: '1' },
});
const win = await electronApp.firstWindow();
await win.setViewportSize({ width: 1280, height: 800 });
await win.waitForTimeout(800);

await win.click('button[data-tab="overview"]');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(shots, 'after-nav-chips-overview.png') });

await win.click('button[data-tab="obs"]');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(shots, 'after-nav-chips-logs.png') });

await electronApp.close();
console.log('done');
