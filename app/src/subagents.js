// Subagent visibility helpers (pure, shared by the renderer and tests), built against the event
// contract from t_c33656ba: subagent records {id, agentId, parentToolUseId, parentAgentId, depth,
// type, toolName, description, startedAt, endedAt, status, tokens} with parentAgentId pointing at
// the owning node (depth 0) or another subagent record (nested), and log rows carrying
// subagentId on child events. Records may be missing entirely — every helper degrades gracefully.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Subagents = factory(); })(this, function () {
  // Walk up the parentAgentId chain to this subagent's depth-0 ancestor (itself when unknown).
  // The depth-0 sentinel is the record's own agentId (logs mix agents, so a fixed nodeId is not enough).
  function rootOf(sid, recOf, nodeId, guard = 20) {
    let cur = sid;
    while (guard-- > 0) {
      const r = recOf(cur);
      if (!r || !r.parentAgentId || r.parentAgentId === (r.agentId || nodeId)) return cur;
      cur = r.parentAgentId;
    }
    return cur;
  }
  // Nearest child block of B that owns sid's rows (sid itself, or the ancestor whose parent is B).
  function innerRootOf(sid, recOf, B, guard = 20) {
    let cur = sid;
    while (guard-- > 0) {
      if (cur === B) return null; // a direct row of B, not a nested block
      const r = recOf(cur);
      if (!r) return sid; // unknown record: render as its own (minimal) block
      if (!r.parentAgentId) return null;
      if (r.parentAgentId === B || r.parentAgentId === (r.agentId || B)) return cur;
      cur = r.parentAgentId;
    }
    return null;
  }
  // Group a flat, time-ordered list (log rows or thread items; anything with .subagentId) into
  // a tree: [{kind:'row', l}, {kind:'sub', rec, rows:[...]}]. Children are matched through the
  // records (parentAgentId), never arrival order, so interleaved parallel subagents stay intact.
  // The block lands at the position of its first child event.
  function nestRows(rows, recOf, nodeId, B = null) {
    const buckets = new Map();
    const bucket = (k, l) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(l); };
    for (const l of rows) {
      const sid = l && l.subagentId; if (!sid) continue;
      if (B) { if (sid === B) continue; const k = innerRootOf(sid, recOf, B); if (k) bucket(k, l); }
      else bucket(rootOf(sid, recOf, nodeId), l);
    }
    const out = []; const emitted = new Set();
    for (const l of rows) {
      const sid = l && l.subagentId;
      if (!sid) { out.push({ kind: 'row', l }); continue; }
      const k = B ? (sid === B ? null : innerRootOf(sid, recOf, B)) : rootOf(sid, recOf, nodeId);
      if (k && buckets.has(k)) {
        if (!emitted.has(k)) { emitted.add(k); out.push({ kind: 'sub', rec: recOf(k) || { id: k }, rows: nestRows(buckets.get(k), recOf, nodeId, k) }); }
        continue;
      }
      out.push({ kind: 'row', l });
    }
    return out;
  }
  // Elapsed time of a record: endedAt-startedAt, or live while running (now defaults to Date.now()).
  function durationMs(rec, now = Date.now()) {
    if (!rec || !rec.startedAt) return null;
    const end = rec.endedAt != null ? rec.endedAt : (rec.status === 'running' ? now : null);
    if (end == null) return null;
    return Math.max(0, end - rec.startedAt);
  }
  // 'n/a' when the CLI reports no per-subagent usage (tokens === null), never 0 (contract rule: never add these to parent totals).
  function tokensLabel(tokens) {
    if (!tokens || (tokens.inputTokens == null && tokens.outputTokens == null)) return 'n/a';
    return `${fmtK(tokens.inputTokens)} / ${fmtK(tokens.outputTokens)} tok`;
  }
  const fmtK = (n) => n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : String(n);
  const fmtDuration = (ms) => ms == null ? '' : ms < 10000 ? (ms / 1000).toFixed(1) + 's' : ms < 60000 ? Math.round(ms / 1000) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  // Per-agent badge numbers from a node's agent state (S.orch.agents[id]): count + in/out totals.
  function badge(a) {
    const recs = (a && a.subagents) || [];
    const count = typeof a.subagentCount === 'number' ? a.subagentCount : recs.length;
    const t = a.subagentTokens || null;
    return { count, tokens: t, label: count ? `🤖 ${count}` : '' };
  }
  return { rootOf, innerRootOf, nestRows, durationMs, tokensLabel, fmtDuration, badge };
});
