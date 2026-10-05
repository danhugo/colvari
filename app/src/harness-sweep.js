'use strict';
// Harness-run lifecycle (t_98eed830, plan t_b8a2f6c4): every Electron a harness starts —
// test/perf/* mains, the ab-gate/profile drivers, gui-e2e/smoke — carries the
// AGENTS_SQUAD_HARNESS_RUN marker. This module is the shared record + reaper:
//   - recordRun: the run writes its OWN pidfile (one JSON per run, tmp+rename atomic) with its
//     pid, process-group id, exact start time, the run marker (argv nonce and/or env) and its
//     owner (the harness process that started it).
//   - armParentWatchdog: runs INSIDE the harness Electron; quits the app when the owning process
//     disappears — covering driver SIGKILL/crash and drain cuts, where no exit handler can fire.
//     It watches both the recorded owner pid and the live ppid (an orphan on macOS reparents to
//     launchd, and a dead owner's pid can be recycled), so one check alone can never miss.
//   - sweep: at app boot, reap only pidfile-recorded orphans. A recorded pid is signalled only
//     when its recorded owner is dead AND the live process still matches the recorded start time
//     and marker — recycled pids, marker mismatches and anything unverifiable are skipped and
//     their pidfile removed, never killed. Processes are never matched by name.
const fs = require('fs');
const os = require('os');
const path = require('path');
const CP = require('./cp');

const MARKER_ARG_PREFIX = '--squad-harness-run=';
const ENV_MARKER_PREFIX = 'AGENTS_SQUAD_HARNESS_RUN=';
const TERM_GRACE_MS = 2000; // SIGTERM, wait, then SIGKILL (critic amendment 2 on t_b8a2f6c4)
const PS_TIMEOUT_MS = 4000;
const PS_TRIES = 5; // a loaded machine can EAGAIN/starve a spawn; empty ≠ a real answer (see psField)
const PS_RETRY_MS = 50;

