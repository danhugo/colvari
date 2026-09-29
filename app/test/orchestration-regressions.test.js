// Orchestration regression tests for the parent incidents (t_8308efb6 -> t_dfb0219d).
// Each scenario reproduces one live-log incident and pins the agreed bar:
// (a) wake during a live task run — at most one live run per agent; the wake is queued, deduped
//     and delivered after the run; it still fires when the run is killed mid-flight.
// (b) self-update drain during a long task under repeated merges — the default drain grace is the
//     ~30min hard cap (not the old 5min cut); commits landing mid-drain coalesce into the same
//     restart; a task cut by a drain is never cut again.
// (c) burst of agent pings — an idle agent with unread agent messages is woken on the next sweep,
//     never suppressed (t_9e4b4805 removed the 5-min per-agent gap); the per-pair cap stays the
//     ping-pong guard; human wake paths bypass every auto-wake gate.
// (d) restart skipped by a guard — dispatch stays unpaused, the skipped sha is deferred (not
//     consumed) and retried, and the skip is logged once.
// Seam contract with Devon's orchestrator fix (t_ace9a3b1, amended by t_9e4b4805), agreed on the tasks:
// - WAKE.MIN_GAP_MS anchors only the nudge throttle now; message wakes never consult it.
// - a wake for unread agent messages is never suppressed: no log line matching /suppress/i for it.
// - the drain records its decisions so a task killed by a drain grace is not killed by the next one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, WAKE } = require('../src/orchestrator');
const { UpdateWatcher, readHistory } = require('../src/self-update');
const { makeTools } = require('../src/board-tools');

// Short timings so sweeps fire quickly; the semantics under test are unchanged.
WAKE.SWEEP_MS = 25; WAKE.DEBOUNCE_MS = 35; WAKE.MIN_GAP_MS = 400;
const WAKE0 = { SWEEP_MS: WAKE.SWEEP_MS, DEBOUNCE_MS: WAKE.DEBOUNCE_MS, MIN_GAP_MS: WAKE.MIN_GAP_MS };
test.after(() => {
  WAKE.SWEEP_MS = WAKE0.SWEEP_MS; WAKE.DEBOUNCE_MS = WAKE0.DEBOUNCE_MS;
  if (WAKE0.MIN_GAP_MS === undefined) delete WAKE.MIN_GAP_MS; else WAKE.MIN_GAP_MS = WAKE0.MIN_GAP_MS;
});

const SHA1 = 'a'.repeat(40); const SHA2 = 'b'.repeat(40); const SHA3 = 'c'.repeat(40); const SHA4 = 'd'.repeat(40);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for: ' + fn); await sleep(10); } };
// A run killed by a signal records exitCode null (usage.finishRun); a clean fake exits 0.
const cutRuns = (s, t) => s.listRuns({ taskId: t.id }).filter((r) => r.exitCode == null).length;

const RESULT = `echo '{"type":"result","subtype":"success","session_id":"sess1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}'\n`;
// Fake claude that logs its args and then runs until <release> appears (a held live run).
const heldClaude = (dir, release, extra = '') => {
  const f = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(f, `#!/bin/sh\necho "$*" >> ${dir}/args.txt\n${extra}while [ ! -f ${release} ]; do sleep 0.02; done\n` + RESULT);
  fs.chmodSync(f, 0o755); return f;
};
// Fake claude that logs its args and exits immediately.
const quickClaude = (dir) => {
  const f = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(f, `#!/bin/sh\necho "$*" >> ${dir}/args.txt\n` + RESULT);
  fs.chmodSync(f, 0o755); return f;
};

// Fake git/npm for the UpdateWatcher (same shape as self-update.test.js's harness).
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
  g.setSha = (s) => { sha = s; }; g.setOrigin = (s) => { opts.origin = s; };
  return g;
}
function fakeNpm() {
  return (args) => {
    if (args[0] === 'ci') return { code: 0, out: 'added 0 packages' };
    if (args[0] === 'run') return { code: 0, out: 'built' };
    if (args[0] === 'test') return { code: 0, out: 'all pass' };
    return { code: 0, out: '' };
  };
}

// ---- (a) wake during a live task run ----

