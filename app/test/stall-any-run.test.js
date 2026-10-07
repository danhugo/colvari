const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');
const { Store } = require('../src/store');
const { Orchestrator, STALL } = require('../src/orchestrator');

// Stall watchdog over every run kind + the system status-check nudge (t_600e630d, plan t_b476117c).
// Integration tests over the real Store + Orchestrator with fake CLIs and a fake clock (sweeps are
// called by hand; periodic timers are cleared in setup). The hang shape is the one that bit
// t_1f75efd8 (wake run hung 3h11m): the CLI prints its init event, then spawns a REAL sleeping
// child and waits — runAlive() legitimately reports alive, so below the hard cap
// (STALL.HARD_CAP_MULT x stallTimeoutMin) the run is protected and past it the cap recovers it.
// Sleep durations are unique per test so the gone-child assertions can never match another test's
// (or another suite's) leftover sleeps; stdout/stderr of the sleeps are redirected or the child
// would hold the run's pipes open and delay its close event.
const RESULT = `printf '%s\\n' '{"type":"result","subtype":"success","session_id":"sess-1","total_cost_usd":0,"num_turns":1,"usage":{}}'`;

function setup({ stallTimeoutMin = 1 / 60, hangCmd = 'sleep 251', fastTitle = null, trapLine = '', resumeLine = RESULT } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stallany-'));
  const fake = path.join(root, 'fake-claude.sh');
  // fastTitle: a task title whose runs exit at once (only the init event) — lets one test hang its
  // wake run while the task it unblocks dispatches and finishes without spawning a second sleeper
  // that would race the gone-child assertion.
  const fastLine = fastTitle
    ? `  *"fast-${fastTitle}"*) printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}' ;;`
    : '';
  // FOREGROUND hang (Reviewer, t_600e630d): `sleep N & wait` is a ~30% coin flip on macOS —
  // /bin/sh often survives a group SIGTERM inside `wait` (reaps and exits 0 at the next command
  // boundary), and an exit-0 kill skips runTask's r.stalled recovery branch (code !== 0), so
  // run.recovering never fires at any timeout. A foreground sleeper is still a real live
  // DESCENDANT (the cap-kill log names it), and the sh dies by the signal itself every time.
  // trapLine (t_1c3375c0): `trap 'exit 0' TERM` makes the CLI exit 0 on its kill — the foreground
  // sleeper dies from the same group signal, then the sh runs the trap. Deterministically exit 0.
  // resumeLine: what a resumed run (`--resume`) does; default answers success.
  fs.writeFileSync(fake, `#!/bin/sh
case "$*" in
  *--resume*) ${resumeLine} ;;
${fastLine}
  *)
    printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'
    ${trapLine}
    ${hangCmd} >/dev/null 2>&1
    ;;
esac
`);
  fs.chmodSync(fake, 0o755);
  const settings = { claudePath: fake, maxConcurrency: 1, maxRuns: 10, stallTimeoutMin };
  const store = new Store(path.join(root, 'data'));
  store.saveSettings(settings);
  const node = store.addNode({ name: 'Dev', role: 'Dev', workdir: path.join(root, 'work') });
  const orch = new Orchestrator(store);
  clearInterval(orch._stallTimer); clearInterval(orch._wakeTimer); // fake clock: sweeps are manual
  if (orch._tickTimer) clearInterval(orch._tickTimer); // dispatch sweep only exists once start() armed it
  return { root, store, node, orch, fake };
}

// The watchdog arms an 8s SIGKILL grace timer per claim; drop pending ones so the test process
// can exit as soon as the assertions hold.
function disarm(orch) { for (const t of orch._stallKill.values()) clearTimeout(t); }

// 100ms cadence: several predicates here spawn `ps -axo` (procTable), and node --test runs test
// files in parallel — a 10ms ps storm starves the other files' timing tests (seen live: the
// self-update group-kill deadline test failed only when this file polled at 10ms).
function waitFor(predicate, timeout = 8000, name = 'condition', intervalMs = 100) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try { if (await predicate()) return resolve(); } catch (e) { return reject(e); }
      if (Date.now() - started > timeout) return reject(new Error('timed out waiting for ' + name));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// ASYNC ps for wait predicates: procTable() is execFileSync (blocks this process's event loop up to
