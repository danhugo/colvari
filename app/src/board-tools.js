// Pure tool implementations with scope enforcement. Used by the MCP server and by tests.
const fs = require('fs');
const path = require('path');
const { outgoing, incoming, canAssign, canMessage, reviewees, visibleTask, canSetStatus, AGENT_PATCH_FIELDS, capPermissionMode, canManageAgent } = require('./scope');
const { BOARD_TOOLS } = require('./agent-config');
const { getRuntime } = require('./runtimes');
const C = require('./controls');
const SU = require('./self-update');

// Board tools this node may use (the rest are disabled in the node's settings).
function enabledTools(node) {
  const off = new Set((node && node.disabledBoardTools) || []);
  return BOARD_TOOLS.filter((t) => !off.has(t));
}

function makeTools(store, nodeId) {
  const team = () => store.getTeam();
  const nodeName = (t, id) => (t.nodes.find((n) => n.id === id) || {}).name || id;
  // Trim heavy fields (full description, comment history) from list results; comment_task/update_task_status
  // callers still get a task's full record via the store, but bulk listing stays small so it doesn't flood context.
  const fmtTask = (t, tk, all, { brief = false } = {}) => {
    const open = C.openBlockers(tk, all || store.listTasks());
    const base = brief ? { ...tk, description: tk.description ? tk.description.slice(0, 200) : tk.description, comments: tk.comments.length } : tk;
    return { ...base, assigneeName: nodeName(t, tk.assignee), ...(open.length ? { blockedByOpen: open } : {}) };
  };
  const me = () => { const t = team(); const n = t.nodes.find((x) => x.id === nodeId); if (!n) throw new Error('unknown caller node ' + nodeId); return t; };
  const resolve = (t, ref, what) => { const n = t.nodes.find((x) => x.id === ref || x.name === ref); if (!n) throw new Error(`unknown ${what} "${ref}"`); return n; };
  // ---- core-agent team management (recruit/retire/update_agent) ----
  // All three tools act on the core's OWN team file: this Store has no teamId (getTeam() returns the
  // merged view of every team and writes would land in the wrong file), so re-scope per call.
  const coreStore = () => {
    const core = me().nodes.find((x) => x.id === nodeId);
    if (!core || !core.core) throw new Error('scope violation: team management tools are core-agent only');
    const tid = store.nodeTeam(nodeId);
    if (!tid) throw new Error('no team for core node ' + nodeId);
    return { core, s: store.forTeam(tid) };
  };
  // Every applied or declined change lands on the core's current task (comment) and in the persisted
  // log timeline (appendLog) — no new UI entry type.
  const announce = (text) => {
    const tk = store.listTasks({ assignee: nodeId, status: 'in_progress' })[0];
    store.appendLog({ nodeId, kind: 'team.change', taskId: tk ? tk.id : null, text });
    if (tk) store.commentTask(tk.id, nodeName(team(), nodeId), text);
  };
  // Canonical JSON so the same request always maps to the same inbox item regardless of key order.
  const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  // teamChangeApproval 'ask' must NOT block the tool call (an MCP call can time out): the first call
  // files the request in the human Inbox — the core's current task goes waiting_for_human — and
  // returns {pending:true}; nothing changes. When the human answered and the core calls again with
  // the same request, the answered item decides: 'approve' applies it, anything else refuses. The
  // answer is one-shot: askGate consumes the item once it is used, so the same request re-asks
  // instead of replaying an old approval or staying blocked by an old decline. The core does not
  // have to re-call at all: the main process applies an answered item itself (team-answers.js), so
  // the stored payload must be complete here — `change` (stable JSON, the fingerprint) plus `reason`,
  // which the tools require but which stays out of the fingerprint.
  const askGate = (change, question, reason) => {
    if ((store.getSettings().teamChangeApproval || 'ask') !== 'ask') return { proceed: true };
    const fp = JSON.stringify(stable(change));
    const mine = store.listInbox().filter((i) => i.kind === 'question' && i.nodeId === nodeId && i.change === fp && !i.consumed);
    const open = mine.find((i) => i.status === 'open');
    if (open) return { pending: true, result: { pending: true, inboxId: open.id, note: 'pending approval: waiting for the human to answer in the Inbox; call this tool again once it is answered' } };
    const answered = [...mine].reverse().find((i) => i.status === 'answered');
    if (answered) {
      store.consumeInbox(answered.id);
      return answered.answer === 'approve' ? { proceed: true } : { declined: true, result: { applied: false, note: `declined by the human (${answered.answer}); nothing was changed` } };
    }
    const tk = store.listTasks({ assignee: nodeId, status: 'in_progress' })[0];
    store.askHuman({ taskId: tk ? tk.id : null, nodeId, question, choices: ['approve'], change: fp, reason });
    return { pending: true, result: { pending: true, note: 'pending approval: the request is in the human Inbox; nothing changes until it is approved and you call this tool again' } };
  };
  const refuseManage = (tool, core, target) => {
    const why = target.id === core.id ? 'a core agent cannot manage itself' : 'a core node can never be retired or updated';
    return new Error(`scope violation: ${tool}: ${why}`);
  };
  // Recruit is refused at >=80% of either project budget (the orchestrator hard-stops runs at 100%):
  // a new agent multiplies spend, so the bar for ADDING spend is lower. Totals are a store-side
  // replica of what the orchestrator accumulates in record() and passes to projectBudgetExceeded —
  // reportedCostUsd and input+output tokens over non-preflight records since the last "Orchestrator
  // started" log line (its counters reset there); those records are exactly what store.addRun
  // persists. Not shared code: if the two ever drift, this gate and the hard-stop disagree.
  // The readLogs(2000) cap can evict the started marker on very log-heavy runs; since=0 then counts
  // ALL persisted runs, so the gate errs toward refusing — the safe side for a spend decision.
  const runTotals = (s) => {
    let since = 0;
    for (const l of s.readLogs(2000)) if (l.text === 'Orchestrator started') since = l.at;
    let cost = 0, tokens = 0;
    for (const r of s.listRuns()) {
      if (r.kind === 'preflight' || Date.parse(r.startedAt) < since) continue;
      cost += r.reportedCostUsd || 0; tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    }
    return { cost, tokens };
  };
  const recruitBudgetBlock = (s) => {
    const st = store.getSettings();
    const usd = Number(st.budgetUsd) || 0, tok = Number(st.budgetTokens) || 0;
    if (!(usd > 0) && !(tok > 0)) return null;
    const { cost, tokens } = runTotals(s);
    if (usd > 0 && cost >= 0.8 * usd) return `refused: project budget $${usd} is >=80% used ($${cost.toFixed(4)}); retire an agent or raise the budget before recruiting`;
    if (tok > 0 && tokens >= 0.8 * tok) return `refused: project token budget ${tok} is >=80% used (${tokens}); retire an agent or raise the budget before recruiting`;
    return null;
  };
  const impl = {
    list_team() {
      const t = me();
      const brief = (id) => { const n = t.nodes.find((x) => x.id === id); return n && { id: n.id, name: n.name, role: n.role, core: !!n.core, ...(n.createdBy ? { createdBy: n.createdBy } : {}) }; };
      return {
        self: brief(nodeId),
        canAssignTo: outgoing(t, nodeId).map(brief), receivesFrom: incoming(t, nodeId).map(brief),
        canMessage: outgoing(t, nodeId, ['assign', 'message']).map(brief),
        reviews: reviewees(t, nodeId).map(brief), reviewedBy: outgoing(t, nodeId, ['review']).map(brief),
      };
    },
    // By default excludes done tasks and trims description/comments, so a full-board listing stays small
    // enough for the 40%-autocompact budget; pass status:'done' (or includeDone) or taskId for full detail.
    list_tasks({ status, mine, includeDone = false, taskId } = {}) {
      const t = me();
      const all = store.listTasks();
      if (taskId) {
        const tk = all.find((x) => x.id === taskId);
        if (!tk || !visibleTask(t, nodeId, tk)) throw new Error('no visible task ' + taskId);
        return fmtTask(t, tk, all);
      }
      const showDone = includeDone || status === 'done';
      return all
        .filter((tk) => (!status || tk.status === status) && (showDone || tk.status !== 'done') && (mine ? tk.assignee === nodeId : visibleTask(t, nodeId, tk)))
        .map((tk) => fmtTask(t, tk, all, { brief: true }));
    },
    create_task({ title, description = '', assignee, parentId = null, blockedBy = [], priority }) {
      const t = me();
      const target = assignee ? resolve(t, assignee, 'assignee') : t.nodes.find((n) => n.id === nodeId);
      if (!canAssign(t, nodeId, target.id)) throw new Error(`scope violation: ${nodeName(t, nodeId)} cannot assign tasks to ${target.name} (no assign edge)`);
      return store.createTask({ title, description, assignee: target.id, createdBy: nodeId, parentId, blockedBy, priority });
    },
    update_task_status({ taskId, status, priority }) {
      const t = me(); const tk = store.getTask(taskId);
      if (!tk) throw new Error('no task ' + taskId);
      if (!canSetStatus(t, nodeId, tk, status)) throw new Error('scope violation: cannot modify this task');
      if (tk.awaitingApproval && status === 'done') throw new Error('this task is waiting for human approval; only a human can move it to done');
      const g = C.gateStatus(status, t.nodes.find((n) => n.id === tk.assignee), store.getSettings());
      // Explicit agent-initiated review (vs. the orchestrator parking an incomplete/failed run for a human):
      // eligible for reviewer dispatch / auto-advance so its dependents unblock.
      if (g.status === 'review') g.parkedForHuman = false;
      const r = store.updateTask(taskId, priority !== undefined ? { ...g, priority } : g);
      return g.awaitingApproval ? { ...r, note: 'Moved to review: a human must approve this task before it is done.' } : r;
    },
    comment_task({ taskId, text }) {
      const t = me(); const tk = store.getTask(taskId);
      if (!tk) throw new Error('no task ' + taskId);
      if (!visibleTask(t, nodeId, tk)) throw new Error('scope violation: task not visible');
      return store.commentTask(taskId, nodeName(t, nodeId), text);
    },
    send_message({ to, text, taskId = null }) {
      const t = me(); const target = resolve(t, to, 'recipient');
      if (!canMessage(t, nodeId, target.id)) throw new Error(`scope violation: ${nodeName(t, nodeId)} cannot message ${target.name} (no message or assign edge)`);
      return store.sendMessage({ from: nodeId, to: target.id, text, taskId });
    },
    // Inbox: messages to me from nodes that (still) have a message/assign edge to me. Marks them read.
    read_messages({ unreadOnly = false, from } = {}) {
      const t = me();
      let ms = store.listMessages({ to: nodeId }).filter((m) => m.from === 'human' || canMessage(t, m.from, nodeId));
      if (from) { const f = resolve(t, from, 'sender'); ms = ms.filter((m) => m.from === f.id); }
      if (unreadOnly) ms = ms.filter((m) => !m.read);
      store.markMessagesRead(ms.filter((m) => !m.read).map((m) => m.id));
      return ms.map((m) => ({ ...m, fromName: m.from === 'human' ? 'human' : nodeName(t, m.from) }));
    },
    // Blocks (async) until a human answers in the Inbox; returns the answer text.
    async ask_human({ question, choices = [], taskId, pollMs = 1000 }) {
      const t = me();
      const tk = taskId ? store.getTask(taskId) : store.listTasks().find((x) => x.assignee === nodeId && x.status === 'in_progress');
      if (taskId && (!tk || !visibleTask(t, nodeId, tk))) throw new Error('no visible task ' + taskId);
      const item = store.askHuman({ taskId: tk ? tk.id : null, nodeId, question, choices });
      for (;;) {
        const it = store.getInboxItem(item.id);
        if (it && it.status === 'answered') return { answer: it.answer };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
    read_wiki({ title } = {}) {
      me();
      if (!title) return Object.keys(store.listWiki());
      return store.readWiki(title) || { error: 'page not found', pages: Object.keys(store.listWiki()) };
    },
    write_wiki({ title, content }) {
      const t = me();
      return store.writeWiki(title, content, nodeName(t, nodeId));
    },
    // PM-only: ask the app to update itself to the newest code. The request is a file the app's
    // UpdateWatcher consumes on its next poll; it still honors the auto-restart setting and the
    // restart guards, and every outcome lands in the activity feed.
    request_self_update({ reason = '' } = {}) {
      const t = me();
      const n = t.nodes.find((x) => x.id === nodeId);
      if (!n || String(n.role).toLowerCase() !== 'pm') throw new Error('scope violation: request_self_update is PM-only');
      // Self-update is dev/dogfood-only (main.js gates the watcher on the same variable).
      if (process.env.AGENTS_SQUAD_DEV !== '1') return { requested: false, note: 'Self-update is disabled outside dev/dogfood mode.' };
      fs.writeFileSync(SU.requestFile(store.dir), JSON.stringify({ reason: String(reason || '').slice(0, 500), from: nodeId, ts: new Date().toISOString() }));
      return { requested: true, note: 'Picked up on the next watcher poll if auto-restart is on; the result appears in the activity feed.' };
    },
    recruit_agent({ name, role, prompt, runtime, model, effort, reason = '' } = {}) {
      if (!String(name || '').trim()) throw new Error('name required');
      if (!String(role || '').trim()) throw new Error('role required');
      if (!String(reason || '').trim()) throw new Error('reason required: state the expected gain vs cost of this change');
      const { core, s } = coreStore();
      getRuntime(runtime); // runtimes.js is the registry: unknown id -> error (model stays free text)
      const blocked = recruitBudgetBlock(s);
      if (blocked) throw new Error(blocked);
      const g = askGate({ tool: 'recruit_agent', name, role, prompt, runtime, model, effort }, `Core agent "${core.name}" requests a new agent "${name}" (role ${role})${reason ? ` — ${reason}` : ''}. Approve?`, reason);
      if (!g.proceed) { if (g.declined) announce(`recruit of "${name}" declined by the human`); return g.result; }
      // Counted again after approval too: the team may have grown while the request was pending.
      const max = Math.max(1, parseInt(store.getSettings().maxAgents, 10) || 6);
      if (s.getTeam().nodes.length >= max) throw new Error(`refused: maxAgents ${max} reached (team has ${s.getTeam().nodes.length} agents)`);
      const blocked2 = recruitBudgetBlock(s);
      if (blocked2) throw new Error(blocked2);
      // The node is built ONLY from the request's allowed fields; core/createdBy/recruitedAt are set
      // here and never taken from the caller.
      const k = s.getTeam().nodes.filter((x) => x.createdBy === nodeId).length;
      let node = s.addNode({
        name: String(name).trim(), role: String(role).trim(),
        ...(prompt != null ? { systemPrompt: String(prompt) } : {}), ...(runtime ? { runtime } : {}),
        ...(model ? { model: String(model) } : {}), ...(effort ? { effort } : {}),
        core: false, createdBy: nodeId, recruitedAt: new Date().toISOString(),
        x: core.x + 220, y: core.y + 120 * (k + 1),
      });
      // A recruit runs at its preset's/project's permission mode, never more permissive than its core.
      const st = store.getSettings();
      const eff = node.permissionMode || st.permissionMode || 'bypassPermissions';
      const coreMode = core.permissionMode || st.permissionMode || 'bypassPermissions';
      if (capPermissionMode(coreMode, eff) !== eff) s.updateNode(node.id, { permissionMode: capPermissionMode(coreMode, eff) });
      s.addEdge(nodeId, node.id);
      s.addEdge(node.id, nodeId, 'message');
      node = s.getTeam().nodes.find((x) => x.id === node.id);
      announce(`recruited agent "${node.name}" (${node.role}) as ${node.id} — ${reason.trim()}`);
      return node;
    },
    retire_agent({ nodeId: ref, reason = '' } = {}) {
      if (!String(reason || '').trim()) throw new Error('reason required: state the expected gain vs cost of this change');
      const { core, s } = coreStore();
      const target = resolve(s.getTeam(), ref, 'agent');
      if (!canManageAgent(core, target)) throw refuseManage('retire_agent', core, target);
      const inProg = store.listTasks({ assignee: target.id, status: 'in_progress' });
      if (inProg.length) throw new Error(`refused: "${target.name}" still owns ${inProg.length} in_progress task(s) (${inProg.map((t) => t.id).join(', ')})`);
      const g = askGate({ tool: 'retire_agent', nodeId: target.id }, `Core agent "${core.name}" requests retiring agent "${target.name}"${reason ? ` — ${reason}` : ''}. Approve?`, reason);
      if (!g.proceed) { if (g.declined) announce(`retire of "${target.name}" declined by the human`); return g.result; }
      // Reassign BEFORE removeNode, while the core -> target edges still exist.
      for (const tk of store.listTasks({ assignee: target.id, status: 'todo' })) store.updateTask(tk.id, { assignee: nodeId });
      s.removeNode(target.id);
      announce(`retired agent "${target.name}" (${target.id}) — ${reason.trim()}`);
      return { retired: true, nodeId: target.id };
    },
    update_agent({ nodeId: ref, patch, reason = '' } = {}) {
      if (!String(reason || '').trim()) throw new Error('reason required: state the expected gain vs cost of this change');
      const { core, s } = coreStore();
      const target = resolve(s.getTeam(), ref, 'agent');
      if (!canManageAgent(core, target)) throw refuseManage('update_agent', core, target);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new Error('patch object required');
      const bad = Object.keys(patch).filter((k) => !AGENT_PATCH_FIELDS.includes(k));
      if (bad.length) throw new Error(`patch field(s) not allowed: ${bad.join(', ')} (allowed: ${AGENT_PATCH_FIELDS.join(', ')})`);
      if (patch.runtime) getRuntime(patch.runtime);
      const g = askGate({ tool: 'update_agent', nodeId: target.id, patch }, `Core agent "${core.name}" requests updating agent "${target.name}": ${JSON.stringify(patch)}${reason ? ` — ${reason}` : ''}. Approve?`, reason);
      if (!g.proceed) { if (g.declined) announce(`update of "${target.name}" declined by the human`); return g.result; }
      const storePatch = {};
      for (const k of Object.keys(patch)) storePatch[k === 'prompt' ? 'systemPrompt' : k] = patch[k];
      const n = s.updateNode(target.id, storePatch);
      announce(`updated agent "${n.name}" (${Object.keys(patch).join(', ')}) — ${reason.trim()}`);
      return n;
    },
  };
  // Wrap each tool with the per-agent enable check (read at call time, so toggles apply to the next call).
  const tools = {};
  for (const name of Object.keys(impl)) {
    tools[name] = (args) => {
      const n = team().nodes.find((x) => x.id === nodeId);
      if (n && !enabledTools(n).includes(name)) throw new Error(`tool ${name} is disabled for this agent`);
      return impl[name](args);
    };
  }
  return tools;
}
module.exports = { makeTools, enabledTools };
