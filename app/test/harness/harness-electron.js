'use strict';
// Driver half of the harness-run lifecycle (t_98eed830; the record/reap side lives in
// src/harness-sweep.js). Every node driver that starts Electron for a run — ab-gate, the
// profile driver — goes through spawnHarness():
//   - the child is DETACHED: it leads its own process group, so the whole tree (Electron main,
//     GPU/utility/renderer helpers, the cli.js wrapper's child) dies with one group signal;
//   - the run marker reaches the child twice: env AGENTS_SQUAD_HARNESS_RUN=<id> (arms the
//     parent-death watchdog inside the app) and an exact --squad-harness-run=<id> argv nonce
//     (lets the boot sweep prove a pidfile pid is this run before signalling it);
//   - the driver registers exit/SIGINT/SIGTERM/uncaught handlers that kill the child's group,
//     so a driver that dies any way but SIGKILL still takes its Electrons with it (SIGKILL is
//     the child watchdog's job). Kills are SIGTERM, grace, SIGKILL, and only with the live
//     pgid confirmed equal to the child pid.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const HS = require('../../src/harness-sweep');

const registry = new Map(); // child pid -> { pid }
let handlersInstalled = false;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The real Electron binary, not the cli.js wrapper: require('electron') under plain node
// resolves to dist/.../Electron (index.js exports the path), so child.pid IS the Electron main —
// own pgid, correct ppid for the watchdog. Falls back to the wrapper binary path.
function electronBin() {
  try {
    const p = require('electron');
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch { /* not installed here */ }
  return path.join(__dirname, '..', '..', 'node_modules', '.bin', 'electron');
}

// SIGTERM the run's group, wait out the grace, SIGKILL anything left. Resolves after the kill
// chain; never throws. Returns false when the pid was already gone.
async function killGroup(pid, { graceMs = HS.TERM_GRACE_MS, log = () => {} } = {}) {
  const livePgid = HS.pidPgid(pid);
  const sig = (s) => {
    try {
      if (livePgid === pid) process.kill(-pid, s); else process.kill(pid, s);
      return true;
    } catch { return false; }
  };
  if (!sig('SIGTERM')) return false;
  await new Promise((r) => setTimeout(r, graceMs));
  if (HS.pidAlive(pid)) { log(`[harness-driver] pid ${pid} survived SIGTERM — SIGKILL`); sig('SIGKILL'); }
  return true;
}

// Last-resort sync reap for driver 'exit' (no async possible) and signals: TERM, short grace,
// KILL for every still-registered child group.
function reapRegistered(graceMs = 300) {
  for (const { pid } of registry.values()) {
    const livePgid = HS.pidPgid(pid);
    try { if (livePgid === pid) process.kill(-pid, 'SIGTERM'); else process.kill(pid, 'SIGTERM'); } catch { continue; }
  }
  if (graceMs > 0) sleepSync(graceMs);
  for (const { pid } of registry.values()) {
    if (!HS.pidAlive(pid)) continue;
    const livePgid = HS.pidPgid(pid);
    try { if (livePgid === pid) process.kill(-pid, 'SIGKILL'); else process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  registry.clear();
}

// Idempotent. A driver's own death by any non-SIGKILL route still kills its harness groups.
function installDriverHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', () => { if (registry.size) reapRegistered(); });
  const onSignal = (code) => { reapRegistered(HS.TERM_GRACE_MS); process.exit(code); };
  process.on('SIGINT', () => onSignal(130));
  process.on('SIGTERM', () => onSignal(143));
  process.on('uncaughtException', (e) => {
    console.error('[harness-driver] uncaught error — killing harness group(s):', (e && e.stack) || e);
    reapRegistered(HS.TERM_GRACE_MS);
    process.exit(1);
  });
}

function spawnHarness(bin, args, opts = {}) {
  const { runId = HS.harnessRunId(opts.label || 'harness'), ...spawnOpts } = opts;
  const child = spawn(bin, [...args, HS.markerArgFor(runId)], {
    ...spawnOpts,
    detached: true, // own process group — the precondition for every group kill in this module
    env: { ...(spawnOpts.env || process.env), AGENTS_SQUAD_HARNESS_RUN: runId },
  });
  if (child.pid) {
    registry.set(child.pid, { pid: child.pid });
    child.once('exit', () => registry.delete(child.pid));
    child.once('error', () => registry.delete(child.pid));
    installDriverHandlers();
  }
  child.harnessRunId = runId;
  return child;
}

module.exports = { electronBin, spawnHarness, killGroup, reapRegistered, installDriverHandlers, TERM_GRACE_MS: HS.TERM_GRACE_MS };
