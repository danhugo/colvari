// Scheduled restarts (plan t_42f310cf item 1, t_c44a1e9d): a landed merge only bumps the pending
// counter in the store; a restart happens solely through an armed schedule — the PM-only
// schedule_restart tool, the human pill (restartNow/cancelRestart IPC), or the cap safety valve.
// The orchestrator gates new dispatch while armed (anchor exempt), fires once eligible and
// drained, and the UpdateWatcher flow does the actual drain/test/relaunch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execSync } = require('child_process');
const { Store } = require('../src/store');
const { Orchestrator, RESTART } = require('../src/orchestrator');
const { UpdateWatcher } = require('../src/self-update');
const { makeTools } = require('../src/board-tools');
const MG = require('../src/merge-gate');
const WT = require('../src/worktree');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

// Team with the PM as the protected core and one Dev report. Task dispatch is stubbed per test
// (runTask), and wake runs (monitor nudges dispatch them outside runTask) are stubbed too, with a
// printf fake as claudePath so no sweep in this file can ever reach the real claude binary — the
// child-reap leak check (t_92c31037) caught this file doing a real $0.13 wake run via tick().
const fakeClaude = (d) => {
  const f = path.join(d, 'fake-claude.sh');
  fs.writeFileSync(f, '#!/bin/sh\necho \'{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(f, 0o755);
  return f;
};
const setup = (d) => {
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fakeClaude(d) });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  s.addEdge(pm.id, a.id);
  const o = new Orchestrator(s);
  o.wakeRun = async () => {};
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
  const orig = MG.gateMerge;
  const root = tmp('squad-restart-root-');
  try {
    MG.gateMerge = () => ({ merged: true, base: 'master', root, gate: { state: 'green', tests: 1, flaky: [] } });
    s.updateTask(s.createTask({ title: 'x', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w', worktreeBranch: 'squad/x', status: 'done' });
    assert.equal(s.restartPending().count, 3, 'a landed merge counts');
    MG.gateMerge = () => ({ merged: false, refused: true, dirty: ['f'], root });
    s.updateTask(s.createTask({ title: 'y', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w2', worktreeBranch: 'squad/y', status: 'done' });
    MG.gateMerge = () => ({ merged: false, base: 'master', root, gate: { state: 'skipped' } });
    s.updateTask(s.createTask({ title: 'z', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w3', worktreeBranch: 'squad/z', status: 'done' });
    assert.equal(s.restartPending().count, 3, 'refused and empty merges do not count (Cato #6)');
    assert.equal(s.restartPending().since, since);
  } finally { MG.gateMerge = orig; }
});

test('store: merges collapse to ONE pending restart at the latest sha, counted as commits behind (t_7e590e54)', () => {
  const d = tmp('squad-restart-');
  const s = new Store(path.join(d, 'p'));
  s.bumpRestartPending({ sha: 'sha-1', behind: 2 });
  const rp = s.bumpRestartPending({ sha: 'sha-2', behind: 5 });
  assert.equal(rp.count, 5, 'the count is commits behind, not merges seen');
  assert.equal(rp.sha, 'sha-2', 'one pending restart, moved to the latest master sha');
  assert.equal(rp.since, s.restartPending().since, 'since still anchors the first change');
  s.bumpRestartPending({ sha: 'sha-3' }); // no behind known (no buildSha recorded yet)
  assert.equal(s.restartPending().sha, 'sha-3', 'the sha still moves');
  assert.equal(s.restartPending().count, 6, 'without a behind count the plain tally holds');
  s.bumpRestartPending(); // legacy callers keep working
  assert.equal(s.restartPending().count, 7);
});

test('store: a landed merge points the pending restart at the new tip, N commits behind (t_7e590e54)', () => {
  const d = tmp('squad-restart-');
  const s = new Store(path.join(d, 'p'));
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  s.update('project', {}, (m) => { m.buildSha = 'build-1'; return m; });
  const orig = MG.gateMerge;
  const origCB = WT.commitsBehind;
  const root = tmp('squad-restart-root-');
  try {
    MG.gateMerge = () => ({ merged: true, base: 'master', root, sha: 'tip-9', gate: { state: 'green', tests: 1, flaky: [] } });
    WT.commitsBehind = () => 4;
    s.updateTask(s.createTask({ title: 'x', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w', worktreeBranch: 'squad/x', status: 'done' });
  } finally { MG.gateMerge = orig; WT.commitsBehind = origCB; }
  const rp = s.restartPending();
  assert.equal(rp.sha, 'tip-9', 'one restart to the merged tip');
  assert.equal(rp.count, 4, 'commits build-1..tip-9, not "1 merge"');
  MG.gateMerge = () => ({ merged: true, base: 'master', root, gate: { state: 'green', tests: 1, flaky: [] } });
  s.updateTask(s.createTask({ title: 'y', assignee: pm.id, createdBy: 'human' }).id, { worktreePath: '/w2', worktreeBranch: 'squad/y', status: 'done' });
  MG.gateMerge = orig;
  assert.equal(s.restartPending().count, 5, 'a gate result without a sha falls back to the tally');
  assert.equal(s.restartPending().sha, 'tip-9', 'and keeps the last known tip');
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
  assert.deepEqual(st, { pendingCount: 0, since: rp.since, targetSha: null, scheduledAfter: anchor.id, scheduledNow: false, gating: [other.id], busyAgents: [], blockedReason: null, waitingReasons: [] });
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

// ---- idle trigger (t_acae4863): tick() is dead once the Run ends, so an armed schedule sat
// unevaluated for hours while the company was idle. The always-on _restartTimer sweeps it. ----
test('orchestrator: a schedule armed while idle fires via the idle sweep, no Run needed', async () => {
  const d = tmp('squad-restart-');
  const prevMs = RESTART.IDLE_SWEEP_MS;
  RESTART.IDLE_SWEEP_MS = 20;
  let o = null;
  try {
    const res = setup(d); // constructed after the mutation, so the timer runs at 20ms
    o = res.o;
    o.updater = fakeUpdater();
    assert.equal(o.running, false, 'the company is idle: no Run is active');
    res.s.scheduleRestart({ now: true });
    await waitFor(() => o.updater.calls.length === 1, 2000);
    assert.equal(o.running, false, 'the fire never needed the Run loop');
    assert.ok(res.s.restartPending().firedAt);
  } finally {
    RESTART.IDLE_SWEEP_MS = prevMs;
    if (o) clearInterval(o._restartTimer);
  }
});

test('orchestrator: the cap crossing while idle also auto-arms and fires via the sweep', async () => {
  const d = tmp('squad-restart-');
  const prevMs = RESTART.IDLE_SWEEP_MS;
  RESTART.IDLE_SWEEP_MS = 20;
  let o = null;
  try {
    o = setup(d).o;
    o.updater = fakeUpdater();
    const s = o.store;
    s.saveSettings({ restartCap: 2 });
    s.bumpRestartPending(); s.bumpRestartPending();
    await waitFor(() => o.updater.calls.length === 1, 2000);
    assert.equal(s.restartPending().scheduledNow, true, 'the sweep armed the cap restart');
    assert.ok(s.restartPending().firedAt, 'and fired it without any tick');
  } finally {
    RESTART.IDLE_SWEEP_MS = prevMs;
    if (o) clearInterval(o._restartTimer);
  }
});

test('orchestrator: a busy agent holds the fire; restartState exposes who and why', () => {
  const d = tmp('squad-restart-');
  const { s, o, a } = setup(d);
  const up = fakeUpdater();
  o.updater = up;
  o.running = false;
  s.scheduleRestart({ now: true });
  o.procs.set(a.id, { kill() {} }); // busy agent while no Run loop is active
  o.sweepRestart();
  assert.equal(up.calls.length, 0, 'busy: not invoked');
  let st = o.restartState();
  assert.deepEqual(st.busyAgents, ['A']);
  assert.match(st.blockedReason, /1 agent still running: A/);
  assert.deepEqual(st.waitingReasons, ['1 agent still running: A']);
  o.procs.clear();
  o.sweepRestart();
  assert.equal(up.calls.length, 1, 'true idle: invoked');
  st = o.restartState();
  assert.equal(st.blockedReason, null);
  assert.deepEqual(st.busyAgents, []);
  assert.deepEqual(st.waitingReasons, []);
});

test('orchestrator: restartState says when changes are pending but nothing is armed', () => {
  const d = tmp('squad-restart-');
  const { s, o } = setup(d);
  s.saveSettings({ restartCap: 20 });
  s.bumpRestartPending(); s.bumpRestartPending();
  const st = o.restartState();
  assert.equal(st.pendingCount, 2);
  assert.match(st.blockedReason, /not armed — 2 commits behind \(cap 20\)/);
  assert.deepEqual(st.waitingReasons, [st.blockedReason]);
  assert.equal(st.targetSha, null, 'bare bumps carry no target sha');
  s.scheduleRestart({ now: true });
  const st2 = o.restartState();
  assert.equal(st2.blockedReason, null, 'armed and drained: nothing blocks (next sweep fires)');
  assert.deepEqual(st2.waitingReasons, []);
});

test('orchestrator: the not-armed reason names the target sha and the commits behind (t_7e590e54)', () => {
  const d = tmp('squad-restart-');
  const { s, o } = setup(d);
  s.bumpRestartPending({ sha: 'abcdef1234567890', behind: 3 });
  const st = o.restartState();
  assert.equal(st.pendingCount, 3);
  assert.equal(st.targetSha, 'abcdef1234567890', 'the restart targets the latest master sha');
  assert.match(st.blockedReason, /not armed — 3 commits behind at abcdef1 \(cap 20\)/);
  assert.deepEqual(st.waitingReasons, [st.blockedReason]);
});

test('orchestrator: boot records the running build sha so merges can count commits behind (t_7e590e54)', () => {
  const d = tmp('squad-restart-');
  const repo = tmp('squad-restart-repo-');
  execSync(`git -C "${repo}" init -q`);
  execSync(`git -C "${repo}" -c user.email=t@t -c user.name=t commit --allow-empty -qm boot`);
  const sha = execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();
  const s = new Store(path.join(d, 'p'));
  const clear = (o) => { clearInterval(o._wakeTimer); clearInterval(o._stallTimer); clearInterval(o._tickTimer); clearInterval(o._restartTimer); };
  const o = new Orchestrator(s, { repoDir: repo });
  clear(o);
  assert.equal((s.meta() || {}).buildSha, sha, 'meta.buildSha = HEAD at boot');
  execSync(`git -C "${repo}" -c user.email=t@t -c user.name=t commit --allow-empty -qm two`);
  const o2 = new Orchestrator(s, { repoDir: repo });
  clear(o2);
  assert.equal((s.meta() || {}).buildSha, execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim(), 'a moved HEAD is re-recorded');
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
