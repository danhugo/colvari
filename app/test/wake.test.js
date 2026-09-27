// Wake-on-message: an idle agent that receives a send_message is dispatched in the background with
// its unread messages as the prompt. The sender never blocks; bursts coalesce; ping-pong is capped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { Orchestrator, WAKE, wakePrompt } = require('../src/orchestrator');

// Short timings so sweeps fire quickly; the semantics under test are unchanged.
WAKE.SWEEP_MS = 40; WAKE.DEBOUNCE_MS = 60;
test.after(() => { WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (dir, body) => { const f = path.join(dir, 'fake-claude.sh'); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
const RESULT = `echo '{"type":"result","subtype":"success","session_id":"sess1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}'\n`;
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('wake: send_message to an idle agent dispatches it with the messages; sender never blocks', async () => {
  const d = tmp('squad-wake-');
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const woken = []; o.on('woken_by_message', (w) => woken.push(w));

  const ta = makeTools(s, a.id);
  const t0 = Date.now();
  ta.send_message({ to: 'B', text: 'please look at the flaky test' });
  assert.ok(Date.now() - t0 < 200, 'send_message must return immediately');

  await waitFor(() => (s.listRuns({ nodeId: b.id }).length === 1) && (s.listMessages({ to: b.id })[0].read));
  assert.equal(woken.length, 1);
  assert.deepEqual(woken[0].by, [a.id]);
  assert.equal(woken[0].nodeId, b.id);
  const args = fs.readFileSync(argsLog, 'utf8');
  assert.match(args, /please look at the flaky test/);
  assert.match(args, /You are "B"/);
  const run = s.listRuns({ nodeId: b.id })[0];
  assert.equal(run.kind, 'agent'); assert.equal(run.taskId, null); assert.equal(run.exitCode, 0);
  assert.equal(o.agent(b.id).status, 'idle');

  // human and system senders never trigger a wake
  s.sendMessage({ from: 'human', to: b.id, text: 'no wake for humans' });
  s.sendMessage({ from: 'system', to: b.id, text: 'no wake for system' });
  await sleep(400);
  assert.equal(s.listRuns({ nodeId: b.id }).length, 1);
  const late = s.listMessages({ to: b.id }).filter((m) => m.from === 'human' || m.from === 'system');
  assert.equal(late.length, 2);
  assert.ok(late.every((m) => !m.read));
});

test('wake: a burst of messages coalesces into one dispatch', async () => {
  const d = tmp('squad-wake-');
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const ta = makeTools(s, a.id);
  ta.send_message({ to: 'B', text: 'one' });
  ta.send_message({ to: 'B', text: 'two' });
  ta.send_message({ to: 'B', text: 'three' });
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 1);
  await sleep(300); // no second dispatch trailing behind
  assert.equal(s.listRuns({ nodeId: b.id }).length, 1);
  const args = fs.readFileSync(argsLog, 'utf8');
  assert.match(args, /one/); assert.match(args, /two/); assert.match(args, /three/);
});

test('wake: per-pair cap stops a ping-pong loop', async () => {
  const d = tmp('squad-wake-');
  const fake = fakeClaude(d, RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id); s.addEdge(b.id, a.id);
  const o = new Orchestrator(s);
  const ta = makeTools(s, a.id); const tb = makeTools(s, b.id);
  const runsB = () => s.listRuns({ nodeId: b.id }).length;
  const runsA = () => s.listRuns({ nodeId: a.id }).length;

  // WAKE.MAX_PER_PAIR round-trips wake fine; the next one in each direction is refused.
  for (let i = 0; i < WAKE.MAX_PER_PAIR; i++) {
    const rb = runsB(), ra = runsA();
    ta.send_message({ to: 'B', text: 'ping ' + i });
    await waitFor(() => runsB() === rb + 1 && s.listMessages({ to: b.id }).every((m) => m.read));
    tb.send_message({ to: 'A', text: 'pong ' + i });
    await waitFor(() => runsA() === ra + 1 && s.listMessages({ to: a.id }).every((m) => m.read));
  }
  // Cap reached both ways: further messages stay unread and un-dispatched.
  ta.send_message({ to: 'B', text: 'ping forever' });
  tb.send_message({ to: 'A', text: 'pong forever' });
  await sleep(500);
  assert.equal(runsB(), WAKE.MAX_PER_PAIR);
  assert.equal(runsA(), WAKE.MAX_PER_PAIR);
  assert.ok(s.listMessages({ to: b.id }).some((m) => !m.read && m.text === 'ping forever'));
  assert.ok(s.listMessages({ to: a.id }).some((m) => !m.read && m.text === 'pong forever'));
});

test('wake: the live run records activity {trigger, messageId, fromNodeId, excerpt, taskId, startedAt}, cleared on end', async () => {
  const d = tmp('squad-wake-');
  const fake = fakeClaude(d, `sleep 0.3\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  assert.equal(o.agent(b.id).activity, null);
  const t0 = s.createTask({ title: 'related', assignee: b.id });
  const ta = makeTools(s, a.id);
  ta.send_message({ to: 'B', text: 'check the wake activity fields', taskId: t0.id });

  await waitFor(() => o.agent(b.id).status === 'working');
  const act = o.agent(b.id).activity;
  assert.equal(act.trigger, 'message');
  assert.equal(act.fromNodeId, a.id);
  assert.equal(act.excerpt, 'check the wake activity fields');
  assert.equal(act.taskId, t0.id);
  assert.ok(act.messageId, 'messageId set');
  assert.ok(Number.isFinite(act.startedAt) && Date.now() - act.startedAt < 5000, 'startedAt is fresh');
  // Flows through the state snapshot that feeds Board/Team/Overview.
  assert.equal(o.snapshot().agents[b.id].activity.trigger, 'message');

  await waitFor(() => o.agent(b.id).status === 'idle');
  assert.equal(o.agent(b.id).activity, null);
  assert.equal(o.snapshot().agents[b.id].activity, null);
});

test('wake: prompt carries identity, board-only instruction and sender names', () => {
  const team = { nodes: [{ id: 'n1', name: 'Rhea', role: 'Reviewer' }, { id: 'n2', name: 'Devon', role: 'Dev' }] };
  const p = wakePrompt(team, team.nodes[0], [{ from: 'n2', text: 'check t_1' }]);
  assert.match(p, /You are "Rhea", role Reviewer/);
  assert.match(p, /- from Devon \(Dev, id=n2\): check t_1/);
  assert.match(p, /"board" MCP tools/);
});

test('wake: a working agent is not woken; user stop() cancels pending wake dispatches', async () => {
  const d = tmp('squad-wake-');
  const fake = fakeClaude(d, RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  const tools = makeTools(s, a.id);
  // B is working on a task: A's message is delivered through the task run, not a wake.
  o.agent(b.id).status = 'working';
  tools.send_message({ to: 'B', text: 'busy' });
  await sleep(300);
  assert.equal(s.listRuns({ nodeId: b.id }).length, 0);
  o.stop(); // user stopped: pending wake dispatch is dropped, sweep is inert
  tools.send_message({ to: 'B', text: 'after stop' });
  await sleep(300);
  assert.equal(s.listRuns({ nodeId: b.id }).length, 0);
  assert.ok(s.listMessages({ to: b.id }).some((m) => !m.read && m.text === 'busy'));
  assert.ok(s.listMessages({ to: b.id }).some((m) => !m.read && m.text === 'after stop'));
});
