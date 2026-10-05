const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const C = require('../src/controls');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { Orchestrator, humanPrompt } = require('../src/orchestrator');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (dir, body) => { const f = path.join(dir, 'fake-claude.sh'); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
const RESULT = (cost, inTok = 10, outTok = 10) => `echo '{"type":"result","subtype":"success","session_id":"sess1","total_cost_usd":${cost},"num_turns":1,"usage":{"input_tokens":${inTok},"output_tokens":${outTok}}}'\n`;
const runToDone = (o) => new Promise((res) => { o.once('done', res); o.start(); });
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('dependencies: openBlockers, cycles and self references', async () => {
  const tasks = [{ id: 'a', status: 'done' }, { id: 'b', status: 'todo', blockedBy: ['a'] }, { id: 'c', status: 'todo', blockedBy: ['b', 'gone'] }];
  assert.deepEqual(C.openBlockers(tasks[1], tasks), []);
  assert.deepEqual(C.openBlockers(tasks[2], tasks), ['b']); // unknown ids do not block
  assert.ok(C.isBlocked(tasks[2], tasks));
  assert.throws(() => C.validateDeps('a', ['a'], tasks), /itself/);
  assert.throws(() => C.validateDeps('b', ['c'], tasks), /cycle/);
  assert.throws(() => C.validateDeps('a', ['zz'], tasks), /unknown task/);
  assert.deepEqual(C.validateDeps('d', 'b, b c', tasks), ['b', 'c']);
});

test('budgets: agent and project caps', async () => {
  assert.equal(C.budgetExceeded({ node: {}, agent: { cost: 9 }, settings: {} }), null);
  assert.match(C.budgetExceeded({ node: { budgetUsd: 0.5 }, agent: { cost: 0.5 } }), /agent budget \$0.5/);
  assert.match(C.budgetExceeded({ node: { budgetTokens: 100 }, agent: { inputTokens: 60, outputTokens: 40 } }), /token budget 100/);
  assert.match(C.budgetExceeded({ settings: { budgetUsd: 1 }, totals: { cost: 1.2 } }), /project budget/);
  assert.match(C.projectBudgetExceeded({ budgetTokens: 10 }, { tokens: 11 }), /project token budget/);
});

test('approval gate: agent done becomes review + awaitingApproval', async () => {
  assert.deepEqual(C.gateStatus('done', { requireApproval: true }, {}), { status: 'review', awaitingApproval: true });
  assert.deepEqual(C.gateStatus('done', {}, { requireApproval: true }), { status: 'review', awaitingApproval: true });
  assert.deepEqual(C.gateStatus('done', { requireApproval: true }, {}, true), { status: 'done', awaitingApproval: false });
  assert.equal(C.gateStatus('done', {}, {}).status, 'done');
});

test('store: blockedBy, approveTask, deleteTask cleans deps, persisted logs', async () => {
  const s = new Store(tmp('squad-ctl-'));
  const a = s.createTask({ title: 'A' }); const b = s.createTask({ title: 'B', blockedBy: [a.id] });
  assert.deepEqual(b.blockedBy, [a.id]);
  assert.throws(() => s.updateTask(a.id, { blockedBy: [b.id] }), /cycle/);
  s.updateTask(b.id, { status: 'review', awaitingApproval: true });
  s.approveTask(b.id, false, 'add tests');
  let tb = s.getTask(b.id); assert.equal(tb.status, 'todo'); assert.equal(tb.awaitingApproval, false); assert.match(tb.comments.at(-1).text, /Changes requested: add tests/);
  s.updateTask(b.id, { status: 'review', awaitingApproval: true }); s.approveTask(b.id, true);
  assert.equal(s.getTask(b.id).status, 'done');
  s.deleteTask(a.id); assert.deepEqual(s.getTask(b.id).blockedBy, []);
  s.appendLog({ nodeId: 'n1', kind: 'text', text: 'hello', at: 1 }); s.appendLog({ nodeId: null, kind: 'system', text: 'x', at: 2 }); s.appendLog({ nodeId: 'n1', kind: 'error', text: 'boom', at: 3 });
  assert.deepEqual(s.readLogs().map((l) => l.text), ['hello', 'x', 'boom']);
  assert.deepEqual(s.readLogs().map((l) => l.level), ['info', 'info', 'error']); // level is derived from kind so the UI can default its filter to warn+error
  assert.equal(s.readLogs(1).length, 1);
  s.clearLogs(); assert.deepEqual(s.readLogs(), []);
});

test('board tools: blockedBy on create_task, approval gate, human messages in inbox', async () => {
  const s = new Store(tmp('squad-ctl-'));
  const pm = s.addNode({ name: 'PM', role: 'PM' }); const dev = s.addNode({ name: 'Dev', role: 'Dev', requireApproval: true });
  s.addEdge(pm.id, dev.id);
  const tp = makeTools(s, pm.id); const td = makeTools(s, dev.id);
  const t1 = tp.create_task({ title: 'build', assignee: 'Dev' });
  const t2 = tp.create_task({ title: 'ship', assignee: 'Dev', blockedBy: [t1.id] });
  assert.deepEqual(tp.list_tasks({}).find((x) => x.id === t2.id).blockedByOpen, [t1.id]);
  const r = await td.update_task_status({ taskId: t1.id, status: 'done' });
  assert.equal(r.status, 'review'); assert.equal(r.awaitingApproval, true); assert.match(r.note, /approve/);
  await assert.rejects(() => tp.update_task_status({ taskId: t1.id, status: 'done' }), /human approval/);
  s.sendMessage({ from: 'human', to: dev.id, text: 'use port 8080' });
  const inbox = td.read_messages({});
  assert.equal(inbox.length, 1); assert.equal(inbox[0].fromName, 'human');
});

test('orchestrator: blocked task waits for its dependency', async () => {
  const d = tmp('squad-ctl-');
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fakeClaude(d, 'sleep 0.2\n' + RESULT(0.001)), maxConcurrency: 2 });
  const x = s.addNode({ name: 'X', role: 'Dev' }); const y = s.addNode({ name: 'Y', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // hand-offs complete via reviewer pickup
  s.addEdge(x.id, rev.id, 'review'); s.addEdge(y.id, rev.id, 'review');
  const first = s.createTask({ title: 'first', assignee: x.id });
  const second = s.createTask({ title: 'second', assignee: y.id, blockedBy: [first.id] });
  const o = new Orchestrator(s);
  const runs = []; o.on('run', (r) => runs.push(r));
  await runToDone(o);
  // Reviewer pickups repeat the task ids; the devs themselves still ran first -> second, in order.
  assert.deepEqual(runs.filter((r) => r.nodeId !== rev.id).map((r) => r.taskId), [first.id, second.id]); // with 2 slots, the second still ran only after the first
  assert.ok(s.listTasks().every((t) => t.status === 'done'));
  assert.ok(s.readLogs().some((l) => /Finished/.test(l.text))); // logs persisted per project
});

test('orchestrator: blocked-only board stops with a clear reason', async () => {
  const d = tmp('squad-ctl-'); const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fakeClaude(d, RESULT(0)) });
  const x = s.addNode({ name: 'X', role: 'Dev' });
  // No reviewer edge from x anywhere: an in_progress task parked for a human (not an agent hand-off,
  // hence parkedForHuman) is the one case that stays stuck and blocks its dependent.
  const a = s.createTask({ title: 'a', assignee: x.id }); s.updateTask(a.id, { status: 'review', parkedForHuman: true });
  s.createTask({ title: 'b', assignee: x.id, blockedBy: [a.id] });
  const o = new Orchestrator(s); const notes = []; o.on('notify', (n) => notes.push(n));
  await runToDone(o);
  assert.equal(o.runs, 0); assert.match(notes[0].body, /blocked/);
});

