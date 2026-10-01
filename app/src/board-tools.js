// Pure tool implementations with scope enforcement. Used by the MCP server and by tests.
const fs = require('fs');
const path = require('path');
const { outgoing, incoming, canAssign, canMessage, reviewees, visibleTask, canSetStatus, AGENT_PATCH_FIELDS, capPermissionMode, canManageAgent, canRetire } = require('./scope');
const { BOARD_TOOLS, RESTART_TOOLS } = require('./agent-config');
const { getRuntime } = require('./runtimes');
const WT = require('./worktree');
const C = require('./controls');
const SU = require('./self-update');

// Board tools this node may use (the rest are disabled in the node's settings). The restart tools
// exist only where the app can restart itself: devMode=false (packaged build) leaves them out, so
// they are never advertised in prompts nor registered in the MCP server. Default (undefined/true)
// is the dev behavior every hand-built caller (tests, prompts) expects.
function enabledTools(node, devMode) {
  const off = new Set((node && node.disabledBoardTools) || []);
  const list = devMode === false ? BOARD_TOOLS : [...BOARD_TOOLS, ...RESTART_TOOLS];
  return list.filter((t) => !off.has(t));
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
    const why = target.id === core.id ? 'a core agent cannot manage itself'
      : target.core === true ? 'a core node can never be retired or updated'
      : `"${target.name}" is protected from retirement — only the human can unprotect it (UI, agent editor)`;
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
  // Repo root owning this store's task worktrees — the same derivation the merge gate and the
  // store's listUnmergedBranches use (worktrees live at <root>/.squad/worktrees/<taskId>).
  // Null when no task carries a worktree.
  const squadRepoRoot = () => {
    const xs = store.listTasks().filter((x) => x.worktreePath);
    return xs.length ? path.resolve(xs[xs.length - 1].worktreePath, '..', '..', '..') : null;
  };
  // Overload guard (advisory only — never blocks creation): warn when the assignee ends up with
  // >=2 open tasks while an idle teammate of the same role (or any dev) could take the work.
  const overloadWarning = (t, assignee) => {
    const role = (n) => String(n.role || '').trim().toLowerCase();
    const open = store.listTasks().filter((x) => x.status !== 'done' && x.assignee === assignee.id);
    if (open.length < 2) return null;
    const idle = t.nodes.filter((n) => n.id !== assignee.id
      && (role(n) === role(assignee) || role(n).startsWith('dev'))
      && !store.listTasks().some((x) => x.status !== 'done' && x.assignee === n.id));
    if (!idle.length) return null;
    const names = idle.slice(0, 3).map((n) => `${n.name} (${n.role})`).join(', ');
    return `overload: ${assignee.name} now has ${open.length} open tasks while ${idle.length} idle teammate${idle.length > 1 ? 's' : ''} could take work: ${names}${idle.length > 3 ? ` +${idle.length - 3} more` : ''} — consider assigning there.`;
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
        .sort((a, b) => String(a.assignee).localeCompare(String(b.assignee)) || String(a.priority).localeCompare(String(b.priority)))
        .map((tk) => fmtTask(t, tk, all, { brief: true }));
    },
    create_task({ title, description = '', assignee, parentId = null, blockedBy = [], priority }) {
      const t = me();
      const target = assignee ? resolve(t, assignee, 'assignee') : t.nodes.find((n) => n.id === nodeId);
      if (!canAssign(t, nodeId, target.id)) throw new Error(`scope violation: ${nodeName(t, nodeId)} cannot assign tasks to ${target.name} (no assign edge)`);
      const task = store.createTask({ title, description, assignee: target.id, createdBy: nodeId, parentId, blockedBy, priority });
      const warn = overloadWarning(t, target);
      return warn ? { ...task, warning: warn } : task;
    },
    // PM-only: move a task to another teammate (needs an assign edge). Worktree, branch and comments stay.
    // Only todo tasks: a running/finished task still belongs to its agent.
    reassign_task({ taskId, assignee }) {
      const t = me();
      const n = t.nodes.find((x) => x.id === nodeId);
      if (!n || String(n.role).toLowerCase() !== 'pm') throw new Error('scope violation: reassign_task is PM-only');
      const tk = store.getTask(taskId);
      if (!tk) throw new Error('no task ' + taskId);
      if (tk.status !== 'todo') throw new Error(`cannot reassign a ${tk.status} task; only todo tasks can be reassigned`);
      const target = resolve(t, assignee, 'assignee');
      if (!canAssign(t, nodeId, target.id)) throw new Error(`scope violation: ${n.name} cannot assign tasks to ${target.name} (no assign edge)`);
      const from = nodeName(t, tk.assignee);
      const r = store.updateTask(taskId, { assignee: target.id });
      store.commentTask(taskId, n.name, `Reassigned from ${from} to ${target.name}.`);
      return r;
    },
    update_task_status({ taskId, status, priority }) {
      const t = me(); let tk = store.getTask(taskId);
      if (!tk) throw new Error('no task ' + taskId);
      if (!canSetStatus(t, nodeId, tk, status)) throw new Error('scope violation: cannot modify this task');
      if (tk.awaitingApproval && status === 'done') throw new Error('this task is waiting for human approval; only a human can move it to done');
      // A done flip must never strand an unmerged branch. When the task carries its worktree, the
      // merge gate inside store.updateTask lands the branch as part of this same flip (every gate
      // failure reopens the task), so done cannot stick unmerged. Without a link the merge would
      // never run: when the derived squad/<id> — the branch ensureWorktree manages — still exists
      // with unmerged work (useWorktrees off, a manually created worktree, or a lost link —
      // t_c1c1d235), re-link it and let the done flip run the gate. A recorded branch that
      // ensureWorktree cannot manage is refused with the branch named, unless it is provably
      // already merged or there is no repo to ask (fail-open keeps no-git stores working).
      if (status === 'done' && !tk.worktreePath) {
        const branch = tk.worktreeBranch || `squad/${tk.id}`;
        const root = squadRepoRoot();
        const st = root && WT.branchExists(root, branch) ? WT.branchMergeState(root, branch) : null;
        if (st && !st.merged && !tk.worktreeBranch) {
          const w = WT.ensureWorktree(root, tk.id);
          if (!w.warning) {
            store.updateTask(taskId, { worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch });
            tk = store.getTask(taskId);
          }
        }
        if (st && !st.merged && !tk.worktreePath) throw new Error(`cannot mark done: branch ${branch} is not merged into ${st.base} and the task has no worktree for the auto-merge — merge it into ${st.base} (or restore the task's worktree), then mark done again.`);
      }
      const g = C.gateStatus(status, t.nodes.find((n) => n.id === tk.assignee), store.getSettings());
      // Explicit agent-initiated review (vs. the orchestrator parking an incomplete/failed run for a human):
      // eligible for reviewer dispatch (no reviewer -> it stays in review, surfaced).
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
      const t = me(); if (to === 'human') throw new Error('unknown recipient "human". To reply to the human, put the reply in your final answer, or use ask_human.');
      const target = resolve(t, to, 'recipient');
      if (!canMessage(t, nodeId, target.id)) throw new Error(`scope violation: ${nodeName(t, nodeId)} cannot message ${target.name} (no message or assign edge)`);
      return store.sendMessage({ from: nodeId, to: target.id, text, taskId });
    },
    // Inbox: messages to me from nodes that (still) have a message/assign edge to me. Marks them read.
    read_messages({ unreadOnly = true, from, limit = 20 } = {}) {
      const t = me();
      let ms = store.listMessages({ to: nodeId }).filter((m) => m.from === 'human' || canMessage(t, m.from, nodeId));
      if (from) { const f = resolve(t, from, 'sender'); ms = ms.filter((m) => m.from === f.id); }
      if (unreadOnly) ms = ms.filter((m) => !m.read);
      ms = ms.slice(-limit); // newest `limit`; only the returned unread ones are marked read
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
    // restart guards, and every outcome lands in the activity feed. In a packaged build there is
    // no watcher at all, so the tool errors instead of pretending to queue something.
    request_self_update({ reason = '' } = {}) {
      const t = me();
      if (store.devMode === false) throw new Error('unavailable in packaged build: self-update only exists in dev/dogfood mode (run from source or set AGENTS_SQUAD_DEV=1)');
      const n = t.nodes.find((x) => x.id === nodeId);
      if (!n || String(n.role).toLowerCase() !== 'pm') throw new Error('scope violation: request_self_update is PM-only');
      // Self-update is dev/dogfood-only (main.js gates the watcher on the same variable).
      if (process.env.AGENTS_SQUAD_DEV !== '1') return { requested: false, note: 'Self-update is disabled outside dev/dogfood mode.' };
      fs.writeFileSync(SU.requestFile(store.dir), JSON.stringify({ reason: String(reason || '').slice(0, 500), from: nodeId, ts: new Date().toISOString() }));
      return { requested: true, note: 'Picked up on the next watcher poll if auto-restart is on; the result appears in the activity feed.' };
    },
    // PM-only (the protected core agent; enforced by caller role here, not by prompt omission —
    // Cato t_42f310cf #3): arm a restart, after a given task completes or once agents drain.
    // Merges never restart the app on their own — they only count toward the pending total the
    // cap watches. afterTaskId is validated in the store (a task that may never finish is refused).
    // In a packaged build nothing can relaunch the app, so arming would only park a schedule that
    // never fires (and gate every new task behind it) — refuse with a clear error.
    schedule_restart({ afterTaskId = null, now = false, reason = '' } = {}) {
      const t = me();
      if (store.devMode === false) throw new Error('unavailable in packaged build: restart scheduling only exists in dev/dogfood mode (run from source or set AGENTS_SQUAD_DEV=1)');
      const n = t.nodes.find((x) => x.id === nodeId);
      if (!n || String(n.role).toLowerCase() !== 'pm') throw new Error('scope violation: schedule_restart is PM-only (the protected core agent)');
      const rp = store.scheduleRestart({ afterTaskId, now });
      const what = now ? 'restart once agents drain' : `restart after ${afterTaskId}`;
      announce(`scheduled ${what} — ${Number(rp.count) || 0} change(s) pending${String(reason || '').trim() ? ` — ${String(reason).trim()}` : ''}`);
      return { scheduled: true, pendingCount: Number(rp.count) || 0, scheduledAfter: rp.afterTaskId || null, scheduledNow: !!rp.scheduledNow };
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
      let node = s.addNode({
        name: String(name).trim(), role: String(role).trim(),
        ...(prompt != null ? { systemPrompt: String(prompt) } : {}), ...(runtime ? { runtime } : {}),
        ...(model ? { model: String(model) } : {}), ...(effort ? { effort } : {}),
        core: false, createdBy: nodeId, recruitedAt: new Date().toISOString(),
        // no explicit x/y: the recruit falls through to addNode's free-spot search instead of
        // forcing a core offset that can land on top of an existing teammate
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
      if (!canRetire(core, target)) throw refuseManage('retire_agent', core, target);
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
