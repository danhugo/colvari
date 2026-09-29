// Subagent (Task/Agent tool) tracking: one record per subagent a run spawns, matched by the CLI's
// own tool-use id — never by arrival order (parallel Task calls interleave their children in the
// stream). Shared by the orchestrator's inline claude parser and the profile parser in runtimes.js,
// which both reduce stream events to the {toolUseId, phase, ...} signals applied here.
//
// Tokens on a record are a BREAKDOWN of the parent run's totals (claude's result modelUsage already
// includes sub-agent usage) — never an addition to them. A CLI that reports no per-subagent usage
// (e.g. opencode-derived ones: the task tool only surfaces "<task id=… state=…>") leaves tokens null;
// the UI shows n/a, not 0.

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

module.exports = { SubagentTracker, isSubagentTool, subagentId };
