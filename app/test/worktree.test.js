const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureWorktree } = require('../src/worktree');

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
