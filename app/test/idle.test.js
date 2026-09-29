const test = require('node:test');
const assert = require('node:assert');
const { agentStates, idleNudges } = require('../src/idle');

const team = { nodes: [{ id: 'pm', name: 'Pia' }, { id: 'a', name: 'Devon' }, { id: 'b', name: 'Uma' }], edges: [{ from: 'pm', to: 'a', type: 'assign' }, { from: 'pm', to: 'b' }] };

test('agentStates: busy via in_progress task or working run', () => {
  const tasks = [{ assignee: 'a', status: 'in_progress' }, { assignee: 'b', status: 'todo' }];
  assert.deepStrictEqual(agentStates(team, tasks, { pm: { status: 'working' } }), { pm: 'busy', a: 'busy', b: 'idle' });
});

test('idleNudges: PM with open goals is told about idle reports', () => {
  const tasks = [{ assignee: 'pm', status: 'todo' }, { assignee: 'a', status: 'in_progress' }];
  assert.deepStrictEqual(idleNudges(team, tasks), [{ pmId: 'pm', idle: ['b'], text: '1 agent idle: Uma' }]);
  assert.strictEqual(idleNudges(team, [{ createdBy: 'pm', status: 'review' }])[0].text, '2 agents idle: Devon, Uma');
});

test('idleNudges: no nudge without open goals or idle agents', () => {
  assert.deepStrictEqual(idleNudges(team, [{ assignee: 'pm', status: 'done' }]), []);
  assert.deepStrictEqual(idleNudges(team, [{ assignee: 'pm', status: 'todo' }], { a: { status: 'working' }, b: { status: 'working' } }), []);
});

// ---- watchdog condition (t_ccab4c19): an open task untouched for staleMin minutes whose assignee
// ---- has no live run on it nudges the CORE — only a core wake can re-dispatch silent work.

test('idleNudges: stale open task nudges the core when opts.staleMin is set', () => {
  const core = { nodes: [{ id: 'core', name: 'Core', role: 'PM', core: true }, { id: 'b', name: 'Uma', role: 'Dev' }], edges: [] };
  const now = 1_000_000_000_000;
  const staleTask = { id: 't1', title: 'Fix the login', status: 'todo', assignee: 'b', updatedAt: new Date(now - 11 * 60000).toISOString() };
  const idleB = { b: { status: 'idle' } };
  const out = idleNudges(core, [staleTask], idleB, { staleMin: 10, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].pmId, 'core');
  assert.deepEqual(out[0].taskIds, ['t1']);
  assert.equal(out[0].kind, 'stale');
  assert.deepEqual(out[0].idle, []);
  assert.match(out[0].text, /Fix the login/);
  // back-compat: without opts the condition is off and the output shape is unchanged
  assert.deepStrictEqual(idleNudges(core, [staleTask], idleB), []);
});

test('idleNudges: stale gate — fresh, live-on-it, and non-actionable tasks never nudge', () => {
  const core = { nodes: [{ id: 'core', name: 'Core', role: 'PM', core: true }, { id: 'b', name: 'Uma', role: 'Dev' }], edges: [] };
  const now = 1_000_000_000_000;
  const old = (over = {}) => ({ id: 't1', title: 'T', status: 'todo', assignee: 'b', updatedAt: new Date(now - 11 * 60000).toISOString(), ...over });
  const O = { staleMin: 10, now };
  assert.deepEqual(idleNudges(core, [old({ updatedAt: new Date(now - 2 * 60000).toISOString() })], { b: { status: 'idle' } }, O), [], 'fresh task');
  assert.deepEqual(idleNudges(core, [old()], { b: { status: 'working', taskId: 't1' } }, O), [], 'assignee live ON the task counts as live');
  assert.equal(idleNudges(core, [old()], { b: { status: 'working', taskId: 'other' } }, O).length, 1, 'live on another task still stale for this one');
  for (const over of [{ status: 'done' }, { status: 'review' }, { awaitingApproval: true }, { parkedForHuman: true }, { assignee: '' }]) {
    assert.deepEqual(idleNudges(core, [old(over)], { b: { status: 'idle' } }, O), [], JSON.stringify(over));
  }
});

test('idleNudges: stale nudge falls back to the top of the assign tree without a core node', () => {
  const tree = { nodes: [{ id: 'pm', name: 'Pia', role: 'PM' }, { id: 'dev', name: 'Dev', role: 'Dev' }], edges: [{ from: 'pm', to: 'dev', type: 'assign' }] };
  const now = 1_000_000_000_000;
  const t = { id: 't9', title: 'Ship it', status: 'in_progress', assignee: 'dev', updatedAt: new Date(now - 61 * 60000).toISOString() };
  const out = idleNudges(tree, [t], {}, { staleMin: 10, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].pmId, 'pm', 'root PM (no incoming assign edge) receives the nudge');
  assert.deepEqual(out[0].taskIds, ['t9']);
});
