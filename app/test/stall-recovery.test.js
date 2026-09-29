const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

// Stalled-run auto-recovery (src/orchestrator.js sweepStalls): integration tests over the real
// Store + Orchestrator with a fake CLI (no real model) and a fake clock — sweeps are driven by
// calling sweepStalls() directly (the periodic timer is cleared in setup), and a run looks idle
// by backdating agent.lastActivityAt past the configured stallTimeoutMin.
//
// The fake CLI emits a stream-json init event (session id sess-1), then sleeps: a live,
// silent process. Whether it counts as stalled is controlled per test by stubbing
// orch.runAlive (the process-tree liveness check), so no real child juggling is needed:
//   - default stub (false): the hung runner has no live descendant -> stall detected.
//   - () => true: a live child/descendant (long silent tool call) -> no stall.
// With mode 'recover' a resumed (--resume) invocation answers with a success result instead
// of hanging, so the recovery path runs to completion and the task finishes.
// The sleeps redirect stdout/stderr away from the run's pipes: a grandchild holding the inherited
// stdout open would delay the child 'close' event (and with it the whole recovery) until it exits.
const SLEEP = 'sleep 30 >/dev/null 2>&1';

function setup({ mode = 'recover', stallTimeoutMin = 1 / 60000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stall-'));
  const fake = path.join(root, 'fake-claude.sh');
  const onResume = mode === 'recover'
    ? `printf '%s\\n' '{"type":"result","subtype":"success","session_id":"sess-1","total_cost_usd":0,"num_turns":1,"usage":{}}'`
    : SLEEP;
  fs.writeFileSync(fake, `#!/bin/sh
case "$*" in
  *--resume*) ${onResume} ;;
  *)
    printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'
    ${SLEEP}
    ;;
esac
`);
  fs.chmodSync(fake, 0o755);
  const settings = { claudePath: fake, maxConcurrency: 1, maxRuns: 10 };
  if (stallTimeoutMin !== null) settings.stallTimeoutMin = stallTimeoutMin;
  const store = new Store(path.join(root, 'data'));
  store.saveSettings(settings);
  const node = store.addNode({ name: 'Dev', role: 'Dev', workdir: path.join(root, 'work') });
  const task = store.createTask({ title: 'stalled task', assignee: node.id });
  const orch = new Orchestrator(store);
  orch.runAlive = () => false;
  clearInterval(orch._stallTimer); clearInterval(orch._wakeTimer); // fake clock: sweeps are manual
  if (orch._tickTimer) clearInterval(orch._tickTimer); // dispatch sweep only exists once start() armed it
  return { root, store, node, task, orch };
}

// The watchdog arms an 8s SIGKILL grace timer per claim; drop pending ones so the test process
// can exit as soon as the assertions hold.
function disarm(orch) { for (const t of orch._stallKill.values()) clearTimeout(t); }

function waitFor(predicate, timeout = 4000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try { if (predicate()) return resolve(); } catch (e) { return reject(e); }
      if (Date.now() - started > timeout) return reject(new Error('timed out waiting for condition'));
      setTimeout(check, 10);
    };
    check();
  });
}

test('hung run with no live child: stopped, resumed in the same session, task completes', async () => {
  const { store, node, task, orch } = setup();
  const events = [];
  orch.on('run.stalled', (e) => events.push(['stalled', e]));
  orch.on('run.recovering', (e) => events.push(['recovering', e]));
  orch.start();
  await waitFor(() => orch.agent(node.id).currentRun && orch.agent(node.id).currentRun.sessionId === 'sess-1');
  orch.agent(node.id).lastActivityAt = Date.now() - 5000; // past the (shortened) stall timeout
  orch.sweepStalls();
  await waitFor(() => store.getTask(task.id).status === 'done');

  const kinds = events.map(([k]) => k);
  assert.deepEqual(kinds, ['stalled', 'recovering']);
  assert.equal(events[1][1].attempt, 1);
  assert.equal(events[1][1].max, 2);
  // Same-session resume: the recovery run reports the original session id, and the task kept it.
  assert.equal(store.getTask(task.id).sessions[`${node.id}:claude`], 'sess-1');
  // Real progress (exit 0) resets the persisted recovery budget.
  assert.equal(store.getTask(task.id).stallRecoveries, 0);
  disarm(orch); orch.stop();
});

test('run with a live child process is not recovered', async () => {
  const { node, orch } = setup();
  orch.runAlive = () => true; // live descendant: a long silent tool call
  orch.start();
  await waitFor(() => orch.agent(node.id).currentRun);
  const a = orch.agent(node.id);
  a.lastActivityAt = Date.now() - 5000;
  orch.sweepStalls();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(a.currentRun.stalled, undefined);
  assert.equal(a.stall, undefined);
  disarm(orch); orch.stop();
});

test('third stall: recovery_failed event, task parked for a human, no further resume', async () => {
  const { store, node, task, orch } = setup({ mode: 'hang' });
  // Two recoveries already used (persisted from earlier runs of this task).
  store.updateTask(task.id, { sessions: { [`${node.id}:claude`]: 'sess-1' }, stallRecoveries: 2 });
  const failed = []; let resumes = 0;
  orch.on('run.recovery_failed', (e) => failed.push(e));
  orch.on('run.recovering', () => resumes++);
  orch.start();
  await waitFor(() => orch.agent(node.id).currentRun);
  orch.agent(node.id).lastActivityAt = Date.now() - 5000;
  orch.sweepStalls();
  await waitFor(() => store.getTask(task.id).status === 'waiting_for_human');

  assert.equal(resumes, 0, 'no recovery run may start once the budget is used up');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].final, true);
  assert.equal(store.getTask(task.id).stallRecoveries, 3);
  assert.ok(store.getTask(task.id).comments.some((c) => /Parked for a human/.test(c.text)), 'orchestrator comment explains the parking');
  disarm(orch); orch.stop();
});

