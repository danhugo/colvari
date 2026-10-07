// Stall watchdog (extracted from orchestrator.js): detects runs that stopped making progress and
// stops them so the orchestrator can recover. Everything here is deliberately side-table based —
// the functions take the orchestrator instance as `orch` and read its live state (procs, agents,
// running, userStopped), so the orchestrator keeps owning lifecycle while this module owns the
// stall policy and liveness heuristics.

// 'ps -o time=' CPU time, e.g. '12:05.44' (MM:SS.cc) or '1:02:03' (H:MM:SS) -> ms.
// Linux reports day-scale CPU as '2-03:12:45' (DD-HH:MM:SS): without parsing the day
// segment, Number('2-03') is NaN and every runAlive() cpuMs comparison is false — the
// CPU-liveness check silently dies and a CPU-busy run reads as stalled.
function stimeToMs(s) {
  const seg = String(s || '').trim().split(':');
  if (!seg[seg.length - 1]) return null;
  let days = 0;
  const dm = /^(\d+)-/.exec(seg[0]);
  if (dm) { days = Number(dm[1]); seg[0] = seg[0].slice(dm[0].length); }
  const last = seg.pop().split('.');
  const secs = Number(last[0]) + Number('0.' + (last[1] || '0'));
  const mins = Number(seg.pop() || 0), hrs = Number(seg.pop() || 0);
  return Math.round((((days * 24 + hrs) * 60 + mins) * 60 + secs) * 1000);
}

// The run's board MCP server is a long-lived stdio helper the CLI spawns for the whole session
// (mcpConfig: <exec> src/mcp-server.js --project <dir> --node <id>). It idles between calls, so its
// being alive says nothing about run progress — leave its whole subtree out of the stall liveness
// scan, or a hung CLI that owns one is never recovered.
const isBoardHelper = (r) => !!r.command && /mcp-server\.js/.test(r.command) && r.command.includes('--project') && r.command.includes('--node');

// Stall watchdog: how often a working agent is checked for silence, how long a SIGTERM'd stalled run
// gets to exit before SIGKILL, and the max automatic stop+resume recoveries per task (persisted there).
// HARD_CAP_MULT: silence for MULT x stallTimeoutMin kills the run even when runAlive() sees live
// descendants — a runtime's own long-lived helpers (helpycode MCP servers) used to pin liveness
// true forever (t_1f75efd8: a wake run hung 3h11m).
// LIVE_RECHECK_MS: how long a run stays trusted-alive after one liveness probe — a silent run kept
// alive by descendants (hung runtime with helpers) used to re-fork the blocking `ps` on every 5s
// sweep forever. Verdicts are minutes-granular, so one probe per window is plenty; a probe is never
// debounced past the hard cap, where the verdict decides a kill.
// Shared with orchestrator.js by reference (tests shorten the timings in place).
const STALL = { SWEEP_MS: 5000, SIGKILL_GRACE_MS: 8000, MAX_RECOVERIES: 2, HARD_CAP_MULT: 3, LIVE_RECHECK_MS: 30000 };

// Short 'continue' prompt for a stalled run resumed in the same session (the session already holds
// the full task context; this only tells the agent the previous attempt was stopped and why).
function stallPrompt(task) {
  return `Your previous run for this task (id=${task.id}) stalled (no activity for the configured stall timeout) and was stopped automatically. Continue the task from where you left off and finish it as originally instructed.`;
}

// [{pid, ppid, state, cpuMs, command}] for every process, or null when ps is unavailable.
// Async (t_5a78aa95): the old execFileSync forked a full `ps -ax` ON the Electron main process
// every stall sweep (every 5s with silent runs) — now awaited on the event loop.
async function procTable() {
  const CP = require('./cp');
  try {
    const r = await CP.run('ps', ['-axo', 'pid=,ppid=,state=,time=,command='], { timeoutMs: 4000 });
    const out = String(r.stdout || '');
    return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
      .map((p) => ({ pid: Number(p[0]), ppid: Number(p[1]), state: p[2], cpuMs: stimeToMs(p[3]), command: p.slice(4).join(' ') }));
  } catch { return null; }
}

// Live (non-zombie) descendants of rootPid, board MCP helper subtree excluded (isBoardHelper):
// the single scan both liveness verdicts and the hard-cap log read, so the two can never drift
// (a descendant counted for recovery is by construction the same one a kill would report).
// Primary ps state is the first char; flags follow ('ZN' = defunct+nice). A stopped CLI cannot
// reap its exited children, so defunct descendants pile up — they are not liveness.
function liveDescendants(rows, rootPid) {
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const out = []; const queue = [rootPid]; const seen = new Set(queue);
  while (queue.length) {
    for (const r of kids.get(queue.pop()) || []) {
      if (seen.has(r.pid) || isBoardHelper(r)) continue; // skipped node's subtree stays unreachable
      seen.add(r.pid); queue.push(r.pid);
      if (r.state[0] !== 'Z') out.push(r);
    }
  }
  return out;
}

