const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/alerts');

const NOW = 1759000000000;
const collect = (state) => A.collect({ now: NOW, ...state });

test('mapping: master red with a fix task -> error alert, not dismissable, Fix opens the task', () => {
  const out = collect({ redMaster: { red: true, since: NOW - 5000, failingTests: ['a test', { name: 'b test' }], fixTaskId: 't_abc123' } });
  assert.equal(out.length, 1);
  const a = out[0];
  assert.equal(a.id, 'master-red');
  assert.equal(a.severity, 'error');
  assert.equal(a.dismissable, false); // blocks every merge: stays until the state clears (Critic)
  assert.equal(a.taskId, 't_abc123');
  assert.equal(a.text, 'Master is red — 2 failing tests: a test, merges blocked');
  assert.deepEqual(a.action, { label: 'Fix', op: 'open-task', arg: 't_abc123' });
  assert.equal(a.fingerprint, `${NOW - 5000}|a test,b test`);
});

test('mapping: master red without a fix task -> null action, text says so', () => {
  const [a] = collect({ redMaster: { red: true, failingTests: ['x'] } });
  assert.equal(a.action, null);
  assert.match(a.text, /no fix task yet/);
  assert.equal(collect({ redMaster: { red: false } }).length, 0);
  assert.equal(collect({ redMaster: null }).length, 0);
});

test('mapping: restart pending -> warn alert with Restart now; stub or idle state stays quiet', () => {
  const out = collect({ rst: { pendingCount: 2, targetSha: 'abcd', since: NOW - 99, stub: false } });
  assert.deepEqual(out.map((a) => a.id), ['restart-pending']);
  assert.equal(out[0].severity, 'warn');
  assert.equal(out[0].text, 'Restart pending — 2 commits behind');
  assert.deepEqual(out[0].action, { label: 'Restart now', op: 'restart-core' });
  const armed = collect({ rst: { pendingCount: 1, scheduledAfter: 't_1234567', scheduledNow: false, stub: false } })[0];
  assert.match(armed.text, /after t_1234/);
  assert.equal(collect({ rst: { pendingCount: 0, stub: false } }).length, 0);
  assert.equal(collect({ rst: { pendingCount: 3, stub: true } }).length, 0); // no backend yet: no alert
});

test('mapping: restart pending is dev-only — hidden when the backend says non-dev, shown when absent', () => {
  // packaged build (t_7fbee55f): a stale stored pending state must never surface, whatever it says
  assert.equal(collect({ devMode: false, rst: { pendingCount: 2, stub: false } }).length, 0);
  assert.equal(collect({ devMode: false, rst: { pendingCount: 1, scheduledAfter: 't_1234567', stub: false } }).length, 0);
  assert.equal(collect({ devMode: false, rst: { scheduledNow: true, stub: false } }).length, 0);
  // devMode absent (stub/older backend): the gated-off UX is not in play — dev rows stay
  assert.equal(collect({ rst: { pendingCount: 2, stub: false } }).length, 1);
  // other alerts are untouched by the gate
  const rm = collect({ devMode: false, redMaster: { red: true, failingTests: ['x'], fixTaskId: 't_abc' } });
  assert.deepEqual(rm.map((a) => a.id), ['master-red']);
});

test('mapping: stopped with work left -> one warn per orphaned in_progress task, action Open task', () => {
  const tasks = [
    { id: 't_1', status: 'in_progress', assignee: 'n_1', title: 'Fix the thing', updatedAt: '2026-09-30T00:00:00Z' },
    { id: 't_2', status: 'in_progress', assignee: 'n_2', title: 'Live one', updatedAt: '' },
    { id: 't_3', status: 'todo', assignee: 'n_1', title: 'Not started' },
    { id: 't_4', status: 'in_progress', assignee: '', title: 'Unassigned' },
    { id: 't_5', status: 'done', assignee: 'n_1', title: 'Finished' },
  ];
  const out = collect({ tasks, running: ['n_2'] });
  assert.deepEqual(out.map((a) => a.id), ['stuck-task:t_1']);
  assert.equal(out[0].severity, 'warn');
  assert.equal(out[0].text, 'Fix the thing — in progress, no live worker');
  assert.equal(out[0].agentId, 'n_1');
  assert.deepEqual(out[0].action, { label: 'Open task', op: 'open-task', arg: 't_1' });
});

test('mapping: agent stuck -> warn; with a current task it opens the task, else the overview', () => {
  const out = collect({ agents: { n_2: { status: 'working', taskId: 't_9' } }, stuck: ['n_2'], stuckMinutes: 5, nodeNames: { n_2: 'Pia' } });
  assert.deepEqual(out.map((a) => a.id), ['stuck-agent:n_2']);
  assert.equal(out[0].text, 'Pia stuck — no output for 5 min');
  assert.deepEqual(out[0].action, { label: 'Open task', op: 'open-task', arg: 't_9' });
  const bare = collect({ agents: { n_2: { status: 'working' } }, stuck: ['n_2'], nodeNames: { n_2: 'Pia' } })[0];
  assert.deepEqual(bare.action, { label: 'Open overview', op: 'open-overview' });
});

