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

// A stopped or paused project drops its wake timers: nothing armed may outlive the pause.
function clearWakeTimers(orch) {
  for (const t of orch.wakeTimers.values()) clearTimeout(t.timer);
  orch.wakeTimers.clear();
}

// Debounce: a burst of messages coalesces into the one dispatch this timer fires. At most one
// pending wake per agent: the wakeTimers entry IS the dedupe key.
function armWakeTimer(orch, nodeId, st, now) {
  if (orch.wakeTimers.has(nodeId)) return;
  st.armed++;
  const dueAt = now + WAKE.DEBOUNCE_MS;
  orch.wakeTimers.set(nodeId, { dueAt, timer: setTimeout(() => {
    orch.wakeTimers.delete(nodeId);
    orch.dispatchWake(nodeId).catch((e) => orch.log(nodeId, 'error', 'wake dispatch: ' + e.message));
  }, WAKE.DEBOUNCE_MS) });
}

// One idle agent's slice of the sweep: refresh its unread count (clearing a stale wakePending when
// the inbox drained) and arm its debounce dispatch. Returns whether the agent had unread messages.
function sweepAgent(orch, node, a, team, st, now, mkey) {
  const unread = orch.wakeUnread(node.id, team, mkey);
  if (!unread.length) {
    if (a.wakePending) { a.wakePending = null; orch.changed(); }
    return false;
  }
  // Per-agent wake debounce: while an agent runs (task or wake), messages stay queued unread —
  // never a parallel run. Once idle, unread teammate and human messages wake the agent on every
  // sweep, burst-coalesced by the debounce timer: message wakes are never suppressed
  // (t_9e4b4805 — the old MIN_GAP_MS window delayed teammate messages while the agent sat idle;
  // the pair cap in dispatchWake is the ping-pong guard, and human senders are exempt from it).
  // Task dispatch is NOT debounced either (an assigned/unblocked task reaches the agent right
  // away and its prompt carries the unread count); system wakes never enter this sweep.
  const prev = a.wakePending;
  if (!prev || prev.count !== unread.length) {
    // nextWakeAt is the armed timer's due time; recomputed only on a transition so an unchanged
    // pending state does not churn a state push every sweep.
    a.wakePending = { count: unread.length, suppressed: false, nextWakeAt: (prev && prev.nextWakeAt) || now + WAKE.DEBOUNCE_MS };
    orch.changed();
  }
  armWakeTimer(orch, node.id, st, now);
  return true;
}

function sweepWakes(orch) {
  if (orch.userStopped || orch.dispatchPaused) { clearWakeTimers(orch); return; }
  const st = orch._wakeStats || (orch._wakeStats = { sweeps: 0, totalMs: 0, maxMs: 0, armed: 0 });
  const sweepStart = Date.now();
  let scanned = 0, withUnread = 0;
  try {
    const team = orch.store.getTeam();
    const now = Date.now();
    const mkey = unreadKey(orch);
    for (const node of team.nodes) {
      const a = orch.agent(node.id);
      if (orch.procs.has(node.id) || a.status === 'working') continue;
      scanned++;
      // One broken agent state (or a throwing wakeUnread seam) must not blind the rest of the
      // roster: the failure is logged against its node and the sweep moves on.
      try {
        if (sweepAgent(orch, node, a, team, st, now, mkey)) withUnread++;
      } catch (e) { orch.log(node.id, 'error', 'wake sweep: ' + node.id + ': ' + e.message); }
    }
  } catch (e) { orch.log(null, 'error', 'wake sweep: ' + e.message); }
  const sweepMs = Date.now() - sweepStart;
  st.sweeps++; st.totalMs += sweepMs; st.maxMs = Math.max(st.maxMs, sweepMs);
  if (sweepMs > WAKE.SLOW_SWEEP_MS) orch.log(null, 'system', `wake sweep: checked ${scanned} idle agent(s), ${withUnread} with unread, ${st.armed} wake(s) armed total, in ${sweepMs}ms (max ${st.maxMs}ms)`);
}

// The sweep runs every SWEEP_MS and each idle agent's wakeUnread scans the whole messages file
// (listMessages({to}) filters it) with an O(nodes) sender-scope check per message — O(messages ×
// agents) per sweep on a grown board. The unread map is a pure function of the messages file and
// the team roster, so build it in one pass and reuse it while the store's stat signatures for both
// are unchanged — the same size:mtime contract as the store's own caches: our writes change the
// file and bust it, so does an out-of-band edit. Memo lives on the orchestrator instance (tests
// create one per case; stubbed wakeUnread never reaches this path). The key is rebuilt once per
// sweep (unreadKey) and passed down — it costs two statSyncs plus a project.json parse, cheap at
// 1 Hz but not once per idle agent.
function unreadKey(orch) { return orch.store.sigFile('messages') + '|' + orch.store.teamsSig(); }
function unreadMap(orch, team, key) {
  key = key || unreadKey(orch);
  const memo = orch._wakeUnreadMemo;
  if (memo && memo.key === key) return memo.byNode;
  const byNode = new Map();
  const known = new Set(team.nodes.map((n) => n.id));
  for (const m of orch.store.listMessages()) {
    if (!m || typeof m !== 'object') continue; // corrupt entry: dropped — the memo only commits on a clean pass, so a throwing build would fail every sweep forever
    if (m.read || m.from === m.to) continue;
    if (m.from === 'system' ? !m.wake : !(m.from === 'human' || known.has(m.from))) continue;
    let arr = byNode.get(m.to);
    if (arr) arr.push(m); else byNode.set(m.to, [m]);
  }
  orch._wakeUnreadMemo = { key, byNode };
  return byNode;
}

// Unread messages for a node from teammates or the human operator (system senders have their own
// delivery paths and never wake anyone — except the queued status-check nudge, whose wake flag
// opts exactly that one message kind into waking an idle agent, like the human message it replaced).
// Returns a copy: the cached arrays are shared, callers must not mutate them.
function wakeUnread(orch, nodeId, team = orch.store.getTeam(), key) {
  return (unreadMap(orch, team, key).get(nodeId) || []).slice();
}

module.exports = { WAKE, sweepWakes, wakeUnread };
