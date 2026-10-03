// runs.json caching + compact writes (t_1fb02462): runs.json is rewritten whole on every run
// record and re-read whole by every consumer; at board scale that was a per-run-event main-process
// stall. The parsed array must be cached behind a stat key (out-of-band edits bust it), write-through
// on same-process writes (a same-ms same-size rewrite must never serve stale data), and the file
// itself compact (runs are machine-read).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Store } = require('../src/store');
const { mktemp } = require('./harness/tmp');

test('runs: addRun/listRuns/replaceRun/clearRuns round-trip through the cache', () => {
  const s = new Store(mktemp('squad-'));
  const a = s.addRun({ id: 'r1', nodeId: 'n1', cost: 0.5 });
  s.addRun({ id: 'r2', nodeId: 'n2' });
  assert.equal(s.listRuns().length, 2);
  a.cost = 0.9;
  s.replaceRun(a); // late in-place update: replace by id, no duplicate
  const rs = s.listRuns();
  assert.equal(rs.length, 2);
  assert.equal(rs.find((r) => r.id === 'r1').cost, 0.9);
  s.replaceRun({ id: 'r3', nodeId: 'n3' }); // unknown id: appended
  assert.equal(s.listRuns().length, 3);
  assert.equal(s.listRuns({ nodeId: 'n2' }).length, 1);
  s.clearRuns();
  assert.deepEqual(s.listRuns(), []);
});

test('runs: compact on disk (no pretty-print whitespace)', () => {
  const s = new Store(mktemp('squad-'));
  s.addRun({ id: 'r1', nodeId: 'n1' });
  const raw = fs.readFileSync(require('node:path').join(s.dir, 'runs.json'), 'utf8');
  assert.ok(!raw.includes('\n  '), 'runs.json must be one compact line of JSON');
  assert.deepEqual(JSON.parse(raw), { runs: [{ id: 'r1', nodeId: 'n1' }] });
});

test('runs: out-of-band file edits bust the cache (stat key)', () => {
  const s = new Store(mktemp('squad-'));
  s.addRun({ id: 'r1', nodeId: 'n1' });
  assert.equal(s.listRuns().length, 1); // warm the cache
  const file = require('node:path').join(s.dir, 'runs.json');
  fs.writeFileSync(file, JSON.stringify({ runs: [{ id: 'zz', nodeId: 'x' }, { id: 'yy', nodeId: 'y' }] }));
  assert.deepEqual(s.listRuns().map((r) => r.id), ['zz', 'yy'], 'the next read must see the out-of-band bytes');
});

test('runs: same-ms same-size rewrite never serves stale data (write-through)', () => {
  const s = new Store(mktemp('squad-'));
  // A rewrite whose compact JSON has the same byte length, within the same ms: identical stat key.
  s.addRun({ id: 'r1', n: 11111 });
  s.replaceRun({ id: 'r1', n: 22222 });
  const rs = s.listRuns();
  assert.equal(rs.length, 1);
  assert.equal(rs[0].n, 22222, 'the replaced record must win even when size+mtime match the stale entry');
});

// t_1fb02462: periodic main-thread work (board-cache reconcile) must never spin on a busy lock —
// an agent's MCP process holding the lock across a write burst used to sleepSync-block the whole
// main thread, and getAll queued behind it as a multi-second stall.
test('withLockTry: runs when free, skips fast when contended, leaves no stale lock', () => {
  const dir = mktemp('squad-');
  const s = new Store(dir);
  let ran = 0;
  assert.equal(s.withLockTry(() => { ran++; }), true, 'free lock: runs');
  assert.equal(ran, 1);
  assert.ok(!fs.existsSync(dir + '/.lock'), 'lock removed after the run');
  fs.mkdirSync(dir + '/.lock'); // simulate another process mid-write-burst
  const t0 = Date.now();
  assert.equal(s.withLockTry(() => { ran++; }), false, 'contended: skipped, not spun');
  assert.ok(Date.now() - t0 < 100, `returned in ${Date.now() - t0}ms`);
  assert.equal(ran, 1, 'the body never ran under contention');
  fs.rmSync(dir + '/.lock', { recursive: true, force: true });
});
