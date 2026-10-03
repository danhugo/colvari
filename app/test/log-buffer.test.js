const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store, LOG_LIMITS } = require('../src/store');
const { mktemp } = require('./harness/tmp');

const tmp = () => new Store(mktemp('squad-logs-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The flush timer is unref'd 16ms — under a concurrent full suite it can slip, so never assert on
// a fixed sleep; poll until the expectation holds (same pattern as delta-pump.test.js).
const until = async (fn, ms = 2000) => { for (let t = 0; t < ms; t += 5) { const v = fn(); if (v) return v; await sleep(5); } return fn(); };
const lines = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);

test('appendLog buffers: the line is readable immediately (read-through) and lands on disk after the flush window', async () => {
  const s = tmp();
  s.appendLog({ nodeId: 'n1', kind: 'text', text: 'buffered line' });
  // Read-through: no flush wait needed within the same process.
  assert.equal(s.readLogs(10).length, 1);
  assert.equal(s.readLogs(10)[0].text, 'buffered line');
  assert.equal(s.readLogs(10)[0].level, 'info');
  assert.ok(!fs.existsSync(s.logFile()), 'nothing written synchronously');
  assert.ok(await until(() => fs.existsSync(s.logFile()) && lines(s.logFile()).length === 1), 'flushed after the flush window');
  assert.match(lines(s.logFile())[0], /buffered line/);
  assert.equal(s.readLogs(10).length, 1); // no duplicates after the flush
});

test('a burst coalesces into one append and preserves order across two Store instances of the same dir', async () => {
  const dir = mktemp('squad-logs-');
  const a = new Store(dir); const b = new Store(dir);
  for (let i = 0; i < 50; i++) (i % 2 ? b : a).appendLog({ nodeId: 'n1', kind: 'text', text: 'line ' + i });
  const got = await until(() => { try { return lines(a.logFile()).length === 50 ? lines(a.logFile()) : false; } catch { return false; } });
  assert.ok(Array.isArray(got), 'flushed');
  assert.deepEqual(got.map((l) => JSON.parse(l).text), Array.from({ length: 50 }, (_, i) => 'line ' + i));
});

test('rotation: past rotateBytes the live file becomes logs.jsonl.1 and readLogs still merges old+new', async () => {
  const s = tmp();
  const prevRotate = LOG_LIMITS.rotateBytes;
  LOG_LIMITS.rotateBytes = 4096;
  try {
    s.appendLog({ nodeId: 'n1', kind: 'text', text: 'x'.repeat(200) });
    for (let i = 0; i < 40; i++) s.appendLog({ nodeId: 'n1', kind: 'text', text: 'old ' + i });
    assert.ok(await until(() => fs.existsSync(s.logFile() + '.1') && fs.statSync(s.logFile() + '.1').size >= 4096), 'first flush crossed the (shrunk) threshold -> rotate');
    for (let i = 0; i < 5; i++) s.appendLog({ nodeId: 'n1', kind: 'text', text: 'new ' + i });
    assert.ok(await until(() => { try { return lines(s.logFile()).length === 5; } catch { return false; } }), 'post-rotation lines flushed');
    // Live file holds only post-rotation lines; readLogs tops up from the backup.
    const all = s.readLogs(Infinity);
    assert.ok(all.some((l) => l.text === 'old 0'), 'pre-rotation lines readable');
    assert.ok(all.some((l) => l.text.startsWith('new ')), 'post-rotation lines readable');
    assert.ok(all.findIndex((l) => l.text === 'old 0') < all.findIndex((l) => l.text.startsWith('new ')), 'backup lines come first (older)');
    // A bounded read keeps the LAST limit lines across both files, newest last.
    const tail = s.readLogs(3);
    assert.deepEqual(tail.map((l) => l.text), ['new 2', 'new 3', 'new 4']);
  } finally { LOG_LIMITS.rotateBytes = prevRotate; }
});

test('append -> getSessionLog stays coherent while lines are still buffered', async () => {
  const s = tmp();
  s.appendLog({ at: Date.now(), nodeId: 'n1', kind: 'text', text: 'session line' });
  const log = await s.getSessionLog('missing-session');
  assert.equal(log.total, 0); // window filter still applies (no runs for the session)
  assert.equal(s.readLogs(5)[0].text, 'session line');
});

test('clearLogs drops buffered lines and both files; appending afterwards starts fresh', async () => {
  const s = tmp();
  s.appendLog({ nodeId: 'n1', kind: 'text', text: 'doomed' });
  s.clearLogs();
  assert.equal(s.readLogs(10).length, 0);
  assert.ok(!fs.existsSync(s.logFile()));
  s.appendLog({ nodeId: 'n1', kind: 'text', text: 'fresh' });
  assert.ok(await until(() => { try { return lines(s.logFile()).length === 1; } catch { return false; } }), 'appending after clear starts fresh');
  assert.deepEqual(lines(s.logFile()).map((l) => JSON.parse(l).text), ['fresh']);
});

test('a normal process exit flushes buffered lines synchronously (MCP servers log right before exit)', () => {
  const dir = mktemp('squad-logs-');
  execFileSync(process.execPath, ['-e', `const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'store.js'))}); new Store(${JSON.stringify(dir)}).appendLog({ nodeId: 'n1', kind: 'text', text: 'last words' }); process.exit(0);`]);
  const s = new Store(dir);
  assert.equal(s.readLogs(10)[0].text, 'last words');
});
