#!/usr/bin/env node
'use strict';
// Die-with-the-app watchdog (t_2ca99830). The 2026-10-01 01:47 silent death orphaned four agent
// runs for minutes: SIGKILL on the app never reaches the detached run groups, and the t_3f830e64
// pidfiles only help the NEXT boot. The orchestrator spawns one of these per run (detached, so it
// survives the app like the orphans do) and it watches the app's pid three ways — its own ppid
// (reparented to 1 when the app dies), signal-0 liveness, and lstart (a recycled pid must never
// pass) — and TERMs then KILLs the run's process group within seconds of the app vanishing.
// It self-exits once the run group is gone (normal end of run) or after a day, so a lost explicit
// kill can never leak one. Killing is only ever by the recorded group pid — never by name.

const CP = require('./cp');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const APP_PID = Number(arg('app-pid', process.ppid));
const APP_LSTART = String(arg('app-lstart', ''));
const GROUP_PID = Number(arg('group-pid', 0));
const INTERVAL_MS = Math.max(250, Number(arg('interval-ms', 2000)));
const TERM_GRACE_MS = 1500;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Async ps read (t_5a78aa95, consistency with the app-side probes): this script is its own
// process, so the old spawnSync only ever blocked itself — the async read is equivalent and
// keeps every probe on one code path.
const pidLstart = async (pid) => { const r = await CP.run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5000 }); return String(r.stdout || '').trim(); };

let reaped = false;
function reapGroup() {
  if (reaped) return;
  reaped = true;
  try { process.kill(-GROUP_PID, 'SIGTERM'); } catch {}
  const t = setTimeout(() => { // TERM-resistant orphan: escalate, then exit
    try { process.kill(-GROUP_PID, 'SIGKILL'); } catch {}
    process.exit(0);
  }, TERM_GRACE_MS);
  if (t.unref) t.unref();
}

const t0 = Date.now();
let ticking = false; // a starved ps must not overlap the next interval's tick
const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    if (GROUP_PID > 1 && !groupAlive(GROUP_PID)) process.exit(0); // run ended; nothing left to guard
    if (process.ppid === 1) return reapGroup(); // reparented: the app (our spawner) is gone
    if (APP_PID > 1 && !pidAlive(APP_PID)) return reapGroup();
    if (APP_PID > 1 && APP_LSTART && pidAlive(APP_PID) && (await pidLstart(APP_PID)) !== APP_LSTART) return reapGroup(); // pid recycled
    if (Date.now() - t0 > MAX_LIFETIME_MS) process.exit(0);
  } finally { ticking = false; }
};
setInterval(tick, INTERVAL_MS);
tick();
