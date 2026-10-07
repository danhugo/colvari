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
