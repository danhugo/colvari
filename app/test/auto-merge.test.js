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

// The merge gate runs asynchronously (it may run the test suite before merging), so the final
// status no longer rides on updateTask's synchronous return: wait for the gate's terminal
// comment — exactly one new comment past the baseline count taken after the done flip (the
// flip itself synchronously adds the "running npm test" pre-comment; anything else is final).
function settle(s, id, from) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const t = s.getTask(id);
      const cs = (t && t.comments) || [];
      if (cs.length > from && !/^merge gate: running npm test/.test(cs[cs.length - 1].text)) return resolve(s.getTask(id));
      if (Date.now() - t0 > 30000) return reject(new Error('gate did not settle: ' + JSON.stringify(cs.map((c) => c.text)).slice(0, 400)));
      setTimeout(check, 20);
    };
    check();
  });
}
// Flip to done and wait for the gate to finish; resolves with the task in its final state.
function done(s, id) {
  const from = (s.getTask(id).comments || []).length;
  s.updateTask(id, { status: 'done' });
  return settle(s, id, from);
}

test('marking a task done auto-merges its squad branch into base', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am1');
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'new\n');
  g(worktreePath, 'add', '.'); g(worktreePath, 'commit', '-q', '-m', 'work');
  const updated = await done(s, task.id);
  assert.strictEqual(updated.status, 'done');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'new\n');
  assert.ok(updated.comments.some((c) => /auto-merged/.test(c.text)));
});

test('conflicting merge aborts, marks merge_conflict, and creates a follow-up task', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am2');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  const head = g(repo, 'rev-parse', 'HEAD');

  const updated = await done(s, task.id);
  assert.strictEqual(updated.status, 'merge_conflict');
  assert.strictEqual(g(repo, 'rev-parse', 'HEAD'), head, 'base left clean, no partial merge');
  assert.strictEqual(g(repo, 'status', '--porcelain'), '');

  const followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1);
  assert.strictEqual(followUps[0].assignee, 'n_dev');
  assert.match(followUps[0].title, /Resolve merge conflict/);
});

test('already-merged branch: marking done again is a no-op success, not an error', async () => {
  const { s, task, worktreePath } = setup('t_am3');
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'new\n');
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '.'], { cwd: worktreePath });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'work'], { cwd: worktreePath });

  const first = await done(s, task.id);
  assert.strictEqual(first.status, 'done');
  // Re-applying the same status (e.g. via approveTask) merges an already-merged branch again cleanly.
  const second = await done(s, task.id);
  assert.strictEqual(second.status, 'done');
});

test('a second conflict on the same branch does not spawn a second resolve task', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am5');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');

  await done(s, task.id);
  await done(s, task.id); // re-trigger the same conflict
  const followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1, 'still just one resolve task for this branch');
  assert.strictEqual(followUps[0].isConflictResolution, true);
  assert.strictEqual(followUps[0].conflictBranch, task.worktreeBranch);
});

test('resolve task reuses the original branch/worktree and never doubles its title', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am6');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  await done(s, task.id);

  const followUp = s.listTasks().find((t) => t.parentId === task.id);
  assert.strictEqual(followUp.worktreeBranch, task.worktreeBranch);
  assert.strictEqual(followUp.worktreePath, task.worktreePath);
  assert.strictEqual((followUp.title.match(/Resolve merge conflict:/g) || []).length, 1);

  // Resolving on the original branch, then marking the resolve task done re-merges that same branch.
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'resolved\n'); g(worktreePath, 'commit', '-qam', 'resolve');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'resolved\n'); g(repo, 'commit', '-qam', 'match'); // simulate rebase catching up
  const doneTask = await done(s, followUp.id);
  assert.strictEqual(doneTask.status, 'done');
});