test('(a) wake during a live task run: never parallel; the queued wake is deduped and delivered after the run', async (tt) => {
  const d = tmp('squad-reg-a1-');
  const release = path.join(d, 'release');
  const fake = heldClaude(d, release);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, maxConcurrency: 0 });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const task = s.createTask({ title: 'long task', assignee: b.id });
  const o = new Orchestrator(s);
  const ta = makeTools(s, a.id);
  tt.after(() => { try { fs.writeFileSync(release, 'go'); } catch {} o.stop(); });

  o.start();
  await waitFor(() => o.agent(b.id).status === 'working' && o.procs.size === 1);
  assert.equal(s.getTask(task.id).status, 'in_progress');

  // Pings arrive while the task run is live: they must queue, never start a second run.
  ta.send_message({ to: 'B', text: 'ping 1' });
  ta.send_message({ to: 'B', text: 'ping 2' });
  ta.send_message({ to: 'B', text: 'ping 3' });
  await sleep(300); // several sweep + debounce windows
  assert.equal(o.procs.size, 1, 'no second concurrent run for B');
  assert.ok(o.procs.has(b.id), 'the live run is B\'s task run');
  assert.equal(s.listRuns({ nodeId: b.id }).length, 0, 'no run has finished behind the live one');
  assert.equal(s.listMessages({ to: b.id }).filter((m) => !m.read).length, 3, 'pings stay queued while busy');

  // The run ends: the queued wake fires exactly once and carries every accumulated message.
  fs.writeFileSync(release, 'go');
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 2);
  await waitFor(() => s.listMessages({ to: b.id }).every((m) => m.read));
  const args = fs.readFileSync(path.join(d, 'args.txt'), 'utf8');
  assert.match(args, /ping 1/); assert.match(args, /ping 2/); assert.match(args, /ping 3/);
  const wake = s.listRuns({ nodeId: b.id }).find((r) => r.taskId === null);
  assert.ok(wake, 'the second run is a wake run (no taskId)');
  await sleep(300);
  assert.equal(s.listRuns({ nodeId: b.id }).length, 2, 'exactly one wake run, no repeats from later sweeps');
  o.stop();
});

test('(a) the live run is killed mid-flight: the queued wake still fires', async (tt) => {
  const d = tmp('squad-reg-a2-');
  const release = path.join(d, 'release');
  const fake = heldClaude(d, release);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, maxConcurrency: 0 });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  s.createTask({ title: 'task to kill', assignee: b.id });
  const o = new Orchestrator(s);
  const ta = makeTools(s, a.id);
  tt.after(() => { try { fs.writeFileSync(release, 'go'); } catch {} o.stop(); });

  o.start();
  await waitFor(() => o.agent(b.id).status === 'working');
  ta.send_message({ to: 'B', text: 'wake me after the kill' });
  await sleep(200);
  assert.equal(o.procs.size, 1, 'no parallel wake while the task run is live');

  o.stopAgent(b.id, 'killed mid-flight by the test');
  fs.writeFileSync(release, 'go'); // unblock the fake CLI for the upcoming wake run
  await waitFor(() => s.listRuns({ nodeId: b.id }).some((r) => r.taskId === null));
  await waitFor(() => s.listMessages({ to: b.id }).every((m) => m.read));
  assert.ok(fs.readFileSync(path.join(d, 'args.txt'), 'utf8').includes('wake me after the kill'));
  o.stop();
});

// ---- (b) self-update drain during a long task under repeated merges ----

test('(b) default drain grace is the ~30min hard cap, not the old 5min cut', () => {
  const d = tmp('squad-reg-b1-');
  const s = new Store(path.join(d, 'p'));
  const w = new UpdateWatcher({ store: s, repoDir: '/repo', git: fakeGit(), npm: fakeNpm(), relaunch: () => {}, pollMs: 3.6e6 });
  assert.ok(w.drainMs() >= 25 * 60000, `default drain grace should be ~30min, got ${w.drainMs()}ms`);
  w.stop();
});

test('(b) drain cuts the long task once and coalesces commits that land mid-drain into the same restart', async (tt) => {
  const d = tmp('squad-reg-b2-');
  const release = path.join(d, 'release');
  const fake = heldClaude(d, release);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, maxConcurrency: 0, autoRestart: true, useWorktrees: false });
  const x = s.addNode({ name: 'X', role: 'Dev', workdir: path.join(d, 'wx') });
  const t = s.createTask({ title: 'long running task', assignee: x.id });
  const o = new Orchestrator(s);
  tt.after(() => { try { fs.writeFileSync(release, 'go'); } catch {}; try { o.stop(); w.stop(); } catch {} });
  o.start();
  await waitFor(() => o.agent(x.id).status === 'working');

  const git = fakeGit(); const npm = fakeNpm();
  let relaunches = 0; const relaunch = () => { relaunches++; };
  const w = new UpdateWatcher({
    store: s, repoDir: '/repo', pollMs: 3.6e6, minIntervalMs: 0, maxRestartsPerHour: 100,
    git, npm, relaunch,
    procCount: () => o.procs.size, runActive: () => o.running,
    setPaused: (v) => { o.dispatchPaused = v; },
    haltProcs: () => o.haltProcs(300),
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    drainTimeoutMs: 50, // test override: the grace itself is covered by the default-grace test above
  });
  let flipped = false;
  w.on('status', (st) => { if (st.phase === 'draining' && !flipped) { flipped = true; git.setOrigin(SHA3); } });
  await w.tick(); // baseline: SHA1 seen
  git.setOrigin(SHA2);
  await w.tick(); // update #1: drain (cuts the live run) -> ... -> restarting
  assert.equal(w.phase, 'restarting');
  assert.equal(relaunches, 1);
  assert.equal(s.getTask(t.id).status, 'in_progress', 'the cut task stays in_progress for the post-restart resume');
  assert.equal(cutRuns(s, t), 1, 'the drain cut the live task once');
  assert.equal(readHistory(s.dir).filter((h) => h.result === 'restarting')[0].toSha, SHA3,
    'commits landing during the drain are coalesced: the restart targets the newest sha');
  o.stop(); w.stop();
});

