// Wake-on-message: an idle agent that receives a send_message is dispatched in the background with
// its unread messages as the prompt. The sender never blocks; bursts coalesce; ping-pong is capped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { Orchestrator, WAKE, wakePrompt } = require('../src/orchestrator');

// Short timings so sweeps fire quickly; the semantics under test are unchanged.
WAKE.SWEEP_MS = 40; WAKE.DEBOUNCE_MS = 60; WAKE.MIN_GAP_MS = 80;
// Every orchestrator a test creates must be stopped at file end: the wake sweep re-arms a REF'd
// debounce timer for any idle agent left with unread messages, and the per-pair-cap tests leave
// agents pair-capped with unread messages on purpose (that is the asserted end state). Nothing in
// the file dispatches those messages afterwards, so the timer chain re-arms forever and pins the
// file process until WAKE.PAIR_WINDOW_MS (10min) expires and one final dispatch drains the inbox —
// which stalled the whole suite ~10min and blew self-update's test step (t_4362c329). stop()
// clears wakeTimers synchronously and makes the (unref'd) sweep inert, so the process exits.
const orchs = [];
const makeOrch = (s) => { const o = new Orchestrator(s); orchs.push(o); return o; };
test.after(() => {
  WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; WAKE.MIN_GAP_MS = 5 * 60 * 1000;
  for (const o of orchs) { try { o.stop(); } catch {} }
});

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
  const o = makeOrch(s);
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

  // system senders never trigger a wake (the human operator's messages DO — t_7c4538d9)
  s.sendMessage({ from: 'system', to: b.id, text: 'no wake for system' });
  await sleep(400);
  assert.equal(s.listRuns({ nodeId: b.id }).length, 1);
  const late = s.listMessages({ to: b.id }).filter((m) => m.from === 'system');
  assert.equal(late.length, 1);
  assert.ok(late.every((m) => !m.read));
});

