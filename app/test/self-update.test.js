const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UpdateWatcher, bootResume, markBootOk, readRestartState, writeRestartState, clearRestartState, readHistory, appendHistory, requestFile } = require('../src/self-update');
const { makeTools } = require('../src/board-tools');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

function fakeStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'su-store-'));
  const settings = { autoRestart: opts.autoRestart !== false };
  const store = { dir, settings, logs: [],
    getSettings: () => ({ ...settings }),
    saveSettings: (s) => { Object.assign(settings, s); return { ...settings }; },
    appendLog: (l) => store.logs.push(l) };
  return store;
}
// plain store without history helpers reading from a chosen dir
const bareStore = (dir) => ({ dir, settings: { autoRestart: true }, logs: [], getSettings: () => ({ autoRestart: true }), saveSettings: (s) => Object.assign({ autoRestart: true }, s), appendLog: (l) => {} });

// Fake git: understands just enough of the watcher's commands; opts switch failure modes.
function fakeGit(opts = {}) {
  let sha = opts.sha || SHA1;
  const calls = [];
  const g = (args) => {
    const a = args.join(' ');
    calls.push(a);
    if (a === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'master' };
    if (a === 'rev-parse HEAD') return { code: 0, out: sha };
    if (a.startsWith('fetch')) return { code: 0, out: '' };
    if (a === 'rev-parse origin/master') return opts.noOrigin ? { code: 1, out: '' } : { code: 0, out: opts.origin || sha };
    if (a === 'status --porcelain') return { code: 0, out: opts.dirty ? ' M app/src/x.js' : '' };
    if (a.startsWith('merge --ff-only')) { if (opts.ffFails) return { code: 1, out: 'CONFLICT' }; sha = args[2]; return { code: 0, out: '' }; }
    if (a.startsWith('diff --name-only')) return { code: 0, out: opts.lockChanged ? 'package-lock.json' : '' };
    if (a.startsWith('worktree')) return { code: 0, out: '' };
    if (a.startsWith('reset --hard')) { if (opts.resetFails) return { code: 1, out: 'nope' }; sha = args[2]; return { code: 0, out: '' }; }
    if (a.startsWith('rev-list --count')) {
      if (opts.revListFails) return { code: 1, out: '' };
      const [from, to] = args[2].split('..');
      return { code: 0, out: String(from === to ? 0 : (opts.behind != null ? opts.behind : 1)) };
    }
    return { code: 0, out: '' };
  };
  g.calls = calls; g.sha = () => sha; g.setSha = (s) => { sha = s; }; g.setOrigin = (s) => { opts.origin = s; }; g.setDirty = (v) => { opts.dirty = v; };
  return g;
}

function fakeNpm(opts = {}) {
  const calls = [];
  const n = (args, cwd) => {
    calls.push([args.join(' '), cwd]);
    if (args[0] === 'ci') return { code: 0, out: 'added 0 packages' };
    if (args[0] === 'run') return { code: opts.buildFails ? 1 : 0, out: opts.buildFails ? 'build error' : 'built' };
    if (args[0] === 'test') return { code: opts.testFails ? 1 : 0, out: opts.testFails ? 'tests failed badly' : 'all pass' };
    return { code: 0, out: '' };
  };
  n.calls = calls;
  return n;
}

// Watcher with fake deps and instant timing. `agents` counts down how many draining polls wait for.
function makeWatcher({ store = fakeStore(), git, npm, npmDir, agents = 0, wasRunning = false, relaunch, sleep, haltProcs, drainTimeoutMs, testRun, testTimeoutMs } = {}) {
  const npmF = npm || fakeNpm();
  const gitF = git || fakeGit();
  let ticks = 0;
  const w = new UpdateWatcher({
    store, repoDir: '/repo', npmDir, pollMs: 3.6e6,
    minIntervalMs: 10 * 60 * 1000, maxRestartsPerHour: 3,
    git: gitF, npm: npmF,
    relaunch: relaunch || (() => { w.relaunched = (w.relaunched || 0) + 1; }),
    procCount: () => Math.max(0, agents - ticks++),
    runActive: () => wasRunning,
    sleep: sleep || (() => new Promise((r) => setTimeout(r, 1))),
    haltProcs: haltProcs || (() => Promise.resolve()),
    drainTimeoutMs, testRun, testTimeoutMs,
  });
  w.gitF = gitF; w.npmF = npmF;
  return w;
}
const drain = async (w) => { await w.tick(); while (w._busy) await new Promise((r) => setTimeout(r, 2)); };

test('no restart when auto-restart is off (new commits are just recorded)', async () => {
  const git = fakeGit();
  const w = makeWatcher({ store: fakeStore({ autoRestart: false }), git });
  await drain(w); // baseline
  git.setSha(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.strictEqual(w._seenSha, SHA2);
});

test('happy path: pending -> draining -> testing -> restarting, state + history persisted, relaunch called', async () => {
  const git = fakeGit({ lockChanged: true });
  const npm = fakeNpm();
  const w = makeWatcher({ git, npm, agents: 2, wasRunning: true });
  assert.strictEqual(w.status().autoRestart, true);
  await drain(w); // baseline: origin at HEAD, nothing to do
  git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1);
  // fast-forwarded, lockfile diff triggered npm ci, tests ran in the throwaway worktree
  assert.ok(git.calls.some((c) => c.startsWith('merge --ff-only ' + SHA2)));
  assert.ok(npm.calls.some(([a]) => a === 'ci'));
  const wtTest = npm.calls.find(([a]) => a === 'test');
  assert.ok(wtTest && /squad-selfupdate/.test(wtTest[1]), 'npm test runs in the temp worktree, not the live tree');
  const st = readRestartState(w.store.dir);
  assert.strictEqual(st.phase, 'restarting');
  assert.strictEqual(st.wasRunning, true);
  assert.strictEqual(st.fromSha, SHA1);
  assert.strictEqual(st.toSha, SHA2);
  assert.strictEqual(w.reason, w.status().reason);
  assert.deepStrictEqual(readHistory(w.store.dir).slice(-1)[0], { ts: st.ts, reason: w.reason, fromSha: SHA1, toSha: SHA2, result: 'restarting' });
  assert.strictEqual(w.status().history[0].result, 'restarting');
});

