'use strict';
// Procguard (t_92c31037): track every child process spawned in this process and make sure none
// outlives the suite. `npm test` preloads it into every test-file process via
// --require ./test/harness/install.js; gui-e2e/smoke install it in TEST_MODE (src/main.js) and
// `npm run e2e` in cli/e2e.js. Tracked pids are persisted to a pidfile so crashed or force-killed
// test processes are covered too: the next run that loads this module sweeps stale pidfiles and
// reaps their children. Signalling is strictly by tracked pid/pgid — never by process name — and
// stale entries are only killed after a process-start-time check confirms the pid was not
// recycled, so nothing the suite did not spawn can ever be signalled.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The pidfile dir must sit in the REAL system tmpdir, not the run's private one (t_4f2ff7cc):
// pidfiles are how a run that died hard gets its children reaped by the NEXT run, so they have
// to survive the private dir's teardown. test/harness/tmpdir.js exports AGENTS_SQUAD_REAL_TMP
// for exactly this; without it (e2e, gui-e2e) this is plain os.tmpdir() as before.
const DIR = path.join(process.env.AGENTS_SQUAD_REAL_TMP || os.tmpdir(), 'agents-squad-procguard');
const STARTED_AT = Date.now();
const PIDFILE = path.join(DIR, `p${process.pid}-${STARTED_AT}.json`);
const LEAK_GRACE_MS = 2000; // SIGKILL is asynchronous in effect; wait before declaring a leak
const PS_TIMEOUT_MS = 4000;

const children = new Map(); // pid -> { pid, pgid, detached, label, recordedAt }
let installed = false;

function writePidfile() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(PIDFILE, JSON.stringify({ ownerPid: process.pid, recordedAt: STARTED_AT, children: [...children.values()] }, null, 1));
  } catch { /* the pidfile is best-effort; reaping has its own paths */ }
}

function removePidfile() {
  try { fs.unlinkSync(PIDFILE); } catch { /* already gone */ }
}

// Elapsed seconds since the process started (ps etime), or null when it cannot be determined.
function elapsedSec(pid) {
  let out;
  try {
    out = cp.execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }).toString().trim();
  } catch { return null; }
  if (!out) return null;
  // formats: "mm:ss", "hh:mm:ss", "dd-hh:mm:ss"
  const [days, clock] = out.includes('-') ? out.split('-') : [null, out];
  const secs = clock.split(':').reduce((acc, n) => acc * 60 + Number(n), 0);
  return Number.isFinite(secs) ? secs + (days ? Number(days) * 86400 : 0) : null;
}

function isZombie(pid) {
  try {
    const state = cp.execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }).toString().trim();
    return state.includes('Z');
  } catch { return false; }
}

// A zombie still answers signal 0 but is dead for our purposes; EPERM means alive but unkillable.
function isAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  return !isZombie(pid);
}

// True when the pid's process age matches the age a child recorded `ageSec` ago would have —
// i.e. it is plausibly the very process we recorded, not a recycled pid (which must never be killed).
function sameProc(pid, ageSec) {
  const el = elapsedSec(pid);
  return el !== null && Math.abs(el - ageSec) <= 120;
}

function killEntry(c) {
  killDescendants(c.pid); // BEFORE the kill: a dead parent's children are unreachable via pgrep -P; a child that escaped its group (setsid) survives the group kill
  let ok;
  try {
    if (c.detached && c.pgid === c.pid) process.kill(-c.pid, 'SIGKILL'); // own group: kills its whole tree
    else process.kill(c.pid, 'SIGKILL');
    ok = true;
  } catch (e) { ok = e.code === 'ESRCH'; }
  return ok;
}

