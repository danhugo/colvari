// t_19f8514d: a wake run that crashes must not lose its messages. dispatchWake marks the messages
// read before wakeRun starts, so a crash between "read" and "delivered" used to drop them forever;
// the crash path now returns them to the unread inbox and the next sweep retries. No real-model
// runs: spawnRun is stubbed to crash, then to succeed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('wake crash: an undelivered wake run puts its messages back in the unread inbox', async () => {
  const d = tmp('squad-wakecrash-');
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(a.id, b.id);
  const o = new Orchestrator(s);
  o.running = true;
  o.spawnRun = async () => { throw new Error('spawn exploded'); }; // the wake run crashes before any delivery
  s.sendMessage({ from: a.id, to: b.id, text: 'deliver me despite the crash' });

  await o.dispatchWake(b.id);

  const after = s.listMessages({ to: b.id })[0];
  assert.equal(after.read, false, 'a crashed wake run must not consume its messages');
  assert.equal(o.agent(b.id).status, 'idle', 'the agent is back to idle after the crash');
  assert.ok(o.agent(b.id) && !o.agent(b.id).wakePending, 'no stale pending wake lingers after the dispatch');

  // The retry path: with the crash gone, the next sweep re-arms the wake and delivery marks read.
  o.spawnRun = async () => ({ code: 0 });
  o.sweepWakes();
  assert.equal(o.agent(b.id).wakePending.count, 1, 'the returned message is pending a wake again');
  await o.dispatchWake(b.id);
  assert.equal(s.listMessages({ to: b.id })[0].read, true, 'the retry delivers the message');
});