// The orchestrator auto-merges to master, so by detection time local HEAD is usually already at
// the new sha; fromSha must be the previously seen sha (what the app was running), not the new one.
test('detection records the previous _seenSha as fromSha even when local is already merged', async () => {
  const git = fakeGit();
  const w = makeWatcher({ git });
  await drain(w); // baseline: seen SHA1
  git.setSha(SHA2); git.setOrigin(SHA2); // auto-merge landed locally before the next poll
  await drain(w);
  assert.strictEqual(w.phase, 'restarting');
  const st = readRestartState(w.store.dir);
  assert.strictEqual(st.fromSha, SHA1, 'fromSha is the previous _seenSha, not the already-merged local HEAD');
  assert.strictEqual(st.toSha, SHA2);
  assert.deepStrictEqual(readHistory(w.store.dir).slice(-1)[0], { ts: st.ts, reason: w.reason, fromSha: SHA1, toSha: SHA2, result: 'restarting' });
  assert.ok(w.store.logs.some((l) => /\(aaaaaaa -> bbbbbbb\)/.test(l.text)), 'log shows old -> new');
});

test('dirty main checkout: abort, no restart, activity feed entry', async () => {
  const git = fakeGit({ dirty: true });
  const w = makeWatcher({ git });
  await drain(w);
  git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.match(w.status().lastError, /uncommitted changes/);
  assert.match(readHistory(w.store.dir).slice(-1)[0].result, /^aborted/);
  assert.ok(w.store.logs.some((l) => l.kind === 'error' && /self-update aborted/.test(l.text)));
});

test('test failure on new code: abort, no restart', async () => {
  const npm = fakeNpm({ testFails: true });
  const git = fakeGit();
  const w = makeWatcher({ git, npm });
  await drain(w);
  git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.match(w.status().lastError, /tests failed/);
});

test('build failure: abort before testing, no restart', async () => {
  const npm = fakeNpm({ buildFails: true });
  const git = fakeGit();
  const w = makeWatcher({ git, npm });
  await drain(w);
  git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.match(w.status().lastError, /build failed/);
  assert.ok(!npm.calls.some(([a]) => a === 'test'), 'tests are not run when the build already failed');
});

test('restart during wait: draining waits for running agents (within the grace) then proceeds', async () => {
  const git = fakeGit();
  let halted = 0;
  const w = makeWatcher({ git, agents: 2, sleep: () => new Promise((r) => setTimeout(r, 30)), haltProcs: async () => { halted++; } });
  await drain(w);
  git.setOrigin(SHA2);
  const p = w.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(w.phase, 'draining');
  assert.ok(w.waitingOn > 0, 'status shows agents still running');
  assert.ok(!w.relaunched);
  await p; await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1);
  assert.strictEqual(halted, 0, 'runs that finish inside the grace are never halted');
});

// One long run used to freeze the whole team: dispatch is paused during the drain, so a 12+ minute
// run left 13 todo tasks waiting behind it indefinitely. The drain now has a grace deadline
// (drainTimeoutMin, default 30): past it the stragglers that were never cut before are halted and
// the update proceeds — their tasks resume after the restart (reconcileOrphanedTasks + session
// resume), wasRunning stays true. A task already cut once is spared and waited for indefinitely.
test('drain grace: runs outlasting the deadline are halted and the update proceeds', async () => {
  let t = Date.now();
  let halted = 0;
  const git = fakeGit();
  const w = makeWatcher({ git, agents: 1e9, wasRunning: true, sleep: async () => { t += 60 * 1000; }, haltProcs: async () => { halted++; } });
  w.now = () => t;
  await drain(w); // baseline
  git.setOrigin(SHA2);
  await drain(w); // 5 one-minute drain polls hit the 5min default grace
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(halted, 1, 'the stragglers were stopped at the deadline');
  assert.strictEqual(w.relaunched, 1);
  assert.ok(w.store.logs.some((l) => /drain grace \(30min\) over with \d+ run\(s\) still active/.test(l.text)), 'the cut is logged');
  assert.strictEqual(readRestartState(w.store.dir).wasRunning, true, 'the Run still resumes after the restart');
});

test('drainTimeoutMin 0 restores wait-forever: no halt however long the runs take', async () => {
  let t = Date.now();
  let halted = 0;
  const store = fakeStore();
  store.settings.drainTimeoutMin = 0;
  const git = fakeGit();
  const w = makeWatcher({ store, git, agents: 3, sleep: async () => { t += 60 * 60 * 1000; }, haltProcs: async () => { halted++; } });
  w.now = () => t;
  await drain(w);
  git.setOrigin(SHA2);
  await drain(w); // three hours of drain polls: no cut, runs finish on their own
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1);
  assert.strictEqual(halted, 0);
});

test('dirty main checkout aborts before draining: no drain pause, no halt', async () => {
  const git = fakeGit({ dirty: true });
  const pauses = [];
  const phases = [];
  const w = makeWatcher({ git, agents: 1e9 });
  w.setPaused = (v) => pauses.push(v);
  w.on('status', (st) => phases.push(st.phase));
  await drain(w); // baseline (not dirty yet)
  git.setOrigin(SHA2);
  git.setDirty(true); // a dev starts editing before this poll
  await drain(w);
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.ok(!phases.includes('draining'), 'no drain wait before the dirty abort');
  // Entering pending pauses dispatch (as always) and the abort immediately unpauses: the doomed
  // update never reaches the long draining pause.
  assert.deepStrictEqual(pauses, [true, false]);
  assert.match(w.status().lastError, /uncommitted changes/);
});

test('restart guards: min interval and max restarts per hour skip the update', async () => {
  // restart 1min ago < 10min min interval -> skip
  const store = fakeStore();
  appendHistory(store.dir, { ts: new Date(Date.now() - 60 * 1000).toISOString(), reason: 'x', fromSha: SHA1, toSha: SHA1, result: 'restarting' });
  const git = fakeGit();
  const w = makeWatcher({ store, git });
  await drain(w);
  git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.ok(store.logs.some((l) => /min\); skipping/.test(l.text)));
  // 4 restarts 11-14min ago: interval passes, hourly rate (>=3) skips
  const store2 = fakeStore();
  for (const m of [11, 12, 13, 14]) appendHistory(store2.dir, { ts: new Date(Date.now() - m * 60000).toISOString(), reason: 'x', fromSha: SHA1, toSha: SHA1, result: 'restarting' });
  const git2 = fakeGit();
  const w2 = makeWatcher({ store: store2, git: git2 });
  await drain(w2);
  git2.setOrigin(SHA2);
  await drain(w2);
  assert.strictEqual(w2.phase, 'idle');
  assert.ok(!w2.relaunched);
  assert.ok(store2.logs.some((l) => /restart guard/.test(l.text)));
});

