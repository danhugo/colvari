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

test('orchestrator: review task with no reviewer edge stays in review; dependents wait (t_699b67b7)', async () => {
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
  assert.equal(after.status, 'review', 'with no reviewer configured the hand-off waits in review, never auto-done');
  assert.ok(!after.comments.some((c) => c.author === 'orchestrator' && /auto-advanced to done/.test(c.text)), 'no silent auto-advance to done');
  assert.equal(s.getTask(dependent.id).status, 'todo', 'dependents stay blocked until a real review approves it');
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
  // .squad/ is the app's own data; fake-claude.sh is test tooling; the store's runtime files sit
  // at the store root because this test colocates Store(repo) — none of it is main-checkout dirt
  // for the merge guard (t_8ace5439); a real project keeps the store outside the repo.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.squad/\nfake-claude.sh\n.usage-ledger\n.nodes-protected\nlogs.jsonl\nruns.json\nsettings.json\nteam.json\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  const s = new Store(repo);
  s.saveSettings({ claudePath: fakeClaude(repo, script), maxConcurrency: 1, useWorktrees: true });
  return { repo, g, s };
}
const COMMIT_WORK = RESULT("echo work > work.txt\ngit add .\ngit -c user.email=a@b -c user.name=a commit -qm work\n");

test('orchestrator: clean exit without status hands off to review without merging; no reviewer -> stays in review, unmerged (t_699b67b7)', async () => {
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

  // (2) no review edge anywhere: the hand-off waits in review — the sweep must not finish it
  const b = setupRepo(COMMIT_WORK);
  const dev2 = b.s.addNode({ name: 'Dev2', role: 'Dev' });
  const t2 = b.s.createTask({ title: 'silent exit, no reviewer', assignee: dev2.id });
  const o2 = new Orchestrator(b.s);
  o2.running = true;
  await o2.runTask(b.s.getTeam().nodes.find((n) => n.id === dev2.id), b.s.getTask(t2.id), b.s.getTeam(), b.s.getSettings());
  assert.equal(b.s.getTask(t2.id).status, 'review');
  o2.autoAdvanceReviews(b.s.getTeam());
  const r2 = b.s.getTask(t2.id);
  assert.equal(r2.status, 'review', 'no reviewer configured: the sweep leaves the hand-off in review instead of done');
  assert.ok(!r2.comments.some((c) => /auto-advanced/.test(c.text)), 'no auto-advance to done is claimed');
  assert.ok(!fs.existsSync(path.join(b.repo, 'work.txt')), 'nothing merges without a review');
});

// ---- session id per agent+runtime ----

const SRESULT = (sid) => `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{},"session_id":"${sid}"}'`;
const readCalls = (argsLog) => fs.readFileSync(argsLog, 'utf8').split(/(?=^-p )/m).filter((x) => x.trim());

function setupArgsLog(script) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-sesskey-'));
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\n${script}`);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxConcurrency: 1 });
  return { s, argsLog };
}

test('orchestrator: task sessions are stored per agent+runtime; another agent never resumes them', async () => {
  const { s, argsLog } = setupArgsLog(SRESULT('sess-1'));
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const b = s.addNode({ name: 'B', role: 'Dev' });
  const t = s.createTask({ title: 'shared', assignee: a.id });
  const o = new Orchestrator(s); o.running = true;
  await o.runTask(s.getTeam().nodes.find((n) => n.id === a.id), s.getTask(t.id), s.getTeam(), s.getSettings());
  const t1 = s.getTask(t.id);
  assert.equal(t1.sessions[`${a.id}:claude`], 'sess-1', 'the run reports its session under the agent+runtime key');
  assert.equal(t1.sessionId, undefined, 'the legacy shared field is no longer written');

  s.updateTask(t.id, { status: 'todo', assignee: b.id }); // hand the same task to a different agent
  await o.runTask(s.getTeam().nodes.find((n) => n.id === b.id), s.getTask(t.id), s.getTeam(), s.getSettings());
  const calls = readCalls(argsLog);
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].includes('--resume'), 'agent B must start fresh, never resume agent A\'s session');
  assert.equal(s.getTask(t.id).sessions[`${b.id}:claude`], 'sess-1', 'B stores its own key');
});

test('orchestrator: lastSession is keyed by runtime, not just assignee', () => {
  const { s } = setup();
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'x', assignee: n.id });
  s.updateTask(t.id, { sessions: { [`${n.id}:claude`]: 'c-1', [`${n.id}:codex`]: 'x-1' } });
  const o = new Orchestrator(s);
  assert.equal(o.lastSession(n.id, 'claude'), 'c-1');
  assert.equal(o.lastSession(n.id, 'codex'), 'x-1');
  assert.equal(o.lastSession(n.id, 'gemini'), null);
});

test('orchestrator: stale resume failing with "No conversation found" retries once from a fresh session', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-sessretry-'));
  const argsLog = path.join(d, 'args.txt');
  const count = path.join(d, 'calls');
  const fake = fakeClaude(d, `n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}
echo "$*" >> ${argsLog}
if [ "$n" = 1 ]; then echo 'No conversation found with session ID: stale-1' >&2; exit 1; fi
${SRESULT('sess-2')}`);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxConcurrency: 1 });
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'resume me', assignee: n.id });
  s.updateTask(t.id, { sessions: { [`${n.id}:claude`]: 'stale-1' } });
  const o = new Orchestrator(s); o.running = true;
  await o.runTask(s.getTeam().nodes.find((x) => x.id === n.id), s.getTask(t.id), s.getTeam(), s.getSettings());
  const calls = readCalls(argsLog);
  assert.equal(calls.length, 2, 'exactly one fresh retry after the failed resume');
  assert.match(calls[0], /--resume stale-1/);
  assert.ok(!calls[1].includes('--resume'), 'the retry spawns without --resume');
  assert.match(calls[1], /resume me/, 'the retry carries the full base prompt (task text), not a continue prompt');
  const after = s.getTask(t.id);
  assert.equal(after.sessions[`${n.id}:claude`], 'sess-2', 'the fresh run stores its own session id');
  assert.equal(after.iterations, 2, 'the retry counts as the spawn it was');
});

test('orchestrator: an unrelated failed run with a stale resume is not retried fresh', async () => {
  const { s, argsLog } = setupArgsLog("echo 'some other error' >&2\nexit 1\n");
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'fails', assignee: n.id });
  s.updateTask(t.id, { sessions: { [`${n.id}:claude`]: 'stale-1' } });
  const o = new Orchestrator(s); o.running = true;
  await o.runTask(s.getTeam().nodes.find((x) => x.id === n.id), s.getTask(t.id), s.getTeam(), s.getSettings());
  assert.equal(readCalls(argsLog).length, 1, 'no fresh retry for unrelated failures');
  const after = s.getTask(t.id);
  assert.equal(after.status, 'review');
  assert.equal(after.parkedForHuman, true);
  assert.equal(after.sessions[`${n.id}:claude`], 'stale-1', 'the stored key survives for a same-session stall recovery');
});
