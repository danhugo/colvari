// Log pane hardening (t_640bf491): renderLog filters every stored line before drawing. A malformed
// entry (null line, or text that is an object/number instead of a string) used to throw mid-build —
// and since logSig is only stamped after a successful build, every later render threw again and the
// pane froze for good. Renderer-level per the chat-patch pattern: extract the real renderLog from
// renderer/app.js and run it against a minimal DOM stub; fails on pre-fix code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('const LOG_LEVEL');
const end = src.indexOf("$('#logteam').onchange");
assert.ok(start > 0 && end > start, 'log pane block found in renderer/app.js');
const block = src.slice(start, end);

const el = (props) => Object.assign({
  innerHTML: '', value: '', scrollTop: 0, clientHeight: 1000, scrollHeight: 1000, checked: true,
  classList: { contains: () => true }, addEventListener: () => {},
}, props);
const els = {
  '#tab-obs': el({}),
  '#log': el({}),
  '#logfilter': el({ value: '' }),
  '#logsearch': el({ value: '' }),
  '#loglevels': el({}),
  '#logauto': el({ checked: true }),
};

const factory = (logs) => {
  const S = { v: { project: 1 }, tasks: [], settings: {}, project: { teams: [] }, orch: { agents: {} } };
  const names = ['$','document','S','logs','ctx','sel','logsLoaded','logTeamNodes','who','avatarBg','avatarBody','esc','shortTaskId','Chat','Subagents','RUNS','CH','requestAnimationFrame','logSig'];
  const args = [
    (x) => els[x],
    { querySelectorAll: () => [], getElementById: () => null },
    S, logs, { p: 'p1' }, { logTeam: '' }, new Set(['p1']), () => [],
    (id) => ({ name: id || '?' }), () => '#111', () => 'A', (id) => id,
    (s) => String(s).replace(/[<>&]/g, '_'),
    { pageOf: (rows) => ({ items: rows, hidden: 0 }), anchorScroll: () => 0 },
    { nestRows: (items) => items.map((l) => ({ kind: 'log', l })), durationMs: () => 0, fmtDuration: () => '', tokensLabel: () => '' },
    [], {}, (f) => f(), '',
  ];
  return new Function(...names, `${block}\nreturn { renderLog };`)(...args);
};

test('renderLog skips a null line instead of throwing mid-build', () => {
  const logs = [{ projectId: 'p1', nodeId: 'a1', at: 1, kind: 'text', text: 'good line' }, null];
  const { renderLog } = factory(logs);
  renderLog(); // must not throw
  assert.ok(els['#log'].innerHTML.includes('good line'), 'the valid line still renders');
});

test('renderLog stringifies non-string text instead of throwing in the search filter', () => {
  const logs = [
    { projectId: 'p1', nodeId: 'a1', at: 1, kind: 'text', text: { boom: 1 } },
    { projectId: 'p1', nodeId: 'a1', at: 2, kind: 'text', text: 42 },
    { projectId: 'p1', nodeId: 'a1', at: 3, kind: 'text', text: 'plain' },
  ];
  const { renderLog } = factory(logs);
  els['#logsearch'].value = 'plain'; // the filter only evaluates text when a query is set
  try {
    renderLog(); // must not throw (pre-fix: (l.text || '').toLowerCase() is not a function)
    assert.ok(els['#log'].innerHTML.includes('plain'), 'matching line renders alongside malformed ones');
    assert.ok(!els['#log'].innerHTML.includes('logrow') || els['#log'].innerHTML.split('logrow').length === 2, 'non-matching lines are filtered out');
  } finally { els['#logsearch'].value = ''; }
});