test('mapping: recovery failed -> error alert pointing at the task', () => {
  const [a] = collect({ stalls: [{ id: 'n_3', st: { state: 'recovery_failed', attempt: 2, max: 2, taskId: 't_2' } }], nodeNames: { n_3: 'Dev' } });
  assert.equal(a.id, 'agent-recovery:n_3');
  assert.equal(a.severity, 'error');
  assert.equal(a.text, 'Dev — recovery failed (attempt 2/2)');
  assert.deepEqual(a.action, { label: 'Open task', op: 'open-task', arg: 't_2' });
});

test('mapping: limits HIT -> error alert; near-limit (warn flag) is NOT an alert in v1', () => {
  const hit = collect({ limits: { providers: [{ provider: 'claude', windows: [{ label: '5h', pct: 1.0 }] }] } });
  assert.deepEqual(hit.map((a) => a.id), ['limits-hit']);
  assert.equal(hit[0].severity, 'error');
  assert.equal(hit[0].text, 'Limits hit — Claude 5h 100%');
  assert.deepEqual(hit[0].action, { label: 'Open usage', op: 'open-usage' });
  // near limit: flagged but under 100% -> nothing (Critic cut "limits near")
  assert.equal(collect({ limits: { providers: [{ provider: 'claude', windows: [{ label: '5h', pct: 0.92, warn: true }] }] } }).length, 0);
  // 0-100 scale pct at 100 and the pause flag both hit; two providers aggregate into one row
  const two = collect({ limits: { providers: [{ provider: 'claude', windows: [{ label: '5h', pct: 100 }] }, { provider: 'codex', windows: [{ label: 'weekly', pct: 0.3, pause: true }] }] } });
  assert.deepEqual(two.map((a) => a.id), ['limits-hit']);
  assert.equal(two[0].text, 'Limits hit — 2 providers (Claude, Codex)');
  // legacy fiveHour/weekly shape (no providers list yet)
  const legacy = collect({ limits: { fiveHour: { limit: 100, used: 100 }, weekly: { limit: 0 } } });
  assert.deepEqual(legacy.map((a) => a.id), ['limits-hit']);
  assert.equal(collect({ limits: null }).length, 0);
  assert.equal(collect({ limits: { providers: [{ provider: 'unknown', windows: [{ label: '5h', pct: 1 }] }] } }).length, 0);
});

test('mapping: runtime down -> error, NOT dismissable while down, Resume reuses the existing IPC op (Critic condition)', () => {
  const out = collect({ rtu: { runtime: 'claude', label: 'Claude', paused: 2, at: NOW - 10, error: 'exit 1' } });
  assert.deepEqual(out.map((a) => a.id), ['runtime-down:claude']);
  assert.equal(out[0].severity, 'error');
  assert.equal(out[0].dismissable, false);
  assert.equal(out[0].text, 'Claude unavailable — 2 agents paused, new work waits');
  assert.deepEqual(out[0].action, { label: 'Resume', op: 'resume-runtime', arg: 'claude' });
  assert.equal(collect({ rtu: null }).length, 0);
});

test('mapping: preflight failed is emitted (single source) so the inline line can render it; bell filters kind', () => {
  const out = collect({ teamNodes: [{ id: 'n_1', name: 'Pia', preflightStatus: 'fail', preflight: { at: 123 } }, { id: 'n_2', name: 'Ok', preflightStatus: 'pass' }] });
  assert.deepEqual(out.map((a) => a.id), ['preflight:n_1']);
  assert.equal(out[0].kind, 'preflight');
  assert.equal(out[0].severity, 'error');
  assert.deepEqual(out[0].action, { label: 'Retest', op: 'retest', arg: 'n_1' });
});

test('empty state: no inputs -> no alerts', () => {
  assert.deepEqual(collect({}), []);
});

test('order: error before warn, newest first within a severity', () => {
  const out = collect({
    rst: { pendingCount: 1, stub: false },
    tasks: [{ id: 't_1', status: 'in_progress', assignee: 'n_1', title: 'A', updatedAt: '2025-01-01T00:00:00Z' }],
    redMaster: { red: true, failingTests: ['x'], since: NOW - 1000 },
  });
  // warn rows newest first: restart-pending (at = now) beats the older stuck task
  assert.deepEqual(out.map((a) => a.kind), ['master-red', 'restart-pending', 'stuck-task']);
});

test('fingerprint: stable for the same state, changes when the state changes (dismiss = id+fp)', () => {
  const state = { redMaster: { red: true, failingTests: ['x'], since: 5, fixTaskId: 't_1' } };
  const [a1] = collect(state);
  const [a2] = collect({ ...state });
  assert.equal(a1.fingerprint, a2.fingerprint);
  const [a3] = collect({ ...state, redMaster: { ...state.redMaster, failingTests: ['x', 'y'] } });
  assert.notEqual(a1.fingerprint, a3.fingerprint);
  const stuck = (updated) => collect({ tasks: [{ id: 't_1', status: 'in_progress', assignee: 'n_1', title: 'A', updatedAt: updated }] })[0].fingerprint;
  assert.notEqual(stuck('2026-09-30T00:00:00Z'), stuck('2026-09-30T00:05:00Z'));
});

test('mapping: self-update abort -> one dismissable error alert with the reason; none when empty or non-dev', () => {
  const out = collect({ updError: 'test step timed out after 10min' });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'self-update-aborted');
  assert.equal(out[0].severity, 'error');
  assert.match(out[0].text, /old code/);
  assert.match(out[0].text, /timed out/);
  assert.equal(collect({ updError: '' }).length, 0);
  assert.equal(collect({ updError: 'x', devMode: false }).length, 0);
});
