// Stall watchdog (extracted from orchestrator.js): detects runs that stopped making progress and
// stops them so the orchestrator can recover. Everything here is deliberately side-table based —
// the functions take the orchestrator instance as `orch` and read its live state (procs, agents,
// running, userStopped), so the orchestrator keeps owning lifecycle while this module owns the
// stall policy and liveness heuristics.

// 'ps -o time=' CPU time, e.g. '12:05.44' (MM:SS.cc) or '1:02:03' (H:MM:SS) -> ms.
function stimeToMs(s) {
  const seg = String(s || '').trim().split(':');
  if (!seg[seg.length - 1]) return null;
  const last = seg.pop().split('.');
  const secs = Number(last[0]) + Number('0.' + (last[1] || '0'));
  const mins = Number(seg.pop() || 0), hrs = Number(seg.pop() || 0);
  return Math.round(((hrs * 60 + mins) * 60 + secs) * 1000);
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
// Shared with orchestrator.js by reference (tests shorten the timings in place).
const STALL = { SWEEP_MS: 5000, SIGKILL_GRACE_MS: 8000, MAX_RECOVERIES: 2, HARD_CAP_MULT: 3 };

// Short 'continue' prompt for a stalled run resumed in the same session (the session already holds
// the full task context; this only tells the agent the previous attempt was stopped and why).
function stallPrompt(task) {
  return `Your previous run for this task (id=${task.id}) stalled (no activity for the configured stall timeout) and was stopped automatically. Continue the task from where you left off and finish it as originally instructed.`;
}

// [{pid, ppid, state, cpuMs, command}] for every process, or null when ps is unavailable.
function procTable() {
  try {
    const out = require('child_process').execFileSync('ps', ['-axo', 'pid=,ppid=,state=,time=,command='], { timeout: 4000 }).toString();
    return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
      .map((p) => ({ pid: Number(p[0]), ppid: Number(p[1]), state: p[2], cpuMs: stimeToMs(p[3]), command: p.slice(4).join(' ') }));
  } catch { return null; }
}

// Liveness beyond emitted events: a live (non-zombie) descendant of the run's CLI process counts as
// alive — a long silent tool call (build, sleep, network) keeps a grandchild process running even
// though no events stream. So does the CLI's own CPU time advancing between sweeps. Unknowable
// (ps unavailable, slot placeholder without a pid) counts as alive: never stall on a hunch. The
// board MCP helper subtree is excluded (isBoardHelper): it idles for the whole session and would
// otherwise keep a hung CLI "alive" forever.
function runAlive(orch, nodeId, child) {
  if (!child || !child.pid) return true;
  if (child.exitCode != null) return false; // already exited; the close event just hasn't fired
  const rows = orch.procTable();
  if (!rows) return true;
  const me = rows.find((r) => r.pid === child.pid);
  const prev = orch._stallCpu.get(nodeId);
  orch._stallCpu.set(nodeId, { pid: child.pid, cpuMs: me ? me.cpuMs : null });
  if (me && prev && prev.pid === child.pid && prev.cpuMs != null && me.cpuMs > prev.cpuMs) return true;
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const queue = [child.pid]; const seen = new Set(queue);
  while (queue.length) {
    for (const r of kids.get(queue.pop()) || []) {
      if (seen.has(r.pid) || isBoardHelper(r)) continue; // skipped node's subtree stays unreachable
      seen.add(r.pid); queue.push(r.pid);
      // Primary ps state is the first char; flags follow ('ZN' = defunct+nice). A stopped CLI cannot
      // reap its exited children, so defunct descendants pile up — they are not liveness.
      if (r.state[0] !== 'Z') return true;
    }
  }
  return false;
}

// Live (non-zombie) descendants of the run's CLI, for the hard-cap log: they show what kept a
// silent run "alive" (board MCP helpers excluded, same scan as runAlive).
function stallLiveKids(orch, child) {
  const rows = orch.procTable();
  if (!rows || !child || !child.pid) return [];
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const out = []; const queue = [child.pid]; const seen = new Set(queue);
  while (queue.length) {
    for (const r of kids.get(queue.pop()) || []) {
      if (seen.has(r.pid) || isBoardHelper(r)) continue;
      seen.add(r.pid); queue.push(r.pid);
      if (r.state[0] !== 'Z') out.push({ pid: r.pid, command: r.command });
    }
  }
  return out;
}

// A run that has emitted nothing AND has no live child/descendant process for stallTimeoutMin
// (setting, default 10) is stalled. Task runs are stopped and resumed in the same session
// (runTask's r.stalled branch) with a short continue prompt, max 2 recoveries per task.
// EVERY run kind is watched (t_600e630d): task runs and every no-task run (wake, loop, watchdog)
// of every runtime — a hung run must never hold the agent's single-run slot. No-task runs are only
// stopped: the sweep re-delivers what still matters. Hard cap: silence for HARD_CAP_MULT x the
// timeout kills any run even with live descendants (runtimes whose own helpers pin runAlive()
// forever). Manual interrupts (stopAgent, a queued human message) always take precedence.
function sweepStalls(orch) {
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
  for (const [nodeId, child] of [...orch.procs]) {
    const a = orch.agents[nodeId];
    const run = a && a.currentRun;
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
    const alive = orch.runAlive(nodeId, child);
    const capped = alive && idleMs >= hardCapMs;
    if (alive && !capped) continue;
    // One-way claim on the run object: whichever sweep flips .stalled owns the recovery, so a tick
    // racing a manual stop or a queued message can never double-fire (compare-and-set on the run).
    run.stalled = true;
    a.stall = { state: 'stalled' };
    const idleMin = Math.round(idleMs / 60000);
    const kids = capped ? orch.stallLiveKids(child) : null;
    orch.log(nodeId, 'error', capped
      ? `stall: no output for ${idleMin} min (${STALL.HARD_CAP_MULT}x the ${timeoutMin} min timeout) — killing despite live child processes: ${kids.length ? kids.slice(0, 3).map((k) => `pid ${k.pid} ${String(k.command).slice(0, 80)}`).join('; ') + (kids.length > 3 ? `; +${kids.length - 3} more` : '') : 'none found'}`
      : isWake
        ? `stall: wake run silent with no live child process for ${idleMin} min; stopping it (messages still pending re-wake the agent)`
        : `stall: no events and no live child process for ${idleMin} min; stopping the run to recover`);
    orch.emit('run.stalled', { nodeId, taskId: a.taskId || null, idleMin, kind: isWake ? 'wake' : 'task' });
    try { child.kill('SIGTERM'); } catch {}
    orch._stallKill.set(nodeId, setTimeout(() => {
      orch._stallKill.delete(nodeId);
      if (orch.procs.get(nodeId) === child && a.currentRun === run && !run.done) {
        try { child.kill('SIGKILL'); } catch {}
        orch.log(nodeId, 'error', 'stall: run ignored SIGTERM; sent SIGKILL');
      }
    }, STALL.SIGKILL_GRACE_MS));
    orch.changed();
  }
}

module.exports = { STALL, stallPrompt, stimeToMs, isBoardHelper, procTable, runAlive, stallLiveKids, sweepStalls };
