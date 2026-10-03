// Sidecar log-index reads for getSessionLog (t_2068c084): pages come from <logs.jsonl>.idx byte
// offsets instead of a full parse. Covers index maintenance (flush appends, rotation), self-healing
// (missing/corrupt index -> raw scan + background rebuild), cross-process gap visibility, buffer
// coherence, and the perf budget: opening a page of a 50MB log stays under 50ms.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, LOG_LIMITS } = require('../src/store');
const LI = require('../src/log-index');

const tmp = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-logidx-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { for (let t = 0; t < ms; t += 10) { const v = fn(); if (v) return v; await sleep(10); } return fn(); };
const flushed = async (s) => { while (s.pendingLogLines().length) await sleep(5); };

// One store with two agents' lines interleaved in one log, session runs bounding the window.
function seeded(dir) {
  const s = new Store(dir);
  s.addRun({ id: 'r1', kind: 'agent', nodeId: 'n_a', sessionId: 'sess-a', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T02:00:00Z', inputTokens: 1, outputTokens: 1 });
  s.addRun({ id: 'r2', kind: 'agent', nodeId: 'n_b', sessionId: 'sess-b', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T02:00:00Z', inputTokens: 1, outputTokens: 1 });
  const base = Date.parse('2026-01-01T00:30:00Z');
  for (let i = 0; i < 600; i++) {
    s.appendLog({ at: base + i * 1000, nodeId: i % 2 ? 'n_a' : 'n_b', kind: 'text', text: 'line-' + i });
  }
  return { s, base };
}

const baseline = (s) => s.readLogs(Infinity).filter((l) => l.nodeId === 'n_a');

test('indexed pagination matches the full-parse baseline page by page', async () => {
  const { s } = seeded(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-logidx-')));
  await flushed(s);
  const want = baseline(s);
  assert.equal(want.length, 300);
  for (let off = 0; off < 300; off += 80) {
    const page = await s.getSessionLog('sess-a', { offset: off, limit: 80 });
    assert.equal(page.total, want.length, 'total ' + off);
    const rows = want.slice(off, off + 80);
    assert.deepEqual(page.entries.map((e) => e.text), rows.map((l) => l.text), 'page ' + off);
    assert.deepEqual(page.entries.map((e) => e.ts), rows.map((l) => l.at), 'page ts ' + off);
  }
  const beyond = await s.getSessionLog('sess-a', { offset: 1000, limit: 50 });
  assert.deepEqual(beyond, { total: 300, offset: 1000, limit: 50, entries: [] });
});

test('flush maintains the sidecar index; rotation moves it to the backup', async () => {
  const { s } = seeded(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-logidx-')));
  await flushed(s);
  assert.equal((await s.getSessionLog('sess-a', { offset: 0, limit: 1 })).total, 300); // first read bootstraps the index (background rebuild)
  assert.ok(await until(() => { try { return fs.statSync(LI.idxPath(s.logFile())).size === LI.HEADER + 600 * LI.REC; } catch { return false; } }), 'index has one 24-byte row per line (plus header)');
  const prevRotate = LOG_LIMITS.rotateBytes;
  LOG_LIMITS.rotateBytes = 8192;
  try {
    for (let i = 0; i < 200; i++) s.appendLog({ at: Date.parse('2026-01-01T01:30:00Z') + i, nodeId: 'n_a', kind: 'text', text: 'post ' + i + ' ' + 'y'.repeat(80) });
    await flushed(s);
    assert.ok(await until(() => fs.existsSync(s.logFile() + '.1') && fs.existsSync(s.logFile() + '.1.idx')), 'rotation moved data and index to the backup');
    const all = await s.getSessionLog('sess-a', { offset: 0, limit: 1000 });
    assert.equal(all.total, 500, 'backup (300) + post-rotation (200) rows all visible');
    assert.equal(all.entries[0].text, 'line-1');
    assert.equal(all.entries[299].text, 'line-599');
    assert.ok(all.entries[300].text.startsWith('post 0 '), 'post-rotation rows follow the backup rows');
  } finally { LOG_LIMITS.rotateBytes = prevRotate; }
});

test('missing or corrupt index: the read still answers from a raw scan and the index rebuilds', async () => {
  const { s } = seeded(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-logidx-')));
  await flushed(s);
  await LI.rebuildIndex(s.logFile());
  const want = baseline(s).map((l) => l.text);
  // null: no file; 'garbage': wrong magic; buffer: valid length, garbage chain (breaks at row 0)
  for (const corrupt of [null, 'garbage', Buffer.alloc(LI.HEADER + 3 * LI.REC, 7)]) {
    if (corrupt === null) fs.unlinkSync(LI.idxPath(s.logFile()));
    else fs.writeFileSync(LI.idxPath(s.logFile()), corrupt);
    LI.dropIndex(s.logFile());
    const page = await s.getSessionLog('sess-a', { offset: 250, limit: 60 });
    assert.equal(page.total, 300, 'total with ' + (corrupt === null ? 'missing' : 'corrupt') + ' index');
    assert.deepEqual(page.entries.map((e) => e.text), want.slice(250, 310));
  }
  assert.ok(await until(() => { try { return fs.statSync(LI.idxPath(s.logFile())).size > LI.HEADER; } catch { return false; } }), 'background rebuild restores the index');
});

test('lines appended by another process (no index records) show up via the gap scan', async () => {
  const { s, base } = seeded(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-logidx-')));
  await flushed(s);
  await LI.rebuildIndex(s.logFile());
  fs.appendFileSync(s.logFile(), JSON.stringify({ at: base + 999999, nodeId: 'n_a', kind: 'text', text: 'foreign line' }) + '\n');
  const page = await s.getSessionLog('sess-a', { offset: 300, limit: 10 });
  assert.equal(page.total, 301);
  assert.equal(page.entries[0].text, 'foreign line');
});

test('append -> read-through -> no duplicate after the flush lands', async () => {
  const { s } = seeded(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-logidx-')));
  await flushed(s);
  const before = (await s.getSessionLog('sess-a', { offset: 0, limit: 1 })).total;
  s.appendLog({ at: Date.parse('2026-01-01T01:00:00Z'), nodeId: 'n_a', kind: 'text', text: 'tail' });
  const hot = await s.getSessionLog('sess-a', { offset: before, limit: 5 });
  assert.equal(hot.total, before + 1);
  assert.equal(hot.entries[0].text, 'tail');
  await flushed(s);
  const cold = await s.getSessionLog('sess-a', { offset: before, limit: 5 });
  assert.equal(cold.total, before + 1, 'no duplicate once the write (and its index records) landed');
  assert.equal(cold.entries[0].text, 'tail');
});

test('opening a page of a 50MB log stays under 50ms once the index exists', async () => {
  const s = tmp();
  const base = Date.parse('2026-01-01T00:00:00Z');
  const lines = [];
  let bytes = 0, i = 0;
  while (bytes < 50 * 1024 * 1024) {
    const line = JSON.stringify({ at: base + i, nodeId: 'n_' + (i % 3), kind: 'text', text: 'perf line ' + i + ' ' + 'p'.repeat(120) }) + '\n';
    lines.push(line);
    bytes += Buffer.byteLength(line);
    i++;
  }
  fs.writeFileSync(s.logFile(), lines.join('')); // a pre-index (legacy) log, like any upgraded project
  s.addRun({ id: 'r1', kind: 'agent', nodeId: 'n_0', sessionId: 'big', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-02T00:00:00Z', inputTokens: 1, outputTokens: 1 });
  const first = await s.getSessionLog('big', { offset: 0, limit: 200 }); // legacy read: raw scan + rebuild
  const expect = lines.map((l) => JSON.parse(l)).filter((l) => l.nodeId === 'n_0').length;
  assert.equal(first.total, expect);
  await LI.rebuildIndex(s.logFile());
  const times = [];
  for (let p = 0; p < 7; p++) {
    const t0 = Date.now();
    const page = await s.getSessionLog('big', { offset: (p * 9000) % (expect - 200), limit: 200 });
    times.push(Date.now() - t0);
    assert.equal(page.total, expect);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[3] < 50, 'median warm open ' + times[3] + 'ms must stay under 50ms (' + times.join(',') + ')');
});
