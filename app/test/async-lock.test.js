'use strict';
// t_a2566d54: the main process's own dispatch/run-end task writes used the sync store lock, which
// sleepSync-spins while an agent's MCP process holds it — freezing the main thread so getAll (and
// every IPC) queued behind it as a 1.3s tail. withLockAsync/updateTaskAsync wait by yielding the
// event loop instead; these tests pin the yielding, the write correctness, and the messages cache.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store.js');

const mktemp = (pfx) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pfx)));

test('withLockAsync: waits by yielding the event loop, never freezing it', async () => {
  const dir = mktemp('squad-alock-');
  const s = new Store(dir);
  fs.mkdirSync(path.join(dir, '.lock')); // contended: another writer holds the lock
  fs.writeFileSync(path.join(dir, '.lock', 'pid'), String(process.pid)); // alive holder (us)
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5); // must keep firing while the write waits
  let done = false;
  const p = s.withLockAsync(async () => { done = true; return 'ran'; });
  // Give the async lock time to be waiting; timers must fire throughout the wait. The window is
  // generous and the bar low because a parallel suite starves timers arbitrarily hard — the
  // regression this pins (the old sync spin) freezes the loop completely, i.e. zero ticks.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(done, false, 'the body must not run while the lock is held');
  assert.ok(ticks >= 3, `event loop starved: only ${ticks} timer ticks in 150ms of waiting`);
  fs.rmSync(path.join(dir, '.lock'), { recursive: true, force: true }); // release
  assert.equal(await p, 'ran');
  clearInterval(timer);
  assert.ok(!fs.existsSync(path.join(dir, '.lock')), 'lock released after the run');
});

test('updateTaskAsync: patch lands on disk for a fresh reader, sync path still coherent', async () => {
  const dir = mktemp('squad-alock2-');
  const s = new Store(dir);
  const t = s.createTask({ title: 'a', description: 'd', assignee: 'n1' });
  await s.updateTaskAsync(t.id, { status: 'in_progress', iterations: 2 });
  const fresh = new Store(dir); // new instance: reads the file, no shared memory
  assert.equal(fresh.getTask(t.id).status, 'in_progress');
  assert.equal(fresh.getTask(t.id).iterations, 2);
  await assert.rejects(() => s.updateTaskAsync('t_missing', { status: 'todo' }), /no task/);
});

test('messages: stat-keyed cache stays coherent across writes and out-of-band edits', () => {
  const dir = mktemp('squad-amsg-');
  const s = new Store(dir);
  s.sendMessage({ from: 'a', to: 'b', text: 'one' });
  assert.equal(s.listMessages().length, 1, 'our own write is visible immediately');
  // Out-of-band append must not be shadowed by the cache (stat key busts).
  const f = path.join(dir, 'messages.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.messages.push({ id: 'm_x', from: 'x', to: 'b', text: 'oob', at: new Date().toISOString(), read: true });
  fs.writeFileSync(f, JSON.stringify(d));
  assert.equal(s.listMessages().length, 2, 'out-of-band edit visible after stat bust');
  assert.equal(s.listMessages({ from: 'x' }).length, 1, 'filters still work');
});

test('updateTaskSoon: uncontended writes are inline; contended ones defer and still land', async () => {
  const dir = mktemp('squad-soon-');
  const s = new Store(dir);
  const t = s.createTask({ title: 'a', description: 'd', assignee: 'n1' });
  const before = process.getActiveResourcesInfo ? undefined : null;
  const view = s.updateTaskSoon(t.id, { status: 'in_progress' }); // uncontended: inline, same span
  assert.equal(view.status, 'in_progress', 'uncontended write is visible to the caller immediately');
  assert.equal(new Store(dir).getTask(t.id).status, 'in_progress', 'and on disk with no awaits');
  fs.mkdirSync(path.join(dir, '.lock')); // contended: must not spin the caller
  fs.writeFileSync(path.join(dir, '.lock', 'pid'), String(process.pid));
  const t0 = Date.now();
  s.updateTaskSoon(t.id, { iterations: 7 });
  assert.ok(Date.now() - t0 < 50, 'contended write returned without blocking');
  fs.rmSync(path.join(dir, '.lock'), { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 60)); // the deferred write lands via the yielding lock
  assert.equal(new Store(dir).getTask(t.id).iterations, 7, 'deferred write landed');
});

// t_c02b7d0b: the IPC createTask spun the main thread in sleepSync while an agent held the lock.
test('createTaskAsync: waits by yielding, then writes the task', async () => {
  const dir = mktemp('squad-alock-ct-');
  const s = new Store(dir);
  s.listTasks(); // board baseline outside the lock
  fs.mkdirSync(path.join(dir, '.lock'));
  fs.writeFileSync(path.join(dir, '.lock', 'pid'), String(process.pid));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const p = s.createTaskAsync({ title: 'async one' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(ticks >= 3, `event loop starved: only ${ticks} ticks`);
  fs.rmSync(path.join(dir, '.lock'), { recursive: true, force: true });
  const t = await p;
  clearInterval(timer);
  assert.equal(new Store(dir).getTask(t.id).title, 'async one');
  fs.rmSync(dir, { recursive: true, force: true });
});
