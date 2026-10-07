const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureWorktree, linkNodeModules, worktreeDiff, worktreeMerge, worktreeDiscard } = require('../src/worktree');

test('falls back when not a git repo', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const r = await ensureWorktree(d, 't_1');
  assert.strictEqual(r.cwd, d); assert.ok(r.warning); assert.ok(!r.worktreePath);
});

test('creates worktree on squad/<taskId> and reuses it', async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  g('init', '-q'); g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
  const r = await ensureWorktree(d, 't_2');
  assert.strictEqual(r.worktreePath, path.join(d, '.squad', 'worktrees', 't_2'));
  assert.strictEqual(r.worktreeBranch, 'squad/t_2'); assert.strictEqual(r.cwd, r.worktreePath);
  assert.strictEqual(execFileSync('git', ['branch', '--show-current'], { cwd: r.cwd }).toString().trim(), 'squad/t_2');
  assert.deepStrictEqual(await ensureWorktree(d, 't_2'), r);
});

// npm install in a worktree must not write through the shared node_modules into the main checkout
// (t_0fd83668): a worktree whose package files differ gets NO shared node_modules, an unchanged
// one gets its own copy-on-write clone (never a symlink, t_09a2c1e0).
test('node_modules share: unchanged package files -> clone, changed package.json -> none (t_0fd83668)', async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
  g(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, '.gitignore'), '.squad/\n');
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"m"}\n');
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.writeFileSync(path.join(d, 'node_modules', 'dep.js'), 'x');
  const same = await ensureWorktree(d, 't_nmA');
  assert.strictEqual(fs.readFileSync(path.join(same.worktreePath, 'node_modules', 'dep.js'), 'utf8'), 'x', 'unchanged package files: node_modules cloned from main');
  assert.strictEqual(fs.lstatSync(path.join(same.worktreePath, 'node_modules')).isSymbolicLink(), false, 'a real dir, never a link');
  // A branch that changes package.json: commit the change on a scratch worktree, then let
  // ensureWorktree recreate the task worktree from that branch.
  const scratch = path.join(d, '.squad', 'scratch-t_nmB');
  g(d, 'worktree', 'add', '-b', 'squad/t_nmB', scratch);
  fs.writeFileSync(path.join(scratch, 'package.json'), '{"name":"branch","deps":"added"}\n');
  g(scratch, 'commit', '-qam', 'bump deps');
  fs.rmSync(scratch, { recursive: true, force: true });
  g(d, 'worktree', 'prune');
  const diff = await ensureWorktree(d, 't_nmB');
  assert.strictEqual(fs.existsSync(path.join(diff.worktreePath, 'node_modules')), false, 'changed package.json: no shared node_modules in the worktree');
  assert.strictEqual(fs.lstatSync(path.join(d, 'node_modules')).isSymbolicLink(), false, 'main checkout node_modules stays a real dir');
});

test('node_modules share: differing package-lock.json also skips the share (t_0fd83668)', async () => {
  const main = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-main-')));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lock-'));
  fs.writeFileSync(path.join(main, 'package.json'), '{"name":"m"}\n');
  fs.writeFileSync(path.join(main, 'package-lock.json'), '{"lock":1}\n');
  fs.mkdirSync(path.join(main, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'package.json'), '{"name":"m"}\n');
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"lock":2}\n');
  await linkNodeModules(main, main, wt);
  assert.strictEqual(fs.existsSync(path.join(wt, 'node_modules')), false, 'lock-only difference: no shared node_modules');
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"lock":1}\n');
  await linkNodeModules(main, main, wt);
  assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isDirectory(), 'identical files: the clone happens');
});

test('useWorktrees defaults on (t_064066e5: code tasks get worktrees unless a project opts out)', () => {
  const Store = require('../src/store');
  const S = Store.Store || Store;
  const s = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  assert.strictEqual(s.getSettings().useWorktrees, true);
  s.saveSettings({ useWorktrees: false });
  assert.strictEqual(s.getSettings().useWorktrees, false);
});

async function repoWithTask(id) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
  g(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), 'base\n'); fs.writeFileSync(path.join(d, '.gitignore'), '.squad/\n');
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  const w = await ensureWorktree(d, id); return { d, g, t: { id, worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch } };
}

