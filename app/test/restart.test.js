// Scheduled restarts (plan t_42f310cf item 1, t_c44a1e9d): a landed merge only bumps the pending
// counter in the store; a restart happens solely through an armed schedule — the PM-only
// schedule_restart tool, the human pill (restartNow/cancelRestart IPC), or the cap safety valve.
// The orchestrator gates new dispatch while armed (anchor exempt), fires once eligible and
// drained, and the UpdateWatcher flow does the actual drain/test/relaunch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, RESTART } = require('../src/orchestrator');
const { UpdateWatcher } = require('../src/self-update');
const { makeTools } = require('../src/board-tools');
const WT = require('../src/worktree');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

// Team with the PM as the protected core and one Dev report; no CLI configured (dispatch tests
// stub runTask, so nothing spawns).
const setup = (d) => {
  const s = new Store(path.join(d, 'p'));
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  s.addEdge(pm.id, a.id);
  const o = new Orchestrator(s);
  clearInterval(o._wakeTimer); clearInterval(o._stallTimer); clearInterval(o._tickTimer);
  return { s, o, pm, a };
};
// Stand-in for the project's UpdateWatcher: records restartScheduled/cancel calls.
const fakeUpdater = () => ({ phase: 'idle', calls: [], restartScheduled(r) { this.calls.push(r); return true; }, cancel() { this.calls.push('cancel'); this.phase = 'idle'; } });

