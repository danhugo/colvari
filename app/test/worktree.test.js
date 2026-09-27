const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureWorktree, worktreeDiff, worktreeMerge, worktreeDiscard } = require('../src/worktree');

test('falls back when not a git repo', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const r = ensureWorktree(d, 't_1');
  assert.strictEqual(r.cwd, d); assert.ok(r.warning); assert.ok(!r.worktreePath);
});

test('creates worktree on squad/<taskId> and reuses it', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  g('init', '-q'); g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
  const r = ensureWorktree(d, 't_2');
  assert.strictEqual(r.worktreePath, path.join(d, '.squad', 'worktrees', 't_2'));
  assert.strictEqual(r.worktreeBranch, 'squad/t_2'); assert.strictEqual(r.cwd, r.worktreePath);
  assert.strictEqual(execFileSync('git', ['branch', '--show-current'], { cwd: r.cwd }).toString().trim(), 'squad/t_2');
  assert.deepStrictEqual(ensureWorktree(d, 't_2'), r);
});

test('useWorktrees defaults off', () => {
  const Store = require('../src/store');
  const S = Store.Store || Store;
  const s = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  assert.strictEqual(s.getSettings().useWorktrees, false);
});

function repoWithTask(id) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
  g(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), 'base\n'); fs.writeFileSync(path.join(d, '.gitignore'), '.squad/\n');
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  const w = ensureWorktree(d, id); return { d, g, t: { id, worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch } };
}

test('diff lists changed files and unified diff; merge brings branch into base', () => {
  const { d, g, t } = repoWithTask('t_3');
  fs.writeFileSync(path.join(t.worktreePath, 'a.txt'), 'changed\n'); fs.writeFileSync(path.join(t.worktreePath, 'b.txt'), 'new\n');
  g(t.worktreePath, 'add', '.'); g(t.worktreePath, 'commit', '-q', '-m', 'work');
  const r = worktreeDiff(t);
  assert.strictEqual(r.base, 'main');
  assert.deepStrictEqual(r.files, [{ status: 'M', file: 'a.txt' }, { status: 'A', file: 'b.txt' }]);
  assert.match(r.diff, /\+changed/);
  worktreeMerge(t);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'changed\n');
});

test('merge conflict aborts with error and leaves base clean', () => {
  const { d, g, t } = repoWithTask('t_4');
  fs.writeFileSync(path.join(t.worktreePath, 'a.txt'), 'theirs\n'); g(t.worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(d, 'a.txt'), 'ours\n'); g(d, 'commit', '-qam', 'o');
  const head = g(d, 'rev-parse', 'HEAD');
  assert.throws(() => worktreeMerge(t), /failed, aborted/);
  assert.strictEqual(g(d, 'rev-parse', 'HEAD'), head);
  assert.strictEqual(g(d, 'status', '--porcelain'), '');
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'ours\n');
});

test('discard removes worktree and branch', () => {
  const { d, g, t } = repoWithTask('t_5');
  worktreeDiscard(t);
  assert.ok(!fs.existsSync(t.worktreePath));
  assert.strictEqual(g(d, 'branch', '--list', t.worktreeBranch), '');
});
