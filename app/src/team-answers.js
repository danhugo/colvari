// Main-process handler for answered human-Inbox items (t_048c41be). An askGate approval request
// (recruit/retire/update with a `change` payload) returns {pending:true} and ends the core's run —
// so after the human answers, nothing re-wakes the core to re-call the tool. Instead the answer is
// applied HERE: a re-call of makeTools(...)[tool] with the stored payload, so askGate sees the
// answered item, consumes it (one-shot), and every re-check (maxAgents, budget, target still
// exists, scope, tool still enabled) runs exactly as on the tool's own path — no second apply
// path. A decline only consumes the item. Both outcomes are messaged to the core through
// orch.sendToAgent, the app's existing human-notice primitive: it interrupts a live core with the
// text and otherwise stores it in the agent's inbox, and it never starts a run on a stopped
// project. Nothing in here may throw into the UI's answer handler once the answer is recorded.
const { makeTools } = require('./board-tools');

function applyAnsweredChange(store, orch, item, answer) {
  if (!item || !item.change || !item.nodeId) return false; // plain ask_human / task approvals keep the current flow
  const live = store.getInboxItem(item.id);
  if (!live || live.status !== 'answered' || live.consumed) return false; // one-shot, race-safe
  let req;
  try { req = JSON.parse(live.change); } catch { req = null; } // `change` is the stable-JSON fingerprint AND the payload
  if (!req || typeof req.tool !== 'string' || !req.tool) return false;
  // The notice must name its subject (the gui-e2e contract greps for it, and the core should not
  // have to cross-reference): recruit carries `name`; retire/update carry the target's id, resolved
  // to a name while the node still exists (a retire removes it during the apply).
  const target = (store.getTeam().nodes || []).find((n) => n.id === req.nodeId);
  const who = req.name || (target ? `${target.name} (${target.id})` : req.nodeId) || 'unknown target';
  const say = (text) => {
    try { orch.sendToAgent(live.nodeId, text, live.taskId); }
    catch (e) { try { store.appendLog({ nodeId: live.nodeId, kind: 'team.change', taskId: live.taskId || null, text: `${text} (notice not delivered: ${e.message})` }); } catch {} }
  };
  if (String(answer ?? '').trim() !== 'approve') {
    store.consumeInbox(live.id);
    say(`Your ${req.tool} request for ${who} was declined by the human; nothing was changed.`);
    return true;
  }
  try {
    const tool = makeTools(store, live.nodeId)[req.tool];
    if (typeof tool !== 'function') throw new Error(`unknown tool "${req.tool}"`);
    const r = tool({ ...req, reason: live.reason || 'approved by the human in the Inbox' });
    if (r && r.pending) say(`Your ${req.tool} request for ${who} was approved but not applied: request not found — the stored ask no longer matched, so a fresh approval ask was filed instead.`);
    else say(`Your ${req.tool} request for ${who} was approved by the human and applied.`);
  } catch (e) {
    say(`Your ${req.tool} request for ${who} was approved but not applied: ${e.message}`);
  }
  return true;
}

module.exports = { applyAnsweredChange };