// 2026-09-29 live regression: a cooldown skip consumed the new sha (_seenSha advanced before the
// guards), so the skipped commits never triggered again — the app stayed on old code for good.
// A guard skip must defer the update and retry it once the guard clears.
test('cooldown-skipped commits are retried once the min interval passes', async () => {
  let t = Date.now();
  const store = fakeStore();
  appendHistory(store.dir, { ts: new Date(t - 60 * 1000).toISOString(), reason: 'x', fromSha: SHA1, toSha: SHA1, result: 'restarting' });
  const git = fakeGit();
  const w = makeWatcher({ store, git });
  w.now = () => t;
  await drain(w); // baseline: seen SHA1
  git.setOrigin(SHA2);
  await drain(w); // last restart 1min ago: skipped and deferred, not consumed
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.ok(store.logs.some((l) => /min\); skipping/.test(l.text) && /retry/.test(l.text)));
  assert.strictEqual(w.status().deferredTo, SHA2, 'the update is parked for retry');
  const logCount = store.logs.length;
  t += 60 * 1000;
  await drain(w); // still cooling down: no restart, no repeated skip log
  assert.ok(!w.relaunched);
  assert.strictEqual(store.logs.length, logCount, 'no skip-log spam while the guard holds');
  t += 10 * 60 * 1000;
  await drain(w); // cooldown over: the same commits now go through
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1);
  const st = readRestartState(w.store.dir);
  assert.strictEqual(st.fromSha, SHA1, 'fromSha is what ran before the deferred commits');
  assert.strictEqual(st.toSha, SHA2);
  assert.strictEqual(w.status().deferredTo, null);
});

test('hour-guard-skipped commits are retried once the rate window clears', async () => {
  let t = Date.now();
  const store = fakeStore();
  for (const m of [11, 12, 13, 14]) appendHistory(store.dir, { ts: new Date(t - m * 60000).toISOString(), reason: 'x', fromSha: SHA1, toSha: SHA1, result: 'restarting' });
  const git = fakeGit();
  const w = makeWatcher({ store, git });
  w.now = () => t;
  await drain(w);
  git.setOrigin(SHA2);
  await drain(w); // interval passes but 4 restarts/hour: deferred
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.ok(store.logs.some((l) => /restart guard/.test(l.text)));
  assert.strictEqual(w.status().deferredTo, SHA2);
  t += 50 * 60 * 1000; // all four restarts fall out of the 1h window
  await drain(w);
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1);
  assert.strictEqual(readRestartState(w.store.dir).toSha, SHA2);
});

test('restartNow bypasses the guards', async () => {
  const store = fakeStore();
  appendHistory(store.dir, { ts: new Date().toISOString(), reason: 'x', fromSha: SHA1, toSha: SHA1, result: 'restarting' });
  const git = fakeGit();
  const w = makeWatcher({ store, git });
  git.setOrigin(SHA2);
  w.restartNow();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1);
});

// ---- t_7426095a: never restart onto the commit that is already running ----
// The incident boot launched on f83c8cd and scheduled f83c8cd -> f83c8cd ("21 changes" was a stale
// pending count): the team was paused and the app froze on the test step for code already live.

test('same-commit restart is skipped: repeated scheduled requests at the running sha are no-ops', async () => {
  const git = fakeGit();
  const w = makeWatcher({ git });
  assert.strictEqual(w.bootSha, SHA1, 'the running sha is captured from git at watcher creation');
  assert.strictEqual(w.status().bootSha, SHA1);
  await drain(w); // baseline: learn the running sha
  const pauses = [];
  w.setPaused = (v) => pauses.push(v);
  // Cato's acceptance: 3 merge "events" (here: forced requests) at the same sha -> 0 restarts.
  for (let i = 0; i < 3; i++) {
    w.restartScheduled('scheduled restart (now)');
    await drain(w);
    assert.strictEqual(w.phase, 'idle');
  }
  assert.ok(!w.relaunched, 'no restart onto the commit already running');
  assert.ok(pauses.length === 0, 'the team is never paused for a no-op restart');
  assert.ok(w.store.logs.some((l) => /nothing to restart onto/.test(l.text)), 'the skip is logged');
  // One new sha -> exactly 1 restart.
  git.setSha(SHA2); git.setOrigin(SHA2);
  w.restartScheduled('scheduled restart (now)');
  await drain(w);
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1, 'a new sha still restarts');
  assert.strictEqual(readRestartState(w.store.dir).fromSha, SHA1);
});

test('a stood-down scheduled restart releases the dispatch schedule (the orchestrator gate lifts)', async () => {
  const { Store } = require('../src/store');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'su-disarm-'));
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ autoRestart: true });
  const git = fakeGit();
  const w = new UpdateWatcher({
    store: s, repoDir: '/repo', pollMs: 3.6e6, git, npm: fakeNpm(),
    relaunch: () => { w.relaunched = (w.relaunched || 0) + 1; },
  });
  clearInterval(w._timer);
  s.setRestartPending({ scheduledNow: true, count: 7 });
  w.restartScheduled('scheduled restart (now)');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched, 'nothing to restart onto');
  const rp = s.restartPending();
  assert.ok(rp && !rp.scheduledNow && !rp.afterTaskId && !rp.firedAt, 'the schedule is disarmed so the dispatch gate lifts with it');
  assert.strictEqual(rp.count, 7, 'the pending count survives the stand-down');
  assert.ok(s.readLogs().some((l) => /nothing to restart onto/.test(l.text)));
  assert.ok(s.readLogs().some((l) => /released the dispatch schedule/.test(l.text)));
});

// t_f6d37ca4: the tally reads as commits the running build is behind (running..target via git).
// At the boot sha that count is 0 — a stale tally must die with the stand-down, or it holds the
// bell row up forever and the cap re-arms restarts onto code that is already live (t_7426095a).
const standDownStore = (git) => {
  const { Store } = require('../src/store');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'su-standdown-'));
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ autoRestart: true });
  const w = new UpdateWatcher({
    store: s, repoDir: '/repo', pollMs: 3.6e6, git, npm: fakeNpm(),
    relaunch: () => { w.relaunched = (w.relaunched || 0) + 1; },
  });
  clearInterval(w._timer);
  return { s, w };
};

