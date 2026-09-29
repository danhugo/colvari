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

await win.evaluate(() => { const n = S.team.nodes[0]?.id; const items0 = [
  { id: 'i1', nodeId: n, kind: 'question', question: 'Older: which palette should the graph use?', choices: ['Cool', 'Warm'], createdAt: 1 },
  { id: 'i2', nodeId: n, kind: 'question', question: 'Ship the inbox change now or wait for review?', choices: ['Ship now', 'Wait'], createdAt: 2 }]; const inj = () => { S.inbox = items; renderInbox(); }; const items = items0; showTab('inbox'); inj(); setInterval(inj, 150); });
await win.waitForTimeout(600);
await win.screenshot({ path: path.join(shots, 'after-inbox-gaps.png') });
await electronApp.close();
