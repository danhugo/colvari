// Wake-run selector (renderer/app.js wakeRun/wakeLabel), regression for the bare-"working" case
// (t_8af586bc): an agent with an in_progress task assigned can still be in a wake run — the backend
// keeps a.taskId null for the whole wake (orchestrator wakeRun) — and the wake info must show then.
// The task-badge veto applies only when the live run IS the task run (a.taskId set).
// Renderer-level per the update-veil-freeze pattern: extract the real wakeRun/wakeLabel from
// renderer/app.js and exercise them in node — no Electron, no gui-e2e.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const chunks = src.split(/\nfunction /).slice(1);
const grabFn = (what) => { const c = chunks.find((x) => x.startsWith(what + '(')); assert.ok(c, `${what} function found in renderer/app.js`); return 'function ' + c; };

function buildRenderer() {
  // The wakeRun chunk runs to the next top-level `function`, carrying the wakeLabel const with it.
  const body = [
    "'use strict';",
    grabFn('wakeRun'),
    'const S = { orch: { agents: {} }, tasks: [], allNodes: [{ id: "n1", name: "Devon" }, { id: "n2", name: "Pia" }] };',
    'let PRESENCE = "busy";',
    'const presence = () => PRESENCE;',
    'const nodeName = (id) => (S.allNodes.find((n) => n.id === id) || {}).name || id;',
    'return { wakeRun, wakeLabel, S, setPresence: (p) => { PRESENCE = p; } };',
  ];
  return new Function(body.join('\n'))();
}
const R = buildRenderer();

// The exact shape the backend pushes on a wake run (orchestrator wakeRun, a.activity).
const wakeActivity = (over = {}) => ({ trigger: 'message', messageId: 'm1', fromNodeId: 'n2', excerpt: 'please look at the failing test', taskId: null, count: 2, startedAt: 1, ...over });

test('wake run shows its info even when an in_progress task is assigned (was bare "working")', () => {
  R.S.tasks = [{ id: 't1', status: 'in_progress', assignee: 'n1' }];
  R.S.orch.agents = { n1: { status: 'working', activity: wakeActivity(), taskId: null } };
  const w = R.wakeRun('n1');
  assert.ok(w, 'wake info present despite the in_progress task (taskId null = wake run)');
  assert.equal(w.from, 'Pia');
  assert.equal(w.excerpt, 'please look at the failing test');
  assert.equal(w.queued, 1, 'count 2 -> +1 queued');
  assert.match(R.wakeLabel('n1'), /woken by message from Pia: "please look at the failing test" \(\+1 queued\)/);
});

test('task badge still wins: a live run ON the task hides wake info', () => {
  R.S.tasks = [{ id: 't1', status: 'in_progress', assignee: 'n1' }];
  R.S.orch.agents = { n1: { status: 'working', activity: wakeActivity(), taskId: 't1' } };
  assert.equal(R.wakeRun('n1'), null);
});

test('no wake without message activity, and nothing while idle', () => {
  R.S.tasks = [{ id: 't1', status: 'in_progress', assignee: 'n1' }];
  R.S.orch.agents = { n1: { status: 'working', taskId: 't1' } };
  assert.equal(R.wakeRun('n1'), null, 'task run, no activity');
  R.S.orch.agents = { n1: { status: 'idle', activity: wakeActivity(), taskId: null } };
  R.setPresence('idle');
  assert.equal(R.wakeRun('n1'), null, 'stale activity clears when idle');
  R.setPresence('busy');
});