test('a stand-down at the running sha clears a stale pending tally (running..target is 0 commits)', async () => {
  const git = fakeGit();
  const { s, w } = standDownStore(git);
  let cleared = 0;
  w.on('pending-cleared', () => cleared++);
  // The incident shape: merges landed, the app already runs the target, the tally survived.
  s.setRestartPending({ scheduledNow: true, count: 7, sha: SHA1 });
  w.restartScheduled('scheduled restart (now)');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched, 'nothing to restart onto');
  assert.strictEqual(s.restartPending(), null, 'count 0 clears the flag and the count');
  assert.strictEqual(cleared, 1, "the 'pending-cleared' event fires so the renderer is pushed");
  assert.ok(s.readLogs().some((l) => /cleared the pending state/.test(l.text)));
});

test('a stand-down keeps the tally when the pending target is not the running build', async () => {
  const git = fakeGit();
  const { s, w } = standDownStore(git);
  let cleared = 0;
  w.on('pending-cleared', () => cleared++);
  s.setRestartPending({ scheduledNow: true, count: 7, sha: SHA2 });
  w.restartScheduled('scheduled restart (now)');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(w.phase, 'idle');
  const rp = s.restartPending();
  assert.ok(rp && !rp.scheduledNow, 'the schedule is still disarmed');
  assert.strictEqual(rp.count, 7, 'the target is ahead of the running build — the count stays');
  assert.strictEqual(rp.sha, SHA2);
  assert.strictEqual(cleared, 0, 'no clear event for a real pending target');
});

test('an uncomputable count never clears on a guess (git rev-list fails)', async () => {
  const git = fakeGit({ revListFails: true });
  const { s, w } = standDownStore(git);
  s.setRestartPending({ scheduledNow: true, count: 7, sha: SHA1 });
  w.restartScheduled('scheduled restart (now)');
  await new Promise((r) => setTimeout(r, 30));
  const rp = s.restartPending();
  assert.ok(rp && rp.count === 7, 'git failed: the tally survives');
  assert.ok(!rp.scheduledNow, 'the schedule is still released');
});

test('unknown running sha (boot capture failed): the same-commit skip stands down and the restart proceeds', async () => {
  const git = fakeGit();
  const w = makeWatcher({ git });
  w.bootSha = null; // main.js captures the boot sha itself; a failed capture passes null
  await drain(w);
  w.restartScheduled('scheduled restart (now)');
  await drain(w);
  assert.strictEqual(w.phase, 'restarting', 'never skip on an unknown running sha — restart the old way');
  assert.strictEqual(w.relaunched, 1);
  assert.ok(w.store.logs.some((l) => /running sha unknown/.test(l.text)), 'the fallback is logged');
});

test('a drain that coalesces onto the running commit stands down before testing', async () => {
  const git = fakeGit();
  let releaseDrain;
  const w = makeWatcher({ git, agents: 1, sleep: () => new Promise((r) => { releaseDrain = r; }) });
  await drain(w); // baseline: seen/boot sha SHA1
  git.setSha(SHA2); git.setOrigin(SHA2);
  const p = w.tick();
  await new Promise((r) => setImmediate(r)); // let the flow reach the drain
  assert.strictEqual(w.phase, 'draining');
  git.setSha(SHA1); git.setOrigin(SHA1); // while draining, HEAD lands back on the running sha
  releaseDrain();
  await p;
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched, 'the same-commit coalesce never relaunches');
  assert.strictEqual(w.status().lastError, null, 'a stand-down is not an error');
  assert.ok(w.store.logs.some((l) => /standing down — no restart/.test(l.text)));
  assert.ok(!w.npmF.calls.some(([a]) => a === 'test'), 'the test step never runs for a same-commit target');
});

test('a same-commit request_self_update is consumed politely without a flow', async () => {
  // A PM request at the running sha: consumed politely, no restart, no defer.
  const git = fakeGit();
  const w = makeWatcher({ git });
  await drain(w);
  fs.writeFileSync(requestFile(w.store.dir), JSON.stringify({ reason: 'PM asked again', from: 'n_pm' }));
  await drain(w);
  assert.strictEqual(w.phase, 'idle');
  assert.ok(!w.relaunched);
  assert.ok(!fs.existsSync(requestFile(w.store.dir)), 'the request is consumed');
  assert.strictEqual(w.status().deferredTo, null, 'nothing is parked for retry — there is nothing to apply');
});

test('restart test step timeout: hard cap fails the restart, cleans up and resumes dispatch', async () => {
  const git = fakeGit();
  const pauses = [];
  const w = makeWatcher({
    git, testTimeoutMs: 5 * 60 * 1000,
    testRun: async () => ({ code: 1, out: 'suite stalled here', timedOut: true }),
  });
  w.setPaused = (v) => pauses.push(v);
  await drain(w);
  git.setSha(SHA2); git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'idle', 'the timed-out restart aborted back to idle');
  assert.ok(!w.relaunched);
  assert.match(w.status().lastError, /test step timed out after 5min/);
  assert.match(readHistory(w.store.dir).slice(-1)[0].result, /test step timed out/);
  assert.deepStrictEqual(pauses, [true, true, true, false], 'dispatch paused through pending/draining/testing, resumed by the abort');
  assert.ok(git.calls.some((c) => c.startsWith('worktree remove')), 'the throwaway test worktree is cleaned up even on timeout');
});

test('defaultTestRun: a hung suite is killed with its whole process group at the deadline', async () => {
  const { defaultTestRun } = require('../src/self-update');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'su-testrun-'));
  // Fake "npm test": records its own pid and a background child's, then outlives any sane cap.
  const slow = path.join(d, 'slow.sh');
  fs.writeFileSync(slow, '#!/bin/sh\necho $$ > "' + slow + '.pids"\nsleep 60 &\necho $! >> "' + slow + '.pids"\nwait\n');
  fs.chmodSync(slow, 0o755);
  const t0 = Date.now();
  // Under full-suite load the OS can take a beat to exec the script; if the cap fired before the
  // script even started (no pids recorded) run it once more — the mechanics under test (timedOut
  // flag + group kill) are deterministic once the process exists.
  const readPids = () => { try { return fs.readFileSync(slow + '.pids', 'utf8').trim().split('\n').map(Number); } catch { return null; } };
  let r = await defaultTestRun([], d, 800, slow);
  let pids = readPids();
  if (!pids) {
    r = await defaultTestRun([], d, 800, slow);
    pids = readPids();
  }
  assert.strictEqual(r.timedOut, true, 'the step reports the timeout');
  assert.ok(Date.now() - t0 < 20 * 1000, 'the cap fired, not the 60s fake suite');
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(pids, 'the fake suite recorded its pids');
  for (const pid of pids) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.ok(!alive, `group member ${pid} did not survive the group kill`);
  }
  // Happy path: a fast fake completes normally, no timedOut marker.
  const fast = path.join(d, 'fast.sh');
  fs.writeFileSync(fast, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fast, 0o755);
  const ok = await defaultTestRun([], d, 8000, fast);
  assert.strictEqual(ok.code, 0);
  assert.ok(!ok.timedOut);
});

