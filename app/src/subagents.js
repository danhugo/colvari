// Subagent visibility, one module for two consumers (t_ac65b690):
//  * Node (orchestrator/runtimes/timeline + tests): SubagentTracker + isSubagentTool/subagentId —
//    one record per subagent a run spawns, matched by the CLI's own tool-use id, never arrival
//    order (parallel Task calls interleave their children in the stream).
//  * Browser (renderer/app.js, loaded as a plain script by index.html): pure display helpers on
//    the global `Subagents` — nesting, labels, badge numbers — built against the record contract
//    {id, agentId, parentToolUseId, parentAgentId, depth, type, toolName, description, startedAt,
//    endedAt, status, tokens} with parentAgentId pointing at the owning node (depth 0) or another
//    record (nested), and log rows carrying subagentId on child events. Records may be missing
//    entirely — every helper degrades gracefully.
// Tokens on a record are a BREAKDOWN of the parent run's totals (claude's result modelUsage already
// includes sub-agent usage) — never an addition to them. A CLI that reports no per-subagent usage
// (e.g. opencode-derived ones: the task tool only surfaces "<task id=… state=…>") leaves tokens null;
// the UI shows n/a, not 0.

(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Subagents = factory(); })(this, function () {

  // ---- tracking (backend) ----

  // Tool names that spawn subagents: claude Task/Agent, opencode-derived task/agent.
  const isSubagentTool = (name) => /^(task|agent)$/i.test(String(name || ''));

  const subagentId = (toolUseId) => 'sa_' + String(toolUseId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

  class SubagentTracker {
    constructor(agentId, now = Date.now) {
      this.agentId = agentId;
      this.now = now;
      this.records = []; // ordered by start
      this.byTool = new Map(); // CLI tool-use id -> record
    }
    record(toolUseId) { return this.byTool.get(String(toolUseId)) || null; }
    // Tag for a child event carrying parent_tool_use_id. An unknown parent id (the Task tool_use event
    // never streamed, e.g. across a resume) gets a placeholder so its children still group under one id.
    tagFor(parentToolUseId) {
      if (parentToolUseId == null || parentToolUseId === '') return null;
      return this.record(parentToolUseId) || this.start({ toolUseId: parentToolUseId, toolName: 'Task', placeholder: true });
    }
    start({ toolUseId, parentToolUseId = null, toolName = 'Task', description = '', prompt = '', startedAt, childSessionId, placeholder = false }) {
      toolUseId = String(toolUseId);
      let rec = this.byTool.get(toolUseId);
      if (rec) return rec; // streams re-emit the same tool part per state change: one record only
      const parent = parentToolUseId != null && parentToolUseId !== '' ? this.byTool.get(String(parentToolUseId)) : null;
      rec = {
        id: subagentId(toolUseId),
        agentId: this.agentId,
        parentToolUseId: parentToolUseId || undefined,
        // Nesting: subagents can spawn subagents, so this may point at another record, not the node.
        parentAgentId: parent ? parent.id : this.agentId,
        depth: parent ? parent.depth + 1 : 0,
        type: String(toolName || 'task').toLowerCase(),
        toolName: toolName || 'Task',
        description: String(description || prompt || '').slice(0, 200) || (placeholder ? '(unknown subagent)' : ''),
        prompt: String(prompt || '').slice(0, 300) || undefined,
        childSessionId: childSessionId || undefined,
        startedAt: startedAt || this.now(),
        endedAt: null,
        status: 'running',
        tokens: null, // null = CLI reports no per-subagent usage -> n/a, never 0
        placeholder: placeholder || undefined,
      };
      this.byTool.set(toolUseId, rec);
      this.records.push(rec);
      return rec;
    }
    end(toolUseId, { status = 'completed', endedAt } = {}) {
      const rec = this.byTool.get(String(toolUseId));
      if (!rec || rec.status !== 'running') return rec; // already ended: first result wins
      rec.status = status;
      rec.endedAt = endedAt || this.now();
      return rec;
    }
    // dedupeKey (e.g. the message id): claude stream-json emits one assistant event per content block
    // of the same message, all carrying that message's usage — only the first sighting counts.
    addTokens(toolUseId, tokens = {}, dedupeKey = null) {
      const rec = this.byTool.get(String(toolUseId));
      if (!rec) return;
      if (dedupeKey != null) {
        this._usageSeen ||= new Set();
        const k = rec.id + '|' + dedupeKey;
        if (this._usageSeen.has(k)) return;
        this._usageSeen.add(k);
      }
      rec.tokens ||= { inputTokens: 0, outputTokens: 0 };
      rec.tokens.inputTokens += Number(tokens.inputTokens) || 0;
      rec.tokens.outputTokens += Number(tokens.outputTokens) || 0;
    }
    // Parent run ended: anything still 'running' can never finish -> aborted, never a zombie.
    close(endedAt) {
      const aborted = [];
      for (const rec of this.records) if (rec.status === 'running') { rec.status = 'aborted'; rec.endedAt = endedAt || this.now(); aborted.push(rec); }
      return aborted;
    }
    // Copies for snapshot/persistence (no live references).
    snapshot() { return this.records.map((r) => ({ ...r, tokens: r.tokens ? { ...r.tokens } : null })); }
    totals() {
      return this.records.reduce((t, r) => (r.tokens
        ? { inputTokens: t.inputTokens + r.tokens.inputTokens, outputTokens: t.outputTokens + r.tokens.outputTokens }
        : t), { inputTokens: 0, outputTokens: 0 });
    }
  }

  // ---- display helpers (renderer) ----

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

  return { SubagentTracker, isSubagentTool, subagentId, rootOf, innerRootOf, nestRows, durationMs, tokensLabel, fmtDuration, badge };
});
