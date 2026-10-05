'use strict';
// Harness sandbox (t_8f7605c4): a perf/e2e harness instance spawns REAL agent CLIs, and one
// leaked run had them wander from the throwaway data root into the developer's real repo —
// seeded tasks were "fixed" there, squad/<id> worktrees appeared in the real .squad/worktrees
// and the auto-merge landed seed commits on the real master. This file proves the fences:
//   - AGENTS_SQUAD_TEST_ROOT (set by src/main.js for every test instance, never in production)
//     makes the app refuse every repo mutation outside it: task worktree create, auto-merge,
//     worktree discard/remove, and agent dispatch (cwd outside the root → dispatch refused).
//   - the harness startup gate (SB.assertSandboxed/assertGitInside) hard-fails unless every node
//     workdir is a git workdir inside the data root, and SB.agentWorkspace builds exactly that.
//   - procguard reaps setsid-escaped descendants, so harness children die with the run.
// Nothing here spawns real agents; repos are tiny fixtures and "commits" are one-line files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { Store } = require('../src/store');
const WT = require('../src/worktree');
const MG = require('../src/merge-gate');
const SB = require('../src/sandbox');
const pg = require('./harness/procguard');
const { mktemp, mktempReal } = require('./harness/tmp');

pg.install(); // no-op under npm test (preloaded); keeps the file standalone-runnable

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// A stand-in for the developer's real repo: its own git history on `main`, nothing shared with
// the sandbox. Every assertion below checks this repo stays untouched.
function realRepoFixture() {
  const repo = mktempReal('sandbox-real-repo-');
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.squad/\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const masterSha = (repo) => g(repo, 'rev-parse', 'HEAD');
const withTestRoot = async (root, fn) => {
  const prev = process.env.AGENTS_SQUAD_TEST_ROOT;
  process.env.AGENTS_SQUAD_TEST_ROOT = root;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENTS_SQUAD_TEST_ROOT; else process.env.AGENTS_SQUAD_TEST_ROOT = prev; }
};

test('sandbox: no task worktree can be created in a repo outside the test data root', async () => {
  const real = realRepoFixture();
  const sandbox = mktempReal('sandbox-root-');
  await withTestRoot(sandbox, async () => {
    const w = await WT.ensureWorktree(real, 't_leak1');
    assert.match(String(w.warning), /sandbox: refusing/);
    assert.equal(fs.existsSync(path.join(real, '.squad', 'worktrees', 't_leak1')), false, 'no worktree dir in the real repo');
    assert.equal(g(real, 'branch', '--list', 'squad/t_leak1').trim(), '', 'no branch in the real repo');
    // inside the sandbox it still works
    const ok = await WT.ensureWorktree(SB.agentRepo(sandbox), 't_ok1');
    assert.ok(ok.worktreePath && !ok.warning, 'inside the sandbox worktrees work');
    assert.ok(SB.inside(sandbox, ok.worktreePath));
  });
});

test('sandbox: auto-merge refuses to land commits in a repo outside the test data root', async () => {
  const real = realRepoFixture();
  const sandbox = mktempReal('sandbox-root-');
  // The leaked shape: a task whose worktreePath points INTO the real repo, branch ahead of base.
  const leaked = await WT.ensureWorktree(real, 't_leak2'); // built WITHOUT the guard: emulate the stray agent's worktree
  assert.equal(WT.ensureWorktree.length, 2); // sanity: the fixture call itself is unguarded
  assert.ok(fs.existsSync(leaked.worktreePath), 'fixture worktree exists');
  await withTestRoot(sandbox, async () => {
    fs.writeFileSync(path.join(leaked.worktreePath, 'seed.txt'), '(seed 484) agent work\n');
    g(leaked.worktreePath, 'add', '.');
    g(leaked.worktreePath, 'commit', '-q', '-m', 'perf(t_seed): seeded work that must never land');
    const before = masterSha(real);
    const store = new Store(mktemp('sandbox-store-'));
    const task = store.createTask({ title: 'leaked', assignee: 'n_x' });
    store._updateTask(task.id, { worktreePath: leaked.worktreePath, worktreeBranch: 'squad/t_leak2' });
    await assert.rejects(() => MG.gateMerge(store.getTask(task.id)), /sandbox: refusing to auto-merge/, 'gateMerge refuses before any git side effect');
    assert.equal(masterSha(real), before, 'real repo master unchanged — no commit landed');
    assert.equal(g(real, 'log', '--oneline', '-1').includes('seed'), false, 'no seed commit on the real base');
  });
  // and the destructive lifecycle paths refuse too
  await withTestRoot(sandbox, async () => {
    const t = { worktreePath: leaked.worktreePath, worktreeBranch: 'squad/t_leak2' };
    await assert.rejects(() => WT.worktreeDiscard(t), /sandbox: refusing/);
    await assert.rejects(() => WT.removeWorktree(t), /sandbox: refusing/);
    assert.ok(fs.existsSync(leaked.worktreePath), 'stray worktree left untouched for the human to clean');
  });
});

