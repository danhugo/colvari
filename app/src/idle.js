// Idle-agent detection (pure): busy = has an in_progress task or a live run; idle otherwise.
// A PM (any node with an assign edge to others) with open goals gets nudged about its idle reports.
const OPEN = (t) => t.status !== 'done';

function agentStates(team, tasks, agents = {}) {
  const out = {};
  for (const n of team.nodes || []) {
    const a = agents[n.id] || {};
    const busy = a.status === 'working' || tasks.some((t) => t.assignee === n.id && t.status === 'in_progress');
    out[n.id] = busy ? 'busy' : 'idle';
  }
  return out;
}

// The core recipient for watchdog notices: the protected core:true node, else the top of the assign
// tree (a node nobody assigns to — the root PM). Shared with team-answers.js's answer notice.
function coreNode(team) {
  const nodes = team.nodes || [];
  return nodes.find((n) => n.core)
    || nodes.find((n) => !(team.edges || []).some((e) => (e.type || 'assign') === 'assign' && e.to === n.id))
    || null;
}

// -> [{ pmId, idle: [nodeIds], text }] for PMs with open goals (tasks they own or created) and idle reports.
// opts.staleMin (with opts.now) adds the watchdog condition (t_ccab4c19): an open todo/in_progress task
// untouched for staleMin minutes whose assignee has no live run on it nudges the CORE as one aggregated
// entry { pmId, idle: [], taskIds, text, kind: 'stale' } — only a core wake can re-dispatch silent work.
// Without staleMin the condition is off and the output shape is unchanged (2-arg callers, deepStrictEqual tests).
function idleNudges(team, tasks, agents = {}, opts = {}) {
  const st = agentStates(team, tasks, agents);
  const name = (id) => ((team.nodes || []).find((n) => n.id === id) || {}).name || id;
  const res = [];
  for (const pm of team.nodes || []) {
    const reports = (team.edges || []).filter((e) => e.from === pm.id && (e.type || 'assign') === 'assign').map((e) => e.to);
    if (!reports.length) continue;
    const goals = tasks.some((t) => OPEN(t) && (t.assignee === pm.id || t.createdBy === pm.id));
    const idle = [...new Set(reports)].filter((id) => st[id] === 'idle');
    if (goals && idle.length) res.push({ pmId: pm.id, idle, text: `${idle.length} agent${idle.length > 1 ? 's' : ''} idle: ${idle.map(name).join(', ')}` });
  }
  const staleMin = Number(opts.staleMin || 0);
  if (staleMin > 0) {
    const now = Number(opts.now) || Date.now();
    const core = coreNode(team);
    if (core) {
      const liveOnIt = (t) => { const a = agents[t.assignee] || {}; return a.status === 'working' && a.taskId === t.id; };
      const stale = tasks.filter((t) => (t.status === 'todo' || t.status === 'in_progress')
        && !t.awaitingApproval && !t.parkedForHuman && t.assignee && !liveOnIt(t)
        && now - new Date(t.updatedAt).getTime() > staleMin * 60000);
      if (stale.length) {
        const mins = (t) => Math.max(1, Math.round((now - new Date(t.updatedAt).getTime()) / 60000));
        const list = stale.slice(0, 4).map((t) => `"${String(t.title || t.id).slice(0, 40)}" (${mins(t)}m)`);
        res.push({ pmId: core.id, idle: [], taskIds: stale.map((t) => t.id), kind: 'stale', text: `${stale.length} task${stale.length > 1 ? 's' : ''} stale ${staleMin} min: ${list.join(', ')}${stale.length > 4 ? ` +${stale.length - 4} more` : ''}` });
      }
    }
  }
  return res;
}

module.exports = { agentStates, idleNudges, coreNode };
