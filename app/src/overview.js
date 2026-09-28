// Overview helpers (pure, shared by the renderer and tests): stuck detection, log -> timeline lanes,
// edge flashes from assign/message tool calls, and a readable per-task thread.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Overview = factory(); })(this, function () {
  const FLASH_MS = 10000;
  const toolName = (text) => String(text).split(' ')[0].replace(/^mcp__\w+__/, '');
  const ms = (t) => (typeof t === 'number' ? t : Date.parse(t) || 0);
  const toolInput = (text) => { const s = String(text); const i = s.indexOf(' '); if (i < 0) return {}; try { return JSON.parse(s.slice(i + 1)); } catch { return {}; } };

  // Agents whose status is working and whose last log line is older than `minutes`.
  function stuckAgents(agents, logs, now, minutes = 5) {
    const last = {}; for (const l of logs) if (l.nodeId) last[l.nodeId] = Math.max(last[l.nodeId] || 0, l.at);
    return Object.keys(agents || {}).filter((id) => agents[id].status === 'working' && now - (last[id] ?? agents[id].startedAt ?? now) >= minutes * 60000);
  }

  // One lane per node: run bars (from "▶ ... starts" to result/error/stop), tool ticks, status markers.
  function timeline(logs, nodeIds, now) {
    const lanes = Object.fromEntries(nodeIds.map((id) => [id, { runs: [], ticks: [], marks: [] }]));
    for (const l of logs.slice().sort((a, b) => a.at - b.at)) {
      const ln = lanes[l.nodeId]; if (!ln) continue;
      const open = ln.runs.length && ln.runs[ln.runs.length - 1].end == null ? ln.runs[ln.runs.length - 1] : null;
      if (l.kind === 'system' && /^▶ .* starts "/.test(l.text)) { if (open) open.end = l.at; ln.runs.push({ start: l.at, end: null, task: (/starts "(.*?)"/.exec(l.text) || [])[1] || '' }); }
      else if (l.kind === 'tool') {
        ln.ticks.push({ at: l.at, name: toolName(l.text) });
        if (toolName(l.text) === 'update_task_status') { const inp = toolInput(l.text); ln.marks.push({ at: l.at, status: inp.status || '?', taskId: inp.taskId }); }
      } else if (open && (l.kind === 'result' || (l.kind === 'system' && /^■/.test(l.text)))) open.end = l.at;
    }
    for (const id in lanes) for (const r of lanes[id].runs) if (r.end == null) { r.end = now; r.live = true; }
    return lanes;
  }

  // Ids of unfinished tasks a task waits for (self-contained copy of controls.openBlockers: this file is
  // also loaded as a plain <script> in the renderer, so it can't require() controls.js).
  const depIds = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean))];
  const isBlocked = (task, tasks) => { const byId = new Map(tasks.map((t) => [t.id, t])); return depIds(task.blockedBy).some((id) => byId.has(id) && byId.get(id).status !== 'done'); };

  const ATTENTION_RANK = { waiting_for_human: 0, blocked: 1, error: 2 };
  // Why a node's lane needs a human right now (its current task is waiting_for_human/blocked, or its last run errored), or null.
  function laneAttention(nodeIds, agents = {}, tasks = []) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const out = {};
    for (const id of nodeIds) {
      const a = agents[id] || {}; const t = a.taskId && byId.get(a.taskId);
      if (t && t.status === 'waiting_for_human') out[id] = 'waiting_for_human';
      else if (t && isBlocked(t, tasks)) out[id] = 'blocked';
      else if (a.lastError) out[id] = 'error';
      else out[id] = null;
    }
    return out;
  }
  // Node ids ordered needs-attention first (waiting_for_human, then blocked, then error); ties keep input order.
  function sortByAttention(nodeIds, agents, tasks) {
    const attn = laneAttention(nodeIds, agents, tasks);
    const rank = (id) => (attn[id] ? ATTENTION_RANK[attn[id]] : 3);
    return nodeIds.map((id, i) => [id, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([id]) => id);
  }

  // Edges that carried an assign (create_task) or send_message within the last FLASH_MS.
  function edgeFlashes(logs, edges, now, windowMs = FLASH_MS) {
    const hot = new Set();
    for (const l of logs) {
      if (l.kind !== 'tool' || now - l.at > windowMs || now < l.at) continue;
      const n = toolName(l.text); const inp = toolInput(l.text);
      const to = n === 'create_task' ? inp.assignee : n === 'send_message' ? inp.to : null; if (!to) continue;
      for (const e of edges) if (e.from === l.nodeId && e.to === to) hot.add(e.id);
    }
    return hot;
  }

  // Readable thread for a task: comments, messages between task participants, and tool calls made during
  // the assignee's runs on this task (one-line summary + full detail), sorted by time.
  function taskThread(task, logs, messages) {
    const items = (task.comments || []).map((c) => ({ at: ms(c.at), type: 'comment', who: c.author, text: c.text }));
    for (const m of messages || []) if (m.taskId === task.id || ((m.to === task.assignee || m.from === task.assignee) && ms(m.at) >= ms(task.createdAt))) items.push({ at: ms(m.at), type: 'message', who: m.from, to: m.to, text: m.text });
    let on = false;
    for (const l of logs.filter((x) => x.nodeId === task.assignee).sort((a, b) => a.at - b.at)) {
      if (l.kind === 'system' && /^▶ .* starts "/.test(l.text)) on = (/starts "(.*?)"/.exec(l.text) || [])[1] === task.title;
      if (!on || l.kind !== 'tool') continue;
      const n = toolName(l.text); const inp = toolInput(l.text);
      const arg = inp.status || inp.title || inp.file_path || inp.command || inp.pattern || inp.text || '';
      items.push({ at: l.at, type: 'tool', who: task.assignee, summary: `${n}${arg ? ' · ' + String(arg).replace(/\s+/g, ' ').slice(0, 60) : ''}`, text: l.text });
    }
    return items.sort((a, b) => a.at - b.at);
  }

  // Signature of every input the Overview render reads (pure, used by the renderer's 1s tick to skip
  // DOM work when nothing changed). `bucket` is a coarse time slice passed by the caller so only
  // time-visible state (stuck flags, live run bars, edge flashes) re-renders, not every tick.
  // Log arrays are append/prepend/clear-only, so length + first/last timestamp is a complete fingerprint.
  function overviewKey(inp) {
    const logs = inp.logs || [], tasks = inp.tasks || [], messages = inp.messages || [], edges = inp.edges || [];
    return JSON.stringify([
      inp.projectId, inp.stuckMinutes ?? null, inp.selectedTask ?? '', inp.bucket ?? 0,
      (inp.nodes || []).map((n) => [n.id, n.x, n.y, n.name, n.role, n.runtime || '', n.model || '']),
      edges.map((e) => [e.id, e.from, e.to, e.type || 'assign']),
      Object.entries(inp.agents || {}).map(([id, a]) => [id, a.status || '', a.taskId || null, a.iteration || 0, a.lastActivityAt || 0, a.lastError ? a.lastError.at : 0, a.activity ? [a.activity.trigger || '', a.activity.fromNodeId || '', a.activity.messageId || '', a.activity.startedAt || 0] : null, a.stall || null]),
      tasks.map((t) => [t.id, t.title, t.status, t.assignee, t.updatedAt]),
      messages.length, messages.length ? messages[messages.length - 1].at : null,
      logs.length, logs.length ? logs[0].at : null, logs.length ? logs[logs.length - 1].at : null,
    ]);
  }

  return { FLASH_MS, stuckAgents, timeline, edgeFlashes, taskThread, toolName, laneAttention, sortByAttention, overviewKey };
});
