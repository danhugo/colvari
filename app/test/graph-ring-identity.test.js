// t_360abb85: renderGraph cleared #graph (innerHTML = '') on every delta, so the working node's
// .avring was re-created and its ringpulse blink restarted. Runs the real morph helper from
// renderer/app.js in a hidden Electron window (real DOM) and checks ring identity across redraws.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('const MORPH_ON');
const end = src.indexOf('function el(tag');
const helper = start > 0 && end > start ? src.slice(start, end) : 'function morphKids(o, n) { o.innerHTML = \'\'; o.append(...n.childNodes); }';

const page = `const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
${helper}
const live = el('svg', { id: 'graph' }); document.body.append(live);
const draw = (agents, msgs) => { const svg = el('svg', {}); const nL = el('g', { class: 'nodes' }, el('g', { class: 'viewport' }, svg));
  for (const [id, st] of agents) { const g = el('g', { class: 'node st-' + st, 'data-id': id }, nL); el('rect', { class: 'card' }, g);
    if (st === 'working') el('rect', { class: 'avring' }, g); el('rect', { class: 'avatar' }, g); el('text', { class: 'nrole' }, g).textContent = msgs + ' msgs'; }
  morphKids(live, svg, new Map()); };
draw([['a', 'working'], ['b', 'idle']], 0);
const ring = live.querySelector('[data-id="a"] .avring'); let reinserted = 0;
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n === ring || (n.contains && n.contains(ring))) reinserted++; }).observe(live, { childList: true, subtree: true });
for (let i = 1; i <= 4; i++) draw([['a', 'working'], ['b', i === 4 ? 'working' : 'idle'], ...(i === 3 ? [['c', 'idle']] : [])], i);
setTimeout(() => console.log('RESULT ' + JSON.stringify({ same: live.querySelector('[data-id="a"] .avring') === ring, reinserted,
  text: live.querySelector('[data-id="a"] .nrole').textContent, bRing: !!live.querySelector('[data-id="b"] .avring'), nodes: live.querySelectorAll('.node').length })), 0);`;

test('Team map keeps the working ring node across graph redraws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringid-'));
  fs.writeFileSync(path.join(dir, 'page.js'), page);
  fs.writeFileSync(path.join(dir, 'main.js'), `const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => { const w = new BrowserWindow({ show: false });
  w.webContents.on('console-message', (e) => { const msg = e.message; if (String(msg).startsWith('RESULT ')) { process.stdout.write(msg + '\\n'); app.exit(0); } });
  await w.loadURL('data:text/html,<body></body>'); w.webContents.executeJavaScript(require('fs').readFileSync(${JSON.stringify(path.join(dir, 'page.js'))}, 'utf8')); });
setTimeout(() => app.exit(1), 20000);`);
  const electron = require('electron');
  const out = execFileSync(electron, [path.join(dir, 'main.js')], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const r = JSON.parse(out.match(/RESULT (.*)/)[1]);
  assert.strictEqual(r.same, true, 'avring element identity kept');
  assert.strictEqual(r.reinserted, 0, 'avring not re-inserted');
  assert.strictEqual(r.text, '4 msgs', 'label still updates');
  assert.strictEqual(r.bRing, true, 'status change still adds the ring');
  assert.strictEqual(r.nodes, 2, 'removed node is dropped');
});

test('renderGraph no longer wipes #graph', () => {
  const body = src.slice(src.indexOf('function renderGraph'), src.indexOf('function renderMinimap'));
  assert.doesNotMatch(body, /innerHTML = ''/);
  assert.match(body, /morphKids\(live, svg/);
});
