// Run lifecycle at drain (t_b2273507): when the board empties the run goes IDLE — still on at zero
// cost — and ready todo work that shows up later (created by the PM, a chat message, or anyone)
// dispatches with no user action. Only an explicit stop() (header Stop), a project budget cap, or
// the maxRuns limit ends the run. runState() exposes running|idle|stopped (+reason) for the UI pill.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, SCHED } = require('../src/orchestrator');

function fakeClaude(dir, script) {
  const f = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(f, '#!/bin/sh\n' + script);
  fs.chmodSync(f, 0o755);
  return f;
}
const RESULT = (cost = 0) => `echo '{"type":"result","subtype":"success","total_cost_usd":${cost},"num_turns":1,"usage":{}}'\n`;

function setup(script = RESULT(), settings = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-idle-'));
  const s = new Store(path.join(r, 'data'));
  s.saveSettings({ claudePath: fakeClaude(r, script), maxConcurrency: 4, ...settings });
  return { r, s };
}
// A dev+reviewer pair: a clean exit hands off to review and the pickup closes it, so a task can
// actually reach done (t_699b67b7) and the board can drain clean.
function team(s) {
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(dev.id, rev.id, 'review');
  return { dev, rev };
}
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 40)); } return true; };
const fastSweep = (body) => async (t) => { const prev = SCHED.TICK_MS; SCHED.TICK_MS = 40; try { await body(t); } finally { SCHED.TICK_MS = prev; } };

test('boot state reads stopped, never silently running', () => {
  const { s } = setup();
  const o = new Orchestrator(s);
  assert.deepEqual(o.runState(), { state: 'stopped', reason: 'not started' });
  assert.equal(o.snapshot().running, false);
});

test('the run idles at drain: stays on, costs nothing, and a new todo dispatches on its own', fastSweep(async () => {
  const { s } = setup();
  const { dev } = team(s);
  const t1 = s.createTask({ title: 'first', assignee: dev.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  assert.equal(s.getTask(t1.id).status, 'done');
  assert.equal(o.running, true, 'the run session stays on after the board drains');
  const rs = o.runState();
  assert.equal(rs.state, 'idle');
  assert.equal(rs.reason, 'waiting for todo tasks');
  assert.ok(rs.since, 'idle carries a since timestamp');
  assert.deepEqual(o.snapshot().runState.state, 'idle');
  assert.equal(o.snapshot().running, false, 'the snapshot running flag means agents at work');
  const runsIdle = o.runs; const costIdle = o.totalCost;
  await new Promise((r) => setTimeout(r, 300)); // several idle sweeps
  assert.equal(o.runs, runsIdle, 'nothing dispatches while idle');
  assert.equal(o.totalCost, costIdle, 'idling is free');
  // Anyone (the PM via chat, the human, an agent's board tool) creates new todo work:
  const t2 = s.createTask({ title: 'picked up without a click', assignee: dev.id });
  assert.ok(await waitFor(() => ['in_progress', 'done'].includes(s.getTask(t2.id).status)), 'the new todo auto-dispatches');
  assert.ok(await waitFor(() => s.getTask(t2.id).status === 'done'), 'and runs to done');
  o.stop();
}));

test('a todo for a missing/retired assignee never dispatches and never wakes the run', fastSweep(async () => {
  const { s } = setup();
  const { dev } = team(s);
  s.createTask({ title: 'real', assignee: dev.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  const runsIdle = o.runs;
  const ghost = s.createTask({ title: 'ghost', assignee: 'n_missing' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.getTask(ghost.id).status, 'todo', 'no assignee means no dispatch');
  assert.equal(o.runs, runsIdle, 'the ghost task spawns nothing');
  assert.equal(o.runState().state, 'idle');
  o.stop();
}));

test('blocked and human-gated work keeps the run idle (reason says so), and unblocking auto-starts it', fastSweep(async () => {
  const { s } = setup();
  const { dev } = team(s);
  const gate = s.createTask({ title: 'needs human', assignee: dev.id });
  s.updateTask(gate.id, { status: 'review', parkedForHuman: true }); // undispatchable: waits for a human
  const dependent = s.createTask({ title: 'blocked work', assignee: dev.id, blockedBy: [gate.id] });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  assert.equal(o.runState().state, 'idle');
  assert.equal(o.runState().reason, 'waiting on review or human');
  assert.equal(s.getTask(dependent.id).status, 'todo');
  const runsIdle = o.runs;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(o.runs, runsIdle, 'blocked work does not spin the scheduler');
  // The human approves the gate: the dependent unblocks and dispatches with no user action.
  s.updateTask(gate.id, { status: 'done' });
  assert.ok(await waitFor(() => s.getTask(dependent.id).status === 'done'), 'unblocked todo runs on its own');
  o.stop();
}));

test('stop() ends an idle run; work created while stopped waits; Run starts a fresh session', fastSweep(async () => {
  const { s } = setup();
  const { dev } = team(s);
  s.createTask({ title: 'first', assignee: dev.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  assert.equal(o.runState().state, 'idle');
  o.stop();
  assert.equal(o.running, false);
  assert.deepEqual(o.runState(), { state: 'stopped', reason: 'stopped by you' });
  const t3 = s.createTask({ title: 'while stopped', assignee: dev.id });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.getTask(t3.id).status, 'todo', 'nothing dispatches while stopped');
  o.start(); // the header Run press: a fresh session
  assert.ok(await waitFor(() => s.getTask(t3.id).status === 'done'), 'Run dispatches the waiting todo');
  await waitFor(() => o.runState().state === 'idle'); // the pickup chain drains too
  assert.equal(o.runState().state, 'idle');
  o.stop();
}));

test('the maxRuns cap terminally stops the run while ready work is refused', fastSweep(async () => {
  const { s } = setup(RESULT(), { maxRuns: 1 });
  const { dev } = team(s);
  s.createTask({ title: 'uses the one run', assignee: dev.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  assert.equal(o.running, false, 'a spent cap ends the run even with a review pickup waiting');
  assert.equal(o.runState().state, 'stopped');
  assert.ok(s.readLogs().some((l) => /run limit reached/.test(l.text)));
}));

test('a project budget cap reads as stopped — budget cap reached', fastSweep(async () => {
  const { s } = setup(RESULT(0.01), { budgetUsd: 0.001 });
  const { dev } = team(s);
  s.createTask({ title: 'over budget', assignee: dev.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  assert.equal(o.running, false);
  assert.deepEqual(o.runState(), { state: 'stopped', reason: 'budget cap reached' });
}));

test('runState reads running while agents work and idle again at the next drain', fastSweep(async () => {
  const { s } = setup('sleep 0.4\n' + RESULT());
  const { dev } = team(s);
  s.createTask({ title: 'slow-ish', assignee: dev.id });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  assert.ok(await waitFor(() => o.procs.size > 0), 'the task dispatches');
  assert.equal(o.runState().state, 'running');
  assert.equal(o.snapshot().running, true, 'the snapshot running flag tracks agents at work');
  await done;
  assert.equal(o.runState().state, 'idle');
  o.stop();
}));