test('a resolve task that keeps conflicting is reopened, then escalated to a human, never re-spawned', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am7');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  await done(s, task.id);
  const followUp = s.listTasks().find((t) => t.parentId === task.id);

  let last = followUp;
  for (let i = 0; i < Store.MAX_CONFLICT_RETRIES - 1; i++) {
    fs.writeFileSync(path.join(repo, 'a.txt'), `ours-${i}\n`); g(repo, 'commit', '-qam', `o${i}`); // keep base diverging
    last = await done(s, last.id);
    assert.strictEqual(last.status, 'todo', `attempt ${i}: reopened, not re-spawned`);
  }
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours-final\n'); g(repo, 'commit', '-qam', 'ofinal');
  last = await done(s, last.id);
  assert.strictEqual(last.status, 'waiting_for_human');

  const resolveTasks = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(resolveTasks.length, 1, 'never spawned a second resolve task, even after repeated failures');
});

test('a task whose title already carries the resolve prefix never gets it doubled', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am8');
  s._updateTask(task.id, { title: 'Resolve merge conflict: something' });
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'theirs\n'); g(worktreePath, 'commit', '-qam', 'w');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'o');
  await done(s, task.id);
  const followUp = s.listTasks().find((t) => t.parentId === task.id);
  assert.strictEqual(followUp.title, 'Resolve merge conflict: something');
});

test('listUnmergedBranches reports branches not yet merged into base', async () => {
  const { s, task, worktreePath } = setup('t_am4');
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'new\n');
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '.'], { cwd: worktreePath });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'work'], { cwd: worktreePath });

  let unmerged = s.listUnmergedBranches();
  assert.ok(unmerged.some((b) => b.branch === task.worktreeBranch));

  await done(s, task.id);
  unmerged = s.listUnmergedBranches();
  assert.ok(!unmerged.some((b) => b.branch === task.worktreeBranch));
});

// t_6aea5305: the registered branch is empty because the work landed on a differently-named
// branch (the t_bf1b168a review finding) — done must say so instead of claiming "auto-merged".
test('work committed on another branch: done stays done but the comment reports nothing merged', async () => {
  const { repo, g, s, task } = setup('t_am9');
  g(repo, 'checkout', '-qb', 'squad/side-work');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'real work\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'real work');
  g(repo, 'checkout', '-q', 'main');

  const updated = await done(s, task.id);
  assert.strictEqual(updated.status, 'done');
  const sys = updated.comments.filter((c) => c.author === 'system').map((c) => c.text);
  assert.ok(!sys.some((t) => /auto-merged/.test(t)), `must not claim a merge that did not happen: ${JSON.stringify(sys)}`);
  assert.ok(sys.some((t) => t.includes(task.worktreeBranch) && /no commits/.test(t)), `must say the registered branch had no commits: ${JSON.stringify(sys)}`);
  assert.ok(!fs.existsSync(path.join(repo, 'b.txt')), 'side branch work must not be merged');
});

// t_8ace5439: uncommitted edits in the main checkout must refuse the merge with a clear
// message (files + how to retry), park the task in review (NOT merge_conflict — no resolve
// task), and let a later done after cleanup merge normally.
test('dirty main checkout: done refuses merge, parks task in review, names files; retry after cleanup merges', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am10');
  fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'new\n');
  g(worktreePath, 'add', '.'); g(worktreePath, 'commit', '-q', '-m', 'work');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'someone edits main\n');

  const updated = await done(s, task.id);
  assert.strictEqual(updated.status, 'review');
  const sys = updated.comments.filter((c) => c.author === 'system').map((c) => c.text);
  assert.ok(sys.some((t) => t.includes('dirty.txt') && /commit or clean main/i.test(t)), `refusal comment names the file and the retry: ${JSON.stringify(sys)}`);
  assert.strictEqual(s.listTasks().filter((t) => t.parentId === task.id).length, 0, 'no resolve task spawned for a refusal');
  assert.ok(!fs.existsSync(path.join(repo, 'b.txt')), 'nothing was merged into the dirty main');

  // Cleanup + retry: re-marking done now merges normally.
  fs.rmSync(path.join(repo, 'dirty.txt'));
  const retried = await done(s, task.id);
  assert.strictEqual(retried.status, 'done');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'new\n');
});

