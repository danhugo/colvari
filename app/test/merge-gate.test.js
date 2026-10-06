// Merge gate tests (t_12a92368) — pin the pre-merge test gate from epic t_ee2721f7.
// The gate itself lands with t_897cca56 (src/merge-gate.js + store.updateTask opts). Until
// then these tests SKIP with a named reason: a test may land ahead of its fix only as a skip
// pointing at the fix task. They activate the moment src/merge-gate.js exists.
//
// Pinned contract (see epic comment 2026-09-29T16:08Z + sync amendment):
//   gateMerge(t, opts)      sync; t = {id, worktreePath, worktreeBranch}; per-root lock ->
//                           merge base into the task branch in its worktree -> run the suite ->
//                           merge branch into base (tested tree == merged tree; CAS re-test if
//                           base moved). opts.runTests({worktreePath,root,base,branch}) sync
//                           callback -> {ok, output}, or opts.testCmd shell command with
//                           cwd = worktreePath.
//                           {merged:true,base,branch} | {merged:false,reason:'tests-failed',
//                           output} | {merged:false,refused:true,dirty}; git conflicts throw
//                           (same /failed, aborted/ contract as worktreeMerge).
//   ensureRedMasterTask(store, {root, tests, output})  deduped open P0 "Fix red master" per root.
//   store.updateTask(tid, patch, opts)  opts flows to the gate; on tests-failed the task
//                           reopens to 'todo' with a "merge gate: tests failed, task reopened:"
//                           system comment carrying the capped output tail.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

let MG = null;
try { MG = require('../src/merge-gate'); } catch {}
const SKIP = MG ? false : 'src/merge-gate.js not landed yet (t_897cca56): these tests pin the gate contract from epic t_ee2721f7 and activate when it lands';

const Store = require('../src/store');
const { ensureWorktree } = require('../src/worktree');
const S = Store.Store || Store;

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// Real git repo + one worktree per id (Cato #7: exercise the race on real branches, not mocks).
async function repoWithTasks(...ids) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-')));
  fs.writeFileSync(path.join(d, '.gitignore'), '.squad/\n');
  g(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'base\n');
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  const wts = {};
  for (const id of ids) wts[id] = await ensureWorktree(d, id);
  return { d, wts };
}

function commitWork(wt, file, content) {
  fs.writeFileSync(path.join(wt.worktreePath, file), content);
  g(wt.worktreePath, 'add', '.'); g(wt.worktreePath, 'commit', '-q', '-m', `work ${file}`);
}

const T = (w) => ({ id: w.worktreeBranch.replace(/^squad\//, ''), worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch });

function storeWithTask(w, title) {
  const s = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-store-')));
  const t = s.createTask({ title });
  s._updateTask(t.id, { worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch, status: 'in_progress' });
  return { s, tid: t.id };
}

test('merge gate: green branch merges (direct gateMerge and via store done)', { skip: SKIP }, async () => {
  const { d, wts } = await repoWithTasks('t_mg1');
  commitWork(wts.t_mg1, 'b.txt', 'green work\n');
  let ran = 0;
  const r = await MG.gateMerge(T(wts.t_mg1), { runTests: () => { ran++; return { ok: true, output: '' }; } });
  assert.strictEqual(r.merged, true, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'green work\n');
  assert.strictEqual(ran, 1, 'suite ran exactly once');

  // store path: flipping done runs the gate and the task stays done
  const { d: d2, wts: wts2 } = await repoWithTasks('t_mg1b');
  commitWork(wts2.t_mg1b, 'b.txt', 'green too\n');
  const { s, tid } = storeWithTask(wts2.t_mg1b, 'green store task');
  s.updateTask(tid, { status: 'done' }, { runTests: () => ({ ok: true, output: '' }) });
  await s._mergeQueue;
  const t = s.getTask(tid);
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(fs.readFileSync(path.join(d2, 'b.txt'), 'utf8'), 'green too\n');
  assert.ok(t.comments.some((c) => /auto-merged/.test(c.text)), 'merged comment recorded');
});

test('merge gate: failing branch is not merged; store reopens the task with capped tail', { skip: SKIP }, async () => {
  const { d, wts } = await repoWithTasks('t_mg2');
  const w = wts.t_mg2;
  commitWork(w, 'b.txt', 'broken work\n');
  const head = g(d, 'rev-parse', 'HEAD');
  const r = await MG.gateMerge(T(w), { runTests: () => ({ ok: false, output: 'FAIL x.test.js' }) });
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.reason, 'tests-failed');
  assert.strictEqual(g(d, 'rev-parse', 'HEAD'), head, 'base untouched by a rejected branch');
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'base\n');
  assert.ok(!fs.existsSync(path.join(d, 'b.txt')), 'branch work stayed out of base');

  // store path: the same branch re-offered via done reopens the task, not the merge
  const { s, tid } = storeWithTask(w, 'failing task');
  const big = 'noise '.repeat(4000) + 'FAIL src/app.test.js — expected red, got blue';
  s.updateTask(tid, { status: 'done' }, { runTests: () => ({ ok: false, output: big }) });
  await s._mergeQueue;
  const t = s.getTask(tid);
  assert.strictEqual(t.status, 'todo', 'task reopened to the assignee');
  const cm = t.comments.map((c) => c.text).find((x) => /merge gate: tests failed, task reopened:/.test(x));
  assert.ok(cm, 'reopen comment present');
  assert.ok(cm.includes('FAIL src/app.test.js'), 'comment carries the tail of the output, not the noise head');
  assert.ok(cm.length < 2500, `output is capped (comment is ${cm.length} chars)`);
  assert.strictEqual(g(d, 'rev-parse', 'HEAD'), head, 'still nothing merged');
});

test('merge gate: dirty main checkout refuses before the suite runs', { skip: SKIP }, async () => {
  const { d, wts } = await repoWithTasks('t_mg3');
  commitWork(wts.t_mg3, 'b.txt', 'work\n');
  fs.writeFileSync(path.join(d, 'dirty.txt'), 'uncommitted\n');
  let ran = 0;
  const r = await MG.gateMerge(T(wts.t_mg3), { runTests: () => { ran++; return { ok: true, output: '' }; } });
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.refused, true);
  assert.ok(r.dirty.includes('dirty.txt'));
  assert.strictEqual(ran, 0, 'refusal is cheap: no suite run for a refused merge');
});

