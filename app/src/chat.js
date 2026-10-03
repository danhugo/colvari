// Chat helpers (pure, shared by the renderer and tests): stable avatars, the #company room feed built from
// logs/messages/tasks/inbox, bubble grouping, and the fixed composer syntax.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Chat = factory(); })(this, function () {
  const ms = (t) => (typeof t === 'number' ? t : Date.parse(t) || 0);
  const GROUP_MS = 5 * 60000, MAX = 500;
  // Colour from a hash of the node id (not the name), so renames keep the colour.
  // Token palette (t_300e8fd2): callers that know the node override with the team-tied
  // agentVar(); this keeps standalone callers (tests, mentions fallback) on the brand ramp
  // instead of raw hsl values that matched no token.
  function avatarColor(id) {
    // Inside the app page, defer to app.js's team-tied agentColor (chat.js loads first and
    // also runs standalone in node tests, where the hash fallback keeps colours stable).
    try { if (typeof agentColor === 'function') return `var(--agent-${agentColor(id)})`; } catch (e) { /* standalone */ }
    let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `var(--agent-${(h % 8) + 1})`;
  }
  const initials = (name) => String(name || '?').split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  // Attachments (t_993822cf): size label + file:// URL for lazy <img> thumbnails (renderer + tests share).
  const fmtSize = (n) => n == null || isNaN(n) ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const fileUrl = (p) => encodeURI('file://' + p);
  // One bubble's attachment row: images render as 64px lazy file:// thumbnails, other files as name chips.
  const attThumbs = (atts) => {
    if (!atts || !atts.length) return '';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<span class="att-row">${atts.map((a) => String(a.mime || '').startsWith('image/') ? `<img class="att-thumb" src="${esc(fileUrl(a.path))}" loading="lazy" alt="${esc(a.name)}" title="${esc(a.name)} · ${fmtSize(a.size)}">` : `<span class="att-file" title="${esc(a.name)} · ${fmtSize(a.size)}">📄 ${esc(a.name)}</span>`).join('')}</span>`;
  };
  const toolName = (text) => String(text).split(' ')[0].replace(/^mcp__\w+__/, '');
  const toolArgs = (text) => { const s = String(text); const i = s.indexOf(' '); return i < 0 ? '' : s.slice(i + 1); };
  function toolLabel(text) {
    let a = {}; try { a = JSON.parse(toolArgs(text)); } catch {}
    const arg = a.title || a.status || a.file_path || a.command || a.pattern || a.text || a.question || '';
    return `${toolName(text)}${arg ? ' · ' + String(arg).replace(/\s+/g, ' ').slice(0, 50) : ''}`;
  }

  // Room events, oldest first, capped to the last MAX. who = node id | 'human' | 'orchestrator'.
  // Child events carrying subagentId (t_c33656ba) are folded into ONE 'subagent' bubble at the
  // position of the first child event — the room must not flood with subagent tool noise. When the
  // caller passes a record lookup (recOf), nested subagents become children of their parent bubble.
  function roomEvents(logs, tasks, messages, inbox, max = MAX, recOf = null) {
    const ev = []; const taskOf = {}; // nodeId -> task title of the current run, to link log bubbles to a thread
    const sub = new Map(); // subagentId -> its single bubble event
    const byTitle = Object.fromEntries((tasks || []).map((t) => [t.title, t.id]));
    for (const l of (logs || []).slice().sort((a, b) => a.at - b.at)) {
      if (!l.nodeId) continue;
      const start = l.kind === 'system' && /^▶ .* starts "(.*?)"/.exec(l.text);
      if (start) { taskOf[l.nodeId] = byTitle[start[1]] || null; ev.push({ at: l.at, who: l.nodeId, type: 'action', text: `started working on “${start[1]}”`, taskId: taskOf[l.nodeId] }); continue; }
      const taskId = taskOf[l.nodeId] || null;
      if (l.subagentId) {
        let e = sub.get(l.subagentId);
        if (!e) { e = { at: l.at, who: l.nodeId, type: 'subagent', subagentId: l.subagentId, taskId, events: [], total: 0 }; sub.set(l.subagentId, e); ev.push(e); }
        e.total++;
        if (e.events.length < 20) e.events.push({ kind: l.kind, text: String(l.text || '').slice(0, 300), at: l.at });
        continue;
      }
      if (l.kind === 'text' && String(l.text).trim()) ev.push({ at: l.at, who: l.nodeId, type: 'thought', text: l.text, taskId });
      else if (l.kind === 'tool') ev.push({ at: l.at, who: l.nodeId, type: 'tool', label: toolLabel(l.text), text: l.text, taskId });
      else if (l.kind === 'tool_result' || l.kind === 'tool_error') { const p = ev[ev.length - 1]; if (p && p.type === 'tool' && p.who === l.nodeId && p.result == null) p.result = l.text; }
      else if (l.kind === 'error') ev.push({ at: l.at, who: l.nodeId, type: 'error', text: l.text, taskId });
    }
    // Nest sub-subagents under their parent bubble (matched by records, never arrival order).
    if (recOf) {
      const nested = new Set();
      for (const [sid, e] of sub) { const p = recOf(sid) && recOf(sid).parentAgentId; if (p && sub.has(p)) { (sub.get(p).children ||= []).push(e); nested.add(sid); } }
      for (let i = ev.length - 1; i >= 0; i--) if (ev[i].type === 'subagent' && nested.has(ev[i].subagentId)) ev.splice(i, 1);
    }
    for (const m of messages || []) ev.push({ at: ms(m.at), who: m.from, to: m.to, type: 'message', text: m.text, atts: m.attachments || null, taskId: m.taskId || null });
    for (const t of tasks || []) {
      if (t.createdBy) ev.push({ at: ms(t.createdAt), who: t.createdBy, to: t.assignee, type: 'handoff', text: t.title, taskId: t.id });
      for (const c of t.comments || []) ev.push({ at: ms(c.at), who: c.author, type: 'comment', text: c.text, atts: c.attachments || null, taskId: t.id });
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

  // Fixed syntax: plain text = message to the core agent; "/task text" = task for the core agent;
  // "@Name text" = message to Name; "@Name? text" = the same message (kept for habit); "@Name! text"
  // = task for Name. The core agent has nodeId/name null — the renderer resolves the head node.
  function parseComposer(text, nodes) {
    const s = String(text || '').trim(); if (!s) return null;
    let m = /^\/task(?:\s+([\s\S]*))?$/.exec(s);
    if (m) { const body = (m[1] || '').trim(); if (!body) return { kind: 'error', text: 'Say what the task should do' }; return { kind: 'task', nodeId: null, name: null, text: body }; }
    m = /^@(\S+?)([?!])?(?:\s+([\s\S]*))?$/.exec(s);
    if (m) {
      const n = (nodes || []).find((x) => x.name.toLowerCase() === m[1].toLowerCase());
      if (!n) return { kind: 'error', text: `No agent called @${m[1]}` };
      const body = (m[3] || '').trim(); if (!body) return { kind: 'error', text: `Say what you want from @${n.name}` };
      return { kind: m[2] === '!' ? 'task' : 'message', nodeId: n.id, name: n.name, text: body };
    }
    return { kind: 'message', nodeId: null, name: null, text: s };
  }
  const preview = (p) => !p ? '' : p.kind === 'task' ? `Will create a task for ${p.name || 'the core agent'}` : p.kind === 'message' ? `Will send a message to ${p.name || 'the core agent'}` : p.text;
  // @mention autocomplete: the partial "@xx" at the end of the text -> matching nodes.
  function mentionMatches(text, nodes) { const m = /(?:^|\s)@(\w*)$/.exec(String(text)); if (!m) return null; return (nodes || []).filter((n) => n.name.toLowerCase().startsWith(m[1].toLowerCase())); }

  // Signature of every input the room feed reads (pure, used by the renderer's 1s tick to skip the
  // expensive roomEvents walk + DOM rebuild when nothing changed). Task comments bump task.updatedAt,
  // logs are append/prepend/clear-only, and subagent bubbles render records from agents/runs
  // (subRecOf), so all three sources are fingerprinted here.
  function feedKey(inp) {
    const logs = inp.logs || [], tasks = inp.tasks || [], messages = inp.messages || [], inbox = inp.inbox || [];
    const subRecs = (holder) => (holder.subagents || []).map((x) => [x.id, x.status || '', x.endedAt || 0, x.tokens ? (x.tokens.inputTokens || 0) + (x.tokens.outputTokens || 0) : 0]);
    return JSON.stringify([
      inp.projectId, inp.thread || null,
      logs.length, logs.length ? logs[0].at : null, logs.length ? logs[logs.length - 1].at : null,
      tasks.map((t) => [t.id, t.updatedAt, (t.comments || []).length]),
      messages.length, messages.length ? messages[messages.length - 1].at : null,
      inbox.map((i) => i.id),
      (inp.nodes || []).map((n) => [n.id, n.name, n.role]),
      [...(inp.working || [])].sort(),
      ...Object.values(inp.agents || {}).flatMap(subRecs),
      ...(inp.runs || []).flatMap(subRecs),
    ]);
  }

  // Windowing (t_fb193107): the room renders only the last `win` events; scrolling near the top
  // prepends the next older page (grow `win` by PAGE) while the scroll anchor keeps the viewport
  // on the same content. Pure so renderer and tests share one implementation.
  const PAGE = 100;
  function pageOf(events, win) {
    const start = Math.max(0, events.length - Math.max(1, win | 0));
    return { items: events.slice(start), hidden: start };
  }
  // After a re-render that added `newHeight - prevHeight` px above the viewport, the scrollTop that
  // keeps the previously-visible content in place. Clamped at 0 (content shrank / scrolled past top).
  const anchorScroll = (prevTop, prevHeight, newHeight) => Math.max(0, newHeight - prevHeight + prevTop);

  // Fingerprint of everything a drawn bubble reads from its event, plus the live subagent-record
  // state (status/tokens/endedAt) when the caller can resolve records. The renderer stores one fp
  // per drawn event (mirroring the DOM exactly), so the next draw can diff the feed against the
  // DOM with string compares instead of rebuilding every group.
  function eventFp(e, recOf) {
    let s = `${e.who}|${e.at}|${e.type}|${e.count || 1}|${e.result != null ? 1 : 0}|${e.total || 0}|${String(e.text || '').slice(0, 48)}|${e.inboxId || ''}`;
    if (e.type === 'subagent' && recOf) { const r = recOf(e.subagentId); s += '|' + (r ? `${r.status || ''}|${r.tokens ? (r.tokens.inputTokens || 0) + (r.tokens.outputTokens || 0) : 0}|${r.endedAt || 0}` : 'x'); }
    return s;
  }

  // Append/patch room update (t_1fb02462, extends t_fe51eee9): plan the minimal DOM change that
  // turns the drawn room into pageOf(ev, win) instead of rebuilding every group. domFp is the
  // per-event fingerprint list the renderer stored at draw time — it mirrors the DOM exactly,
  // including the front drift whole-group eviction leaves behind. The DOM's events sit inside the
  // fresh window at some offset — the slide — located by finding the first target event whose fp
  // already exists in the DOM; from there the fp-aligned stretch is verified event by event.
  // Returns null whenever alignment fails (rescope, backfilled older events) — the caller must do
  // the full render, which is always correct. On success:
  // { target, slide, alignFrom, alignLen } — the DOM keeps groups whose events sit fully inside
  // [slide + alignFrom, slide + alignFrom + alignLen), whole-group evicts what fits before slide
  // (a straddling group survives as front drift, the next plan call locates it), and re-renders
  // from the first group that isn't confirmed — mutated older bubbles (late tool results,
  // subagent totals/record state) patch in place from their group boundary instead of forcing a
  // whole-room rebuild. That rebuild was the #1 streaming long task in Quinn's real-agent trace
  // (t_f4f6d15e). alignFrom > 0 only when target[0..alignFrom) themselves mutated (front of the
  // window): they re-render as part of the rebuild region.
  function tailPlan(domFp, ev, win, recOf = null) {
    if (!domFp || !domFp.length || !ev.length) return null;
    const target = pageOf(ev, Math.max(1, win | 0)).items;
    if (!target.length) return null;
    let slide = -1, off = 0;
    for (let t = 0; t < target.length && t < 24; t++) { // a mutated front must not hide a live anchor deeper in
      const i = domFp.indexOf(eventFp(target[t], recOf));
      if (i >= 0 && i - t < 0) return null; // the window reaches before the DOM: backfill, rebuild
      if (i >= 0) { slide = i - t; off = t; break; }
    }
    if (slide < 0) return null;
    // target[j] sits at DOM position j + slide; verify the stretch from the anchor onward.
    const align = Math.min(domFp.length - slide - off, target.length - off);
    let stable = 0;
    while (stable < align && eventFp(target[off + stable], recOf) === domFp[slide + off + stable]) stable++;
    if (!stable) return null;
    return { target, slide, alignFrom: off, alignLen: stable };
  }

  // Older-page request (chatGrow): plan prepending the next older window slice to the drawn room
  // without a full rebuild (the scroll-up prepend was a whole-room innerHTML at feed scale — the
  // 1.3s worst frame in Quinn's trace). The DOM's events must be exactly the fp-matching tail of
  // the grown window; anything else (a simultaneous append, a mutated bubble) returns null and the
  // caller does the full render. Slice and target are the DOM-verified older page and full window.
  function prependPlan(domFp, ev, win, recOf = null) {
    if (!domFp || !domFp.length || !ev.length) return null;
    const target = pageOf(ev, Math.max(1, win | 0)).items;
    const add = target.length - domFp.length;
    if (add <= 0) return null;
    for (let i = 0; i < domFp.length; i++) if (domFp[i] !== eventFp(target[add + i], recOf)) return null;
    return { target, slice: target.slice(0, add) };
  }

  // Progressive first paint (t_7e53747c): split a full page into {head, tail} at a group boundary
  // so the newest ~tailMin events render first and the older half prepends next frame. The seam is
  // walked back past same-author non-question neighbours — mergeGroups re-joins those, so a seam
  // there would render an extra header and un-merged repeats that one full render never shows.
  // Returns null below minLen (single-phase render) or when no split point exists.
  function splitPage(items, minLen = 60, tailMin = 36) {
    if (!items || items.length < minLen) return null;
    const groups = group(items);
    let n = 0, cut = 0;
    for (let gi = groups.length - 1; gi >= 0; gi--) { n += groups[gi].items.length; if (n >= tailMin) { cut = gi; break; } }
    while (cut > 0 && groups[cut].who === groups[cut - 1].who && groups[cut].items[0].type !== 'question' && groups[cut - 1].items[0].type !== 'question') cut--;
    if (cut <= 0) return null;
    return { head: groups.slice(0, cut).flatMap((g) => g.items), tail: groups.slice(cut).flatMap((g) => g.items) };
  }

  // Collapse consecutive identical messages (same type/target/text) from one author into one bubble + a ×N
  // badge at the end. Messages carrying attachments never collapse (each file needs its own thumbs).
  const collapseRepeats = (items) => items.reduce((out, it) => { const p = out[out.length - 1]; if (p && p.type === it.type && p.text === it.text && p.to === it.to && !p.atts && !it.atts && it.type !== 'tool' && it.type !== 'question' && it.type !== 'subagent') p.count = (p.count || 1) + 1; else out.push({ ...it }); return out; }, []);
  return { avatarColor, initials, toolLabel, roomEvents, group, splitPage, parseComposer, preview, mentionMatches, fmtSize, fileUrl, attThumbs, collapseRepeats, GROUP_MS, MAX, PAGE, pageOf, anchorScroll, eventFp, tailPlan, prependPlan, feedKey };
});