test('diff lists changed files and unified diff; merge brings branch into base', async () => {
  const { d, g, t } = await repoWithTask('t_3');
  fs.writeFileSync(path.join(t.worktreePath, 'a.txt'), 'changed\n'); fs.writeFileSync(path.join(t.worktreePath, 'b.txt'), 'new\n');
  g(t.worktreePath, 'add', '.'); g(t.worktreePath, 'commit', '-q', '-m', 'work');
  const r = await worktreeDiff(t);
  assert.strictEqual(r.base, 'main');
  assert.deepStrictEqual(r.files, [{ status: 'M', file: 'a.txt' }, { status: 'A', file: 'b.txt' }]);
  assert.match(r.diff, /\+changed/);
  await worktreeMerge(t);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'changed\n');
});

test('merge conflict aborts with error and leaves base clean', async () => {
  const { d, g, t } = await repoWithTask('t_4');
  fs.writeFileSync(path.join(t.worktreePath, 'a.txt'), 'theirs\n'); g(t.worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(d, 'a.txt'), 'ours\n'); g(d, 'commit', '-qam', 'o');
  const head = g(d, 'rev-parse', 'HEAD');
  await assert.rejects(() => worktreeMerge(t), /failed, aborted/);
  assert.strictEqual(g(d, 'rev-parse', 'HEAD'), head);
  assert.strictEqual(g(d, 'status', '--porcelain'), '');
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'ours\n');
});

// t_8ace5439: a dirty main checkout must refuse the merge (naming the files) instead of
// letting git merge fail or half-apply around uncommitted work (the t_048c41be incident).
test('dirty main checkout: merge refused, nothing merged, dirty files named', async () => {
  const { d, g, t } = await repoWithTask('t_10');
  fs.writeFileSync(path.join(t.worktreePath, 'b.txt'), 'new\n');
  g(t.worktreePath, 'add', '.'); g(t.worktreePath, 'commit', '-q', '-m', 'work');
  // Both status kinds: untracked ("??") and worktree-modified (" M", first line — the one
  // a blob-level trim() would corrupt).
  fs.writeFileSync(path.join(d, 'dirty.txt'), 'uncommitted\n');
  fs.writeFileSync(path.join(d, 'a.txt'), 'modified\n');
  const head = g(d, 'rev-parse', 'HEAD');
  const r = await worktreeMerge(t);
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.refused, true);
  assert.ok(r.dirty.includes('dirty.txt') && r.dirty.includes('a.txt'), `dirty list names the files: ${JSON.stringify(r.dirty)}`);
  assert.strictEqual(g(d, 'rev-parse', 'HEAD'), head, 'no merge happened');
  assert.ok(!fs.existsSync(path.join(d, 'b.txt')), 'branch work stayed out of base');
});

test('only .squad/ dirty in main: merge still runs (managed files are not real dirt)', async () => {
  const { d, g, t } = await repoWithTask('t_11');
  fs.writeFileSync(path.join(t.worktreePath, 'b.txt'), 'new\n');
  g(t.worktreePath, 'add', '.'); g(t.worktreePath, 'commit', '-q', '-m', 'work');
  // A tracked, modified file under .squad/ (board data) shows in porcelain but must not block:
  // staged NEW files would make git itself refuse, so track it first, then dirty it.
  fs.mkdirSync(path.join(d, '.squad', 'board'), { recursive: true });
  fs.writeFileSync(path.join(d, '.squad', 'board', 'x.json'), '{}\n');
  g(d, 'add', '-f', '.squad/board/x.json'); g(d, 'commit', '-qam', 'board file');
  fs.writeFileSync(path.join(d, '.squad', 'board', 'x.json'), '{"v":2}\n');
  const r = await worktreeMerge(t);
  assert.strictEqual(r.merged, true);
  assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'new\n');
});

test('discard removes worktree and branch', async () => {
  const { d, g, t } = await repoWithTask('t_5');
  await worktreeDiscard(t);
  assert.ok(!fs.existsSync(t.worktreePath));
  assert.strictEqual(g(d, 'branch', '--list', t.worktreeBranch), '');
});
