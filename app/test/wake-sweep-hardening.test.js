// The wake sweep runs at 1 Hz on the main event loop; a malformed message entry or one broken
// agent state must degrade the sweep, not kill it. These tests lock the hardening: garbage
// entries in the messages file are dropped by the unread-map build instead of throwing (the memo
// only commits on a clean pass, so an unsanitized file would otherwise throw on every sweep
// forever), and a scan that throws for one idle agent is logged and skipped while the rest of the
// roster still gets woken.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, WAKE } = require('../src/orchestrator');
const WS = require('../src/wake-sweep');

WAKE.SWEEP_MS = 40; WAKE.DEBOUNCE_MS = 60; WAKE.MIN_GAP_MS = 80;
const orchs = [];
const makeOrch = (s) => { const o = new Orchestrator(s); orchs.push(o); return o; };
test.after(() => {
  WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; WAKE.MIN_GAP_MS = 5 * 60 * 1000;
  for (const o of orchs) { try { o.stop(); } catch {} }
});

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('wake sweep survives a malformed messages file', () => {
  const d = tmp('squad-wake-hardening-');
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  const o = makeOrch(s);
  s.sendMessage({ from: a.id, to: b.id, text: 'real unread' });

  // Corrupt the file out-of-band: a null entry and a bare string among the messages.
  const f = s.file('messages');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data.messages.unshift(null, 'junk');
  fs.writeFileSync(f, JSON.stringify(data));

  const got = o.wakeUnread(b.id, s.getTeam());
  assert.equal(got.length, 1, 'garbage entries are dropped, the real unread survives');
  assert.equal(got[0].text, 'real unread');

  // The sweep itself runs clean and keeps running: no throw, wake armed for the receiver.
  o.sweepWakes();
  assert.equal(o.agent(b.id).wakePending.count, 1);
  o.sweepWakes();
  assert.equal(o.agent(b.id).wakePending.count, 1, 'repeated sweeps over the corrupt file stay healthy');
});

test('wake sweep: one broken agent does not blind the rest of the roster', () => {
  const d = tmp('squad-wake-hardening2-');
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.sendMessage({ from: 'human', to: a.id, text: 'wake a' });
  s.sendMessage({ from: 'human', to: b.id, text: 'wake b' });
  const o = makeOrch(s);
  const errors = [];
  o.log = (nodeId, kind, text) => { if (kind === 'error') errors.push({ nodeId, text }); };
  // One agent's unread refresh throws (a broken state behind the seam).
  const orig = o.wakeUnread.bind(o);
  o.wakeUnread = (id, team, key) => { if (id === a.id) throw new Error('boom'); return orig(id, team, key); };

  o.sweepWakes();
  assert.equal(o.agent(b.id).wakePending.count, 1, 'the healthy agent still got its wake');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].nodeId, a.id, 'the failure is logged against the broken agent');
  assert.match(errors[0].text, /boom/);
});

test('overdue human unread: records block reason, logs once, heals leaked procs/working', async () => {
  const d = tmp('squad-wake-overdue-');
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const o = makeOrch(s);
  const logs = []; o.log = (n, k, t) => logs.push(t);
  const m = s.sendMessage({ from: 'human', to: a.id, text: 'hi' });
  const old = WAKE.OVERDUE_MS; WAKE.OVERDUE_MS = 0;
  try {
    o.memGuard = { status: () => ({ defer: true, why: 'pressure critical' }), refresh: async () => {}, configure() {} };
    await o.dispatchWake(a.id);
    assert.match(o.agent(a.id).wakeBlocked.reason, /memory guard: pressure critical/);
    o.sweepWakes(); o.sweepWakes();
    const wp = o.agent(a.id).wakePending;
    assert.match(wp.wakeBlockedReason, /memory guard/);
    assert.ok(wp.oldestUnreadAt > 0);
    assert.equal(logs.filter((t) => /wake overdue/.test(t)).length, 1, 'logged once per reason');
    // leaked procs entry with a dead pid
    o.procs.set(a.id, { pid: 2 ** 22 + 12345, kill() {} }); o.agent(a.id).status = 'working';
    o.sweepWakes();
    assert.equal(o.procs.has(a.id), false);
    assert.equal(o.agent(a.id).status, 'idle');
    assert.ok(logs.some((t) => /self-heal/.test(t)));
  } finally { WAKE.OVERDUE_MS = old; }
});

