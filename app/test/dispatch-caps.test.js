// t_a9864978: concurrency cap (default 5) holds extra runs in a queue instead of dropping them,
// and the memory-pressure guard (src/mem-guard.js) defers dispatch — never os.freemem() on macOS.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const { MemGuard, DEFER_AT } = require('../src/mem-guard');

function setup(n = 3, settings = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-caps-'));
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 0.4\necho \'{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(r, 'data')); s.saveSettings({ claudePath: fake, maxConcurrency: 0, useWorktrees: false, ...settings });
  const ns = Array.from({ length: n }, (_, i) => s.addNode({ name: 'A' + i, role: 'Dev', workdir: path.join(r, 'w' + i) }));
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // clean hand-offs complete via reviewer pickup
  for (const n of ns) s.addEdge(n.id, rev.id, 'review');
  return { s, ns };
}

test('settings defaults: maxConcurrency 5, memGuardDeferAt warning; bogus guard value rejected', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-caps-def-'));
  const st = new Store(path.join(r, 'data')).getSettings();
  assert.equal(st.maxConcurrency, 5);
  assert.equal(st.memGuardDeferAt, 'warning');
  const { s } = setup(1);
  assert.throws(() => s.saveSettings({ memGuardDeferAt: 'bogus' }), /memGuardDeferAt/);
  assert.equal(s.saveSettings({ memGuardDeferAt: 'critical' }).memGuardDeferAt, 'critical');
});

test('cap queues extra runs instead of dropping them, and the queue drains as slots free', async () => {
  const { s, ns } = setup(6, { maxConcurrency: 2 });
  ns.forEach((n, i) => s.createTask({ title: 't' + i, assignee: n.id }));
  const o = new Orchestrator(s);
  o.start();
  // Only 2 slots; the other 4 are held as queued with the cap as the reason (not dropped).
  assert.equal(o.snapshotSlim().active.length, 2);
  let holds = o.snapshotSlim().dispatchHolds;
  assert.equal(holds.length, 4);
  assert.ok(holds.every((h) => /maxConcurrency \(2\) slots in use/.test(h.why)), JSON.stringify(holds));
  assert.ok(holds.every((h) => typeof h.since === 'number' && h.title && h.nodeId));
  // Guard state rides the snapshot for the UI.
  assert.equal(o.snapshotSlim().memGuard.deferAt, 'warning');
  await new Promise((r) => o.on('done', r));
  // Queue-not-drop: every task ran to done.
  assert.ok(s.listTasks().every((t) => t.status === 'done'));
  assert.equal(o.snapshotSlim().dispatchHolds.length, 0);
});

test('memory-pressure guard defers dispatch (fail-open when it clears), with the reason surfaced', async () => {
  const { s, ns } = setup(2);
  ns.forEach((n) => s.createTask({ title: 'memtask', assignee: n.id }));
  let defer = true; let why = 'memory pressure warning (level 2)';
  const fakeGuard = { configure() {}, refresh: () => Promise.resolve(), status: () => ({ defer, why, level: 2, deferAt: 'warning' }) };
  const o = new Orchestrator(s, { memGuard: fakeGuard });
  o.start();
  assert.equal(o.snapshotSlim().active.length, 0, 'nothing dispatches under pressure');
  assert.equal(o.snapshotSlim().dispatchHolds.length, 2);
  assert.ok(o.snapshotSlim().dispatchHolds.every((h) => h.why.includes('memory pressure warning')));
  assert.equal(o.runState().state, 'idle');
  assert.equal(o.runState().reason, 'paused: memory pressure');
  defer = false;
  await o.tick();
  assert.equal(o.snapshotSlim().active.length, 2, 'queued tasks dispatch once pressure clears');
  assert.equal(o.snapshotSlim().dispatchHolds.length, 0);
  await new Promise((r) => o.on('done', r));
  assert.ok(s.listTasks().every((t) => t.status === 'done'));
});

test('wake dispatch defers under memory pressure; messages stay unread and are delivered later', async () => {
  const { s, ns } = setup(1);
  let defer = true;
  const fakeGuard = { configure() {}, refresh: () => Promise.resolve(), status: () => ({ defer, why: 'memory pressure warning (level 2)' }) };
  const o = new Orchestrator(s, { memGuard: fakeGuard });
  o.start();
  const m = s.sendMessage({ from: 'human', to: ns[0].id, text: 'hello' });
  assert.equal(await o.wakeForHuman(ns[0].id, [m]), false, 'wake refused under pressure');
  assert.equal(o.procs.size, 0);
  assert.equal(s.listMessages({ to: ns[0].id }).find((x) => x.id === m.id).read || false, false, 'message stays unread');
  defer = false;
  assert.equal(await o.wakeForHuman(ns[0].id, [m]), true, 'wake dispatches once pressure clears');
  await new Promise((r) => o.on('done', r));
  assert.equal(s.listMessages({ to: ns[0].id }).find((x) => x.id === m.id).read, true);
});

test('MemGuard: mac probe levels gate at the configured threshold and a broken probe fails open', async () => {
  // guard 'warning' (default): level 2 defers, level 1 does not
  const g = new MemGuard({ platform: 'darwin', probe: async () => ({ level: 2 }) });
  g.configure('warning');
  await g.refresh();
  assert.equal(g.status().defer, true);
  assert.match(g.status().why, /warning \(level 2\)/);
  const g1 = new MemGuard({ platform: 'darwin', probe: async () => ({ level: 1 }) });
  g1.configure('warning');
  await g1.refresh();
  assert.equal(g1.status().defer, false);
  // 'critical' defers only at level 3
  const g3 = new MemGuard({ platform: 'darwin', probe: async () => ({ level: 2 }) });
  g3.configure('critical');
  await g3.refresh();
  assert.equal(g3.status().defer, false);
  // 'off' never defers
  const g0 = new MemGuard({ platform: 'darwin', probe: async () => ({ level: 3 }) });
  g0.configure('off');
  await g0.refresh();
  assert.equal(g0.status().defer, false);
  assert.equal(DEFER_AT.warning, 2); assert.equal(DEFER_AT.critical, 3); assert.equal(DEFER_AT.off, Infinity);
  // broken probe: defer stays false (fail open), the failure is named
  const gb = new MemGuard({ platform: 'darwin', probe: async () => { throw new Error('sysctl exploded'); } });
  await gb.refresh();
  assert.equal(gb.status().defer, false);
  assert.match(gb.status().why, /memory probe failed/);
  // non-mac fallback: the task's literal freemem < 1.5 GB rule
  const gf = new MemGuard({ platform: 'linux', freeMem: () => 0.5 * 1024 ** 3 });
  await gf.refresh();
  assert.equal(gf.status().defer, true);
  assert.match(gf.status().why, /free memory 0\.50 GB < 1\.5 GB/);
  const gok = new MemGuard({ platform: 'linux', freeMem: () => 4 * 1024 ** 3 });
  await gok.refresh();
  assert.equal(gok.status().defer, false);
});
