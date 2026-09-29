const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const C = require('../src/controls');

function fakeClaude(dir, script) {
  const f = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(f, '#!/bin/sh\n' + script);
  fs.chmodSync(f, 0o755);
  return f;
}
const RESULT = (extra = '') => `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}'\n${extra}`;

function setup(script = RESULT()) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-sched-'));
  const s = new Store(path.join(r, 'data'));
  s.saveSettings({ claudePath: fakeClaude(r, script), maxConcurrency: 1 });
  return { r, s };
}

// ---- priority ----

test('controls: normalizePriority defaults to P2 and rejects unknown values', () => {
  assert.equal(C.normalizePriority(undefined), 'P2');
  assert.equal(C.normalizePriority('bogus'), 'P2');
  assert.equal(C.normalizePriority('P0'), 'P0');
});

test('store: createTask defaults priority to P2, updateTask validates it', () => {
  const { s } = setup();
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'x', assignee: n.id });
  assert.equal(t.priority, 'P2');
  const t1 = s.createTask({ title: 'y', assignee: n.id, priority: 'P0' });
  assert.equal(t1.priority, 'P0');
  const t2 = s.updateTask(t1.id, { priority: 'bogus' });
  assert.equal(t2.priority, 'P2'); // invalid falls back to default
});

test('orchestrator: scheduler dispatches the highest-priority ready task first', async () => {
  const { s } = setup();
  const n = s.addNode({ name: 'D', role: 'Dev' }); // single agent: only one task can run at a time
  const low = s.createTask({ title: 'low', assignee: n.id, priority: 'P3' });
  const high = s.createTask({ title: 'high', assignee: n.id, priority: 'P0' });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(o.snapshot().active[0].taskId, high.id, 'P0 task must be dispatched before the P3 task');
  await done;
  assert.ok([low, high].every((t) => s.getTask(t.id).status === 'done'));
});

test('board-tools: create_task and update_task_status accept/validate priority', () => {
  const { s } = setup();
  const { makeTools } = require('../src/board-tools');
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const tools = makeTools(s, a.id);
  const t = tools.create_task({ title: 'x', priority: 'P1' });
  assert.equal(t.priority, 'P1');
  const t2 = tools.update_task_status({ taskId: t.id, status: 'in_progress', priority: 'P0' });
  assert.equal(t2.priority, 'P0');
});

// ---- review-stuck pickup ----

test('orchestrator: review task with a reviewer edge is dispatched to the reviewer, not left stuck', async () => {
  const { s } = setup();
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(dev.id, rev.id, 'review');
  const t = s.createTask({ title: 'needs review', assignee: dev.id });
  s.updateTask(t.id, { status: 'review' }); // e.g. left in review by a previous, now-dead run
  const dependent = s.createTask({ title: 'depends on review', assignee: dev.id, blockedBy: [t.id] });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  await done;
  assert.equal(s.getTask(t.id).status, 'done');
  assert.equal(s.getTask(dependent.id).status, 'done');
  // dev's silent finish of the dependent also hands off to review now, so the reviewer runs twice:
  // once for t, once for the dependent.
  assert.equal(o.agent(rev.id).runs, 2, 'the reviewer must actually have run both hand-offs');
});

test('orchestrator: review task with no reviewer edge auto-advances to done so dependents unblock', async () => {
  const { s } = setup();
  const dev = s.addNode({ name: 'Dev', role: 'Dev' }); // no review edge from dev anywhere
  const t = s.createTask({ title: 'orphan review', assignee: dev.id });
  s.updateTask(t.id, { status: 'review' });
  const dependent = s.createTask({ title: 'waits', assignee: dev.id, blockedBy: [t.id] });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  await done;
  const after = s.getTask(t.id);
  assert.equal(after.status, 'done');
  assert.ok(after.comments.some((c) => c.author === 'orchestrator' && /auto-advanced/.test(c.text)));
  assert.equal(s.getTask(dependent.id).status, 'done');
});

test('orchestrator: a review task parked for a human (no reviewer role) is left alone, not auto-advanced', async () => {
  const { s } = setup('exit 7\n'); // agent run "fails": task ends in_progress, orchestrator parks it in review
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const t = s.createTask({ title: 'will fail', assignee: dev.id });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  await done;
  const after = s.getTask(t.id);
  assert.equal(after.status, 'review');
  assert.equal(after.parkedForHuman, true);
});

