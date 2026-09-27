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

// -> [{ pmId, idle: [nodeIds], text }] for PMs with open goals (tasks they own or created) and idle reports.
function idleNudges(team, tasks, agents = {}) {
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
  return res;
}

module.exports = { agentStates, idleNudges };