test('orchestrator: review task with no reviewer edge stays in review and is surfaced, never auto-done', async () => {
  const d = tmp('squad-ctl-'); const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fakeClaude(d, RESULT(0)) });
  const x = s.addNode({ name: 'X', role: 'Dev' });
  const a = s.createTask({ title: 'a', assignee: x.id }); s.updateTask(a.id, { status: 'review' });
  const b = s.createTask({ title: 'b', assignee: x.id, blockedBy: [a.id] });
  const o = new Orchestrator(s);
  await runToDone(o);
  const ta = s.getTask(a.id);
  assert.equal(ta.status, 'review', 'done requires reviewer/owner verification');
  assert.ok(ta.comments.some((c) => c.author === 'orchestrator' && /no reviewer/.test(c.text)), 'the stranded task is surfaced');
  assert.equal(s.getTask(b.id).status, 'todo', 'the dependent stays blocked until a reviewer/owner verifies');
});

test('orchestrator: agent budget stops that agent, project budget stops the Run', async () => {
  const d = tmp('squad-ctl-'); const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fakeClaude(d, RESULT(0.3)), maxConcurrency: 1 });
  const x = s.addNode({ name: 'X', role: 'Dev', budgetUsd: 0.25 }); const y = s.addNode({ name: 'Y', role: 'Dev' });
  s.createTask({ title: 'x1', assignee: x.id }); s.createTask({ title: 'x2', assignee: x.id }); s.createTask({ title: 'y1', assignee: y.id });
  const o = new Orchestrator(s);
  let snap = await runToDone(o);
  assert.equal(s.listRuns({ nodeId: x.id }).length, 1); // x stopped after its first run
  assert.equal(s.listRuns({ nodeId: y.id }).length, 1);
  assert.match(snap.agents[x.id].budgetStop, /agent budget/);
  assert.equal(s.listTasks().find((t) => t.title === 'x2').status, 'todo');

  s.saveSettings({ budgetUsd: 0.2 }); s.updateNode(x.id, { budgetUsd: 0 }); s.createTask({ title: 'y2', assignee: y.id });
  snap = await runToDone(o);
  assert.match(snap.budgetStop, /project budget/);
  assert.equal(o.runs, 1);
});