test('(b) the resumed task is never cut again by the next update', async (tt) => {
  const d = tmp('squad-reg-b3-');
  const release = path.join(d, 'release');
  const fake = heldClaude(d, release);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, maxConcurrency: 0, autoRestart: true, useWorktrees: false });
  const x = s.addNode({ name: 'X', role: 'Dev', workdir: path.join(d, 'wx') });
  const t = s.createTask({ title: 'long running task', assignee: x.id });
  const o = new Orchestrator(s);
  let w, w2;
  tt.after(() => { try { fs.writeFileSync(release, 'go'); } catch {}; try { o.stop(); w?.stop(); w2?.stop(); } catch {} });
  o.start();
  await waitFor(() => o.agent(x.id).status === 'working');

  const deps = () => ({
    store: s, repoDir: '/repo', pollMs: 3.6e6, minIntervalMs: 0, maxRestartsPerHour: 100,
    git, npm, relaunch: () => { relaunches++; },
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    drainTimeoutMs: 50,
  });
  const git = fakeGit(); const npm = fakeNpm();
  let relaunches = 0;
  w = new UpdateWatcher({ ...deps(), procCount: () => o.procs.size, runActive: () => o.running, setPaused: (v) => { o.dispatchPaused = v; }, haltProcs: () => o.haltProcs(300) });
  await w.tick(); // baseline
  git.setOrigin(SHA2);
  await w.tick(); // update #1 cuts the live run#1
  assert.equal(w.phase, 'restarting');
  assert.equal(cutRuns(s, t), 1, 'update #1 cut the task once');
  o.stop();

  // Reboot: a fresh orchestrator re-dispatches the interrupted task; it holds again on the release file.
  const o2 = new Orchestrator(s);
  o2.start();
  await waitFor(() => o2.agent(x.id).status === 'working');
  assert.ok(o2.procs.has(x.id), 'the interrupted task was re-dispatched after the restart');

  // A second update arrives (repeated merges). It must wait for the marked task, never cut it again.
  w2 = new UpdateWatcher({ ...deps(), procCount: () => o2.procs.size, runActive: () => o2.running, setPaused: (v) => { o2.dispatchPaused = v; }, haltProcs: () => o2.haltProcs(300) });
  await w2.tick(); // fresh watcher baseline (post-restart code is the already-merged sha)
  git.setSha(SHA4); git.setOrigin(SHA4);
  const flow2 = w2.tick().catch(() => {});
  // Once the drain grace is over the fix either already cut (master: regression) or is holding for
  // the marked task: either way it is safe to let the run finish now.
  await waitFor(() => w2.phase !== 'draining' || (w2.drainEndsAt && Date.now() >= Date.parse(w2.drainEndsAt) + 150));
  fs.writeFileSync(release, 'go');
  await waitFor(() => ['idle', 'restarting'].includes(w2.phase));
  await flow2;
  await sleep(200); // run bookkeeping settles
  assert.equal(cutRuns(s, t), 1, 'a task cut by a drain is never cut again');
  assert.equal(relaunches, 2, 'the second update completes on its own once the task finishes');
  o2.stop(); w.stop(); w2.stop();
});

// ---- (c) burst of agent pings / wake churn ----

