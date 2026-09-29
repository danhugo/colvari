// Pre-merge test gate (t_897cca56): real git repos with a tiny npm suite in app/, driven through
// the same entry points production uses (store.updateTask(done) and MG.gateMerge directly).
// Covers the t_485c97c5 critic review: serialization + CAS (#1 via the race test), red branch vs
// red base attribution (#2/#6), exact suite command + infra-vs-red split (#3), flaky rerun (#4),
// P0 dedupe/self-close (#5), capped bounce payload (#8).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const WT = require('../src/worktree');
const MG = require('../src/merge-gate');

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASS_TEST = "const t=require('node:test');t.test('ok',()=>{});\n";

// A repo whose app/ holds a real (tiny) test suite, plus a task worktree on squad/<id> and a
// Store OUTSIDE the repo (a store inside would dirty the main checkout and refuse every merge).
function fixture(id, { pkg = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gate-repo-')));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gate-store-'));
  fs.writeFileSync(path.join(root, '.gitignore'), '.squad/\nnode_modules/\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  if (pkg) {
    fs.mkdirSync(path.join(root, 'app', 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'node --test test/*.test.js' } }, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'app', 'test', 'a.test.js'), PASS_TEST);
    fs.mkdirSync(path.join(root, 'app', 'node_modules')); // untracked: lets the gate symlink deps instead of npm install
  }
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'add', '-f', '.'); g(root, 'commit', '-q', '-m', 'init');
  const w = WT.ensureWorktree(root, id);
  const t = { id, worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch };
  const store = new Store(path.join(storeDir, 'data'));
  return { root, store, t, g };
}

const commit = (cwd, files, msg) => {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
    fs.writeFileSync(path.join(cwd, f), content);
  }
  g(cwd, 'add', '-A', '.'); g(cwd, 'commit', '-qam', msg);
};

async function waitFor(fn, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    try { if (fn()) return; } catch {}
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await sleep(50);
  }
}

const commentText = (store, tid) => (store.getTask(tid).comments || []).map((c) => c.text).join('\n---\n');

// ---- unit: output classification ----

test('parseSummary: names extracted, numbered detail lines and the header excluded', () => {
  const out = [
    '✖ failing tests:',
    'test at test/x.test.js:1:1',
    '✖ test/x.test.js (255.985ms)',
    "  'test failed'",
    '✖ 1. subtest detail',
    'ℹ tests 483',
    'ℹ fail 2',
  ].join('\n');
  const s = MG.parseSummary(out);
  assert.equal(s.tests, 483); assert.equal(s.fail, 2); assert.equal(s.summarySeen, true);
  assert.deepEqual(s.names, ['test/x.test.js']);
});

test('isInfra: timeout, missing summary and bare modules are infra; relative module misses are red', () => {
  assert.equal(MG.isInfra({ timedOut: true, out: '', code: null }), true);
  assert.equal(MG.isInfra({ timedOut: false, out: 'Error: boom', code: 7 }), true, 'no node:test summary');
  assert.equal(MG.isInfra({ timedOut: false, out: "throw er: Cannot find module 'left-pad-dep'", code: 1 }), true, 'bare dep missing');
  const red = "Cannot find module '../src/nope'\\nℹ tests 1\\nℹ fail 1";
  assert.equal(MG.isInfra({ timedOut: false, out: red.replace(/\\n/g, '\n'), code: 1 }), false, 'relative miss = real red');
});

// ---- integration: the gate against real repos ----

test('green branch merges: base fast-forwards to the tested tip (tested tree == merged tree)', async () => {
  const { root, store, t, g } = fixture('t_gate_green');
  commit(t.worktreePath, { 'app/test/feature.test.js': PASS_TEST, 'README.md': 'feature\n' }, 'feature');
  const baseSha = g(root, 'rev-parse', 'main');
  const r = await MG.gateMerge(t, store);
  assert.equal(r.merged, true);
  assert.equal(r.gate.state, 'green');
  assert.ok(r.gate.tests >= 2, 'both fixture tests ran');
  assert.equal(g(root, 'rev-parse', 'main'), g(t.worktreePath, 'rev-parse', 'HEAD'), 'base == tested tip (ff)');
  assert.notEqual(baseSha, g(root, 'rev-parse', 'main'));
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'feature\n', 'base checkout updated');
  const health = MG.readHealth(root);
  assert.equal(health.state, 'green');
  assert.equal(health.lastGreenTree, g(root, 'rev-parse', 'main^{tree}'));
  assert.equal(health.lastMergedTask, t.id);
});

