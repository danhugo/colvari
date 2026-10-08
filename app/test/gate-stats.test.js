'use strict';
// Gate-suite trend stats (t_dc59a89e): the stats file records every finished merge-gate suite
// run (duration, attempts, outcome) and summarizes it as p95/median time and green-after-retry rate — the infra retry rate, not flaky tests
// (green only after a second attempt). Unit coverage for the module, plus wire-through proofs:
// runGateTests records what it ran (injected runner AND the real default runner, including the
// flake path — infra first attempt, green rerun), and redMasterSnapshot exposes the summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GS = require('../src/gate-stats');
const MG = require('../src/merge-gate');

const tmpRoot = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `squad-gstats-${label}-`));

test('percentile: empty is null; p95/median pick inside the sorted window', () => {
  assert.equal(GS.percentile([], 0.95), null);
  assert.equal(GS.percentile([5], 0.95), 5);
  assert.deepEqual(GS.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10); // nearest-rank: ceil(0.95*10)th value
  assert.deepEqual(GS.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
});

test('record/summarize: p95, median, green p95 and infra retry rate over the window', () => {
  const root = tmpRoot('sum');
  const runs = [
    { state: 'green', durationMs: 1000, attempts: 1, infraRetry: false },
    { state: 'green', durationMs: 2000, attempts: 1, infraRetry: false },
    { state: 'green', durationMs: 3000, attempts: 2, infraRetry: true },
    { state: 'red', durationMs: 4000, attempts: 1, infraRetry: false },
    { state: 'green', durationMs: 5000, attempts: 1, infraRetry: false },
    { state: 'infra', durationMs: 6000, attempts: 1, infraRetry: false },
    { state: 'green', durationMs: 7000, attempts: 1, infraRetry: false },
    { state: 'green', durationMs: 8000, attempts: 1, infraRetry: false },
    { state: 'green', durationMs: 9000, attempts: 1, infraRetry: false },
    { state: 'green', durationMs: 10000, attempts: 1, infraRetry: false },
  ];
  for (const r of runs) assert.ok(GS.record(root, { task: 't_1', branch: 'squad/t_1', ...r }), 'record failed');
  const s = GS.summarize(root);
  assert.equal(s.runs, 10);
  assert.equal(s.greenRuns, 8);
  assert.equal(s.infraRetryRuns, 1);
  assert.equal(s.infraRetryRate, 0.1);
  assert.equal(s.p95Ms, 10000); // ceil(0.95*10)-1 = index 9
  assert.equal(s.medianMs, 5000);
  assert.equal(s.greenP95Ms, 10000); // greens: 1,2,3,5,7,8,9,10k → ceil(0.95*8)th = the max
  assert.ok(s.lastAt > 0);
  assert.equal(fs.existsSync(GS.statsFile(root)), true);
});

test('record: window capped at MAX_RUNS, oldest dropped', () => {
  const root = tmpRoot('cap');
  for (let i = 0; i < GS.MAX_RUNS + 5; i++) GS.record(root, { state: 'green', durationMs: i, attempts: 1 });
  const j = JSON.parse(fs.readFileSync(GS.statsFile(root), 'utf8'));
  assert.equal(j.runs.length, GS.MAX_RUNS);
  assert.equal(j.runs[0].durationMs, 5); // 0..4 dropped
  const s = GS.summarize(root);
  assert.equal(s.runs, GS.MAX_RUNS);
});

test('record: an unwritable root fails soft — no throw, file untouched', () => {
  const root = tmpRoot('hard');
  fs.writeFileSync(path.join(root, '.squad'), 'a file, not a dir'); // mkdirSync must fail
  assert.equal(GS.record(root, { state: 'green', durationMs: 1, attempts: 1 }), false);
});

test('runGateTests (injected runner): the suite run is recorded with duration and state', async () => {
  const root = tmpRoot('wire');
  const t = { id: 't_wire', worktreePath: path.join(root, 'app'), worktreeBranch: 'squad/t_wire' };
  const g = await MG.runGateTests(t, root, 'main', { runTests: async () => ({ ok: true, output: 'ℹ tests 7\n' }) });
  assert.equal(g.state, 'green');
  assert.equal(g.attempts, 1);
  assert.ok(g.durationMs >= 0);
  const s = GS.summarize(root);
  assert.equal(s.runs, 1);
  assert.equal(s.greenRuns, 1);
  assert.equal(s.infraRetryRuns, 0);
  const j = JSON.parse(fs.readFileSync(GS.statsFile(root), 'utf8'));
  assert.equal(j.runs[0].task, 't_wire');
  assert.equal(j.runs[0].state, 'green');
});

// The real infra-retry signal end to end: the default runner sees an infra-classified first attempt
// ("Cannot find module 'boom'") and a green rerun — infraRetryRun true, stats entry infraRetry.
test('runGateTests (default runner): infra first attempt + green rerun records an infra retry', async () => {
  const root = tmpRoot('flake');
  fs.mkdirSync(path.join(root, 'app', 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'node --test test/*.test.js' } }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'app', 'node_modules')); // pre-created: ensureDeps clones nothing
  fs.writeFileSync(path.join(root, 'app', 'test', 'a.test.js'), [
    "const fs = require('fs');",
    "const marker = require('path').join(__dirname, 'ran-once');",
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); throw new Error(\"Cannot find module 'boom'\"); }",
    "require('node:test').test('ok', () => {});",
    '',
  ].join('\n'));
  const t = { id: 't_flake', worktreePath: path.join(root, 'app'), worktreeBranch: 'squad/t_flake' };
  const g = await MG.runGateTests(t, root, 'main', {});
  assert.equal(g.state, 'green');
  assert.equal(g.attempts, 2);
  assert.equal(g.infraRetryRun, true);
  const s = GS.summarize(root);
  assert.equal(s.runs, 1);
  assert.equal(s.infraRetryRuns, 1);
  assert.equal(s.infraRetryRate, 1);
}, { timeout: 120000 });

test('redMasterSnapshot exposes gateStats for the board', async () => {
  const root = tmpRoot('snap');
  await MG.runGateTests({ id: 't_snap', worktreePath: path.join(root, 'app'), worktreeBranch: 'squad/t_snap' }, root, 'main', { runTests: async () => ({ ok: true, output: 'ℹ tests 3\n' }) });
  const store = { listTasks: () => [{ worktreePath: path.join(root, '.squad', 'worktrees', 't_x') }] };
  const snap = MG.redMasterSnapshot(store);
  assert.ok(snap.gateStats, 'no gateStats in snapshot');
  assert.equal(snap.gateStats.runs, 1);
  assert.ok(Number.isFinite(snap.gateStats.p95Ms));
});

test('gateMerge skipped runs leave no stats entry', async () => {
  const root = tmpRoot('skip');
  await MG.runGateTests({ id: 't_skip', worktreePath: root, worktreeBranch: 'squad/t_skip' }, root, 'main', {});
  assert.equal(GS.summarize(root).runs, 0);
});