test('(c) ping bursts: a burst inside the old gap still wakes the idle agent (no suppression window); the pair cap stays the loop guard', async () => {
  const d = tmp('squad-reg-c-');
  const fake = quickClaude(d);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const ta = makeTools(s, a.id);

  ta.send_message({ to: 'B', text: 'burst one 1' });
  ta.send_message({ to: 'B', text: 'burst one 2' });
  ta.send_message({ to: 'B', text: 'burst one 3' });
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 1); // wake #1
  await waitFor(() => o.agent(b.id).status === 'idle'); // ...and it finished (fake exits at once)

  // Second burst immediately after: wake #1 has just reset the old per-agent gap — it wakes anyway
  // (t_9e4b4805: the 5-min suppression window delayed teammate messages while the agent sat idle).
  ta.send_message({ to: 'B', text: 'burst two 1' });
  ta.send_message({ to: 'B', text: 'burst two 2' });
  ta.send_message({ to: 'B', text: 'burst two 3' });
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 2, 'the second burst wakes inside the old gap');
  await waitFor(() => s.listMessages({ to: b.id }).every((m) => m.read), 'one wake delivers the whole burst');
  assert.ok(fs.readFileSync(path.join(d, 'args.txt'), 'utf8').includes('burst two 1'));
  assert.ok(!s.readLogs(Infinity).some((l) => l.nodeId === b.id && /suppress/i.test(l.text)), 'message wakes are never suppressed');
  await sleep(250);
  assert.equal(s.listRuns({ nodeId: b.id }).length, 2, 'no repeat wakes after delivery');

  // The ping-pong guard is the per-pair cap: burst three reaches it, burst four stays queued.
  ta.send_message({ to: 'B', text: 'burst three 1' });
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 3, 'burst three wakes (pair cap hit on this wake)');
  await waitFor(() => s.listMessages({ to: b.id }).every((m) => m.read));
  await waitFor(() => o.agent(b.id).status === 'idle');
  ta.send_message({ to: 'B', text: 'burst four 1' });
  await sleep(400); // sweeps + debounce have all fired by now
  assert.equal(s.listRuns({ nodeId: b.id }).length, 3, 'the pair cap holds the fourth burst (loop protection)');
  assert.ok(s.listMessages({ to: b.id }).some((m) => !m.read), 'the capped burst stays queued in the inbox');
  assert.ok(s.readLogs(Infinity).some((l) => l.nodeId === b.id && /wake cap reached/.test(l.text)), 'the cap is logged');

  // Human wake paths bypass the auto-wake gates entirely.
  o.running = true; // under test is the human bypass, not the Run lifecycle (wakeForHuman requires a live Run)
  const hm = s.sendMessage({ from: 'human', to: b.id, text: 'human asks now' });
  assert.equal(await o.wakeForHuman(b.id, [hm], { reason: 'human message' }), true, 'human wake bypasses the gates');
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 4);
});

// ---- (d) restart skipped by a guard must not stall dispatch (the 22:00 incident) ----

test('(d) a guard-skipped restart leaves dispatch unpaused: the todo is picked up, the sha is deferred and logged once', async () => {
  const d = tmp('squad-reg-d-');
  const fake = quickClaude(d);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, maxConcurrency: 0, autoRestart: true });
  const x = s.addNode({ name: 'X', role: 'Dev', workdir: path.join(d, 'wx') });
  const t = s.createTask({ title: 'unblocked todo', assignee: x.id });
  const o = new Orchestrator(s);
  const pauses = [];
  const git = fakeGit(); const npm = fakeNpm();
  const w = new UpdateWatcher({
    store: s, repoDir: '/repo', pollMs: 3.6e6, maxRestartsPerHour: 3,
    git, npm, relaunch: () => {},
    procCount: () => o.procs.size, runActive: () => o.running,
    setPaused: (v) => { pauses.push(v); o.dispatchPaused = v; },
    sleep: () => new Promise((r) => setTimeout(r, 2)),
  });
  await w.tick(); // baseline: SHA1 seen, nothing to do
  git.setSha(SHA2); git.setOrigin(SHA2);
  w.lastRestartAt = Date.now() - 6 * 60000; // "the last restart was 6min ago" (< the 10min guard)
  await w.tick(); // the skip: defer, never pause
  assert.equal(w.phase, 'idle', 'a guard skip never enters the update flow');
  assert.equal(w.status().deferredTo, SHA2, 'the skipped sha is deferred for retry, not consumed');
  assert.ok(!o.dispatchPaused, 'dispatch is not paused after the skip');
  assert.ok(pauses.every((v) => v === false), 'setPaused(true) is never called for a guard skip');

  o.start(); // unblocked todo work is picked up as usual
  await waitFor(() => s.getTask(t.id).status === 'in_progress');

  await w.tick(); // still inside the guard: stays deferred, no second skip log
  assert.equal(w.status().deferredTo, SHA2);
  const skips = s.readLogs(Infinity).filter((l) => /skipping/.test(l.text));
  assert.equal(skips.length, 1, 'the skip is logged once, not on every poll');
  o.stop(); w.stop();
});
