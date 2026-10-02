const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const { mktemp } = require('./harness/tmp');

// ---- harness (same fake-CLI shape as scheduling.test.js) ----

function fakeClaude(dir, script) {
  const f = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(f, '#!/bin/sh\n' + script);
  fs.chmodSync(f, 0o755);
  return f;
}
const SRESULT = (sid) => `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{},"session_id":"${sid}"}'`;
const readCalls = (argsLog) => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').split(/(?=^-p )/m).filter((x) => x.trim()) : []);

// A preflight that blocks the FIRST call (so a test can observe the pre-spawn state) and passes
// every later one — the code-0 tail can chain one more auto try, which must not hang.
function blockingPreflight(o) {
  let release; let used = false;
  o.preflight = () => new Promise((res) => { if (used) return res({ ok: true }); used = true; release = res; });
  return (r) => release(r);
}

function setup(script) {
  const d = mktemp('squad-autoresume-');
  const argsLog = path.join(d, 'args.txt');
  const count = path.join(d, 'calls');
  const fake = fakeClaude(d, `n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}\necho "$*" >> ${argsLog}\n${script}`);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxConcurrency: 4 });
  return { s, argsLog };
}

// Fire-and-forget dispatches (auto resume) are awaited via polling that never touches timers,
// so the no-timers test can spy on setTimeout/setInterval undisturbed. "Quiet" means several
// idle macrotasks in a row: a released preflight continuation (microtask) gets the chance to
// start its run before the wait gives up.
async function settle(o, ms = 5000) {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < ms) {
    if (o.procs.size > 0) { quiet = 0; await new Promise((r) => setImmediate(r)); continue; }
    if (++quiet >= 25) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('settle timeout: runs still live');
}
async function waitUntil(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setImmediate(r));
  }
}

// ---- B: the Retest + Resume action ----

test('retestAndResume: preflight pass re-dispatches the stuck task, resuming its own session', async () => {
  const { s, argsLog } = setup(SRESULT('sess-9'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: n.id });
  s.updateTask(t.id, { status: 'in_progress', sessions: { [`${n.id}:claude`]: 'old-1' } });
  const o = new Orchestrator(s); o.running = true;
  o.preflight = async () => ({ ok: true });
  const r = await o.retestAndResume(t.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  await settle(o);
  const calls = readCalls(argsLog);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /--resume old-1/, 'the run resumes the task session');
  assert.equal(s.getTask(t.id).status, 'review', 'clean exit hands off to review as usual');
  assert.ok(!s.getTask(t.id).autoResumeTried, 'no leftover one-try flag after the run started');
});