test('merge gate: concurrent merges serialize across processes — second suite tests a tree containing the first merge', { skip: SKIP }, async () => {
  const { d, wts } = await repoWithTasks('t_mg4a', 't_mg4b');
  commitWork(wts.t_mg4a, 'b.txt', 'from A\n');
  commitWork(wts.t_mg4b, 'c.txt', 'from B\n');

  // Driver + probe live OUTSIDE the repo: untracked files in the main checkout would refuse
  // the merge via the dirty check before the gate even runs.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-run-'));
  const logf = path.join(scratch, 'suites.jsonl');
  const probe = path.join(scratch, 'probe.js');
  fs.writeFileSync(probe, `
    const fs = require('fs'); const { execFileSync } = require('child_process');
    const [logf, wt] = process.argv.slice(2);
    const start = Date.now();
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},150)']); // wide window: overlap if unlocked
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt }).toString().trim();
    fs.appendFileSync(logf, JSON.stringify({ start, end: Date.now(), head }) + '\\n');
  `);
  const driver = path.join(scratch, 'driver.js');
  fs.writeFileSync(driver, `
    const MG = require(process.env.MG_MODULE);
    const [wt, branch, logf, probe] = process.argv.slice(2);
    (async () => {
      const r = await MG.gateMerge(
        { id: branch.slice(6), worktreePath: wt, worktreeBranch: branch },
        { testCmd: process.execPath + ' ' + JSON.stringify(probe) + ' ' + JSON.stringify(logf) + ' ' + JSON.stringify(wt) }
      );
      process.stdout.write(JSON.stringify(r));
    })();
  `);

  const env = { ...process.env, MG_MODULE: require.resolve('../src/merge-gate') };
  const kids = [wts.t_mg4a, wts.t_mg4b].map((w) =>
    spawn(process.execPath, [driver, w.worktreePath, w.worktreeBranch, logf, probe], { env }));
  const outs = await Promise.all(kids.map((p) => new Promise((res, rej) => {
    let buf = ''; p.stdout.on('data', (c) => (buf += c));
    p.on('close', (code) => (code === 0 ? res(buf) : rej(new Error('gate driver exited ' + code))));
  })));
  for (const [i, o] of outs.entries()) assert.strictEqual(JSON.parse(o).merged, true, `merge ${i} succeeded: ${o}`);

  assert.ok(fs.existsSync(path.join(d, 'b.txt')) && fs.existsSync(path.join(d, 'c.txt')), 'both branches landed in base');
  g(d, 'merge-base', '--is-ancestor', 'squad/t_mg4a', 'main');
  g(d, 'merge-base', '--is-ancestor', 'squad/t_mg4b', 'main');

  const rows = fs.readFileSync(logf, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 2, 'both suites ran');
  const [first, second] = rows[0].start <= rows[1].start ? rows : [rows[1], rows[0]];
  assert.ok(second.start >= first.end, `suites serialized, not overlapped: ${JSON.stringify(rows)}`);

  // First-parent merges on base: exactly the two gate merges (a branch that had to absorb
  // base first also carries a merge commit in its own history — don't count that one).
  const merges = g(d, 'log', '--merges', '--first-parent', '--format=%H %P', 'main').split('\n').filter(Boolean);
  assert.strictEqual(merges.length, 2, `two merge commits landed, got ${merges.length}`);
  const oldest = merges[merges.length - 1].split(' ');
  assert.strictEqual(oldest[2], first.head, 'the suite that ran first is the one merged first');
  g(d, 'merge-base', '--is-ancestor', oldest[0], second.head); // throws unless the second-tested tree contains the first merge
});

