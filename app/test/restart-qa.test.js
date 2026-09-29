// QA redo of t_1890e7bd (t_3298d008): the four scheduled-restart cases the plan calls out,
// pinned against the shipped backend (t_c44a1e9d). test/restart.test.js covers the store/tool
// primitives; these tests assert the orchestration-level contract:
//   1. a landed merge never restarts — only the pending count moves;
//   2. schedule_restart is refused for non-core agents and changes nothing;
//   3. dispatch pauses while a restart is scheduled, the pause is bounded by the drain grace
//      and ends (on cancel, or when the new process boots after the fire);
//   4. the saved schedule is cleared only after the new process starts;
//   5. (t_b1939389) schedule while an agent is busy → stays pending; the agent idling → fires;
//      the new process boots → chip clears. Plus the anchored variant: an anchor in review
//      blocks the fire with a visible reason, completing it fires.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const { UpdateWatcher } = require('../src/self-update');
const { makeTools } = require('../src/board-tools');
const MG = require('../src/merge-gate');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

// PM (the protected core) + one Dev report; no CLI configured — dispatch tests stub runTask.
const setup = (d) => {
  const s = new Store(path.join(d, 'p'));
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  s.addEdge(pm.id, a.id);
  const o = new Orchestrator(s);
  clearInterval(o._wakeTimer); clearInterval(o._stallTimer); clearInterval(o._tickTimer); clearInterval(o._restartTimer);
  return { s, o, pm, a };
};
// Stand-in for the project's UpdateWatcher, wired like main.js: restartScheduled pauses dispatch
// (setPaused callback), cancel unpauses and re-ticks — an aborted flow must lift the gate itself.
const wireUpdater = (o) => ({
  phase: 'idle', calls: [],
  restartScheduled(r) { this.calls.push(r); this.phase = 'draining'; o.dispatchPaused = true; return true; },
  cancel() { this.calls.push('cancel'); this.phase = 'idle'; o.dispatchPaused = false; o.running = true; o.tick(); },
});

// ---- case 1: merge doesn't restart (the pending count goes up instead) ----
test('qa: a landed merge never restarts — only the pending count moves', () => {
  const d = tmp('squad-restart-qa-');
  const { s, o, a } = setup(d);
  const up = wireUpdater(o);
  o.updater = up;
  o.running = true;
  o.tick();
  const orig = MG.gateMerge;
  const root = tmp('squad-restart-qa-root-');
  try {
    MG.gateMerge = () => ({ merged: true, base: 'master', root, gate: { state: 'green', tests: 1, flaky: [] } });
    const t = s.createTask({ title: 'm', assignee: a.id, createdBy: 'human' });
    s.updateTask(t.id, { worktreePath: '/w', worktreeBranch: 'squad/m', status: 'done' });
  } finally { MG.gateMerge = orig; }
  const rp = s.restartPending();
  assert.equal(rp.count, 1, 'the landed merge counts toward the next restart');
  assert.ok(!rp.scheduledNow && !rp.afterTaskId && !rp.firedAt, 'and arms nothing on its own');
  o.tick();
  assert.equal(up.calls.length, 0, 'no tick ever fires the updater off a merge');
  const st = o.restartState();
  assert.equal(st.pendingCount, 1);
  assert.equal(st.scheduledNow, false);
  assert.equal(st.scheduledAfter, null);
});

// ---- case 2: schedule_restart is rejected for non-core agents ----
test('qa: schedule_restart is refused for non-core agents and leaves the state untouched', () => {
  const d = tmp('squad-restart-qa-');
  const { s, pm, a } = setup(d);
  s.bumpRestartPending();
  const before = s.restartPending();
  assert.throws(() => makeTools(s, a.id).schedule_restart({ now: true }), /scope violation: schedule_restart is PM-only/);
  assert.throws(() => makeTools(s, 'n_ghost').schedule_restart({ now: true }), /unknown caller/, 'an unknown caller is refused too');
  assert.deepEqual(s.restartPending(), before, 'a refused call changed nothing');
  const r = makeTools(s, pm.id).schedule_restart({ now: true, reason: 'qa' });
  assert.equal(r.scheduled, true);
  assert.equal(s.restartPending().scheduledNow, true, 'the PM (protected core) can arm it');
});