test('sandbox: inside the test data root the merge path still lands', async () => {
  const sandbox = mktempReal('sandbox-root-');
  await withTestRoot(sandbox, async () => {
    const repo = SB.agentRepo(sandbox);
    const w = await WT.ensureWorktree(repo, 't_ok2');
    assert.ok(w.worktreePath && !w.warning);
    fs.writeFileSync(path.join(w.worktreePath, 'fix.txt'), 'legit\n');
    g(w.worktreePath, 'add', '.');
    g(w.worktreePath, 'commit', '-q', '-m', 'fix(t_ok2): sandboxed work');
    const store = new Store(mktemp('sandbox-store-'));
    const task = store.createTask({ title: 'ok', assignee: 'n_x' });
    store._updateTask(task.id, { worktreePath: w.worktreePath, worktreeBranch: 'squad/t_ok2' });
    const before = masterSha(repo);
    const r = await MG.gateMerge(store.getTask(task.id));
    assert.equal(r.merged, true, 'merge lands inside the sandbox');
    assert.notEqual(masterSha(repo), before);
  });
});

test('sandbox: startup gate hard-fails on a node workdir outside the data root or outside git', () => {
  const sandbox = mktempReal('sandbox-root-');
  const outside = mktempReal('outside-root-');
  assert.throws(() => SB.assertSandboxed(sandbox, [{ label: 'node Real-1 workdir', path: outside }]), /escapes the harness data root/);
  assert.throws(() => SB.assertGitInside(sandbox, mktemp('not-a-repo-'), 'node Real-1'), /not inside a git repo/);
  // happy path: a workspace clone passes both gates
  const ws = SB.agentWorkspace(sandbox, 0);
  SB.assertSandboxed(sandbox, [{ label: 'node workdir', path: ws }]);
  SB.assertGitInside(sandbox, ws, 'node Real-1');
});

test('sandbox: with no test root set (production) the guards are inert', async () => {
  const real = realRepoFixture();
  const prev = process.env.AGENTS_SQUAD_TEST_ROOT;
  delete process.env.AGENTS_SQUAD_TEST_ROOT;
  try {
    assert.equal(SB.refusal(real, 'auto-merge into'), null);
    const w = await WT.ensureWorktree(real, 't_prod');
    assert.ok(w.worktreePath && !w.warning, 'production worktrees unaffected');
  } finally { if (prev !== undefined) process.env.AGENTS_SQUAD_TEST_ROOT = prev; }
});

test('sandbox: main.js arms the root for every test instance', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /AGENTS_SQUAD_TEST_ROOT = testRoot/, 'TEST_MODE sets the durable sandbox root');
});

test('sandbox: procguard reaps setsid-escaped descendants of tracked children', async () => {
  const dir = mktemp('sandbox-setsid-');
  const marker = path.join(dir, 'gc.pid');
  // The grandchild calls setsid(): a new session and process group that procguard's group kill
  // cannot reach — only the pid-tree walk (pgrep -P, repeated) gets it. macOS ships no setsid
  // binary; python3's os.setsid() is the same syscall.
  const py = `import os, time\nos.setsid()\nopen(${JSON.stringify(marker)}, 'w').write(str(os.getpid()))\ntime.sleep(30)`;
  const pyFile = path.join(dir, 'escape.py');
  fs.writeFileSync(pyFile, py);
  const sh = path.join(dir, 'escape.sh');
  fs.writeFileSync(sh, `#!/bin/sh\npython3 ${JSON.stringify(pyFile)} &\nwait\n`);
  fs.chmodSync(sh, 0o755);
  const child = spawn(sh, [], { stdio: 'ignore' });
  pg.track(child, 'sandbox-test escape child');
  const gcPid = await (async () => { for (let i = 0; i < 75; i++) { if (fs.existsSync(marker)) return Number(fs.readFileSync(marker, 'utf8').trim()); await new Promise((r) => setTimeout(r, 40)); } throw new Error('grandchild never started'); })();
  assert.ok(pg.isAlive(gcPid), 'grandchild alive before the reap');
  pg.reapAll();
  await (async () => { for (let i = 0; i < 75; i++) { if (!pg.isAlive(gcPid)) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error('setsid-escaped grandchild survived reapAll (pid ' + gcPid + ')'); })();
});
