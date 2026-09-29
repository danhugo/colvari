// Idle-agent detection (pure): busy = has an in_progress task or a live run; idle otherwise.
// A PM (any node with an assign edge to others) with open goals gets nudged about its idle reports.
const OPEN = (t) => t.status !== 'done';
const { outgoing, incoming } = require('./scope');
const { isBlocked } = require('./controls');

// Reviewer routing (t_8df2cab6): a task entering review must land with a LIVE reviewer — a node
// that still exists in the team (a retire removes it), never the assignee (no self-review), and
// passing the caller's availability check. Route order:
//   1. an agent with a review edge to the assignee          -> route 'review'
//   2. the assignee's lead (an assign edge into it)         -> route 'lead'
//   3. nobody live                                          -> route 'human' (caller gates on approval)
// `stage` (0/1/2) is the task's persisted escalation level: 1 skips route 1 (the review-edge
// reviewer was re-woken and never came), 2 goes straight to the human. Pure — the orchestrator
// injects availability (paused runtime, budget stop) so tests and callers share the graph rules.
function pickReviewer(team, task, available = () => true, stage = 0) {
  const nodes = team.nodes || [];
  const find = (id) => nodes.find((n) => n.id === id) || null;
  const usable = (n) => n && n.id !== task.assignee && available(n);
  if (stage < 1) { const r = outgoing(team, task.assignee, ['review']).map(find).find(usable); if (r) return { reviewer: r, route: 'review' }; }
  if (stage < 2) { const l = incoming(team, task.assignee, ['assign']).map(find).find(usable); if (l) return { reviewer: l, route: 'lead' }; }
  return { reviewer: null, route: 'human' };
}

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
  // Idle company, workable open work (t_8df2cab6): with the Run up, no live run anywhere, and a todo
  // task that could actually start (assignee set, not blocked, not approval-gated/parked), wake the
  // task owner's lead — the assign edge into the assignee — else the core. Only genuinely workable
  // tasks count: waiting_for_human and blocked piles must not keep re-waking a finished company
  // (that would be a wake loop). The nudge loop's condition-key debounce + wake gap throttle the
  // repetition; once the lead dispatches, the task leaves todo and the condition clears.
  if (opts.companyIdle) {
    const core = coreNode(team);
    // No double-nudging: a stale-reported task already reached the core, and a task owned or
    // created by a PM whose idle-reports nudge is firing in this same sweep is already covered by
    // that nudge — 'open' is for work that would otherwise go unnoticed.
    const staleIds = new Set(res.flatMap((r) => (r.kind === 'stale' ? r.taskIds : [])));
    const covered = new Set(res.filter((r) => !r.kind || r.kind === 'idle').map((r) => r.pmId));
    const byTarget = new Map();
    for (const t of tasks) {
      if (t.status !== 'todo' || !t.assignee || t.awaitingApproval || t.parkedForHuman || isBlocked(t, tasks)) continue;
      if (staleIds.has(t.id) || covered.has(t.assignee) || (t.createdBy && covered.has(t.createdBy))) continue;
      const lead = incoming(team, t.assignee, ['assign']).map((id) => (team.nodes || []).find((n) => n.id === id)).find((n) => n && n.id !== t.assignee);
      const target = (lead || core || {}).id;
      if (!target) continue;
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push(t);
    }
    for (const [target, ts] of byTarget) {
      const list = ts.slice(0, 4).map((t) => `"${String(t.title || t.id).slice(0, 40)}"`);
      res.push({ pmId: target, idle: [], taskIds: ts.map((t) => t.id), kind: 'open', text: `${ts.length} task${ts.length > 1 ? 's' : ''} ready but nobody is working: ${list.join(', ')}${ts.length > 4 ? ` +${ts.length - 4} more` : ''}` });
    }
  }
  return res;
}

module.exports = { agentStates, idleNudges, coreNode, pickReviewer };
