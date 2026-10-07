// Wire the stall watchdog (t_ea67793b): runAlive and stallLiveKids used to carry two hand-rolled
// copies of the descendant scan (same ppid BFS, same board-helper and zombie rules). They now share
// liveDescendants(), so a descendant that counts for liveness is by construction the same one a
// hard-cap kill reports — these tests pin the shared scan's rules through both callers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAlive, stallLiveKids, liveDescendants } = require('../src/stall-watchdog');

const row = (pid, ppid, state = 'S', command = 'cli', cpuMs = null) => ({ pid, ppid, state, cpuMs, command });
const BOARD_HELPER = row(70, 20, 'S', 'node src/mcp-server.js --project /tmp/p --node n_1');

test('liveDescendants: a live grandchild is found; zombies and the board helper subtree are not', () => {
  const rows = [row(10, 1), row(20, 10), row(30, 20), row(31, 20, 'Z'), row(40, 30), BOARD_HELPER, row(71, 70), row(50, 99)];
  const found = liveDescendants(rows, 10).map((r) => r.pid);
  assert.deepEqual(found.sort((a, b) => a - b), [20, 30, 40]); // 31 zombie, 70+71 helper subtree, 50 unrelated
});

test('runAlive: live descendant -> true; helper-only descendant -> false; zombie-only -> false', async () => {
  const orch = { _stallCpu: new Map(), procTable: async () => { throw new Error('must not fork ps when a snapshot is passed'); } };
  assert.equal(await runAlive(orch, 'n', { pid: 10 }, [row(10, 1), row(20, 10)]), true);
  assert.equal(await runAlive(orch, 'n', { pid: 10 }, [row(10, 1), BOARD_HELPER]), false);
  assert.equal(await runAlive(orch, 'n', { pid: 10 }, [row(10, 1), row(20, 10, 'Z')]), false);
  assert.equal(await runAlive(orch, 'n', { pid: 10 }, [row(10, 1)]), false);
});

test('runAlive: advanced CPU time counts as alive with no descendants at all', async () => {
  const orch = { _stallCpu: new Map() };
  const child = { pid: 10 };
  assert.equal(await runAlive(orch, 'n', child, [row(10, 1, 'S', 'cli', 1)]), false); // first pass seeds the snapshot
  assert.equal(await runAlive(orch, 'n', child, [row(10, 1, 'S', 'cli', 5)]), true);
});

test('runAlive: unknowable (no ps rows) counts as alive; an exited child does not', async () => {
  const orch = { _stallCpu: new Map() };
  assert.equal(await runAlive(orch, 'n', { pid: 10 }, null), true);
  assert.equal(await runAlive(orch, 'n', { pid: 10, exitCode: 0 }, [row(10, 1), row(20, 10)]), false);
});

test('stallLiveKids: same scan, pid+command shape for the hard-cap log', async () => {
  const orch = {};
  const rows = [row(10, 1), row(20, 10, 'S', 'npm build'), row(21, 10, 'Z'), BOARD_HELPER];
  assert.deepEqual(await stallLiveKids(orch, { pid: 10 }, rows), [{ pid: 20, command: 'npm build' }]);
  assert.deepEqual(await stallLiveKids(orch, { pid: 10 }, null), []);
  assert.deepEqual(await stallLiveKids(orch, null, rows), []);
});
