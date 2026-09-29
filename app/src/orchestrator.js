// Scheduler: runs Claude Code agents for todo tasks until the board is drained or stop() is called.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { outgoing, incoming, reviewees } = require('./scope');
const { buildClaudeArgs, applyPreset, normalizeNode } = require('./agent-config');
const { enabledTools } = require('./board-tools');
const { normalizeMode, iterationPrompt, nextStep, judgeArgs, parseJudge, isLastLoop } = require('./agent-modes');
const U = require('./usage');
const TL = require('./timeline');
const PF = require('./preflight');
const C = require('./controls');
const IDLE = require('./idle');
const WT = require('./worktree');
const RT = require('./runtimes');
const CAP = require('./capabilities');
const { SubagentTracker, isSubagentTool } = require('./subagents');

const MCP_SERVER = path.join(__dirname, 'mcp-server.js');

// 'ps -o time=' CPU time, e.g. '12:05.44' (MM:SS.cc) or '1:02:03' (H:MM:SS) -> ms.
function stimeToMs(s) {
  const seg = String(s || '').trim().split(':');
  if (!seg[seg.length - 1]) return null;
  const last = seg.pop().split('.');
  const secs = Number(last[0]) + Number('0.' + (last[1] || '0'));
  const mins = Number(seg.pop() || 0), hrs = Number(seg.pop() || 0);
  return Math.round(((hrs * 60 + mins) * 60 + secs) * 1000);
}

// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value for a configured percent. claude 2.1.284 parses the env as a
// percent (0-100], not a fraction: threshold = min(floor(window * pct/100), window - 13000). The CLI
// applies no floor of its own, and a threshold at/below a session's ~25-30k baseline compacts at once
// and re-compacts forever — "Autocompact is thrashing" agent death (reproduced live: env=0.4 on a 1M
// window is 4k tokens and compacted at pre_tokens 30414). Sending the old fraction format ("0.4") is
// exactly what thrashed agents; the env must carry the percent. Tiny percents are floored at 10%
// (100k of a 1M window, safely above the baseline; windows under ~300k could still dip below it, but
// that takes deliberately pairing a small window with a small pct) and clamped into the CLI's accepted
// band so odd settings values degrade to a sane threshold.
function autoCompactEnv(pct) {
  return String(Math.min(100, Math.max(10, Math.round(pct))));
}

// Wake-on-message: how often the orchestrator looks for unread agent->agent messages, how long a burst
// may coalesce into one dispatch, and the ping-pong guard (max auto-wakes per sender->recipient pair
// per window). MIN_GAP_MS is the per-recipient wake debounce: after an agent-to-agent wake, that
// agent is not auto-woken again for at least this long — further messages accumulate unread in its
// inbox until the interval passes (or the agent is dispatched for a task, whose prompt carries them).
// Human wakes (ask_human answers, chat) and task dispatch bypass the interval; nudge wakes (idle/
// stale watchdog) defer to it in nudgeIdle — a changed idle set must not re-wake a just-woken core.
// Exported so tests can shorten the timings.
const WAKE = { SWEEP_MS: 1000, DEBOUNCE_MS: 1500, MIN_GAP_MS: 5 * 60 * 1000, MAX_PER_PAIR: 3, PAIR_WINDOW_MS: 10 * 60 * 1000 };

// The run's board MCP server is a long-lived stdio helper the CLI spawns for the whole session
// (mcpConfig: <exec> src/mcp-server.js --project <dir> --node <id>). It idles between calls, so its
// being alive says nothing about run progress — leave its whole subtree out of the stall liveness
// scan, or a hung CLI that owns one is never recovered.
const isBoardHelper = (r) => !!r.command && /mcp-server\.js/.test(r.command) && r.command.includes('--project') && r.command.includes('--node');

// Stall watchdog: how often a working agent is checked for silence, how long a SIGTERM'd stalled run
// gets to exit before SIGKILL, and the max automatic stop+resume recoveries per task (persisted there).
const STALL = { SWEEP_MS: 5000, SIGKILL_GRACE_MS: 8000, MAX_RECOVERIES: 2 };

function buildPrompt(team, node, task, extra = {}) {
  node = { ...normalizeNode(applyPreset(node, extra.presets)), id: node.id };
  const nm = (id) => { const n = team.nodes.find((x) => x.id === id); return n ? `${n.name} (${n.role}, id=${n.id})` : id; };
  const outs = outgoing(team, node.id).map(nm);
  const ins = incoming(team, node.id).map(nm);
  const msgTo = outgoing(team, node.id, ['assign', 'message']).map(nm);
  const revs = reviewees(team, node.id).map(nm);
  const unread = extra.unread || 0;
  const tools = enabledTools(node);
  const roleHints = {
    PM: 'You own the goal. Break it into concrete tasks and assign them to your teammates with create_task. Do not write code yourself if a Dev is available. If a Critic is on the team: first create a plan-review task for the Critic and make every Dev task blockedBy it; finally create a Critic verification task (blockedBy the Dev tasks) that requires evidence such as screenshots before the goal is done.',
    Planner: 'Split work into small, concrete tasks and assign them to the right teammates.',
    Dev: 'Implement the task in your working directory using your tools. Keep changes minimal.',
    Reviewer: 'Review the work described in the task. Comment findings on the task.',
    Critic: 'Critique plans before work starts and verify finished work with concrete evidence (test output, screenshots). Comment findings; only mark done when the evidence holds.',
    QA: 'Verify the work actually functions. Comment results on the task.',
  };
  return [
    `You are "${node.name}", role ${node.role}, in an agent team called Colvari (your node id: ${node.id}).`,
    node.systemPrompt ? `Instructions from your manager:\n${node.systemPrompt}` : '',
    roleHints[node.role] || '',
    `Teammates you can assign tasks to: ${outs.length ? outs.join(', ') : 'none (do the work yourself)'}.`,
    `Teammates who can assign tasks to you: ${ins.length ? ins.join(', ') : 'none (the human)'}.`,
    msgTo.length ? `Teammates you can message (send_message): ${msgTo.join(', ')}.` : '',
    revs.length ? `You review the work of: ${revs.join(', ')}. You may move their tasks to review or done.` : '',
    unread ? `You have ${unread} unread message(s): call read_messages.` : '',
    '',
    `Your current task (id=${task.id}): ${task.title}`,
    task.description ? `Description:\n${task.description}` : '',
    task.attachments && task.attachments.length ? attachedFilesLines(task.attachments) : '',
    (task.blockedBy || []).length ? `This task depended on: ${task.blockedBy.join(', ')} (all done now; read their comments with list_tasks if useful).` : '',
    task.comments.length ? `Comments so far:\n${task.comments.map((c) => `- ${c.author}: ${c.text}`).join('\n')}` : '',
    '',
    `Board files: every task is one pretty-JSON file at .squad/board/tasks/<id>.json and every wiki page one markdown file at .squad/wiki/<slug>.md${extra.boardDir ? ` — this project's store dir: ${extra.boardDir}` : ''}. Read them freely with cat/grep/jq; write only via the board tools — never create or edit these files directly. Private data (direct messages, inbox) is kept outside .squad/.`,
    `Never pkill/killall/pgrep-kill by name (Electron, electron, agents-squad, node) — patterns match the user's live app and its helper processes, not just yours. To stop your own background job, kill the PID you started ($!, or kill the process group) or use your tool's job stop.`,
    extra.worktree ? `Write code only in your task worktree (your cwd). Never edit the main checkout; only the merge step changes it.` : '',
    `Coordinate ONLY through the "board" MCP tools (${tools.join(', ')}).`,
    tools.includes('update_task_status') && extra.deferDone ? `This task runs in loop mode (${extra.deferDone}). Do NOT call update_task_status with status="done" in this pass${tools.includes('comment_task') ? '; you may add a short comment on what you did' : ''}. The orchestrator repeats the task and you will be told when the final pass comes.` : '',
    tools.includes('update_task_status') && !extra.deferDone ? `When you have finished your part, ${tools.includes('comment_task') ? 'add a short comment summarising what you did and ' : ''}call update_task_status with taskId=${task.id} and status="done".` : '',
    'Be concise and finish in as few steps as possible.',
  ].filter((l) => l !== '').join('\n');
}

// Prompt lines for files already saved under <store>/attachments: absolute paths only. The agent
// reads them from disk with its own file tools (claude gets the dir via --add-dir); bytes never
// travel through the prompt.
function attachedFilesLines(atts) {
  const list = (atts || []).filter((a) => a && a.path);
  if (!list.length) return '';
  return list.map((a) => `Attached files: ${a.path}${a.mime ? ` (${a.mime}, ${a.size} bytes)` : ''}`).join('\n');
}

// Prompt for a resumed run that delivers a human message (base is included when there is no session to resume).
function humanPrompt(text, base = null, attachments = null) {
  return [base, `Message from the human operator (answer or act on it, then continue your task):\n${text}`, attachedFilesLines(attachments)].filter(Boolean).join('\n\n');
}

// Short 'continue' prompt for a stalled run resumed in the same session (the session already holds
// the full task context; this only tells the agent the previous attempt was stopped and why).
function stallPrompt(task) {
  return `Your previous run for this task (id=${task.id}) stalled (no activity for the configured stall timeout) and was stopped automatically. Continue the task from where you left off and finish it as originally instructed.`;
}

// Prompt for a wake run: an idle agent dispatched purely to handle unread teammate messages.
function wakePrompt(team, node, msgs) {
  const nm = (id) => { const n = team.nodes.find((x) => x.id === id); return n ? `${n.name} (${n.role}, id=${n.id})` : id; };
  return [
    `You are "${node.name}", role ${node.role}, in an agent team called Colvari (your node id: ${node.id}).`,
    'You were idle and have been woken by unread teammate message(s). Handle them now:',
    'reply with send_message where an answer is expected, or act on the request, then stop.',
    'Coordinate ONLY through the "board" MCP tools.',
    '',
    'Unread messages:',
    ...msgs.map((m) => ['- from ' + nm(m.from) + ': ' + m.text, attachedFilesLines(m.attachments)].filter(Boolean).join('\n')),
  ].join('\n');
}

