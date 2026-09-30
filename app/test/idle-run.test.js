// t_b2273507 — a Run whose board drained stays ON: it goes 'idle' (snapshot.running false +
// runState {state:'idle', reason}) instead of stopping, auto-dispatches any ready todo task that
// shows up later (created by chat, the PM, or an agent's board MCP), and only an explicit stop()
// ends it. A goal-mode session keeps today's semantics: its drain ends the run ('done'). After an
// app restart nothing auto-runs: a fresh orchestrator boots 'stopped'.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, SCHED } = require('../src/orchestrator');

SCHED.TICK_MS = 30; // the dispatch sweep drives idle exit and auto-dispatch
test.after(() => { SCHED.TICK_MS = 1000; });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RESULT = `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}'\n`;
const waitFor = async (fn, what, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 10)); } };

function setup(settings = {}) {
  const r = tmp('squad-idle-');
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 0.15\n' + RESULT);
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(r, 'data'));
  s.saveSettings({ claudePath: fake, maxConcurrency: 0, ...settings });
  const a = s.addNode({ name: 'A', role: 'Dev', workdir: path.join(r, 'wA') });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // clean hand-offs complete via reviewer pickup
  s.addEdge(a.id, rev.id, 'review');
  return { s, a, r };
}

test('a drained board idles the run instead of stopping it; only an explicit stop ends it', async () => {
  const { s, a } = setup();
  s.createTask({ title: 'only task', assignee: a.id });
  const o = new Orchestrator(s);
  let doneFired = false; o.on('done', () => { doneFired = true; });
  const idleOnce = new Promise((r) => o.once('idle', r));
  o.start();
  await idleOnce;
  assert.equal(doneFired, false, "a drained board must not emit 'done'");
  assert.equal(o.running, true, 'the run session stays on');
  assert.equal(o.snapshot().running, false, 'snapshot.running is false while idle (the pill leaves "N running")');
  assert.deepEqual({ state: o.snapshot().runState.state, reason: o.snapshot().runState.reason }, { state: 'idle', reason: 'waiting for todo tasks' });
  const done = new Promise((r) => o.once('done', r));
  o.stop();
  await done;
  assert.equal(doneFired, true, "an explicit stop emits 'done'");
  assert.equal(o.running, false);
  assert.deepEqual(o.snapshot().runState, { state: 'stopped', reason: 'stopped by you' });
});

test('a todo task created while idle auto-dispatches without a new Run press', async () => {
  const { s, a } = setup();
  const o = new Orchestrator(s);
  o.start();
  await waitFor(() => o.runStateView().state === 'idle', 'initial idle on an empty board');
  const t = s.createTask({ title: 'chat-created work', assignee: a.id }); // as if chat/PM created it
  await waitFor(() => o.procs.size === 1 && o.agent(a.id).taskId === t.id, 'the new todo auto-dispatched');
  assert.equal(o.runStateView().state, 'running');
  assert.equal(o.snapshot().running, true);
  await waitFor(() => o.runStateView().state === 'idle', 'back to idle after it finished');
  assert.equal(s.getTask(t.id).status, 'done');
});

test('idle reason reflects ready-task reality; unblocking the work auto-dispatches it', async () => {
  const { s, a } = setup();
  const gate = s.createTask({ title: 'gate', assignee: a.id });
  s.updateTask(gate.id, { status: 'waiting_for_human' }); // never auto-dispatched; waits for the human
  const blocked = s.createTask({ title: 'blocked', assignee: a.id, blockedBy: [gate.id] });
  const o = new Orchestrator(s);
  o.start();
  await waitFor(() => o.runStateView().state === 'idle', 'idle with nothing dispatchable');
  assert.match(o.runStateView().reason, /1 unfinished task/, 'the stuck task is the stated reason');
  s.updateTask(gate.id, { status: 'done' }); // the human approves the gate task
  await waitFor(() => o.procs.size === 1, 'the unblocked todo auto-dispatched');
  await waitFor(() => o.runStateView().state === 'idle', 'drained again');
  assert.equal(s.getTask(blocked.id).status, 'done');
});

test('a goal-mode session still ends the run at drain (done, not idle)', async () => {
  const { s, a } = setup();
  s.createTask({ title: 'goal work', assignee: a.id });
  const o = new Orchestrator(s);
  o.start();
  o._sawGoalRun = true; // set by runTask when a goal-mode agent dispatches (the flow itself is pinned in agent-modes); start() resets it, so set it after
  const done = new Promise((r) => o.once('done', r));
  await done;
  assert.equal(o.running, false, 'the goal run finished for real');
  assert.equal(o.runStateView().state, 'stopped');
});

test('a run limit hit with dispatchable work stops instead of idling forever', async () => {
  const { s, a } = setup({ maxRuns: 1 });
  const logs = [];
  s.createTask({ title: 'first', assignee: a.id });
  s.createTask({ title: 'second', assignee: a.id });
  const o = new Orchestrator(s);
  o.on('log', (l) => logs.push(l.text));
  const done = new Promise((r) => o.once('done', r));
  o.start();
  await done;
  assert.ok(logs.some((l) => /run limit reached/.test(l)), 'the limit is the stated stop reason');
  assert.equal(o.runStateView().state, 'stopped');
});

test('a fresh orchestrator boots stopped — a restart never silently runs', () => {
  const { s } = setup();
  const o = new Orchestrator(s);
  assert.deepEqual(o.runStateView(), { state: 'stopped' });
  assert.equal(o.snapshot().running, false);
});

test('stopped reasons: the budget cap says so; a bare stop has none', () => {
  const { s } = setup();
  const o = new Orchestrator(s);
  assert.deepEqual(o.runStateView(), { state: 'stopped' });
  o.userStopped = true;
  assert.deepEqual(o.runStateView(), { state: 'stopped', reason: 'stopped by you' });
  o.budgetStop = 'per-project budget exhausted';
  assert.deepEqual(o.runStateView(), { state: 'stopped', reason: 'budget cap reached' });
});
