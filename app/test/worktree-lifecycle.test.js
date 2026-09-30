// Worktree lifecycle (t_9b662983): remove on done/merge (branch kept), orphan sweep + prune,
// shared node_modules via symlink, disk usage. Covers Cato's plan-review checklist: dirty
// retained, unmerged retained, in-flight skipped, reopen recreates, symlink not a copy, prune.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const WT = require('../src/worktree');
const { Orchestrator } = require('../src/orchestrator');

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();

// Repo (base branch `main`, a 300KB blob in an ignored node_modules/). No package.json, so the
// merge gate skips the suite and done-flips stay fast.
function bareRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wlc-repo-')));
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.squad/\nnode_modules\n'); // no slash: symlinks match only the bare name
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'node_modules', 'blob.bin'), 'x'.repeat(300 * 1024));
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

// bareRepo + a Store whose task carries a worktree on squad/<id> — the auto-merge.test.js shape.
function setup(taskId) {
  const repo = bareRepo();
  const w = WT.ensureWorktree(repo, taskId);
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'wlc-store-')));
  let task = s.createTask({ title: 'lifecycle', assignee: 'n_dev' });
  task = s._updateTask(task.id, { worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch });
  return { repo, s, task, wt: w.worktreePath, taskId };
}

// Same settle contract as auto-merge.test.js: wait for the gate's terminal comment.
function settle(s, id, from) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const t = s.getTask(id);
      const cs = (t && t.comments) || [];
      if (cs.length > from && !/^merge gate: running the unit suite/.test(cs[cs.length - 1].text)) return resolve(s.getTask(id));
      if (Date.now() - t0 > 30000) return reject(new Error('gate did not settle: ' + JSON.stringify(cs.map((c) => c.text)).slice(0, 400)));
      setTimeout(check, 20);
    };
    check();
  });
}
function done(s, id) {
  const from = (s.getTask(id).comments || []).length;
  s.updateTask(id, { status: 'done' });
  return settle(s, id, from);
}

// ---- node_modules sharing ----

test('new worktrees link node_modules (symlink, gitignored), never a copy', () => {
  const { repo, wt } = setup('t_lc1');
  const link = path.join(wt, 'node_modules');
  const st = fs.lstatSync(link);
  assert.ok(st.isSymbolicLink(), 'lstat says symlink');
  assert.strictEqual(fs.realpathSync(link), fs.realpathSync(path.join(repo, 'node_modules')), 'resolves to the shared dir');
  assert.strictEqual(g(wt, 'status', '--porcelain'), '', 'symlink is gitignored: porcelain clean');
  assert.deepStrictEqual(WT.ensureWorktree(repo, 't_lc1'), { cwd: wt, worktreePath: wt, worktreeBranch: 'squad/t_lc1' }, 'reuse path keeps the link');
});

test('an existing real node_modules copy in a worktree is never replaced', () => {
  const { repo, wt } = setup('t_lc11');
  fs.rmSync(path.join(wt, 'node_modules'), { force: true, recursive: true }); // drop the auto-created symlink (lstat: link only, target untouched)
  fs.mkdirSync(path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'node_modules', 'local.txt'), 'real\n');
  WT.ensureWorktree(repo, 't_lc11'); // reuse path must not touch it
  const st = fs.lstatSync(path.join(wt, 'node_modules'));
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(wt, 'node_modules', 'local.txt'), 'utf8'), 'real\n');
});

// ---- remove on done/merge ----

test('merge on done removes the worktree, keeps the branch and the fields naming it', async () => {
  const { repo, s, task, wt } = setup('t_lc2');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n'); g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', 'work');
  const updated = await done(s, task.id);
  assert.strictEqual(updated.status, 'done');
  assert.strictEqual(updated.worktreePath, wt, 'fields stay: they name the kept branch for reopen');
  assert.strictEqual(fs.existsSync(wt), false, 'worktree dir removed');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'new\n', 'work landed on base');
  g(repo, 'rev-parse', '--verify', 'squad/t_lc2'); // throws (test failure) if the branch was dropped
  assert.ok(updated.comments.some((c) => /worktree removed after merge/.test(c.text)));
});

test('reopen after cleanup recreates the worktree from the kept branch', async () => {
  const { repo, s, task, wt, taskId } = setup('t_lc2');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n'); g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', 'work');
  await done(s, task.id);
  const w2 = WT.ensureWorktree(repo, taskId);
  assert.strictEqual(w2.worktreePath, wt, 'same dir comes back');
  assert.match(g(w2.cwd, 'log', '--oneline', 'squad/' + taskId), /work/, 'prior commits present on the kept branch');
  assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), 'link re-created too');
});

