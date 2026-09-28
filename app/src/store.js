// JSON-file store shared by the Electron main process and MCP server processes.
// Layout: <dir>/team.json, board.json, wiki.json, settings.json
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const C = require('./controls');
const U = require('./usage');
const TL = require('./timeline');
const PRESET_FIELDS = ['systemPrompt', 'allowedTools', 'disallowedTools', 'permissionMode'];
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const { normalizeNode, normalizePatch, normalizePreset, applyPreset, EDGE_TYPES, SUGGESTED_ROLES } = require('./agent-config');
const WT = require('./worktree');

const ROLES = SUGGESTED_ROLES; // suggestions only: roles are free text
const STATUSES = ['todo', 'in_progress', 'review', 'done', 'waiting_for_human', 'merge_conflict'];

function defaultProjectDir(name = 'default') {
  return path.join(os.homedir(), '.agents-squad', name);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const id = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;

class Store {
  // teamId: which team graph this store edits. Without it, getTeam() returns the union of all
  // teams in the project (used by the orchestrator and MCP server: node ids are globally unique).
  constructor(dir, teamId = null) {
    this.dir = dir;
    this.teamId = teamId;
    fs.mkdirSync(dir, { recursive: true });
  }
  forTeam(teamId) { return new Store(this.dir, teamId); }
  meta() { return this.read('project', null); }
  teamFile() {
    if (this.teamId) return 'team-' + this.teamId;
    const m = this.meta();
    return m && m.teams && m.teams[0] ? 'team-' + m.teams[0].id : 'team';
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  read(name, dflt) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return dflt; }
  }
  write(name, data) {
    const tmp = this.file(name) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file(name));
  }
  // cross-process mutex (mkdir is atomic)
  withLock(fn) {
    const lock = path.join(this.dir, '.lock');
    const start = Date.now();
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (Date.now() - start > 5000) { try { fs.rmdirSync(lock); } catch {} continue; } // stale
        sleepSync(10);
      }
    }
    try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
  }
  update(name, dflt, fn) {
    return this.withLock(() => { const d = this.read(name, dflt); const r = fn(d); this.write(name, d); return r; });
  }

  // ---- team ----
  getTeam() {
    if (!this.teamId) {
      const m = this.meta();
      if (m && m.teams && m.teams.length) {
        const all = { nodes: [], edges: [] };
        for (const t of m.teams) { const g = this.read('team-' + t.id, { nodes: [], edges: [] }); all.nodes.push(...g.nodes.map((n) => ({ ...n, teamId: t.id }))); all.edges.push(...g.edges); }
        return all;
      }
    }
    return this.read(this.teamFile(), { nodes: [], edges: [] });
  }
  saveTeam(team) { this.withLock(() => this.write(this.teamFile(), team)); return team; }
  addNode(n) {
    const presets = this.getSettings().rolePresets;
    const node = { id: n.id || id('n'), ...normalizeNode(applyPreset(n, presets)), x: n.x ?? 80, y: n.y ?? 80 };
    this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => { t.nodes.push(node); });
    return node;
  }
  // Changing the role to a preset's name fills the node's empty prompt / tools / permission mode from that preset.
  updateNode(nid, patch) {
    const p = normalizePatch(patch); const presets = this.getSettings().rolePresets;
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      const n = t.nodes.find((x) => x.id === nid); if (!n) throw new Error('no node');
      const roleChanged = p.role !== undefined && String(p.role).toLowerCase() !== String(n.role || '').toLowerCase();
      Object.assign(n, p, { id: nid });
      if (roleChanged) Object.assign(n, normalizePatch(pick(applyPreset(n, presets), PRESET_FIELDS)));
      return n;
    });
  }
  removeNode(nid) {
    this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => { t.nodes = t.nodes.filter((n) => n.id !== nid); t.edges = t.edges.filter((e) => e.from !== nid && e.to !== nid); });
    for (const tid of this.teamIds()) if ('team-' + tid !== this.teamFile()) this.update('team-' + tid, { nodes: [], edges: [] }, (t) => { t.edges = t.edges.filter((e) => e.to !== nid); });
  }
  teamIds() { const m = this.meta(); return (m && m.teams || []).map((t) => t.id); }
  teamName(tid) { const m = this.meta(); const t = m && m.teams && m.teams.find((x) => x.id === tid); return t ? t.name : null; }
  nodeTeam(nid) { return this.teamIds().find((tid) => this.read('team-' + tid, { nodes: [] }).nodes.some((n) => n.id === nid)) || null; }
  // {nodeId: {teamId, teamName}} for every node across all teams; used to tag log/timeline entries for renderer filtering.
  nodeTeamMap() {
    const out = {};
    for (const tid of this.teamIds()) {
      const teamName = this.teamName(tid);
      for (const n of this.read('team-' + tid, { nodes: [] }).nodes) out[n.id] = { teamId: tid, teamName };
    }
    return out;
  }
  // Edges from other teams that point into this team (stored in the source team's file), flagged crossTeam.
  incomingCrossEdges() {
    const mine = new Set(this.getTeam().nodes.map((n) => n.id)); const out = [];
    for (const tid of this.teamIds()) if ('team-' + tid !== this.teamFile()) for (const e of this.read('team-' + tid, { edges: [] }).edges) if (mine.has(e.to)) out.push({ ...e, crossTeam: true, fromTeam: tid });
    return out;
  }
  // Canvas viewport { x, y, zoom } persisted per team graph.
  getViewport() { return this.read(this.teamFile(), {}).viewport || null; }
  setViewport(v) {
    const vp = { x: Number(v.x) || 0, y: Number(v.y) || 0, zoom: Math.min(4, Math.max(0.1, Number(v.zoom) || 1)) };
    this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => { t.viewport = vp; }); return vp;
  }
  // Bulk position save after drag / auto-layout: { nodeId: { x, y } }.
  setPositions(pos) {
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      for (const n of t.nodes) { const p = pos[n.id]; if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) { n.x = +p.x; n.y = +p.y; } }
      return t.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
    });
  }
  // type: assign (can create tasks for target, implies message), message (send_message only), review (target reviews source's tasks)
  addEdge(from, to, type = 'assign') {
    if (!EDGE_TYPES.includes(type)) throw new Error('bad edge type ' + type);
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      if (from === to) throw new Error('self edge not allowed');
      // source must be in this team; target may be in any team of the project (cross-team edge)
      if (!t.nodes.find((n) => n.id === from) || !(t.nodes.find((n) => n.id === to) || this.nodeTeam(to))) throw new Error('unknown node');
      let e = t.edges.find((x) => x.from === from && x.to === to && (x.type || 'assign') === type);
      if (!e) { e = { id: id('e'), from, to, type }; t.edges.push(e); }
      return e;
    });
  }
  updateEdge(eid, patch) {
    if (patch.type !== undefined && !EDGE_TYPES.includes(patch.type)) throw new Error('bad edge type ' + patch.type);
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      const e = t.edges.find((x) => x.id === eid); if (!e) throw new Error('no edge');
      if (patch.type && t.edges.some((x) => x !== e && x.from === e.from && x.to === e.to && (x.type || 'assign') === patch.type)) throw new Error('an edge of that type already exists');
      if (patch.type) e.type = patch.type;
      return e;
    });
  }
  removeEdge(eid) { this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => { t.edges = t.edges.filter((e) => e.id !== eid); }); }

  // ---- board ----
  listTasks(filter = {}) {
    let ts = this.read('board', { tasks: [] }).tasks;
    if (filter.status) ts = ts.filter((t) => t.status === filter.status);
    if (filter.assignee) ts = ts.filter((t) => t.assignee === filter.assignee);
    return ts;
  }
  getTask(tid) { return this.listTasks().find((t) => t.id === tid); }
  createTask({ title, description = '', assignee = null, createdBy = 'human', parentId = null, blockedBy = [], priority }) {
    if (!title) throw new Error('title required');
    const now = new Date().toISOString();
    const task = { id: id('t'), title, description, assignee, status: 'todo', priority: C.normalizePriority(priority), createdBy, parentId, blockedBy: [], comments: [], createdAt: now, updatedAt: now };
    this.update('board', { tasks: [] }, (b) => { task.blockedBy = C.validateDeps(task.id, blockedBy, b.tasks); b.tasks.push(task); });
    return task;
  }
  updateTask(tid, patch) {
    let t = this._updateTask(tid, patch);
    // Every approval request also shows up in the human inbox.
    if (patch.awaitingApproval && !this.listInbox({ status: 'open' }).some((i) => i.kind === 'approval' && i.taskId === tid)) this.addInbox({ kind: 'approval', taskId: tid, nodeId: t.assignee, question: `Approve "${t.title}"?`, choices: ['approve'] });
    // Never strand finished work in its worktree branch: auto-merge on done, or park as merge_conflict.
    if (patch.status === 'done' && t.worktreePath && t.worktreeBranch) t = this._mergeOnDone(t);
    return t;
  }
  // Merge a done task's squad/<id> branch into base. On conflict, abort, mark the task 'merge_conflict'
  // (not done) and hand the SAME branch to a follow-up conflict-resolution task (never a new branch),
  // so resolving it re-merges the original work instead of stranding it behind a chain of tasks.
  _mergeOnDone(t) {
    try {
      WT.worktreeMerge(t);
      this.commentTask(t.id, 'system', `auto-merged ${t.worktreeBranch} into base`);
      return this.getTask(t.id);
    } catch (e) {
      return this._onMergeConflict(t, e);
    }
  }
  static MAX_CONFLICT_RETRIES = 3;
  _onMergeConflict(t, e) {
    this._updateTask(t.id, { status: 'merge_conflict' });
    this.commentTask(t.id, 'system', `auto-merge blocked, task moved to merge_conflict: ${e.message}`);
    // A resolve task's own completion re-runs this same merge. If it still conflicts, reopen the
    // *same* task (bounded retries) instead of spawning another "Resolve merge conflict: ..." task.
    if (t.isConflictResolution) {
      const retries = (t.conflictRetries || 0) + 1;
      if (retries >= Store.MAX_CONFLICT_RETRIES) {
        this.commentTask(t.id, 'system', `merge of ${t.worktreeBranch} still conflicts after ${retries} attempts; escalating to a human instead of retrying again.`);
        this.askHuman({ taskId: t.id, nodeId: t.assignee, question: `Merge conflict on ${t.worktreeBranch} persists after ${retries} attempts: ${e.message}. Please resolve manually.` });
        return this.getTask(t.id);
      }
      this.commentTask(t.id, 'system', `still conflicts; reopening this same task to retry resolving ${t.worktreeBranch} (attempt ${retries}/${Store.MAX_CONFLICT_RETRIES}).`);
      return this._updateTask(t.id, { status: 'todo', conflictRetries: retries });
    }
    // Dedupe by branch + flag (not by title prefix): at most one open resolve task per branch.
    const dup = this.listTasks().find((x) => x.isConflictResolution && x.conflictBranch === t.worktreeBranch && x.status !== 'done');
    if (dup) {
      this.commentTask(t.id, 'system', `an open resolve task already exists for ${t.worktreeBranch} (${dup.id}); not creating another.`);
      return this.getTask(t.id);
    }
    const baseTitle = t.title.replace(/^Resolve merge conflict:\s*/, '');
    const task = this.createTask({
      title: `Resolve merge conflict: ${baseTitle}`,
      description: `Auto-merge of ${t.worktreeBranch} failed:\n${e.message}\n\nResolve the conflict directly on ${t.worktreeBranch} (rebase on the base branch, fix conflicts, commit), then mark this task done — that re-runs the merge of the SAME branch. Do not create another conflict task.`,
      assignee: t.assignee, createdBy: 'system', parentId: t.id,
    });
    this._updateTask(task.id, { isConflictResolution: true, conflictBranch: t.worktreeBranch, worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
    return this.getTask(t.id);
  }
  // Unmerged squad/<id> branches across every git repo referenced by a task's worktreePath.
  listUnmergedBranches() {
    const roots = new Set(this.listTasks().filter((t) => t.worktreePath).map((t) => path.resolve(t.worktreePath, '..', '..', '..')));
    return [...roots].flatMap((root) => WT.unmergedSquadBranches(root));
  }
  _updateTask(tid, patch) {
    return this.update('board', { tasks: [] }, (b) => {
      const t = b.tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      if (patch.status && !STATUSES.includes(patch.status)) throw new Error('bad status ' + patch.status);
      if (patch.blockedBy !== undefined) t.blockedBy = C.validateDeps(tid, patch.blockedBy, b.tasks);
      if (patch.status && patch.status !== 'review') t.awaitingApproval = false;
      if (patch.priority !== undefined) t.priority = C.normalizePriority(patch.priority);
      for (const k of ['title', 'description', 'assignee', 'status', 'sessionId', 'iterations', 'awaitingApproval', 'reopenCount', 'worktreePath', 'worktreeBranch', 'isConflictResolution', 'conflictBranch', 'conflictRetries', 'parkedForHuman']) if (patch[k] !== undefined) t[k] = patch[k];
      t.updatedAt = new Date().toISOString();
      // Parent auto-complete: when the last open subtask is done, the parent moves to done.
      for (let c = t; c.status === 'done' && c.parentId;) {
        const parent = b.tasks.find((x) => x.id === c.parentId);
        if (!parent || parent.status === 'done' || b.tasks.some((x) => x.parentId === parent.id && x.status !== 'done')) break;
        parent.status = 'done'; parent.awaitingApproval = false; parent.updatedAt = t.updatedAt; c = parent;
      }
      return t;
    });
  }
  deleteTask(tid) { this.update('board', { tasks: [] }, (b) => { b.tasks = b.tasks.filter((t) => t.id !== tid); for (const t of b.tasks) if (t.blockedBy) t.blockedBy = t.blockedBy.filter((x) => x !== tid); }); }
  // Human approval gate: approve -> done, reject -> todo (with the note as a comment, so the agent reworks it).
  approveTask(tid, approve = true, note = '') {
    const t = this.getTask(tid); if (!t) throw new Error('no task ' + tid);
    if (note || !approve) this.commentTask(tid, 'human', (approve ? 'Approved' : 'Changes requested') + (note ? ': ' + note : ''));
    this.closeInbox((i) => i.kind === 'approval' && i.taskId === tid && i.status === 'open', approve ? 'approved' : 'changes requested');
    // "reopened": sent back for changes at least once, so it can't count as first-pass-accepted in modelStats.
    if (!approve) this._updateTask(tid, { reopenCount: (t.reopenCount || 0) + 1 });
    return this.updateTask(tid, { status: approve ? 'done' : 'todo', awaitingApproval: false });
  }

  // ---- human inbox: questions (ask_human) and approval requests ----
  listInbox(filter = {}) { let xs = this.read('inbox', { items: [] }).items; if (filter.status) xs = xs.filter((i) => i.status === filter.status); return xs; }
  getInboxItem(iid) { return this.listInbox().find((i) => i.id === iid); }
  addInbox({ kind = 'question', taskId = null, nodeId = null, question, choices = [] }) {
    if (!question) throw new Error('question required');
    const item = { id: id('q'), kind, taskId, nodeId, question, choices: (choices || []).map(String), status: 'open', answer: null, at: new Date().toISOString() };
    this.update('inbox', { items: [] }, (d) => { d.items.push(item); });
    return item;
  }
  closeInbox(match, answer) { this.update('inbox', { items: [] }, (d) => { for (const i of d.items) if (match(i)) Object.assign(i, { status: 'answered', answer, answeredAt: new Date().toISOString() }); }); }
  // ask_human: store the question and park the task in waiting_for_human.
  askHuman({ taskId, nodeId, question, choices }) {
    const item = this.addInbox({ kind: 'question', taskId, nodeId, question, choices });
    if (taskId && this.getTask(taskId)) this.updateTask(taskId, { status: 'waiting_for_human' });
    return item;
  }
  // Answer an item. Questions: the task goes back to in_progress (the blocked agent tool call returns the answer).
  // Approvals: answer 'approve' / anything else = changes requested with that note.
  answerInbox(iid, answer) {
    const it = this.getInboxItem(iid); if (!it) throw new Error('no inbox item ' + iid);
    if (it.status !== 'open') throw new Error('already answered');
    answer = String(answer ?? '').trim(); if (!answer) throw new Error('answer required');
    if (it.kind === 'approval') { const ok = answer === 'approve'; return this.approveTask(it.taskId, ok, ok ? '' : answer); }
    this.closeInbox((i) => i.id === iid, answer);
    const t = it.taskId && this.getTask(it.taskId);
    if (t) { this.commentTask(t.id, 'human', `Q: ${it.question}\nA: ${answer}`); if (t.status === 'waiting_for_human') this.updateTask(t.id, { status: 'in_progress' }); }
    return this.getInboxItem(iid);
  }
  commentTask(tid, author, text) {
    return this.update('board', { tasks: [] }, (b) => {
      const t = b.tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      const c = { author, text, at: new Date().toISOString() }; t.comments.push(c); t.updatedAt = c.at; return c;
    });
  }

  // ---- messages (agent to agent, scope checked in board-tools) ----
  listMessages(filter = {}) {
    let ms = this.read('messages', { messages: [] }).messages;
    if (filter.to) ms = ms.filter((m) => m.to === filter.to);
    if (filter.from) ms = ms.filter((m) => m.from === filter.from);
    return ms;
  }
  sendMessage({ from, to, text, taskId = null }) {
    if (!text) throw new Error('text required');
    const m = { id: id('m'), from, to, text, taskId, at: new Date().toISOString(), read: false };
    this.update('messages', { messages: [] }, (d) => { d.messages.push(m); });
    return m;
  }
  markMessagesRead(ids) {
    const set = new Set(ids); if (!set.size) return;
    this.update('messages', { messages: [] }, (d) => { for (const m of d.messages) if (set.has(m.id)) m.read = true; });
  }

  // ---- wiki ----
  listWiki() { return this.read('wiki', { pages: {} }).pages; }
  readWiki(title) { return this.listWiki()[title] || null; }
  writeWiki(title, content, author = 'human') {
    if (!title) throw new Error('title required');
    return this.update('wiki', { pages: {} }, (w) => { w.pages[title] = { title, content, author, updatedAt: new Date().toISOString() }; return w.pages[title]; });
  }
  deleteWiki(title) { this.update('wiki', { pages: {} }, (w) => { delete w.pages[title]; }); }
  // Page list without body content, newest first: [{title, author, updatedAt}].
  listWikiSummaries() {
    return Object.values(this.listWiki())
      .map((p) => ({ title: p.title, author: p.author || '', updatedAt: p.updatedAt || null }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  // Case-insensitive full-text search over title + content. Returns matches with a short snippet
  // around the first hit, newest first.
  searchWiki(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const p of Object.values(this.listWiki())) {
      const content = p.content || '';
      const hitTitle = p.title.toLowerCase().includes(q);
      const idx = content.toLowerCase().indexOf(q);
      if (!hitTitle && idx < 0) continue;
      const at = idx >= 0 ? idx : 0;
      const start = Math.max(0, at - 40);
      const snippet = (start > 0 ? '…' : '') + content.slice(start, at + q.length + 40).trim() + (start + 80 < content.length ? '…' : '');
      out.push({ title: p.title, author: p.author || '', updatedAt: p.updatedAt || null, snippet });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // ---- usage: one record per claude run (see usage.js), newest last, capped ----
  addRun(r) { this.update('runs', { runs: [] }, (d) => { d.runs.push(r); if (d.runs.length > 5000) d.runs.splice(0, d.runs.length - 5000); }); return r; }
  listRuns(filter = {}) {
    let rs = this.read('runs', { runs: [] }).runs;
    for (const k of ['nodeId', 'taskId', 'billingSource', 'kind']) if (filter[k]) rs = rs.filter((r) => r[k] === filter[k]);
    return rs;
  }
  clearRuns() { this.update('runs', { runs: [] }, (d) => { d.runs = []; }); }

  // ---- persisted orchestrator log (logs.jsonl, trimmed to the last LOG_CAP lines) ----
  appendLog(l) {
    const f = path.join(this.dir, 'logs.jsonl');
    fs.appendFileSync(f, C.logLine(l) + '\n');
    try { if (fs.statSync(f).size > 3e6) { const keep = C.parseLogs(fs.readFileSync(f, 'utf8'), C.LOG_CAP); this.withLock(() => fs.writeFileSync(f, keep.map(C.logLine).join('\n') + '\n')); } } catch {}
  }
  // level (info/warn/error, derived from kind via TL.levelOf) lets the UI default its filter to warn+error.
  readLogs(limit = 2000) {
    try { return C.parseLogs(fs.readFileSync(path.join(this.dir, 'logs.jsonl'), 'utf8'), limit).map((l) => ({ ...l, level: TL.levelOf(l.kind) })); } catch { return []; }
  }
  clearLogs() { try { fs.unlinkSync(path.join(this.dir, 'logs.jsonl')); } catch {} }

  // ---- sessions: claude sessions grouped from persisted runs (see usage.js newRun) ----
  // One entry per distinct sessionId, newest first: [{sessionId, nodeId, agent, taskId, task, startedAt, endedAt, model, models, runs, reportedCostUsd, totalTokens}].
  listSessions(filter = {}) {
    const rs = this.listRuns({ nodeId: filter.nodeId }).filter((r) => r.kind === 'agent' && r.sessionId);
    const byId = new Map();
    for (const r of rs) {
      const s = byId.get(r.sessionId) || { sessionId: r.sessionId, nodeId: r.nodeId, agent: r.agent || '', taskId: r.taskId || null, task: r.task || '', startedAt: r.startedAt || null, endedAt: r.endedAt || null, models: [], runs: 0, reportedCostUsd: 0, totalTokens: 0 };
      s.runs++; s.reportedCostUsd += r.reportedCostUsd || 0; s.totalTokens += U.totalTokens(r);
      if (r.startedAt && (!s.startedAt || r.startedAt < s.startedAt)) s.startedAt = r.startedAt;
      if (r.endedAt && (!s.endedAt || r.endedAt > s.endedAt)) s.endedAt = r.endedAt;
      if (r.taskId) { s.taskId = r.taskId; s.task = r.task || s.task; } // last run's task wins
      for (const m of r.model ? [r.model] : []) if (!s.models.includes(m)) s.models.push(m);
      byId.set(r.sessionId, s);
    }
    return [...byId.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
  // Full conversation/log for one session, paginated oldest-first: {total, offset, limit, entries}.
  // Bounded by the session's runs' [startedAt, endedAt] window on that node (only one run is active per node at a time).
  getSessionLog(sessionId, { offset = 0, limit = 200 } = {}) {
    const rs = this.listRuns().filter((r) => r.sessionId === sessionId);
    if (!rs.length) return { total: 0, offset, limit, entries: [] };
    const nodeId = rs[0].nodeId;
    const startMs = Math.min(...rs.map((r) => (r.startedAt ? Date.parse(r.startedAt) : Infinity)));
    const endsOpen = rs.some((r) => !r.endedAt);
    const endMs = endsOpen ? Infinity : Math.max(...rs.map((r) => Date.parse(r.endedAt)));
    const all = this.readLogs(Infinity).filter((l) => l.nodeId === nodeId && l.at >= startMs && l.at <= endMs);
    const entries = TL.logEntries(all.slice(offset, offset + limit));
    return { total: all.length, offset, limit, entries };
  }

  // ---- settings ----
  getSettings() { return { claudePath: 'claude', maxConcurrency: 8, maxRuns: 30, permissionMode: 'bypassPermissions', rolePresets: [], budgetUsd: 0, budgetTokens: 0, requireApproval: false, useWorktrees: false, usageLimits: {}, autoCompactPct: 40, autoRestart: false, ...this.read('settings', {}) }; }
  saveSettings(s) {
    const next = { ...this.getSettings(), ...s };
    if (s.rolePresets) {
      next.rolePresets = s.rolePresets.map(normalizePreset);
      const names = next.rolePresets.map((p) => p.name.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error('duplicate preset name');
    }
    this.withLock(() => this.write('settings', next)); return this.getSettings();
  }
  // Role presets are per project (stored in settings.json).
  savePreset(p) { const np = normalizePreset(p); const rest = this.getSettings().rolePresets.filter((x) => x.name.toLowerCase() !== np.name.toLowerCase()); return this.saveSettings({ rolePresets: [...rest, np] }).rolePresets; }
  deletePreset(name) { return this.saveSettings({ rolePresets: this.getSettings().rolePresets.filter((x) => x.name !== name) }).rolePresets; }
}

module.exports = { Store, ROLES, STATUSES, PRIORITIES: C.PRIORITIES, defaultProjectDir };