// ---- t_a91c68ce: the test step's throwaway worktree vs the worktree sweeps ----
// The 04:35 incident: the flow's squad-selfupdate-* worktree is a REGISTERED worktree of the
// live repo, so every sweeper of the repo sees it, and the suite's cwd vanished mid-run
// (spawn node ENOENT with the binary present — reproduced byte-identical by deleting a
// node --test cwd between file spawns). The flow now holds a git worktree lock while the
// suite runs: the one protection all sweepers honor (stray reaper skips locked entries, git
// refuses to remove one), plus one retry when the harness itself failed to spawn.

test('test step locks its throwaway worktree against the sweeps and unlocks before removal', async () => {
  const git = fakeGit();
  const w = makeWatcher({ git });
  await drain(w);
  git.setSha(SHA2); git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'restarting');
  const add = git.calls.findIndex((c) => c.startsWith('worktree add --detach '));
  const lock = git.calls.findIndex((c) => c.startsWith('worktree lock '));
  const unlock = git.calls.findIndex((c) => c.startsWith('worktree unlock '));
  const rm = git.calls.findIndex((c) => c.startsWith('worktree remove --force '));
  assert.ok(add >= 0, 'the flow registers a throwaway worktree');
  assert.ok(lock > add, `the worktree is locked right after it is added (add=${add}, lock=${lock}, calls: ${git.calls.filter((c) => c.startsWith('worktree')).join(' | ')})`);
  assert.ok(unlock > lock && rm > unlock, `unlock precedes removal — git refuses to remove a locked tree (calls: ${git.calls.filter((c) => c.startsWith('worktree')).join(' | ')})`);
  const wt = git.calls[add].split(' ')[3];
  assert.ok(/squad-selfupdate-/.test(wt), 'the locked worktree is the throwaway test worktree');
  assert.ok(git.calls[lock].endsWith(wt) && git.calls[unlock].endsWith(wt) && git.calls[rm].endsWith(wt), 'lock/unlock/remove all target that same worktree');
});

test('infra spawn failure in the test step retries once, loudly, and can still restart', async () => {
  const git = fakeGit();
  let runs = 0;
  const w = makeWatcher({ git, testRun: async () => {
    runs++;
    return runs === 1
      ? { code: 1, out: "✖ test/worktree.test.js (5.4ms)\n  Error: spawn /opt/homebrew/Cellar/node/23.11.0/bin/node ENOENT\n    errno: -2,\n    code: 'ENOENT',\n    syscall: 'spawn /opt/homebrew/Cellar/node/23.11.0/bin/node'" }
      : { code: 0, out: 'all pass' };
  } });
  await drain(w);
  git.setSha(SHA2); git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(runs, 2, 'the suite ran exactly twice (one retry)');
  assert.strictEqual(w.phase, 'restarting', 'the retry went green and the restart proceeds');
  assert.ok(w.relaunched === 1);
  assert.ok(w.store.logs.some((l) => l.kind === 'error' && /infra spawn failure.*retrying once \(attempt 1\/2\)/.test(l.text)), 'the retry is logged loudly with its counter');
});

test('an assertion failure is never retried', async () => {
  const git = fakeGit();
  let runs = 0;
  const w = makeWatcher({ git, testRun: async () => { runs++; return { code: 1, out: 'AssertionError: 1 !== 2 — tests failed badly' }; } });
  await drain(w);
  git.setSha(SHA2); git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(runs, 1, 'a real test failure aborts on the first run');
  assert.strictEqual(w.phase, 'idle');
  assert.match(w.status().lastError, /tests failed/);
});

test('a second infra failure is final: the same test never retries twice in a row', async () => {
  const git = fakeGit();
  let runs = 0;
  const w = makeWatcher({ git, testRun: async () => { runs++; return { code: 1, spawnError: 'ENOENT', out: 'spawn failed again' }; } });
  await drain(w);
  git.setSha(SHA2); git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(runs, 2, 'exactly one retry, then the gate fails');
  assert.strictEqual(w.phase, 'idle');
  assert.match(w.status().lastError, /infra spawn failure repeated/);
  // A later flow (new sha) may retry again — the finality is per target sha, not forever.
  const SHA3 = 'c'.repeat(40);
  git.setSha(SHA3); git.setOrigin(SHA3);
  await drain(w);
  assert.strictEqual(runs, 4, 'a new target sha gets its own single retry');
});

test('a timeout is an abort, never a retry', async () => {
  let runs = 0;
  const git = fakeGit();
  const w = makeWatcher({ git, testRun: async () => { runs++; return { code: 1, out: 'suite stalled here', timedOut: true }; } });
  await drain(w);
  git.setSha(SHA2); git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(runs, 1, 'no rerun after the hard cap');
  assert.match(w.status().lastError, /test step timed out/);
});

test('isInfraSpawnFailure: harness spawn shapes only', async () => {
  const { isInfraSpawnFailure } = require('../src/self-update');
  assert.strictEqual(isInfraSpawnFailure({ code: 1, spawnError: 'ENOENT', out: '' }), true, 'child_process error event');
  assert.strictEqual(isInfraSpawnFailure({ code: 1, out: "errno: -2,\n    code: 'ENOENT',\n    syscall: 'spawn /opt/homebrew/Cellar/node/23.11.0/bin/node',\n    path: '/opt/homebrew/Cellar/node/23.11.0/bin/node'" }), true, 'node --test inspect shape (the 04:35 incident)');
  assert.strictEqual(isInfraSpawnFailure({ code: 1, out: "syscall: 'spawn git',\n  code: 'EAGAIN'" }), true, 'reversed order, other errno');
  assert.strictEqual(isInfraSpawnFailure({ code: 1, out: 'npm error code ENOENT\nnpm error syscall spawn git\nnpm error path git' }), true, 'npm error style');
  assert.strictEqual(isInfraSpawnFailure({ code: 1, out: 'AssertionError: expected 1 to equal 2' }), false, 'assertion failure');
  assert.strictEqual(isInfraSpawnFailure({ code: 1, out: 'a test asserted code: ENOENT far away ... '.padEnd(400) + 'syscall spawn' }), false, 'distant mentions (beyond the 300-char window) do not count');
  assert.strictEqual(isInfraSpawnFailure({ code: 0, out: "code: 'ENOENT' syscall: 'spawn'" }), false, 'a green run is never infra');
  assert.strictEqual(isInfraSpawnFailure({ code: 1, timedOut: true, out: "code: 'ENOENT' syscall: 'spawn'" }), false, 'timeouts are their own abort, never retried');
  assert.strictEqual(isInfraSpawnFailure(null), false);
});