// its 4s timeout per call when ps is slow under parallel suite load) — polling it starves the very
// timers and close events the test waits for. The async form keeps the loop free.
function procTableAsync() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,state=,time=,command='], { timeout: 4000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
        .map((p) => ({ pid: Number(p[0]), ppid: Number(p[1]), state: p[2], cpuMs: p[3], command: p.slice(4).join(' ') })));
    });
  });
}
const findProcAsync = async (re) => (await procTableAsync()).find((r) => re.test(r.command || ''));
const logText = (store) => store.readLogs().map((l) => l.text || '').join('\n');

test('silent task run with a live sleeping child: protected below the hard cap, killed past it, recovered', async () => {
  const { store, node, orch, fake } = setup({ hangCmd: 'sleep 251' });
  const task = store.createTask({ title: 'hung task', assignee: node.id });
  orch.start(); // real runAlive on purpose: the sleeping grandchild is genuine liveness
  await waitFor(() => orch.agent(node.id).currentRun && orch.agent(node.id).currentRun.sessionId === 'sess-1', 8000, 'init event parsed');
  await waitFor(async () => findProcAsync(/sleep 251/), 8000, 'sleeping child visible in ps');
  const a = orch.agent(node.id);
  const events = [];
  orch.on('run.stalled', (e) => events.push(['stalled', e]));
  orch.on('run.recovering', (e) => events.push(['recovering', e]));
  // 1s timeout, 3s hard cap: at 1.5s silent the live child still protects the run.
  a.lastActivityAt = Date.now() - 1500;
  await orch.sweepStalls();
  assert.equal(events.length, 0, 'below the cap a live descendant still protects the run');
  assert.equal(a.currentRun.stalled, undefined);
  // Past the cap the same run is claimed despite the live child, and the log names what kept it "alive".
  a.lastActivityAt = Date.now() - 3500;
  await orch.sweepStalls();
  assert.equal(a.currentRun.stalled, true, 'the hard cap kills the run even with a live child');
  assert.match(logText(store), /killing despite live child processes/);
  assert.match(logText(store), /sleep 251/, 'the log names the process that pinned liveness');
  // The kill is a real kill: the recovery resumes the same session and gets a success result.
  // 30s: the sweep's real-ps runAlive/stallLiveKids calls run synchronously and can take seconds
  // each under parallel suite load, delaying the close and the recovery decision.
  await waitFor(() => events.map(([k]) => k).join(',') === 'stalled,recovering', 30000, 'stalled+recovering events');
  assert.equal(events[1][1].attempt, 1);
  assert.equal(events[1][1].max, 2);
  assert.equal(store.getTask(task.id).sessions[`${node.id}:claude`], 'sess-1');
  disarm(orch); orch.stop();
});

test('incident repro: system nudge wakes an idle agent, the hung wake run is cap-killed, the ready task it blocked dispatches', async () => {
  const { store, node, orch } = setup({ hangCmd: 'sleep 263', fastTitle: 'blocked behind the hung wake' });
  orch.start();
  // A plain system message (watch digest) never wakes anyone — the nudge kind is the only exception.
  store.sendMessage({ from: 'system', to: node.id, text: 'periodic watch digest' });
  assert.equal(orch.wakeUnread(node.id).length, 0, 'plain system messages are not wake-eligible');
  await orch.dispatchWake(node.id);
  assert.equal(orch.agent(node.id).currentRun, undefined);
  // The Overview Nudge sends exactly this: system label, never interrupts.
  const m = orch.sendToAgent(node.id, 'Status check: you have produced no output for a while.', null, { from: 'system', interrupt: false });
  assert.equal(m.from, 'system');
  assert.equal(m.delivered, 'queued');
  assert.equal(orch.wakeUnread(node.id).length, 1, 'the nudge is wake-eligible like the human message it replaced');
  const stored = store.listMessages({ to: node.id }).find((x) => x.id === m.id);
  assert.equal(stored.wake, true);
  assert.match(logText(store), /Status check \(system\) stored in inbox/);
  let wakeErr = null;
  const wakeP = orch.dispatchWake(node.id).catch((e) => { wakeErr = e; });
  await waitFor(() => orch.agent(node.id).currentRun, 8000, 'run started');
  const a = orch.agent(node.id);
  assert.equal(a.activity && a.activity.trigger, 'message');
  // The incident shape: a ready task lands while the wake run hangs, blocked by the single-run slot.
  const task = store.createTask({ title: 'fast-blocked behind the hung wake', assignee: node.id });
  await waitFor(async () => findProcAsync(/sleep 263/), 8000, 'sleeping child visible in ps');
  a.lastActivityAt = Date.now() - 3500; // 1s timeout, past the 3s hard cap
  let stalledEvent = null;
  orch.on('run.stalled', (e) => { stalledEvent = e; });
  orch.sweepStalls();
  await waitFor(() => stalledEvent, 8000, 'wake run claimed stalled');
  assert.equal(stalledEvent.kind, 'wake');
  assert.match(logText(store), /killing despite live child processes/);
  // The cap kill reaches the whole process group: the sleeping helper dies with the CLI, so no
  // orphan is left behind (spawnRun's detached child.kill is a group kill).
  await waitFor(async () => !(await findProcAsync(/sleep 263/)), 8000, 'sleeping child gone after group kill');
  // Slot freed: the ready task the hung wake used to block dispatches on the next tick. The fake
  // task run exits at once and the orchestrator hands the finished task to review — either state
  // proves the dispatch happened ('todo' would mean the hung run still blocks it).
  await waitFor(() => ['in_progress', 'review'].includes(store.getTask(task.id).status), 8000, 'ready task dispatched');
  await wakeP;
  assert.equal(wakeErr, null);
  disarm(orch); orch.stop();
});