test('retestAndResume: stale session failing with Session-not-found falls back to one fresh run', async () => {
  const { s, argsLog } = setup(`if [ "$n" = 1 ]; then echo 'No conversation found with session ID: old-1' >&2; exit 1; fi\n` + SRESULT('new-1'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: n.id });
  s.updateTask(t.id, { status: 'in_progress', sessions: { [`${n.id}:claude`]: 'old-1' } });
  const o = new Orchestrator(s); o.running = true;
  o.preflight = async () => ({ ok: true });
  const r = await o.retestAndResume(t.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  await settle(o);
  const calls = readCalls(argsLog);
  assert.equal(calls.length, 2, 'exactly one fresh fallback after the failed resume');
  assert.match(calls[0], /--resume old-1/);
  assert.ok(!calls[1].includes('--resume'), 'the fallback spawns without --resume');
  assert.match(calls[1], /stuck work/, 'the fallback keeps the full base prompt (task text)');
  assert.equal(s.getTask(t.id).sessions[`${n.id}:claude`], 'new-1', 'the fresh run stores its own session');
  assert.ok(s.getTask(t.id).comments.length >= 0, 'comments untouched by the fallback');
});

test('retestAndResume: preflight failure reports the error and spawns nothing', async () => {
  const { s, argsLog } = setup(SRESULT('never'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: n.id });
  s.updateTask(t.id, { status: 'in_progress' });
  const o = new Orchestrator(s); o.running = true;
  o.preflight = async () => ({ ok: false, error: 'auth broken: check credentials' });
  const r = await o.retestAndResume(t.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /auth broken/);
  assert.ok(!r.resumeFailed, 'the button stays Retest + Resume (retestable), not Rerun fresh');
  assert.equal(readCalls(argsLog).length, 0, 'no run is spawned on a failed retest');
});

test('rerunFresh drops the stored session, dispatches fresh, keeps prompt and comments', async () => {
  const { s, argsLog } = setup(SRESULT('sess-1'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: n.id });
  s.updateTask(t.id, { status: 'in_progress', sessions: { [`${n.id}:claude`]: 'dead-1' } });
  s.commentTask(t.id, 'someone', 'keep me');
  const o = new Orchestrator(s); o.running = true;
  o.preflight = async () => ({ ok: true });
  const r = o.rerunFresh(t.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  await settle(o);
  const calls = readCalls(argsLog);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('--resume'), 'the dead session is not resumed');
  assert.match(calls[0], /stuck work/, 'the full base prompt is kept');
  const after = s.getTask(t.id);
  assert.equal(after.sessions[`${n.id}:claude`], 'sess-1', 'the fresh run stores its own session');
  assert.ok(after.comments.some((c) => c.text.includes('keep me')), 'comments are kept');
  assert.ok(after.comments.some((c) => /fresh session/.test(c.text)), 'the manual rerun is on the record');
});

test('retestAndResume: a live run for the agent is never doubled', async () => {
  const { s, argsLog } = setup(SRESULT('live-1'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'running work', assignee: n.id });
  const o = new Orchestrator(s); o.running = true;
  o.preflight = async () => ({ ok: true });
  const p = o.runTask(s.getTeam().nodes.find((x) => x.id === n.id), s.getTask(t.id), s.getTeam(), s.getSettings());
  await waitUntil(() => readCalls(argsLog).length >= 1);
  const r = await o.retestAndResume(t.id);
  assert.equal(r.ok, true);
  assert.match(r.skipped || '', /already live/, 'skipped, not a second run');
  assert.equal(readCalls(argsLog).length, 1, 'no second spawn');
  await p;
});

// ---- C: free-signal auto resume, once per episode ----

test('human message triggers exactly one auto try; the flag is persisted before trying', async () => {
  const { s, argsLog } = setup(SRESULT('auto-1'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: n.id });
  s.updateTask(t.id, { status: 'in_progress', sessions: { [`${n.id}:claude`]: 'old-7' } });
  const o = new Orchestrator(s); o.running = true;
  o.wakeUnread = () => []; // counts the auto-try spawn; the human-message wake has its own suite
  const release = blockingPreflight(o); // block at the preflight
  o.sendToAgent(n.id, 'please look at this', t.id);
  const flagged = s.getTask(t.id).autoResumeTried;
  assert.ok(flagged, 'the one-try flag is persisted (store) BEFORE the try');
  o.sendToAgent(n.id, 'a second message', t.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(o.procs.size, 0, 'the second message triggers nothing while the try is in flight');
  release({ ok: true });
  await settle(o);
  const calls = readCalls(argsLog);
  assert.equal(calls.length, 1, 'exactly one auto try this episode');
  assert.match(calls[0], /--resume old-7/);
  assert.equal(typeof flagged, 'string', 'the flag is a persisted timestamp, restart-safe');
});

test('another run finishing OK on the same runtime triggers one auto try', async () => {
  const { s, argsLog } = setup(SRESULT('ok-1'));
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const b = s.addNode({ name: 'B', role: 'Dev' });
  const ta = s.createTask({ title: 'healthy run', assignee: a.id });
  const tb = s.createTask({ title: 'stuck work', assignee: b.id });
  s.updateTask(tb.id, { status: 'in_progress', sessions: { [`${b.id}:claude`]: 'old-b' } });
  const o = new Orchestrator(s); o.running = true;
  o.preflight = async () => ({ ok: true });
  await o.runTask(s.getTeam().nodes.find((x) => x.id === a.id), s.getTask(ta.id), s.getTeam(), s.getSettings());
  await settle(o);
  const calls = readCalls(argsLog);
  assert.equal(calls.length, 2, 'the healthy run + one auto try for the stuck task');
  assert.match(calls[1], /--resume old-b/);
  assert.equal(s.getTask(tb.id).status, 'review', 'the auto try resumed it to a clean hand-off');
});

test('autoResumeStuck claims at most ONE task per trigger', async () => {
  const { s, argsLog } = setup(`exec sleep 30`); // hang: hold the claimed run in flight (exec: no orphan)
  const b = s.addNode({ name: 'B', role: 'Dev' });
  const c = s.addNode({ name: 'C', role: 'Dev' });
  const tb = s.createTask({ title: 'stuck B', assignee: b.id });
  const tc = s.createTask({ title: 'stuck C', assignee: c.id });
  for (const [n, t] of [[b, tb], [c, tc]]) s.updateTask(t.id, { status: 'in_progress', sessions: { [`${n.id}:claude`]: `old-${n.id}` } });
  const o = new Orchestrator(s); o.running = true;
  const release = blockingPreflight(o); // hold the claimed try at the preflight: the flag is still set
  assert.equal(o.autoResumeStuck('claude', 'burst'), 1, 'one trigger, one try');
  await new Promise((r) => setImmediate(r));
  const flagged = [tb, tc].filter((x) => s.getTask(x.id).autoResumeTried);
  assert.equal(flagged.length, 1, 'exactly one task was claimed by this trigger');
  const other = s.getTask(flagged[0].id === tb.id ? tc.id : tb.id);
  assert.ok(!other.autoResumeTried && other.status === 'in_progress', 'the second stuck task waits for its own trigger');
  release({ ok: true }); // the claimed try proceeds into its (hanging) run
  await waitUntil(() => readCalls(argsLog).length >= 1);
  assert.equal(o.procs.size, 1, 'one run in flight');
  assert.equal(readCalls(argsLog).length, 1, 'one CLI spawn, not a burst');
  o.stop(); // clean up: kill the hanging run and keep tick's reconcile from re-dispatching the leftover
  await settle(o);
});

test('autoResumeStuck: the persisted flag stops tries even after a restart (new Orchestrator)', async () => {
  const { s, argsLog } = setup(SRESULT('never'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: n.id });
  s.updateTask(t.id, { status: 'in_progress', autoResumeTried: new Date().toISOString() });
  const o = new Orchestrator(s); o.running = true; // fresh instance = restart
  o.preflight = async () => ({ ok: true });
  o.wakeUnread = () => []; // counts spawns (expects 0); the human-message wake has its own suite
  o.sendToAgent(n.id, 'hello', t.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(o.autoResumeStuck('claude', 'after restart'), 0, 'no second episode from a restart');
  assert.equal(readCalls(argsLog).length, 0, 'no spawn');
  o.stop(); // the unread human message must not wake from a leaked sweep during later tests (t_7c4538d9)
});

test('human-stopped work never auto-resumes (stamp survives even a manual reopen)', async () => {
  const { s, argsLog } = setup(`sleep 2\n` + SRESULT('x-1'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'to stop', assignee: n.id });
  const o = new Orchestrator(s); o.running = true;
  o.preflight = async () => ({ ok: true });
  o.wakeUnread = () => []; // counts spawns across the run; the human-message wake has its own suite
  const p = o.runTask(s.getTeam().nodes.find((x) => x.id === n.id), s.getTask(t.id), s.getTeam(), s.getSettings());
  await waitUntil(() => readCalls(argsLog).length >= 1); // past the script's first line: safe to SIGTERM
  assert.equal(o.stopAgent(n.id), true, 'human stop accepted');
  await p; await settle(o);
  const after = s.getTask(t.id);
  assert.equal(after.status, 'review');
  assert.equal(after.parkedForHuman, true);
  assert.equal(after.noAutoResume, true, 'the human stop is stamped on the task');
  o.sendToAgent(n.id, 'hello', t.id);
  await settle(o);
  assert.equal(readCalls(argsLog).length, 1, 'no auto run: the task is not stuck-shaped');
  s.updateTask(t.id, { status: 'in_progress' }); // even moved back by hand
  o.sendToAgent(n.id, 'hello again', t.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(readCalls(argsLog).length, 1, 'noAutoResume blocks the free signals');
  const r = await o.retestAndResume(t.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  await settle(o);
  assert.equal(readCalls(argsLog).length, 2, 'the manual button still works on human-stopped work');
  o.stop(); // the unread human messages must not wake from a leaked sweep during later tests (t_7c4538d9)
});

// ---- store + design invariants ----

test('store: autoResumeTried / noAutoResume persist on the task and clear again', () => {
  const { s } = setup(SRESULT('x'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'x', assignee: n.id });
  s.updateTask(t.id, { autoResumeTried: '2026-09-30T00:00:00.000Z', noAutoResume: true });
  const after = s.getTask(t.id);
  assert.equal(after.autoResumeTried, '2026-09-30T00:00:00.000Z');
  assert.equal(after.noAutoResume, true);
  s.updateTask(t.id, { autoResumeTried: null, noAutoResume: null });
  assert.ok(!s.getTask(t.id).autoResumeTried && !s.getTask(t.id).noAutoResume);
});

test('free signals create no timers: no polling, no retries (plan A/C invariant)', async () => {
  const { s, argsLog } = setup(SRESULT('nt-1'));
  const n = s.addNode({ name: 'D', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: n.id });
  s.updateTask(t.id, { status: 'in_progress', sessions: { [`${n.id}:claude`]: 'old-nt' } });
  const o = new Orchestrator(s); o.running = true; // never started: no tick sweep exists
  o.preflight = async () => ({ ok: true });
  // The nudge also wakes the idle agent (t_7c4538d9) and that system owns a debounce timer by
  // design (covered in wake.test.js). Mute the wake sweep so the spy measures only the
  // free-signal feature's timers.
  o.wakeUnread = () => [];
  const timers = { timeout: 0, interval: 0 };
  const sto = global.setTimeout, sio = global.setInterval;
  global.setTimeout = (...a) => { timers.timeout++; return sto(...a); };
  global.setInterval = (...a) => { timers.interval++; return sio(...a); };
  try {
    o.sendToAgent(n.id, 'nudge', t.id); // trigger 1
    await settle(o);
    assert.equal(o.autoResumeStuck('claude', 'run finished ok'), 0, 'episode used up, nothing left to try');
    assert.ok(!o._tickTimer, 'no dispatch sweep was armed by the feature');
  } finally { global.setTimeout = sto; global.setInterval = sio; }
  assert.equal(timers.interval, 0, 'no polling timers');
  assert.equal(timers.timeout, 0, 'no retry timers');
  assert.equal(readCalls(argsLog).length, 1, 'the single auto try did run');
});
