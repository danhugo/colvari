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
function repoWithTasks(...ids) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-')));
  fs.writeFileSync(path.join(d, '.gitignore'), '.squad/\n');
  g(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'base\n');
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  const wts = {};
  for (const id of ids) wts[id] = ensureWorktree(d, id);
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

test('merge gate: green branch merges (direct gateMerge and via store done)', { skip: SKIP }, () => {
  const { d, wts } = repoWithTasks('t_mg1');
  commitWork(wts.t_mg1, 'b.txt', 'green work\n');
  let ran = 0;
  const r = MG.gateMerge(T(wts.t_mg1), { runTests: () => { ran++; return { ok: true, output: '' }; } });
  assert.strictEqual(r.merged, true, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'green work\n');
  assert.strictEqual(ran, 1, 'suite ran exactly once');

  // store path: flipping done runs the gate and the task stays done
  const { d: d2, wts: wts2 } = repoWithTasks('t_mg1b');
  commitWork(wts2.t_mg1b, 'b.txt', 'green too\n');
  const { s, tid } = storeWithTask(wts2.t_mg1b, 'green store task');
  const t = s.updateTask(tid, { status: 'done' }, { runTests: () => ({ ok: true, output: '' }) });
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(fs.readFileSync(path.join(d2, 'b.txt'), 'utf8'), 'green too\n');
  assert.ok(t.comments.some((c) => /auto-merged/.test(c.text)), 'merged comment recorded');
});

test('merge gate: failing branch is not merged; store reopens the task with capped tail', { skip: SKIP }, () => {
  const { d, wts } = repoWithTasks('t_mg2');
  const w = wts.t_mg2;
  commitWork(w, 'b.txt', 'broken work\n');
  const head = g(d, 'rev-parse', 'HEAD');
  const r = MG.gateMerge(T(w), { runTests: () => ({ ok: false, output: 'FAIL x.test.js' }) });
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.reason, 'tests-failed');
  assert.strictEqual(g(d, 'rev-parse', 'HEAD'), head, 'base untouched by a rejected branch');
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'base\n');
  assert.ok(!fs.existsSync(path.join(d, 'b.txt')), 'branch work stayed out of base');

  // store path: the same branch re-offered via done reopens the task, not the merge
  const { s, tid } = storeWithTask(w, 'failing task');
  const big = 'noise '.repeat(4000) + 'FAIL src/app.test.js — expected red, got blue';
  const t = s.updateTask(tid, { status: 'done' }, { runTests: () => ({ ok: false, output: big }) });
  assert.strictEqual(t.status, 'todo', 'task reopened to the assignee');
  const cm = t.comments.map((c) => c.text).find((x) => /merge gate: tests failed, task reopened:/.test(x));
  assert.ok(cm, 'reopen comment present');
  assert.ok(cm.includes('FAIL src/app.test.js'), 'comment carries the tail of the output, not the noise head');
  assert.ok(cm.length < 2500, `output is capped (comment is ${cm.length} chars)`);
  assert.strictEqual(g(d, 'rev-parse', 'HEAD'), head, 'still nothing merged');
});

test('merge gate: dirty main checkout refuses before the suite runs', { skip: SKIP }, () => {
  const { d, wts } = repoWithTasks('t_mg3');
  commitWork(wts.t_mg3, 'b.txt', 'work\n');
  fs.writeFileSync(path.join(d, 'dirty.txt'), 'uncommitted\n');
  let ran = 0;
  const r = MG.gateMerge(T(wts.t_mg3), { runTests: () => { ran++; return { ok: true, output: '' }; } });
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.refused, true);
  assert.ok(r.dirty.includes('dirty.txt'));
  assert.strictEqual(ran, 0, 'refusal is cheap: no suite run for a refused merge');
});

test('merge gate: concurrent merges serialize across processes — second suite tests a tree containing the first merge', { skip: SKIP }, async () => {
  const { d, wts } = repoWithTasks('t_mg4a', 't_mg4b');
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
    const r = MG.gateMerge(
      { id: branch.slice(6), worktreePath: wt, worktreeBranch: branch },
      { testCmd: process.execPath + ' ' + JSON.stringify(probe) + ' ' + JSON.stringify(logf) + ' ' + JSON.stringify(wt) }
    );
    process.stdout.write(JSON.stringify(r));
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

test('red master: auto-created P0 fix task is deduped while open', { skip: SKIP }, () => {
  const { d } = repoWithTasks('t_mg5');
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

test('master health sweep: startup check runs the suite on base and lands the result (t_1f379c6c)', { skip: SKIP }, () => {
  const d = repoWithSuite(GREEN_TEST, 'red');
  const s = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-hc-store-')));
  const t = s.createTask({ title: 'anchors the sweep to this repo' });
  const wt = ensureWorktree(d, 't_hc1');
  s._updateTask(t.id, { worktreePath: wt.worktreePath, worktreeBranch: wt.worktreeBranch });
  MG.checkMasterHealth(s);
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
  const wt2 = ensureWorktree(d2, 't_hc2');
  s2._updateTask(t2.id, { worktreePath: wt2.worktreePath, worktreeBranch: wt2.worktreeBranch });
  MG.checkMasterHealth(s2);
  const p0 = s2.listTasks().find((x) => x.redMaster);
  assert.ok(p0 && p0.priority === 'P0', 'failing base creates the P0 fix task');
  assert.strictEqual(MG.readHealth(d2).state, 'red', 'red recorded');
});