test('no-task run with a non-message trigger (loop) is watched now, not skipped', async () => {
  const { node, orch } = setup();
  orch.running = true; // sweepStalls only runs while the orchestrator is up
  const events = [];
  orch.on('run.stalled', (e) => events.push(e));
  orch.runAlive = () => true; // liveness stubbed: this test is about the trigger gate, not ps
  const a = orch.agent(node.id);
  a.status = 'working'; a.taskId = null; a.activity = { trigger: 'loop', startedAt: Date.now() };
  const run = { done: false }; a.currentRun = run;
  orch.procs.set(node.id, { pid: 123456, kill() {} });
  a.lastActivityAt = Date.now() - 1500; // past the 1s timeout, below the 3s cap
  await orch.sweepStalls();
  assert.equal(run.stalled, undefined, 'below the cap the (stubbed) live child protects it');
  a.lastActivityAt = Date.now() - 3500;
  await orch.sweepStalls();
  assert.equal(run.stalled, true, 'past the cap the no-task loop run is claimed');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'wake'); // no-task runs recover as 'wake' kind (stop only, no resume)
  disarm(orch);
});

test('a protected silent run is probed at most once per LIVE_RECHECK_MS; a cap-eligible run always probes fresh', async () => {
  // Debounce (t_f53d6df8): runAlive forks a blocking `ps` on the main loop, so a run that stays
  // alive below the cap (hung runtime with helpers) must not be re-probed on every sweep. The
  // stub counts probes; the run here can never emit (lastActivityAt keeps being re-backdated).
  const origRecheck = STALL.LIVE_RECHECK_MS;
  STALL.LIVE_RECHECK_MS = 500; // the sweep cadence here is manual, so the window is what matters
  try {
    const { node, orch } = setup();
    orch.running = true; // sweepStalls only runs while the orchestrator is up
    let probes = 0;
    orch.runAlive = () => { probes++; return true; }; // live descendant: a long silent tool call
    const a = orch.agent(node.id);
    a.status = 'working'; a.taskId = 't1'; a.activity = { trigger: 'task', startedAt: Date.now() };
    const run = { done: false }; a.currentRun = run;
    orch.procs.set(node.id, { pid: 123456, kill() {} });
    a.lastActivityAt = Date.now() - 2000; // silent 2s: past the 1s timeout, below the 3s cap
    await orch.sweepStalls();
    assert.equal(probes, 1, 'first sweep probes');
    assert.equal(run.stalled, undefined);
    await orch.sweepStalls();
    await orch.sweepStalls();
    assert.equal(probes, 1, 'sweeps inside the recheck window skip the probe entirely');
    await new Promise((r) => setTimeout(r, STALL.LIVE_RECHECK_MS + 100));
    a.lastActivityAt = Date.now() - 2000; // keep the run below the cap regardless of elapsed time
    await orch.sweepStalls();
    assert.equal(probes, 2, 'the window only defers the probe, it never expires the run');
    assert.equal(run.stalled, undefined);
    a.lastActivityAt = Date.now() - 3500; // past the 3s hard cap: the kill path always probes fresh
    await orch.sweepStalls();
    assert.equal(probes, 3, 'a cap-eligible run probes on every sweep');
    assert.equal(run.stalled, true, 'the cap claims the run despite the (stubbed) live child');
    disarm(orch);
  } finally {
    STALL.LIVE_RECHECK_MS = origRecheck;
  }
});