test('red master: auto-created P0 fix task is deduped while open', { skip: SKIP }, async () => {
  const { d } = await repoWithTasks('t_mg5');
  const s = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-store-')));
  const info = { root: d, tests: ['src/app.test.js', 'src/other.test.js'], output: 'FAIL src/other.test.js — color mismatch' };
  const a = MG.ensureRedMasterTask(s, info);
  assert.ok(a, 'P0 fix task created');
  assert.strictEqual(a.priority, 'P0');
  assert.match(a.title, /red master/i);
  assert.match(a.description, /src\/other\.test\.js/, 'failing tests named in the description');
  assert.notStrictEqual(a.status, 'done');
  const b = MG.ensureRedMasterTask(s, { ...info, output: 'FAIL different.test.js' });
  assert.strictEqual(b.id, a.id, 'same open red master returns the same P0');
  const p0s = s.listTasks().filter((x) => x.priority === 'P0' && /red master/i.test(x.title));
  assert.strictEqual(p0s.length, 1, 'no duplicate P0s for one red master');
  s.updateTask(a.id, { status: 'done' }); // no worktree fields on a fix task: straight done, no merge
  const c = MG.ensureRedMasterTask(s, info);
  assert.notStrictEqual(c.id, a.id, 'a closed P0 does not dedupe the next red master');
});

// The startup sweep (orchestrator start() spawns checkMasterHealth in a detached child, t_1f379c6c):
// it must actually run the suite on base and land the result — it used to pass a TREE sha to
// runSuiteOnBase ('git worktree add --detach' needs a commit), fail as infra and silently no-op.
const GREEN_TEST = { name: 'gate', version: '1.0.0', scripts: { test: `node -e "console.log('ℹ tests 1');console.log('ℹ suites 0');console.log('ℹ pass 1');console.log('ℹ fail 0')"` } };
const RED_TEST = { name: 'gate', version: '1.0.0', scripts: { test: `node -e "console.log('ℹ tests 1');console.log('ℹ suites 0');console.log('ℹ pass 0');console.log('ℹ fail 1');console.log('✖ broken.test.js — boom (1ms)')"` } };
function repoWithSuite(pkg, health) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-hc-')));
  fs.writeFileSync(path.join(d, '.gitignore'), '.squad/\n');
  g(d, 'init', '-q', '-b', 'master');
  fs.mkdirSync(path.join(d, 'app'));
  fs.writeFileSync(path.join(d, 'app', 'package.json'), JSON.stringify(pkg));
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'suite');
  fs.mkdirSync(path.join(d, '.squad'), { recursive: true });
  fs.writeFileSync(path.join(d, '.squad', 'merge-gate.json'), JSON.stringify({ state: health, failing: health === 'red' ? ['seeded-red'] : [] }));
  return d;
}

test('master health sweep: startup check runs the suite on base and lands the result (t_1f379c6c)', { skip: SKIP }, async () => {
  const d = repoWithSuite(GREEN_TEST, 'red');
  const s = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-hc-store-')));
  const t = s.createTask({ title: 'anchors the sweep to this repo' });
  const wt = await ensureWorktree(d, 't_hc1');
  s._updateTask(t.id, { worktreePath: wt.worktreePath, worktreeBranch: wt.worktreeBranch });
  await MG.checkMasterHealth(s);
  const h = MG.readHealth(d);
  assert.strictEqual(h.state, 'green', JSON.stringify(h).slice(0, 300));
  assert.ok(h.lastGreenTree, 'green tree recorded');
  const logs = s.readLogs(Infinity).filter((l) => l.kind === 'master.green');
  assert.strictEqual(logs.length, 1, 'master.green logged exactly once');
  assert.match(logs[0].text, /startup check/);

  // red base: the sweep surfaces a deduped P0 fix task (same sweep, failing suite)
  const d2 = repoWithSuite(RED_TEST, 'unknown');
  const s2 = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-hc-store-')));
  const t2 = s2.createTask({ title: 'anchors the sweep to this repo' });
  const wt2 = await ensureWorktree(d2, 't_hc2');
  s2._updateTask(t2.id, { worktreePath: wt2.worktreePath, worktreeBranch: wt2.worktreeBranch });
  await MG.checkMasterHealth(s2);
  const p0 = s2.listTasks().find((x) => x.redMaster);
  assert.ok(p0 && p0.priority === 'P0', 'failing base creates the P0 fix task');
  assert.strictEqual(MG.readHealth(d2).state, 'red', 'red recorded');
});

