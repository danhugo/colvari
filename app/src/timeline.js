// Pure helpers turning stored runs/logs/wiki pages into the shapes the UI wants for
// a timeline view, a structured log feed, and a wiki page list. No side effects.

// One entry per run that actually ran an agent against a task: start/end per agent+task.
function timeline(runs = []) {
  return runs
    .filter((r) => r.kind === 'agent' && r.nodeId)
    .map((r) => ({
      nodeId: r.nodeId, agent: r.agent || '', taskId: r.taskId || null, task: r.task || '',
      startedAt: r.startedAt || null, endedAt: r.endedAt || null, durationMs: r.durationMs || 0,
      model: r.model || '', isError: !!r.isError,
    }));
}

const LEVELS = { error: 'error', tool_error: 'error', stderr: 'warn' };
const levelOf = (kind) => LEVELS[kind] || 'info';

// logs.jsonl lines ({at, nodeId, kind, text}, see controls.parseLogs) -> {ts, agentId, level, text}.
function logEntries(lines = []) {
  return lines.map((l) => ({ ts: l.at, agentId: l.nodeId || null, level: levelOf(l.kind), text: l.text }));
}

// store.listWiki() ({title: {title, content, author, updatedAt}}) -> [{title, body, updatedAt, author}].
function wikiPages(pages = {}) {
  return Object.values(pages).map((p) => ({ title: p.title, body: p.content || '', updatedAt: p.updatedAt || null, author: p.author || '' }));
}

module.exports = { timeline, logEntries, wikiPages };