test('nothing-merged done flip: dir removed, fields kept so re-flips still comment', async () => {
  const { s, task, wt } = setup('t_lc12'); // no commits on the branch
  const first = await done(s, task.id);
  assert.strictEqual(first.status, 'done');
  assert.strictEqual(fs.existsSync(wt), false, 'dir removed (branch was already an ancestor)');
  assert.strictEqual(first.worktreePath, wt, 'fields kept on the nothing-merged path');
  const second = await done(s, task.id);
  assert.strictEqual(second.status, 'done');
  assert.ok(second.comments.some((c) => /nothing merged: no commits/.test(c.text)), 're-flip walks the cheap gate path and comments');
});

test('repeated done-flip and human mergeTask after cleanup are clean no-ops', async () => {
  const { s, task, wt } = setup('t_lc10');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n'); g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', 'work');
  const first = await done(s, task.id);
  assert.strictEqual(fs.existsSync(wt), false);
  const second = await done(s, task.id); // fields kept + dir gone: gate skips at ahead-0 and comments
  assert.strictEqual(second.status, 'done');
  assert.ok(second.comments.some((c) => /nothing merged: no commits/.test(c.text)));
  const m = s.mergeTask(task.id); // direct human path takes the same ahead-0 skip
  assert.ok(m.comments.some((c) => /nothing merged: no commits/.test(c.text)));
  assert.strictEqual(m.status, 'done');
});

// ---- sweep: retained vs removed ----

test('dirty worktree is retained and flagged (sweep and done-flip)', async () => {
  const { s, task, wt } = setup('t_lc3');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n'); g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', 'work');
  s._updateTask(task.id, { status: 'done' }); // raw done: clean tree, unmerged branch
  fs.writeFileSync(path.join(wt, 'c.txt'), 'uncommitted\n');
  const r = WT.sweepWorktrees({ repoDir: repoOf(wt), store: s });
  assert.deepStrictEqual(r.removed, []);
  assert.ok(r.retained.some((x) => x.dir === 't_lc3' && /uncommitted changes/.test(x.reason)), JSON.stringify(r.retained));
  assert.strictEqual(fs.existsSync(wt), true);
  assert.ok(s.getTask(task.id).comments.some((c) => /worktree retained/.test(c.text)), 'flagged on the task');
  // The done-flip merge itself succeeds (untracked file), but cleanup must still refuse.
  const t2 = await done(s, task.id);
  assert.strictEqual(t2.status, 'done');
  assert.strictEqual(fs.existsSync(wt), true, 'dirty worktree survives even a landed merge');
  assert.strictEqual(t2.worktreePath, wt, 'fields kept when retained');
  assert.ok(t2.comments.some((c) => /worktree retained: worktree has uncommitted changes/.test(c.text)));
});

test('unmerged branch is retained', () => {
  const { s, task, wt } = setup('t_lc4');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n'); g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', 'work');
  s._updateTask(task.id, { status: 'done' });
  const r = WT.sweepWorktrees({ repoDir: repoOf(wt), store: s });
  assert.deepStrictEqual(r.removed, []);
  assert.ok(r.retained.some((x) => x.dir === 't_lc4' && /unmerged/.test(x.reason)), JSON.stringify(r.retained));
  assert.strictEqual(fs.existsSync(wt), true);
});

test('in-flight tasks are never touched (status, busy list, shared conflict dir)', () => {
  const { s, task, wt, repo } = setup('t_lc5');
  s._updateTask(task.id, { status: 'in_progress' });
  let r = WT.sweepWorktrees({ repoDir: repo, store: s });
  assert.deepStrictEqual(r.removed, []);
  s._updateTask(task.id, { status: 'todo' });
  r = WT.sweepWorktrees({ repoDir: repo, store: s, busyTaskIds: [task.id] });
  assert.deepStrictEqual(r.removed, [], 'busy list holds it even at todo');
  assert.strictEqual(fs.existsSync(wt), true);

  // A conflict-resolution task shares its parent's dir: parent done, resolve still in flight.
  fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n'); g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', 'work');
  g(repo, 'merge', '--no-ff', '-q', '-m', 'm', 'squad/t_lc5'); // branch fully merged, so only the ref blocks
  const res = s.createTask({ title: 'Resolve merge conflict: x', assignee: 'n_dev' });
  s._updateTask(res.id, { status: 'in_progress', worktreePath: wt, worktreeBranch: 'squad/t_lc5' });
  s._updateTask(task.id, { status: 'done' });
  r = WT.sweepWorktrees({ repoDir: repo, store: s });
  assert.deepStrictEqual(r.removed, [], 'resolve task keeps the shared dir');
  assert.ok(r.retained.some((x) => x.dir === 't_lc5' && /in_progress/.test(x.reason)), JSON.stringify(r.retained));
  assert.strictEqual(fs.existsSync(wt), true);
});