// Liveness beyond emitted events: a live (non-zombie) descendant of the run's CLI process counts as
// alive — a long silent tool call (build, sleep, network) keeps a grandchild process running even
// though no events stream. So does the CLI's own CPU time advancing between sweeps. Unknowable
// (ps unavailable, slot placeholder without a pid) counts as alive: never stall on a hunch. The
// board MCP helper subtree is excluded (isBoardHelper): it idles for the whole session and would
// otherwise keep a hung CLI "alive" forever.
// snapshot: optional shared proc table — the sweep passes one so a pass with N silent runs forks
// ps once, not N times (all reads within a sweep are the same instant anyway).
async function runAlive(orch, nodeId, child, snapshot) {
  if (!child || !child.pid) return true;
  if (child.exitCode != null) return false; // already exited; the close event just hasn't fired
  const rows = snapshot === undefined ? await orch.procTable() : snapshot;
  if (!rows) return true;
  const me = rows.find((r) => r.pid === child.pid);
  const prev = orch._stallCpu.get(nodeId);
  orch._stallCpu.set(nodeId, { pid: child.pid, cpuMs: me ? me.cpuMs : null });
  if (me && prev && prev.pid === child.pid && prev.cpuMs != null && me.cpuMs > prev.cpuMs) return true;
  return liveDescendants(rows, child.pid).length > 0;
}

// Live (non-zombie) descendants of the run's CLI, for the hard-cap log: they show what kept a
// silent run "alive" (board MCP helpers excluded, same scan as runAlive).
async function stallLiveKids(orch, child, snapshot) {
  const rows = snapshot === undefined ? await orch.procTable() : snapshot;
  if (!rows || !child || !child.pid) return [];
  return liveDescendants(rows, child.pid).map((r) => ({ pid: r.pid, command: r.command }));
}

// A run that has emitted nothing AND has no live child/descendant process for stallTimeoutMin
// (setting, default 10) is stalled. Task runs are stopped and resumed in the same session
// (runTask's r.stalled branch) with a short continue prompt, max 2 recoveries per task.
// EVERY run kind is watched (t_600e630d): task runs and every no-task run (wake, loop, watchdog)
// of every runtime — a hung run must never hold the agent's single-run slot. No-task runs are only
// stopped: the sweep re-delivers what still matters. Hard cap: silence for HARD_CAP_MULT x the
// timeout kills any run even with live descendants (runtimes whose own helpers pin runAlive()
// forever). Manual interrupts (stopAgent, a queued human message) always take precedence.
// Overlap debounce (seed 488): the 5s sweep interval fires regardless of the last pass — a sweep
// still awaiting its proc table (ps up to its 4s timeout on a loaded main loop) must not race the
// next tick into a second concurrent fork and duplicate probes. The busy pass owns the sweep; a
// later tick is dropped, not queued — the pass after that re-reads live state anyway.
async function sweepStalls(orch) {
  if (orch._stallSweepBusy) return;
  orch._stallSweepBusy = true;
  try { return await sweepStallsPass(orch); } finally { orch._stallSweepBusy = false; }
}

