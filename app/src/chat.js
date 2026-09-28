// Chat helpers (pure, shared by the renderer and tests): stable avatars, the #company room feed built from
// logs/messages/tasks/inbox, bubble grouping, and the fixed composer syntax.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Chat = factory(); })(this, function () {
  const ms = (t) => (typeof t === 'number' ? t : Date.parse(t) || 0);
  const GROUP_MS = 5 * 60000, MAX = 500;
  // Colour from a hash of the node id (not the name), so renames keep the colour.
  function avatarColor(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360}, 55%, 48%)`; }
  const initials = (name) => String(name || '?').split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const toolName = (text) => String(text).split(' ')[0].replace(/^mcp__\w+__/, '');
  const toolArgs = (text) => { const s = String(text); const i = s.indexOf(' '); return i < 0 ? '' : s.slice(i + 1); };
  function toolLabel(text) {
    let a = {}; try { a = JSON.parse(toolArgs(text)); } catch {}
    const arg = a.title || a.status || a.file_path || a.command || a.pattern || a.text || a.question || '';
    return `${toolName(text)}${arg ? ' · ' + String(arg).replace(/\s+/g, ' ').slice(0, 50) : ''}`;
  }

  // Room events, oldest first, capped to the last MAX. who = node id | 'human' | 'orchestrator'.
  function roomEvents(logs, tasks, messages, inbox, max = MAX) {
    const ev = []; const taskOf = {}; // nodeId -> task title of the current run, to link log bubbles to a thread
    const byTitle = Object.fromEntries((tasks || []).map((t) => [t.title, t.id]));
    for (const l of (logs || []).slice().sort((a, b) => a.at - b.at)) {
      if (!l.nodeId) continue;
      const start = l.kind === 'system' && /^▶ .* starts "(.*?)"/.exec(l.text);
      if (start) { taskOf[l.nodeId] = byTitle[start[1]] || null; ev.push({ at: l.at, who: l.nodeId, type: 'action', text: `started working on “${start[1]}”`, taskId: taskOf[l.nodeId] }); continue; }
      const taskId = taskOf[l.nodeId] || null;
      if (l.kind === 'text' && String(l.text).trim()) ev.push({ at: l.at, who: l.nodeId, type: 'thought', text: l.text, taskId });
      else if (l.kind === 'tool') ev.push({ at: l.at, who: l.nodeId, type: 'tool', label: toolLabel(l.text), text: l.text, taskId });
      else if (l.kind === 'tool_result' || l.kind === 'tool_error') { const p = ev[ev.length - 1]; if (p && p.type === 'tool' && p.who === l.nodeId && p.result == null) p.result = l.text; }
      else if (l.kind === 'error') ev.push({ at: l.at, who: l.nodeId, type: 'error', text: l.text, taskId });
    }
    for (const m of messages || []) ev.push({ at: ms(m.at), who: m.from, to: m.to, type: 'message', text: m.text, taskId: m.taskId || null });
    for (const t of tasks || []) {
      if (t.createdBy) ev.push({ at: ms(t.createdAt), who: t.createdBy, to: t.assignee, type: 'handoff', text: t.title, taskId: t.id });
      for (const c of t.comments || []) ev.push({ at: ms(c.at), who: c.author, type: 'comment', text: c.text, taskId: t.id });
    }
    for (const i of inbox || []) if (i.kind === 'question') ev.push({ at: ms(i.at), who: i.nodeId, type: 'question', text: i.question, choices: i.choices || [], inboxId: i.id, taskId: i.taskId || null });
    return ev.sort((a, b) => a.at - b.at).slice(-max);
  }

  // Consecutive events by the same author within GROUP_MS form one group (one avatar + name header).
  function group(events) {
    const out = [];
    for (const e of events) { const g = out[out.length - 1]; if (g && g.who === e.who && e.at - g.items[g.items.length - 1].at < GROUP_MS && e.type !== 'question' && g.items[0].type !== 'question') g.items.push(e); else out.push({ who: e.who, at: e.at, items: [e] }); }
    return out;
  }

  // Fixed syntax: "@Name text" = task for Name; "@Name? text" = message to Name; anything else = goal for the head.
  function parseComposer(text, nodes) {
    const s = String(text || '').trim(); if (!s) return null;
    const m = /^@(\S+?)(\?)?(?:\s+([\s\S]*))?$/.exec(s);
    if (m) {
      const n = (nodes || []).find((x) => x.name.toLowerCase() === m[1].toLowerCase());
      if (!n) return { kind: 'error', text: `No agent called @${m[1]}` };
      const body = (m[3] || '').trim(); if (!body) return { kind: 'error', text: `Say what you want from @${n.name}` };
      return { kind: m[2] ? 'message' : 'task', nodeId: n.id, name: n.name, text: body };
    }
    return { kind: 'goal', text: s };
  }
  const preview = (p) => !p ? '' : p.kind === 'task' ? `Will create a task for ${p.name}` : p.kind === 'message' ? `Will send a message to ${p.name}` : p.kind === 'goal' ? 'Will start a new goal for the team (asks to confirm)' : p.text;
  // @mention autocomplete: the partial "@xx" at the end of the text -> matching nodes.
  function mentionMatches(text, nodes) { const m = /(?:^|\s)@(\w*)$/.exec(String(text)); if (!m) return null; return (nodes || []).filter((n) => n.name.toLowerCase().startsWith(m[1].toLowerCase())); }

  // Signature of every input the room feed reads (pure, used by the renderer's 1s tick to skip the
  // expensive roomEvents walk + DOM rebuild when nothing changed). Task comments bump task.updatedAt,
  // and logs are append/prepend/clear-only, so this catches every change the feed can show.
  function feedKey(inp) {
    const logs = inp.logs || [], tasks = inp.tasks || [], messages = inp.messages || [], inbox = inp.inbox || [];
    return JSON.stringify([
      inp.projectId, inp.thread || null,
      logs.length, logs.length ? logs[0].at : null, logs.length ? logs[logs.length - 1].at : null,
      tasks.map((t) => [t.id, t.updatedAt, (t.comments || []).length]),
      messages.length, messages.length ? messages[messages.length - 1].at : null,
      inbox.map((i) => i.id),
      (inp.nodes || []).map((n) => [n.id, n.name, n.role]),
      [...(inp.working || [])].sort(),
    ]);
  }

  return { avatarColor, initials, toolLabel, roomEvents, group, parseComposer, preview, mentionMatches, GROUP_MS, MAX, feedKey };
});