// t_b9ed7fa3: two app instances watched one store and both started the done->merge gate in the
// same second; the lock's old age-only steal rule let the second waiter steal from the live
// holder mid-suite and a second npm test ran in the same worktree ("could not run"). Pinned
// here: only a stale lock with a provably dead holder is stealable, and two simultaneous
// same-task gates across processes run the suite exactly once.
test('merge lock steal rule: only a stale lock with a dead holder is stealable (t_b9ed7fa3)', { skip: SKIP }, () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-lock-')));
  fs.mkdirSync(path.join(d, '.squad'), { recursive: true });
  const lock = path.join(d, '.squad', 'merge.lock');
  const back = (ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(lock, t, t); };

  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  assert.strictEqual(MG.lockStealable(lock), false, 'a fresh live holder is never stealable');
  fs.writeFileSync(path.join(lock, 'pid'), '999999999');
  assert.strictEqual(MG.lockStealable(lock), false, 'a fresh lock is not stolen even with a dead pid (grace window)');
  back(10 * 60_000);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  assert.strictEqual(MG.lockStealable(lock), false, 'a stale lock with a live holder is not stolen by age');
  fs.writeFileSync(path.join(lock, 'pid'), '999999999');
  assert.strictEqual(MG.lockStealable(lock), true, 'a stale lock with a dead holder is stolen');
  fs.rmSync(path.join(lock, 'pid'));
  back(10 * 60_000); // removing the pid file bumps the dir mtime — backdate again
  assert.strictEqual(MG.lockStealable(lock), true, 'a stale pid-less lock falls back to the age rule');
});

test('merge gate: a live lock holder is waited for, a dead one is stolen immediately (t_b9ed7fa3)', { skip: SKIP }, async () => {
  const { d, wts } = await repoWithTasks('t_mg8a', 't_mg8b');
  commitWork(wts.t_mg8a, 'b.txt', 'held\n');
  commitWork(wts.t_mg8b, 'c.txt', 'held too\n');
  const lock = path.join(d, '.squad', 'merge.lock');
  const back = () => { const t = new Date(Date.now() - 10 * 60_000); fs.utimesSync(lock, t, t); };

  // Live holder with a 10-min-old mtime: the old rule stole at the age check and a second suite
  // ran in this worktree; now the gate waits for release and proceeds. THIS process is the
  // holder (a spawned holder child would zombie on exit and kill(pid,0) still sees zombies, so
  // a wait on it is indistinguishable from a live one) — the gate runs in a child, which waits
  // out the hold and merges only after release.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-held-'));
  const driver = path.join(scratch, 'driver.js');
  fs.writeFileSync(driver, `
    const MG = require(process.env.MG_MODULE);
    const [wt, branch] = process.argv.slice(2);
    (async () => { process.stdout.write(JSON.stringify(await MG.gateMerge(
      { id: branch.slice(6), worktreePath: wt, worktreeBranch: branch },
      { runTests: () => ({ ok: true, output: '' }) }))); })();
  `);
  fs.mkdirSync(path.join(d, '.squad'), { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  back();
  const t0 = Date.now();
  const kid = spawn(process.execPath, [driver, wts.t_mg8a.worktreePath, wts.t_mg8a.worktreeBranch], { env: { ...process.env, MG_MODULE: require.resolve('../src/merge-gate') } });
  let out = ''; kid.stdout.on('data', (c) => (out += c));
  setTimeout(() => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }, 1200).unref();
  const kidCode = await new Promise((res) => kid.on('close', res));
  assert.strictEqual(kidCode, 0, 'gate child exited cleanly');
  assert.ok(Date.now() - t0 >= 1100, `waited for the live holder instead of stealing (took ${Date.now() - t0}ms)`);
  assert.strictEqual(JSON.parse(out).merged, true, out);
  assert.ok(!fs.existsSync(lock), 'lock released after the gate');

  // Dead holder: the stale lock is stolen on the first poll, not waited out.
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((res) => dead.on('close', res));
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(dead.pid));
  back();
  const t1 = Date.now();
  const r2 = await MG.gateMerge(T(wts.t_mg8b), { runTests: () => ({ ok: true, output: '' }) });
  assert.strictEqual(r2.merged, true, JSON.stringify(r2));
  assert.ok(Date.now() - t1 < 10_000, `dead holder stolen immediately (took ${Date.now() - t1}ms)`);
});

