// Pure helpers turning stored runs/logs/wiki pages into the shapes the UI wants for
// a timeline view, a structured log feed, and a wiki page list. No side effects.
const { isBlocked } = require('./controls');

// Priority rank a lane (one agent's runs) sorts by when it needs human attention: lower sorts first.
const ATTENTION_RANK = { waiting_for_human: 0, blocked: 1, error: 2 };

// One entry per run that actually ran an agent against a task: start/end per agent+task.
// Lanes (grouped by nodeId) are ordered needs-attention first: waiting_for_human, then blocked, then error,
// using `tasks` (store.listTasks()) to resolve each entry's current task status; ties keep chronological order.
function timeline(runs = [], tasks = []) {
  const entries = runs
    .filter((r) => r.kind === 'agent' && r.nodeId)
    .map((r) => ({
      nodeId: r.nodeId, agent: r.agent || '', taskId: r.taskId || null, task: r.task || '',
      startedAt: r.startedAt || null, endedAt: r.endedAt || null, durationMs: r.durationMs || 0,
      model: r.model || '', isError: !!r.isError,
    }));
  const byTaskId = new Map(tasks.map((t) => [t.id, t]));
  const blockedIds = new Set(tasks.filter((t) => isBlocked(t, tasks)).map((t) => t.id));
  const lanes = new Map();
  for (const e of entries) { if (!lanes.has(e.nodeId)) lanes.set(e.nodeId, []); lanes.get(e.nodeId).push(e); }
  const rankOf = (es) => {
    let best = 3;
    for (const e of es) {
      const t = e.taskId && byTaskId.get(e.taskId);
      if (t && t.status === 'waiting_for_human') best = Math.min(best, ATTENTION_RANK.waiting_for_human);
      else if (e.taskId && blockedIds.has(e.taskId)) best = Math.min(best, ATTENTION_RANK.blocked);
      else if (e.isError) best = Math.min(best, ATTENTION_RANK.error);
    }
    return best;
  };
  const order = new Map([...lanes.entries()].sort((a, b) => rankOf(a[1]) - rankOf(b[1])).map(([id], i) => [id, i]));
  return entries.slice().sort((a, b) => (order.get(a.nodeId) - order.get(b.nodeId)) || String(a.startedAt).localeCompare(String(b.startedAt)));
}

const LEVELS = { error: 'error', tool_error: 'error', stderr: 'warn' };
const levelOf = (kind) => LEVELS[kind] || 'info';

// logs.jsonl lines ({at, nodeId, kind, text, taskId, task}, see controls.parseLogs) -> {ts, agentId, level, text, taskId, task}.
// taskId/task let the UI deep-link a log row into the originating task's thread.
function logEntries(lines = []) {
  return lines.map((l) => ({ ts: l.at, agentId: l.nodeId || null, level: levelOf(l.kind), text: l.text, taskId: l.taskId || null, task: l.task || '' }));
}

// store.listWiki() ({title: {title, content, author, updatedAt}}) -> [{title, body, updatedAt, author}].
function wikiPages(pages = {}) {
  return Object.values(pages).map((p) => ({ title: p.title, body: p.content || '', updatedAt: p.updatedAt || null, author: p.author || '' }));
}

module.exports = { timeline, logEntries, wikiPages };
