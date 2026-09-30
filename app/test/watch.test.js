// Core-agent watch (plan t_42f310cf item 2): a periodic digest wake for the protected core agent
// while work is active — idle-off, interval-gated, digest-change-gated, per-agent wake-gap aware.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, WAKE } = require('../src/orchestrator');

// The wake gap must pass quickly inside the tests; real timing semantics are unchanged.
WAKE.MIN_GAP_MS = 80;
// Every orchestrator this file creates: their spawned fake-CLI runs must be dead before the file
// ends, or procguard's leak check fails the file under full-suite load (the runs exit by
// themselves, just slowly — the wake sweeps fire right up to the last assertion).
const orchs = [];
test.after(async () => {
  WAKE.MIN_GAP_MS = 5 * 60 * 1000;
  try { await waitFor(() => orchs.every((o) => [...o.procs.values()].every((p) => !p || !p.pid)), 8000); } catch { /* procguard owns real leaks */ }
});

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (dir, body) => { const f = path.join(dir, 'fake-claude.sh'); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
const RESULT = `echo '{"type":"result","subtype":"success","session_id":"sess1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}'\n`;
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Team with the PM as the assign-tree root (the core the watch wakes) and one Dev report.
const setup = (d, extra = {}) => {
  const fake = fakeClaude(d, `echo "$*" >> ${path.join(d, 'args.txt')}\n` + RESULT);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, ...extra });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  s.addEdge(pm.id, a.id);
  const o = new Orchestrator(s);
  clearInterval(o._wakeTimer); clearInterval(o._stallTimer); clearInterval(o._tickTimer);
  orchs.push(o);
  return { s, o, pm, a };
};
// Make "work is active" true without a real CLI: A holds a live slot.
const workActive = (o, a) => { o.running = true; o.procs.set(a.id, { kill() {} }); o.agent(a.id).status = 'working'; };
const due = (o) => { o.watch.lastWatchAt = Date.now() - 11 * 60000; };

test('watch: idle-off with no active work; first active tick wakes the core with the digest', async () => {
  const d = tmp('squad-watch-');
  const { s, o, pm, a } = setup(d);
  o.sweepWatch();
  assert.equal(o.watchStatus().active, false);
  assert.equal(o.watchStatus().lastWatchAt, null);
  assert.equal(s.listRuns({ nodeId: pm.id }).length, 0);

  workActive(o, a);
  o.sweepWatch(); // activation: arms the interval, no digest yet
  assert.equal(o.watchStatus().active, true);
  assert.ok(o.watchStatus().lastWatchAt, 'activation arms the watch interval');
  assert.equal(s.listRuns({ nodeId: pm.id }).length, 0, 'no digest the moment work starts');

  due(o);
  o.sweepWatch();
  const digest = o.watchStatus().digest;
  assert.match(digest, /working: A/);
  assert.match(digest, /idle agents: PM/);
  assert.match(digest, /restarts pending: 0/);
  assert.ok(s.readLogs(Infinity).some((l) => l.kind === 'watch' && l.nodeId === pm.id), 'watch tick logged with kind watch + core nodeId');

  await waitFor(() => s.listRuns({ nodeId: pm.id }).length === 1);
  const msg = s.listMessages({ to: pm.id })[0];
  assert.equal(msg.from, 'system');
  assert.match(msg.text, /restarts pending/);
  assert.ok(msg.read, 'digest message delivered read');
  const args = fs.readFileSync(path.join(d, 'args.txt'), 'utf8');
  assert.match(args, /restarts pending/);
  assert.match(args, /periodic watch digest/);
  assert.equal(o.watchStatus().digest, digest);

  // Tick again after the interval with an unchanged digest: lastWatchAt advances, no second wake.
  o.agent(pm.id).status = 'idle';
  due(o);
  o.sweepWatch();
  assert.ok(o.watch.lastWatchAt > Date.now() - 60000, 'due tick re-stamps lastWatchAt');
  await sleep(300);
  assert.equal(s.listRuns({ nodeId: pm.id }).length, 1, 'unchanged digest never re-wakes');
  await waitFor(() => !o.procs.has(pm.id), 8000); // drain the run before the file's procguard after-hook checks
});

test('watch: unchanged digest does not wake; a state change wakes on the next due tick', async () => {
  const d = tmp('squad-watch-');
  const { s, o, pm, a } = setup(d);
  workActive(o, a);
  o.sweepWatch(); // activation arms the interval
  due(o);
  o.sweepWatch(); // first due tick wakes (wokeDigest was null)
  await waitFor(() => s.listRuns({ nodeId: pm.id }).length === 1);
  await sleep(300);

  // Same state, due again, gap passed: still only one wake.
  due(o);
  o.sweepWatch();
  await sleep(300);
  assert.equal(s.listRuns({ nodeId: pm.id }).length, 1);

  // A task starts awaiting the human -> digest changes -> second wake.
  const t = s.createTask({ title: 'needs a human decision', assignee: a.id, createdBy: pm.id });
  s.updateTask(t.id, { status: 'waiting_for_human' });
  due(o);
  o.sweepWatch();
  await waitFor(() => s.listRuns({ nodeId: pm.id }).length === 2);
  assert.match(o.watchStatus().digest, /awaiting human: t_/);
  await waitFor(() => !o.procs.has(pm.id), 8000); // drain the run before the file's procguard after-hook checks
});

test('watch: respects the per-agent wake gap (deferred, not dropped)', async () => {
  const d = tmp('squad-watch-');
  const { s, o, pm, a } = setup(d);
  workActive(o, a);
  o.sweepWatch(); // activation arms the interval
  o.wakeLastAt.set(pm.id, Date.now()); // the core was just woken by something else
  due(o);
  o.sweepWatch();
  assert.ok(o.watchStatus().lastWatchAt, 'the tick itself still runs');
  assert.ok(s.readLogs(Infinity).some((l) => l.kind === 'watch'), 'digest still logged');
  await sleep(200);
  assert.equal(s.listMessages({ to: pm.id }).length, 0, 'gap defers the wake: no message, no run');
  assert.equal(s.listRuns({ nodeId: pm.id }).length, 0);

  // Once the gap passes the still-pending change fires on the next due tick.
  due(o);
  o.sweepWatch();
  await waitFor(() => s.listRuns({ nodeId: pm.id }).length === 1);
  await waitFor(() => !o.procs.has(pm.id), 8000); // drain the run before the file's procguard after-hook checks
});

test('watch: interval gate and digest determinism', async () => {
  const d = tmp('squad-watch-');
  const { s, o, pm, a } = setup(d, { watchIntervalMin: 10 });
  workActive(o, a);
  o.sweepWatch(); // activation arms: lastWatchAt set, no digest
  assert.ok(o.watch.lastWatchAt);
  due(o);
  o.sweepWatch();
  const t1 = o.watch.lastWatchAt;
  o.sweepWatch(); // interval not yet passed: no new tick
  assert.equal(o.watch.lastWatchAt, t1);
  const st = o.watchStatus();
  assert.equal(st.intervalMin, 10);
  assert.equal(st.active, true);
  assert.equal(new Date(st.lastWatchAt).getTime(), t1);
  assert.ok(st.digest.length > 0);
  assert.equal(o.watchDigest(), o.watchDigest(), 'digest text is stable across calls');
  await waitFor(() => !o.procs.has(pm.id), 8000); // drain the run before the file's procguard after-hook checks
});
