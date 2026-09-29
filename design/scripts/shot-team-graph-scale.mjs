// t_2aaf566c: team graph at 5/15/24 agents (synthetic critique fixture injected into the renderer). Not app/ code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
let _electron;
try { ({ _electron } = await import('playwright')); } catch {
  const found = execSync("find /Users/d/.npm/_npx -maxdepth 3 -type d -name playwright 2>/dev/null | head -1").toString().trim();
  ({ _electron } = await import(path.join(found, 'index.mjs')));
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..', 'app');
const shots = path.join(__dirname, '..', 'shots');
const app = await _electron.launch({ args: [appDir], executablePath: '/Users/d/hice/agents-squad/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', env: { ...process.env, SQUAD_HEADLESS: '1' } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForTimeout(800);
await win.click('button[data-tab="team"]');
for (const theme of ['light', 'dark']) for (const n of [5, 15, 24]) {
  await win.evaluate(([n, theme]) => {
    document.documentElement.dataset.theme = theme;
    const roles = ['Frontend', 'Backend', 'QA', 'Design', 'Infra', 'Research']; const nodes = [{ id: 'lead', name: 'Mira Lead', role: 'Team lead', core: true, x: 0, y: 0 }], edges = [];
    const mgrs = n === 5 ? 0 : n === 15 ? 3 : 4; const per = n === 5 ? 0 : Math.floor((n - 1 - mgrs) / mgrs);
    if (n === 5) for (let i = 0; i < 4; i++) { nodes.push({ id: 'a' + i, name: 'Agent ' + i, role: roles[i], x: 0, y: 0 }); edges.push({ id: 'e' + i, from: 'lead', to: 'a' + i, type: 'assign' }); }
    else for (let m = 0; m < mgrs; m++) { nodes.push({ id: 'm' + m, name: 'Lead ' + roles[m], role: 'Manager', x: 0, y: 0 }); edges.push({ id: 'em' + m, from: 'lead', to: 'm' + m, type: 'assign' });
      for (let k = 0; k < per; k++) { const id = `w${m}_${k}`; nodes.push({ id, name: `${roles[m]} ${k + 1}`, role: 'Engineer', x: 0, y: 0 }); edges.push({ id: 'ew' + id, from: 'm' + m, to: id, type: 'assign' }); } }
    edges.push({ id: 'msg', from: nodes[1].id, to: nodes[2].id, type: 'message' });
    S.team = { ...S.team, nodes, edges }; S.cross = []; S.nstat = {};
    nodes.forEach((x, i) => { if (i % 3 === 1 || i === 0) S.nstat[x.id] = { status: 'working' }; });
    expandedClusters.clear(); graphAuto = true; vpCount = 0; renderGraph(); fitView();
  }, [n, theme]);
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(shots, `graph-${n}-${theme}.png`) });
}
await app.close();
