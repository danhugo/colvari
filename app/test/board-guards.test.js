const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { ensureWorktree } = require('../src/worktree');

// Git repo (base `main`) + store with a PM caller, two Devs, a QA and a keeper node that holds
// the worktree anchor task (so dev starts with a clean open-task count). PM has assign edges to
// everyone. The anchor gives repo-root derivation (used by the unmerged-branch guard) a real
// worktree to resolve.
function setup() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bg-repo-')));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.squad/\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'bg-store-')));
  const pm = s.addNode({ name: 'Pia', role: 'PM' });
  const dev = s.addNode({ name: 'Devon', role: 'Dev' });
  const dev2 = s.addNode({ name: 'Dee', role: 'Dev' });
  const qa = s.addNode({ name: 'Quinn', role: 'QA' });
  const keeper = s.addNode({ name: 'Keeper', role: 'Keeper' });
  for (const n of [dev, dev2, qa]) s.addEdge(pm.id, n.id);
  const anchor = s.createTask({ title: 'anchor', assignee: keeper.id, createdBy: pm.id });
  const w = ensureWorktree(repo, anchor.id);
  s._updateTask(anchor.id, { worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch });
  return { repo, g, s, pm, dev, dev2, qa, anchor };
}

// The merge gate completes synchronously inside updateTask, but poll for its terminal comment
// anyway (same defensive pattern as auto-merge.test.js) so the test holds either way.
function settle(s, id, from) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const t = s.getTask(id);
      const cs = (t && t.comments) || [];
      if (cs.length > from && !/^merge gate: running the unit suite/.test(cs[cs.length - 1].text)) return resolve(s.getTask(id));
      if (Date.now() - t0 > 30000) return reject(new Error('gate did not settle'));
      setTimeout(check, 20);
    };
    check();
  });
}

// ---- update_task_status: done must not strand an unmerged branch ----

test('done is refused with the branch named when worktreeBranch is unmerged and there is no worktree', () => {
  const { repo, g, s, pm, dev } = setup();
  g(repo, 'checkout', '-qb', 'squad/t_stray');
  fs.writeFileSync(path.join(repo, 'stray.txt'), 'stray\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'stray');
  g(repo, 'checkout', 'main');
  const tk = makeTools(s, pm.id).create_task({ title: 'stray work', assignee: dev.id });
  s._updateTask(tk.id, { status: 'in_progress', worktreeBranch: 'squad/t_stray' });
  assert.throws(
    () => makeTools(s, dev.id).update_task_status({ taskId: tk.id, status: 'done' }),
    /squad\/t_stray is not merged into main/
  );
  assert.strictEqual(s.getTask(tk.id).status, 'in_progress', 'status left unchanged by the refusal');
});

test('done passes when the branch is already merged into the base', () => {
  const { repo, g, s, pm, dev } = setup();
  g(repo, 'checkout', '-qb', 'squad/t_merged');
  fs.writeFileSync(path.join(repo, 'm.txt'), 'm\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'm');
  g(repo, 'checkout', 'main');
  g(repo, 'merge', '--no-ff', '--no-edit', '-qm', 'land t_merged', 'squad/t_merged');
  const tk = makeTools(s, pm.id).create_task({ title: 'merged work', assignee: dev.id });
  s._updateTask(tk.id, { status: 'in_progress', worktreeBranch: 'squad/t_merged' });
  makeTools(s, dev.id).update_task_status({ taskId: tk.id, status: 'done' });
  assert.strictEqual(s.getTask(tk.id).status, 'done');
});

test('done is allowed (fail-open) when no repo can be derived to verify the branch', () => {
  const { s, pm, dev, anchor } = setup();
  s._updateTask(anchor.id, { worktreePath: null, worktreeBranch: null });
  const tk = makeTools(s, pm.id).create_task({ title: 'unverifiable', assignee: dev.id });
  s._updateTask(tk.id, { status: 'in_progress', worktreeBranch: 'squad/nowhere' });
  makeTools(s, dev.id).update_task_status({ taskId: tk.id, status: 'done' });
  assert.strictEqual(s.getTask(tk.id).status, 'done');
});

test('with a worktree the done flip still runs the auto-merge instead of refusing', async () => {
  const { repo, g, s, pm, dev } = setup();
  const tk = makeTools(s, pm.id).create_task({ title: 'real work', assignee: dev.id });
  const w = ensureWorktree(repo, tk.id);
  s._updateTask(tk.id, { status: 'in_progress', worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch });
  fs.writeFileSync(path.join(w.worktreePath, 'w.txt'), 'w\n');
  g(w.worktreePath, 'add', '.'); g(w.worktreePath, 'commit', '-q', '-m', 'w');
  const from = (s.getTask(tk.id).comments || []).length;
  makeTools(s, dev.id).update_task_status({ taskId: tk.id, status: 'done' });
  const final = await settle(s, tk.id, from);
  assert.strictEqual(final.status, 'done');
  assert.ok(fs.existsSync(path.join(repo, 'w.txt')), 'branch work landed on the base branch');
});

// ---- create_task: overload warning ----

test('create_task warns when the assignee reaches 2 open tasks while a same-role teammate is idle', () => {
  const { s, pm, dev } = setup();
  makeTools(s, pm.id).create_task({ title: 'one', assignee: dev.id });
  const second = makeTools(s, pm.id).create_task({ title: 'two', assignee: dev.id });
  assert.match(second.warning, /overload: Devon now has 2 open tasks/);
  assert.match(second.warning, /Dee \(Dev\)/);
  assert.strictEqual(second.assignee, dev.id, 'the task is still created — the warning is advisory');
});

test('no warning when every same-role/dev teammate already has open work', () => {
  const { s, pm, dev, dev2 } = setup();
  makeTools(s, pm.id).create_task({ title: 'd1', assignee: dev.id });
  makeTools(s, pm.id).create_task({ title: 'busy', assignee: dev2.id });
  const r = makeTools(s, pm.id).create_task({ title: 'd2', assignee: dev.id });
  assert.strictEqual(r.warning, undefined);
});

test('no warning while the assignee has fewer than 2 open tasks', () => {
  const { s, pm, dev } = setup();
  const r = makeTools(s, pm.id).create_task({ title: 'solo', assignee: dev.id });
  assert.strictEqual(r.warning, undefined);
});

test('a dev-role teammate counts as an idle candidate across role spellings; unrelated roles do not', () => {
  const { s, pm, dev } = setup();
  s.addNode({ name: 'Uma', role: 'Dev (UI)' });
  s.addNode({ name: 'Rey', role: 'Reviewer' });
  makeTools(s, pm.id).create_task({ title: 'one', assignee: dev.id });
  const r = makeTools(s, pm.id).create_task({ title: 'two', assignee: dev.id });
  assert.match(r.warning, /Uma \(Dev \(UI\)\)/);
  assert.doesNotMatch(r.warning, /Rey|Quinn/);
});

test('done tasks do not count toward the open load', () => {
  const { s, pm, dev } = setup();
  const a = makeTools(s, pm.id).create_task({ title: 'a', assignee: dev.id });
  s.updateTask(a.id, { status: 'done' });
  const b = makeTools(s, pm.id).create_task({ title: 'b', assignee: dev.id });
  assert.strictEqual(b.warning, undefined);
});