// The real system tmpdir, not a run's private one (same reasoning as procguard): pidfiles are how
// a run that died hard gets reaped by a LATER boot, so they must survive private-dir teardown.
const pidsDir = () => path.join(process.env.AGENTS_SQUAD_REAL_TMP || os.tmpdir(), 'agents-squad-harness-pids');
const pidFileOf = (runId) => path.join(pidsDir(), `${String(runId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
const harnessRunId = (label = 'harness') => `${label}-${process.pid}-${Date.now().toString(36)}`;
const markerArgFor = (runId) => MARKER_ARG_PREFIX + runId;

// Non-blocking nap for the retry gap (sweep is async since t_5a78aa95 — the old Atomics.wait
// blocked the booting main process for the whole identity-verified sweep).
const psNap = (ms) => CP.sleep(ms);

// An empty read of a live pid is always a FAILED observation, never an answer: a live process
// always has an lstart, a pgid and a command. Under load the `ps` spawn itself can EAGAIN, time
// out or be starved into emptiness — reporting that as a mismatch would skip (never signal) an
// orphan that must be reaped, so retry briefly before giving up and reporting emptiness.
async function psField(pid, args) {
  for (let i = 0; i < PS_TRIES; i++) {
    let out = '';
    try {
      const r = await CP.run('ps', ['-p', String(pid), ...args], { timeoutMs: PS_TIMEOUT_MS });
      out = String(r.stdout || '').trim();
    } catch { /* transient spawn failure under load: retry */ }
    if (out) return out;
    if (i < PS_TRIES - 1) await psNap(PS_RETRY_MS * (i + 1)); // growing backoff: a slammed machine needs more than one slack window
  }
  return '';
}
const pidLstart = async (pid) => psField(pid, ['-o', 'lstart=']);
const pidPgid = async (pid) => { const v = Number(await psField(pid, ['-o', 'pgid='])); return Number.isInteger(v) && v > 0 ? v : null; };
const pidCommand = async (pid) => psField(pid, ['-o', 'command=']);
// `ps eww` (darwin) appends the process environment to the command line — how a run that
// self-marked via env alone (no argv nonce) is still identified from outside. The mode flag
// must precede -p; empty output (unsupported platform) fails the check open to the lstart gate.
const pidEnvBlob = async (pid) => {
  const r = await CP.run('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeoutMs: PS_TIMEOUT_MS });
  return String(r.stdout || '').trim();
};

const isZombie = async (pid) => (await psField(pid, ['-o', 'state='])).includes('Z');
// A zombie answers signal 0 but is dead for our purposes; EPERM means alive but unkillable.
async function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  return !(await isZombie(pid));
}

// Pids of this process and its ancestors (bounded walk): the sweep never signals these even if a
// stale pidfile claims them (critic amendment 5).
async function ownAncestors(selfPid = process.pid) {
  const seen = new Set([selfPid]);
  let pid = selfPid;
  for (let i = 0; i < 30; i++) {
    const ppid = Number(await psField(pid, ['-o', 'ppid=']));
    if (!Number.isInteger(ppid) || ppid <= 1 || seen.has(ppid)) break;
    seen.add(ppid); pid = ppid;
  }
  return seen;
}

function atomicWriteJson(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
  fs.renameSync(tmp, file);
}
const removeFile = (file) => { try { fs.unlinkSync(file); } catch { /* raced or gone */ } };

// The harness app records itself (called from src/main.js when the marker is present). The marker
// argv nonce comes from the driver when it spawned us; TEST_MODE self-marks have env only.
// Async since t_5a78aa95 (the pid/pgid/lstart reads fork ps).
async function recordRun({ runId, ownerPid = process.ppid, markerArg = null, log = () => {} } = {}) {
  if (!runId) return null;
  const rec = {
    runId: String(runId),
    pid: process.pid,
    pgid: (await pidPgid(process.pid)) || process.pid,
    lstart: await pidLstart(process.pid),
    markerArg: markerArg || process.argv.find((a) => String(a).startsWith(MARKER_ARG_PREFIX)) || null,
    envMarker: ENV_MARKER_PREFIX + String(runId),
    ownerPid: ownerPid || null,
    ownerLstart: ownerPid ? await pidLstart(ownerPid) : '',
    recordedAt: Date.now(),
  };
  atomicWriteJson(pidFileOf(rec.runId), rec);
  log(`[harness-sweep] run ${rec.runId} recorded (pid ${rec.pid}, pgid ${rec.pgid}, owner ${rec.ownerPid})`);
  return rec;
}

const removeRun = (runId) => { if (runId) removeFile(pidFileOf(runId)); };

// Parent-death watchdog for the harness child. Polls both signals of a dead owner: the recorded
// owner pid vanishing, and the live ppid having become 1 (reparented — the original parent is
// gone even if its pid was reused). Only meaningful in a marked harness process; production apps
// never arm it. `quit` is the app-provided stop; this module stays Electron-free.
function armParentWatchdog({ runId, ownerPid = process.ppid, quit, log = (m) => console.error(m), intervalMs = 1000 } = {}) {
  const t = setInterval(() => {
    let reason = null;
    if (process.ppid === 1) reason = 'parent died (orphaned to launchd)';
    else if (ownerPid && ownerPid !== 1) {
      try { process.kill(ownerPid, 0); } catch (e) { if (e.code === 'ESRCH') reason = `owner pid ${ownerPid} is gone`; }
    }
    if (!reason) return;
    clearInterval(t);
    log(`[harness-watchdog] ${reason} — ending harness run ${runId} (pid ${process.pid})`);
    try { removeRun(runId); } catch { /* swept later anyway */ }
    try { quit && quit(reason); } catch { /* exit below is the backstop */ }
  }, intervalMs);
  t.unref?.();
  return t;
}

// Group kill verified against the LIVE pgid (critic amendment 2): the negative form only fires
// when the pid really leads its own group, so the signal can never land in some other group.
function signalRun(pid, sig, livePgid) {
  try {
    if (livePgid === pid) process.kill(-pid, sig);
    else process.kill(pid, sig);
    return true;
  } catch { return false; }
}

async function killRecorded(rec, log) {
  const livePgid = await pidPgid(rec.pid);
  signalRun(rec.pid, 'SIGTERM', livePgid);
  setTimeout(() => {
    if (!pidAlive(rec.pid)) return;
    log(`[harness-sweep] run ${rec.runId}: pid ${rec.pid} survived SIGTERM — SIGKILL`);
    signalRun(rec.pid, 'SIGKILL', livePgid);
  }, TERM_GRACE_MS).unref?.();
}

// Why a pidfile entry may not be touched. 'live-run' keeps the pidfile (its owner is alive);
// every other non-orphan verdict deletes the pidfile but NEVER signals.
async function judgeRun(rec, { selfPid, ancestors }) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1) return 'malformed';
  if (rec.pid === selfPid || ancestors.has(rec.pid)) return 'live-run'; // our own tree
  if (rec.ownerPid && rec.ownerPid !== selfPid && !ancestors.has(rec.ownerPid)) {
    const ownerAlive = (await pidAlive(rec.ownerPid)) && (!rec.ownerLstart || (await pidLstart(rec.ownerPid)) === rec.ownerLstart);
    if (ownerAlive) return 'live-run';
  }
  if (!(await pidAlive(rec.pid))) return 'dead-record'; // recorded pid gone: stale record, nothing to reap
  // Identity: a DIFFERENT, non-empty lstart proves pid reuse (critic amendment 1); a DIFFERENT
  // command proves the same. An EMPTY read (ps starved under load, t_8f7605c4 gate flake) proves
  // nothing — it must fall through to the next check instead of skipping an orphan that has to
  // be reaped, and if every read starves the record is kept for the next sweep, never deleted.
  let verified = false;
  if (rec.lstart) { const ls = await pidLstart(rec.pid); if (ls) { if (ls !== rec.lstart) return 'recycled-pid'; verified = true; } }
  if (rec.markerArg) {
    const cmd = await pidCommand(rec.pid);
    if (cmd) { if (!cmd.includes(rec.markerArg)) return 'marker-mismatch'; verified = true; }
  } else if (rec.envMarker) {
    const blob = await pidEnvBlob(rec.pid);
    if (blob) { if (!blob.includes(rec.envMarker)) return 'marker-mismatch'; verified = true; }
  }
  if (!verified) return 'unverifiable'; // every identity read starved: keep the record, try again after the next boot
  return 'orphan'; // owner dead, live pid is provably the recorded harness run
}

// Boot sweep (plan item 2): read ONLY the dedicated pidfile dir, never userData, never names.
// Async since t_5a78aa95: identity reads fork ps (per record, with retries) — awaited on the
// event loop so the booting main process never stalls.
async function sweep({ selfPid = process.pid, log = (m) => console.log(m) } = {}) {
  const out = { reaped: [], skipped: [], stale: 0 };
  let files = [];
  try { files = fs.readdirSync(pidsDir()); } catch { return out; }
  const ancestors = await ownAncestors(selfPid);
  for (const f of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(f)) continue;
    const full = path.join(pidsDir(), f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { removeFile(full); continue; }
    const verdict = await judgeRun(rec, { selfPid, ancestors });
    if (verdict === 'live-run') continue;
    if (verdict === 'orphan') {
      log(`[harness-sweep] reaping orphaned harness run ${rec.runId} (pid ${rec.pid}, owner ${rec.ownerPid} is gone)`);
      killRecorded(rec, log);
      removeFile(full);
      out.reaped.push({ runId: rec.runId, pid: rec.pid });
      continue;
    }
    if (verdict === 'dead-record') { removeFile(full); out.stale++; continue; }
    if (verdict === 'unverifiable') { // keep the record: the next sweep re-reads identity once ps can answer
      out.skipped.push({ runId: rec.runId, pid: rec.pid, verdict });
      log(`[harness-sweep] ${f}: not reaped (${verdict}) — record kept for the next sweep, nothing signalled`);
      continue;
    }
    log(`[harness-sweep] ${f}: not reaped (${verdict}) — pidfile removed, nothing signalled`);
    removeFile(full);
    out.skipped.push({ runId: rec && rec.runId, pid: rec && rec.pid, verdict });
  }
  return out;
}

module.exports = {
  MARKER_ARG_PREFIX, ENV_MARKER_PREFIX, TERM_GRACE_MS,
  pidsDir, harnessRunId, markerArgFor, pidFileOf,
  pidLstart, pidPgid, pidCommand, pidEnvBlob, pidAlive,
  recordRun, removeRun, armParentWatchdog, sweep,
  // test surface: plant/verify records exactly the way the app does
  atomicWriteJson, judgeRun, killRecorded, ownAncestors,
};