test('store: landed merges bump the pending counter; refusals and empty merges do not', () => {
  const d = tmp('squad-restart-');
  const s = new Store(path.join(d, 'p'));
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  assert.equal(s.restartPending(), null);
  s.bumpRestartPending();
  const rp = s.bumpRestartPending();
  assert.equal(rp.count, 2);
  assert.ok(rp.since, 'since is anchored on the first bump');
  const since = rp.since;
  const orig = WT.worktreeMerge;
  try {
    WT.worktreeMerge = () => ({ merged: true, base: 'master' });
    s.updateTask(s.createTask({ title: 'x', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w', worktreeBranch: 'squad/x', status: 'done' });
    assert.equal(s.restartPending().count, 3, 'a landed merge counts');
    WT.worktreeMerge = () => ({ refused: true, dirty: ['f'] });
    s.updateTask(s.createTask({ title: 'y', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w2', worktreeBranch: 'squad/y', status: 'done' });
    WT.worktreeMerge = () => ({ merged: false, base: 'master' });
    s.updateTask(s.createTask({ title: 'z', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w3', worktreeBranch: 'squad/z', status: 'done' });
    assert.equal(s.restartPending().count, 3, 'refused and empty merges do not count (Cato #6)');
    assert.equal(s.restartPending().since, since);
  } finally { WT.worktreeMerge = orig; }
});

test('store: scheduleRestart validates the anchor at schedule time (Cato #2)', () => {
  const d = tmp('squad-restart-');
  const s = new Store(path.join(d, 'p'));
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  assert.throws(() => s.scheduleRestart(), /nothing requested/);
  assert.throws(() => s.scheduleRestart({ afterTaskId: 't_x', now: true }), /not both/);
  assert.throws(() => s.scheduleRestart({ afterTaskId: 't_nope' }), /unknown afterTaskId/);
  const blocked = s.createTask({ title: 'blocked', assignee: a.id, createdBy: 'human', blockedBy: [] });
  const blocker = s.createTask({ title: 'blocker', assignee: pm.id, createdBy: 'human' });
  s.updateTask(blocked.id, { blockedBy: [blocker.id] });
  assert.throws(() => s.scheduleRestart({ afterTaskId: blocked.id }), /blocked/);
  s.updateTask(blocker.id, { status: 'in_progress' });
  const waiting = s.createTask({ title: 'waiting', assignee: a.id, createdBy: 'human' });
  s.updateTask(waiting.id, { status: 'waiting_for_human' });
  assert.throws(() => s.scheduleRestart({ afterTaskId: waiting.id }), /waiting_for_human/);
  const ok = s.scheduleRestart({ afterTaskId: blocker.id });
  assert.equal(ok.afterTaskId, blocker.id);
  assert.ok(ok.since, 'arming also anchors since');
  s.updateTask(blocked.id, { blockedBy: [] });
  s.updateTask(blocked.id, { status: 'done' });
  assert.ok(s.scheduleRestart({ afterTaskId: blocked.id }), 'a done anchor is already eligible');
  assert.ok(s.scheduleRestart({ now: true }).scheduledNow);
});

test('orchestrator: armed schedule gates new dispatch (anchor exempt) and fires once drained', () => {
  const d = tmp('squad-restart-');
  const { s, o, pm, a } = setup(d);
  const up = fakeUpdater();
  o.updater = up;
  const pushed = [];
  o.on('restart-state', (r) => pushed.push(r));
  const anchor = s.createTask({ title: 'anchor', assignee: a.id, createdBy: 'human' });
  const other = s.createTask({ title: 'other', assignee: pm.id, createdBy: 'human' });
  s.scheduleRestart({ afterTaskId: anchor.id });
  o.running = true;
  const ran = [];
  o.runTask = async (node, task) => { ran.push(task.id); o.procs.set(node.id, { kill() {} }); };
  o.tick();
  assert.deepEqual(ran, [anchor.id], 'the anchor dispatches; other new work is gated');
  assert.ok(o._restartGating.includes(other.id) && !o._restartGating.includes(anchor.id));
  assert.ok(s.readLogs(50).some((l) => /ready but not dispatched: restart scheduled/.test(l.text)));
  assert.equal(up.calls.length, 0, 'anchor not done yet: nothing fires');

  s.updateTask(anchor.id, { status: 'done' });
  o.procs.clear();
  o.tick();
  assert.equal(up.calls.length, 1);
  assert.match(up.calls[0], /anchor/);
  const rp = s.restartPending();
  assert.ok(rp.firedAt, 'fired marker persisted for the boot-clear');
  assert.equal(rp.firedCount, 0);
  assert.equal(o._restartGate, true, 'the gate stays armed until the relaunch (no dispatch window)');
  const st = o.restartState();
  assert.deepEqual(st, { pendingCount: 0, since: rp.since, scheduledAfter: anchor.id, scheduledNow: false, gating: [other.id] });
  assert.ok(pushed.length >= 1, 'restart-state is pushed when it changes');
});

test('orchestrator: cap auto-schedules a drain restart and notifies the core once per crossing', () => {
  const d = tmp('squad-restart-');
  const { s, o, pm } = setup(d);
  o.updater = fakeUpdater();
  s.saveSettings({ restartCap: 2 });
  s.bumpRestartPending(); s.bumpRestartPending();
  o.sweepRestart();
  assert.equal(s.restartPending().scheduledNow, true, 'cap auto-arms {now}');
  const msgs = () => s.listMessages({ to: pm.id });
  assert.equal(msgs().length, 1);
  assert.match(msgs()[0].text, /cap 2/);
  o.sweepRestart();
  assert.equal(msgs().length, 1, 'no repeat notification while the count is unchanged');
  o.cancelRestart();
  s.bumpRestartPending();
  o.sweepRestart();
  assert.equal(msgs().length, 2, 'a new crossing (count moved) notifies again');
  assert.equal(s.restartPending().scheduledNow, true);
  assert.equal(RESTART.CAP, 20, 'default cap');
});

test('orchestrator: without an updater the schedule stays armed instead of being consumed', () => {
  const d = tmp('squad-restart-');
  const { s, o } = setup(d);
  s.scheduleRestart({ now: true });
  o.sweepRestart();
  const rp = s.restartPending();
  assert.ok(!rp.firedAt && rp.scheduledNow, 'nothing to relaunch with: keep the schedule');
  assert.ok(s.readLogs(20).some((l) => /self-update is unavailable/.test(l.text)));
});

test('orchestrator: human pill — restartNow fires when idle; cancel disarms and aborts the flow', () => {
  const d = tmp('squad-restart-');
  const { s, o } = setup(d);
  const up = fakeUpdater();
  o.updater = up;
  o.running = false;
  o.restartNow();
  assert.ok(s.restartPending().firedAt, 'idle board: armed and fired immediately');
  assert.ok(up.calls.includes('manual restart'));
  s.bumpRestartPending();
  up.phase = 'draining'; // simulate a flow already in flight
  o.cancelRestart();
  const rp = s.restartPending();
  assert.ok(!rp.scheduledNow && !rp.afterTaskId && !rp.firedAt, 'cancel clears the whole schedule');
  assert.ok(up.calls.includes('cancel'), 'a running flow is aborted too');
});

test('orchestrator: the fired schedule is consumed only on the next boot (Cato #4)', () => {
  const d = tmp('squad-restart-');
  const { s } = setup(d);
  s.setRestartPending({ scheduledNow: true, count: 4, firedAt: new Date().toISOString(), firedCount: 4 });
  const logs0 = s.readLogs(50).length;
  const o2 = new Orchestrator(s);
  clearInterval(o2._wakeTimer); clearInterval(o2._stallTimer); clearInterval(o2._tickTimer);
  assert.equal(s.restartPending(), null, 'boot consumed the fired marker');
  assert.equal(o2.restartState().pendingCount, 0);
  assert.ok(s.readLogs(50).slice(logs0).some((l) => /cleared the consumed schedule \(4 change/.test(l.text)));
});

test('board tool: schedule_restart is PM-only, validates, and announces', () => {
  const d = tmp('squad-restart-');
  const { s, pm, a } = setup(d);
  s.bumpRestartPending();
  assert.throws(() => makeTools(s, a.id).schedule_restart({ now: true }), /scope violation: schedule_restart is PM-only/);
  const r = makeTools(s, pm.id).schedule_restart({ now: true });
  assert.equal(r.scheduled, true);
  assert.equal(r.pendingCount, 1);
  assert.equal(s.restartPending().scheduledNow, true);
  assert.throws(() => makeTools(s, pm.id).schedule_restart({ afterTaskId: 't_nope' }), /unknown afterTaskId/);
  assert.ok(s.readLogs(20).some((l) => l.kind === 'team.change' && /restart once agents drain/.test(l.text)));
  const anchor = s.createTask({ title: 'anchor', assignee: pm.id, createdBy: 'human' });
  const r2 = makeTools(s, pm.id).schedule_restart({ afterTaskId: anchor.id });
  assert.equal(r2.scheduledAfter, anchor.id);
});

// ---- watcher integration: the scheduled restart reuses the drain/test/relaunch flow ----
const SHA1 = 'a'.repeat(40);
function fakeGit(opts = {}) {
  const sha = opts.sha || SHA1;
  return (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'master' };
    if (a === 'rev-parse HEAD') return { code: 0, out: sha };
    if (a.startsWith('fetch')) return { code: 0, out: '' };
    if (a === 'rev-parse origin/master') return { code: 0, out: sha };
    if (a === 'status --porcelain') return { code: 0, out: '' };
    if (a.startsWith('diff --name-only')) return { code: 0, out: '' };
    if (a.startsWith('worktree')) return { code: 0, out: '' };
    return { code: 0, out: '' };
  };
}
function fakeNpm() {
  return (args) => {
    if (args[0] === 'run') return { code: 0, out: 'built' };
    if (args[0] === 'test') return { code: 0, out: 'all pass' };
    return { code: 0, out: '' };
  };
}
const watcherStore = (dir) => ({ dir, settings: { autoRestart: false }, getSettings: () => ({ ...{ autoRestart: false } }), saveSettings: (s) => Object.assign({ autoRestart: false }, s), appendLog: () => {} });

test('watcher: restartScheduled runs the full flow even with auto-restart off; cancel aborts mid-drain', async () => {
  const d = tmp('squad-restart-');
  const relaunches = [];
  const w = new UpdateWatcher({
    store: watcherStore(path.join(d, 'su1')), repoDir: d, pollMs: 3.6e6,
    git: fakeGit(), npm: fakeNpm(),
    relaunch: () => relaunches.push(1), procCount: () => 0,
    setPaused: () => {}, drainTimeoutMs: 100,
  });
  clearInterval(w._timer);
  assert.equal(w.restartScheduled('test reason'), true);
  await waitFor(() => relaunches.length === 1);
  assert.equal(w.phase, 'restarting', 'auto-restart off does not block an explicit schedule');

  const hangs = new UpdateWatcher({
    store: watcherStore(path.join(d, 'su2')), repoDir: d, pollMs: 3.6e6,
    git: fakeGit(), npm: fakeNpm(),
    relaunch: () => relaunches.push(1), procCount: () => 1,
    setPaused: () => {}, drainTimeoutMs: 3.6e6,
  });
  clearInterval(hangs._timer);
  hangs.restartScheduled('test reason');
  await waitFor(() => hangs.phase === 'draining');
  hangs.cancel();
  assert.equal(hangs.phase, 'idle', 'cancel aborts the in-flight flow');
  assert.equal(relaunches.length, 1, 'cancelled flow never relaunches');
});