class Orchestrator extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.running = false;
    this.procs = new Map(); // nodeId -> child
    this.agents = {}; // nodeId -> {status, cost, inputTokens, outputTokens, runs, taskId}
    this.totalCost = 0;
    this.runs = 0;
    // Seed from each node's persisted rate-limit snapshot (usage.js parseRateLimits, written by the
    // init/rate_limit_event handling below) so a restarted app shows the CLI's last-known 5h/weekly usage
    // immediately, instead of waiting for a fresh run to repopulate this in-memory map.
    this.subscriptionRateLimits = {};
    // Only restore still-live snapshots that match the node's current runtime (usage.js nodeLiveRateLimits):
    // one whose resetsAt passed while the app was down describes a window that already reset, and one captured
    // by a runtime the node has since left must not pause or meter under the new provider.
    try { for (const n of store.getTeam().nodes) { const rl = U.nodeLiveRateLimits(n); if (rl) this.subscriptionRateLimits[n.id] = rl; } } catch {}
    // Wake-on-message state: per-recipient debounce timers and per-pair ping-pong counters.
    this.userStopped = false;
    // Set by the UpdateWatcher while a self-update is pending/draining: no new dispatches (tasks or
    // wakes) until it is back to false, so the restart waits for agents instead of racing them.
    this.dispatchPaused = false;
    // Nodes whose CURRENT run was cut by a self-update drain halt (haltProcs): runTask breaks those
    // out instead of iterating/resuming them, and the run's task stays in_progress for the post-restart
    // reconcile. Per-node (not global) so a halt that spares one agent does not poison another's run.
    this.drainCutNodes = new Set();
    this.wakeTimers = new Map(); // nodeId -> { timer, dueAt } — at most one pending wake per agent
    this.wakePairs = new Map(); // 'from>to' -> {count, since}
    this.wakeLastAt = new Map(); // nodeId -> ts of the agent's last agent->agent wake dispatch
    this.wakeSuppressedLogged = new Map(); // nodeId -> ts the current suppression window was logged at
    this._wakeTimer = setInterval(() => this.sweepWakes(), WAKE.SWEEP_MS);
    if (this._wakeTimer.unref) this._wakeTimer.unref();
    // Stall watchdog state: last seen cumulative CPU time of each run's CLI process (nodeId -> {pid, cpuMs}),
    // and the pending SIGKILL grace timers for stalled runs that ignore SIGTERM.
    this._stallCpu = new Map();
    this._stallKill = new Map();
    this._stallTimer = setInterval(() => this.sweepStalls(), STALL.SWEEP_MS);
    if (this._stallTimer.unref) this._stallTimer.unref();
    // Perf (t_9d92c3d3): snapshot() runs on every changed()/getAll; its file-derived parts
    // (modelStats, timeline, wiki, nodeTeams, logs) are memoized by store file signatures so repeated
    // snapshots with unchanged files cost stats instead of re-reading and re-parsing multi-MB JSON.
    this._memo = new Map(); // key -> { sig, val }
    this._logTail = null; // { sig, size, entries } — incremental tail of logs.jsonl
  }
  // Memoize fn by a cheap signature string: recompute only when the sig differs from last time.
  // Hand-rolled orchestrators (tests) skip the constructor, so the memo map is lazy.
  _memoBy(key, sig, fn) {
    const memo = this._memo ||= new Map();
    const hit = memo.get(key);
    if (hit && hit.sig === sig) return hit.val;
    const val = fn();
    memo.set(key, { sig, val });
    return val;
  }
  // Store file signatures; a store without sig helpers (minimal mocks) just yields '' (always recompute).
  sig(name) { try { return this.store.sigFile(name); } catch { return ''; } }
  logSig() { try { return this.store.logsSig(); } catch { return ''; } }
  teamsSigOf() { try { return this.store.teamsSig(); } catch { return ''; } }
  agent(id) { return (this.agents[id] ||= { runCost: 0, runTokens: 0, pendingHuman: [], stopRequested: false, budgetStop: null, status: 'idle', iteration: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, runs: 0, taskId: null, task: null, activity: null, model: '', runtime: '', billingSource: '', contextTokens: null, contextWindow: 0, contextPct: null, lastContextMessageId: null, subagents: [], subagentCount: 0, subagentTokens: { inputTokens: 0, outputTokens: 0 } }); }
  // Persisted runs, memoized on the runs file signature: one read per change serves every
  // file-derived aggregate (modelStats, timeline, ledger).
  runsMemo() { return this._memoBy('runs', this.sig('runs'), () => { let rs = []; try { rs = this.store.listRuns(); } catch { rs = []; } return rs; }); }
  // modelStats: per-model aggregate across this project's persisted runs + tasks (see usage.js modelStats for the field shape).
  modelStats() { return this._memoBy('modelStats', this.sig('runs') + '|' + this.sig('board'), () => { let ts = []; try { ts = this.store.listTasks(); } catch {} return U.modelStats(this.runsMemo(), ts); }); }
  // nodeTeams: {nodeId: {teamId, teamName}} across all teams in the project, for tagging log/timeline entries.
  nodeTeams() { return this._memoBy('nodeTeams', this.teamsSigOf(), () => { try { return this.store.nodeTeamMap(); } catch { return {}; } }); }
  // timeline: per-run start/end per agent+task, lanes ordered needs-attention first (TL.timeline, see timeline.js).
  timeline() { return this._memoBy('timeline', this.sig('runs') + '|' + this.sig('board') + '|' + this.teamsSigOf(), () => { let ts = []; try { ts = this.store.listTasks(); } catch {} return TL.timeline(this.runsMemo(), ts, this.nodeTeams()); }); }
  // logs: structured {ts, agentId, level, text} entries from the persisted orchestrator log.
  // The raw parse is cached incrementally (only newly appended bytes are read+parsed); the mapped
  // entries are memoized per (file sig, limit, teams sig).
  logs(limit) {
    const sig = this.logSig(); const size = Number(sig.split(':')[0]) || 0;
    let c = this._logTail;
    if (!c || c.sig !== sig) {
      // Growth is normally a pure append; the store's trim rewrite (logs over the size cap) can also
      // leave a bigger file, so confirm the head is untouched before trusting the incremental read.
      let grew = c && size > c.size && sig && this._logHead() === c.head;
      let entries;
      if (grew) {
        try {
          const fd = fs.openSync(this.store.logFile(), 'r');
          try {
            const buf = Buffer.alloc(size - c.size);
            fs.readSync(fd, buf, 0, buf.length, c.size);
            entries = c.entries.concat(C.parseLogs(buf.toString('utf8'), Infinity));
          } finally { fs.closeSync(fd); }
        } catch { entries = this.store.readLogs(Infinity); }
      } else { try { entries = this.store.readLogs(Infinity); } catch { entries = []; } }
      if (entries.length > C.LOG_CAP) entries = entries.slice(-C.LOG_CAP);
      c = this._logTail = { sig, size, head: this._logHead(), entries };
    }
    return this._memoBy('logEntries|' + limit, sig + '|' + this.teamsSigOf(), () => TL.logEntries(c.entries.slice(-(limit ?? Infinity)), this.nodeTeams()));
  }
  _logHead() {
    try {
      const fd = fs.openSync(this.store.logFile(), 'r');
      try { const buf = Buffer.alloc(64); const n = fs.readSync(fd, buf, 0, 64, 0); return buf.toString('utf8', 0, n); } finally { fs.closeSync(fd); }
    } catch { return ''; }
  }
  // wiki: [{title, body, updatedAt, author}], from the store's {title: {...}} page map.
  wiki() { return this._memoBy('wiki', this.sig('wiki'), () => { let ps = {}; try { ps = this.store.listWiki(); } catch {} return TL.wikiPages(ps); }); }
  // Cheap in-memory fingerprint (no I/O): everything volatile the snapshot exposes besides file-backed parts.
  memSig() { return JSON.stringify([this.running, this.runs, this.runCost, this.runTokens, this.totalCost, this.billedCost, this.subCost, this.budgetStop, this.usagePaused, this.usageStatus || null, this.procs.size, this.agents, this.subscriptionRateLimits]); }
  // Combined fingerprint for change-driven polling: in-memory state + every file the snapshot reads.
  versionSig() { return [this.memSig(), this.sig('runs'), this.sig('board'), this.sig('wiki'), this.teamsSigOf(), this.logSig()].join('|'); }
  // IPC-safe agent view. a.currentRun carries the live run record, whose .subs is a SubagentTracker
  // instance with a function field (.now) — one function anywhere in a state push / getAll payload
  // fails the whole structured clone, Electron drops the message ("Failed to serialize arguments")
  // and the UI silently never updates (t_72309c30: blank after restart because the resumed run armed
  // this before the first renderer refresh). Project only what the renderer reads off a.run:
  // stall (stall/recovery badges) and sessionId.
  agentView(a) {
    // inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens/cacheTokens are omitted: an agent
    // mixes models across runs, so its flat token sums are cross-model totals the API no longer
    // offers — per-key splits come from snapshot.ledger.byAgent instead (t_3318ff63).
    const { currentRun, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheTokens, ...rest } = a;
    // wakePending: unread agent->agent messages held back by the per-agent wake debounce — the UI's
    // "N messages pending, wake at ..." label (a null hides it; the field is absent, not null).
    return { ...rest, pendingHuman: a.pendingHuman.length, ...(a.wakePending ? { wakePending: a.wakePending } : {}), ...(currentRun ? { run: { sessionId: currentRun.sessionId ?? null, stall: currentRun.stall || null } } : {}) };
  }
  // Per-key usage ledger over the persisted runs (see usage.js usageLedger): one row per
  // {runtime, provider, model}, plus byAgent/byTask groupings. Memoized on the runs file signature.
  ledger() { return this._memoBy('ledger', this.sig('runs'), () => U.usageLedger(this.runsMemo())); }
  // When per-key usage tracking started (older runs are dropped on migration — store.migrateUsageLedger);
  // null when the project predates the field or has no meta yet.
  usageSince() { try { const m = this.store.meta(); return (m && m.usageTrackingSince) || null; } catch { return null; } }
  snapshot() { return { running: this.running, totalCost: this.totalCost, billedCost: this.billedCost || 0, subCost: this.subCost || 0, runs: this.runs, active: [...this.procs.keys()].map((id) => ({ nodeId: id, taskId: this.agent(id).taskId, cwd: this.cwds && this.cwds.get(id) || null })), runCost: this.runCost || 0, budgetStop: this.budgetStop || null, agents: Object.fromEntries(Object.entries(this.agents).map(([k, a]) => [k, this.agentView(a)])), ledger: this.ledger(), usageSince: this.usageSince(), modelStats: this.modelStats(), timeline: this.timeline(), logs: this.logs(), wiki: this.wiki(), nodeTeams: this.nodeTeams() }; }
  // Renderer-facing snapshot: the UI reads only agents + run scalars, so the file-backed display parts
  // (modelStats/timeline/logs/wiki/nodeTeams) are pure IPC payload — ~1.4MB per change on a large
  // project. Kept out of getAll and state pushes; snapshot() stays whole for other consumers.
  snapshotSlim() { const s = this.snapshot(); for (const k of ['modelStats', 'timeline', 'logs', 'wiki', 'nodeTeams']) delete s[k]; return s; }
  // Account one finished run: agent counters, session totals, persisted history.
  record(rec) {
    const a = this.agent(rec.nodeId);
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) a[k] += rec[k];
    a.cacheTokens = a.cacheReadTokens + a.cacheCreationTokens; a.cost += rec.reportedCostUsd; this.totalCost += rec.reportedCostUsd;
    if (rec.billingSource === 'subscription') this.subCost = (this.subCost || 0) + rec.reportedCostUsd; else this.billedCost = (this.billedCost || 0) + rec.reportedCostUsd;
    if (rec.kind === 'agent') { if (rec.model) a.model = rec.model; a.billingSource = rec.billingSource; }
    try { this.store.addRun(rec); } catch (e) { this.log(rec.nodeId, 'error', 'could not save usage: ' + e.message); }
    if (rec.kind !== 'preflight') {
      const tok = rec.inputTokens + rec.outputTokens; a.runCost += rec.reportedCostUsd; a.runTokens += tok;
      this.runCost = (this.runCost || 0) + rec.reportedCostUsd; this.runTokens = (this.runTokens || 0) + tok;
      this.checkBudget(rec.nodeId);
    }
    this.emit('run', rec);
  }
  log(nodeId, kind, text, extra = null) {
    const a = nodeId && this.agents[nodeId];
    const l = { nodeId, kind, text, at: Date.now(), taskId: (a && a.taskId) || null, task: (a && a.task) || null, level: TL.levelOf(kind), ...(extra && typeof extra === 'object' ? extra : {}) };
    try { this.store.appendLog(l); } catch {}
    this.emit('log', l);
    // Keep the latest error reason on the agent so the UI can show why it failed (and push it now, not at next run end).
    if (kind === 'error' && nodeId) { this.agent(nodeId).lastError = { text: String(text).slice(0, 500), at: l.at }; this.changed(); }
  }
  notify(title, body, extra = {}) { this.emit('notify', { title, body, ...extra }); }
  budgetReason(nodeId) {
    const node = this.store.getTeam().nodes.find((n) => n.id === nodeId) || {}; const a = this.agent(nodeId);
    return C.budgetExceeded({ node, agent: { cost: a.runCost, inputTokens: a.runTokens }, settings: this.store.getSettings(), totals: { cost: this.runCost || 0, tokens: this.runTokens || 0 } });
  }
  // Budget caps (per agent and per project Run): stop the agent, or the whole Run for a project cap.
  checkBudget(nodeId) {
    if (!this.running) return;
    const proj = C.projectBudgetExceeded(this.store.getSettings(), { cost: this.runCost || 0, tokens: this.runTokens || 0 });
    if (proj) { this.budgetStop = proj; this.log(null, 'error', 'Budget: ' + proj + '. Stopping all agents.'); this.notify('Budget reached', proj); return this.stop(); }
    const why = this.budgetReason(nodeId);
    if (why) { const a = this.agent(nodeId); a.budgetStop = why; this.log(nodeId, 'error', 'Budget: ' + why + '. Stopping this agent.'); this.notify('Agent budget reached', why, { nodeId }); if (a.status === 'working') this.stopAgent(nodeId, 'budget'); }
    this.checkUsageLimits(nodeId);
  }
  // Subscription (5h/weekly) and API (tokens/cost) usage limits: warn once, then pause new dispatch when hit.
  // Configured in settings.usageLimits; 0 disables a given limit. Does not stop an already-running agent.
  // Also guards against the CLI's own reported subscription rate-limit % (see subscriptionRateLimits), which is
  // independent of the count-based fiveHourLimit/weeklyLimit above and defaults to pausing at 90% of the window.
  checkUsageLimits(nodeId) {
    const settings = this.store.getSettings();
    const status = U.usageStatus(this.store.listRuns(), settings.usageLimits);
    // Drop readings whose resetsAt passed since they were stored (usage.js liveRateLimits): a stale pct
    // describes a window that already reset, and the freshest still-live reading is what counts. Readings
    // captured by a runtime the node has since left don't count either (nodeLiveRateLimits).
    const nodes = this.store.getTeam().nodes;
    const rlAll = nodes.map((n) => U.nodeLiveRateLimits(n, this.subscriptionRateLimits)).filter(Boolean);
    const combinedRL = rlAll.reduce((acc, rl) => ({
      fiveHour: (!acc.fiveHour || (rl.fiveHour && rl.fiveHour.pct > acc.fiveHour.pct)) ? rl.fiveHour : acc.fiveHour,
      weekly: (!acc.weekly || (rl.weekly && rl.weekly.pct > acc.weekly.pct)) ? rl.weekly : acc.weekly,
    }), { fiveHour: null, weekly: null });
    const guard = U.subscriptionGuard(combinedRL, (settings.usageLimits && settings.usageLimits.guardThresholdPct) || U.GUARD_DEFAULT_PCT);
    this.usageStatus = { ...status, subscriptionGuard: guard };
    const pause = status.pause || guard.pause;
    if (pause && !this.usagePaused) {
      this.usagePaused = true;
      this.log(nodeId || null, 'error', guard.pause && !status.pause ? `Subscription usage guard: pausing new dispatch (>= ${guard.thresholdPct}% of window).` : 'Usage limit reached: pausing new dispatch.');
      this.notify('Usage limit reached', 'Pausing new agent dispatch until the window resets.');
      this.emit('usage-limit-guard', { nodeId: nodeId || null, guard, status });
    } else if (!pause) this.usagePaused = false;
    if (status.warn && !pause && !this.usageWarned) { this.usageWarned = true; this.log(nodeId || null, 'system', 'Usage warning: approaching configured limit.'); this.notify('Usage warning', 'Approaching a configured usage limit.'); }
    else if (!status.warn) this.usageWarned = false;
    return this.usageStatus;
  }
  // Stop one agent's current run (the rest keep going). Its task goes to review.
  stopAgent(nodeId, why = 'stopped by human') {
    const a = this.agent(nodeId); const p = this.procs.get(nodeId);
    if (!p || a.status !== 'working') return false;
    a.stopRequested = why; p.kill('SIGTERM');
    this.log(nodeId, 'system', `■ stop requested (${why})`); this.changed();
    return true;
  }
  // Human -> agent message. Stored in the agent's inbox; if the agent is running, the current run is
  // interrupted and resumed in the same session with the message as the next prompt. extra.attachments
  // are already-saved files ({path,name,mime,size}); only the records travel, never the bytes.
  sendToAgent(nodeId, text, taskId = null, extra = null) {
    if (!String(text || '').trim()) throw new Error('text required');
    const a = this.agent(nodeId);
    const m = this.store.sendMessage({ from: 'human', to: nodeId, text: String(text).trim(), taskId: taskId || a.taskId || null, attachments: extra && extra.attachments });
    const live = a.status === 'working' && this.procs.has(nodeId) && this.running;
    if (live) { a.pendingHuman.push(m); this.log(nodeId, 'system', `✉ human message queued; interrupting to deliver: ${m.text.slice(0, 200)}`); this.procs.get(nodeId).kill('SIGTERM'); }
    else this.log(nodeId, 'system', `✉ human message stored in inbox: ${m.text.slice(0, 200)}`);
    this.changed();
    return { ...m, delivered: live ? 'interrupt' : 'inbox' };
  }

  // ---- wake on message: an idle agent that receives a send_message is dispatched with its unread
  // messages as the prompt. The sender's send_message has already returned (it only writes to the
  // store); delivery happens here, in the background, debounced and loop-capped. ----
  sweepWakes() {
    if (this.userStopped || this.dispatchPaused) { for (const t of this.wakeTimers.values()) clearTimeout(t.timer); this.wakeTimers.clear(); return; }
    try {
      const team = this.store.getTeam();
      const now = Date.now();
      for (const node of team.nodes) {
        const a = this.agent(node.id);
        if (this.procs.has(node.id) || a.status === 'working') continue;
        const unread = this.wakeUnread(node.id, team);
        if (!unread.length) {
          if (a.wakePending) { a.wakePending = null; this.changed(); }
          this.wakeSuppressedLogged.delete(node.id);
          continue;
        }
        // Per-agent wake debounce: while an agent runs (task or wake), messages stay queued unread —
        // never a parallel run. Once idle, an agent->agent wake fires at most once per
        // WAKE.MIN_GAP_MS; further messages accumulate in the inbox until the interval passes.
        // Task dispatch is NOT debounced (an assigned/unblocked task reaches the agent right away and
        // its prompt carries the unread count), and human/system wakes never enter this sweep.
        const cooldown = (this.wakeLastAt.get(node.id) || 0) + WAKE.MIN_GAP_MS - now;
        const suppressing = cooldown > 0;
        const prev = a.wakePending;
        if (!prev || prev.count !== unread.length || prev.suppressed !== suppressing) {
          // nextWakeAt is the armed timer's due time or the interval's end; recomputed only on a
          // transition so an unchanged pending state does not churn a state push every sweep.
          a.wakePending = { count: unread.length, suppressed: suppressing, nextWakeAt: suppressing ? (this.wakeLastAt.get(node.id) || 0) + WAKE.MIN_GAP_MS : ((prev && !prev.suppressed && prev.nextWakeAt) || now + WAKE.DEBOUNCE_MS) };
          this.changed();
        }
        if (suppressing) {
          // Evidence over silence (one line per suppression window, not per sweep): the messages are
          // deliberately held back and WILL wake on the timer.
          if (!this.wakeSuppressedLogged.has(node.id)) {
            this.wakeSuppressedLogged.set(node.id, now);
            this.log(node.id, 'system', `✉ wake suppressed for another ${Math.ceil(cooldown / 60000)}min (last agent wake < ${Math.round(WAKE.MIN_GAP_MS / 60000)}min ago); ${unread.length} message(s) wait in the inbox and wake on the timer`);
          }
          continue;
        }
        this.wakeSuppressedLogged.delete(node.id);
        // Debounce: a burst of messages coalesces into the one dispatch this timer fires. At most one
        // pending wake per agent: the wakeTimers entry IS the dedupe key.
        if (!this.wakeTimers.has(node.id)) {
          const dueAt = now + WAKE.DEBOUNCE_MS;
          this.wakeTimers.set(node.id, { dueAt, timer: setTimeout(() => {
            this.wakeTimers.delete(node.id);
            this.dispatchWake(node.id).catch((e) => this.log(node.id, 'error', 'wake dispatch: ' + e.message));
          }, WAKE.DEBOUNCE_MS) });
        }
      }
    } catch (e) { this.log(null, 'error', 'wake sweep: ' + e.message); }
  }
  // Unread agent->agent messages for a node (human and system senders have their own delivery paths).
  wakeUnread(nodeId, team = this.store.getTeam()) {
    return this.store.listMessages({ to: nodeId })
      .filter((m) => !m.read && m.from !== nodeId && m.from !== 'human' && m.from !== 'system' && team.nodes.some((n) => n.id === m.from));
  }
  async dispatchWake(nodeId) {
    const team = this.store.getTeam();
    const node = team.nodes.find((n) => n.id === nodeId);
    if (!node || this.userStopped || this.dispatchPaused || this.procs.has(nodeId)) return;
    const a = this.agent(nodeId);
    if (a.status === 'working' || a.budgetStop) return; // busy (or over budget): stay unread, the next sweep retries
    // Re-check the debounce at fire time (the sweep armed this timer before it expired): still inside
    // the per-agent interval — leave the messages unread, the sweep re-arms once the interval passes.
    if (Date.now() - (this.wakeLastAt.get(nodeId) || 0) < WAKE.MIN_GAP_MS) return;
    const settings = this.store.getSettings();
    if (settings.maxConcurrency > 0 && this.procs.size >= settings.maxConcurrency) return;
    const msgs = this.wakeUnread(nodeId, team);
    if (!msgs.length) return;
    const now = Date.now();
    const senders = [...new Set(msgs.map((m) => m.from))];
    const capped = (f) => { const e = this.wakePairs.get(f + '>' + nodeId); return e && now - e.since < WAKE.PAIR_WINDOW_MS && e.count >= WAKE.MAX_PER_PAIR; };
    if (senders.every(capped)) return; // ping-pong loop: every sender pair is at its cap, stay quiet
    for (const f of senders) {
      const k = f + '>' + nodeId; const e = this.wakePairs.get(k);
      if (!e || now - e.since >= WAKE.PAIR_WINDOW_MS) this.wakePairs.set(k, { count: 1, since: now });
      else { e.count++; if (e.count === WAKE.MAX_PER_PAIR) this.log(nodeId, 'system', `wake cap reached for messages from ${f}: no more auto-wakes from this pair for a while`); }
    }
    this.wakeLastAt.set(nodeId, now); // starts the agent's next wake-debounce interval
    this.wakeSuppressedLogged.delete(nodeId);
    a.wakePending = null;
    this.store.markMessagesRead(msgs.map((m) => m.id)); // delivered verbatim in the prompt below
    this.emit('woken_by_message', { nodeId, by: senders, messageIds: msgs.map((m) => m.id) });
    const nameOf = (id) => (team.nodes.find((n) => n.id === id) || {}).name || id;
    this.log(nodeId, 'system', `✉ woken by message from ${senders.map(nameOf).join(', ')}: ${msgs[0].text.slice(0, 200)}`);
    await this.wakeRun(node, msgs, team, settings);
  }
  // Deliver already-stored messages to an IDLE agent as a wake run — the two paths the message sweep
  // deliberately ignores (human and system senders have their own delivery): the human's answer to an
  // ask_human (team-answers) and the core nudge (nudgeIdle). This path BYPASSES the per-agent wake
  // debounce for human messages (an answer must reach the asker immediately); the nudge path defers
  // to the debounce itself in nudgeIdle, so a watchdog wake never lands inside another wake's gap.
  // Guards
  // mirror dispatchWake plus the run gate: nothing auto-starts on a stopped project, a live agent is
  // reached by its own channels, and maxRuns/maxConcurrency still bound auto-dispatch. `why` carries
  // the monitor event Dev B's UI keys on — orch.log(nodeId, 'monitor', <sentence>, {reason, taskIds,
  // action}) — emitted only when the wake actually fires, so a refused wake never reads as a watchdog action.
  async wakeForHuman(nodeId, msgs, why = {}) {
    const list = (msgs || []).filter(Boolean);
    if (!list.length) return false;
    const team = this.store.getTeam();
    const node = team.nodes.find((n) => n.id === nodeId);
    if (!node || !this.running || this.userStopped || this.dispatchPaused) return false;
    const a = this.agent(nodeId);
    if (a.status === 'working' || this.procs.has(nodeId) || a.budgetStop) return false;
    if (this.usagePaused && (node.runtime || 'claude') === 'claude') return false; // same pause rule as tick()
    const settings = this.store.getSettings();
    if (settings.maxConcurrency > 0 && this.procs.size >= settings.maxConcurrency) return false;
    if (settings.maxRuns > 0 && this.runs >= settings.maxRuns) return false; // at the cap the stored message still informs the human via the Board
    this.store.markMessagesRead(list.map((m) => m.id));
    this.emit('woken_by_message', { nodeId, by: [...new Set(list.map((m) => m.from))], messageIds: list.map((m) => m.id) });
    const { reason = 'human message', taskIds = [], action = 'wake' } = why;
    this.log(nodeId, 'monitor', `waking ${node.name}: ${reason}`, { reason, taskIds, action });
    this.log(nodeId, 'system', `✉ waking for ${reason}: ${list[0].text.slice(0, 200)}`);
    await this.wakeRun(node, list, team, settings);
    return true;
  }
  // One background run delivering the messages (resumes the agent's last session when it has one).
  async wakeRun(node, msgs, team, settings) {
    // Single-run lock, enforced at the last choke point: never a second live run for one agent, even
    // if a caller raced past its own guard. The would-be wake stays queued (messages stay unread).
    if (this.procs.has(node.id)) { this.log(node.id, 'system', `✉ wake not dispatched: ${node.name} already has a live run (single run per agent); messages stay queued`); return; }
    const a = this.agent(node.id);
    a.status = 'working'; a.lastError = null; a.taskId = null; a.task = null; a.iteration = 0; a.stopRequested = false; a.wakePending = null;
    // Live-run reason/activity, shown by Board/Team/Overview via snapshot: what woke the agent, from
    // whom, and the first unread message as the excerpt. messageIds lets haltProcs put the messages
    // back in the unread inbox when the run is cut for a restart (they were marked read below).
    // Cleared when the run ends.
    a.activity = { trigger: 'message', messageId: msgs[0].id, messageIds: msgs.map((m) => m.id), fromNodeId: msgs[0].from, excerpt: msgs[0].text.slice(0, 200), taskId: (msgs.find((m) => m.taskId) || {}).taskId || null, count: msgs.length, startedAt: Date.now() };
    a.runs++; this.runs++;
    this.procs.set(node.id, { kill() {} }); // reserve the slot synchronously
    try {
      this.changed();
      let cfg;
      try { cfg = normalizeNode(applyPreset(node, settings.rolePresets || [])); } catch (e) { cfg = { env: {}, mode: 'single' }; this.log(node.id, 'error', 'bad agent settings: ' + e.message); }
      const bill = U.applyBillingEnv(cfg, this.env(cfg)); const env = bill.env;
      for (const w of bill.warnings) this.log(node.id, 'error', w);
      const meta = { billingMode: cfg.billingMode || 'auto', runtime: cfg.runtime || 'claude' };
      a.runtime = meta.runtime; a.model = cfg.model || '';
      if (!this.cwds) this.cwds = new Map();
      let cwd = node.workdir || this.store.dir;
      fs.mkdirSync(cwd, { recursive: true });
      this.cwds.set(node.id, cwd);
      const resume = this.lastSession(node.id, meta.runtime);
      this.log(node.id, 'system', `▶ ${node.name} wakes to handle messages in ${cwd}${resume ? ' [resume ' + resume + ']' : ''}`);
      let args = null;
      // Wake messages can carry attachments (their paths are in wakePrompt): pass the dir like the
      // task-run path does, or the agent gets a path it cannot read.
      const wakeAtts = msgs.flatMap((m) => m.attachments || []);
      try { args = RT.getRuntime(cfg.runtime).buildArgs(cfg, wakePrompt(team, node, msgs), settings, this.mcpConfig(node), { resume, cwd, env, ...(wakeAtts.length ? { attachDir: this.store.attachmentsDir() } : {}) }); }
      catch (e) { this.log(node.id, 'error', 'bad agent settings: ' + e.message); }
      const r = await this.spawnRun(node, args, cwd, env, settings, { ...meta, resumedFrom: args && resume ? resume : null });
      a.status = 'idle'; a.iteration = 0; a.activity = null;
      this.log(node.id, 'system', `■ ${node.name} finished the wake run (exit ${r.code})`);
      this.changed();
    } catch (e) {
      a.status = 'idle'; a.iteration = 0; a.activity = null;
      this.log(node.id, 'error', `wake run crashed: ${e.message}`);
      this.changed();
    } finally {
      // Released however the bookkeeping above ends: a leaked slot leaves a self-update
      // drain waiting forever for an agent that already exited.
      this.procs.delete(node.id); this.cwds.delete(node.id);
      // The gap anchors at the wake-run END (not just the dispatch): a long wake run was busy
      // working, not churning, so the next burst waits WAKE.MIN_GAP_MS from when it went idle.
      this.wakeLastAt.set(node.id, Date.now());
    }
    if (this.running) setImmediate(() => this.tick());
    if (this.running) setImmediate(() => this.tick());
  }

  // ---- stall watchdog: a run that has emitted nothing AND has no live child/descendant process for
  // stallTimeoutMin (setting, default 10) is stalled. Task runs are stopped and resumed in the same
  // session (runTask's r.stalled branch) with a short continue prompt, max 2 recoveries per task.
  // Wake runs (no task) are only stopped: the sweep re-delivers what still matters, and holding the
  // agent's single-run slot forever on a hung wake is never right. Manual interrupts (stopAgent, a
  // queued human message) always take precedence and are never recovered over. ----
  sweepStalls() {
    if (this.userStopped) return;
    // Task-run recovery is the Run's business (it re-dispatches through runTask), but a wake run can
    // be live with the Run over (dispatchWake does not require it) — those still get watched, since a
    // hung wake run must not hold the agent's single-run slot forever.
    let runOver = false;
    if (!this.running) {
      runOver = true;
      let hasWake = false;
      for (const [nodeId] of this.procs) {
        const a = this.agents[nodeId];
        if (a && a.status === 'working' && !a.taskId && a.activity && a.activity.trigger === 'message') hasWake = true;
      }
      if (!hasWake) return;
    }
    const timeoutMin = Number(this.store.getSettings().stallTimeoutMin ?? 10);
    if (!(timeoutMin > 0)) return;
    const now = Date.now();
    for (const [nodeId, child] of [...this.procs]) {
      const a = this.agents[nodeId];
      const run = a && a.currentRun;
      if (!a || a.status !== 'working' || !run || run.done || run.stalled) continue;
      // Cover both run kinds: task runs (a.taskId) and wake runs (no task, message-triggered activity).
      const isWake = !a.taskId && !!(a.activity && a.activity.trigger === 'message');
      if (!a.taskId && !isWake) continue;
      if (runOver && !isWake) continue;
      if (a.stopRequested || a.pendingHuman.length) continue;
      if (now - (a.lastActivityAt || 0) < timeoutMin * 60000) continue;
      if (this.runAlive(nodeId, child)) continue;
      // One-way claim on the run object: whichever sweep flips .stalled owns the recovery, so a tick
      // racing a manual stop or a queued message can never double-fire (compare-and-set on the run).
      run.stalled = true;
      a.stall = { state: 'stalled' };
      const idleMin = Math.round((now - (a.lastActivityAt || 0)) / 60000);
      this.log(nodeId, 'error', isWake
        ? `stall: wake run silent with no live child process for ${idleMin} min; stopping it (messages still pending re-wake the agent)`
        : `stall: no events and no live child process for ${idleMin} min; stopping the run to recover`);
      this.emit('run.stalled', { nodeId, taskId: a.taskId || null, idleMin, kind: isWake ? 'wake' : 'task' });
      try { child.kill('SIGTERM'); } catch {}
      this._stallKill.set(nodeId, setTimeout(() => {
        this._stallKill.delete(nodeId);
        if (this.procs.get(nodeId) === child && a.currentRun === run && !run.done) {
          try { child.kill('SIGKILL'); } catch {}
          this.log(nodeId, 'error', 'stall: run ignored SIGTERM; sent SIGKILL');
        }
      }, STALL.SIGKILL_GRACE_MS));
      this.changed();
    }
  }

  // Liveness beyond emitted events: a live (non-zombie) descendant of the run's CLI process counts as
  // alive — a long silent tool call (build, sleep, network) keeps a grandchild process running even
  // though no events stream. So does the CLI's own CPU time advancing between sweeps. Unknowable
  // (ps unavailable, slot placeholder without a pid) counts as alive: never stall on a hunch. The
  // board MCP helper subtree is excluded (isBoardHelper): it idles for the whole session and would
  // otherwise keep a hung CLI "alive" forever.
  runAlive(nodeId, child) {
    if (!child || !child.pid) return true;
    if (child.exitCode != null) return false; // already exited; the close event just hasn't fired
    const rows = this.procTable();
    if (!rows) return true;
    const me = rows.find((r) => r.pid === child.pid);
    const prev = this._stallCpu.get(nodeId);
    this._stallCpu.set(nodeId, { pid: child.pid, cpuMs: me ? me.cpuMs : null });
    if (me && prev && prev.pid === child.pid && prev.cpuMs != null && me.cpuMs > prev.cpuMs) return true;
    const kids = new Map();
    for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
    const queue = [child.pid]; const seen = new Set(queue);
    while (queue.length) {
      for (const r of kids.get(queue.pop()) || []) {
        if (seen.has(r.pid) || isBoardHelper(r)) continue; // skipped node's subtree stays unreachable
        seen.add(r.pid); queue.push(r.pid);
        // Primary ps state is the first char; flags follow ('ZN' = defunct+nice). A stopped CLI cannot
        // reap its exited children, so defunct descendants pile up — they are not liveness.
        if (r.state[0] !== 'Z') return true;
      }
    }
    return false;
  }

  // [{pid, ppid, state, cpuMs, command}] for every process, or null when ps is unavailable.
  procTable() {
    try {
      const out = require('child_process').execFileSync('ps', ['-axo', 'pid=,ppid=,state=,time=,command='], { timeout: 4000 }).toString();
      return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
        .map((p) => ({ pid: Number(p[0]), ppid: Number(p[1]), state: p[2], cpuMs: stimeToMs(p[3]), command: p.slice(4).join(' ') }));
    } catch { return null; }
  }
  changed() { this.emit('state', this.snapshotSlim()); }

  start() {
    if (this.running) return;
    this.running = true; this.runs = 0; this.runCost = 0; this.runTokens = 0; this.budgetStop = null;
    this.userStopped = false;
    for (const a of Object.values(this.agents)) { a.runCost = 0; a.runTokens = 0; a.budgetStop = null; }
    this.reconcileOrphanedTasks();
    this.log(null, 'system', 'Orchestrator started');
    this.changed();
    this.tick();
  }
  stop() {
    this.running = false;
    this.userStopped = true; // a human pressed stop: no wake dispatches behind their back
    for (const t of this.wakeTimers.values()) clearTimeout(t.timer); this.wakeTimers.clear();
    this.log(null, 'system', 'Orchestrator stopped');
    this.changed();
    // Only report the run done once every agent process has actually exited (kill is async: SIGTERM
    // doesn't stop them synchronously), never while one is still running/pending.
    if (this.procs.size === 0) this.emit('done', this.snapshot());
    else this._stopPending = true;
    for (const p of this.procs.values()) p.kill('SIGTERM');
  }

  // Self-update drain deadline: stop the live agent processes we are ALLOWED to stop so the restart
  // can proceed (SIGTERM now, SIGKILL after killGraceMs; resolves once those have all exited).
  // Resolves {cut, spared}: cut = runs stopped here, spared = live runs intentionally left running
  // (a task already cut for a restart is never cut again — the drain keeps waiting for those).
  // A stub haltProcs (tests) resolving without the shape reads as "spared nothing".
  // Cut-once protection uses the persisted drainCuts on the task — it must survive the relaunch.
  // The stall watchdog is the hang safety-valve for spared tasks, not this deadline. Wake runs have
  // no task to protect: they are always cuttable, and their messages go back to the unread inbox so
  // the agent is re-woken after the restart.
  // Unlike stop() this keeps the Run alive and marks the cut nodes (drainCutNodes): runTask treats
  // killed runs as restart-interrupted (task stays in_progress; after the relaunch
  // reconcileOrphanedTasks resets it to todo and the session resumes), not crashed (which would park
  // it for a human).
  haltProcs(killGraceMs = 5000) {
    const targets = []; let spared = 0;
    for (const [nodeId] of this.procs) {
      const a = this.agents[nodeId];
      const t = a && a.taskId ? this.store.getTask(a.taskId) : null;
      if (t && (t.drainCuts || 0) > 0) {
        spared++;
        this.log(nodeId, 'system', `self-update drain: "${t.title}" was already cut for a restart once — not cutting it again; the drain waits for it to finish`);
        continue;
      }
      targets.push(nodeId);
    }
    if (!targets.length) return Promise.resolve({ cut: 0, spared });
    for (const nodeId of targets) {
      this.drainCutNodes.add(nodeId);
      const a = this.agents[nodeId];
      if (a && a.taskId) {
        const cuts = ((this.store.getTask(a.taskId) || {}).drainCuts || 0) + 1;
        this.store.updateTask(a.taskId, { drainCuts: cuts });
        this.log(nodeId, 'system', `self-update drain: cutting "${a.task}" for the restart (cut #${cuts}); it resumes from its session after the relaunch`);
      } else if (a && a.activity && Array.isArray(a.activity.messageIds) && a.activity.messageIds.length) {
        try { this.store.markMessagesRead(a.activity.messageIds, false); } catch {} // the cut wake run never delivered them
      }
      const p = this.procs.get(nodeId);
      try { if (p) p.kill('SIGTERM'); } catch {}
    }
    this.changed();
    return new Promise((resolve) => {
      const t0 = Date.now(); let killed = false;
      // Referenced on purpose: while waiting out the kill grace this interval is what keeps the
      // process (and the pending update) alive after the agent children are gone. Waits only for the
      // cut nodes — spared (cut-once) tasks keep running and are the drain loop's business.
      const iv = setInterval(() => {
        if (!targets.some((id) => this.procs.has(id))) { clearInterval(iv); return resolve({ cut: targets.length, spared }); }
        if (!killed && Date.now() - t0 >= killGraceMs) {
          killed = true;
          for (const id of targets) { const p = this.procs.get(id); try { if (p) p.kill('SIGKILL'); } catch {} }
        } else if (killed && Date.now() - t0 >= killGraceMs + 1000) { clearInterval(iv); resolve({ cut: targets.length, spared }); }
      }, 100);
    });
  }

  // An aborted self-update unpauses dispatch: the cut markers would make every subsequent run of the
  // affected agents break instantly at their first iteration. (main.js setPaused(false) calls this.)
  clearDrainCuts() { this.drainCutNodes.clear(); }

  // Reset any in_progress task whose assignee has no live session/process back to todo so it gets
  // re-dispatched. Covers agent exit/crash/idle leaving a task stranded in_progress.
  reconcileOrphanedTasks() {
    const all = this.store.listTasks();
    let changed = false;
    for (const t of all) {
      if (t.status !== 'in_progress') continue;
      const a = this.agents[t.assignee];
      const live = a && a.taskId === t.id && this.procs.has(t.assignee);
      if (live) continue;
      this.store.updateTask(t.id, { status: 'todo' });
      this.store.commentTask(t.id, 'orchestrator', 'No live session for this task (its agent has no running process); reset to todo for re-dispatch.');
      this.log(t.assignee, 'system', `↺ "${t.title}" had no live session; reset to todo`);
      changed = true;
    }
    return changed;
  }

  agentStates() { return IDLE.agentStates(this.store.getTeam(), this.store.listTasks(), this.agents); }
  // Board message to each PM with open goals whose reports are idle; repeats only when the idle set changes.
  // With the watchdog (t_ccab4c19) a nudge is no longer Board-only: a NEW nudge also wakes its
  // recipient with the nudge text, so an all-idle stall actually reaches a core. No LLM call unless
  // something really changed — the same-condition debounce below is the wake-loop guard.
  nudgeIdle() {
    this.nudged ||= new Map();
    // staleMin reuses the stall timeout (no new setting); <=0 disables the watchdog condition.
    const staleMin = Number(this.store.getSettings().stallTimeoutMin ?? 10);
    const now = Date.now();
    const opts = staleMin > 0 ? { staleMin, now } : {};
    for (const n of IDLE.idleNudges(this.store.getTeam(), this.store.listTasks(), this.agents, opts)) {
      // Debounce per kind, keyed by pmId+kind so the two conditions never clobber each other: idle
      // nudges by their (already distinct) text, stale nudges by the sorted taskIds — a core that
      // wakes and changes nothing must not be woken again for the same stale set, while a changed
      // stale set is a new condition even if the wording matches.
      const kind = n.kind || 'idle';
      const key = kind === 'stale' ? [...n.taskIds].sort().join(',') : n.text;
      const mk = `${n.pmId}|${kind}`;
      if (this.nudged.get(mk) === key) continue;
      // Nudge wakes respect the per-agent wake gap too (t_cb6663f7): the text-key debounce re-arms
      // whenever the idle set changes — any report flipping busy<->idle — and each "new" nudge would
      // otherwise wake the core through wakeForHuman's human bypass seconds after the last wake,
      // even right after the sweep logged "wake suppressed" for the same agent. Deferred, not
      // dropped: the key is recorded only when the wake actually fires, so the condition re-fires
      // on a later tick once the interval passes (a newer condition supersedes it meanwhile).
      const cooldown = (this.wakeLastAt.get(n.pmId) || 0) + WAKE.MIN_GAP_MS - now;
      if (cooldown > 0) {
        const last = (this.nudgeDeferredLogged ||= new Map()).get(n.pmId) || 0;
        if (now - last >= WAKE.MIN_GAP_MS) { // one line per gap window, like the sweep's suppression line
          this.nudgeDeferredLogged.set(n.pmId, now);
          this.log(n.pmId, 'system', `nudge deferred for another ${Math.ceil(cooldown / 60000)}min (last wake < ${Math.round(WAKE.MIN_GAP_MS / 60000)}min ago); it re-fires once the interval passes: ${n.text}`);
        }
        continue;
      }
      this.nudgeDeferredLogged?.delete(n.pmId);
      this.nudged.set(mk, key);
      const m = this.store.sendMessage({ from: 'system', to: n.pmId, text: n.text });
      this.log(n.pmId, 'system', 'nudge: ' + n.text);
      this.wakeForHuman(n.pmId, [m], { reason: kind === 'stale' ? 'stale tasks' : 'idle reports', taskIds: n.taskIds || [], action: 'wake core' })
        .catch((e) => this.log(n.pmId, 'error', 'nudge wake: ' + e.message));
    }
  }

  // Tasks left in review that never got picked back up (their reviewer's process crashed/exited, or
  // the run stopped mid-way) are dispatched to their reviewer. With no reviewer configured for the
  // assignee the task STAYS in review: done requires reviewer/owner verification (t_699b67b7), so the
  // sweep surfaces the stranded task once instead of finishing unreviewed work. Returns the
  // (possibly stale) tasks in review that DO have a reviewer, ready for dispatch.
  autoAdvanceReviews(team) {
    const out = [];
    for (const t of this.store.listTasks()) {
      if (t.status !== 'review' || t.awaitingApproval || t.parkedForHuman) continue;
      const reviewer = outgoing(team, t.assignee, ['review']).map((id) => team.nodes.find((n) => n.id === id)).find(Boolean);
      if (reviewer) { out.push({ task: t, node: reviewer }); continue; }
      (this._noReviewerNoted ||= new Set());
      if (this._noReviewerNoted.has(t.id)) continue;
      this._noReviewerNoted.add(t.id);
      // An approval-gated project also records the human gate: with no reviewer, only a human can
      // approve it as done. Either way the task stays in review (t_699b67b7), surfaced once.
      if (C.needsApproval(team.nodes.find((n) => n.id === t.assignee), this.store.getSettings())) {
        this.store.updateTask(t.id, { status: 'review', awaitingApproval: true });
      }
      this.store.commentTask(t.id, 'orchestrator', 'staying in review: no reviewer is configured for this task (no review edge from the assignee). Done requires reviewer/owner verification — add a reviewer or move it to done yourself.');
      this.log(t.assignee, 'system', `⏸ "${t.title}" stays in review (no reviewer configured); it will not auto-advance to done`);
    }
    return out;
  }

  tick() {
    if (!this.running) {
      // Draining after stop(): report done exactly once every agent has actually exited.
      if (this._stopPending && this.procs.size === 0) { this._stopPending = false; this.emit('done', this.snapshot()); }
      return;
    }
    const s = this.store.getSettings();
    const team = this.store.getTeam();
    // Sweep + write auto-advances first so a task's own dependents see it done within this same tick.
    const reviewReady = this.autoAdvanceReviews(team).map(({ task, node }) => ({ task: this.store.getTask(task.id), node }));
    const all = this.store.listTasks();
    const todo = all.filter((t) => t.status === 'todo' && team.nodes.some((n) => n.id === t.assignee));
    // The subscription usage pause is about the Claude subscription: agents on other runtimes keep working.
    // dispatchPaused (UpdateWatcher) pauses every runtime: the restart waits for agents to finish.
    const paused = (node) => this.dispatchPaused || (this.usagePaused && (!node || (node.runtime || 'claude') === 'claude'));
    const readyTodo = todo.map((t) => ({ task: t, node: team.nodes.find((n) => n.id === t.assignee) }))
      .filter(({ task, node }) => !C.isBlocked(task, all) && !this.agent(task.assignee).budgetStop && !paused(node));
    const readyReview = reviewReady.filter(({ task, node }) => !C.isBlocked(task, all) && !this.agent(node.id).budgetStop && !paused(node));
    // Highest priority first (P0..P3); stable sort, so same-priority tasks keep arrival order.
    const ready = [...readyTodo, ...readyReview].sort((a, b) => C.priorityRank(a.task) - C.priorityRank(b.task));
    for (const { task, node } of ready) {
      if (s.maxConcurrency > 0 && this.procs.size >= s.maxConcurrency) break; // 0 = unlimited
      if (this.procs.has(node.id)) continue;
      if (this.runs >= s.maxRuns) { this.log(null, 'system', `maxRuns (${s.maxRuns}) reached`); break; }
      this.runTask(node, task, team, s).catch((e) => this.log(node.id, 'error', 'agent run crashed: ' + e.message));
    }
    try { this.nudgeIdle(); } catch (e) { this.log(null, 'error', 'idle nudge: ' + e.message); }
    if (this.procs.size === 0) {
      // UpdateWatcher is draining for a restart: hold the run session open (no dispatches while
      // paused) so the watcher's wasRunning stays true and bootResume can restart the Run after the
      // relaunch. An aborted update unpauses and re-ticks via main.js's setPaused callback.
      if (this.dispatchPaused) return;
      // Before declaring a stop, sweep for in_progress tasks whose agent has no live session (e.g. its
      // process exited/crashed without updating status) and re-dispatch them instead of blocking forever.
      if (this.reconcileOrphanedTasks()) { setImmediate(() => this.tick()); return; }
      this.running = false;
      // A run must not read as a clean "Finished." while undispatchable unfinished work (open review,
      // waiting_for_human, merge_conflict, a stray in_progress) remains on the board.
      const stuck = all.filter((t) => ['in_progress', 'review', 'waiting_for_human', 'merge_conflict'].includes(t.status));
      const why = !todo.length && !ready.length
        ? (stuck.length ? `Stopped: ${stuck.length} unfinished task(s) with no agent to pick them up (${stuck.map((t) => `${t.id} ${t.status}`).join(', ')})` : 'No more todo tasks. Finished.')
        : !ready.length ? `Stopped: ${todo.length} todo task(s) are blocked by unfinished dependencies or over budget` : 'Stopped: run limit reached';
      this.log(null, 'system', why);
      const waiting = all.filter((t) => t.awaitingApproval).length;
      this.notify('Run finished', why + (waiting ? ` ${waiting} task(s) wait for your approval.` : ''));
      this.changed();
      // No agents running/pending at this point (procs is empty and nothing is left to dispatch): safe to report done.
      this.emit('done', this.snapshot());
    }
  }

  // The agent's most recent session id for a runtime (from the board's per-owner sessions map),
  // used by continueSession. Never falls back to the legacy shared task.sessionId: it has no owner
  // info, so resuming it can land in another agent's/runtime's dead session.
  lastSession(nodeId, runtime = 'claude') {
    const key = `${nodeId}:${runtime}`;
    const ts = this.store.listTasks().filter((t) => t.assignee === nodeId && t.sessions && t.sessions[key]).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    return ts.length ? ts[ts.length - 1].sessions[key] : null;
  }

  env(cfg) {
    const env = { ...process.env, ...(cfg.env || {}) }; delete env.ELECTRON_RUN_AS_NODE;
    const home = require('os').homedir();
    env.PATH = [env.PATH, `${home}/.local/bin`, `${home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
    return env;
  }

  // Last cumulative usage snapshot of a session (resumed runs report session-cumulative modelUsage/cost).
  sessionBaseline(sessionId) {
    const m = this.sessionCum && this.sessionCum.get(sessionId); if (m) return m;
    let rs = []; try { rs = this.store.listRuns(); } catch {}
    for (let i = rs.length - 1; i >= 0; i--) if (rs[i].sessionId === sessionId && rs[i].cumulative) return rs[i].cumulative;
    return null;
  }

  // One claude process. Resolves {code, sessionId, result}.
  spawnRun(node, args, cwd, env, settings, meta = {}) {
    return new Promise((resolve) => {
      const startedMs = Date.now();
      const usage = U.newRun({ projectId: this.store.meta() ? this.store.meta().id : null, nodeId: node.id, agent: node.name, ...meta });
      usage.runtime = meta.runtime || node.runtime || 'unknown'; // ledger key part; the init event corrects it if the CLI reports its own
      if (!usage.model && node.model) usage.model = node.model; // non-claude runtimes report no model in events; the node's config is the best known value
      if (usage.resumedFrom) usage.baseline = this.sessionBaseline(usage.resumedFrom);
      let rt; try { rt = RT.getRuntime(meta.runtime); } catch (e) { this.log(node.id, 'error', e.message + ' (run failed, no fallback)'); rt = { id: String(meta.runtime), label: String(meta.runtime), bin: () => '' }; args = null; }
      const child = args ? spawn(rt.bin(settings), args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        : Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
      if (!args) setImmediate(() => child.emit('close', 1));
      this.procs.set(node.id, child);
      const a = this.agent(node.id);
      // Identity + liveness for the stall watchdog: any stdout/stderr byte refreshes a.lastActivityAt,
      // and `run` is the handle the watchdog claims (.stalled) to own this run's recovery.
      const run = { sessionId: null, result: '', usage };
      // Subagent (Task/Agent tool) records for this run; reset the live agent-side totals it feeds.
      run.subs = new SubagentTracker(node.id);
      a.subagents = []; a.subagentCount = 0; a.subagentTokens = { inputTokens: 0, outputTokens: 0 };
      a.currentRun = run; a.lastActivityAt = Date.now();
      let buf = ''; let errbuf = '';
      child.stdout.on('data', (d) => {
        a.lastActivityAt = Date.now();
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.onEvent(node, line, run, rt.id); }
      });
      child.stderr.on('data', (d) => { a.lastActivityAt = Date.now(); errbuf += d; if (errbuf.length > 8192) errbuf = errbuf.slice(-8192); this.log(node.id, 'stderr', String(d).trim()); });
      child.on('error', (e) => this.log(node.id, 'error', e.code === 'ENOENT' ? `${rt.label} binary not found: "${rt.bin(settings)}". Install it or set its path in Settings (run failed, no fallback).` : 'spawn failed: ' + e.message));
      child.on('close', (code) => {
        run.done = true;
        run.stderr = errbuf.trim();
        if (a.currentRun === run) a.currentRun = null;
        try {
          if (buf.trim()) this.onEvent(node, buf.trim(), run, rt.id);
          if (run.subs && run.subs.records.length) {
            // Anything still 'running' can never finish once the CLI is gone: abort before persisting.
            for (const rec of run.subs.close()) this.emit('subagent', { nodeId: node.id, record: { ...rec } });
            usage.subagents = run.subs.snapshot(); // per-run history: listRuns()[i].subagents rebuilds after a restart
            this.syncSubs(node.id, run);
          }
          delete usage.baseline;
          if (usage.sessionId && usage.cumulative) (this.sessionCum ||= new Map()).set(usage.sessionId, usage.cumulative);
          if (args) this.record(U.finishRun(usage, { code, env, billingMode: meta.billingMode, startedMs }));
        } catch (e) { this.log(node.id, 'error', 'run close bookkeeping crashed: ' + e.message); }
        resolve({ code, ...run });
      });
    });
  }

  // Cheap completion check for goal mode (separate short claude run with --json-schema).
  // An unreadable answer is retried once; if it is still unreadable the result is marked inconclusive
  // (never fed back to the agent as "not met") and the raw checker output is logged for debugging.
  async judge(node, m, task, lastResult, cwd, env, settings, meta = {}) {
    let j = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      j = await this.judgeOnce(node, m, task, lastResult, cwd, env, settings, meta);
      if (!j.unreadable) return j;
      this.log(node.id, 'error', `goal check attempt ${attempt}: ${j.reason}; raw checker output: ${String(j.out || '').trim().slice(0, 1500) || '(empty)'}${j.stderr ? ' | stderr: ' + j.stderr.trim().slice(0, 300) : ''}`);
      if (!this.running) break;
    }
    return { ...j, inconclusive: true, reason: `checker inconclusive (${j.reason})` };
  }
  judgeOnce(node, m, task, lastResult, cwd, env, settings, meta = {}) {
    return new Promise((resolve) => {
      let out = ''; let err = ''; const startedMs = Date.now();
      const child = spawn(settings.claudePath, judgeArgs(m, task, lastResult), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.procs.set(node.id, child);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => this.log(node.id, 'error', 'checker spawn failed: ' + e.message));
      child.on('close', () => {
        const j = parseJudge(out);
        const rec = U.newRun({ projectId: this.store.meta() ? this.store.meta().id : null, nodeId: node.id, agent: node.name, ...meta, kind: 'check' });
        rec.runtime = meta.runtime || node.runtime || 'unknown';
        if (j.raw) U.applyEvent(rec, { ...j.raw, type: 'result' }); else rec.reportedCostUsd = j.cost;
        if (!rec.model) rec.model = m.checkModel || '';
        this.record(U.finishRun(rec, { code: j.raw ? 0 : 1, env, billingMode: meta.billingMode, startedMs }));
        if (!j.unreadable) this.log(node.id, 'system', `goal check: ${j.met ? 'MET' : 'not met'} (${j.reason.slice(0, 200)}) cost=$${j.cost.toFixed(4)}`);
        resolve(j.unreadable ? Object.assign(j, { out, stderr: err }) : j);
      });
    });
  }

  async runTask(node, task, team, settings) {
    // Single-run lock, enforced at the last choke point: never a second live run for one agent, even
    // if a caller raced past its own guard.
    if (this.procs.has(node.id)) { this.log(node.id, 'error', `dispatch refused: ${node.name} already has a live run (single run per agent)`); return; }
    this.runs++;
    const reviewPickup = task.status === 'review'; // dispatched to review a hand-off: ending clean approves it
    this.store.updateTask(task.id, { status: 'in_progress' });
    const a = this.agent(node.id); a.status = 'working'; a.lastError = null; a.taskId = task.id; a.task = task.title; a.runs++; a.iteration = 1; a.reviewPickup = reviewPickup; a.wakePending = null; // the prompt carries the unread count
    this.procs.set(node.id, { kill() {} }); // reserve the slot synchronously
    try {
      this.changed();
      const mcp = this.mcpConfig(node);
      let cwd = node.workdir || this.store.dir;
      fs.mkdirSync(cwd, { recursive: true });
      // Concurrent runs sharing a workdir each get their own git worktree/branch so their edits don't collide.
      if (!this.cwds) this.cwds = new Map();
      const shared = [...this.cwds.entries()].some(([id, d]) => id !== node.id && d === cwd);
      this.cwds.set(node.id, cwd);
      let worktree = false;
      if (settings.useWorktrees || shared) {
        // Conflict-resolution tasks are pre-assigned the original task's worktree/branch (never a
        // fresh one) so resolving them re-merges the SAME branch instead of stranding it behind a new one.
        if (task.isConflictResolution && task.worktreePath && fs.existsSync(task.worktreePath)) { cwd = task.worktreePath; worktree = true; }
        else {
          const w = WT.ensureWorktree(cwd, task.id);
          if (w.warning) this.log(node.id, 'error', 'warning: ' + w.warning);
          else { cwd = w.cwd; worktree = true; this.store.updateTask(task.id, { worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch }); }
        }
      }
      const presets = settings.rolePresets || [];
      const unread = this.store.listMessages({ to: node.id }).filter((m) => !m.read).length;
      let cfg; let base = null; let baseDefer = null;
      try {
        cfg = normalizeNode(applyPreset(node, presets)); base = buildPrompt(team, node, task, { presets, unread, boardDir: this.store.dir, worktree });
        const lm = normalizeMode(cfg); // loop mode: every pass but the last is told not to mark the task done
        baseDefer = lm.mode === 'loop' && lm.loopCount > 1 ? buildPrompt(team, node, task, { presets, unread, boardDir: this.store.dir, deferDone: `${lm.loopCount} passes`, worktree }) : base;
      } catch (e) { cfg = { env: {}, mode: 'single' }; this.log(node.id, 'error', 'bad agent settings: ' + e.message); }
      const m = normalizeMode(cfg);
      // Workflow mode: only the task text follows the slash command ($ARGUMENTS); the team context goes in --append-system-prompt.
      const wf = m.mode === 'workflow' && !!m.slashCommand && base !== null;
      const runCfg = wf ? { ...cfg, appendSystemPrompt: [base, cfg.appendSystemPrompt].filter(Boolean).join('\n\n') } : cfg;
      if (m.mode === 'goal' && !m.goalCondition.trim()) { this.log(node.id, 'error', 'goal mode without a completion condition: running once'); m.mode = 'single'; }
      const bill = U.applyBillingEnv(cfg, this.env(cfg)); const env = bill.env;
      for (const w of bill.warnings) this.log(node.id, 'error', w);
      const meta = { taskId: task.id, task: task.title, billingMode: cfg.billingMode || 'auto', runtime: cfg.runtime || 'claude' };
      // claude >=2.1.284 reads CLAUDE_AUTOCOMPACT_PCT_OVERRIDE as a percent (0-100] of the context
      // window (see autoCompactEnv) — this is set at spawn instead of the app sending /compact itself.
      // Per-agent threshold wins over the project default so thinkers (PM/reviewer/critic) can compact later.
      const autoCompactPct = Number(cfg.autoCompactPct || (settings.autoCompactPct ?? 40));
      if (meta.runtime === 'claude' && autoCompactPct > 0) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = autoCompactEnv(autoCompactPct);
      a.runtime = meta.runtime; a.model = cfg.model || '';
      // Sessions are per owner: only resume this agent's own session on this runtime (the legacy
      // shared task.sessionId had no owner info and got other agents' dead sessions resumed).
      const sessKey = `${node.id}:${meta.runtime}`;
      let resume = (task.sessions && task.sessions[sessKey]) || (m.continueSession ? this.lastSession(node.id, meta.runtime) : null);
      this.log(node.id, 'system', `▶ ${node.name} starts "${task.title}" in ${cwd} [mode=${m.mode}${resume ? ', resume ' + resume : ''}]`);
      let code = 1; let judge = null; let i = 0; let reason = ''; let human = null; let recover = false; let humanAtts = []; let freshTried = false;
      a.stopRequested = false; a.pendingHuman = [];
      for (;;) {
        // The run was killed for a self-update restart (haltProcs): no further iterations, human
        // deliveries or stall recoveries — the task stays in_progress and resumes after the relaunch.
        if (this.drainCutNodes.has(node.id)) { reason = 'interrupted for self-update restart'; break; }
        a.iteration = i + 1; this.changed();
        let args = null;
        if (base !== null) {
          const b = m.mode === 'loop' && !isLastLoop(m, i) ? baseDefer : base;
          const prompt = human ? humanPrompt(human, resume || wf ? null : b) : recover ? stallPrompt(task) : iterationPrompt(m, b, i, { reason: judge && judge.reason, task: wf ? (this.store.getTask(task.id) || task) : null });
          // Only runs that actually carry attachments get the attachments dir passed (claude maps it
          // to --add-dir; profile runtimes work from the paths in the prompt).
          const runAtts = (task.attachments || []).concat(humanAtts);
          try { args = RT.getRuntime(cfg.runtime).buildArgs(runCfg, prompt, settings, mcp, { resume, cwd, env, ...(runAtts.length ? { attachDir: this.store.attachmentsDir() } : {}) }); }
          catch (e) { this.log(node.id, 'error', 'bad agent settings: ' + e.message); }
        }
        if (i > 0) this.log(node.id, 'system', `↻ ${node.name} iteration ${i + 1} (${m.mode})`);
        const usedResume = !!(args && resume);
        const r = await this.spawnRun(node, args, cwd, env, settings, { ...meta, iteration: i + 1, resumedFrom: usedResume ? resume : null });
        code = r.code; i++; human = null; recover = false; humanAtts = [];
        if (r.sessionId) {
          resume = r.sessionId;
          const tp = this.store.getTask(task.id);
          this.store.updateTask(task.id, { sessions: { ...((tp && tp.sessions) || {}), [sessKey]: r.sessionId }, iterations: i });
        }
        // A resume can fail because the session id went stale (sessions are per cwd; ids stored
        // before the per-owner key may belong to another agent or runtime): retry once from a fresh
        // session instead of failing the whole run.
        if (usedResume && code !== 0 && !freshTried && /No conversation found|Session not found/.test(`${r.result || ''}\n${r.stderr || ''}`)) {
          freshTried = true;
          const tp = this.store.getTask(task.id);
          const sessions = { ...((tp && tp.sessions) || {}) };
          delete sessions[sessKey];
          this.store.updateTask(task.id, { sessions });
          resume = null;
          this.log(node.id, 'system', '↻ resume failed (session not found): retrying once from a fresh session');
          continue;
        }
        // A run that got through (exit 0) is real progress: the stall counter resets (persisted on the task,
        // so it survives app restarts — otherwise a restart would re-arm the recovery budget).
        if (code === 0) { const tp = this.store.getTask(task.id); if (tp && tp.stallRecoveries) this.store.updateTask(task.id, { stallRecoveries: 0 }); }
        // Stalled run confirmed exited (the watchdog killed it after the run.stalled claim): resume the
        // same session with a continue prompt, at most STALL.MAX_RECOVERIES times per task (persisted
        // counter), then park the task for a human. Only when the orchestrator is still running and no
        // manual stop interleaved.
        if (r.stalled && code !== 0 && this.running && !a.stopRequested) {
          const ts = this.store.getTask(task.id);
          const attempt = ((ts && ts.stallRecoveries) || 0) + 1;
          if (attempt > STALL.MAX_RECOVERIES) {
            this.store.updateTask(task.id, { stallRecoveries: attempt, status: 'waiting_for_human' });
            this.store.commentTask(task.id, 'orchestrator', `Run stalled ${attempt} time(s); the ${STALL.MAX_RECOVERIES} automatic stop+resume recoveries are used up. Parked for a human.`);
            this.emit('run.recovery_failed', { nodeId: node.id, taskId: task.id, attempt: attempt - 1, final: true });
            this.log(node.id, 'error', `stall recovery failed: ${attempt - 1} automatic resume(s) already used; parked for a human`);
            reason = `stalled after ${attempt - 1} recovery attempt(s)`; break;
          }
          if (!resume) {
            // No session id to resume: never silently retry fresh (would lose the session's context).
            this.store.updateTask(task.id, { stallRecoveries: attempt, status: 'waiting_for_human' });
            this.store.commentTask(task.id, 'orchestrator', 'Run stalled; automatic recovery failed because the run reported no session id to resume. Parked for a human.');
            this.emit('run.recovery_failed', { nodeId: node.id, taskId: task.id, attempt, final: true, reason: 'no session' });
            this.log(node.id, 'error', 'stall recovery failed: no session id was reported, the same session cannot be resumed');
            reason = 'stalled: no session to resume'; break;
          }
          this.store.updateTask(task.id, { stallRecoveries: attempt, status: 'in_progress' });
          a.stall = { attempt, max: STALL.MAX_RECOVERIES };
          this.log(node.id, 'system', `↻ stall recovery ${attempt}/${STALL.MAX_RECOVERIES}: resuming the same session with a continue prompt`);
          this.emit('run.recovering', { nodeId: node.id, taskId: task.id, attempt, max: STALL.MAX_RECOVERIES });
          recover = true;
          continue;
        }
        const msgs = a.pendingHuman.splice(0);
        if (msgs.length && this.running && !a.stopRequested && !this.drainCutNodes.has(node.id)) {
          try { this.store.markMessagesRead(msgs.map((x) => x.id)); } catch {}
          if (this.runs >= settings.maxRuns) { reason = 'maxRuns reached'; break; }
          humanAtts = msgs.flatMap((x) => x.attachments || []);
          human = [msgs.map((x) => x.text).join('\n\n'), attachedFilesLines(humanAtts)].filter(Boolean).join('\n\n');
          this.runs++; a.runs++;
          this.log(node.id, 'system', `↻ ${node.name} resumes with the human message`);
          const tt = this.store.getTask(task.id); if (tt && tt.status !== 'in_progress') this.store.updateTask(task.id, { status: 'in_progress' });
          continue;
        }
        judge = null;
        if (m.mode === 'goal' && code === 0 && this.running) judge = await this.judge(node, m, this.store.getTask(task.id) || task, r.result, cwd, env, settings, { ...meta, apiKeySource: r.usage ? r.usage.apiKeySource : null }); // json output has no init event: same env as the agent run
        const t = this.store.getTask(task.id);
        const step = nextStep(m, i, { code, stopped: !this.running || !!a.stopRequested, judge, taskStatus: t && t.status });
        reason = step.why;
        if (!step.again) break;
        if (this.runs >= settings.maxRuns) { reason = 'maxRuns reached'; break; }
        this.runs++; a.runs++;
        if (t && t.status !== 'in_progress') this.store.updateTask(task.id, { status: 'in_progress' });
      }
      const stoppedWhy = a.stopRequested; a.stopRequested = false;
      a.status = 'idle'; a.taskId = null; a.task = null; a.iteration = 0; a.stall = null;
      const t = this.store.getTask(task.id);
      const gate = (st) => C.gateStatus(st, node, this.store.getSettings());
      if (m.mode === 'goal' && t && judge && !judge.met && t.status === 'done') {
        // Parked for a human, not a "please review this" hand-off: never auto-dispatched/auto-advanced.
        this.store.updateTask(task.id, { status: 'review', parkedForHuman: true });
        this.store.commentTask(task.id, 'orchestrator', judge.inconclusive ? `Goal check was inconclusive after ${i} iteration(s): ${judge.reason}. Check the result yourself.` : `Goal condition not met after ${i} iteration(s) (${reason}): ${judge.reason}`);
      } else if (t && t.status === 'in_progress' && !this.drainCutNodes.has(node.id)) {
        // Agent ended without updating status: a normal dispatch hands off to review —
        // autoAdvanceReviews() then moves it to the reviewer, or leaves it in review (surfaced)
        // when none is configured — so nothing merges unreviewed. A run dispatched to review that
        // ends clean approves the hand-off (done); a failed/stopped run parks for a human instead.
        // (A run killed by the self-update drain cutoff skips this: its task stays in_progress so the
        // post-restart reconcile re-dispatches it instead of parking it for a human.)
        const ok = code === 0 && this.running && !stoppedWhy && !(m.mode === 'goal' && !(judge && judge.met));
        const g = gate(ok && a.reviewPickup ? 'done' : 'review');
        if (!ok) g.parkedForHuman = true;
        this.store.updateTask(task.id, g);
        this.store.commentTask(task.id, 'orchestrator', stoppedWhy ? `Agent stopped (${stoppedWhy}) after ${i} iteration(s); moved to review.` : `Agent exited (code ${code}) without setting status after ${i} iteration(s) (${reason}); moved to review.`);
      } else if (t && t.status === 'review' && !t.parkedForHuman && code !== 0 && this.running && !stoppedWhy && !this.drainCutNodes.has(node.id)) {
        // The agent itself moved this to 'review' (clearing parkedForHuman) but the process then crashed
        // (nonzero exit). A crashed run must never look like a clean hand-off eligible for silent
        // auto-advance to done: park it for a human to inspect.
        this.store.updateTask(task.id, { parkedForHuman: true });
        this.store.commentTask(task.id, 'orchestrator', `Agent exited (code ${code}) after moving this task to review during iteration ${i}; parked for a human because the run crashed.`);
      }
      const t2 = this.store.getTask(task.id);
      if (t2 && t2.awaitingApproval) { this.log(node.id, 'system', `⏸ "${task.title}" waits for human approval`); this.notify('Approval needed', `${node.name}: ${task.title}`, { taskId: task.id }); }
      this.log(node.id, 'system', `■ ${node.name} finished (exit ${code}, ${i} iteration(s), ${reason})`);
      this.changed();
    } catch (e) {
      a.status = 'idle'; a.taskId = null; a.task = null; a.iteration = 0; a.stall = null; a.stopRequested = false;
      this.log(node.id, 'error', `agent run crashed: ${e.message}`);
      this.changed();
    } finally {
      // Released however the bookkeeping above ends: a leaked slot leaves a self-update
      // drain waiting forever for an agent that already exited.
      this.procs.delete(node.id); this.cwds.delete(node.id);
    }
    setImmediate(() => this.tick());
    setImmediate(() => this.tick());
  }

  mcpConfig(node) { return { mcpServers: { board: { type: 'stdio', command: process.execPath, args: [MCP_SERVER, '--project', this.store.dir, '--node', node.id], env: { ELECTRON_RUN_AS_NODE: '1' } } } }; }

  // Preflight test of one agent with its exact run config. Resolves the evaluated result (see preflight.js).
  async preflight(node, settings = this.store.getSettings()) {
    const presets = settings.rolePresets || [];
    let cfg;
    try { cfg = normalizeNode(applyPreset(node, presets)); } catch (e) { return { ok: false, checks: [{ id: 'config', label: 'agent settings', ok: false, detail: e.message }], error: 'agent settings: ' + e.message, at: new Date().toISOString() }; }
    if (cfg.runtime && cfg.runtime !== 'claude') { // other runtimes: binary + version check only
      const d = RT.detectRuntimes(settings, this.env(cfg))[cfg.runtime] || { installed: false, version: null, error: 'unknown runtime' };
      const r = { ok: d.installed, runtime: cfg.runtime, checks: [{ id: 'binary', label: cfg.runtime + ' binary', ok: d.installed, detail: d.installed ? cfg.runtime + ' ' + d.version : d.error }], error: d.installed ? null : cfg.runtime + ' ' + d.error, at: new Date().toISOString(), configHash: PF.configHash(node, settings) };
      this.log(node.id, r.ok ? 'result' : 'error', `⚑ preflight ${node.name} [${cfg.runtime}] ${r.ok ? 'PASS' : 'FAIL'}: ${r.checks[0].detail}`);
      this.changed(); return r;
    }
    const cwd = node.workdir || this.store.dir;
    try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
    const bill = U.applyBillingEnv(cfg, this.env(cfg));
    const a = this.agent(node.id); a.preflight = 'testing'; this.changed();
    this.log(node.id, 'system', `⚑ preflight ${node.name}: model=${cfg.model || 'default'} perms=${cfg.permissionMode || settings.permissionMode}`);
    // runtime-less nodes run the claude CLI here (only falsy/claude runtimes reach this path) —
    // stamp that, not 'unknown', so usage rows key the claude account instead of an unattributed one
    const usage = U.newRun({ projectId: this.store.meta() ? this.store.meta().id : null, nodeId: node.id, agent: node.name, kind: 'preflight', task: 'preflight', runtime: node.runtime || 'claude', billingMode: cfg.billingMode || 'auto' });
    const t0 = Date.now(); let r;
    try {
      r = await PF.runPreflight({ cfg, settings, mcp: this.mcpConfig(node), cwd, env: bill.env, onEvent: (ev) => U.applyEvent(usage, ev) });
    } finally { a.preflight = null; }
    const events = r.events || []; delete r.events;
    if (events.length) this.record(U.finishRun(usage, { code: r.exitCode, env: bill.env, billingMode: cfg.billingMode, startedMs: t0 }));
    for (const w of bill.warnings) this.log(node.id, 'error', w);
    r.configHash = PF.configHash(node, settings);
    this.log(node.id, r.ok ? 'result' : 'error', `⚑ preflight ${node.name} ${r.ok ? 'PASS' : 'FAIL'}${r.ok ? '' : ': ' + r.error} (${r.latencyMs || 0}ms, apiKeySource=${r.apiKeySource ?? '?'}, ${(r.tokens && r.tokens.inputTokens) || 0} in / ${(r.tokens && r.tokens.outputTokens) || 0} out)`);
    this.changed();
    return r;
  }

  // Mirror the run's subagent tracker into live agent state for the snapshot (renderer reads
  // a.subagents / a.subagentCount / a.subagentTokens). Records are copies, not live references.
  syncSubs(nodeId, run) {
    if (!run || !run.subs) return;
    const a = this.agent(nodeId);
    a.subagents = run.subs.snapshot();
    a.subagentCount = a.subagents.length;
    a.subagentTokens = run.subs.totals();
    this.changed();
  }
  // Apply one subagent signal from a runtime parser ({toolUseId, phase, status, toolName, description,
  // prompt, startedAt, endedAt, childSessionId}): create/complete the record, mirror state, notify.
  onSubagentSignal(nodeId, run, s) {
    const subs = run.subs;
    let rec = subs.start(s);
    if (s.phase === 'end') rec = subs.end(s.toolUseId, { status: s.status, endedAt: s.endedAt });
    if (s.childSessionId && !rec.childSessionId) rec.childSessionId = s.childSessionId;
    this.syncSubs(nodeId, run);
    this.emit('subagent', { nodeId, record: { ...rec } });
  }

  onEvent(node, line, run, runtime = 'claude') {
    let ev; try { ev = JSON.parse(line); } catch { return this.log(node.id, 'raw', line); }
    const a = this.agent(node.id);
    // A parsed event is liveness for the stall watchdog (a stalled run's late events don't count).
    if (run && !run.stalled) a.lastActivityAt = Date.now();
    // Runtimes that declare a parseEvent hook (codex, profile-driven CLIs) parse their own events;
    // no per-CLI branch here. Claude's stream-json stays handled inline below.
    const rt = (() => { try { return RT.getRuntime(runtime); } catch { return null; } })();
    if (rt && rt.parseEvent) {
      const o = rt.parseEvent(ev, this.store.getSettings());
      for (const [k, t] of o.logs) if (String(t).trim()) this.log(node.id, k, t);
      if (run && run.subs && o.subagent) this.onSubagentSignal(node.id, run, o.subagent);
      if (run && o.sessionId) { run.sessionId = o.sessionId; if (run.usage) run.usage.sessionId = o.sessionId; }
      if (run && o.result !== undefined) run.result = o.result;
      if (o.tokens && run && run.usage) {
        const u = run.usage;
        u.inputTokens = (u.inputTokens || 0) + (o.tokens.inputTokens || 0);
        u.outputTokens = (u.outputTokens || 0) + (o.tokens.outputTokens || 0);
        // cache reads reported per turn; cache writes are unknown for these runtimes (ledger keeps them null)
        const fsn = (u.flatSeen ||= []);
        if (o.tokens.inputTokens != null && !fsn.includes('inputTokens')) fsn.push('inputTokens');
        if (o.tokens.outputTokens != null && !fsn.includes('outputTokens')) fsn.push('outputTokens');
        if (o.tokens.cacheReadTokens != null) { u.cacheReadTokens = (u.cacheReadTokens || 0) + o.tokens.cacheReadTokens; if (!fsn.includes('cacheReadTokens')) fsn.push('cacheReadTokens'); }
        u.reportedCostUsd = (u.reportedCostUsd || 0) + (o.cost || 0);
        this.changed();
      } // record() adds the run's totals to the agent counters at close; adding them here too would double-count
      return;
    }
    // Subagent scoping (claude stream-json): every event belonging to a spawned subagent carries the
    // tool_use id of the Agent/Task call that started it. The tool_use itself is the start, its
    // tool_result (a parent-level user event) the end; children are matched by id, never arrival order
    // (parallel subagents interleave in the stream).
    const subs = run && run.subs;
    const parentTag = ev.parent_tool_use_id && subs ? subs.tagFor(ev.parent_tool_use_id) : null;
    const subTag = parentTag ? { subagentId: parentTag.id } : null;
    if (ev.type === 'assistant' && ev.message?.content) {
      // Stream-json can repeat the same message id across deltas; only the first sighting is a new turn.
      // Child (subagent) turns are excluded: their usage describes the subagent's context, not this agent's.
      const ctx = !ev.parent_tool_use_id ? U.contextFromAssistant(ev) : null;
      if (ctx && ctx.messageId !== a.lastContextMessageId) {
        a.lastContextMessageId = ctx.messageId;
        a.contextWindow = U.contextWindowFor(ctx.model || a.model);
        a.contextTokens = ctx.contextTokens;
        a.contextPct = a.contextWindow ? ctx.contextTokens / a.contextWindow : null;
        this.changed();
      }
      // Per-subagent token breakdown from the child turns' own message usage (deduped by message id).
      if (parentTag && ev.message.usage) {
        subs.addTokens(ev.parent_tool_use_id, { inputTokens: ev.message.usage.input_tokens, outputTokens: ev.message.usage.output_tokens }, ev.message.id);
        this.syncSubs(node.id, run);
      }
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text.trim()) this.log(node.id, 'text', c.text, subTag);
        else if (c.type === 'tool_use') {
          if (subs && isSubagentTool(c.name)) {
            const rec = subs.start({
              toolUseId: c.id,
              parentToolUseId: ev.parent_tool_use_id || null,
              toolName: c.name,
              description: (c.input && (c.input.description || c.input.subagent_type)) || '',
              prompt: (c.input && c.input.prompt) || '',
            });
            this.syncSubs(node.id, run);
            this.emit('subagent', { nodeId: node.id, record: { ...rec } });
          }
          this.log(node.id, 'tool', `${c.name} ${JSON.stringify(c.input).slice(0, 300)}`, subTag);
        }
      }
    } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      const cb = U.parseCompactBoundary(ev);
      if (cb) {
        // Unknown again until the next assistant turn reports fresh usage: the pre-compact % no longer applies.
        a.contextTokens = null; a.contextPct = null; a.lastContextMessageId = null;
        this.log(node.id, 'compacted', `${cb.trigger === 'auto' ? 'auto-compacted' : 'compacted'} ${cb.preTokens}→${cb.postTokens} tokens`);
        this.emit('compacted', { nodeId: node.id, ...cb });
        this.changed();
      }
    } else if (ev.type === 'user' && ev.message?.content) {
      for (const c of ev.message.content) if (c.type === 'tool_result') {
        // A parent-level result for a tracked Agent/Task tool_use ends that subagent (is_error -> failed).
        if (!parentTag && subs && subs.record(c.tool_use_id)) {
          const rec = subs.end(c.tool_use_id, { status: c.is_error ? 'failed' : 'completed' });
          this.syncSubs(node.id, run);
          this.emit('subagent', { nodeId: node.id, record: { ...rec } });
        }
        const txt = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : String(c.content ?? '');
        this.log(node.id, c.is_error ? 'tool_error' : 'tool_result', txt.slice(0, 400), subTag);
      }
    } else if (ev.type === 'result') {
      if (run) { run.result = typeof ev.result === 'string' ? ev.result : ''; if (ev.session_id) run.sessionId = ev.session_id; }
      const cost = Number(ev.total_cost_usd) || 0;
      if (run && run.usage) U.applyEvent(run.usage, ev);
      else { const t = U.tokensFromResult(ev); a.inputTokens += t.inputTokens; a.outputTokens += t.outputTokens; a.cost += cost; this.totalCost += cost; }
      if (ev.is_error && ev.result) this.log(node.id, 'error', String(ev.result).slice(0, 500));
      const own = run && run.usage ? run.usage : null;
      this.log(node.id, ev.is_error ? 'error' : 'result', `${ev.subtype} cost=$${(own ? own.reportedCostUsd : cost).toFixed(4)} turns=${ev.num_turns}${own && own.resumedFrom ? ` (this run only; session total $${cost.toFixed(4)})` : ''}`);
      this.changed();
    } else if (ev.type === 'rate_limit_event') {
      // The claude CLI's real, live 5h/weekly usage % — a separate stream event (rate_limit_info.unifiedWindows),
      // not part of the system/init event below. This is the actual source for the top bar's "5h"/"weekly" meter.
      // Stamped with the reporting runtime so a node repointed to another runtime drops the old CLI's windows
      // (usage.js nodeLiveRateLimits) instead of passing them off as the new provider's quota.
      const rl0 = U.parseRateLimits(ev);
      if (rl0) {
        const rl = { ...rl0, runtime };
        (this.subscriptionRateLimits ||= {})[node.id] = rl; this.checkUsageLimits(node.id); this.changed();
        try { this.store.updateNode(node.id, { rateLimits: rl, rateLimitsAt: new Date().toISOString() }); } catch {}
      }
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      const mcpStatus = (ev.mcp_servers || []).map((s) => `${s.name}:${s.status}`).join(',');
      if (run && ev.session_id) run.sessionId = ev.session_id;
      if (run && run.usage) U.applyEvent(run.usage, ev);
      const rl0 = U.parseRateLimits(ev);
      if (rl0) {
        const rl = { ...rl0, runtime }; // stamped: see the rate_limit_event branch above
        (this.subscriptionRateLimits ||= {})[node.id] = rl; this.checkUsageLimits(node.id);
        try { this.store.updateNode(node.id, { rateLimits: rl, rateLimitsAt: new Date().toISOString() }); } catch {}
      }
      // Automatic capability discovery: every run's init event is a free, live "probe" (richer than --help),
      // so cache it per node and re-merge whenever the model/provider changed or the TTL lapsed since the last
      // one (capabilities.needsReprobe) — no extra CLI invocation needed. Manual Refresh (main.js IPC) still
      // does a full --help probe on demand.
      try {
        const signature = CAP.capabilitySignature({ runtime, model: ev.model, provider: run && run.usage ? run.usage.billingMode : undefined });
        const fromInit = CAP.fromInitEvent(ev);
        const hasNewData = fromInit.slashCommands.length || fromInit.skills.length || fromInit.modes.length;
        if (hasNewData || CAP.needsReprobe(node, signature)) {
          const prev = node.capabilities || {};
          const slashCommands = [...new Set([...(prev.slashCommands || []), ...fromInit.slashCommands])];
          const skills = fromInit.skills.length ? fromInit.skills : (prev.skills || []);
          const modes = [...new Set([...CAP.detectAppModes('', slashCommands), ...(prev.modes || []), ...fromInit.modes])];
          const mcpServers = Object.keys((this.store.getSettings().mcpServers && typeof this.store.getSettings().mcpServers === 'object') ? this.store.getSettings().mcpServers : {});
          const categorized = CAP.categorize({ modes, skills, slashCommands, mcpServers });
          const merged = { ...prev, ...fromInit, slashCommands, skills, modes, categorized };
          this.store.updateNode(node.id, { capabilities: merged, capabilitiesProbedAt: merged.probedAt, capabilitiesSignature: signature });
        }
      } catch {}
      this.log(node.id, 'system', `session ${ev.session_id} model=${ev.model} apiKeySource=${ev.apiKeySource ?? '?'} mcp=${mcpStatus}`);
    }
  }
}
module.exports = { Orchestrator, buildPrompt, humanPrompt, wakePrompt, stallPrompt, attachedFilesLines, WAKE, STALL, autoCompactEnv };