test('red branch: no merge, task reopened to assignee with capped failing output', async () => {
  const { root, store, t, g } = fixture('t_gate_red');
  const task = store.createTask({ title: 'red work', createdBy: 'test' });
  store.updateTask(task.id, { worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
  commit(t.worktreePath, { 'app/test/bad.test.js': "const t=require('node:test');const a=require('node:assert/strict');t.test('gate-bounce-marker',()=>a.equal(1,2));\n" }, 'broken');
  const baseSha = g(root, 'rev-parse', 'main');
  store.updateTask(task.id, { status: 'done' });
  await waitFor(() => store.getTask(task.id).status === 'todo');
  assert.equal(g(root, 'rev-parse', 'main'), baseSha, 'base untouched');
  const task2 = store.getTask(task.id);
  assert.equal(task2.status, 'todo');
  const text = commentText(store, task.id);
  assert.match(text, /merge gate: running npm test/);
  assert.match(text, /NOT merged.*npm test fails on squad\/t_gate_red/);
  assert.match(text, /gate-bounce-marker/, 'failing test name in the bounce payload');
  assert.ok(text.length < 6000, 'payload capped, got ' + text.length);
  assert.notEqual(MG.readHealth(root).state, 'red', 'a red branch is not a red master');
  assert.ok(!store.listTasks().some((x) => x.redMaster), 'no P0 for a red branch');
});

test('red base: master.red event, deduped P0, task reopened with attribution', async () => {
  const { root, store, t, g } = fixture('t_gate_redbase');
  const task = store.createTask({ title: 'redbase work', createdBy: 'test' });
  store.updateTask(task.id, { worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
  commit(root, { 'app/test/bad.test.js': "const t=require('node:test');const a=require('node:assert/strict');t.test('base-bad',()=>a.equal(1,2));\n" }, 'break base directly');
  const baseSha = g(root, 'rev-parse', 'main');
  commit(t.worktreePath, { 'README.md': 'feature\n' }, 'feature');
  const tsk = { id: task.id, worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch };
  const r = await MG.gateMerge(tsk, store);
  assert.equal(r.merged, false);
  assert.equal(r.gate.state, 'master-red');
  assert.equal(g(root, 'rev-parse', 'main'), baseSha, 'red base not advanced');
  assert.equal(store.getTask(task.id).status, 'todo', 'task reopened');
  assert.match(commentText(store, task.id), /base branch \(main@[0-9a-f]{8}\) itself fails/);
  const logs = store.readLogs(Infinity);
  assert.ok(logs.some((l) => l.kind === 'master.red' && /master is red/.test(l.text)), 'master.red logged');
  const p0s = store.listTasks().filter((x) => x.redMaster);
  assert.equal(p0s.length, 1);
  assert.equal(p0s[0].priority, 'P0');
  assert.ok(p0s[0].createdBy === 'merge-gate');
  assert.match(p0s[0].description, /no merge involved|last merged task/, 'owner attribution stated');
  // dedupe: a second gate run against the same red base must not spawn another P0
  const r2 = await MG.gateMerge(tsk, store);
  assert.equal(r2.gate.state, 'master-red');
  assert.equal(store.listTasks().filter((x) => x.redMaster).length, 1, 'P0 deduped');
  assert.equal(store.listTasks().filter((x) => x.redMaster)[0].id, p0s[0].id);
});

test('base fixed: next gate run merges, logs master.green and auto-closes the P0', async () => {
  const { root, store, t } = fixture('t_gate_fix');
  const task = store.createTask({ title: 'fix work', createdBy: 'test' });
  store.updateTask(task.id, { worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
  commit(root, { 'app/test/bad.test.js': "const t=require('node:test');const a=require('node:assert/strict');t.test('base-bad',()=>a.equal(1,2));\n" }, 'break base');
  commit(t.worktreePath, { 'README.md': 'feature\n' }, 'feature');
  const tsk = { id: task.id, worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch };
  await MG.gateMerge(tsk, store); // detects red base, creates the P0
  const p0 = store.listTasks().find((x) => x.redMaster);
  assert.ok(p0 && p0.status === 'todo');
  fs.unlinkSync(path.join(root, 'app', 'test', 'bad.test.js'));
  g(root, 'add', '-A', '.'); g(root, 'commit', '-qam', 'fix base');
  const r = await MG.gateMerge(tsk, store);
  assert.equal(r.merged, true);
  assert.equal(r.gate.state, 'green');
  assert.equal(MG.readHealth(root).state, 'green');
  assert.ok(store.readLogs(Infinity).some((l) => l.kind === 'master.green'), 'master.green logged');
  const p0b = store.getTask(p0.id);
  assert.equal(p0b.status, 'done', 'P0 self-closed');
  assert.match(commentText(store, p0.id), /master verified green/);
});

test('flaky suite: pass on the rerun merges green and says so', async () => {
  const { root, store, t } = fixture('t_gate_flaky');
  const marker = path.join(os.tmpdir(), 'squad-gate-flaky-' + t.id);
  try { fs.unlinkSync(marker); } catch {}
  commit(t.worktreePath, {
    'app/test/flaky.test.js': `const t=require('node:test');const fs=require('fs');t.test('flaky',()=>{if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'x');throw new Error('flake on first run');}});\n`,
  }, 'flaky work');
  const r = await MG.gateMerge(t, store);
  assert.equal(r.merged, true);
  assert.equal(r.gate.state, 'green');
  assert.ok(r.gate.flaky.length >= 1, 'flaky names recorded');
  assert.match(r.gate.flaky.join(','), /flaky/);
  fs.unlinkSync(marker);
});

test('infra failure (runner crash, no summary): no merge, infra note, not counted as red', async () => {
  const { root, store, t } = fixture('t_gate_infra');
  commit(t.worktreePath, { 'app/package.json': JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'node -e "process.exit(7)"' } }, null, 2) + '\n' }, 'crashy suite');
  const task = store.createTask({ title: 'infra work', createdBy: 'test' });
  store.updateTask(task.id, { worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
  const baseSha = g(root, 'rev-parse', 'main');
  store.updateTask(task.id, { status: 'done' });
  await waitFor(() => store.getTask(task.id).status === 'todo');
  assert.equal(g(root, 'rev-parse', 'main'), baseSha, 'nothing merged');
  assert.match(commentText(store, task.id), /infrastructure error/);
  assert.notEqual(MG.readHealth(root).state, 'red');
});

test('missing bare dependency is infra, not a red branch', async () => {
  const { root, store, t, g } = fixture('t_gate_dep');
  const task = store.createTask({ title: 'dep work', createdBy: 'test' });
  store.updateTask(task.id, { worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
  commit(t.worktreePath, { 'app/test/dep.test.js': "require('definitely-not-a-real-pkg-xyz');\nconst t=require('node:test');t.test('never',()=>{});\n" }, 'bad dep');
  const baseSha = g(root, 'rev-parse', 'main');
  const r = await MG.gateMerge({ id: task.id, worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch }, store);
  assert.equal(r.merged, false);
  assert.equal(r.gate.state, 'infra');
  assert.equal(g(root, 'rev-parse', 'main'), baseSha);
});

test('repo without a test suite merges untested (minimal repos keep working)', async () => {
  const { root, store, t, g } = fixture('t_gate_nopkg', { pkg: false });
  commit(t.worktreePath, { 'docs/x.md': 'doc\n' }, 'docs');
  const r = await MG.gateMerge(t, store);
  assert.equal(r.merged, true);
  assert.equal(r.gate.state, 'skipped');
  assert.equal(g(root, 'rev-parse', 'main'), g(t.worktreePath, 'rev-parse', 'HEAD'));
});

test('dirty main checkout: still refused through the gate, nothing merged', async () => {
  const { root, store, t, g } = fixture('t_gate_dirty');
  commit(t.worktreePath, { 'README.md': 'feature\n' }, 'feature');
  fs.writeFileSync(path.join(root, 'uncommitted.txt'), 'dirty\n');
  const baseSha = g(root, 'rev-parse', 'main');
  const r = await MG.gateMerge(t, store);
  assert.equal(r.merged, false);
  assert.equal(r.refused, true);
  assert.ok(r.dirty.includes('uncommitted.txt'));
  assert.equal(g(root, 'rev-parse', 'main'), baseSha, 'no merge happened');
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'base\n');
});

// t_485c97c5 #7: the race two single-branch tests miss — B must test the tree that ALREADY
// contains A, proving serialization + re-merge, not two merges against the same base.
test('concurrent merges serialize: the second branch tests the combined tree', async () => {
  const { root, store, g } = fixture('t_gate_raceA');
  const wA = WT.ensureWorktree(root, 't_gate_raceA');
  const wB = WT.ensureWorktree(root, 't_gate_raceB');
  const tA = { id: 't_gate_raceA', worktreePath: wA.worktreePath, worktreeBranch: wA.worktreeBranch };
  const tB = { id: 't_gate_raceB', worktreePath: wB.worktreePath, worktreeBranch: wB.worktreeBranch };
  commit(tA.worktreePath, { 'app/test/a-landed.test.js': "const t=require('node:test');const fs=require('fs');t.test('land',()=>{fs.writeFileSync(process.env.TMPDIR+'/squad-gate-race-A','1');});\n" }, 'A work');
  // B's suite only passes if B's checkout ALREADY contains A's commit (i.e. B re-merged the
  // base after A landed) — the exact combination a naive two-merge race would leave untested.
  commit(tB.worktreePath, { 'app/test/b-needs-a.test.js': "const t=require('node:test');const a=require('node:assert/strict');const p=require('path');t.test('combined tree',()=>a.ok(require('fs').existsSync(p.join(__dirname,'a-landed.test.js'))));\n" }, 'B work');
  const taskA = store.createTask({ title: 'race A', createdBy: 'test' });
  store.updateTask(taskA.id, { worktreePath: tA.worktreePath, worktreeBranch: tA.worktreeBranch });
  const taskB = store.createTask({ title: 'race B', createdBy: 'test' });
  store.updateTask(taskB.id, { worktreePath: tB.worktreePath, worktreeBranch: tB.worktreeBranch });
  const [rA, rB] = await Promise.all([
    MG.gateMerge({ id: taskA.id, worktreePath: tA.worktreePath, worktreeBranch: tA.worktreeBranch }, store),
    MG.gateMerge({ id: taskB.id, worktreePath: tB.worktreePath, worktreeBranch: tB.worktreeBranch }, store),
  ]);
  assert.equal(rA.merged, true, 'A merged: ' + JSON.stringify(rA));
  assert.equal(rB.merged, true, 'B merged: ' + JSON.stringify(rB));
  assert.equal(rB.gate.state, 'green');
  assert.ok(fs.existsSync(path.join(root, 'app', 'test', 'a-landed.test.js')), 'A landed on base');
  assert.ok(fs.existsSync(path.join(root, 'app', 'test', 'b-needs-a.test.js')), 'B landed on base');
  assert.equal(g(root, 'merge-base', '--is-ancestor', tA.worktreeBranch, tB.worktreeBranch), '', 'B built on top of A');
  assert.equal(MG.readHealth(root).state, 'green');
});

test('store-level green merge writes the gate comment on the task', async () => {
  const { root, store, t } = fixture('t_gate_comment');
  commit(t.worktreePath, { 'README.md': 'feature\n' }, 'feature');
  const task = store.createTask({ title: 'commented work', createdBy: 'test' });
  store.updateTask(task.id, { worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
  store.updateTask(task.id, { status: 'done' });
  await waitFor(() => commentText(store, task.id).includes('auto-merged squad/t_gate_comment into main'));
  assert.match(commentText(store, task.id), /merge gate: npm test green, \d+ tests/);
  assert.equal(store.getTask(task.id).status, 'done');
});