// All live descendants of pid via repeated `pgrep -P` walks (pid-based, never by name). Cycles
// guarded by a seen set; our own pid can never appear (we predate every tracked child) but is
// skipped defensively.
function descendantsOf(pid, seen = new Set()) {
  let direct = [];
  try {
    const out = cp.execFileSync('pgrep', ['-P', String(pid)], { timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) direct = out.split('\n').map(Number).filter(Boolean);
  } catch { /* no children (ESRCH/exit 1) or pgrep unavailable */ }
  const out = [];
  for (const d of direct) {
    if (d === process.pid || seen.has(d)) continue;
    seen.add(d);
    out.push(d, ...descendantsOf(d, seen));
  }
  return out;
}

function killDescendants(pid) {
  for (const d of descendantsOf(pid)) { try { process.kill(d, 'SIGKILL'); } catch {} }
}

function track(child, label, opts = {}) {
  if (!child || !child.pid || child.pid === process.pid || children.has(child.pid)) return child;
  // ChildProcess does not expose its spawn options: detached-ness (and with it whether the child
  // leads its own process group) only comes from the options captured at spawn time.
  const detached = !!opts.detached;
  children.set(child.pid, { pid: child.pid, pgid: detached ? child.pid : child.pid, detached, label: String(label || '').slice(0, 120), recordedAt: Date.now() });
  child.once('exit', () => {
    children.delete(child.pid);
    if (children.size) writePidfile(); else removePidfile();
  });
  writePidfile();
  return child;
}

function trackPid(pid, opts = {}) {
  if (!pid || pid === process.pid || children.has(pid)) return;
  children.set(pid, { pid, pgid: opts.pgid || pid, detached: !!opts.detached, label: String(opts.label || '').slice(0, 120), recordedAt: Date.now() });
  writePidfile();
}

// Last-resort reap: SIGKILL every tracked child (whole group for detached spawns) synchronously.
// Used at suite end, on process exit and on SIGINT/SIGTERM; stale-pidfile sweeps use killEntry.
function reapAll() {
  const failed = [];
  for (const c of children.values()) if (!killEntry(c)) failed.push(c);
  children.clear();
  removePidfile();
  return failed;
}

// The leak check: resolves with the tracked children that survived past the grace period. The
// per-file node:test teardown registered by install() throws when this is non-empty, failing the file.
async function assertNoLeaks(graceMs = LEAK_GRACE_MS) {
  const deadline = Date.now() + graceMs;
  let survivors = [...children.values()];
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    survivors = survivors.filter((c) => isAlive(c.pid));
  }
  return survivors;
}

// Reap children listed in pidfiles whose owner died without cleanup (crash, SIGKILL, force exit).
// Live sibling runs are skipped; recycled pids are never signalled (sameProc start-time check).
function sweepStale() {
  let files = [];
  try { files = fs.readdirSync(DIR); } catch { return; }
  for (const f of files) {
    if (!/^p\d+-\d+\.json$/.test(f) || f === path.basename(PIDFILE)) continue;
    const full = path.join(DIR, f);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { try { fs.unlinkSync(full); } catch { /* raced */ } continue; }
    const ageSec = (Date.now() - entry.recordedAt) / 1000;
    if (isAlive(entry.ownerPid) && sameProc(entry.ownerPid, ageSec)) continue; // a live run owns it
    for (const c of entry.children || []) {
      if (isAlive(c.pid) && sameProc(c.pid, ageSec)) killEntry(c);
    }
    try { fs.unlinkSync(full); } catch { /* raced */ }
  }
}

function wrap(original, labelOf) {
  return function wrapped(...args) {
    const child = original.apply(this, args);
    const opts = [args[1], args[2]].find((a) => a && typeof a === 'object' && !Array.isArray(a)) || {};
    track(child, labelOf(args), opts);
    return child;
  };
}

function install() {
  if (installed) return module.exports;
  installed = true;
  const label = (args) => `${args[0]} ${Array.isArray(args[1]) ? args[1].map(String).join(' ') : args[1] ?? ''}`;
  if (typeof cp.spawn === 'function') cp.spawn = wrap(cp.spawn, label);
  if (typeof cp.execFile === 'function') cp.execFile = wrap(cp.execFile, label);
  if (typeof cp.exec === 'function') cp.exec = wrap(cp.exec, (args) => args[0]);
  fs.mkdirSync(DIR, { recursive: true });
  sweepStale();
  process.on('exit', () => { reapAll(); });
  const onSignal = (code) => { reapAll(); process.exit(code); };
  process.on('SIGINT', () => onSignal(130));
  process.on('SIGTERM', () => onSignal(143));
  if (process.env.NODE_TEST_CONTEXT) {
    try {
      const { after } = require('node:test');
      after(async () => {
        // Check first: a tracked child still alive at suite end is a leak and must fail the file,
        // not be silently cleaned up (the grace window only covers children already being stopped).
        const leaked = await assertNoLeaks();
        reapAll();
        const unkillable = await assertNoLeaks(1000);
        const bad = [...unkillable];
        for (const l of leaked) if (!bad.some((b) => b.pid === l.pid)) bad.push(l);
        if (bad.length) throw new Error(`leak check (${path.basename(process.argv[1] || 'test')}): child processes survived the suite: ${bad.map((l) => `pid ${l.pid}${l.label ? ` (${l.label})` : ''}`).join(', ')}`);
      });
    } catch { /* no test teardown available — the exit hook still reaps */ }
  }
  return module.exports;
}

module.exports = { install, track, trackPid, reapAll, assertNoLeaks, sweepStale, writePidfile, isAlive, pidfile: PIDFILE, dir: DIR, children: () => [...children.values()] };