// ---- accurate run 'done' ----

test("orchestrator: stop() does not emit 'done' until every agent process has actually exited", async () => {
  // Ignore SIGTERM for a bit so the process is still alive right after stop() sends it.
  const { s } = setup("trap '' TERM\nsleep 0.3\n" + RESULT());
  const n = s.addNode({ name: 'D', role: 'Dev' });
  s.createTask({ title: 'slow', assignee: n.id });
  const o = new Orchestrator(s);
  let fired = false;
  o.on('done', () => { fired = true; });
  o.start();
  await new Promise((r) => setTimeout(r, 50));
  o.stop();
  assert.equal(o.procs.size, 1, 'the child process has not exited yet when stop() returns');
  assert.equal(fired, false, "done' must not fire while the process is still running/pending");
  await new Promise((res) => o.on('done', res));
  assert.equal(o.procs.size, 0);
});

test("orchestrator: stop() with no running agents emits 'done' right away", async () => {
  const { s } = setup();
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.running = true; // nothing dispatched, no procs
  o.stop();
  await done; // must resolve synchronously/immediately, not hang
});

// ---- silent-exit hand-off ----

// Repo-backed store with worktrees on and an agent script that commits real work, so the
// auto-merge consequences of a status change are observable in the repo.
function setupRepo(script = RESULT()) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-exitrev-')));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.squad/\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  const s = new Store(repo);
  s.saveSettings({ claudePath: fakeClaude(repo, script), maxConcurrency: 1, useWorktrees: true });
  return { repo, g, s };
}
const COMMIT_WORK = RESULT("echo work > work.txt\ngit add .\ngit -c user.email=a@b -c user.name=a commit -qm work\n");

test('orchestrator: clean exit without status hands off to review without merging; no reviewer -> done on the sweep', async () => {
  // (1) dev with a review edge: the silent exit is a review hand-off, not an instant done+merge
  const a = setupRepo(COMMIT_WORK);
  const dev = a.s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = a.s.addNode({ name: 'Rev', role: 'Reviewer' });
  a.s.addEdge(dev.id, rev.id, 'review');
  const t1 = a.s.createTask({ title: 'silent exit', assignee: dev.id });
  const o1 = new Orchestrator(a.s);
  o1.running = true;
  await o1.runTask(a.s.getTeam().nodes.find((n) => n.id === dev.id), a.s.getTask(t1.id), a.s.getTeam(), a.s.getSettings());
  const r1 = a.s.getTask(t1.id);
  assert.equal(r1.status, 'review', 'a clean exit without status is a review hand-off, not done');
  assert.equal(r1.parkedForHuman, undefined, 'a clean exit is a hand-off, not a human escalation');
  assert.equal(a.g(a.repo, 'rev-list', '--count', `main..${r1.worktreeBranch}`), '1', 'the dev did commit work on the branch');
  assert.ok(!fs.existsSync(path.join(a.repo, 'work.txt')), 'nothing is merged before the review happens');
  assert.ok(!r1.comments.some((c) => /auto-merged/.test(c.text)), 'no merge is claimed');

  // (2) no review edge anywhere: the same hand-off lands done when the sweep (next tick) runs
  const b = setupRepo(COMMIT_WORK);
  const dev2 = b.s.addNode({ name: 'Dev2', role: 'Dev' });
  const t2 = b.s.createTask({ title: 'silent exit, no reviewer', assignee: dev2.id });
  const o2 = new Orchestrator(b.s);
  o2.running = true;
  await o2.runTask(b.s.getTeam().nodes.find((n) => n.id === dev2.id), b.s.getTask(t2.id), b.s.getTeam(), b.s.getSettings());
  assert.equal(b.s.getTask(t2.id).status, 'review');
  o2.autoAdvanceReviews(b.s.getTeam());
  const r2 = b.s.getTask(t2.id);
  assert.equal(r2.status, 'done', 'the sweep finishes the hand-off when no reviewer is configured');
  assert.ok(r2.comments.some((c) => c.author === 'orchestrator' && /auto-advanced/.test(c.text)));
  assert.ok(fs.existsSync(path.join(b.repo, 'work.txt')), 'the hand-off still lands the merge once done');
});
