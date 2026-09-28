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
  g.calls = calls; g.sha = () => sha; g.setSha = (s) => { sha = s; }; g.setOrigin = (s) => { opts.origin = s; };
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
function makeWatcher({ store = fakeStore(), git, npm, agents = 0, wasRunning = false, relaunch, sleep } = {}) {
  const npmF = npm || fakeNpm();
  const gitF = git || fakeGit();
  let ticks = 0;
  const w = new UpdateWatcher({
    store, repoDir: '/repo', pollMs: 3.6e6,
    minIntervalMs: 10 * 60 * 1000, maxRestartsPerHour: 3,
    git: gitF, npm: npmF,
    relaunch: relaunch || (() => { w.relaunched = (w.relaunched || 0) + 1; }),
    procCount: () => Math.max(0, agents - ticks++),
    runActive: () => wasRunning,
    sleep: sleep || (() => new Promise((r) => setTimeout(r, 1))),
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

test('restart during wait: draining waits for running agents (no timeout) then proceeds', async () => {
  const git = fakeGit();
  const w = makeWatcher({ git, agents: 2, sleep: () => new Promise((r) => setTimeout(r, 30)) });
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

test('request_self_update MCP tool: PM-only, writes the request file the watcher consumes', () => {
  const store = fakeStore();
  store.getTeam = () => ({ nodes: [{ id: 'pm', name: 'Pia', role: 'PM' }, { id: 'dev', name: 'Devon', role: 'Dev' }], edges: [] });
  makeTools(store, 'pm').request_self_update({ reason: 'ship it' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(requestFile(store.dir), 'utf8')), { reason: 'ship it', from: 'pm', ts: JSON.parse(fs.readFileSync(requestFile(store.dir), 'utf8')).ts });
  assert.throws(() => makeTools(store, 'dev').request_self_update({ reason: 'x' }), /scope violation/, 'non-PM is rejected');
  assert.strictEqual(JSON.parse(fs.readFileSync(requestFile(store.dir), 'utf8')).from, 'pm', 'rejected call did not overwrite the request');
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
