// Run controls (pure functions, shared by store, board tools, orchestrator and tests):
//   - task dependencies (blockedBy)
//   - budget caps per agent and per project Run (reported $ and measured tokens)
//   - human approval gate (done -> review + awaitingApproval until a human approves)
//   - persisted per-project log lines

// ---- dependencies ----
const depIds = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean))];
// Ids of unfinished tasks this task waits for. Unknown ids (deleted tasks) do not block.
// byId is memoized per tasks array: the orchestrator tick calls this once per task with the same
// list, which rebuilt the map every time (O(n²), 175 ms self-time in t_155e7859). Callers must not
// mutate a list after passing it (they all pass fresh listTasks() snapshots).
const byIdCache = new WeakMap();
function openBlockers(task, tasks) {
  let byId = byIdCache.get(tasks);
  if (!byId) byIdCache.set(tasks, (byId = new Map(tasks.map((t) => [t.id, t]))));
  return depIds(task.blockedBy).filter((id) => byId.has(id) && byId.get(id).status !== 'done');
}
const isBlocked = (task, tasks) => openBlockers(task, tasks).length > 0;
// Throws if setting task.blockedBy = deps would reference itself, an unknown task, or create a cycle.
function validateDeps(taskId, deps, tasks) {
  const ids = depIds(deps); const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const d of ids) { if (d === taskId) throw new Error('a task cannot depend on itself'); if (!byId.has(d)) throw new Error('unknown task ' + d); }
  const seen = new Set(); const stack = [...ids];
  while (stack.length) {
    const cur = stack.pop(); if (cur === taskId) throw new Error('dependency cycle'); if (seen.has(cur)) continue; seen.add(cur);
    const t = byId.get(cur); if (t) stack.push(...depIds(t.blockedBy));
  }
  return ids;
}

// ---- priority ----
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const DEFAULT_PRIORITY = 'P2';
const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));
function normalizePriority(p) { return PRIORITIES.includes(p) ? p : DEFAULT_PRIORITY; }
const priorityRank = (t) => PRIORITY_RANK[t && t.priority] ?? PRIORITY_RANK[DEFAULT_PRIORITY];
// Highest priority first (P0..P3); ties keep original relative order (stable sort).
const byPriority = (tasks) => [...tasks].sort((a, b) => priorityRank(a) - priorityRank(b));

// ---- budgets ----
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
// Returns null or a reason string. agent: orchestrator counters of one node; totals: {cost, tokens} of this Run.
function budgetExceeded({ node = {}, agent = {}, settings = {}, totals = {} }) {
  const aTok = (agent.inputTokens || 0) + (agent.outputTokens || 0);
  if (num(node.budgetUsd) && (agent.cost || 0) >= num(node.budgetUsd)) return `agent budget $${num(node.budgetUsd)} reached ($${(agent.cost || 0).toFixed(4)})`;
  if (num(node.budgetTokens) && aTok >= num(node.budgetTokens)) return `agent token budget ${num(node.budgetTokens)} reached (${aTok})`;
  return projectBudgetExceeded(settings, totals);
}
function projectBudgetExceeded(settings = {}, totals = {}) {
  if (num(settings.budgetUsd) && (totals.cost || 0) >= num(settings.budgetUsd)) return `project budget $${num(settings.budgetUsd)} reached ($${(totals.cost || 0).toFixed(4)})`;
  if (num(settings.budgetTokens) && (totals.tokens || 0) >= num(settings.budgetTokens)) return `project token budget ${num(settings.budgetTokens)} reached (${totals.tokens || 0})`;
  return null;
}

// ---- approval gate ----
// Status an agent's "done" really becomes. Needs approval when the assignee has requireApproval or the project setting is on.
function needsApproval(node, settings = {}) { return !!((node && node.requireApproval) || settings.requireApproval); }
function gateStatus(status, node, settings, byHuman = false) {
  if (status === 'done' && !byHuman && needsApproval(node, settings)) return { status: 'review', awaitingApproval: true };
  return { status, awaitingApproval: status === 'review' ? undefined : false };
}

// ---- persisted logs ----
const LOG_CAP = 5000;
// Monitor events (plan t_a4ceb629/C) carry structured {reason, taskIds, action} the log UI reads;
// other kinds keep the whitelist so unknown extras never reach the persisted file.
const monitorFields = (l) => l.kind === 'monitor'
  ? { reason: l.reason ?? null, taskIds: Array.isArray(l.taskIds) ? l.taskIds : null, action: l.action ?? null }
  : {};
const logLine = (l) => JSON.stringify({ at: l.at || Date.now(), nodeId: l.nodeId || null, kind: l.kind, text: String(l.text ?? '').slice(0, 4000), taskId: l.taskId || null, task: l.task || null, subagentId: l.subagentId || null, ...monitorFields(l) });
function parseLogs(text, limit = 2000) {
  const out = [];
  for (const line of String(text || '').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out.slice(-limit);
}

module.exports = { depIds, openBlockers, isBlocked, validateDeps, budgetExceeded, projectBudgetExceeded, needsApproval, gateStatus, LOG_CAP, logLine, parseLogs, PRIORITIES, DEFAULT_PRIORITY, normalizePriority, priorityRank, byPriority };
