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
  t = 5000; level = 1; await g.refresh();
  assert.equal(g.status().clearSince, 5000);
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
