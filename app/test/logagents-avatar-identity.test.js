// t_0a1f16e4: the Logs sidebar rebuilt #logagents with innerHTML on every log line, so the working
// avatar was re-created and its ringpulse animation restarted. Runs the real patchRows from
// renderer/app.js in a hidden Electron window (real DOM) and checks avatar node identity.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('const rowKey =');
const end = src.indexOf('const logTeamNodes');
const helper = start > 0 && end > start ? src.slice(start, end) : 'function patchRows(box, html) { box.innerHTML = html; }';

const row = (id, n, cls = 'working') => `<div class="logagent-row" data-id="${id}"><span class="avatar sm ${cls}">A</span><b>${id}</b><span class="lacount">${n}</span></div>`;
const page = `${helper}
const box = document.createElement('div'); document.body.append(box);
const html = (n, cls) => \`<div class="logagent-row" data-id=""><span class="avatar sm">∀</span><span class="lacount">\${n}</span></div>\` + ${JSON.stringify(row('a', 0))}.replace('>0<', '>' + n + '<') + ${JSON.stringify(row('b', 0, ''))}.replace('class="avatar sm "', 'class="avatar sm ' + cls + '"');
patchRows(box, html(1, ''));
const av = box.querySelector('[data-id="a"] .avatar'); let reinserted = 0;
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n === av || (n.contains && n.contains(av))) reinserted++; }).observe(box, { childList: true, subtree: true });
for (let i = 2; i <= 5; i++) patchRows(box, html(i, i === 5 ? 'working' : ''));
setTimeout(() => console.log('RESULT ' + JSON.stringify({ same: box.querySelector('[data-id="a"] .avatar') === av, reinserted,
  count: box.querySelector('[data-id="a"] .lacount').textContent, bWorking: box.querySelector('[data-id="b"] .avatar').classList.contains('working'), rows: box.children.length })), 0);`;

test('Logs sidebar keeps the working avatar node across new log lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avid-'));
  fs.writeFileSync(path.join(dir, 'page.js'), page);
  fs.writeFileSync(path.join(dir, 'main.js'), `const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => { const w = new BrowserWindow({ show: false });
  w.webContents.on('console-message', (e) => { const msg = e.message; if (String(msg).startsWith('RESULT ')) { process.stdout.write(msg + '\\n'); app.exit(0); } });
  await w.loadURL('data:text/html,<body></body>'); w.webContents.executeJavaScript(require('fs').readFileSync(${JSON.stringify(path.join(dir, 'page.js'))}, 'utf8')); });
setTimeout(() => app.exit(1), 20000);`);
  const electron = require('electron');
  const out = execFileSync(electron, [path.join(dir, 'main.js')], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const r = JSON.parse(out.match(/RESULT (.*)/)[1]);
  assert.strictEqual(r.same, true, 'avatar element identity kept');
  assert.strictEqual(r.reinserted, 0, 'avatar not re-inserted');
  assert.strictEqual(r.count, '5', 'count still updates');
  assert.strictEqual(r.bWorking, true, 'status class still updates');
  assert.strictEqual(r.rows, 3);
});
