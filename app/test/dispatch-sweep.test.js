// t_9e4b4805 — the scheduler must fill free slots with ready (unblocked) tasks promptly and wake
// gating must never delay substantive work:
// (a) 3 ready todos with maxConcurrency=2 dispatch exactly 2; the 3rd starts the moment a slot
//     frees (within one tick, no idle wait) and the hold is logged with its reason;
// (b) a task written by an EXTERNAL process (an agent's own board MCP calls) while a run is live
//     is picked up by the periodic dispatch sweep, not only at the next run end;
// (c) a fresh wake gap neither suppresses a wake for unread agent messages nor delays a ready task.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, WAKE, SCHED } = require('../src/orchestrator');
const { makeTools } = require('../src/board-tools');

WAKE.SWEEP_MS = 25; WAKE.DEBOUNCE_MS = 40;
SCHED.TICK_MS = 30;
test.after(() => { WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; SCHED.TICK_MS = 1000; });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (dir, body) => { const f = path.join(dir, 'fake-claude.sh'); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
const RESULT = `echo '{"type":"result","subtype":"success","session_id":"sess1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}'\n`;
const waitFor = async (fn, what, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 10)); } };

function setup(maxConcurrency, script = RESULT) {
  const d = tmp('squad-sweep-');
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fakeClaude(d, script), maxConcurrency });
  return { d, s };
}

test('(a) 3 ready todos with maxConcurrency=2 dispatch exactly 2; the 3rd starts the moment a slot frees', async () => {
  const { s } = setup(2);
  const n1 = s.addNode({ name: 'N1', role: 'Dev' });
  const n2 = s.addNode({ name: 'N2', role: 'Dev' });
  const n3 = s.addNode({ name: 'N3', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // hand-offs complete via reviewer pickup (t_699b67b7)
  for (const n of [n1, n2, n3]) s.addEdge(n.id, rev.id, 'review');
  const t1 = s.createTask({ title: 'one', assignee: n1.id });
  const t2 = s.createTask({ title: 'two', assignee: n2.id });
  const t3 = s.createTask({ title: 'three', assignee: n3.id });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  await waitFor(() => o.procs.size === 2, 'two slots filled');
  const active = o.snapshot().active.map((a) => a.taskId);
  assert.equal(active.length, 2, 'exactly maxConcurrency tasks dispatched');
  assert.ok(active.includes(t1.id) && active.includes(t2.id) && !active.includes(t3.id), 'the 3rd ready todo waits for a slot');
  assert.ok(s.readLogs(Infinity).some((l) => l.text.includes('ready but not dispatched: maxConcurrency')), 'the hold is logged with its reason');
  await waitFor(() => o.snapshot().active.some((a) => a.taskId === t3.id), 'the 3rd dispatches within a tick of a slot freeing');
  await done;
  assert.ok([t1, t2, t3].every((t) => s.getTask(t.id).status === 'done'), 'all three finish');
  o.stop();
});

test('(b) a task written by an external process (board MCP) during a live run is dispatched by the sweep, not the next run end', async () => {
  // A run that stays live while the external write lands: only the periodic sweep can see it.
  const { s } = setup(0, `sleep 0.7\n` + RESULT);
  const busy = s.addNode({ name: 'Busy', role: 'Dev' });
  const idle = s.addNode({ name: 'Idle', role: 'Dev' });
  s.addEdge(busy.id, idle.id); // assign edge so Busy's board tools may create tasks for Idle
  s.createTask({ title: 'keeps busy busy', assignee: busy.id });
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  await waitFor(() => o.procs.has(busy.id), 'the first task is live');
  const ta = makeTools(s, busy.id);
  const t2 = ta.create_task({ title: 'external todo', assignee: idle.id });
  const t0 = Date.now();
  await waitFor(() => s.getTask(t2.id).status === 'in_progress', 'the external task is dispatched');
  assert.ok(Date.now() - t0 < 2000, 'promptly — well inside one prod sweep second, no run-end wait');
  assert.ok(o.procs.has(busy.id), 'the first run was still live: the sweep, not a run end, did this');
  await done;
  o.stop();
});

test('(c) a fresh wake gap neither suppresses a message wake nor delays a ready task dispatch', async () => {
  const { s } = setup(0);
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s); // never started: the constructor wake sweep drives the wake path
  o.wakeLastAt.set(b.id, Date.now()); // a wake JUST fired: the old code suppressed for MIN_GAP_MS
  const ta = makeTools(s, a.id);
  ta.send_message({ to: 'B', text: 'answer me despite the fresh gap' });
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 1, 'woken on the next sweep despite the fresh gap');
  assert.ok(!s.readLogs(Infinity).some((l) => /suppress/i.test(l.text)), 'no suppression log for message wakes');
  await waitFor(() => o.agent(b.id).status === 'idle' && !o.procs.has(b.id), 'wake run over');

  // A ready task dispatches regardless of the gap too: tick dispatch never consults wakeLastAt.
  const t = s.createTask({ title: 'ready despite gap', assignee: b.id });
  o.running = true; // drive the tick manually; the sweep timer is only armed by start()
  o.tick();
  assert.equal(o.procs.has(b.id), true, 'the ready task reserved the slot on this very tick');
  await waitFor(() => ['review', 'done'].includes(s.getTask(t.id).status), 'the task ran to its hand-off');
});
