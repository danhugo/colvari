// Communication scope derived from the team graph. Each directed edge A -> B has a type:
//   assign  : A can create tasks for B (and message B). Edges without a type are assign edges.
//   message : A can send messages to B.
//   review  : B reviews A's work: B can see A's tasks and move them to review/done.
const typeOf = (e) => e.type || 'assign';
function outgoing(team, nodeId, types = ['assign']) {
  return [...new Set(team.edges.filter((e) => e.from === nodeId && types.includes(typeOf(e))).map((e) => e.to))];
}
function incoming(team, nodeId, types = ['assign']) {
  return [...new Set(team.edges.filter((e) => e.to === nodeId && types.includes(typeOf(e))).map((e) => e.from))];
}
const ALL = ['assign', 'message', 'review'];
const hasEdge = (team, from, to, types) => team.edges.some((e) => e.from === from && e.to === to && types.includes(typeOf(e)));
function canAssign(team, from, to) {
  if (from === to) return true;
  return hasEdge(team, from, to, ['assign']);
}
function canMessage(team, from, to) { return from !== to && hasEdge(team, from, to, ['assign', 'message']); }
// Nodes whose work nodeId reviews (sources of review edges into nodeId).
const reviewees = (team, nodeId) => incoming(team, nodeId, ['review']);
function canReviewTask(team, nodeId, task) {
  const r = reviewees(team, nodeId);
  return r.includes(task.assignee) || r.includes(task.createdBy);
}
// Who a node may see on the board: its own tasks, tasks of neighbours over any edge (both directions), tasks it created.
function visibleTask(team, nodeId, task) {
  const near = new Set([nodeId, ...outgoing(team, nodeId, ALL), ...incoming(team, nodeId, ALL)]);
  return near.has(task.assignee) || task.createdBy === nodeId;
}
// A node may change any status of tasks assigned to it, created by it, or assigned to an assign-neighbour.
function canModifyTask(team, nodeId, task) {
  return task.assignee === nodeId || task.createdBy === nodeId || outgoing(team, nodeId).includes(task.assignee);
}
// Full status rule: canModifyTask, or a reviewer moving a reviewee's task to review/done.
function canSetStatus(team, nodeId, task, status) {
  return canModifyTask(team, nodeId, task) || (['review', 'done'].includes(status) && canReviewTask(team, nodeId, task));
}
// ---- core-agent team management (recruit_agent / retire_agent / update_agent) ----
// update_agent may change ONLY these node fields (prompt maps to systemPrompt in board-tools); any
// other key is refused, so a core can never set core/createdBy/disabledBoardTools/... on a teammate.
const AGENT_PATCH_FIELDS = ['role', 'prompt', 'runtime', 'model', 'effort'];
// Permissiveness order used to cap a recruit's permission mode at its core's: a recruit never runs
// with more power than the agent that created it. plan (read-only) < default < acceptEdits < bypass.
const PERMISSION_RANK = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };
const capPermissionMode = (coreMode, mode) => ((PERMISSION_RANK[mode] ?? PERMISSION_RANK.default) > (PERMISSION_RANK[coreMode] ?? PERMISSION_RANK.default) ? coreMode : mode);
// A core may retire/update ANY teammate except cores: never itself, never a core node (human-made
// teammates included). Nodes of other teams never reach this check — they are not resolvable in the
// core's team-scoped store.
const canManageAgent = (core, target) => !!core && !!target && target.id !== core.id && target.core !== true;

module.exports = { outgoing, incoming, canAssign, canMessage, canReviewTask, reviewees, visibleTask, canModifyTask, canSetStatus, typeOf, AGENT_PATCH_FIELDS, PERMISSION_RANK, capPermissionMode, canManageAgent };