test('merge gate: two simultaneous gates on one task across processes run the suite exactly once (t_b9ed7fa3)', { skip: SKIP }, async () => {
  const { d, wts } = await repoWithTasks('t_mg9');
  commitWork(wts.t_mg9, 'b.txt', 'once\n');

  // Driver + probe live OUTSIDE the repo: untracked files in the main checkout would refuse
  // the merge via the dirty check before the gate even runs.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-dbl-'));
  const logf = path.join(scratch, 'suites.jsonl');
  const probe = path.join(scratch, 'probe.js');
  fs.writeFileSync(probe, `
    const fs = require('fs');
    setTimeout(() => fs.appendFileSync(process.argv[2], JSON.stringify({ pid: process.pid }) + '\\n'), 1000);
  `);
  const driver = path.join(scratch, 'driver.js');
  fs.writeFileSync(driver, `
    const MG = require(process.env.MG_MODULE);
    const [wt, branch, logf, probe] = process.argv.slice(2);
    (async () => {
      const r = await MG.gateMerge(
        { id: branch.slice(6), worktreePath: wt, worktreeBranch: branch },
        { testCmd: process.execPath + ' ' + JSON.stringify(probe) + ' ' + JSON.stringify(logf) }
      );
      process.stdout.write(JSON.stringify(r));
    })();
  `);

  const env = { ...process.env, MG_MODULE: require.resolve('../src/merge-gate') };
  const w = wts.t_mg9;
  const kids = [0, 1].map(() =>
    spawn(process.execPath, [driver, w.worktreePath, w.worktreeBranch, logf, probe], { env }));
  const outs = await Promise.all(kids.map((p) => new Promise((res, rej) => {
    let buf = ''; p.stdout.on('data', (c) => (buf += c));
    p.on('close', (code) => (code === 0 ? res(buf) : rej(new Error('gate driver exited ' + code))));
  })));
  const rs = outs.map((o) => JSON.parse(o));
  assert.strictEqual(rs.filter((r) => r.merged).length, 1, `exactly one gate merged: ${outs.join('|')}`);
  const loser = rs.find((r) => !r.merged);
  assert.strictEqual(loser.gate && loser.gate.state, 'skipped', `loser took the neutral no-commits path: ${JSON.stringify(loser)}`);
  assert.strictEqual(fs.readFileSync(logf, 'utf8').split('\n').filter(Boolean).length, 1, 'suite ran exactly once across both gates');
  assert.ok(fs.existsSync(path.join(d, 'b.txt')), 'the work landed in base');
  g(d, 'merge-base', '--is-ancestor', 'squad/t_mg9', 'main');
});

// npm install in a worktree must never resolve through a stale shared symlink into the main
// checkout (t_0fd83668): once the branch's package files differ from main, the gate drops the
// link and installs into a real local dir; a matching share stays untouched.
test('ensureDeps: stale node_modules symlink is dropped when package files differ (t_0fd83668)', { skip: SKIP }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-nm-main-')));
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-nm-wt-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"main"}\n');
  fs.writeFileSync(path.join(wt, 'package.json'), '{"name":"main"}\n');
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'x');
  // matching files: the existing symlink share stays, no install runs
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
  assert.strictEqual(await MG.ensureDeps(wt, root, null), null);
  assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), 'matching share is kept');
  // branch changes its package files (no new deps: the local install stays offline): the symlink
  // must be dropped and a LOCAL install happens
  fs.writeFileSync(path.join(wt, 'package.json'), '{"name":"main","version":"2.0.0"}\n');
  assert.strictEqual(await MG.ensureDeps(wt, root, null), null, 'local install of the empty tree succeeds');
  let st = null; try { st = fs.lstatSync(path.join(wt, 'node_modules')); } catch {}
  assert.ok(!st || !st.isSymbolicLink(), 'after a package change node_modules is not a shared symlink (installs land locally)');
});
