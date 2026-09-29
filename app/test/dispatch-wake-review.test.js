// Plan t_3ab7c5e3 / plan-review t_8863dbea (Cato's conditions), covering Devon's t_9e4b4805 and
// t_699b67b7: (1) the scheduler fills every free slot with ready tasks in the same pass, (2) an
// unread agent-to-agent message wakes its recipient even while the per-agent wake-debounce window
// is active, and (3) a finished run hands off to review — a sweep with no reviewer configured must
// never finish the hand-off to done. No real-model runs: the CLI is a fake shell script.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, WAKE } = require('../src/orchestrator');

// Short debounce so the wake fires inside the test's wait window; the semantics are unchanged.
WAKE.SWEEP_MS = 40; WAKE.DEBOUNCE_MS = 60;
test.after(() => { WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (dir, body) => { const f = path.join(dir, 'fake-claude.sh'); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
const RESULT = `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}'\n`;
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

// ---- dispatch fill: free slots take ready tasks in the same pass (t_9e4b4805) ----

test('scheduler: 4 ready tasks + maxConcurrency 4 dispatch all 4 at once', async () => {
  const d = tmp('squad-fill-');
  const fake = fakeClaude(d, 'sleep 0.5\n' + RESULT); // slow enough that all four are live together
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxConcurrency: 4 });
  const agents = ['A', 'B', 'C', 'D'].map((name) => s.addNode({ name, role: 'Dev' }));
  const tasks = agents.map((n) => s.createTask({ title: 'work ' + n.name, assignee: n.id }));
  const o = new Orchestrator(s);
  o.start();
  await waitFor(() => o.snapshot().active.length === 4, 4000);
  const active = o.snapshot().active;
  assert.deepEqual(new Set(active.map((a) => a.taskId)), new Set(tasks.map((t) => t.id)),
    'every ready task is dispatched in the fill pass — no slot idles while ready work waits');
  assert.equal(new Set(active.map((a) => a.nodeId)).size, 4, 'one run per agent: nobody doubled up');
  await new Promise((res) => o.on('done', res));
  assert.ok(tasks.every((t) => s.getTask(t.id).status === 'done'));
});

// ---- wake suppression: an unread agent message must not wait out the debounce (t_9e4b4805) ----

test('wake: an unread agent message wakes the recipient even inside the suppression window', async () => {
  const d = tmp('squad-wakesup-');
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const woken = []; o.wakeRun = async (node, msgs) => woken.push({ nodeId: node.id, texts: msgs.map((m) => m.text) });
  // B was auto-woken a second ago: its per-agent wake-debounce window is active right now, and the
  // default gap is minutes long — a suppressed message would sit unread for the rest of the window.
  o.wakeLastAt.set(b.id, Date.now() - 1000);
  s.sendMessage({ from: a.id, to: b.id, text: 'fresh teammate message lands inside the suppression window' });
  o.sweepWakes(); // the tick after the message arrives
  await waitFor(() => woken.length === 1, 3000);
  assert.equal(woken[0].nodeId, b.id, 'the suppression window must not delay an unread agent message');
  assert.match(woken[0].texts[0], /fresh teammate message/);
  assert.equal(o.agent(b.id).wakePending, null, 'nothing stays parked as a pending wake once delivered');
  assert.equal(s.listMessages({ to: b.id })[0].read, true, 'the message is delivered, not held unread');
});

// ---- no auto-done: a finished run without a reviewer lands in review and stays there (t_699b67b7) ----

test('no auto-done: a finished run with no reviewer stays in review, never auto-advances', async () => {
  const d = tmp('squad-noauto-');
  const fake = fakeClaude(d, RESULT);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' }); // no review edge from dev anywhere
  const t = s.createTask({ title: 'finished work', assignee: dev.id });
  const dep = s.createTask({ title: 'depends on it', assignee: dev.id, blockedBy: [t.id] });
  const o = new Orchestrator(s);
  o.running = true;
  await o.runTask(s.getTeam().nodes.find((n) => n.id === dev.id), s.getTask(t.id), s.getTeam(), s.getSettings());
  assert.equal(s.getTask(t.id).status, 'review', 'the run hands off to review, not done');
  o.tick(); // the scheduler sweep runs the same auto-advance path the live loop uses
  const after = s.getTask(t.id);
  assert.equal(after.status, 'review', 'no reviewer configured: the task stays in review for a human/reviewer');
  assert.ok(!after.comments.some((c) => /auto-advanced to done/.test(c.text)), 'no silent auto-advance to done');
  assert.equal(s.getTask(dep.id).status, 'todo', 'the dependent stays blocked until a real review approves it');
});
