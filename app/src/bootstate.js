'use strict';
// App liveness breadcrumb (t_2ca99830). The 2026-10-01 01:47 silent death left no trace: no
// crash report, no log line, no restart state — the next boot could not tell "killed" from
// "never ran". The lock-holding app stamps every project's store dir with a heartbeat every few
// seconds and rewrites the stamp with a cleanExitAt on any exit it can still act on (quit,
// SIGTERM/SIGINT/SIGHUP, self-update relaunch — app.exit() skips 'will-quit', so relaunchApp
// marks clean itself). A boot that finds a stamp WITHOUT a clean marker knows the previous
// instance died without notice. Per store dir, so isolated instances (tests, perf harness on
// their own data roots) never see each other's breadcrumb.

const fs = require('fs');
const path = require('path');
const MG = require('./merge-gate');

const alivePath = (storeDir) => path.join(storeDir, '.squad', 'app-alive.json');

function writeAlive(storeDir, extra = {}) {
  const rec = { pid: process.pid, lstart: MG.pidLstart(process.pid), at: Date.now(), ...extra };
  try {
    fs.mkdirSync(path.dirname(alivePath(storeDir)), { recursive: true });
    const tmp = alivePath(storeDir) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, alivePath(storeDir)); // atomic: a concurrent reader never sees a torn record
  } catch {}
  return rec;
}

function readAlive(storeDir) {
  try { return JSON.parse(fs.readFileSync(alivePath(storeDir), 'utf8')); } catch { return null; }
}

// Unclean = a heartbeat exists, carries no clean-exit stamp, and belongs to a different process
// than the one asking (a heartbeat this process just wrote is never evidence against itself).
function detectUnclean(storeDir, selfPid = process.pid) {
  const prev = readAlive(storeDir);
  if (!prev || prev.cleanExitAt || prev.pid === selfPid) return null;
  return prev;
}

module.exports = { alivePath, writeAlive, readAlive, detectUnclean };