test('orphan worktrees are removed (clean + merged only) and the sweep prunes', () => {
  const { s, task, wt, repo } = setup('t_lc7'); // task t_lc7 is todo: its dir must survive
  const mk = (name, withCommit) => {
    const dir = path.join(repo, '.squad', 'worktrees', name);
    g(repo, 'worktree', 'add', '-b', `squad/${name}`, dir);
    if (withCommit) { fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n'); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'orphan work'); }
    return dir;
  };
  mk('t_orphan1', true); // unmerged: retained
  const orphan2 = mk('t_orphan2', false); // clean + no commits: removed
  let r = WT.sweepWorktrees({ repoDir: repo, store: s });
  assert.deepStrictEqual(r.removed, ['t_orphan2'], JSON.stringify(r));
  assert.ok(r.retained.some((x) => x.dir === 't_orphan1' && /unmerged/.test(x.reason)), JSON.stringify(r.retained));
  assert.ok(r.retained.some((x) => x.dir === 't_lc7'), 'in-flight task dir survives');
  assert.strictEqual(fs.existsSync(orphan2), false);
  assert.strictEqual(r.pruned, true);
  // A stale admin entry (dir deleted by hand) is pruned even though the sweep never saw the dir.
  g(repo, 'worktree', 'add', '-b', 'squad/t_orphan3', path.join(repo, '.squad', 'worktrees', 't_orphan3'));
  fs.rmSync(path.join(repo, '.squad', 'worktrees', 't_orphan3'), { recursive: true, force: true });
  const r3 = WT.sweepWorktrees({ repoDir: repo, store: s });
  assert.ok(r3.pruned);
  assert.strictEqual(g(repo, 'worktree', 'list').includes('t_orphan3'), false, 'stale entry pruned');
});

test('a board read error is not proof of orphans: the sweep no-ops', () => {
  const { s, task, wt } = setup('t_lc8');
  const broken = { listTasks() { throw new Error('disk on fire'); } };
  const r = WT.sweepWorktrees({ repoDir: repoOf(wt), store: broken });
  assert.strictEqual(r.removed.length, 0);
  assert.match(r.skipped, /board unreadable/);
  assert.strictEqual(fs.existsSync(wt), true);
});

// ---- disk usage ----

test('diskUsage: worktree count + bytes, symlinked node_modules not counted as a copy', async () => {
  const { repo } = setup('t_lc9');
  const u = await WT.diskUsage(repo, { force: true });
  assert.strictEqual(u.count, 1);
  assert.ok(u.bytes > 0);
  assert.ok(u.bytes < 128 * 1024, `bytes=${u.bytes} — a copied 300KB node_modules would blow past this`);
  assert.deepStrictEqual(await WT.diskUsage(repo), u, 'served from the TTL cache');
});

// ---- t_1ff80eba: our own node_modules link is not "uncommitted changes" ----

// A branch cut before the `node_modules` ignore landed: the auto-created symlink shows as
// untracked, which used to keep done worktrees alive forever.
function oldBranchRepo(withAppDir) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wlc-old-')));
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); // .gitignore deliberately absent
  if (withAppDir) {
    fs.mkdirSync(path.join(repo, 'app', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'app', 'a.txt'), 'app\n');
    fs.writeFileSync(path.join(repo, 'app', 'node_modules', 'blob.bin'), 'x'.repeat(64 * 1024));
    g(repo, 'add', 'a.txt', 'app/a.txt');
  } else {
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules', 'blob.bin'), 'x'.repeat(64 * 1024));
    g(repo, 'add', 'a.txt');
  }
  g(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

test('symlink-only worktree on a pre-ignore branch is clean and removed; a real copy still refuses', () => {
  const repo = oldBranchRepo(false);
  const w = WT.ensureWorktree(repo, 't_lc14');
  assert.ok(fs.lstatSync(path.join(w.worktreePath, 'node_modules')).isSymbolicLink());
  assert.strictEqual(g(w.worktreePath, 'status', '--porcelain'), '?? node_modules', 'the evidence from t_1ff80eba');
  assert.strictEqual(WT.worktreeDirty(w.worktreePath), false, 'our own link is not user work');
  assert.deepStrictEqual(WT.removeWorktree({ worktreePath: w.worktreePath, worktreeBranch: 'squad/t_lc14' }), { removed: true });
  assert.strictEqual(fs.existsSync(w.worktreePath), false);
  g(repo, 'rev-parse', '--verify', 'squad/t_lc14'); // throws (test failure) if the branch was dropped

  // A real node_modules dir (a deliberate local copy) is still uncommitted work: refuse.
  const w2 = WT.ensureWorktree(repo, 't_lc15');
  fs.rmSync(path.join(w2.worktreePath, 'node_modules'), { force: true, recursive: true }); // unlink the link, never the shared target
  fs.mkdirSync(path.join(w2.worktreePath, 'node_modules'));
  fs.writeFileSync(path.join(w2.worktreePath, 'node_modules', 'local.txt'), 'real\n');
  assert.strictEqual(WT.worktreeDirty(w2.worktreePath), true);
  assert.throws(() => WT.removeWorktree({ worktreePath: w2.worktreePath, worktreeBranch: 'squad/t_lc15' }), /uncommitted changes/);
});

test('same for the app/ layout: wt/app/node_modules link does not block removal', () => {
  const repo = oldBranchRepo(true);
  const w = WT.ensureWorktree(path.join(repo, 'app'), 't_lc16');
  assert.ok(fs.lstatSync(path.join(w.worktreePath, 'app', 'node_modules')).isSymbolicLink());
  assert.strictEqual(g(w.worktreePath, 'status', '--porcelain'), '?? app/node_modules', 'exactly the evidence comment');
  assert.strictEqual(WT.worktreeDirty(w.worktreePath), false);
  const r = WT.sweepWorktrees({ repoDir: repo, store: { listTasks: () => [], getTask: () => ({ id: 't_lc16', status: 'done' }) } }); // store knows the task as done: removable
  assert.deepStrictEqual(r.removed, ['t_lc16'], JSON.stringify(r));
  assert.strictEqual(fs.existsSync(w.worktreePath), false);
  g(repo, 'rev-parse', '--verify', 'squad/t_lc16'); // branch kept
});

test('a store that cannot see a worktree id retains it when work is at stake (t_e23df71f)', () => {
  const repo = oldBranchRepo(true);
  const w = WT.ensureWorktree(repo, 't_lc18');
  // Perf/e2e harness store: knows no tasks at all — the old orphan path deleted every real
  // worktree on such boots (Quinn's t_4382031b scratchpad, 2026-09-30). Uncommitted scratch in
  // an unknown-id dir must survive; only clean+merged dirs are safe to recycle.
  fs.writeFileSync(path.join(w.worktreePath, 'scratch.txt'), 'gate outputs\n');
  const r = WT.sweepWorktrees({ repoDir: repo, store: { listTasks: () => [], getTask: () => null } });
  assert.deepStrictEqual(r.removed, [], JSON.stringify(r));
  assert.ok(r.retained.some((e) => e.dir === 't_lc18' && /unknown to this store/.test(e.reason)), JSON.stringify(r.retained));
  assert.strictEqual(fs.existsSync(w.worktreePath), true);
  assert.strictEqual(fs.readFileSync(path.join(w.worktreePath, 'scratch.txt'), 'utf8'), 'gate outputs\n');
});

// ---- t_1ff80eba: stray gate/tmp registrations outside .squad/worktrees ----

test('stray squad-*/gate registrations are reaped; locked, dirty and non-matching ones survive', () => {
  const { repo, s } = setup('t_lc17');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wlc-stray-')));
  const gate = path.join(tmp, 'squad-gate-base-abc123');
  g(repo, 'worktree', 'add', '--detach', gate, 'HEAD');
  const scratch = path.join(tmp, 'squad-before');
  g(repo, 'worktree', 'add', '--detach', scratch, 'HEAD');
  const twt = path.join(tmp, 'tmp.xyz', 'wt');
  fs.mkdirSync(path.dirname(twt), { recursive: true });
  g(repo, 'worktree', 'add', '--detach', twt, 'HEAD');
  const user = path.join(tmp, 'user-lab'); // no squad shape: never touched
  g(repo, 'worktree', 'add', '-b', 'feature-lab', user);
  const locked = path.join(tmp, 'squad-locked'); // deliberately protected: never touched
  g(repo, 'worktree', 'add', '--detach', locked, 'HEAD');
  g(repo, 'worktree', 'lock', locked);

  const r = WT.sweepWorktrees({ repoDir: repo, store: s });
  assert.deepStrictEqual(r.strays.sort(), [gate, scratch, twt].sort(), JSON.stringify(r));
  for (const p of [gate, scratch, twt]) assert.strictEqual(fs.existsSync(p), false, `${p} reaped`);
  assert.strictEqual(fs.existsSync(user), true, 'a non-squad worktree is not ours to reap');
  assert.strictEqual(fs.existsSync(locked), true, 'locked entries are never touched');
  assert.strictEqual(g(repo, 'worktree', 'list').includes('squad-gate-base'), false, 'registration gone');
  g(repo, 'worktree', 'unlock', locked); g(repo, 'worktree', 'remove', '--force', locked); g(repo, 'worktree', 'remove', '--force', user); // test hygiene

  // A dirty stray might be someone's checkout: reported, not destroyed.
  const dirty = path.join(tmp, 'squad-dirty');
  g(repo, 'worktree', 'add', '--detach', dirty, 'HEAD');
  fs.writeFileSync(path.join(dirty, 'wip.txt'), 'mine\n');
  const r2 = WT.sweepWorktrees({ repoDir: repo, store: s });
  assert.deepStrictEqual(r2.strays, [], JSON.stringify(r2));
  assert.ok(r2.retained.some((x) => x.dir === dirty && /dirty/.test(x.reason)), JSON.stringify(r2.retained));
  assert.strictEqual(fs.existsSync(dirty), true);
});

// Repo root owning a worktree at <root>/.squad/worktrees/<taskId>.
function repoOf(wtPath) { return path.resolve(wtPath, '..', '..', '..'); }

// ---- QA (t_3344282a): pin the removeWorktree contract store._mergeOnDone leans on ----

test('removeWorktree: absent is a quiet no-op, dirty refuses, unmerged refuses, clean+merged removes and keeps the branch', () => {
  const { repo, wt } = setup('t_lc13');
  assert.deepStrictEqual(WT.removeWorktree(null), { removed: false, absent: true });
  assert.deepStrictEqual(WT.removeWorktree({}), { removed: false, absent: true });
  assert.deepStrictEqual(WT.removeWorktree({ worktreePath: path.join(repo, '.squad', 'worktrees', 't_missing') }), { removed: false, absent: true });
  assert.strictEqual(WT.worktreeDirty(path.join(repo, '.squad', 'worktrees', 't_missing')), true, 'unreadable tree counts as dirty: removal never gambles');

  fs.writeFileSync(path.join(wt, 'd.txt'), 'uncommitted\n');
  assert.throws(() => WT.removeWorktree({ worktreePath: wt, worktreeBranch: 'squad/t_lc13' }), /uncommitted changes/);
  assert.strictEqual(fs.existsSync(wt), true);

  g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', 'work'); // clean now, but the branch is unmerged
  assert.throws(() => WT.removeWorktree({ worktreePath: wt, worktreeBranch: 'squad/t_lc13' }), /unmerged/);
  assert.strictEqual(fs.existsSync(wt), true);

  g(repo, 'merge', '--no-ff', '-q', '-m', 'm', 'squad/t_lc13'); // the human merge path
  assert.deepStrictEqual(WT.removeWorktree({ worktreePath: wt, worktreeBranch: 'squad/t_lc13' }), { removed: true });
  assert.strictEqual(fs.existsSync(wt), false);
  g(repo, 'rev-parse', '--verify', 'squad/t_lc13'); // throws (test failure) if the branch was dropped
});

// main.js sweeps at boot + every 10 min and orchestrator.start() sweeps before agents spawn
// (orchestrator.js); this pins the start() wiring — without it a refactor could silently
// disconnect startup cleanup while every sweepWorktrees unit test stays green.
test('startup sweep wiring: Orchestrator.start() sweeps orphan worktrees before agents spawn', () => {
  const repo = bareRepo();
  const orphan = path.join(repo, '.squad', 'worktrees', 't_orpwire');
  g(repo, 'worktree', 'add', '-b', 'squad/t_orpwire', orphan);
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'wlc-wirestore-'))); // empty board: nothing to dispatch
  const o = new Orchestrator(s, { repoDir: repo });
  o.spawnFn = () => ({ unref() {} }); // stub the detached red-master health child
  o.start();
  try {
    assert.strictEqual(fs.existsSync(orphan), false, 'orphan swept during start(), before any agent could spawn');
  } finally { o.stop(); }
});
