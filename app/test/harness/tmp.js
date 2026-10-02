'use strict';
// Tracked temp dirs for tests (t_8170a988): every test-file process that creates a temp dir
// through mktemp()/mktempReal() — or through the installGlobal() fs.mkdtempSync wrapper — also
// removes it when the file's tests end, so `npm test` leaves nothing behind in $TMPDIR. node
// --test runs one process per file, so the tracking is per-file and concurrent files never see
// each other's dirs. Removal rides BOTH hooks: the node:test after() (runs even when
// --test-force-exit later SIGKILLs a loop-keeping file, which skips 'exit') and the process
// 'exit' hook (crashes, non-runner use). Must be required after procguard so its after/exit
// hooks (which kill spawned children) run first. Removal is best-effort: a dir still held by a
// spawned child is warned about, never fails the suite.
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];
let hooked = false;

function flush() {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.error(`[tmp] could not remove ${d}: ${e.message}`); }
  }
}

function hookOnce() {
  if (hooked) return;
  hooked = true;
  process.on('exit', flush);
  if (process.env.NODE_TEST_CONTEXT) {
    try {
      const { after } = require('node:test');
      after(async () => { flush(); }); // --test-force-exit kills the process AFTER after() hooks: this is the only guaranteed one
    } catch { /* no test teardown available — the exit hook still removes */ }
  }
}

function track(dir) {
  hookOnce();
  made.push(dir);
  return dir;
}

// Drop-in for fs.mkdtempSync(path.join(os.tmpdir(), prefix)).
function mktemp(prefix) {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Same, with the symlinked /var -> /private/var prefix resolved — what the old
// fs.realpathSync(fs.mkdtempSync(...)) sites needed for git worktree path comparisons.
function mktempReal(prefix) {
  return track(fs.realpathSync(mktemp(prefix)));
}

// Catch-all (t_8170a988): wraps fs.mkdtempSync so EVERY temp dir a test-file process makes is
// tracked and removed — files that never adopted mktemp()/mktempReal() above are covered too, as
// is any mkdtemp that test-required src/ code performs inside the test process.
function installGlobal() {
  if (installGlobal.done) return;
  installGlobal.done = true;
  hookOnce();
  const orig = fs.mkdtempSync;
  fs.mkdtempSync = function (prefix, options) { return track(orig.call(fs, prefix, options)); };
}

module.exports = { mktemp, mktempReal, installGlobal };