test('a sweep still in flight debounces the next tick — no overlapping probes (seed 488)', async () => {
  // Overlap debounce: the 5s interval fires a new sweep while the previous pass is still awaiting
  // its proc table (ps up to its 4s timeout under load) — the two passes would fork ps
  // concurrently and probe the same runs twice, defeating the one-snapshot-per-sweep design.
  const { node, orch } = setup();
  orch.running = true; // sweepStalls only runs while the orchestrator is up
  let probes = 0; let release;
  const gate = new Promise((r) => { release = r; });
  orch.procTable = async () => [{ pid: 123456, ppid: 1, state: 'S', cpuMs: null, command: 'cli' }];
  orch.runAlive = async () => { probes++; await gate; return true; }; // parks mid-probe until released
  const a = orch.agent(node.id);
  a.status = 'working'; a.taskId = 't1'; a.activity = { trigger: 'task', startedAt: Date.now() };
  const run = { done: false }; a.currentRun = run;
  orch.procs.set(node.id, { pid: 123456, kill() {} });
  a.lastActivityAt = Date.now() - 3500; // past the 3s cap: the kill path always probes fresh
  const inFlight = orch.sweepStalls(); // reaches runAlive and parks on the (stubbed) slow ps
  await new Promise((r) => setImmediate(r)); // microtasks first: the in-flight sweep is parked in runAlive
  assert.equal(probes, 1, 'the first sweep is parked in its probe');
  await orch.sweepStalls(); // the next tick while the pass is mid-probe
  assert.equal(probes, 1, 'the overlapping tick is dropped, not a second concurrent probe');
  release(); // the slow ps returns
  await inFlight;
  assert.equal(run.stalled, true, 'the busy sweep still completes its claim and kill');
  await orch.sweepStalls(); // a later tick sweeps again — the claimed run is skipped without probing
  assert.equal(probes, 1);
  disarm(orch);
});

test('nudge with interrupt:false never SIGTERMs a live run; a human message still does', async () => {
  const { store, node, orch } = setup({ hangCmd: 'sleep 257' });
  store.createTask({ title: 'live run', assignee: node.id });
  orch.start();
  await waitFor(() => orch.agent(node.id).currentRun && orch.agent(node.id).currentRun.sessionId === 'sess-1', 8000, 'init event parsed');
  const a = orch.agent(node.id);
  const child = orch.procs.get(node.id);
  let sig = null; const origKill = child.kill.bind(child);
  child.kill = (s) => { sig = s; return origKill(s); };
  const m = orch.sendToAgent(node.id, 'Status check: still there?', null, { from: 'system', interrupt: false });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sig, null, 'the nudge must not kill the live run');
  assert.equal(a.pendingHuman.length, 0);
  assert.equal(m.delivered, 'queued');
  assert.ok(orch.procs.has(node.id), 'the run is untouched');
  // The human interrupt path is unchanged: it queues into pendingHuman and SIGTERMs the run.
  const h = orch.sendToAgent(node.id, 'real human message', null, null);
  await waitFor(() => sig === 'SIGTERM', 8000, 'human interrupt SIGTERMs');
  assert.equal(h.delivered, 'interrupt');
  assert.equal(a.pendingHuman.length, 1);
  // The killed run resumes with the human message; the resume branch answers success, so the run ends.
  await waitFor(() => !orch.procs.has(node.id), 8000, 'run ended after human resume');
  disarm(orch); orch.stop();
});

