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

const MCP_SERVER = path.join(__dirname, 'mcp-server.js');

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
    `You are "${node.name}", role ${node.role}, in an agent team called Agents Squad (your node id: ${node.id}).`,
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
    (task.blockedBy || []).length ? `This task depended on: ${task.blockedBy.join(', ')} (all done now; read their comments with list_tasks if useful).` : '',
    task.comments.length ? `Comments so far:\n${task.comments.map((c) => `- ${c.author}: ${c.text}`).join('\n')}` : '',
    '',
    `Coordinate ONLY through the "board" MCP tools (${tools.join(', ')}).`,
    tools.includes('update_task_status') && extra.deferDone ? `This task runs in loop mode (${extra.deferDone}). Do NOT call update_task_status with status="done" in this pass${tools.includes('comment_task') ? '; you may add a short comment on what you did' : ''}. The orchestrator repeats the task and you will be told when the final pass comes.` : '',
    tools.includes('update_task_status') && !extra.deferDone ? `When you have finished your part, ${tools.includes('comment_task') ? 'add a short comment summarising what you did and ' : ''}call update_task_status with taskId=${task.id} and status="done".` : '',
    'Be concise and finish in as few steps as possible.',
  ].filter((l) => l !== '').join('\n');
}

// Prompt for a resumed run that delivers a human message (base is included when there is no session to resume).
function humanPrompt(text, base = null) {
  return [base, `Message from the human operator (answer or act on it, then continue your task):\n${text}`].filter(Boolean).join('\n\n');
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
    // Seed from each node's persisted rate-limit snapshot (usage.js parseRateLimits, written by applyEvent's
    // init/rate_limit_event handling below) so a restarted app shows the CLI's last-known 5h/weekly usage
    // immediately, instead of waiting for a fresh run to repopulate this in-memory map.
    this.subscriptionRateLimits = {};
    // Only restore still-live snapshots: one whose resetsAt passed while the app was down describes a
    // window that already reset, and must not pause dispatch (usage.js liveRateLimits).
    try { for (const n of store.getTeam().nodes) { const rl = U.liveRateLimits(n.rateLimits); if (rl) this.subscriptionRateLimits[n.id] = rl; } } catch {}
  }
  agent(id) { return (this.agents[id] ||= { runCost: 0, runTokens: 0, pendingHuman: [], stopRequested: false, budgetStop: null, status: 'idle', iteration: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, runs: 0, taskId: null, task: null, model: '', runtime: '', billingSource: '', contextTokens: null, contextWindow: 0, contextPct: null, lastContextMessageId: null }); }
  // modelStats: per-model aggregate across this project's persisted runs + tasks (see usage.js modelStats for the field shape).
  modelStats() { let rs = []; try { rs = this.store.listRuns(); } catch {} let ts = []; try { ts = this.store.listTasks(); } catch {} return U.modelStats(rs, ts); }
  // nodeTeams: {nodeId: {teamId, teamName}} across all teams in the project, for tagging log/timeline entries.
  nodeTeams() { try { return this.store.nodeTeamMap(); } catch { return {}; } }
  // timeline: per-run start/end per agent+task, lanes ordered needs-attention first (TL.timeline, see timeline.js).
  timeline() { let rs = []; let ts = []; try { rs = this.store.listRuns(); } catch {} try { ts = this.store.listTasks(); } catch {} return TL.timeline(rs, ts, this.nodeTeams()); }
  // logs: structured {ts, agentId, level, text} entries from the persisted orchestrator log.
  logs(limit) { let ls = []; try { ls = this.store.readLogs(limit); } catch {} return TL.logEntries(ls, this.nodeTeams()); }
  // wiki: [{title, body, updatedAt, author}], from the store's {title: {...}} page map.
  wiki() { let ps = {}; try { ps = this.store.listWiki(); } catch {} return TL.wikiPages(ps); }
  snapshot() { return { running: this.running, totalCost: this.totalCost, billedCost: this.billedCost || 0, subCost: this.subCost || 0, runs: this.runs, active: [...this.procs.keys()].map((id) => ({ nodeId: id, taskId: this.agent(id).taskId, cwd: this.cwds && this.cwds.get(id) || null })), runCost: this.runCost || 0, runTokens: this.runTokens || 0, budgetStop: this.budgetStop || null, agents: Object.fromEntries(Object.entries(this.agents).map(([k, a]) => [k, { ...a, pendingHuman: a.pendingHuman.length }])), tokens: this.tokens || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelStats: this.modelStats(), timeline: this.timeline(), logs: this.logs(), wiki: this.wiki(), nodeTeams: this.nodeTeams() }; }
  // Account one finished run: agent counters, session totals, persisted history.
  record(rec) {
    const a = this.agent(rec.nodeId); const t = (this.tokens ||= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) { a[k] += rec[k]; t[k] += rec[k]; }
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
  log(nodeId, kind, text) {
    const a = nodeId && this.agents[nodeId];
    const l = { nodeId, kind, text, at: Date.now(), taskId: (a && a.taskId) || null, task: (a && a.task) || null, level: TL.levelOf(kind) };
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
    // describes a window that already reset, and the freshest still-live reading is what counts.
    const rlAll = Object.values(this.subscriptionRateLimits || {}).map((rl) => U.liveRateLimits(rl)).filter(Boolean);
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
  // interrupted and resumed in the same session with the message as the next prompt.
  sendToAgent(nodeId, text, taskId = null) {
    if (!String(text || '').trim()) throw new Error('text required');
    const a = this.agent(nodeId);
    const m = this.store.sendMessage({ from: 'human', to: nodeId, text: String(text).trim(), taskId: taskId || a.taskId || null });
    const live = a.status === 'working' && this.procs.has(nodeId) && this.running;
    if (live) { a.pendingHuman.push(m); this.log(nodeId, 'system', `✉ human message queued; interrupting to deliver: ${m.text.slice(0, 200)}`); this.procs.get(nodeId).kill('SIGTERM'); }
    else this.log(nodeId, 'system', `✉ human message stored in inbox: ${m.text.slice(0, 200)}`);
    this.changed();
    return { ...m, delivered: live ? 'interrupt' : 'inbox' };
  }
  changed() { this.emit('state', this.snapshot()); }

  start() {
    if (this.running) return;
    this.running = true; this.runs = 0; this.runCost = 0; this.runTokens = 0; this.budgetStop = null;
    for (const a of Object.values(this.agents)) { a.runCost = 0; a.runTokens = 0; a.budgetStop = null; }
    this.reconcileOrphanedTasks();
    this.log(null, 'system', 'Orchestrator started');
    this.changed();
    this.tick();
  }
  stop() {
    this.running = false;
    this.log(null, 'system', 'Orchestrator stopped');
    this.changed();
    // Only report the run done once every agent process has actually exited (kill is async: SIGTERM
    // doesn't stop them synchronously), never while one is still running/pending.
    if (this.procs.size === 0) this.emit('done', this.snapshot());
    else this._stopPending = true;
    for (const p of this.procs.values()) p.kill('SIGTERM');
  }

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
  nudgeIdle() {
    this.nudged ||= new Map();
    for (const n of IDLE.idleNudges(this.store.getTeam(), this.store.listTasks(), this.agents)) {
      if (this.nudged.get(n.pmId) === n.text) continue;
      this.nudged.set(n.pmId, n.text);
      this.store.sendMessage({ from: 'system', to: n.pmId, text: n.text });
      this.log(n.pmId, 'system', 'nudge: ' + n.text);
    }
  }

  // Tasks left in review that never got picked back up (their reviewer's process crashed/exited, or
  // the run stopped mid-way). With no reviewer configured for the assignee, auto-advances the task to
  // done (once) so its dependents unblock, instead of leaving it stranded forever. Returns the
  // (possibly stale) tasks still in review that DO have a reviewer, ready for dispatch.
  autoAdvanceReviews(team) {
    const out = [];
    for (const t of this.store.listTasks()) {
      if (t.status !== 'review' || t.awaitingApproval || t.parkedForHuman) continue;
      const reviewer = outgoing(team, t.assignee, ['review']).map((id) => team.nodes.find((n) => n.id === id)).find(Boolean);
      if (reviewer) { out.push({ task: t, node: reviewer }); continue; }
      (this._autoAdvanced ||= new Set());
      if (this._autoAdvanced.has(t.id)) continue;
      this._autoAdvanced.add(t.id);
      this.store.updateTask(t.id, { status: 'done' });
      this.store.commentTask(t.id, 'orchestrator', 'auto-advanced to done: no reviewer is configured for this task (no review edge from the assignee).');
      this.log(t.assignee, 'system', `↷ "${t.title}" auto-advanced to done (no reviewer)`);
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
    const paused = (node) => this.usagePaused && (!node || (node.runtime || 'claude') === 'claude');
    const readyTodo = todo.map((t) => ({ task: t, node: team.nodes.find((n) => n.id === t.assignee) }))
      .filter(({ task, node }) => !C.isBlocked(task, all) && !this.agent(task.assignee).budgetStop && !paused(node));
    const readyReview = reviewReady.filter(({ task, node }) => !C.isBlocked(task, all) && !this.agent(node.id).budgetStop && !paused(node));
    // Highest priority first (P0..P3); stable sort, so same-priority tasks keep arrival order.
    const ready = [...readyTodo, ...readyReview].sort((a, b) => C.priorityRank(a.task) - C.priorityRank(b.task));
    for (const { task, node } of ready) {
      if (s.maxConcurrency > 0 && this.procs.size >= s.maxConcurrency) break; // 0 = unlimited
      if (this.procs.has(node.id)) continue;
      if (this.runs >= s.maxRuns) { this.log(null, 'system', `maxRuns (${s.maxRuns}) reached`); break; }
      this.runTask(node, task, team, s);
    }
    try { this.nudgeIdle(); } catch (e) { this.log(null, 'error', 'idle nudge: ' + e.message); }
    if (this.procs.size === 0) {
      // Before declaring a stop, sweep for in_progress tasks whose agent has no live session (e.g. its
      // process exited/crashed without updating status) and re-dispatch them instead of blocking forever.
      if (this.reconcileOrphanedTasks()) { setImmediate(() => this.tick()); return; }
      this.running = false;
      const why = !todo.length && !ready.length ? 'No more todo tasks. Finished.' : !ready.length ? `Stopped: ${todo.length} todo task(s) are blocked by unfinished dependencies or over budget` : 'Stopped: run limit reached';
      this.log(null, 'system', why);
      const waiting = all.filter((t) => t.awaitingApproval).length;
      this.notify('Run finished', why + (waiting ? ` ${waiting} task(s) wait for your approval.` : ''));
      this.changed();
      // No agents running/pending at this point (procs is empty and nothing is left to dispatch): safe to report done.
      this.emit('done', this.snapshot());
    }
  }

  // The agent's most recent session id (from the board), used by continueSession.
  lastSession(nodeId) {
    const ts = this.store.listTasks().filter((t) => t.assignee === nodeId && t.sessionId).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    return ts.length ? ts[ts.length - 1].sessionId : null;
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
      if (usage.resumedFrom) usage.baseline = this.sessionBaseline(usage.resumedFrom);
      let rt; try { rt = RT.getRuntime(meta.runtime); } catch (e) { this.log(node.id, 'error', e.message + ' (run failed, no fallback)'); rt = { id: String(meta.runtime), label: String(meta.runtime), bin: () => '' }; args = null; }
      const child = args ? spawn(rt.bin(settings), args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        : Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
      if (!args) setImmediate(() => child.emit('close', 1));
      this.procs.set(node.id, child);
      const run = { sessionId: null, result: '', usage };
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.onEvent(node, line, run, rt.id); }
      });
      child.stderr.on('data', (d) => this.log(node.id, 'stderr', String(d).trim()));
      child.on('error', (e) => this.log(node.id, 'error', e.code === 'ENOENT' ? `${rt.label} binary not found: "${rt.bin(settings)}". Install it or set its path in Settings (run failed, no fallback).` : 'spawn failed: ' + e.message));
      child.on('close', (code) => {
        if (buf.trim()) this.onEvent(node, buf.trim(), run, rt.id);
        delete usage.baseline;
        if (usage.sessionId && usage.cumulative) (this.sessionCum ||= new Map()).set(usage.sessionId, usage.cumulative);
        if (args) this.record(U.finishRun(usage, { code, env, billingMode: meta.billingMode, startedMs }));
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
        if (j.raw) U.applyEvent(rec, { ...j.raw, type: 'result' }); else rec.reportedCostUsd = j.cost;
        if (!rec.model) rec.model = m.checkModel || '';
        this.record(U.finishRun(rec, { code: j.raw ? 0 : 1, env, billingMode: meta.billingMode, startedMs }));
        if (!j.unreadable) this.log(node.id, 'system', `goal check: ${j.met ? 'MET' : 'not met'} (${j.reason.slice(0, 200)}) cost=$${j.cost.toFixed(4)}`);
        resolve(j.unreadable ? Object.assign(j, { out, stderr: err }) : j);
      });
    });
  }

  async runTask(node, task, team, settings) {
    this.runs++;
    this.store.updateTask(task.id, { status: 'in_progress' });
    const a = this.agent(node.id); a.status = 'working'; a.lastError = null; a.taskId = task.id; a.task = task.title; a.runs++; a.iteration = 1;
    this.procs.set(node.id, { kill() {} }); // reserve the slot synchronously
    this.changed();
    const mcp = this.mcpConfig(node);
    let cwd = node.workdir || this.store.dir;
    fs.mkdirSync(cwd, { recursive: true });
    // Concurrent runs sharing a workdir each get their own git worktree/branch so their edits don't collide.
    if (!this.cwds) this.cwds = new Map();
    const shared = [...this.cwds.entries()].some(([id, d]) => id !== node.id && d === cwd);
    this.cwds.set(node.id, cwd);
    if (settings.useWorktrees || shared) {
      // Conflict-resolution tasks are pre-assigned the original task's worktree/branch (never a
      // fresh one) so resolving them re-merges the SAME branch instead of stranding it behind a new one.
      if (task.isConflictResolution && task.worktreePath && fs.existsSync(task.worktreePath)) cwd = task.worktreePath;
      else {
        const w = WT.ensureWorktree(cwd, task.id);
        if (w.warning) this.log(node.id, 'error', 'warning: ' + w.warning);
        else { cwd = w.cwd; this.store.updateTask(task.id, { worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch }); }
      }
    }
    const presets = settings.rolePresets || [];
    const unread = this.store.listMessages({ to: node.id }).filter((m) => !m.read).length;
    let cfg; let base = null; let baseDefer = null;
    try {
      cfg = normalizeNode(applyPreset(node, presets)); base = buildPrompt(team, node, task, { presets, unread });
      const lm = normalizeMode(cfg); // loop mode: every pass but the last is told not to mark the task done
      baseDefer = lm.mode === 'loop' && lm.loopCount > 1 ? buildPrompt(team, node, task, { presets, unread, deferDone: `${lm.loopCount} passes` }) : base;
    } catch (e) { cfg = { env: {}, mode: 'single' }; this.log(node.id, 'error', 'bad agent settings: ' + e.message); }
    const m = normalizeMode(cfg);
    // Workflow mode: only the task text follows the slash command ($ARGUMENTS); the team context goes in --append-system-prompt.
    const wf = m.mode === 'workflow' && !!m.slashCommand && base !== null;
    const runCfg = wf ? { ...cfg, appendSystemPrompt: [base, cfg.appendSystemPrompt].filter(Boolean).join('\n\n') } : cfg;
    if (m.mode === 'goal' && !m.goalCondition.trim()) { this.log(node.id, 'error', 'goal mode without a completion condition: running once'); m.mode = 'single'; }
    const bill = U.applyBillingEnv(cfg, this.env(cfg)); const env = bill.env;
    for (const w of bill.warnings) this.log(node.id, 'error', w);
    const meta = { taskId: task.id, task: task.title, billingMode: cfg.billingMode || 'auto', runtime: cfg.runtime || 'claude' };
    // Verified empirically (claude 2.1.283): CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<fraction 0-1> makes the CLI
    // auto-compact on its own once context passes that fraction of the window (confirmed via a live
    // compact_boundary event). So this is set at spawn instead of the app sending /compact itself.
    // Per-agent threshold wins over the project default so thinkers (PM/reviewer/critic) can compact later.
    const autoCompactPct = Number(cfg.autoCompactPct || (settings.autoCompactPct ?? 40));
    if (meta.runtime === 'claude' && autoCompactPct > 0) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(Math.min(1, autoCompactPct / 100));
    a.runtime = meta.runtime; a.model = cfg.model || '';
    let resume = task.sessionId || (m.continueSession ? this.lastSession(node.id) : null);
    this.log(node.id, 'system', `▶ ${node.name} starts "${task.title}" in ${cwd} [mode=${m.mode}${resume ? ', resume ' + resume : ''}]`);
    let code = 1; let judge = null; let i = 0; let reason = ''; let human = null;
    a.stopRequested = false; a.pendingHuman = [];
    for (;;) {
      a.iteration = i + 1; this.changed();
      let args = null;
      if (base !== null) {
        const b = m.mode === 'loop' && !isLastLoop(m, i) ? baseDefer : base;
        const prompt = human ? humanPrompt(human, resume || wf ? null : b) : iterationPrompt(m, b, i, { reason: judge && judge.reason, task: wf ? (this.store.getTask(task.id) || task) : null });
        try { args = RT.getRuntime(cfg.runtime).buildArgs(runCfg, prompt, settings, mcp, { resume, cwd, env }); }
        catch (e) { this.log(node.id, 'error', 'bad agent settings: ' + e.message); }
      }
      if (i > 0) this.log(node.id, 'system', `↻ ${node.name} iteration ${i + 1} (${m.mode})`);
      const r = await this.spawnRun(node, args, cwd, env, settings, { ...meta, iteration: i + 1, resumedFrom: args && resume ? resume : null });
      code = r.code; i++; human = null;
      if (r.sessionId) { resume = r.sessionId; this.store.updateTask(task.id, { sessionId: r.sessionId, iterations: i }); }
      const msgs = a.pendingHuman.splice(0);
      if (msgs.length && this.running && !a.stopRequested) {
        try { this.store.markMessagesRead(msgs.map((x) => x.id)); } catch {}
        if (this.runs >= settings.maxRuns) { reason = 'maxRuns reached'; break; }
        human = msgs.map((x) => x.text).join('\n\n'); this.runs++; a.runs++;
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
    this.procs.delete(node.id); this.cwds.delete(node.id);
    const stoppedWhy = a.stopRequested; a.stopRequested = false;
    a.status = 'idle'; a.taskId = null; a.task = null; a.iteration = 0;
    const t = this.store.getTask(task.id);
    const gate = (st) => C.gateStatus(st, node, this.store.getSettings());
    if (m.mode === 'goal' && t && judge && !judge.met && t.status === 'done') {
      // Parked for a human, not a "please review this" hand-off: never auto-dispatched/auto-advanced.
      this.store.updateTask(task.id, { status: 'review', parkedForHuman: true });
      this.store.commentTask(task.id, 'orchestrator', judge.inconclusive ? `Goal check was inconclusive after ${i} iteration(s): ${judge.reason}. Check the result yourself.` : `Goal condition not met after ${i} iteration(s) (${reason}): ${judge.reason}`);
    } else if (t && t.status === 'in_progress') {
      // Agent ended without updating status: success -> done, failure -> back to review for a human.
      const ok = code === 0 && this.running && !stoppedWhy && !(m.mode === 'goal' && !(judge && judge.met));
      const g = gate(ok ? 'done' : 'review');
      if (!ok) g.parkedForHuman = true;
      this.store.updateTask(task.id, g);
      this.store.commentTask(task.id, 'orchestrator', stoppedWhy ? `Agent stopped (${stoppedWhy}) after ${i} iteration(s); moved to review.` : `Agent exited (code ${code}) without setting status after ${i} iteration(s) (${reason}); moved automatically.`);
    } else if (t && t.status === 'review' && !t.parkedForHuman && code !== 0 && this.running && !stoppedWhy) {
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
    const usage = U.newRun({ projectId: this.store.meta() ? this.store.meta().id : null, nodeId: node.id, agent: node.name, kind: 'preflight', task: 'preflight', billingMode: cfg.billingMode || 'auto' });
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

  onEvent(node, line, run, runtime = 'claude') {
    let ev; try { ev = JSON.parse(line); } catch { return this.log(node.id, 'raw', line); }
    const a = this.agent(node.id);
    // Runtimes that declare a parseEvent hook (codex, profile-driven CLIs) parse their own events;
    // no per-CLI branch here. Claude's stream-json stays handled inline below.
    const rt = (() => { try { return RT.getRuntime(runtime); } catch { return null; } })();
    if (rt && rt.parseEvent) {
      const o = rt.parseEvent(ev, this.store.getSettings());
      for (const [k, t] of o.logs) if (String(t).trim()) this.log(node.id, k, t);
      if (run && o.sessionId) { run.sessionId = o.sessionId; if (run.usage) run.usage.sessionId = o.sessionId; }
      if (run && o.result !== undefined) run.result = o.result;
      if (o.tokens) { if (run && run.usage) { run.usage.inputTokens = (run.usage.inputTokens || 0) + o.tokens.inputTokens; run.usage.outputTokens = (run.usage.outputTokens || 0) + o.tokens.outputTokens; run.usage.reportedCostUsd = (run.usage.reportedCostUsd || 0) + (o.cost || 0); this.changed(); } } // record() adds the run's totals to the agent counters at close; adding them here too would double-count
      return;
    }
    if (ev.type === 'assistant' && ev.message?.content) {
      // Stream-json can repeat the same message id across deltas; only the first sighting is a new turn.
      const ctx = U.contextFromAssistant(ev);
      if (ctx && ctx.messageId !== a.lastContextMessageId) {
        a.lastContextMessageId = ctx.messageId;
        a.contextWindow = U.contextWindowFor(ctx.model || a.model);
        a.contextTokens = ctx.contextTokens;
        a.contextPct = a.contextWindow ? ctx.contextTokens / a.contextWindow : null;
        this.changed();
      }
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text.trim()) this.log(node.id, 'text', c.text);
        else if (c.type === 'tool_use') this.log(node.id, 'tool', `${c.name} ${JSON.stringify(c.input).slice(0, 300)}`);
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
        const txt = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : String(c.content ?? '');
        this.log(node.id, c.is_error ? 'tool_error' : 'tool_result', txt.slice(0, 400));
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
      const rl = U.parseRateLimits(ev);
      if (rl) {
        (this.subscriptionRateLimits ||= {})[node.id] = rl; this.checkUsageLimits(node.id); this.changed();
        try { this.store.updateNode(node.id, { rateLimits: rl, rateLimitsAt: new Date().toISOString() }); } catch {}
      }
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      const mcpStatus = (ev.mcp_servers || []).map((s) => `${s.name}:${s.status}`).join(',');
      if (run && ev.session_id) run.sessionId = ev.session_id;
      if (run && run.usage) U.applyEvent(run.usage, ev);
      const rl = U.parseRateLimits(ev);
      if (rl) {
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
module.exports = { Orchestrator, buildPrompt, humanPrompt };
