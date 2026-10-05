// Guard (t_6ffed1bd, epic t_h0a1c2fd): sync child_process calls block the Electron main
// process — a human marking a task done froze the whole app while the merge gate ran.
// The scan fails when a NEW sync spawn/exec lands in main-process src/: any file not listed
// here must stay at zero, and listed files carry a floor (ratchet) that only shrinking
// (Devon's async conversion, t_5a78aa95) keeps green. To add one legitimately — a CLI-only
// file that never loads inside Electron, like sandbox.js for the perf harness — raise that
// file's FLOOR entry with a justification comment. Matches are counted textually on purpose
// (Cato #5): both `const { spawnSync } = require('child_process')` and inline
// `require('child_process').execSync(...)` land here, strings included (conservative by
// design — a comment mentioning the API still counts, so nobody can hide a call in one).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Floors = current occurrences after t_5a78aa95 converted every main-path call to async
// (pruned from the landing snapshot of 39 on 2026-10-05). What remains, per file:
//   sandbox.js    — CLI-only (perf harness, never loaded inside Electron).
//   merge-gate.js — string content of the WATCHDOG child script (its own process) + comments.
//   main.js       — the gui-e2e conflictShots fixture helper (test-driver path) + comments.
//   the rest      — comments only; every real call is async now.
// Ratchet: only shrinking keeps this green; a new sync call must come with a conversion.
const FLOOR = {
  'capabilities.js': 1,
  'introspector.js': 2,
  'main.js': 4,
  'merge-gate.js': 4,
  'run-watchdog.js': 1,
  'runtimes.js': 1,
  'sandbox.js': 5,
  'self-update.js': 2,
  'stall-watchdog.js': 1,
  'worktree.js': 2,
};

const SYNC_API = /\b(?:spawnSync|execFileSync|execSync)\b/g;

// Recursive on purpose: a future subdir must not become a blind spot (renderer lives
// outside src/, in app/renderer/, so nothing here should be excluded).
function listSrcFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSrcFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

test('no sync child_process calls in main-process src/ beyond the pinned floors', () => {
  const offenders = [];
  for (const p of listSrcFiles(SRC)) {
    const rel = path.relative(SRC, p);
    const n = (fs.readFileSync(p, 'utf8').match(SYNC_API) || []).length;
    const floor = FLOOR[rel] || 0;
    if (n > floor) offenders.push(`${rel}: ${n} sync child_process occurrence(s) > floor ${floor}${floor === 0 ? ' (file not allowlisted at all)' : ''}`);
  }
  assert.deepStrictEqual(offenders, [], [
    'sync child_process found in main-process src/ — it blocks the Electron main loop',
    '(t_h0a1c2fd). Convert to async spawn/execFile with a timeout (see t_5a78aa95); a',
    'CLI-only exception needs an explicit FLOOR entry in test/main-sync-guard.test.js.',
  ].join('\n'));
});

test('guard floors stay honest: no floor for a file that no longer exists', () => {
  // A renamed/deleted file must not silently keep a floor that would excuse a new offender
  // reusing the old name; floors left high after a conversion should be pruned too.
  const missing = Object.keys(FLOOR).filter((f) => !fs.existsSync(path.join(SRC, f)));
  assert.deepStrictEqual(missing, [], 'stale guard floors for files that no longer exist — prune FLOOR');
});