// ---- case 3: dispatch pauses while scheduled; the pause is bounded and ends ----
test('qa: dispatch pauses while a restart is scheduled and the pause ends — on cancel, and after the restart boots', () => {
  const d = tmp('squad-restart-qa-');
  const { s, o, a } = setup(d);
  const up = wireUpdater(o);
  o.updater = up;
  o.running = true;
  const ran = [];
  const stubRun = (orch) => { orch.runTask = async (node, task) => { s.updateTask(task.id, { status: 'in_progress' }); ran.push(task.id); orch.procs.set(node.id, { kill() {} }); }; };
  stubRun(o);
  const held = s.createTask({ title: 'held', assignee: a.id, createdBy: 'human' });
  s.scheduleRestart({ now: true });
  o.tick();
  assert.deepEqual(ran, [], 'no new work starts while a restart is scheduled');
  assert.ok(o._restartGating.includes(held.id));
  // cancel unpauses dispatch and re-ticks (the wired cancel does it, like main.js's setPaused callback)
  o.cancelRestart();
  assert.equal(o._restartGate, false, 'cancelling lifts the gate');
  assert.deepEqual(ran, [held.id], 'the held task dispatches');

  const held2 = s.createTask({ title: 'held2', assignee: a.id, createdBy: 'human' });
  s.scheduleRestart({ now: true });
  o.procs.clear();
  o.tick(); // drained + updater idle: fires
  assert.ok(s.restartPending().firedAt);
  assert.equal(o._restartGate, true, 'the gate survives the fire until the relaunch');
  const o2 = new Orchestrator(s);
  clearInterval(o2._wakeTimer); clearInterval(o2._stallTimer); clearInterval(o2._tickTimer);
  stubRun(o2);
  o2.running = true;
  assert.equal(o2._restartGate, false, 'a fresh process boots with the gate off');
  o2.tick();
  assert.deepEqual(ran, [held.id, held2.id], 'work resumes in the new process');
});

test('qa: the dispatch pause is bounded — past the drain grace the restart proceeds without waiting forever', async () => {
  const d = tmp('squad-restart-qa-');
  const relaunches = []; let halts = 0;
  const w = new UpdateWatcher({
    store: watcherStore(path.join(d, 'su')), repoDir: d, pollMs: 3.6e6,
    git: fakeGit(), npm: fakeNpm(),
    relaunch: () => relaunches.push(1),
    procCount: () => 1, // a run that never finishes
    setPaused: () => {},
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    drainTimeoutMs: 60,
    haltProcs: async () => { halts++; return { cut: 1, spared: 0 }; },
  });
  clearInterval(w._timer);
  assert.equal(w.restartScheduled('qa: drain deadline'), true, 'an explicit schedule bypasses auto-restart being off');
  await waitFor(() => relaunches.length === 1);
  assert.equal(halts, 1, 'the straggler is stopped exactly once, at the deadline');
  assert.equal(w.phase, 'restarting');
});

// ---- case 4: the saved schedule is cleared only after the new process starts ----
test('qa: the fired schedule survives every sweep of the old process and is consumed only on boot', () => {
  const d = tmp('squad-restart-qa-');
  const { s, o } = setup(d);
  const up = wireUpdater(o);
  o.updater = up;
  s.scheduleRestart({ now: true });
  o.sweepRestart();
  assert.ok(s.restartPending().firedAt, 'firing marks the schedule, it does not clear it');
  o.sweepRestart(); o.sweepRestart();
  assert.ok(s.restartPending().firedAt && s.restartPending().scheduledNow, 'the old process keeps it saved across sweeps');
  const o2 = new Orchestrator(s);
  clearInterval(o2._wakeTimer); clearInterval(o2._stallTimer); clearInterval(o2._tickTimer);
  assert.equal(s.restartPending(), null, 'only the boot of the new process consumes it');
  const st = o2.restartState();
  assert.equal(st.pendingCount, 0);
  assert.equal(st.targetSha, null);
  assert.equal(st.scheduledAfter, null);
  assert.equal(st.scheduledNow, false);
  assert.deepEqual(st.gating, []);
  assert.deepEqual(st.busyAgents, []);
  assert.deepEqual(st.waitingReasons, [], 'nothing pending, nothing armed: no reasons');
  assert.equal(st.blockedReason, null);
});

