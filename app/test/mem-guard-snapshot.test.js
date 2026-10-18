const test = require('node:test');
const assert = require('node:assert');
const { MemGuard } = require('../src/mem-guard');

test('mem-guard: snapshot probed ONCE when a hold starts; clearSince set on clear, reset on re-hold', async () => {
  let level = 1, snaps = 0, t = 1000;
  const g = new MemGuard({ platform: 'darwin', probe: async () => ({ level }), snapshot: async () => { snaps++; return { procs: [{ name: 'Docker', mb: 2000 }] }; }, now: () => t });
  await g.refresh(); assert.equal(snaps, 0);
  level = 2; await g.refresh(); await g.refresh(); await new Promise((r) => setImmediate(r));
  assert.equal(snaps, 1);
  assert.equal(g.status().heldSince, 1000);
  assert.equal(g.status().snapshot.procs[0].name, 'Docker');
  t = 40000; level = 1; await g.refresh(); // past the 30 s minimum hold
  assert.equal(g.status().clearSince, 40000);
  level = 2; await g.refresh(); await new Promise((r) => setImmediate(r));
  assert.equal(g.status().clearSince, null);
  assert.equal(snaps, 2);
});

test('mem-guard: parseSnapshot reads ps + vm_stat', () => {
  const s = MemGuard.parseSnapshot('2048000 /Applications/Docker.app/Contents/MacOS/com.docker.backend\n 1024 /bin/zsh\n',
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               19200.\nPages occupied by compressor:            64000.\n');
  assert.deepEqual(s.procs[0], { name: 'com.docker.backend', mb: 2000 });
  assert.equal(s.freeMB, 300);
  assert.equal(s.compressedMB, 1000);
});

const VM = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages active: 500.\nPages inactive: 300.\nPages speculative: 0.\nPages wired down: 100.\nPages purgeable: 0.\nPages occupied by compressor: 0.\n';
test('mem-guard: parseAvailPct = (free+inactive+purgeable)/total', () => assert.equal(Math.round(MemGuard.parseAvailPct(VM)), 40));

test('mem-guard: level 2 defers only below 15% available; level 3 always; 30 s hysteresis', async () => {
  let r = { level: 2, availPct: 42 }, t = 1000;
  const g = new MemGuard({ platform: 'darwin', probe: async () => r, snapshot: async () => ({}), now: () => t });
  await g.refresh(); assert.equal(g.status().defer, false);
  r = { level: 2, availPct: 10 }; await g.refresh(); assert.equal(g.status().defer, true);
  t = 20000; r = { level: 2, availPct: 50 }; await g.refresh(); assert.equal(g.status().defer, true, 'held >= 30 s');
  t = 32000; assert.equal(g.status().defer, false);
  r = { level: 3, availPct: 80 }; await g.refresh(); assert.equal(g.status().defer, true);
});

test('mem-guard: override lasts 30 min and ends early when the level rises', async () => {
  let r = { level: 2, availPct: 5 }, t = 0;
  const g = new MemGuard({ platform: 'darwin', probe: async () => r, snapshot: async () => ({}), now: () => t });
  await g.refresh(); assert.equal(g.status().defer, true);
  g.override(); assert.equal(g.status().defer, false);
  t = 29 * 60000; assert.equal(g.status().defer, false);
  r = { level: 3 }; await g.refresh(); assert.equal(g.status().defer, true);
  r = { level: 2, availPct: 5 }; t = 100000; await g.refresh(); g.override(); t = 100000 + 31 * 60000; assert.equal(g.status().defer, true);
});

test('mem-guard: statfs gives disk free of the project volume', async () => {
  const g = new MemGuard({ platform: 'darwin', probe: async () => ({ level: 1 }), diskPath: '/x', statfs: async () => ({ bavail: 10, bsize: 4, blocks: 100 }) });
  await g.refresh(); assert.equal(g.status().diskFreeBytes, 40);
});
