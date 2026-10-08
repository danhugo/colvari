// Obs agent-list highlight (t_h0a1c2fa bug 1): renderObs skips its rebuild when nothing but the
// #logfilter selection changed — clicking an agent row switched the log stream but left the .sel
// row and the filter dropdown stale until the next log line moved the signature. Renderer-level
// per the chat-patch pattern: extract the real renderObs from renderer/app.js and run it against a
// minimal DOM stub; the test fails on pre-fix code (second call must rebuild).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('function renderObs');
const end = src.indexOf('const LOG_LEVEL');
assert.ok(start > 0 && end > start, 'renderObs block found in renderer/app.js');
const block = src.slice(start, end);

const el = (props) => Object.assign({ innerHTML: '', value: '' }, props);
const els = {
  '#tab-obs': el({ classList: { contains: () => true } }),
  '#logfilter': el({ value: '' }),
  '#logteam': el({}),
  '#logagents': el({ innerHTML: '<bootstrap>' }),
  '#budgetbar': el({}),
};

const S = { v: { project: 1, teams: 1, settings: 1 }, tasks: [], settings: {}, project: { teams: [] },
  orch: { agents: { a2: { status: 'working' } }, runCost: 0, runTokens: 0, budgetStop: '' } };
const logs = [{ projectId: 'p1', nodeId: 'a1', at: 1, kind: 'text', text: 'l1' }, { projectId: 'p1', nodeId: 'a2', at: 2, kind: 'text', text: 'l2' }];

const names = ['$','document','S','logs','ctx','sel','obsSig','logTeamNodes','agentStamp','who','avatarBg','avatarBody','esc','shortTaskId','runtimeLabel','orphanedTasks','stuckBtn','fmtTok','wireStuckBtns','patchRows'];
const args = [
  (x) => els[x],
  { querySelectorAll: () => [] },
  S, logs, { p: 'p1' }, { logTeam: '' }, null,
  () => [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
  () => 'stamp',
  (id) => ({ name: id.toUpperCase() }),
  () => '#111', () => 'A',
  (s) => String(s).replace(/[<>&]/g, '_'),
  (id) => id, () => 'rt',
  () => [], () => '', () => '',
  () => {},
  (box, html) => { box.innerHTML = html; },
];
const factory = new Function(...names, `${block}\nreturn { renderObs, sig: () => obsSig };`);

test('renderObs rebuilds the agent list when only the filter selection changes', () => {
  const { renderObs } = factory(...args);
  renderObs(); // initial draw, filter = ''
  assert.ok(els['#logagents'].innerHTML.includes('data-id="a2"'), 'initial draw lists agents');
  assert.ok(!els['#logagents'].innerHTML.includes('row sel" data-id="a2'), 'a2 unselected initially');
  els['#logfilter'].value = 'a2'; // the click handler changes exactly this
  const before = els['#logagents'].innerHTML;
  renderObs(); // must rebuild: new selection must gate the signature
  assert.notEqual(els['#logagents'].innerHTML, before, 'selection change alone must rebuild the list (bug 1: stale .sel until the next log line)');
  assert.ok(els['#logagents'].innerHTML.includes('row sel" data-id="a2') || /logagent-row sel" data-id="a2"/.test(els['#logagents'].innerHTML), 'a2 row carries .sel after the click');
});