async function sweepStallsPass(orch) {
  if (orch.userStopped) return;
  // Task-run recovery is the Run's business (it re-dispatches through runTask), but a no-task run
  // can be live with the Run over (dispatchWake does not require it) — those still get watched.
  let runOver = false;
  if (!orch.running) {
    runOver = true;
    let hasNoTaskRun = false;
    for (const [nodeId] of orch.procs) {
      const a = orch.agents[nodeId];
      if (a && a.status === 'working' && !a.taskId) hasNoTaskRun = true;
    }
    if (!hasNoTaskRun) return;
  }
  const timeoutMin = Number(orch.store.getSettings().stallTimeoutMin ?? 10);
  if (!(timeoutMin > 0)) return;
  const now = Date.now();
  const hardCapMs = timeoutMin * STALL.HARD_CAP_MULT * 60000;
  // One shared proc table per sweep, forked lazily on the first liveness check: a sweep that must
  // judge N silent runs reads a single snapshot instead of forking ps per run. null (ps
  // unavailable) stays falsy, so a failed fork is retried on the next run rather than pinned for
  // the pass.
  let rows;
  const table = async () => rows || (rows = await orch.procTable());
  for (const [nodeId, child] of [...orch.procs]) {
    const a = orch.agents[nodeId];
    const run = a && a.currentRun;
    try {
      if (!a || a.status !== 'working' || !run || run.done || run.stalled) continue;
      // Every run kind: task runs (a.taskId) and every no-task run — the activity trigger no longer
      // gates the sweep (t_600e630d: no-task runs without a 'message' trigger were skipped).
      const isWake = !a.taskId;
      if (runOver && !isWake) continue;
      if (a.stopRequested || a.pendingHuman.length) continue;
      const idleMs = now - (a.lastActivityAt || 0);
      if (idleMs < timeoutMin * 60000) continue;
      // A live descendant (long silent tool call) protects the run — up to the hard cap, where
      // silence wins: the cap is what recovers runs whose runtime keeps helpers alive forever.
      // Debounce the probe (runAlive forks `ps`): a run verified alive stays trusted-alive for
      // LIVE_RECHECK_MS — only cap-eligible runs probe on every sweep, because there the verdict
      // decides the kill and must read fresh data.
      const cappedIdle = idleMs >= hardCapMs;
      const probed = orch._stallProbe || (orch._stallProbe = new Map());
      if (!cappedIdle && now - (probed.get(nodeId) || 0) < STALL.LIVE_RECHECK_MS) continue;
      const alive = await orch.runAlive(nodeId, child, await table());
      probed.set(nodeId, now);
      const capped = alive && cappedIdle;
      if (alive && !capped) continue;
      // One-way claim on the run object: whichever sweep flips .stalled owns the recovery, so a tick
      // racing a manual stop or a queued message can never double-fire (compare-and-set on the run).
      run.stalled = true;
      probed.delete(nodeId);
      a.stall = { state: 'stalled' };
      const idleMin = Math.round(idleMs / 60000);
      // Reporting is guarded: the sweep that made the claim owes the kill — a crashing log/emit must
      // never strand a claimed run (later sweeps skip it, and without the TERM there is no close, so
      // no recovery would ever fire).
      try {
        const kids = capped ? await stallLiveKids(orch, child, await table()) : null;
        orch.log(nodeId, 'error', capped
          ? `stall: no output for ${idleMin} min (${STALL.HARD_CAP_MULT}x the ${timeoutMin} min timeout) — killing despite live child processes: ${kids.length ? kids.slice(0, 3).map((k) => `pid ${k.pid} ${String(k.command).slice(0, 80)}`).join('; ') + (kids.length > 3 ? `; +${kids.length - 3} more` : '') : 'none found'}`
          : isWake
            ? `stall: wake run silent with no live child process for ${idleMin} min; stopping it (messages still pending re-wake the agent)`
            : `stall: no events and no live child process for ${idleMin} min; stopping the run to recover`);
        orch.emit('run.stalled', { nodeId, taskId: a.taskId || null, idleMin, kind: isWake ? 'wake' : 'task' });
      } catch {}
      try { child.kill('SIGTERM'); } catch {}
      orch._stallKill.set(nodeId, setTimeout(() => {
        orch._stallKill.delete(nodeId);
        if (orch.procs.get(nodeId) === child && a.currentRun === run && !run.done) {
          try { child.kill('SIGKILL'); } catch {}
          orch.log(nodeId, 'error', 'stall: run ignored SIGTERM; sent SIGKILL');
        }
      }, STALL.SIGKILL_GRACE_MS));
      try { orch.changed(); } catch {}
    } catch (e) {
      // One agent's unreadable state must not blind the sweep for the rest of the board (pre-claim
      // failures only: post-claim reporting is guarded above so the kill always happens).
      try { orch.log(nodeId, 'error', 'stall sweep: ' + (e && e.message || e)); } catch {}
    }
  }
}

module.exports = { STALL, stallPrompt, stimeToMs, isBoardHelper, procTable, runAlive, stallLiveKids, liveDescendants, sweepStalls };

// A run that got through (exit 0, no stall claim) is real progress: the per-task recovery counter
// resets (persisted on the task, so it survives app restarts — otherwise a restart would re-arm the
// recovery budget). A code 0 under an active stall claim is NOT progress — the watchdog killed a
// run whose CLI trapped TERM and exited 0; resetting there would disarm the max-recoveries limit.
// Migrated from runTask: the recovery-budget policy belongs with STALL.MAX_RECOVERIES, which reads it.
function resetRecoveries(orch, taskId) {
  const tp = orch.store.getTask(taskId);
  if (tp && tp.stallRecoveries) orch.store.updateTaskSoon(taskId, { stallRecoveries: 0 });
}

module.exports.resetRecoveries = resetRecoveries;