test('a watchdog-killed run that traps TERM and exits 0 still recovers; the budget resets only on real progress', async () => {
  // The group SIGTERM kills the foreground sleeper; the sh then runs `trap 'exit 0' TERM` and the
  // killed run exits 0. That must take the SAME recovery path as a signal death (t_1c3375c0: the
  // old `code !== 0` guard parked trapping CLIs in review with no recovery), and the exit 0 under
  // the stall claim must NOT reset the persisted recovery budget (else max-2 would never bind).
  const { store, node, orch } = setup({ hangCmd: 'sleep 241', trapLine: `trap 'exit 0' TERM` });
  const task = store.createTask({ title: 'trapping CLI', assignee: node.id });
  orch.start();
  await waitFor(() => orch.agent(node.id).currentRun && orch.agent(node.id).currentRun.sessionId === 'sess-1', 8000, 'init event parsed');
  await waitFor(() => findProcAsync(/sleep 241/), 8000, 'sleeping child visible in ps');
  const a = orch.agent(node.id);
  const events = [];
  orch.on('run.stalled', (e) => events.push(['stalled', e]));
  orch.on('run.recovering', (e) => events.push(['recovering', e]));
  a.lastActivityAt = Date.now() - 3500; // 1s timeout, past the 3s hard cap — the sleeper keeps runAlive true
  await orch.sweepStalls();
  assert.equal(a.currentRun.stalled, true, 'the cap claims the run despite the live child');
  assert.equal(store.getTask(task.id).status, 'in_progress');
  // Recovery fires for the exit-0 kill exactly as for a signal death.
  await waitFor(() => events.map(([k]) => k).join(',') === 'stalled,recovering', 30000, 'stalled+recovering events');
  assert.equal(events[1][1].attempt, 1);
  assert.equal(events[1][1].max, 2);
  // The resumed run answers success WITHOUT a stall claim: only then does the budget reset.
  await waitFor(() => store.getTask(task.id).stallRecoveries === 0, 8000, 'budget reset after the clean resumed run');
  await waitFor(() => store.getTask(task.id).status === 'review', 8000, 'task handed off after the recovered run');
  assert.notEqual(store.getTask(task.id).status, 'waiting_for_human');
  disarm(orch); orch.stop();
});

test('a trap-0 CLI that hangs on every resume parks for a human after the 2 recoveries (budget not reset by code-0 kills)', async () => {
  // The Critic's item-2 proof (t_1c3375c0): every kill exits 0 under an active stall claim, so the
  // `code === 0 && !r.stalled` guard must never reset the budget mid-chain — after MAX_RECOVERIES
  // stop+resumes the task parks for a human instead of recovering forever.
  const { store, node, orch } = setup({
    hangCmd: 'sleep 237',
    trapLine: `trap 'exit 0' TERM`,
    resumeLine: `trap 'exit 0' TERM; sleep 239 >/dev/null 2>&1`, // the recovery run hangs the same way
  });
  const task = store.createTask({ title: 'trapping CLI, never recovers', assignee: node.id });
  orch.start();
  await waitFor(() => orch.agent(node.id).currentRun && orch.agent(node.id).currentRun.sessionId === 'sess-1', 8000, 'init event parsed');
  await waitFor(() => findProcAsync(/sleep 237/), 8000, 'sleeping child visible in ps');
  const a = orch.agent(node.id);
  const evs = [];
  orch.on('run.stalled', (e) => evs.push(e));
  orch.on('run.recovering', (e) => evs.push(e));
  orch.on('run.recovery_failed', (e) => evs.push(e));
  // Cycle 1: kill -> exit 0 -> recovery 1/2 -> the resumed run hangs the same way.
  a.lastActivityAt = Date.now() - 3500; // 1s timeout, past the 3s hard cap
  orch.sweepStalls();
  await waitFor(() => evs.length >= 2 && evs[1].attempt === 1, 30000, 'recovery 1/2 fired');
  await waitFor(() => findProcAsync(/sleep 239/), 8000, 'resumed run 1 live');
  // Cycle 2: kill -> exit 0 -> recovery 2/2 -> that resumed run hangs too.
  a.lastActivityAt = Date.now() - 3500;
  orch.sweepStalls();
  await waitFor(() => evs.length >= 4 && evs[3].attempt === 2, 30000, 'recovery 2/2 fired');
  await waitFor(() => findProcAsync(/sleep 239/), 8000, 'resumed run 2 live');
  // Cycle 3: kill -> exit 0 -> budget spent: parked for a human, never a third resume.
  a.lastActivityAt = Date.now() - 3500;
  orch.sweepStalls();
  await waitFor(() => store.getTask(task.id).status === 'waiting_for_human', 30000, 'parked after the 2 recoveries');
  assert.equal(store.getTask(task.id).stallRecoveries, 3, 'no code-0 kill reset the budget along the chain');
  assert.ok(evs.some((e) => e.final === true), 'run.recovery_failed fired');
  assert.ok(store.getTask(task.id).comments.some((c) => /used up\. Parked for a human/.test(c.text)));
  disarm(orch); orch.stop();
});
