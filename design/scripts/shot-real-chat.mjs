// Real-app, real-data screenshots (t_h0a1c2e3). Launches the actual Electron app via Playwright
// `_electron` against a throwaway COPY of ~/.agents-squad (never the original), opens the project
// with the most chat history, and captures Chat / Overview / Board / Logs in light and dark at
// 1440x900 into design/screenshots/real/. Design sign-off starts here (see design/audit-bar.md).
//
//   node design/scripts/shot-real-chat.mjs [projectId] [--src ~/.agents-squad] [--out dir]
//
// Safety: AGENTS_SQUAD_DEV=0 disables boot-resume/self-update so no agents get spawned; only the
// Electron process this script launched is closed.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

let _electron;
try { ({ _electron } = await import('playwright')); } catch {
  const found = execSync("find /Users/d/.npm/_npx -maxdepth 4 -type d -name playwright 2>/dev/null | head -1").toString().trim();
  ({ _electron } = await import(path.join(found, 'index.mjs')));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, '..', '..');
const appDir = path.join(repo, 'app');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const src = opt('--src', path.join(os.homedir(), '.agents-squad'));
const out = opt('--out', path.join(repo, 'design', 'screenshots', 'real'));
const suffix = opt('--suffix', '');
let pid = args.find((a) => /^p_/.test(a));
fs.mkdirSync(out, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-real-'));
fs.cpSync(src, tmp, { recursive: true });
if (!pid) { // project with the largest messages.json
  const dir = path.join(tmp, 'projects');
  pid = fs.readdirSync(dir).map((p) => [p, fs.existsSync(path.join(dir, p, 'messages.json')) ? fs.statSync(path.join(dir, p, 'messages.json')).size : 0]).sort((a, b) => b[1] - a[1])[0][0];
}
console.log('[real] data copy', tmp, 'project', pid);

const env = { ...process.env, AGENTS_SQUAD_HOME: tmp, AGENTS_SQUAD_DEV: '0' };
for (const k of ['AGENTS_SQUAD_PROJECT', 'AGENTS_SQUAD_GUI_E2E', 'AGENTS_SQUAD_SMOKE', 'AGENTS_SQUAD_AUTORUN']) delete env[k];
const require = (await import('node:module')).createRequire(path.join(appDir, 'package.json'));
const electronBin = require('electron'); // resolves to the Electron binary path
const app = await _electron.launch({ executablePath: electronBin, args: [appDir], cwd: appDir, env });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.waitForSelector('#projectlist', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate((p) => document.querySelector(`#projectlist [data-pid="${p}"]`)?.click(), pid);
  await page.waitForTimeout(2000);
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  const tabs = [['chat', 'chat'], ['overview', 'overview'], ['board', 'board'], ['obs', 'logs']];
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
    await page.waitForTimeout(500);
    for (const [tab, name] of tabs) {
      await page.evaluate((t) => document.querySelector(`#tabs button[data-tab=${t}]`)?.click(), tab);
      await page.waitForTimeout(1500);
      const f = path.join(out, `${name}-${theme}${suffix}.png`);
      await page.screenshot({ path: f });
      console.log('[real]', f);
    }
  }
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