test('wake: a burst of messages coalesces into one dispatch', async () => {
  const d = tmp('squad-wake-');
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = makeOrch(s);
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
  const o = makeOrch(s);
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
  const o = makeOrch(s);
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
  const o = makeOrch(s);
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

test('wake: nudge wakes respect the per-agent gap — deferred inside it, fired after (t_cb6663f7)', async () => {
  const d = tmp('squad-wake-');
  const s = new Store(path.join(d, 'p'));
  const pm = s.addNode({ name: 'Pia', role: 'PM' });
  const r1 = s.addNode({ name: 'Rhea', role: 'Dev' }); const r2 = s.addNode({ name: 'Uma', role: 'Dev' });
  s.addEdge(pm.id, r1.id); s.addEdge(pm.id, r2.id);
  s.createTask({ title: 'goal', assignee: pm.id, createdBy: pm.id }); // open goal: idle nudges apply
  const o = makeOrch(s);
  o.running = true; // wakeForHuman's run gate; no tick loop is driven here
  const wakes = [];
  o.wakeRun = async (node, msgs) => { wakes.push(msgs.map((m) => m.text)); }; // stub the run itself
  const nudges = () => s.listMessages({ to: pm.id }).filter((m) => m.from === 'system');

  // A wake just ended: the pm's idle reports changed, but inside the gap the nudge must not wake
  // her — live evidence was three pm wakes in 2 min, one 30s after "wake suppressed" was logged.
  o.wakeLastAt.set(pm.id, Date.now());
  o.nudgeIdle();
  assert.equal(nudges().length, 0, 'no nudge message while inside the gap');
  assert.ok(!o.nudged.get(pm.id + '|idle'), 'a deferred nudge must not consume its debounce key');
  // Log writes are buffered (t_d22a6cf2): read through the store, which merges not-yet-flushed lines.
  assert.match(s.readLogs(50).map((l) => l.text).join('\n'), /nudge deferred for another \d+min/, 'the deferral is logged');

  await sleep(WAKE.MIN_GAP_MS + 60);
  o.nudgeIdle(); // interval passed: the same (unconsumed) condition now fires
  assert.equal(nudges().length, 1, 'the deferred nudge fires once the gap passes');
  assert.match(nudges()[0].text, /2 agents idle/);
  assert.ok(nudges()[0].read, 'delivered by the wake, not left unread');
  assert.equal(wakes.length, 1);

  // The gap re-arms on every wake: a report flipping busy changes the idle text, which would
  // re-arm the debounce and wake the pm again immediately — deferred too, then delivered.
  o.wakeLastAt.set(pm.id, Date.now());
  o.agent(r1.id).status = 'working';
  o.nudgeIdle();
  assert.equal(nudges().length, 1, 'a changed idle set does not bypass the gap');
  await sleep(WAKE.MIN_GAP_MS + 60);
  o.nudgeIdle();
  assert.equal(nudges().length, 2, 'the changed condition fires after the gap');
  assert.match(nudges()[1].text, /1 agent idle/);
  assert.equal(wakes.length, 2);
});

test('wake: a human chat message wakes an idle agent with the human wording; no task is created', async () => {
  const d = tmp('squad-wake-');
  const argsLog = path.join(d, 'args.txt');
  const fake = fakeClaude(d, `echo "$*" >> ${argsLog}\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const b = s.addNode({ name: 'B', role: 'Dev' });
  const o = makeOrch(s);
  s.sendMessage({ from: 'human', to: b.id, text: 'hi, are you there?' });
  await waitFor(() => s.listRuns({ nodeId: b.id }).length === 1 && s.listMessages({ to: b.id })[0].read);
  const args = fs.readFileSync(argsLog, 'utf8');
  assert.match(args, /hi, are you there\?/);
  assert.match(args, /human operator/);
  assert.match(args, /create_task only for real work/);
  assert.equal(s.listTasks().length, 0, 'a plain chat message must not create a task');
  assert.equal(o.agent(b.id).status, 'idle');
  const run = s.listRuns({ nodeId: b.id })[0];
  assert.equal(run.kind, 'agent'); assert.equal(run.taskId, null); assert.equal(run.exitCode, 0);
});

test('wake: the human sender is never pair-capped; the cap still binds agent->agent', async () => {
  const d = tmp('squad-wake-');
  const fake = fakeClaude(d, RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = makeOrch(s);
  const runsB = () => s.listRuns({ nodeId: b.id }).length;
  // More than MAX_PER_PAIR human messages in a row: every single one wakes B.
  for (let i = 0; i < WAKE.MAX_PER_PAIR + 2; i++) {
    s.sendMessage({ from: 'human', to: b.id, text: 'chat ' + i });
    await waitFor(() => runsB() === i + 1 && s.listMessages({ to: b.id }).every((m) => m.read));
  }
  // agent->agent wakes are still capped as before (human exemption must not open the cap for all).
  const ta = makeTools(s, a.id);
  const base = runsB();
  for (let i = 0; i < WAKE.MAX_PER_PAIR; i++) {
    ta.send_message({ to: 'B', text: 'ping ' + i });
    await waitFor(() => runsB() === base + i + 1 && s.listMessages({ to: b.id }).every((m) => m.read));
  }
  ta.send_message({ to: 'B', text: 'ping capped' });
  await sleep(400);
  assert.equal(runsB(), base + WAKE.MAX_PER_PAIR);
  assert.ok(s.listMessages({ to: b.id }).some((m) => !m.read && m.text === 'ping capped'));
});

// ---- sweep instrumentation (t_4dba572d): counters always advance; a sweep past the slow
// threshold logs a system line naming the scanned idle-agent count (the sweep re-reads every
// idle agent's inbox at 1 Hz on the main loop, so a long sweep is a jank signal).

test('wake sweep instrumentation: counters advance per sweep and per armed debounce', () => {
  const d = tmp('squad-wake-');
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  s.sendMessage({ from: a.id, to: b.id, text: 'wake me' });
  const o = makeOrch(s);
  o.dispatchWake = async () => {}; // counter test only: never let the debounce timer spawn a run
  o.sweepWakes();
  o.sweepWakes(); // second sweep: timer already armed, pending unchanged — nothing new to count
  const st = o._wakeStats;
  assert.equal(st.sweeps, 2);
  assert.equal(st.armed, 1);
  assert.ok(st.maxMs >= 0 && st.totalMs >= st.maxMs);
});

test('wake sweep instrumentation: a slow sweep logs a system line with the scanned count', () => {
  const d = tmp('squad-wake-');
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  s.sendMessage({ from: a.id, to: b.id, text: 'wake me' });
  const o = makeOrch(s);
  o.dispatchWake = async () => {};
  const lines = [];
  const orig = o.log.bind(o);
  o.log = (id, lvl, text) => { lines.push(text); orig(id, lvl, text); };
  const prev = WAKE.SLOW_SWEEP_MS;
  WAKE.SLOW_SWEEP_MS = -1; // force the slow branch: elapsed is always >= 0
  try { o.sweepWakes(); } finally { WAKE.SLOW_SWEEP_MS = prev; }
  assert.ok(lines.some((t) => /wake sweep: checked 2 idle agent\(s\), 1 with unread/.test(t)), JSON.stringify(lines));
});
