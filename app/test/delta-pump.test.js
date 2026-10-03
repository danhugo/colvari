const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { DeltaPump } = require('../src/delta-pump');
const DeltaClient = require('../src/delta-client');
const { Store } = require('../src/store');
const { BoardCache } = require('../src/board-cache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pump on a fake clock-ish setup: short tick/idle so tests stay fast.
const mkPump = (over = {}) => {
  const cache = new EventEmitter();
  const sends = [];
  const store = { sigFile: () => 's0', listMessages: () => [{ m: 1 }], listInbox: () => [{ i: 1 }], listRuns: () => [{ r: 1 }] };
  const pump = new DeltaPump({ projectId: 'p1', store, cache, orch: () => null, send: (b) => sends.push(b), tickMs: 5, idleMs: 15, ...over });
  return { pump, cache, sends, store };
};

const until = async (fn, ms = 2000) => { for (let t = 0; t < ms; t += 5) { if (fn()) return true; await sleep(5); } return fn(); };

test('pump batches a burst into one send per tick, seq/prev continuous, later events coalesce', async () => {
  const { pump, cache, sends } = mkPump();
  cache.emit('change', { section: 'task', id: 't1', type: 'put', seq: 1, data: { id: 't1', v: 1 } });
  cache.emit('change', { section: 'task', id: 't2', type: 'put', seq: 2, data: { id: 't2' } });
  cache.emit('change', { section: 'task', id: 't1', type: 'put', seq: 3, data: { id: 't1', v: 2 } }); // same key: last wins
  assert.ok(await until(() => sends.length === 1), 'one send for the whole burst');
  assert.equal(sends[0].projectId, 'p1');
  assert.equal(sends[0].seq, 1); assert.equal(sends[0].prev, 0);
  const t1 = sends[0].deltas.filter((d) => d.id === 't1');
  assert.equal(t1.length, 1); assert.equal(t1[0].set.v, 2); // coalesced to the latest put
  assert.equal(sends[0].deltas.length, 2);
  // second burst: the chain continues
  cache.emit('change', { section: 'wiki', id: 'Plan', type: 'delete', seq: 4 });
  assert.ok(await until(() => sends.length === 2));
  assert.equal(sends[1].seq, 2); assert.equal(sends[1].prev, 1);
  assert.deepEqual(sends[1].deltas, [{ type: 'wiki', id: 'Plan', del: 1 }]);
  pump.close();
});

test('orch state collapses to the last snapshot per batch', async () => {
  const { pump, sends } = mkPump();
  const o = new EventEmitter();
  pump.attachOrch(o);
  o.emit('state', { running: true, runs: 1 });
  o.emit('state', { running: true, runs: 2 });
  assert.ok(await until(() => sends.length === 1));
  const orch = sends[0].deltas.filter((d) => d.type === 'orch');
  assert.equal(orch.length, 1); assert.equal(orch[0].set.runs, 2);
  pump.close();
});

test('cold sections (messages/inbox/runs) ride along only when their sig moves', async () => {
  let sig = 's0';
  const { pump, sends, store } = mkPump({ store: { sigFile: (k) => (sig === 's0' ? 's0' : 'CHANGED:' + k), listMessages: () => [{ m: 2 }], listInbox: () => [], listRuns: () => [{ r: 2 }] } });
  await sleep(40); // idle flushes find nothing: no sends at all
  assert.equal(sends.length, 0);
  sig = 's1'; // all three sigs "changed"
  assert.ok(await until(() => sends.some((b) => b.deltas.some((d) => d.type === 'messages'))));
  const b = sends.find((x) => x.deltas.some((d) => d.type === 'messages'));
  assert.deepEqual(b.deltas.map((d) => d.type).sort(), ['inbox', 'messages', 'runs']);
  assert.deepEqual(b.deltas.find((d) => d.type === 'messages').set, [{ m: 2 }]);
  await sleep(40);
  const count = sends.length; // sig stable again: quiet
  await sleep(40);
  assert.equal(sends.length, count);
  pump.close();
});

test('the batch carries the hot version map the renderer needs to keep its poll quiet', async () => {
  const cache = new EventEmitter();
  cache.sectionSig = (s) => 'sig-' + s;
  const orch = { versionSig: () => 'orch-1' };
  let sig = 's0';
  const { pump, sends } = mkPump({ cache, orch: () => orch, store: { sigFile: () => sig, listMessages: () => [], listInbox: () => [], listRuns: () => [] } });
  sig = 's1';
  assert.ok(await until(() => sends.length === 1));
  assert.equal(sends[0].v.board, 'sig-board'); assert.equal(sends[0].v.wiki, 'sig-wiki');
  assert.equal(sends[0].v.orch, 'orch-1'); assert.equal(sends[0].v.messages, 's1');
  pump.close();
});

test('a cache resync event maps to a resync delta (full-resync path)', async () => {
  const { pump, cache, sends } = mkPump();
  cache.emit('resync');
  assert.ok(await until(() => sends.length === 1));
  assert.deepEqual(sends[0].deltas, [{ type: 'resync' }]);
  pump.close();
});

test('close() stops the pump: no sends after it', async () => {
  const { pump, cache, sends } = mkPump();
  pump.close();
  cache.emit('change', { section: 'task', id: 't1', type: 'put', seq: 1, data: { id: 't1' } });
  await sleep(40);
  assert.equal(sends.length, 0);
  pump.close(); // idempotent
});

// ---- the renderer side of the contract (DeltaClient) ----

test('gap or replay in the seq chain plans a full resync (wiki rule 5)', () => {
  assert.equal(DeltaClient.plan(null, { seq: 7, prev: 6, deltas: [] }).op, 'apply'); // first batch after boot/resync
  assert.equal(DeltaClient.plan(6, { seq: 7, prev: 6, deltas: [] }).op, 'apply');
  assert.equal(DeltaClient.plan(5, { seq: 7, prev: 6, deltas: [] }).op, 'resync'); // gap: batch 6 missed
  assert.equal(DeltaClient.plan(7, { seq: 7, prev: 6, deltas: [] }).op, 'resync'); // replay
  assert.equal(DeltaClient.plan(7, { seq: 9, prev: 8, deltas: [] }).op, 'resync'); // out of order: seq jumped past us
  assert.equal(DeltaClient.plan(7, null).op, 'ignore');
});

test('patch keeps S.tasks in listTasks order (createdAt, then id) on insert and replace', () => {
  const S = { tasks: [
    { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'c', createdAt: '2026-01-03T00:00:00Z' },
  ], wiki: {}, orch: {}, messages: [], inbox: [] };
  DeltaClient.patch(S, { type: 'task', id: 'b', set: { id: 'b', createdAt: '2026-01-02T00:00:00Z' } });
  assert.deepEqual(S.tasks.map((t) => t.id), ['a', 'b', 'c']);
  DeltaClient.patch(S, { type: 'task', id: 'a2', set: { id: 'a2', createdAt: '2026-01-01T00:00:00Z' } }); // same createdAt as 'a': id tiebreak
  assert.deepEqual(S.tasks.map((t) => t.id), ['a', 'a2', 'b', 'c']);
  DeltaClient.patch(S, { type: 'task', id: 'c', set: { id: 'c', createdAt: '2026-01-03T00:00:00Z', status: 'done' } }); // replace in place
  assert.equal(S.tasks.find((t) => t.id === 'c').status, 'done');
  assert.deepEqual(S.tasks.map((t) => t.id), ['a', 'a2', 'b', 'c']);
  DeltaClient.patch(S, { type: 'task', id: 'a2', del: 1 });
  assert.deepEqual(S.tasks.map((t) => t.id), ['a', 'b', 'c']);
  DeltaClient.patch(S, { type: 'task', id: 'zz', del: 1 }); // delete of an unknown id: no-op
  assert.deepEqual(S.tasks.map((t) => t.id), ['a', 'b', 'c']);
});

test('patch applies wiki/orch/messages/inbox deltas', () => {
  const S = { tasks: [], wiki: { Plan: { title: 'Plan', content: 'v1' } }, orch: { agents: {} }, messages: [], inbox: [] };
  DeltaClient.patch(S, { type: 'wiki', id: 'Plan', set: { title: 'Plan', content: 'v2' } });
  DeltaClient.patch(S, { type: 'wiki', id: 'Other', set: { title: 'Other', content: 'x' } });
  assert.equal(S.wiki.Plan.content, 'v2'); assert.equal(S.wiki.Other.content, 'x');
  DeltaClient.patch(S, { type: 'wiki', id: 'Other', del: 1 });
  assert.equal(S.wiki.Other, undefined);
  const orch = { agents: { a: { status: 'working' } } };
  DeltaClient.patch(S, { type: 'orch', set: orch });
  assert.equal(S.orch, orch);
  DeltaClient.patch(S, { type: 'messages', set: [{ m: 1 }] });
  DeltaClient.patch(S, { type: 'inbox', set: [{ i: 1 }] });
  assert.deepEqual(S.messages, [{ m: 1 }]); assert.deepEqual(S.inbox, [{ i: 1 }]);
});

// ---- end to end on a real Store + BoardCache: real writes become real deltas ----

test('real store writes flow through the cache into one batched send', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-e2e-'));
  const s = new Store(d, null, { cache: { debounceMs: 10, reconcileMs: 3600_000 } });
  s.listTasks(); // warm: watchers on
  const sends = [];
  const pump = new DeltaPump({ projectId: 'p', store: s, cache: s.cache, orch: () => null, send: (b) => sends.push(b), tickMs: 5, idleMs: 40 });
  const t = s.createTask({ title: 'from delta test' });
  assert.ok(await until(() => sends.length === 1), 'the write must reach the wire within one tick');
  const b = sends[0];
  assert.equal(b.seq, 1);
  const d1 = b.deltas.find((x) => x.type === 'task' && x.id === t.id);
  assert.ok(d1, 'task put delta present'); assert.equal(d1.set.title, 'from delta test');
  assert.equal(typeof b.v.board, 'string'); // version map rides along
  s.updateTask(t.id, { status: 'done' });
  s.deleteTask(t.id);
  assert.ok(await until(() => sends.some((x) => x.deltas.some((y) => y.type === 'task' && y.id === t.id && y.del))), 'the delete delta arrives');
  const last = sends[sends.length - 1];
  assert.ok(last.seq > 1 && last.prev === last.seq - 1, 'seq chain stays continuous');
  pump.close(); s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('renderer plan+patch reproduce getAll state from deltas alone (wiki rule 5, resync path)', async () => {
  // The full loop the renderer runs: boot getAll -> batches -> forced gap -> resync getAll ->
  // batches again, with S.tasks/wiki staying byte-equal to what a fresh getAll returns.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resync-'));
  const s = new Store(d, null, { cache: { debounceMs: 10, reconcileMs: 3600_000 } });
  const boot = s.createTask({ title: 'boot task' });
  s.listTasks();
  const sends = [];
  const pump = new DeltaPump({ projectId: 'p', store: s, cache: s.cache, orch: () => null, send: (b) => sends.push(b), tickMs: 5, idleMs: 40 });
  const S = { tasks: s.listTasks().map((x) => ({ ...x })), wiki: {}, orch: {}, messages: [], inbox: [] };
  let lastSeq = null;
  s.createTask({ title: 'delta task A' });
  s.createTask({ title: 'delta task B' });
  await until(() => sends.length >= 1); // both writes may coalesce into one batch — by design
  for (const b of sends.splice(0)) { // apply everything received so far as the renderer would
    assert.equal(DeltaClient.plan(lastSeq, b).op, 'apply');
    for (const dd of b.deltas) DeltaClient.patch(S, dd);
    lastSeq = b.seq;
  }
  assert.deepEqual(S.tasks.map((t) => t.id).sort(), s.listTasks().map((t) => t.id).sort());
  // A forced gap: the "renderer" never saw the next batch (we plan against a fabricated stale
  // seq) — it must plan a resync, i.e. re-pull instead of patching.
  assert.equal(DeltaClient.plan(lastSeq, { seq: lastSeq + 2, prev: lastSeq + 1, deltas: [] }).op, 'resync');
  // ...and after the resync the store's fresh state patches cleanly again.
  const S2 = { tasks: s.listTasks().map((x) => ({ ...x })), wiki: {}, orch: {}, messages: [], inbox: [] };
  s.createTask({ title: 'after resync' });
  assert.ok(await until(() => sends.length >= 1));
  const nb = sends[sends.length - 1];
  assert.equal(DeltaClient.plan(null, nb).op, 'apply'); // post-resync: first batch is trusted
  for (const dd of nb.deltas) DeltaClient.patch(S2, dd);
  assert.ok(S2.tasks.some((t) => t.title === 'after resync'));
  assert.ok(S2.tasks.some((t) => t.id === boot.id));
  pump.close(); s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- log lines ride the batch (t_d22a6cf2) ----

test('pushLog batches lines in order into ONE logs delta per tick; a logs-only burst still sends', async () => {
  const { pump, sends } = mkPump();
  pump.pushLog({ nodeId: 'n1', kind: 'text', text: 'a' });
  pump.pushLog({ nodeId: 'n1', kind: 'text', text: 'b' });
  pump.pushLog({ nodeId: 'n1', kind: 'text', text: 'c' });
  assert.ok(await until(() => sends.length === 1), 'one send for the whole burst');
  const d = sends[0].deltas;
  assert.equal(d.length, 1);
  assert.equal(d[0].type, 'logs');
  assert.deepEqual(d[0].set.map((l) => l.text), ['a', 'b', 'c']); // append-only: order preserved, no coalescing
  assert.equal(sends[0].seq, 1); assert.equal(sends[0].prev, 0); // logs alone still join the seq chain
  pump.close();
});

test('log lines ride along with task deltas in the same batch', async () => {
  const { pump, cache, sends } = mkPump();
  cache.emit('change', { section: 'task', id: 't1', type: 'put', seq: 1, data: { id: 't1' } });
  pump.pushLog({ nodeId: 'n1', kind: 'text', text: 'hi' });
  assert.ok(await until(() => sends.length === 1));
  assert.deepEqual(sends[0].deltas.map((d) => d.type), ['task', 'logs']);
  pump.close();
});

test('close() drops buffered log lines and pushLog after close is a no-op', async () => {
  const { pump, sends } = mkPump();
  pump.pushLog({ nodeId: 'n1', kind: 'text', text: 'x' });
  pump.close();
  pump.pushLog({ nodeId: 'n1', kind: 'text', text: 'y' });
  await sleep(40);
  assert.equal(sends.length, 0);
  assert.equal(pump.logBuf.length, 0);
});