// ---- case 5 (t_b1939389): the busy→idle loop — pending while busy, fires on idle, clears on boot ----
const setupQa = (d) => {
  const x = setup(d);
  // QA must never spawn a real CLI: any dispatch here is a gate failure, so fail loudly instead.
  x.o.runTask = async () => { throw new Error('dispatch happened while a restart schedule should hold it'); };
  // The wake path bypasses runTask (nudgeIdle → wakeForHuman → wakeRun → spawnRun): a stuck task
  // makes tick() wake the core asynchronously, which would reserve a slot and spawn for real.
  x.o.wakeRun = async () => {};
  return x;
};
const wireUpdaterQa = (o) => ({
  phase: 'idle', calls: [],
  restartScheduled(r) { this.calls.push(r); this.phase = 'draining'; o.dispatchPaused = true; return true; },
  cancel() { this.calls.push('cancel'); this.phase = 'idle'; o.dispatchPaused = false; o.running = true; o.tick(); },
});

test('qa: schedule while an agent is busy stays pending; the agent idling fires it; boot clears the chip', () => {
  const d = tmp('squad-restart-qa-');
  const { s, o, pm, a } = setupQa(d);
  const up = wireUpdaterQa(o);
  o.updater = up;
  const pushed = [];
  o.on('restart-state', (st) => pushed.push(JSON.parse(JSON.stringify(st))));
  o.running = true;

  // Busy: agent A holds a live run (slot reserved the way runTask does), one landed change counts.
  const busy = s.createTask({ title: 'busy', assignee: a.id, createdBy: 'human' });
  s.updateTask(busy.id, { status: 'in_progress' });
  o.procs.set(a.id, { kill() {} });
  s.bumpRestartPending();
  o.tick();

  // The PM arms a restart-now through the real board tool while the run is in flight.
  const r = makeTools(s, pm.id).schedule_restart({ now: true, reason: 'qa: busy gate' });
  assert.equal(r.scheduled, true);
  o.tick();

  assert.ok(!s.restartPending().firedAt, 'busy agent: the restart stays pending, it does not fire');
  assert.deepEqual(up.calls, [], 'the updater was never told to restart');
  assert.equal(up.phase, 'idle');
  assert.equal(o._restartGate, true, 'the dispatch gate is armed while agents drain');
  let st = o.restartState();
  assert.equal(st.scheduledNow, true, 'chip: armed');
  assert.equal(st.pendingCount, 1);
  assert.deepEqual(st.busyAgents, ['A'], 'the chip names the busy agent');
  assert.match(st.blockedReason, /agent still running: A/, 'the chip says why the restart waits');
  assert.ok(pushed.some((x) => x.scheduledNow), 'the renderer heard the armed state');

  // New work must not start while the schedule waits (the gate, under live conditions).
  s.createTask({ title: 'new work', assignee: a.id, createdBy: 'human' });
  o.tick();
  assert.equal(s.listTasks().find((t) => t.title === 'new work').status, 'todo', 'the gate held the new todo task');

  // The agent goes idle: the run ends, the slot frees, the run-end re-tick sweeps.
  s.updateTask(busy.id, { status: 'done' });
  o.procs.delete(a.id);
  o.tick(); // the same sweep a real run end schedules via setImmediate

  assert.deepEqual(up.calls, ['scheduled restart (now)'], 'idle company: the restart fires');
  const rp = s.restartPending();
  assert.ok(rp.firedAt, 'the fire is marked');
  assert.equal(rp.scheduledNow, true, 'the chip stays up until the new process boots');
  assert.equal(up.phase, 'draining');
  assert.equal(o._restartGate, true, 'the gate survives the fire until the relaunch');
  assert.equal(o.restartState().blockedReason, 'updater: draining', 'after the fire the chip names the drain');
  // dispatchPaused (set by the wired updater, like main.js) holds tick() before its stop path.
  const o2 = new Orchestrator(s);
  clearInterval(o2._wakeTimer); clearInterval(o2._stallTimer); clearInterval(o2._tickTimer); clearInterval(o2._restartTimer);
  assert.equal(s.restartPending(), null, 'boot consumed the fired schedule');
  const st2 = o2.restartState();
  assert.equal(st2.pendingCount, 0);
  assert.equal(st2.scheduledAfter, null);
  assert.equal(st2.scheduledNow, false, 'chip cleared');
  assert.deepEqual(st2.gating, []);
  assert.deepEqual(st2.busyAgents, []);
  assert.deepEqual(st2.waitingReasons, []);
  assert.equal(st2.blockedReason, null, 'chip cleared');
  o2.runTask = o.runTask; o2.wakeRun = async () => {}; o2.updater = up; o2.running = true;
  o2.tick();
  assert.deepEqual(up.calls, ['scheduled restart (now)'], 'the cleared schedule never re-fires');
});