// ---- long-run stall (t_13eeaaae): fake clock jumps 11 min past an unread human message ----
const { mock } = require('node:test');
const OVERDUE = () => WAKE.OVERDUE_MS + 60000;
function stalled() {
  const s = new Store(path.join(tmp('squad-wake-stall-'), 'p'));
  const b = s.addNode({ name: 'B', role: 'Dev' });
  const o = makeOrch(s);
  s.sendMessage({ from: 'human', to: b.id, text: 'are you there?' });
  const real = Date.now;
  const clock = mock.method(Date, 'now', () => real() + OVERDUE());
  return { s, b, o, clock, logs: () => s.readLogs(Infinity).map((l) => l.text) };
}

test('stall: leaked dead proc is self-healed and the overdue human message gets woken', () => {
  const { b, o, clock, logs } = stalled();
  try {
    let dispatched = 0;
    o.dispatchWake = async () => { dispatched++; };
    o.procs.set(b.id, { pid: 2147483646 }); // no such process
    o.agent(b.id).status = 'working';
    o.sweepWakes();
    assert.ok(!o.procs.has(b.id) && o.agent(b.id).status === 'idle', 'stale proc cleared');
    assert.ok(logs().some((t) => t.includes('wake self-heal')));
    assert.equal(o.agent(b.id).wakePending.count, 1, 'wake armed in the same sweep');
    assert.ok(o.wakeTimers.has(b.id));
  } finally { clock.mock.restore(); }
});

test('stall: orphan "working" status with no proc is self-healed', () => {
  const { b, o, clock, logs } = stalled();
  try {
    o.dispatchWake = async () => {};
    o.agent(b.id).status = 'working';
    o.sweepWakes();
    assert.equal(o.agent(b.id).status, 'idle');
    assert.ok(logs().some((t) => t.includes('stale working status')));
  } finally { clock.mock.restore(); }
});

test('stall: a live proc is not healed', () => {
  const { b, o, clock } = stalled();
  try {
    o.procs.set(b.id, { pid: process.pid });
    o.sweepWakes();
    assert.ok(o.procs.has(b.id));
  } finally { clock.mock.restore(); }
});

test('stall: memGuard defer records the reason and raises one overdue alert; wake lands once it clears', async () => {
  const { b, o, clock, logs } = stalled();
  try {
    o.memGuard = { status: () => ({ defer: true, why: 'memory pressure critical' }), refresh: async () => {}, configure() {} };
    await o.dispatchWake(b.id);
    assert.match(o.agent(b.id).wakeBlocked.reason, /memory guard: memory pressure critical/);
    o.sweepWakes(); o.sweepWakes();
    const alerts = logs().filter((t) => t.includes('wake overdue'));
    assert.equal(alerts.length, 1, 'alerted once, not per sweep');
    assert.match(alerts[0], /memory guard/);
    assert.match(o.agent(b.id).wakePending.wakeBlockedReason, /memory guard/);
    assert.ok(o.agent(b.id).wakePending.oldestUnreadAt, 'age exposed for the UI');
  } finally { clock.mock.restore(); }
});

test('stall: sweep refreshes memGuard itself (not via tick)', () => {
  const { o, clock } = stalled();
  try {
    let n = 0;
    o.memGuard = { status: () => ({ defer: false }), refresh: async () => { n++; }, configure() {} };
    o.sweepWakes();
    assert.equal(n, 1);
  } finally { clock.mock.restore(); }
});

test('stall: a throwing wakeUnread is logged, sweep survives', () => {
  const { b, o, clock, logs } = stalled();
  try {
    o.wakeUnread = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => o.sweepWakes());
    assert.ok(logs().some((t) => t.includes('boom')));
  } finally { clock.mock.restore(); }
});