test('orchestrator: approval gate on auto-done, stopAgent, human message interrupts and resumes', async () => {
  const d = tmp('squad-ctl-'); const argsLog = path.join(d, 'args.txt');
  // Fast when the prompt carries a human message, otherwise print init and block (exec so SIGTERM hits the sleeper).
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}
case "$2" in *"Message from the human"*) ${RESULT(0.001).trim()} ; exit 0 ;; esac
echo '{"type":"system","subtype":"init","session_id":"sess1","model":"m","mcp_servers":[]}'
exec sleep 5
`);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake, requireApproval: true });
  const x = s.addNode({ name: 'X', role: 'Dev' });
  const t = s.createTask({ title: 'job', assignee: x.id });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.once('done', res)); o.start();
  await waitFor(() => fs.existsSync(argsLog) && s.getTask(t.id).sessionId === undefined && o.agents[x.id].status === 'working');
  await new Promise((r) => setTimeout(r, 200));
  const m = o.sendToAgent(x.id, 'use port 8080');
  assert.equal(m.delivered, 'interrupt');
  await done;
  const calls = fs.readFileSync(argsLog, 'utf8').split(/(?=^-p )/m).filter((x) => x.trim());
  assert.equal(calls.length, 2);
  assert.match(calls[1], /--resume sess1/); assert.match(calls[1], /use port 8080/);
  const tt = s.getTask(t.id);
  assert.equal(tt.status, 'review'); assert.equal(tt.awaitingApproval, true); // exit 0 without status -> gated
  assert.ok(s.listMessages({ to: x.id })[0].read);

  // stopAgent: the run is killed and the task goes to review (not done).
  const t2 = s.createTask({ title: 'job2', assignee: x.id });
  const done2 = new Promise((res) => o.once('done', res)); o.start();
  await waitFor(() => o.agents[x.id].status === 'working' && o.agents[x.id].taskId === t2.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(o.stopAgent(x.id), true);
  await done2;
  const t2b = s.getTask(t2.id);
  assert.equal(t2b.status, 'review'); assert.ok(!t2b.awaitingApproval); assert.match(t2b.comments.at(-1).text, /stopped/);
  assert.equal(o.stopAgent(x.id), false); // idle now
  assert.match(humanPrompt('hi', 'BASE'), /^BASE\n\nMessage from the human/);
});

test('persisted logs: monitor events keep their structured fields, other kinds stay whitelisted', async () => {  const mon = { at: 123, nodeId: 'core', kind: 'monitor', text: 'woke the core', reason: '2 open tasks, all agents idle', taskIds: ['t_1', 't_2'], action: 'woke core' };
  const back = C.parseLogs(C.logLine(mon))[0];
  assert.equal(back.reason, '2 open tasks, all agents idle');
  assert.deepEqual(back.taskIds, ['t_1', 't_2']);
  assert.equal(back.action, 'woke core');
  assert.equal(back.kind, 'monitor'); assert.equal(back.text, 'woke the core');
  const plain = C.parseLogs(C.logLine({ at: 1, nodeId: 'a', kind: 'text', text: 'hi', reason: 'x' }))[0];
  assert.equal(plain.reason, undefined); // whitelist still strips unknown extras on other kinds
  const malformed = C.parseLogs(C.logLine({ at: 1, kind: 'monitor', text: 'x', taskIds: 't_1' }))[0];
  assert.equal(malformed.taskIds, null); // non-array taskIds persist as null, not a string
});

test('watchdog: a stale-task nudge wakes the core once, with the monitor event (t_ccab4c19)', async () => {
  const d = tmp('squad-idlew-');
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fakeClaude(d, 'sleep 0.1\n' + RESULT(0.001)) });
  const pm = s.addNode({ name: 'PM', role: 'PM' }); const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  s.addEdge(pm.id, dev.id);
  const t1 = s.createTask({ title: 'busy work', assignee: dev.id }); // keeps dev busy so t2 can go stale
  s.createTask({ title: 'stale work', assignee: dev.id }); // t2: todo and untouched while dev runs t1
  const o = new Orchestrator(s);
  // Freeze "now" 20 min ahead for the starting tick only: t2 (updatedAt ~real now) crosses
  // stallTimeoutMin (default 10) exactly in the pass that must nudge; every later tick runs on real
  // time, so the same stale set can only ever produce this one nudge — a built-in wake-loop check.
  const real = Date.now; const shifted = Date.now() + 20 * 60000; Date.now = () => shifted;
  let done;
  try { done = new Promise((res) => o.once('done', res)); o.start(); } finally { Date.now = real; }
  // RED on current code: the nudge is a Board-only system message nobody wakes for.
  await done;
  // Assert through the PERSISTED logs — the same readLogs path the monitor UI renders
  // (controls.js logLine keeps reason/taskIds/action for kind 'monitor' via monitorFields).
  const mons = s.readLogs().filter((l) => l.kind === 'monitor' && l.nodeId === pm.id);
  assert.equal(mons.length, 1, 'exactly one monitor event: fired only for the wake that actually ran');
  const mon = mons[0];
  assert.equal(mon.reason, 'stale tasks');
  assert.equal(mon.action, 'wake core');
  assert.deepEqual(mon.taskIds, [s.listTasks().find((t) => t.title === 'stale work').id]);
  assert.match(mon.text, /waking PM/);
  const nudges = s.listMessages({ to: pm.id }).filter((m) => /stale work/.test(m.text));
  assert.equal(nudges.length, 1, 'no wake loop: the same stale set nudges once');
  assert.equal(nudges[0].read, true, 'the wake consumed the nudge message');
  assert.equal(o.runs, 5, 'dev ran both tasks, the PM woke once for the nudge, then reviewed both hand-offs as the dev\'s lead (review chain: review edge -> lead)');
});
