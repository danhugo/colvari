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

  return { FLASH_MS, stuckAgents, timeline, edgeFlashes, taskThread, toolName };
});
