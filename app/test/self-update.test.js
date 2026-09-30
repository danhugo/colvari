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
function makeWatcher({ store = fakeStore(), git, npm, npmDir, agents = 0, wasRunning = false, relaunch, sleep, haltProcs, drainTimeoutMs } = {}) {
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
    drainTimeoutMs,
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

test('request_self_update file is consumed and triggers the flow', async () => {
  const w = makeWatcher({ git: fakeGit() });
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
