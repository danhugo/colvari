'use strict';
// Rolling record of merge-gate suite runs (t_dc59a89e): per-run wall time, attempts and outcome,
// summarized as p95/median suite time and a flake rate (a green result that needed a second
// attempt). One small capped JSON per repo root, written atomically next to merge-gate.json so
// gate-speed and flake trends are visible instead of anecdotal.
const fs = require('fs');
const path = require('path');

const MAX_RUNS = 200;
const statsFile = (root) => path.join(root, '.squad', 'merge-gate-stats.json');

function read(root) {
  try {
    const j = JSON.parse(fs.readFileSync(statsFile(root), 'utf8'));
    return Array.isArray(j.runs) ? j : { runs: [] };
  } catch { return { runs: [] }; }
}

// rec: { task, branch, state, attempts, durationMs, tests, flaky } — one SUITE run (a CAS round
// that re-tests records its own entry). Never throws at call sites; a stats failure must not
// fail a green gate.
function record(root, rec) {
  try {
    const j = read(root);
    j.runs.push({
      at: Date.now(),
      task: rec.task || null,
      branch: rec.branch || null,
      state: rec.state,
      attempts: rec.attempts || 1,
      durationMs: Math.max(0, Math.round(rec.durationMs || 0)),
      tests: rec.tests || 0,
      flaky: !!rec.flaky,
    });
    if (j.runs.length > MAX_RUNS) j.runs = j.runs.slice(-MAX_RUNS);
    const f = statsFile(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 1) + '\n');
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

// Trends over the recorded window. p95/median cover every finished suite run (a red run costs
// the gate just as much); greenP95Ms isolates the happy path; flakeRate is flaky runs / runs.
function summarize(root) {
  const runs = read(root).runs.filter((r) => r && Number.isFinite(r.durationMs));
  const durs = runs.map((r) => r.durationMs).sort((a, b) => a - b);
  const green = runs.filter((r) => r.state === 'green').map((r) => r.durationMs).sort((a, b) => a - b);
  const flaky = runs.filter((r) => r.flaky).length;
  return {
    runs: runs.length,
    greenRuns: green.length,
    flakyRuns: flaky,
    flakeRate: runs.length ? flaky / runs.length : null,
    p95Ms: percentile(durs, 0.95),
    medianMs: percentile(durs, 0.5),
    greenP95Ms: percentile(green, 0.95),
    lastAt: runs.length ? runs[runs.length - 1].at : null,
  };
}

module.exports = { record, summarize, statsFile, MAX_RUNS, percentile };