test('stall timeout defaults to ten minutes when the setting is absent', () => {
  const { store } = setup({ stallTimeoutMin: null });
  assert.equal(store.getSettings().stallTimeoutMin, 10);
});

test('no double resume: a claimed run cannot be claimed or recovered twice', () => {
  const { node, orch } = setup();
  orch.running = true; // sweepStalls only runs while the orchestrator is up
  let stalled = 0; orch.on('run.stalled', () => stalled++);
  const a = orch.agent(node.id);
  a.status = 'working'; a.taskId = 't1'; a.lastActivityAt = Date.now() - 5000;
  const run = { done: false }; a.currentRun = run;
  orch.procs.set(node.id, { pid: 123, kill() {} });
  orch.sweepStalls();
  orch.sweepStalls(); // same tick: the one-way run.stalled claim must win
  assert.equal(stalled, 1);
  assert.equal(run.stalled, true);
  disarm(orch);
});

// ---- runAlive against the real ps table (live-proved gap, 2026-09-28: a SIGSTOP'd helpycode CLI was
// never recovered because its idle board MCP helper child counted as liveness) ----

// Spawns a real node process standing in for the run's CLI. Its child mimics the shapes that matter:
// the idle board MCP helper (exact production argv shape, optionally with a grandchild of its own)
// and a real working child. Detached so the whole tree dies by process group in killTree.
function spawnFakeCli(root, shape) {
  const helperJs = path.join(root, 'mcp-server.js');
  fs.writeFileSync(helperJs, [
    'if (process.env.HELPER_GRANDCHILD) require("child_process").spawn("/bin/sleep", ["30"], { stdio: "ignore" });',
    'require("http").createServer(() => {}).listen(0);',
    'setInterval(() => {}, 1 << 30);',
  ].join('\n'));
  const script = `
    const { spawn } = require('child_process');
    const [shape, helperJs] = process.argv.slice(1);
    if (shape === 'helper' || shape === 'helper-tree') spawn(process.execPath, [helperJs, '--project', 'p', '--node', 'n_x'], { stdio: 'ignore' });
    else if (shape === 'worker') spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    setInterval(() => {}, 1 << 30);
  `;
  const cli = spawn(process.execPath, ['-e', script, shape, helperJs], { stdio: 'ignore', detached: true, env: { ...process.env, HELPER_GRANDCHILD: shape === 'helper-tree' ? '1' : '' } });
  cli.unref();
  return cli;
}

function killTree(pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }

// setup() stubs orch.runAlive for the sweep tests above; the liveness tests need the real one.
const realRunAlive = (orch, child) => Orchestrator.prototype.runAlive.call(orch, 'n_x', child);

test('runAlive: an idle board MCP helper child does not keep a silent run alive', async () => {
  const { root, orch } = setup();
  const cli = spawnFakeCli(root, 'helper');
  try {
    await waitFor(() => (orch.procTable() || []).some((r) => r.ppid === cli.pid && /mcp-server\.js/.test(r.command || '')));
    assert.equal(realRunAlive(orch, cli), false);
  } finally { killTree(cli.pid); }
});

test('runAlive: the helper subtree is skipped even when the helper has a child of its own', async () => {
  const { root, orch } = setup();
  const cli = spawnFakeCli(root, 'helper-tree');
  try {
    let helperPid = 0;
    await waitFor(() => {
      const rows = orch.procTable() || [];
      const h = rows.find((r) => r.ppid === cli.pid && /mcp-server\.js/.test(r.command || ''));
      if (h) helperPid = h.pid;
      return !!(h && rows.some((r) => r.ppid === helperPid && /sleep/.test(r.command || '')));
    });
    assert.equal(realRunAlive(orch, cli), false);
  } finally { killTree(cli.pid); }
});

test('runAlive: a real working child still counts as alive', async () => {
  const { root, orch } = setup();
  const cli = spawnFakeCli(root, 'worker');
  try {
    await waitFor(() => (orch.procTable() || []).some((r) => r.ppid === cli.pid && /sleep/.test(r.command || '')));
    assert.equal(realRunAlive(orch, cli), true);
  } finally { killTree(cli.pid); }
});

// A stopped CLI cannot reap its exited children, so defunct descendants pile up under it. Their ps
// state carries flags ('ZN', 'Z+'...) — only the first char is the primary state (live-proved
// 2026-09-28: state 'ZN' defeated the old `!== 'Z'` check and blocked recovery forever).
test('runAlive: defunct descendants with flagged ps state (ZN/Z+) do not count as alive', () => {
  const { orch } = setup();
  orch.procTable = () => [
    { pid: 100, ppid: 1, state: 'TN', cpuMs: 6680, command: 'helpycode run --format json' },
    { pid: 101, ppid: 100, state: 'ZN', cpuMs: 0, command: '<defunct>' },
    { pid: 102, ppid: 100, state: 'Z+', cpuMs: 0, command: '<defunct>' },
  ];
  assert.equal(realRunAlive(orch, { pid: 100, exitCode: null }), false);
});
