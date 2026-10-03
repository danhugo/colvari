// The 1 Hz wake sweep reads every idle agent's unread inbox; the unread map behind wakeUnread is
// cached (t_3ef18625) keyed on the store's messages + team stat signatures and rebuilt at most
// once per sweep. These tests lock the cache contract: reuse while nothing changed, rebuild on
// any message write (send/read) or roster change, and the exact wake-eligibility filter the
// pre-cache scan applied.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, WAKE } = require('../src/orchestrator');

WAKE.SWEEP_MS = 40; WAKE.DEBOUNCE_MS = 60; WAKE.MIN_GAP_MS = 80;
const orchs = [];
const makeOrch = (s) => { const o = new Orchestrator(s); orchs.push(o); return o; };
test.after(() => {
  WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; WAKE.MIN_GAP_MS = 5 * 60 * 1000;
  for (const o of orchs) { try { o.stop(); } catch {} }
});

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Count the underlying full scans: the cache must turn one scan into many wakeUnread reads.
function countingStore(s) {
  let lists = 0;
  const orig = s.listMessages.bind(s);
  s.listMessages = (filter) => { lists++; return orig(filter); };
  s._lists = () => lists;
  return s;
}

test('wake unread cache: one scan serves repeated reads; sends and reads bust it', () => {
  const d = tmp('squad-wake-cache-');
  const s = countingStore(new Store(path.join(d, 'p')));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  const o = makeOrch(s);
  const team = s.getTeam();

  s.sendMessage({ from: a.id, to: b.id, text: 'ping' });
  const first = o.wakeUnread(b.id, team);
  const afterFirst = s._lists();
  assert.equal(first.length, 1);

  // Same files, same roster: repeated reads (the sweep's steady state) must not rescan.
  for (let i = 0; i < 5; i++) assert.equal(o.wakeUnread(b.id, team).length, 1);
  assert.equal(s._lists(), afterFirst, 'cache hit must not rescan messages');

  // A new message busts the cache (sig changes on write) and shows up on the next read.
  s.sendMessage({ from: 'human', to: b.id, text: 'hello' });
  assert.equal(o.wakeUnread(b.id, team).length, 2);

  // Delivering (mark-read) busts it the same way.
  s.markMessagesRead(o.wakeUnread(b.id, team).map((m) => m.id));
  assert.deepEqual(o.wakeUnread(b.id, team), []);

  // Roster changes (team file write) bust it too: a new teammate's messages become eligible.
  s.sendMessage({ from: 'human', to: a.id, text: 'for later' });
  const c = s.addNode({ name: 'C', role: 'Dev' });
  s.sendMessage({ from: c.id, to: a.id, text: 'hi from the new node' });
  const now = o.wakeUnread(a.id, s.getTeam());
  assert.equal(now.length, 2);
  assert.ok(now.some((m) => m.from === c.id));

  // Cached arrays are shared — wakeUnread hands out copies, not the memo's own arrays.
  const got = o.wakeUnread(a.id, s.getTeam());
  got.length = 0;
  assert.equal(o.wakeUnread(a.id, s.getTeam()).length, 2, 'mutating a returned copy must not corrupt the cache');
});

test('wake unread cache: same eligibility filter as the direct scan', () => {
  const d = tmp('squad-wake-cache2-');
  const s = countingStore(new Store(path.join(d, 'p')));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  const o = makeOrch(s);
  const team = s.getTeam();
  s.sendMessage({ from: b.id, to: a.id, text: 'teammate' });
  s.sendMessage({ from: 'human', to: a.id, text: 'human' });
  s.sendMessage({ from: 'system', to: a.id, text: 'system, no wake flag' });
  s.sendMessage({ from: 'system', to: a.id, text: 'system nudge', wake: true });
  s.sendMessage({ from: 'n_xxx', to: a.id, text: 'not on this team' });
  s.sendMessage({ from: a.id, to: a.id, text: 'self' });
  s.sendMessage({ from: b.id, to: a.id, text: 'already read' });
  s.markMessagesRead(s.listMessages().filter((m) => m.text === 'already read').map((m) => m.id));

  const got = o.wakeUnread(a.id, team).map((m) => m.from).sort();
  assert.deepEqual(got, [a.id === 'human' ? null : 'human', 'system', b.id].filter(Boolean).sort(), 'teammate + human + flagged system only');
});

test('wake sweep: the unread map is rebuilt at most once per sweep, not per idle agent', async () => {
  const d = tmp('squad-wake-cache3-');
  const s = countingStore(new Store(path.join(d, 'p')));
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(s.addNode({ name: 'N' + i, role: 'Dev' }).id);
  s.addEdge(ids[0], ids[1]); s.addEdge(ids[0], ids[2]); s.addEdge(ids[0], ids[3]); s.addEdge(ids[0], ids[4]); s.addEdge(ids[0], ids[5]);
  const o = makeOrch(s);
  o.dispatchWake = async () => {}; // measure the sweep only, no dispatches
  s.sendMessage({ from: ids[1], to: ids[2], text: 'wake n2' });

  o.sweepWakes();
  const afterSweep1 = s._lists();
  o.sweepWakes(); // unchanged files: the map (and its key) is reused for all 5 idle agents
  assert.equal(s._lists(), afterSweep1, 'steady-state sweep must not rescan messages');

  s.sendMessage({ from: ids[3], to: ids[4], text: 'wake n4' });
  o.sweepWakes(); // one write -> exactly one rebuild inside this sweep
  assert.equal(s._lists(), afterSweep1 + 1);
  assert.equal(o.agent(ids[2]).wakePending.count, 1);
  assert.equal(o.agent(ids[4]).wakePending.count, 1);
});
