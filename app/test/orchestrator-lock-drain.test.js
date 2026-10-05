// t_ace9a3b1 — the four parent-log incidents cannot recur:
// (a) at most one live run per agent (wakes queue while a run is live; the lock releases on crash/kill);
// (b) the self-update drain never cuts the same task twice (persisted drainCuts) and a cut wake run
//     re-queues its messages;
// (c) unread agent messages wake an idle agent on the next sweep — never suppressed (t_9e4b4805);
//     the human path bypasses every auto-wake gate;
// (d) a deferred/skipped restart leaves dispatch unpaused — todo tasks are picked up regardless.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { Orchestrator, WAKE, STALL } = require('../src/orchestrator');
const { UpdateWatcher } = require('../src/self-update');

// Short timings so sweeps fire quickly; the semantics under test are unchanged.
WAKE.SWEEP_MS = 30; WAKE.DEBOUNCE_MS = 50; WAKE.MIN_GAP_MS = 400;
STALL.SWEEP_MS = 40;
test.after(() => { WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; WAKE.MIN_GAP_MS = 5 * 60 * 1000; STALL.SWEEP_MS = 5000; });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (dir, body) => { const f = path.join(dir, 'fake-claude.sh'); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
const RESULT = `echo '{"type":"result","subtype":"success","session_id":"sess1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}'\n`;
const waitFor = async (fn, what, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- (a) single run per agent ----

// Run records persist only when a run CLOSES, and the first spawn in a process is slow (~0.4s here):
// assertions about WHEN a wake dispatched must key off the synchronous woken_by_message event, not
// store.listRuns. Records are only read at the very end (for prompt/args content), with generous waits.
const trackWakes = (o) => { const woken = []; o.on('woken_by_message', (w) => woken.push(w)); return woken; };

test('single run per agent: a message during a live task run queues; the wake fires when the run ends', async () => {
  const d = tmp('squad-lock-');
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\nexec sleep 0.7\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const woken = trackWakes(o);
  const task = s.createTask({ title: 'worker task', assignee: b.id });
  o.start();
  await waitFor(() => o.procs.size === 1 && o.agent(b.id).taskId === task.id, 'task run live');
  makeTools(s, a.id).send_message({ to: 'B', text: 'please also look at the flaky test' });
  await sleep(120);
  assert.equal(o.procs.size, 1, 'no parallel run while the task run is live');
  assert.equal(woken.length, 0, 'no wake dispatch while busy');
  assert.equal(s.listMessages({ to: b.id }).filter((m) => !m.read).length, 1, 'the message stays queued unread');
  // the last-chance lock: calling the dispatcher directly must refuse too
  await o.dispatchWake(b.id);
  assert.equal(o.procs.size, 1, 'wakeRun entry lock refuses a second live run');
  await waitFor(() => woken.length === 1, 'queued wake fired after the task run ended');
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 2, 'both runs persisted');
  assert.match(fs.readFileSync(argsLog, 'utf8'), /please also look at the flaky test/, 'the queued wake delivers the message');
  assert.equal(s.listMessages({ to: b.id }).some((m) => !m.read), false, 'delivered messages are read');
  assert.equal(o.agent(b.id).status, 'idle');
  o.stop();
});

test('single run per agent: killing the live run releases the lock and the queued wake fires', async () => {
  const d = tmp('squad-lock-');
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\nexec sleep 30\n`);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const woken = trackWakes(o);
  s.createTask({ title: 'long task', assignee: b.id });
  o.start();
  await waitFor(() => o.procs.size === 1, 'task run live');
  makeTools(s, a.id).send_message({ to: 'B', text: 'wake me when free' });
  await sleep(120);
  assert.equal(o.procs.size, 1, 'no parallel wake while busy');
  assert.equal(woken.length, 0, 'no wake dispatch while busy');
  o.procs.get(b.id).kill('SIGTERM'); // the run dies mid-flight; the lock must go with it
  await waitFor(() => woken.length === 1, 'queued wake fired after the kill');
  // the wake's args were written the moment its process started
  await waitFor(() => { try { return /wake me when free/.test(fs.readFileSync(argsLog, 'utf8')); } catch { return false; } }, 'queued wake delivers the message');
  const runs = s.listRuns({ nodeId: b.id });
  assert.equal(runs.length, 1, 'the killed task run persisted; the wake run is still live');
  assert.equal(o.procs.size, 1, 'the wake run is the one live run');
  o.stop();
});

test('single run per agent: a hung wake run is stopped by the stall watchdog (lock released on timeout)', async () => {
  const d = tmp('squad-lock-');
  const fake = fakeClaude(d, `exec sleep 30\n`);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, stallTimeoutMin: 1 / 60000 });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  makeTools(s, a.id).send_message({ to: 'B', text: 'start a wake run that hangs' });
  await waitFor(() => o.procs.size === 1 && o.agent(b.id).status === 'working', 'wake run live');
  await waitFor(() => o.agent(b.id).status === 'idle' && o.procs.size === 0, 'stall watchdog stopped the hung wake run');
  assert.ok(s.readLogs().some((l) => /wake run silent/.test(l.text)), 'the wake-run stall is logged');
  o.stop();
});

// ---- (c) per-agent wake debounce ----

test('wake: a burst inside the old per-agent gap still wakes the idle agent on the next sweep (no suppression window)', async () => {
  const d = tmp('squad-lock-');
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const woken = trackWakes(o);
  const ta = makeTools(s, a.id);
  // a wide gap so burst two lands squarely inside the old MIN_GAP_MS window (t_9e4b4805: it must
  // wake anyway — the old 5-minute suppression delayed teammate messages while the agent sat idle)
  WAKE.MIN_GAP_MS = 1500;
  try {
    ta.send_message({ to: 'B', text: 'first ping' });
    await waitFor(() => woken.length === 1, 'first wake fires');
    assert.equal(s.listMessages({ to: b.id }).every((m) => m.read), true);
    await waitFor(() => o.agent(b.id).status === 'idle' && !o.procs.has(b.id), 'first wake run over');
    ta.send_message({ to: 'B', text: 'second ping within the old gap' });
    await waitFor(() => { const w = o.snapshotSlim().agents[b.id].wakePending; return w && w.count === 1; }, 'pending state exposed while the burst coalesces');
    assert.equal(o.snapshotSlim().agents[b.id].wakePending.suppressed, false, 'message wakes are never suppressed');
    await waitFor(() => woken.length === 2, 'the debounced wake fires on the next sweep despite the fresh gap');
    await waitFor(() => s.listRuns({ nodeId: b.id }).length === 2, 'both wake runs persisted');
    assert.match(fs.readFileSync(argsLog, 'utf8'), /second ping within the old gap/);
    assert.ok(!s.readLogs().some((l) => /wake suppressed/.test(l.text)), 'wakes for unread agent messages are never suppressed');
    assert.equal(o.snapshotSlim().agents[b.id].wakePending, undefined, 'pending label cleared after dispatch');
  } finally { WAKE.MIN_GAP_MS = 400; }
  o.stop();
}, { timeout: 20000 });

test('wake debounce: human/system wakes bypass the per-agent interval', async () => {
  const d = tmp('squad-lock-');
  const fake = fakeClaude(d, RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' }); const c = s.addNode({ name: 'C', role: 'Dev' });
  s.addEdge(a.id, b.id); s.addEdge(c.id, b.id);
  const o = new Orchestrator(s);
  const woken = trackWakes(o);
  // c's long task keeps the Run alive; b stays free for the two wakes. A separate script FILE:
  // fakeClaude() writes a fixed name, so overwriting it would swap the wake run's CLI too.
  s.createTask({ title: 'run keeper', assignee: c.id });
  const keep = fakeClaude(fs.mkdirSync(path.join(d, 'keeper'), { recursive: true }), 'exec sleep 30\n');
  s.saveSettings({ claudePath: keep });
  o.start();
  await waitFor(() => o.procs.size === 1, 'run keeper live');
  s.saveSettings({ claudePath: fake });
  makeTools(s, a.id).send_message({ to: 'B', text: 'agent ping (starts the interval)' });
  await waitFor(() => woken.length === 1, 'agent wake dispatched (interval now running)');
  await waitFor(() => o.agent(b.id).status === 'idle' && !o.procs.has(b.id), 'agent wake run over');
  const m = s.sendMessage({ from: 'human', to: b.id, text: 'human question — must bypass the debounce' });
  const ok = await o.wakeForHuman(b.id, [m], { reason: 'human message' });
  assert.equal(ok, true, 'the human wake fired inside the debounce window');
  await waitFor(() => woken.length === 2, 'human wake run dispatched');
  await waitFor(() => s.readLogs().some((l) => /waking for human message/.test(l.text)), 'the bypass is logged');
  o.stop();
});

// ---- (b) drain cut-once protection ----

test('drain: haltProcs cuts a never-cut task, persists drainCuts, and never cuts that task again', async () => {
  const d = tmp('squad-lock-');
  const fake = fakeClaude(d, `exec sleep 30\n`);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  const ta = s.createTask({ title: 'fresh task', assignee: a.id });
  const tb = s.createTask({ title: 'already-cut task', assignee: b.id });
  const o = new Orchestrator(s);
  o.start();
  await waitFor(() => o.procs.size === 2 && o.procs.get(a.id) && o.procs.get(b.id) && o.procs.get(a.id).pid && o.procs.get(b.id).pid, 'both tasks running (real children, not placeholders)');
  s.updateTask(tb.id, { drainCuts: 1 }); // persisted marker from a previous restart's cut
  const bProc = o.procs.get(b.id);
  await o.haltProcs(200);
  assert.equal(o.procs.has(b.id), true, 'the already-cut task keeps running');
  assert.equal(o.procs.get(b.id), bProc, 'its process was never signalled');
  assert.equal(s.getTask(tb.id).drainCuts, 1, 'no second cut');
  assert.equal(s.getTask(ta.id).drainCuts, 1, 'the fresh task was cut once and the cut persisted');
  assert.equal(o.drainCutNodes.has(a.id), true);
  assert.equal(o.drainCutNodes.has(b.id), false);
  assert.ok(s.readLogs().some((l) => /not cutting it again/.test(l.text)), 'the spare decision is logged');
  assert.equal(s.getTask(ta.id).status, 'in_progress', 'a cut task stays re-dispatchable, not parked');
  // a second halt within the same drain cuts nothing
  const logsBefore = s.readLogs().filter((l) => /cutting "/.test(l.text)).length;
  await o.haltProcs(200);
  assert.equal(s.readLogs().filter((l) => /cutting "/.test(l.text)).length, logsBefore, 'no additional cuts');
  assert.equal(s.getTask(tb.id).drainCuts, 1);
  o.stop();
});

test('drain: cutting a wake run puts its messages back in the unread inbox', async () => {
  const d = tmp('squad-lock-');
  const fake = fakeClaude(d, `exec sleep 30\n`);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const woken = trackWakes(o);
  makeTools(s, a.id).send_message({ to: 'B', text: 'wake run that will be cut' });
  await waitFor(() => woken.length === 1 && o.procs.size === 1 && o.agent(b.id).status === 'working', 'wake run live');
  assert.equal(s.listMessages({ to: b.id }).every((m) => m.read), true, 'marked read at dispatch');
  // Freeze the wake sweep: since t_9e4b4805 there is no suppression window, so a live sweep would
  // re-wake B and re-mark the re-queued messages read within milliseconds of the cut.
  clearInterval(o._wakeTimer);
  for (const t of o.wakeTimers.values()) clearTimeout(t.timer);
  await o.haltProcs(200);
  assert.equal(s.listMessages({ to: b.id }).some((m) => !m.read), true, 'the cut wake run re-queues its messages for the post-restart sweep');
  assert.equal(o.drainCutNodes.has(b.id), true);
  o.clearDrainCuts(); o.stop();
});

// ---- (b) + (d) watcher wired to a live orchestrator, like main.js does ----

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40);
function fakeGit(opts = {}) {
  let sha = opts.sha || SHA1;
  const g = (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'master' };
    if (a === 'rev-parse HEAD') return { code: 0, out: sha };
    if (a.startsWith('fetch')) return { code: 0, out: '' };
    if (a === 'rev-parse origin/master') return { code: 0, out: opts.origin || sha };
    if (a === 'status --porcelain') return { code: 0, out: '' };
    if (a.startsWith('merge --ff-only')) { sha = args[2]; return { code: 0, out: '' }; }
    if (a.startsWith('diff --name-only')) return { code: 0, out: '' };
    if (a.startsWith('worktree')) return { code: 0, out: '' };
    return { code: 0, out: '' };
  };
  g.setOrigin = (s2) => { opts.origin = s2; };
  g.sha = () => sha;
  return g;
}
const fakeNpm = () => { const n = (args) => ({ code: 0, out: 'ok' }); return n; };

test('22:00 regression: a deferred (skipped) restart leaves dispatch unpaused — todo tasks are picked up', async () => {
  const d = tmp('squad-lock-');
  const fake = fakeClaude(d, RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, autoRestart: true });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // the hand-offs complete via reviewer pickup
  s.addEdge(a.id, rev.id, 'review'); s.addEdge(b.id, rev.id, 'review');
  s.createTask({ title: 'one', assignee: a.id });
  s.createTask({ title: 'two', assignee: b.id });
  const o = new Orchestrator(s);
  const git = fakeGit();
  const paused = [];
  const w = new UpdateWatcher({
    store: s, repoDir: '/repo', pollMs: 3.6e6, minIntervalMs: 60 * 60 * 1000, maxRestartsPerHour: 3,
    git, npm: fakeNpm(),
    relaunch: () => { w.relaunched = (w.relaunched || 0) + 1; },
    procCount: () => o.procs.size,
    runActive: () => o.running,
    setPaused: (v) => { paused.push(v); o.dispatchPaused = v; if (!v) { o.clearDrainCuts(); setImmediate(() => o.tick()); } },
    haltProcs: () => o.haltProcs(),
    drainTimeoutMs: 5000,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  w.lastRestartAt = Date.now(); // a restart just happened: the min-interval guard is tripped
  await w.tick(); // baseline: sha recorded, nothing else
  git.setOrigin(SHA2); // new commits arrive
  await w.tick();
  assert.equal(w.phase, 'idle', 'a deferred update is not a pending one');
  assert.equal(w.status().deferredTo, SHA2);
  assert.deepEqual(paused, [], 'the skip never paused dispatch');
  assert.equal(o.dispatchPaused, false);
  // THE regression: with the update still deferred, unblocked todo tasks get dispatched.
  o.start();
  await waitFor(() => s.listTasks().every((t) => t.status === 'done'), 'both todo tasks ran to done while the update sat deferred');
  assert.deepEqual(paused, [], 'still no pause');
  // the guard clears: the deferred update proceeds, consumes the defer marker, and restarts.
  w.lastRestartAt = 0;
  await w.tick();
  while (w._busy) await new Promise((r) => setTimeout(r, 2));
  assert.equal(w.relaunched, 1, 'the deferred update restarted the app');
  assert.equal(w.status().deferredTo, null, 'the pending-update marker is cleared');
  assert.equal(w.fromSha, SHA1);
  o.stop(); w.stop();
});

test('deferred updates coalesce to the newest sha, keeping the first-seen from sha', async () => {
  const d = tmp('squad-lock-');
  const s = new Store(path.join(d, 'p')); s.saveSettings({ autoRestart: true });
  const git = fakeGit();
  const w = new UpdateWatcher({
    store: s, repoDir: '/repo', pollMs: 3.6e6, minIntervalMs: 60 * 60 * 1000, maxRestartsPerHour: 3,
    git, npm: fakeNpm(),
    relaunch: () => { w.relaunched = (w.relaunched || 0) + 1; },
    drainTimeoutMs: 1000,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  w.lastRestartAt = Date.now();
  await w.tick(); // baseline SHA1
  git.setOrigin(SHA2);
  await w.tick();
  assert.equal(w.status().deferredTo, SHA2);
  git.setOrigin(SHA3); // even newer commits land while still deferred
  await w.tick();
  assert.equal(w.status().deferredTo, SHA3, 'the deferred update tracks the newest sha');
  w.lastRestartAt = 0;
  await w.tick();
  while (w._busy) await new Promise((r) => setTimeout(r, 2));
  assert.equal(w.fromSha, SHA1, 'from stays the sha that was actually running when the commits were first seen');
  assert.equal(w.toSha, SHA3, 'the update goes to the newest sha');
  assert.equal(w.relaunched, 1);
  w.stop();
});

test('drain grace defaults to 30 minutes', async () => {
  const d = tmp('squad-lock-');
  const w = new UpdateWatcher({ store: { dir: d, getSettings: () => ({}) } });
  assert.equal(w.drainMs(), 30 * 60000);
  w.stop();
});
