// Live task-detail tail (t_d4655b21): renderLive rides every streamed flush (flushLogTail calls it
// even while Obs is hidden), but it missed the malformed-line hardening renderLog got in 7c95e40 —
// a null line in the buffer throws in its filter, and the call sits outside flushLogTail's
// try/catch, so the throw escapes as an uncaught exception recurring on every flush. Renderer-level
// per the log-pane-defer pattern: extract the real renderLive + flush blocks from renderer/app.js
// and run them against a DOM stub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const rStart = src.indexOf('function renderLive() {');
const rEnd = src.indexOf('// ---------- wiki ----------');
const bStart = src.indexOf('let logFlushQueued = false');
const bEnd = src.indexOf("// Direct 'log' pushes now carry");
assert.ok(rStart > 0 && rEnd > rStart, 'renderLive block found in renderer/app.js');
assert.ok(bStart > 0 && bEnd > bStart, 'flush/append block found in renderer/app.js');
const liveSrc = src.slice(rStart, rEnd);
const flushBlock = src.slice(bStart, bEnd);
// The flush must not let a throwing task-detail render escape the scheduler.
assert.ok(/try \{ renderLive\(\); \} catch/.test(flushBlock), 'flushLogTail guards the renderLive call');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (props) => Object.assign({
  innerHTML: '', value: '', scrollTop: 0, clientHeight: 1000, scrollHeight: 1000, checked: true,
  classList: { contains: () => true }, addEventListener: () => {},
  querySelector: () => null, insertAdjacentHTML(pos, html) { this.innerHTML += html; },
}, props);
const els = {
  '#tab-obs': el({}),
  '#log': el({}),
  '#logfilter': el({ value: '' }),
  '#logsearch': el({ value: '' }),
  '#logauto': el({ checked: true }),
  '#td-live': el({}),
};

const liveFactory = (logs) => {
  els['#td-live'] = el({});
  const S = { tasks: [{ id: 't1', assignee: 'a1' }] }, sel = { task: 't1' }, ctx = { p: 'p1' };
  const names = ['logs', 'S', 'sel', 'ctx', 'esc', '$'];
  const args = [logs, S, sel, ctx, esc, (x) => els[x]];
  return new Function(...names, `${liveSrc}\nreturn renderLive;`)(...args);
};

const flushFactory = (logs, { renderLiveThrows = false, logRowThrows = false } = {}) => {
  let scrollFn = null;
  els['#log'] = el({});
  els['#log'].addEventListener = (t, fn) => { scrollFn = fn; };
  els['#log'].querySelector = (q) => q === '#log-older' ? null : null;
  const ctx = { p: 'p1' }, sel = { logTeam: '' };
  const renderLog = () => { renderLog.calls++; };
  renderLog.calls = 0; renderLog.total = 0; renderLog.winItems = 0;
  const renderLive = () => { renderLive.calls++; if (renderLiveThrows) throw new Error('bad task detail'); };
  renderLive.calls = 0;
  const logRow = () => { if (logRowThrows) throw new Error('bad row'); return '<div class="logrow"></div>'; };
  const names = ['$','document','requestAnimationFrame','logs','ctx','sel','logsLoaded','logTeamNodes','logLevels','logRow','renderLog','renderLive'];
  const args = [
    (x) => els[x],
    { hidden: false },
    (f) => f(),
    logs, ctx, sel, new Set(['p1']), () => [],
    new Set(['info', 'warn', 'error']),
    logRow, renderLog, renderLive,
  ];
  const api = new Function(...names, `${flushBlock}\nreturn { flushLogTail, appendLogTail, isDirty: () => logTailDirty };`)(...args);
  api.renderLog = renderLog; api.renderLive = renderLive; api.box = els['#log'];
  return api;
};

const seeded = () => Array.from({ length: 4 }, (_, i) => ({ projectId: 'p1', nodeId: 'a1', at: i + 1, kind: 'text', text: 'line ' + (i + 1), _seq: i + 1 }));

test('renderLive skips a null line instead of throwing in its filter', () => {
  const logs = [null, ...seeded(), { projectId: 'p1', nodeId: 'a1', at: 9, kind: 'text', text: undefined }];
  const renderLive = liveFactory(logs);
  renderLive();
  assert.ok(els['#td-live'].innerHTML.includes('line 4'), 'good lines still render');
  assert.ok(els['#td-live'].innerHTML.includes('line 1'), 'window slice unaffected by the dropped null');
  assert.ok(!els['#td-live'].innerHTML.includes('undefined'), 'a missing text renders empty, not the string "undefined"');
});

test('a throwing renderLive does not escape flushLogTail', () => {
  const logs = seeded(); const api = flushFactory(logs, { renderLiveThrows: true });
  api.renderLog.winItems = 190;
  assert.doesNotThrow(() => api.flushLogTail(), 'the scheduler survives the task-detail render throw');
  assert.equal(api.renderLive.calls, 1, 'renderLive was still attempted');
});

test('renderLive still runs after an append throw (existing behavior preserved)', () => {
  const logs = seeded(); const api = flushFactory(logs, { logRowThrows: true });
  api.renderLog.winItems = 190;
  assert.doesNotThrow(() => api.flushLogTail());
  assert.equal(api.renderLive.calls, 1, 'the task-detail refresh follows the stream even when the append fails');
});