test('boot reaps a stale locked squad-selfupdate-* registration left by a crashed flow', () => {
  const { execFileSync } = require('child_process');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'su-bootrepo-')));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
  g('-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '.');
  g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'i');
  const stale = path.join(os.tmpdir(), 'squad-selfupdate-stale-' + process.pid);
  const other = path.join(os.tmpdir(), 'squad-gate-base-keep-' + process.pid);
  for (const p of [stale, other]) fs.rmSync(p, { recursive: true, force: true });
  g('worktree', 'add', '--detach', stale, 'HEAD'); g('worktree', 'lock', stale);
  g('worktree', 'add', '--detach', other, 'HEAD'); g('worktree', 'lock', other);
  bootResume(fakeStore(), { repoDir: repo }); // no restart state: just the boot hygiene
  assert.strictEqual(fs.existsSync(stale), false, "the crashed flow's locked worktree is reaped at boot");
  assert.strictEqual(g('worktree', 'list').includes('squad-selfupdate-stale'), false, 'its registration is pruned');
  assert.strictEqual(fs.existsSync(other), true, 'non-selfupdate registrations are not ours to touch');
  g('worktree', 'unlock', other); g('worktree', 'remove', '--force', other); // test hygiene
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---- t_203691fa: the 04:35 regression, end to end — a worktree sweep firing WHILE the
// restart test step runs. Real flow on a real fixture repo (real git), and the real
// sweepWorktrees entry point every sweeper funnels through (main.js's 10-min interval, the
// orchestrator's, any sibling app instance's), fired from inside the running test step.
// 04:35 precondition (t_a91c68ce root cause): the throwaway's best-effort node_modules
// share-link is absent, leaving the registered squad-selfupdate-* worktree clean — so
// without the lock the reaper deletes the suite's cwd mid-run, the next node --test
// per-file child spawn dies with ENOENT (binary present) and the gate aborts, throwing
// away the whole drain. With the fix the flow holds a git worktree lock while the suite
// runs: the reaper skips the entry, the child spawn survives, the gate goes green.
test('a worktree sweep firing while the restart test step runs does not abort the gate (04:35 regression)', async () => {
  const { execFileSync, spawnSync } = require('child_process');
  const util = require('util');
  const WT = require('../src/worktree');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'su-sweeprepo-')));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'app'));
  fs.writeFileSync(path.join(repo, 'app', 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
  try {
    // What the test step observed while it was running.
    const obs = { wt: null, existedAtSweep: null, lockedAtSweep: null, reapedBySweep: null, childOk: null, childErr: '' };
    const w = new UpdateWatcher({
      store: fakeStore(), repoDir: repo, npmDir: path.join(repo, 'app'), pollMs: 3.6e6,
      npm: () => ({ code: 0, out: 'ok' }),
      relaunch: () => { w.relaunched = (w.relaunched || 0) + 1; },
      procCount: () => 0,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
      // The suite under test: while it "runs", the sweep fires — then, exactly like node --test
      // spawning its next per-file child, the step spawns a real child process in its cwd.
      testRun: async (cwd) => {
        obs.wt = path.resolve(cwd, '..'); // .../squad-selfupdate-*/app -> the throwaway worktree
        // The 04:35 precondition: the share-link the flow creates best-effort is absent,
        // leaving the registered worktree clean for the stray reaper (t_a91c68ce).
        try { fs.unlinkSync(path.join(cwd, 'node_modules')); } catch {}
        const reg = g('worktree', 'list', '--porcelain').split('\n\n').find((b) => /squad-selfupdate-/.test(b)) || '';
        obs.wt = (reg.match(/^worktree (.*)$/m) || [])[1] || obs.wt;
        const report = WT.sweepWorktrees({ repoDir: repo, store: { listTasks: () => [] } });
        obs.reapedBySweep = report.strays.includes(obs.wt);
        obs.existedAtSweep = fs.existsSync(path.join(obs.wt, '.git'));
        obs.lockedAtSweep = g('worktree', 'list', '--porcelain').split('\n\n')
          .some((b) => b.startsWith('worktree ' + obs.wt) && /(^|\n)locked(\n|$)/.test(b));
        const st = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { cwd, encoding: 'utf8' });
        if (st.error) {
          obs.childOk = false;
          obs.childErr = util.inspect(st.error);
          return { code: 1, out: 'node --test child spawn failed\n' + obs.childErr };
        }
        obs.childOk = st.status === 0;
        return { code: obs.childOk ? 0 : 1, out: obs.childOk ? 'child spawn survived the concurrent sweep' : String(st.stderr) };
      },
    });
    await w.tick(); // baseline
    fs.writeFileSync(path.join(repo, 'README.md'), 'two\n');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two');
    await w.tick(); // detects the new commit and runs the flow: drain -> build -> testing
    while (w._busy) await new Promise((r) => setTimeout(r, 2));

    assert.strictEqual(obs.childOk, true,
      `the suite's child spawn must survive a concurrent sweep (the 04:35 ENOENT) — observed: ${JSON.stringify(obs)}`);
    assert.strictEqual(w.phase, 'restarting',
      `a sweep during the test step must not abort the gate — phase=${w.phase}, lastError=${JSON.stringify(w.status().lastError)}, observed: ${JSON.stringify(obs)}`);
    assert.strictEqual(obs.reapedBySweep, false, 'the stray reaper must not reap the live test worktree');
    assert.strictEqual(obs.lockedAtSweep, true, 'the test step holds a git worktree lock while its suite runs');
    assert.strictEqual(w.relaunched, 1, 'the gate goes green and the restart proceeds');
    assert.strictEqual(g('worktree', 'list', '--porcelain').includes('squad-selfupdate-'), false, 'the flow cleaned up its throwaway registration');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('request_self_update file is consumed and triggers the flow', async () => {
  const git = fakeGit();
  const w = makeWatcher({ git });
  await drain(w); // baseline: learn the running sha
  git.setSha(SHA2); git.setOrigin(SHA2); // a request alone is not enough since t_7426095a: there must be code to restart onto
  fs.writeFileSync(requestFile(w.store.dir), JSON.stringify({ reason: 'PM asked for it', from: 'n_pm' }));
  await drain(w);
  assert.strictEqual(w.phase, 'restarting');
  assert.strictEqual(w.relaunched, 1);
  assert.strictEqual(w.reason, 'PM asked for it');
  assert.ok(!fs.existsSync(requestFile(w.store.dir)));
});

test('request_self_update MCP tool: PM-only, dev/dogfood-only, writes the request file the watcher consumes', () => {
  const store = fakeStore();
  store.getTeam = () => ({ nodes: [{ id: 'pm', name: 'Pia', role: 'PM' }, { id: 'dev', name: 'Devon', role: 'Dev' }], edges: [] });
  // Outside dev mode (t_6703ba9c) the tool politely refuses and writes nothing.
  delete process.env.AGENTS_SQUAD_DEV;
  assert.deepStrictEqual(makeTools(store, 'pm').request_self_update({ reason: 'ship it' }), { requested: false, note: 'Self-update is disabled outside dev/dogfood mode.' });
  assert.ok(!fs.existsSync(requestFile(store.dir)), 'no request file outside dev mode');
  try {
    process.env.AGENTS_SQUAD_DEV = '1';
    makeTools(store, 'pm').request_self_update({ reason: 'ship it' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(requestFile(store.dir), 'utf8')), { reason: 'ship it', from: 'pm', ts: JSON.parse(fs.readFileSync(requestFile(store.dir), 'utf8')).ts });
    assert.throws(() => makeTools(store, 'dev').request_self_update({ reason: 'x' }), /scope violation/, 'non-PM is rejected');
    assert.strictEqual(JSON.parse(fs.readFileSync(requestFile(store.dir), 'utf8')).from, 'pm', 'rejected call did not overwrite the request');
  } finally { delete process.env.AGENTS_SQUAD_DEV; }
});

test('boot: resume interrupted Run on first boot; markBootOk ends the fragile window', () => {
  const store = fakeStore();
  writeRestartState(store.dir, { phase: 'restarting', wasRunning: true, reason: 'r', fromSha: SHA1, toSha: SHA2, ts: new Date().toISOString(), bootAttempts: 0 });
  const r = bootResume(store);
  assert.strictEqual(r.resume, true);
  assert.strictEqual(readRestartState(store.dir).bootAttempts, 1);
  markBootOk(store);
  assert.strictEqual(readRestartState(store.dir).phase, 'idle');
  assert.strictEqual(bootResume(store).resume, false, 'no resume once the boot was marked ok');
  clearRestartState(store.dir);
});

test('boot crash twice: rollback path clears state and disables auto-restart', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'su-repo-'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"repo"}');
  const store = fakeStore();
  writeRestartState(store.dir, { phase: 'restarting', wasRunning: true, reason: 'r', fromSha: SHA1, toSha: SHA2, ts: new Date().toISOString(), bootAttempts: 2 });
  // repo is not a git checkout, so the rollback cannot reset; it must still clear state + disable.
  const r = bootResume(store, { repoDir: repo });
  assert.strictEqual(r.rolledBack, true);
  assert.strictEqual(r.resume, false);
  assert.strictEqual(store.settings.autoRestart, false, 'auto-restart is disabled after rollback');
  assert.strictEqual(readRestartState(store.dir), null, 'restart state cleared');
  assert.strictEqual(readHistory(store.dir).slice(-1)[0].result, 'rolled_back');
  assert.ok(store.logs.some((l) => l.kind === 'error' && /rolled back|not rolled back/.test(l.text)));
});

