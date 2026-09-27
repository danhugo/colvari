const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const { ensureWorktree } = require('../src/worktree');

// Sets up a git repo (base branch `main`) plus a Store whose task carries a worktree
// pointing at squad/<taskId> inside that repo.
function setup(taskId) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-repo-')));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
  g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); fs.writeFileSync(path.join(repo, '.gitignore'), '.squad/\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  const w = ensureWorktree(repo, taskId);
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'am-store-')));
  let task = s.createTask({ title: 'do the thing', assignee: 'n_dev' });
  task = s._updateTask(task.id, { worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch });
  return { repo, g, s, task, worktreePath: w.worktreePath };
}

test('marking a task done auto-merges its squad branch into base', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am1');
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'new\n');
  g(worktreePath, 'add', '.'); g(worktreePath, 'commit', '-q', '-m', 'work');
  const updated = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(updated.status, 'done');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'new\n');
  assert.ok(updated.comments.some((c) => /auto-merged/.test(c.text)));
});

test('conflicting merge aborts, marks merge_conflict, and creates a follow-up task', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am2');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  const head = g(repo, 'rev-parse', 'HEAD');

  const updated = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(updated.status, 'merge_conflict');
  assert.strictEqual(g(repo, 'rev-parse', 'HEAD'), head, 'base left clean, no partial merge');
  assert.strictEqual(g(repo, 'status', '--porcelain'), '');

  const followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1);
  assert.strictEqual(followUps[0].assignee, 'n_dev');
  assert.match(followUps[0].title, /Resolve merge conflict/);
});

test('already-merged branch: marking done again is a no-op success, not an error', () => {
  const { s, task, worktreePath } = setup('t_am3');
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'new\n');
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '.'], { cwd: worktreePath });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'work'], { cwd: worktreePath });

  const first = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(first.status, 'done');
  // Re-applying the same status (e.g. via approveTask) merges an already-merged branch again cleanly.
  const second = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(second.status, 'done');
});

test('a second conflict on the same branch does not spawn a second resolve task', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am5');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');

  s.updateTask(task.id, { status: 'done' });
  s.updateTask(task.id, { status: 'done' }); // re-trigger the same conflict
  const followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1, 'still just one resolve task for this branch');
  assert.strictEqual(followUps[0].isConflictResolution, true);
  assert.strictEqual(followUps[0].conflictBranch, task.worktreeBranch);
});

test('resolve task reuses the original branch/worktree and never doubles its title', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am6');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  s.updateTask(task.id, { status: 'done' });

  const followUp = s.listTasks().find((t) => t.parentId === task.id);
  assert.strictEqual(followUp.worktreeBranch, task.worktreeBranch);
  assert.strictEqual(followUp.worktreePath, task.worktreePath);
  assert.strictEqual((followUp.title.match(/Resolve merge conflict:/g) || []).length, 1);

  // Resolving on the original branch, then marking the resolve task done re-merges that same branch.
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'resolved\n'); g(worktreePath, 'commit', '-qam', 'resolve');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'resolved\n'); g(repo, 'commit', '-qam', 'match'); // simulate rebase catching up
  const done = s.updateTask(followUp.id, { status: 'done' });
  assert.strictEqual(done.status, 'done');
});

test('a resolve task that keeps conflicting is reopened, then escalated to a human, never re-spawned', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am7');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  s.updateTask(task.id, { status: 'done' });
  const followUp = s.listTasks().find((t) => t.parentId === task.id);

  let last = followUp;
  for (let i = 0; i < Store.MAX_CONFLICT_RETRIES - 1; i++) {
    fs.writeFileSync(path.join(repo, 'a.txt'), `ours-${i}\n`); g(repo, 'commit', '-qam', `o${i}`); // keep base diverging
    last = s.updateTask(last.id, { status: 'done' });
    assert.strictEqual(last.status, 'todo', `attempt ${i}: reopened, not re-spawned`);
  }
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours-final\n'); g(repo, 'commit', '-qam', 'ofinal');
  last = s.updateTask(last.id, { status: 'done' });
  assert.strictEqual(last.status, 'waiting_for_human');

  const resolveTasks = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(resolveTasks.length, 1, 'never spawned a second resolve task, even after repeated failures');
});