// Makes `a.txt` diverge between a task's worktree branch and its base repo, so the
// next auto-merge attempt on that task is guaranteed to conflict.
function conflictAgain(g, repo, worktreePath, tag) {
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), `theirs-${tag}\n`);
  g(worktreePath, 'commit', '-qam', `w-${tag}`);
  fs.writeFileSync(path.join(repo, 'a.txt'), `ours-${tag}\n`);
  g(repo, 'commit', '-qam', `o-${tag}`);
}

test('repeated conflict on the same task reuses the one open resolve task (no duplicate)', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am5b');
  conflictAgain(g, repo, worktreePath, 1);
  let updated = await done(s, task.id);
  assert.strictEqual(updated.status, 'merge_conflict');
  let followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1);
  const firstFollowUpId = followUps[0].id;

  // Conflicts again before the resolve task is closed: still exactly one, same, follow-up.
  conflictAgain(g, repo, worktreePath, 2);
  updated = await done(s, task.id);
  assert.strictEqual(updated.status, 'merge_conflict');
  followUps = s.listTasks().filter((t) => t.parentId === task.id);
  assert.strictEqual(followUps.length, 1, 'a second conflict must not spawn a second resolve task');
  assert.strictEqual(followUps[0].id, firstFollowUpId, 'the existing open resolve task is reused, not replaced');
});

test('a conflict while resolving a conflict task never nests the title and stays bounded', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am6b');
  conflictAgain(g, repo, worktreePath, 1);
  await done(s, task.id);
  const resolveTask = s.listTasks().find((t) => t.parentId === task.id);
  assert.ok(resolveTask);
  assert.strictEqual(resolveTask.title, 'Resolve merge conflict: do the thing');

  // The resolve task itself picks up a worktree branch (e.g. an assignee fixes it in its own
  // branch) and that branch *also* fails to auto-merge cleanly.
  const w2 = ensureWorktree(repo, resolveTask.id);
  s._updateTask(resolveTask.id, { worktreePath: w2.worktreePath, worktreeBranch: w2.worktreeBranch });
  conflictAgain(g, repo, w2.worktreePath, 2);
  await done(s, resolveTask.id);

  const titles = s.listTasks().map((t) => t.title);
  assert.ok(!titles.some((t) => /Resolve merge conflict:.*Resolve merge conflict:/.test(t)), `title nested: ${JSON.stringify(titles)}`);
  const resolveCount = titles.filter((t) => t.startsWith('Resolve merge conflict:')).length;
  assert.ok(resolveCount <= 2, `resolve-task count should stay bounded, got ${resolveCount}: ${JSON.stringify(titles)}`);
});

test('once the conflict is actually fixed, re-marking the task done lands its branch on master', async () => {
  const { repo, g, s, task, worktreePath } = setup('t_am7b');
  conflictAgain(g, repo, worktreePath, 1);
  const parked = await done(s, task.id);
  assert.strictEqual(parked.status, 'merge_conflict');
  assert.ok(s.listUnmergedBranches().some((b) => b.branch === task.worktreeBranch));

  // Resolve the conflict for real: make the worktree branch match base, then commit.
  const baseContent = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8');
  fs.writeFileSync(path.join(worktreePath, 'a.txt'), baseContent);
  g(worktreePath, 'commit', '-qam', 'resolve conflict');

  const resolved = await done(s, task.id);
  assert.strictEqual(resolved.status, 'done');
  assert.doesNotThrow(() => g(repo, 'merge-base', '--is-ancestor', task.worktreeBranch, 'main'));
  assert.ok(!s.listUnmergedBranches().some((b) => b.branch === task.worktreeBranch));
});