test('qa: an anchor still in review blocks the fire; completing the anchor fires it once the company is idle', () => {
  const d = tmp('squad-restart-qa-');
  const { s, o, pm, a } = setupQa(d);
  const up = wireUpdaterQa(o);
  o.updater = up;
  o.running = true;

  // The company is mid-work: agent A holds a live run while the PM arms an anchored restart.
  // (Production shape: an anchored restart waits for its anchor AND for busy agents to drain.)
  const work = s.createTask({ title: 'work', assignee: a.id, createdBy: 'human' });
  s.updateTask(work.id, { status: 'in_progress' });
  o.procs.set(a.id, { kill() {} });

  // Anchor assigned to the PM: no review chain into the PM, so nothing auto-dispatches it.
  const anchor = s.createTask({ title: 'anchor', assignee: pm.id, createdBy: 'human' });
  s.updateTask(anchor.id, { status: 'review' });
  const r = makeTools(s, pm.id).schedule_restart({ afterTaskId: anchor.id });
  assert.equal(r.scheduledAfter, anchor.id);
  const other = s.createTask({ title: 'other', assignee: a.id, createdBy: 'human' });
  o.tick();

  assert.ok(!s.restartPending().firedAt, 'an in-review anchor blocks the fire');
  assert.deepEqual(up.calls, []);
  const st = o.restartState();
  assert.equal(st.scheduledAfter, anchor.id, 'the chip names what the restart waits on');
  assert.match(st.blockedReason, new RegExp(`anchor ${anchor.id} is review`), 'the chip says the anchor is why');
  assert.deepEqual(st.gating, [other.id], 'new work is held while the anchor runs');

  // The anchor lands and the last agent idles: the next sweep fires.
  s.updateTask(anchor.id, { status: 'done' });
  s.updateTask(work.id, { status: 'done' });
  o.procs.delete(a.id);
  o.tick();
  assert.deepEqual(up.calls, [`anchor ${anchor.id} done`], 'anchor done + idle company: the restart fires');
  assert.ok(s.restartPending().firedAt);
});

// ---- watcher fakes (same shape as test/restart.test.js) ----
const SHA1 = 'a'.repeat(40);
function fakeGit() {
  return (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'master' };
    if (a === 'rev-parse HEAD') return { code: 0, out: SHA1 };
    if (a.startsWith('fetch')) return { code: 0, out: '' };
    if (a === 'rev-parse origin/master') return { code: 0, out: SHA1 };
    if (a === 'status --porcelain') return { code: 0, out: '' };
    if (a.startsWith('diff --name-only')) return { code: 0, out: '' };
    if (a.startsWith('worktree')) return { code: 0, out: '' };
    return { code: 0, out: '' };
  };
}
const fakeNpm = () => (args) => (args[0] === 'run' ? { code: 0, out: 'built' } : args[0] === 'test' ? { code: 0, out: 'all pass' } : { code: 0, out: '' });
const watcherStore = (dir) => ({ dir, settings: { autoRestart: false }, getSettings: () => ({ autoRestart: false }), saveSettings: (s) => Object.assign({ autoRestart: false }, s), appendLog: () => {} });