test('a task whose title already carries the resolve prefix never gets it doubled', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am8');
  s._updateTask(task.id, { title: 'Resolve merge conflict: something' });
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  s.updateTask(task.id, { status: 'done' });
  const followUp = s.listTasks().find((t) => t.parentId === task.id);
  assert.strictEqual(followUp.title, 'Resolve merge conflict: something');
});

test('listUnmergedBranches reports branches not yet merged into base', () => {
  const { s, task, worktreePath } = setup('t_am4');
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'new\n');
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '.'], { cwd: worktreePath });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'work'], { cwd: worktreePath });

  let unmerged = s.listUnmergedBranches();
  assert.ok(unmerged.some((b) => b.branch === task.worktreeBranch));

  s.updateTask(task.id, { status: 'done' });
  unmerged = s.listUnmergedBranches();
  assert.ok(!unmerged.some((b) => b.branch === task.worktreeBranch));
});

// Makes `a.txt` diverge between a task's worktree branch and its base repo, so the
// next auto-merge attempt on that task is guaranteed to conflict.
function conflictAgain(g, repo, worktreePath, tag) {
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), `theirs-${tag}\n`);
  g(worktreePath, 'commit', '-qam', `w-${tag}`);
  fs.writeFileSync(path.join(repo, 'a.txt'), `ours-${tag}\n`);
  g(repo, 'commit', '-qam', `o-${tag}`);
}

test('repeated conflict on the same task reuses the one open resolve task (no duplicate)', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am5');
  conflictAgain(g, repo, worktreePath, 1);
  let updated = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(updated.status, 'merge_conflict');
  let followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1);
  const firstFollowUpId = followUps[0].id;

  // Conflicts again before the resolve task is closed: still exactly one, same, follow-up.
  conflictAgain(g, repo, worktreePath, 2);
  updated = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(updated.status, 'merge_conflict');
  followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1, 'a second conflict must not spawn a second resolve task');
  assert.strictEqual(followUps[0].id, firstFollowUpId, 'the existing open resolve task is reused, not replaced');
});

test('a conflict while resolving a conflict task never nests the title and stays bounded', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am6');
  conflictAgain(g, repo, worktreePath, 1);
  s.updateTask(task.id, { status: 'done' });
  const resolveTask = s.listTasks().find((t) => t.parentId === task.id);
  assert.ok(resolveTask);
  assert.strictEqual(resolveTask.title, 'Resolve merge conflict: do the thing');

  // The resolve task itself picks up a worktree branch (e.g. an assignee fixes it in its own
  // branch) and that branch *also* fails to auto-merge cleanly.
  const w2 = ensureWorktree(repo, resolveTask.id);
  s._updateTask(resolveTask.id, { worktreePath: w2.worktreePath, worktreeBranch: w2.worktreeBranch });
  conflictAgain(g, repo, w2.worktreePath, 2);
  s.updateTask(resolveTask.id, { status: 'done' });

  const titles = s.listTasks().map((t) => t.title);
  assert.ok(!titles.some((t) => /Resolve merge conflict:.*Resolve merge conflict:/.test(t)), `title nested: ${JSON.stringify(titles)}`);
  const resolveCount = titles.filter((t) => t.startsWith('Resolve merge conflict:')).length;
  assert.ok(resolveCount <= 2, `resolve-task count should stay bounded, got ${resolveCount}: ${JSON.stringify(titles)}`);
});

test('once the conflict is actually fixed, re-marking the task done lands its branch on master', () => {
  const { repo, g, s, task, worktreePath } = setup('t_am7');
  conflictAgain(g, repo, worktreePath, 1);
  const parked = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(parked.status, 'merge_conflict');
  assert.ok(s.listUnmergedBranches().some((b) => b.branch === task.worktreeBranch));

  // Resolve the conflict for real: make the worktree branch match base, then commit.
  const baseContent = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), baseContent);
  g(worktreePath, 'commit', '-qam', 'resolve conflict');

  const resolved = s.updateTask(task.id, { status: 'done' });
  assert.strictEqual(resolved.status, 'done');
  assert.doesNotThrow(() => g(repo, 'merge-base', '--is-ancestor', task.worktreeBranch, 'main'));
  assert.ok(!s.listUnmergedBranches().some((b) => b.branch === task.worktreeBranch));
});