test('boot rollback refuses to reset a dirty checkout but still disables auto-restart', () => {
  // Real git repo with a commit and an uncommitted change: rollback must not touch it.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'su-realdirty-'));
  const run = (a) => require('child_process').execFileSync('git', a, { cwd: repo });
  run(['init', '-q']); run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hello');
  run(['add', '.']); run(['commit', '-qm', 'init']);
  const head = String(run(['rev-parse', 'HEAD'])).trim();
  fs.writeFileSync(path.join(repo, 'f.txt'), 'uncommitted work');
  const store = fakeStore();
  writeRestartState(store.dir, { phase: 'restarting', wasRunning: false, reason: 'r', fromSha: SHA1, toSha: SHA2, ts: new Date().toISOString(), bootAttempts: 2 });
  const r = bootResume(store, { repoDir: repo });
  assert.strictEqual(r.rolledBack, true);
  assert.strictEqual(store.settings.autoRestart, false);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'uncommitted work', 'uncommitted changes preserved');
  assert.strictEqual(String(run(['rev-parse', 'HEAD'])).trim(), head, 'HEAD untouched');
});

// Draining for a restart must hold the run session open: with dispatchPaused, an empty proc table
// is not "no more work" — the watcher reads running as wasRunning and bootResume restarts the Run.
// Before the fix, tick() ended the run the moment the last proc exited, so wasRunning was always
// false and auto-resume was unreachable in the real wiring.
test('drain: dispatchPaused keeps the run session alive; unpausing resumes and finishes it', async () => {
  const { Store } = require('../src/store');
  const { Orchestrator } = require('../src/orchestrator');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'su-drain-'));
  const fake = path.join(d, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"type":"result","subtype":"success","session_id":"s1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}\'\n');
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxRuns: 5 });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // the finished hand-off completes via reviewer pickup
  s.addEdge(a.id, rev.id, 'review');
  s.createTask({ title: 'drain me', assignee: a.id });
  const o = new Orchestrator(s);
  o.dispatchPaused = true; // watcher is draining: pause before the first dispatch
  o.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(o.running, true, 'run session must stay alive while the update drain holds it');
  assert.strictEqual(s.listRuns().length, 0, 'no dispatch while paused');
  assert.ok(!s.readLogs().some((l) => /No more todo|Finished/.test(l.text)), 'run must not be declared finished during the drain');

  // The update aborts: unpause re-ticks, the task dispatches, the run runs to completion — and
  // idles at drain now (t_b2273507), it does not stop.
  o.dispatchPaused = false;
  o.tick();
  const waitFor = async (fn) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > 8000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
  await waitFor(() => o.runState().state === 'idle');
  assert.strictEqual(s.getTask(s.listTasks()[0].id).status, 'done');
  assert.ok(s.listRuns().length === 2, 'dev run + reviewer pickup');
  assert.ok(s.readLogs().some((l) => /No more todo tasks. Finished./.test(l.text)));
  o.stop && o.stop();
});

