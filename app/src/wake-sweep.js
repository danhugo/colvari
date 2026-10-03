// Wake on message (extracted from orchestrator.js): an idle agent that receives a send_message is
// dispatched with its unread messages as the prompt. The sender's send_message has already returned
// (it only writes to the store); delivery happens in the background, debounced and loop-capped.
// Everything here is deliberately side-table based — the functions take the orchestrator instance
// as `orch` and read its live state (wakeTimers, wakePairs, procs, agents, userStopped), so the
// orchestrator keeps owning lifecycle and dispatch (dispatchWake/wakeRun) while this module owns
// the sweep and the unread filter. Tests stub wakeUnread/sweepWakes on instances, so the
// orchestrator keeps delegation seams on the prototype and the sweep reads through `orch.*`.

// The sender's send_message has already returned, so a burst coalesces: an idle agent is woken on
// every SWEEP_MS sweep but the per-agent DEBOUNCE_MS timer fires at most one dispatch, and the
// ping-pong guard (max auto-wakes per sender->recipient pair per window) sits in dispatchWake.
// MIN_GAP_MS no longer gates message wakes (t_9e4b4805) — it only anchors the watchdog nudge
// throttle in nudgeIdle. Shared with orchestrator.js by reference (tests shorten the timings
// in place, orchestrator re-exports this same object).
const WAKE = { SWEEP_MS: 1000, DEBOUNCE_MS: 1500, MIN_GAP_MS: 5 * 60 * 1000, MAX_PER_PAIR: 3, PAIR_WINDOW_MS: 10 * 60 * 1000, SLOW_SWEEP_MS: 25 };
// SLOW_SWEEP_MS: the sweep runs at 1 Hz on the main event loop and listMessages() re-reads the
// inbox per idle agent (orch.wakeUnread), so a sweep over this duration is a UI jank signal
// worth logging — the same instrumentation the stall watchdog carries for its own sweep.

function sweepWakes(orch) {
  if (orch.userStopped || orch.dispatchPaused) { for (const t of orch.wakeTimers.values()) clearTimeout(t.timer); orch.wakeTimers.clear(); return; }
  const st = orch._wakeStats || (orch._wakeStats = { sweeps: 0, totalMs: 0, maxMs: 0, armed: 0 });
  const sweepStart = Date.now();
  let scanned = 0, withUnread = 0;
  try {
    const team = orch.store.getTeam();
    const now = Date.now();
    for (const node of team.nodes) {
      const a = orch.agent(node.id);
      if (orch.procs.has(node.id) || a.status === 'working') continue;
      scanned++;
      const unread = orch.wakeUnread(node.id, team);
      if (!unread.length) {
        if (a.wakePending) { a.wakePending = null; orch.changed(); }
        continue;
      }
      // Per-agent wake debounce: while an agent runs (task or wake), messages stay queued unread —
      // never a parallel run. Once idle, unread teammate and human messages wake the agent on every
      // sweep, burst-coalesced by the debounce timer below: message wakes are never suppressed
      // (t_9e4b4805 — the old MIN_GAP_MS window delayed teammate messages while the agent sat idle;
      // the pair cap in dispatchWake is the ping-pong guard, and human senders are exempt from it).
      // Task dispatch is NOT debounced either (an assigned/unblocked task reaches the agent right
      // away and its prompt carries the unread count); system wakes never enter this sweep.
      const prev = a.wakePending;
      withUnread++;
      if (!prev || prev.count !== unread.length) {
        // nextWakeAt is the armed timer's due time; recomputed only on a transition so an unchanged
        // pending state does not churn a state push every sweep.
        a.wakePending = { count: unread.length, suppressed: false, nextWakeAt: (prev && prev.nextWakeAt) || now + WAKE.DEBOUNCE_MS };
        orch.changed();
      }
      // Debounce: a burst of messages coalesces into the one dispatch this timer fires. At most one
      // pending wake per agent: the wakeTimers entry IS the dedupe key.
      if (!orch.wakeTimers.has(node.id)) {
        st.armed++;
        const dueAt = now + WAKE.DEBOUNCE_MS;
        orch.wakeTimers.set(node.id, { dueAt, timer: setTimeout(() => {
          orch.wakeTimers.delete(node.id);
          orch.dispatchWake(node.id).catch((e) => orch.log(node.id, 'error', 'wake dispatch: ' + e.message));
        }, WAKE.DEBOUNCE_MS) });
      }
    }
  } catch (e) { orch.log(null, 'error', 'wake sweep: ' + e.message); }
  const sweepMs = Date.now() - sweepStart;
  st.sweeps++; st.totalMs += sweepMs; st.maxMs = Math.max(st.maxMs, sweepMs);
  if (sweepMs > WAKE.SLOW_SWEEP_MS) orch.log(null, 'system', `wake sweep: checked ${scanned} idle agent(s), ${withUnread} with unread, ${st.armed} wake(s) armed total, in ${sweepMs}ms (max ${st.maxMs}ms)`);
}

// Unread messages for a node from teammates or the human operator (system senders have their own
// delivery paths and never wake anyone — except the queued status-check nudge, whose wake flag
// opts exactly that one message kind into waking an idle agent, like the human message it replaced).
function wakeUnread(orch, nodeId, team = orch.store.getTeam()) {
  return orch.store.listMessages({ to: nodeId })
    .filter((m) => !m.read && m.from !== nodeId && (m.from !== 'system' || m.wake) && (m.from === 'human' || m.from === 'system' || team.nodes.some((n) => n.id === m.from)));
}

module.exports = { WAKE, sweepWakes, wakeUnread };
