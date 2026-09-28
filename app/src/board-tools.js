// Pure tool implementations with scope enforcement. Used by the MCP server and by tests.
const fs = require('fs');
const path = require('path');
const { outgoing, incoming, canAssign, canMessage, reviewees, visibleTask, canSetStatus } = require('./scope');
const { BOARD_TOOLS } = require('./agent-config');
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
  const impl = {
    list_team() {
      const t = me();
      const brief = (id) => { const n = t.nodes.find((x) => x.id === id); return n && { id: n.id, name: n.name, role: n.role }; };
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
      fs.writeFileSync(SU.requestFile(store.dir), JSON.stringify({ reason: String(reason || '').slice(0, 500), from: nodeId, ts: new Date().toISOString() }));
      return { requested: true, note: 'Picked up on the next watcher poll if auto-restart is on; the result appears in the activity feed.' };
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
