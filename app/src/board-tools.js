// Pure tool implementations with scope enforcement. Used by the MCP server and by tests.
const { outgoing, incoming, canAssign, canMessage, reviewees, visibleTask, canSetStatus } = require('./scope');
const { BOARD_TOOLS } = require('./agent-config');
const C = require('./controls');

// Board tools this node may use (the rest are disabled in the node's settings).
function enabledTools(node) {
  const off = new Set((node && node.disabledBoardTools) || []);
  return BOARD_TOOLS.filter((t) => !off.has(t));
}

function makeTools(store, nodeId) {
  const team = () => store.getTeam();
  const nodeName = (t, id) => (t.nodes.find((n) => n.id === id) || {}).name || id;
  const fmtTask = (t, tk, all) => { const open = C.openBlockers(tk, all || store.listTasks()); return { ...tk, assigneeName: nodeName(t, tk.assignee), ...(open.length ? { blockedByOpen: open } : {}) }; };
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
    list_tasks({ status, mine } = {}) {
      const t = me();
      const all = store.listTasks();
      return all.filter((tk) => (!status || tk.status === status) && (mine ? tk.assignee === nodeId : visibleTask(t, nodeId, tk))).map((tk) => fmtTask(t, tk, all));
    },
    create_task({ title, description = '', assignee, parentId = null, blockedBy = [] }) {
      const t = me();
      const target = assignee ? resolve(t, assignee, 'assignee') : t.nodes.find((n) => n.id === nodeId);
      if (!canAssign(t, nodeId, target.id)) throw new Error(`scope violation: ${nodeName(t, nodeId)} cannot assign tasks to ${target.name} (no assign edge)`);
      return store.createTask({ title, description, assignee: target.id, createdBy: nodeId, parentId, blockedBy });
    },
    update_task_status({ taskId, status }) {
      const t = me(); const tk = store.getTask(taskId);
      if (!tk) throw new Error('no task ' + taskId);
      if (!canSetStatus(t, nodeId, tk, status)) throw new Error('scope violation: cannot modify this task');
      if (tk.awaitingApproval && status === 'done') throw new Error('this task is waiting for human approval; only a human can move it to done');
      const g = C.gateStatus(status, t.nodes.find((n) => n.id === tk.assignee), store.getSettings());
      const r = store.updateTask(taskId, g);
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
    read_wiki({ title } = {}) {
      me();
      if (!title) return Object.keys(store.listWiki());
      return store.readWiki(title) || { error: 'page not found', pages: Object.keys(store.listWiki()) };
    },
    write_wiki({ title, content }) {
      const t = me();
      return store.writeWiki(title, content, nodeName(t, nodeId));
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
