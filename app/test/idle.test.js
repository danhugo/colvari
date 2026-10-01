const test = require('node:test');
const assert = require('node:assert');
const { agentStates, idleNudges, boardGapNudges } = require('../src/idle');

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

// ---- board-shape gaps (plan t_76da3303 D): the watchdog only looked at processes and per-agent
// ---- mailboxes; these states stopped the cycle while every process looked healthy.

test('boardGapNudges: task in review with an empty review chain pushes the core (t_8b11c78a)', () => {
  const now = 1_000_000_000_000;
  const team = { nodes: [{ id: 'pm', name: 'Pia', role: 'PM', core: true }, { id: 'dev', name: 'Dev', role: 'Dev' }], edges: [{ from: 'pm', to: 'dev', type: 'assign' }] };
  const old = (over = {}) => ({ id: 't1', title: 'Watchdog gap', status: 'review', assignee: 'pm', updatedAt: new Date(now - 11 * 60000).toISOString(), ...over });
  const O = { staleMin: 10, now };
  const out = boardGapNudges(team, [old()], {}, O);
  assert.equal(out.length, 1, 'no review edge and no lead (assignee is the root PM) = stranded');
  assert.equal(out[0].pmId, 'pm', 'the core node receives the push');
  assert.equal(out[0].kind, 'review-stranded');
  assert.deepEqual(out[0].taskIds, ['t1']);
  assert.deepEqual(out[0].idle, []);
  assert.match(out[0].text, /no reviewer configured/);
  assert.deepEqual(boardGapNudges(team, [old({ updatedAt: new Date(now - 2 * 60000).toISOString() })], {}, O), [], 'fresh stranding waits for the same anchor as the sweep');
  assert.deepEqual(boardGapNudges(team, [old({ awaitingApproval: true })], {}, O), [], 'already human-gated');
  const team2 = { nodes: [...team.nodes, { id: 'rev', name: 'R', role: 'Reviewer' }], edges: [...team.edges, { from: 'pm', to: 'rev', type: 'review' }] };
  assert.deepEqual(boardGapNudges(team2, [old()], {}, O), [], 'a review edge means the review sweep, not a gap push');
});

test('boardGapNudges: parent in review with all children done pushes the core (lost hand-off)', () => {
  const now = 1_000_000_000_000;
  const team = { nodes: [{ id: 'pm', name: 'Pia', role: 'PM', core: true }, { id: 'dev', name: 'Dev', role: 'Dev' }, { id: 'rev', name: 'R', role: 'Reviewer' }], edges: [{ from: 'pm', to: 'dev', type: 'assign' }, { from: 'rev', to: 'dev', type: 'review' }] };
  const parent = { id: 'p1', title: 'Logo epic', status: 'review', assignee: 'dev', updatedAt: new Date(now - 11 * 60000).toISOString() };
  const kids = (statuses) => statuses.map((s, i) => ({ id: 'k' + i, title: 'kid ' + i, status: s, assignee: 'dev', parentId: 'p1', updatedAt: new Date(now - 5 * 60000).toISOString() }));
  const O = { staleMin: 10, now };
  const out = boardGapNudges(team, [parent, ...kids(['done', 'done'])], {}, O);
  assert.equal(out.length, 1, 'reviewer exists, so not stranded — but the children are all done');
  assert.equal(out[0].kind, 'review-closeable');
  assert.deepEqual(out[0].taskIds, ['p1']);
  assert.match(out[0].text, /children are done/);
  assert.deepEqual(boardGapNudges(team, [parent, ...kids(['done', 'in_progress'])], {}, O), [], 'an open child means the cycle still moves');
  assert.deepEqual(boardGapNudges(team, [parent, ...kids(['done', 'done'])].map((t) => t.id === 'p1' ? { ...t, updatedAt: new Date(now - 2 * 60000).toISOString() } : t), {}, O), [], 'fresh parent review is normal flow, not a gap');
  assert.deepEqual(boardGapNudges(team, [parent], {}, O), [], 'a parent without children is the review sweep\'s job');
});

test('idleNudges: an agent state claiming working with a dead proc no longer suppresses stale', () => {
  const core = { nodes: [{ id: 'core', name: 'Core', role: 'PM', core: true }, { id: 'b', name: 'Uma', role: 'Dev' }], edges: [] };
  const now = 1_000_000_000_000;
  const t = { id: 't1', title: 'Zombie run', status: 'in_progress', assignee: 'b', updatedAt: new Date(now - 11 * 60000).toISOString() };
  const working = { b: { status: 'working', taskId: 't1' } };
  const O = { staleMin: 10, now };
  assert.deepEqual(idleNudges(core, [t], working, O), [], 'back-compat: without liveNodeIds a working state still counts as live');
  assert.deepEqual(idleNudges(core, [t], working, { ...O, liveNodeIds: new Set(['b']) }), [], 'a real live proc still suppresses the stale nudge');
  const out = idleNudges(core, [t], working, { ...O, liveNodeIds: new Set() });
  assert.equal(out.length, 1, 'working state + dead proc = the Session-not-found hang the sweep missed');
  assert.equal(out[0].kind, 'stale');
  assert.deepEqual(out[0].taskIds, ['t1']);
});

test('staffingSummary: ready per role (unassigned too), blocked incl. waiting_for_human, busy/idle per role', () => {
  const { staffingSummary } = require('../src/idle');
  const tm = { nodes: [{ id: 'a', role: 'Dev' }, { id: 'b', role: 'Dev' }, { id: 'c', role: 'Critic' }], edges: [] };
  const tasks = [
    { id: '1', status: 'in_progress', assignee: 'a' }, { id: '2', status: 'todo', assignee: 'b' }, { id: '3', status: 'todo' },
    { id: '4', status: 'todo', assignee: 'c', blockedBy: ['1'] }, { id: '5', status: 'waiting_for_human', assignee: 'c' },
  ];
  assert.equal(staffingSummary(tm, tasks), 'Ready: Dev 1, unassigned 1 | Blocked: 2\nAgents: Dev 1 busy/1 idle, Critic 0 busy/1 idle');
});