// The app lives in app/ inside the repo: npm (build/test/lockfile) must target the package dir,
// while git keeps operating on the repo root.
test('subdir layout: lockfile pathspec and test worktree cwd are under app/', async () => {
  const npm = fakeNpm();
  const git = fakeGit({ lockChanged: true });
  const w = makeWatcher({ git, npm, npmDir: '/repo/app' });
  assert.strictEqual(w.rel, 'app');
  await drain(w); // baseline: origin at HEAD, nothing to do
  git.setOrigin(SHA2);
  await drain(w);
  assert.ok(w.relaunched === 1);
  const diff = git.calls.find((c) => c.startsWith('diff --name-only'));
  assert.match(diff, /-- app\/package-lock\.json$/, 'lockfile diff uses the repo-relative app/ path');
  const wtTest = npm.calls.find(([a]) => a === 'test');
  assert.ok(/squad-selfupdate/.test(wtTest[1]), 'npm test runs in the temp worktree');
  assert.ok(wtTest[1].endsWith('/app'), 'npm test runs in the worktree\'s app/ subdir, got ' + wtTest[1]);
});

// 2026-09-28 dogfood: with the store migrated underneath it, the running app's post-run task write
// threw ("no task …"), runTask's promise died unhandled (no .catch at the dispatch site), the proc
// slot leaked, and the drain waited for two agents that had already exited — forever, with dispatch
// paused. A slot must be released however the run's bookkeeping ends, and an aborted update must
// still hand dispatch back.
test('drain: a run whose bookkeeping crashes releases its slot; drain completes; abort resumes dispatch', async () => {
  const { Store } = require('../src/store');
  const { Orchestrator } = require('../src/orchestrator');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'su-crashdrain-'));
  const fake = path.join(d, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"type":"result","subtype":"success","session_id":"s1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}\'\n');
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxRuns: 5, autoRestart: true });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // the resumed hand-off completes via reviewer pickup
  s.addEdge(a.id, rev.id, 'review');
  s.createTask({ title: 'crash my bookkeeping', assignee: a.id });
  const o = new Orchestrator(s);
  const waitFor = async (fn, what) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > 8000) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 10)); } };
  o.start();
  await waitFor(() => o.procs.size === 1, 'task dispatched');
  // The store breaks mid-run (the migration scenario): every post-run task write throws.
  const realUpdate = s.updateTask.bind(s);
  s.updateTask = () => { throw new Error('no task t_x'); };
  o.dispatchPaused = true; // the watcher pauses while the agent is running
  await waitFor(() => o.procs.size === 0, 'slot released despite the bookkeeping crash');
  assert.strictEqual(o.agents[a.id].status, 'idle', 'agent state reset after the crash');
  assert.ok(s.readLogs().some((l) => /agent run crashed/.test(l.text) && /no task/.test(l.text)), 'the crash is logged, not a silent unhandled rejection');

  // The watcher drains (0 procs), tests on the new code fail, the update aborts — and unpausing
  // must resume dispatch: the orphaned task is reconciled, re-dispatched and finishes.
  s.updateTask = realUpdate;
  const git = fakeGit(); const npm = fakeNpm({ testFails: true });
  const w = new UpdateWatcher({
    store: s, repoDir: '/repo', pollMs: 3.6e6,
    git, npm,
    relaunch: () => { w.relaunched = (w.relaunched || 0) + 1; },
    procCount: () => o.procs.size,
    runActive: () => o.running,
    setPaused: (v) => { o.dispatchPaused = v; if (!v) setImmediate(() => o.tick()); },
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  await drain(w); // baseline
  git.setOrigin(SHA2);
  await drain(w);
  assert.strictEqual(w.phase, 'idle', 'drain completed and the failed update aborted back to idle');
  assert.match(w.status().lastError, /tests failed/);
  await waitFor(() => o.runState().state === 'idle', 'run resumed after the abort and drained to idle'); // t_b2273507: drain now idles, it does not stop
  assert.strictEqual(s.getTask(s.listTasks()[0].id).status, 'done', 'the interrupted task finished after dispatch resumed');
  o.stop && o.stop();
});

// The drain grace cut, end to end: a long run is halted (haltProcs) for the restart. Unlike a crash,
// the task must stay in_progress — not review/parkedForHuman — so the post-restart reconcile
// re-dispatches it, and the Run session stays alive so wasRunning resumes it.
test('drain cutoff: haltProcs stops a long run, the task stays re-dispatchable and resumes', async () => {
  const { Store } = require('../src/store');
  const { Orchestrator } = require('../src/orchestrator');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'su-cutoff-'));
  const fake = path.join(d, 'fake-claude.sh');
  // exec is load-bearing: a bare `sleep 30` lets /bin/sh choose fork-vs-exec for the last script
  // line, and when it forks, SIGTERM kills only sh while the orphaned sleep keeps the run's stdio
  // pipes open — child 'close' (which spawnRun awaits) then waits out the full 30s sleep and the
  // drain's bounded give-up resolves with the proc slot still held. exec makes the fake ONE process
  // that dies when signalled, like the real CLI binary.
  fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n');
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxRuns: 5 });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // the resumed hand-off completes via reviewer pickup
  s.addEdge(a.id, rev.id, 'review');
  s.createTask({ title: 'long runner', assignee: a.id });
  const o = new Orchestrator(s);
  const waitFor = async (fn, what) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > 8000) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 10)); } };
  o.start();
  await waitFor(() => o.procs.size === 1, 'task dispatched');
  o.dispatchPaused = true; // the watcher is draining
  const task = s.listTasks()[0];
  await o.haltProcs(300);
  assert.strictEqual(o.procs.size, 0, 'the long run was stopped');
  assert.strictEqual(o.running, true, 'the Run session is held so wasRunning stays true');
  const after = s.getTask(task.id);
  assert.strictEqual(after.status, 'in_progress', 'a cut task is restart-interrupted, not crashed');
  assert.strictEqual(after.parkedForHuman, undefined, 'never parked for a human');

  // The update completes (or aborts): unpausing — main.js also clears the drain-cut markers —
  // reconciles the cut task back to todo and re-dispatches it; with a fast fake it runs to done.
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"type":"result","subtype":"success","session_id":"s2","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}\'\n');
  o.dispatchPaused = false; o.clearDrainCuts(); o.tick();
  await waitFor(() => o.runState().state === 'idle', 're-dispatched run finished (drained to idle)'); // t_b2273507: drain now idles
  assert.strictEqual(s.getTask(task.id).status, 'done');
  assert.ok(s.readLogs().some((l) => /reset to todo/.test(l.text)), 'the reconcile sweep logged the reset');
  o.stop && o.stop();
});
