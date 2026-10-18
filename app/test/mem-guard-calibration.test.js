// Interface assumed from wiki "Decision: memory guard calibration and visibility (t_h0a1c302)";
// written ahead of the implementation — adjust names here if the landed code differs.
//   probe -> { level, availablePct }; status().defer / heldSince; guard.grantOverride(ms) / status().override;
//   alerts state: memGuard (status), memHeld (tasks), memWakeHeld (blocked wakes/agents).
const test = require('node:test');
const assert = require('node:assert');
const { MemGuard } = require('../src/mem-guard');
const A = require('../src/alerts');

const mk = (r, t = { v: 1000 }) => {
  const g = new MemGuard({ platform: 'darwin', probe: async () => r.cur, snapshot: async () => ({}), now: () => t.v });
  g.t = t; return g;
};
const probeAt = async (g, cur, at) => { if (at != null) g.t.v = at; g._probe = async () => cur; await g.refresh(); return g.status(); };

test('calibration (a): level 2 + 42% available does not defer; level 2 + 5% defers; level 3 defers', async () => {
  const g = mk({ cur: { level: 2, availablePct: 42 } });
  assert.equal((await probeAt(g, { level: 2, availablePct: 42 })).defer, false);
  assert.equal((await probeAt(g, { level: 2, availablePct: 5 }, 100000)).defer, true);
  assert.equal((await probeAt(g, { level: 2, availablePct: 42 }, 200000)).defer, false);
  assert.equal((await probeAt(g, { level: 3, availablePct: 42 })).defer, true);
});

test('calibration: hold lasts at least 30 s (no flapping on leaving)', async () => {
  const g = mk({ cur: {} });
  await probeAt(g, { level: 3, availablePct: 5 }, 1000);
  assert.equal((await probeAt(g, { level: 1, availablePct: 60 }, 10000)).defer, true);
  assert.equal((await probeAt(g, { level: 1, availablePct: 60 }, 32000)).defer, false);
});

test('override (d): expires after its window and ends early when the level rises', async () => {
  const g = mk({ cur: {} });
  await probeAt(g, { level: 2, availablePct: 5 }, 1000);
  g.grantOverride(30 * 60000);
  assert.ok(g.status().override);
  await probeAt(g, { level: 2, availablePct: 5 }, 1000 + 29 * 60000);
  assert.ok(g.status().override, 'still active inside 30 min');
  await probeAt(g, { level: 2, availablePct: 5 }, 1000 + 31 * 60000);
  assert.ok(!g.status().override, 'expired');
  g.grantOverride(30 * 60000);
  await probeAt(g, { level: 3, availablePct: 5 }, 1000 + 32 * 60000);
  assert.ok(!g.status().override, 'level rose above the granted level');
});

const holdState = (over) => ({ now: 5000, memGuard: { defer: true, level: 2, why: 'memory pressure', heldSince: 1000 }, memHeld: 0, memWakeHeld: 2, ...over });
const memAlert = (s) => A.collect(s).find((a) => a.id === 'mem-hold');

test('wake visibility (b): blocked wakes count in the alert even with no held tasks', () => {
  const a = memAlert(holdState());
  assert.ok(a, 'alert shown for wake-only holds');
  assert.match(a.text, /2/);
});

test('alert (c): fingerprint is per hold episode (heldSince); a new hold re-shows after dismissal', () => {
  const first = memAlert(holdState());
  assert.equal(memAlert(holdState({ memWakeHeld: 5 })).fingerprint, first.fingerprint, 'count changes do not re-show');
  const second = memAlert(holdState({ memGuard: { defer: true, level: 2, why: 'x', heldSince: 9000 } }));
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(first.action.label, 'Proceed anyway (30 min)');
});
