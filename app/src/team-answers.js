// Main-process handler for answered human-Inbox items (t_048c41be). An askGate approval request
// (recruit/retire/update with a `change` payload) returns {pending:true} and ends the core's run —
// so after the human answers, nothing re-wakes the core to re-call the tool. Instead the answer is
// applied HERE: a re-call of makeTools(...)[tool] with the stored payload, so askGate sees the
// answered item, consumes it (one-shot), and every re-check (maxAgents, budget, target still
// exists, scope, tool still enabled) runs exactly as on the tool's own path — no second apply
// path. A decline only consumes the item. Both outcomes are messaged to the core through
// orch.sendToAgent, the app's existing human-notice primitive: it interrupts a live core with the
// text and otherwise stores it in the agent's inbox, and it never starts a run on a stopped
// project. Plain ask_human answers are delivered here too (t_ccab4c19): the asker's message plus a
// wake for whatever landed in an inbox, so an answer never dies with a run that already ended.
// Nothing in here may throw into the UI's answer handler once the answer is recorded.
const { makeTools } = require('./board-tools');
const { coreNode } = require('./idle');

// A live run receives its answer through the ask_human poll loop; sendToAgent would SIGTERM it
// mid-poll, so deliveries and wakes only happen for agents without a live process.
const isLive = (orch, nodeId) => {
  try { return orch.agent(nodeId).status === 'working' && orch.procs.has(nodeId); } catch { return false; }
};
// Fire-and-forget wake with the message sendToAgent just stored; never throws into the answer handler.
const wake = (orch, nodeId, msg, why) => {
  try { if (msg && typeof orch.wakeForHuman === 'function') orch.wakeForHuman(nodeId, [msg], why).catch(() => {}); } catch {}
};

function applyAnsweredChange(store, orch, item, answer) {
  if (!item || !item.nodeId) return false; // task approvals and anything unaddressed keep the current flow
  const live = store.getInboxItem(item.id);
  if (!live || live.status !== 'answered' || live.consumed) return false; // one-shot, race-safe
  const answerText = String(answer ?? '').trim();
  if (!live.change) {
    // Plain ask_human: nothing to apply. Deliver the answer so a question never dies silently —
    // an idle asker (its run already ended) gets the answer as an inbox message plus a wake run;
    // a live asker is polling ask_human and gets it there. The core is told too (it may need to
    // re-plan), unless the asker IS the core. One-shot via the consumed flag, same as the change path.
    store.consumeInbox(live.id);
    const q = String(live.question || '').slice(0, 200);
    const why = { reason: 'human answer', taskIds: live.taskId ? [live.taskId] : [] };
    const team = store.getTeam();
    const sayTo = (nodeId, text, action) => {
      try {
        if (isLive(orch, nodeId)) return;
        wake(orch, nodeId, orch.sendToAgent(nodeId, text, live.taskId), { ...why, action });
      } catch (e) {
        try { store.appendLog({ nodeId, kind: 'team.change', taskId: live.taskId || null, text: `${text} (notice not delivered: ${e.message})` }); } catch {}
      }
    };
    sayTo(live.nodeId, `Human answered your question "${q}": "${answerText.slice(0, 500)}"`, 'wake asker');
    const core = coreNode(team);
    if (core && core.id !== live.nodeId) {
      const asker = (team.nodes || []).find((n) => n.id === live.nodeId);
      sayTo(core.id, `Human answered ${asker ? asker.name : live.nodeId}'s question "${q}": "${answerText.slice(0, 500)}"`, 'wake core');
    }
    return true;
  }
  let req;
  try { req = JSON.parse(live.change); } catch { req = null; } // `change` is the stable-JSON fingerprint AND the payload
  if (!req || typeof req.tool !== 'string' || !req.tool) return false;
  // The notice must name its subject (the gui-e2e contract greps for it, and the core should not
  // have to cross-reference): recruit carries `name`; retire/update carry the target's id, resolved
  // to a name while the node still exists (a retire removes it during the apply).
  const target = (store.getTeam().nodes || []).find((n) => n.id === req.nodeId);
  const who = req.name || (target ? `${target.name} (${target.id})` : req.nodeId) || 'unknown target';
  const why = { reason: 'human answer', taskIds: live.taskId ? [live.taskId] : [], action: 'wake asker' };
  const say = (text) => {
    try { return orch.sendToAgent(live.nodeId, text, live.taskId); }
    catch (e) { try { store.appendLog({ nodeId: live.nodeId, kind: 'team.change', taskId: live.taskId || null, text: `${text} (notice not delivered: ${e.message})` }); } catch {} return null; }
  };
  if (answerText !== 'approve') {
    store.consumeInbox(live.id);
    wake(orch, live.nodeId, say(`Your ${req.tool} request for ${who} was declined by the human; nothing was changed.`), why);
    return true;
  }
  try {
    const tool = makeTools(store, live.nodeId)[req.tool];
    if (typeof tool !== 'function') throw new Error(`unknown tool "${req.tool}"`);
    const r = tool({ ...req, reason: live.reason || 'approved by the human in the Inbox' });
    if (r && r.pending) wake(orch, live.nodeId, say(`Your ${req.tool} request for ${who} was approved but not applied: request not found — the stored ask no longer matched, so a fresh approval ask was filed instead.`), why);
    else wake(orch, live.nodeId, say(`Your ${req.tool} request for ${who} was approved by the human and applied.`), why);
  } catch (e) {
    wake(orch, live.nodeId, say(`Your ${req.tool} request for ${who} was approved but not applied: ${e.message}`), why);
  }
  return true;
}

module.exports = { applyAnsweredChange };
