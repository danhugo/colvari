// Usage & billing accounting: exact token counts from claude stream-json, the model actually used,
// and where the run was billed (subscription / API key / proxy / Bedrock / Vertex).
// Pure functions shared by the orchestrator, store, main process and tests.

const BILLING_MODES = ['auto', 'subscription', 'api', 'proxy'];
const BILLING_SOURCES = ['subscription', 'api', 'proxy', 'bedrock', 'vertex', 'unknown'];
const truthy = (v) => v != null && v !== '' && !/^(0|false|no|off)$/i.test(String(v));

function normalizeBilling(n = {}) {
  const billingMode = BILLING_MODES.includes(n.billingMode) ? n.billingMode : 'auto';
  const billingBaseUrl = String(n.billingBaseUrl || '').trim();
  if (billingMode === 'proxy' && billingBaseUrl && !/^https?:\/\/\S+$/i.test(billingBaseUrl)) throw new Error('proxy base URL must start with http:// or https://');
  return { billingMode, billingBaseUrl };
}

// Adjust the child env so the run really uses the chosen billing mode. Returns { env, warnings }.
function applyBillingEnv(cfg, env) {
  const { billingMode, billingBaseUrl } = normalizeBilling(cfg);
  const e = { ...env }; const warnings = [];
  if (billingMode === 'subscription') {
    // Force the claude.ai (Pro/Max) login: drop anything that would route the run to per-token billing.
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete e[k];
  } else if (billingMode === 'api') {
    delete e.ANTHROPIC_BASE_URL; delete e.CLAUDE_CODE_USE_BEDROCK; delete e.CLAUDE_CODE_USE_VERTEX;
    if (!e.ANTHROPIC_API_KEY) warnings.push('billing mode "api" but ANTHROPIC_API_KEY is not set (add it in the agent env vars)');
  } else if (billingMode === 'proxy') {
    if (billingBaseUrl) e.ANTHROPIC_BASE_URL = billingBaseUrl;
    if (!e.ANTHROPIC_BASE_URL) warnings.push('billing mode "proxy" but no base URL is set');
  }
  return { env: e, warnings };
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
// Where a run was billed, from the env it ran with and the init event's apiKeySource.
function detectBilling(env = {}, apiKeySource) {
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) return { source: 'bedrock', detail: 'AWS Bedrock' };
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) return { source: 'vertex', detail: 'Google Vertex AI' };
  if (env.ANTHROPIC_BASE_URL) return { source: 'proxy', detail: hostOf(env.ANTHROPIC_BASE_URL) + (apiKeySource && apiKeySource !== 'none' ? ` (${apiKeySource})` : '') };
  if (apiKeySource === 'none') return { source: 'subscription', detail: 'claude.ai login (Pro/Max)' };
  if (apiKeySource) return { source: 'api', detail: String(apiKeySource) };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return { source: 'api', detail: env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN' };
  return { source: 'unknown', detail: 'no init event' };
}

// How to present total_cost_usd for a billing source.
function costNote(source) {
  if (source === 'subscription') return 'Covered by subscription — not billed per token';
  return 'API-equivalent (reported by Claude CLI)';
}

const emptyTokens = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
// Tokens + models from a result event. modelUsage (per model, includes sub-agents) wins over usage.
function tokensFromResult(ev = {}) {
  const t = emptyTokens(); const models = [];
  const mu = ev.modelUsage && typeof ev.modelUsage === 'object' ? ev.modelUsage : null;
  if (mu && Object.keys(mu).length) {
    for (const [m, u] of Object.entries(mu)) {
      models.push(m);
      t.inputTokens += +u.inputTokens || 0; t.outputTokens += +u.outputTokens || 0;
      t.cacheReadTokens += +u.cacheReadInputTokens || 0; t.cacheCreationTokens += +u.cacheCreationInputTokens || 0;
    }
  } else {
    const u = ev.usage || {};
    t.inputTokens = +u.input_tokens || 0; t.outputTokens = +u.output_tokens || 0;
    t.cacheReadTokens = +u.cache_read_input_tokens || 0; t.cacheCreationTokens = +u.cache_creation_input_tokens || 0;
  }
  return { ...t, models };
}
const totalTokens = (r) => (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);

// Mutable per-run record, filled from stream events.
function newRun(fields = {}) {
  return { id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: 'agent', startedAt: new Date().toISOString(), endedAt: null, durationMs: 0,
    projectId: null, nodeId: null, agent: '', taskId: null, task: '', model: '', models: [], apiKeySource: null, billingMode: 'auto', billingSource: 'unknown', billingDetail: '',
    ...emptyTokens(), numTurns: 0, reportedCostUsd: 0, exitCode: null, isError: false, sessionId: null, ...fields };
}
// Raw cumulative-capable snapshot of a result event: per-model tokens (from modelUsage) + total_cost_usd.
function resultSnapshot(ev = {}) {
  const mu = ev.modelUsage && typeof ev.modelUsage === 'object' ? ev.modelUsage : null;
  const perModel = {};
  if (mu) for (const [m, u] of Object.entries(mu)) perModel[m] = { inputTokens: +u.inputTokens || 0, outputTokens: +u.outputTokens || 0, cacheReadTokens: +u.cacheReadInputTokens || 0, cacheCreationTokens: +u.cacheCreationInputTokens || 0 };
  return { perModel, costUsd: Number(ev.total_cost_usd) || 0 };
}
const TOK = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
// On `claude -p --resume`, result.modelUsage and total_cost_usd are cumulative for the whole session,
// while result.usage covers only this call. Given the previous cumulative snapshot of the resumed session
// (baseline), return this run's own share. Without a baseline, fall back to per-call usage (cost unknown -> 0,
// flagged). If the numbers are not cumulative after all (any field shrinks), the raw values are used.
function tokensForRun(ev, { resumed = false, baseline = null } = {}) {
  const raw = tokensFromResult(ev); const snap = resultSnapshot(ev);
  if (!resumed) return { tokens: raw, costUsd: snap.costUsd, snapshot: snap, basis: 'raw' };
  if (baseline && baseline.perModel) {
    const d = emptyTokens(); let ok = snap.costUsd >= (baseline.costUsd || 0) - 1e-9;
    for (const [m, u] of Object.entries(snap.perModel)) { const b = baseline.perModel[m] || emptyTokens(); for (const k of TOK) { const v = u[k] - (b[k] || 0); if (v < 0) ok = false; d[k] += v; } }
    for (const m of Object.keys(baseline.perModel)) if (!snap.perModel[m]) ok = false;
    if (ok && Object.keys(snap.perModel).length) return { tokens: { ...d, models: raw.models }, costUsd: Math.max(0, snap.costUsd - (baseline.costUsd || 0)), snapshot: snap, basis: 'delta' };
    if (!ok) return { tokens: raw, costUsd: snap.costUsd, snapshot: snap, basis: 'raw' };
  }
  const u = ev.usage || {};
  return { tokens: { inputTokens: +u.input_tokens || 0, outputTokens: +u.output_tokens || 0, cacheReadTokens: +u.cache_read_input_tokens || 0, cacheCreationTokens: +u.cache_creation_input_tokens || 0, models: raw.models }, costUsd: 0, snapshot: snap, basis: 'usage-no-baseline' };
}
// Apply one parsed stream-json (or --output-format json) event to a run record.
// run.resumedFrom / run.baseline (set by the orchestrator for --resume runs) make accounting per-run, not cumulative.
function applyEvent(run, ev) {
  if (!ev || typeof ev !== 'object') return run;
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.model) run.model = ev.model;
    if (ev.apiKeySource !== undefined) run.apiKeySource = ev.apiKeySource;
    if (ev.session_id) run.sessionId = ev.session_id;
  } else if (ev.type === 'result') {
    const r = tokensForRun(ev, { resumed: !!run.resumedFrom, baseline: run.baseline });
    const t = r.tokens;
    run.inputTokens += t.inputTokens; run.outputTokens += t.outputTokens; run.cacheReadTokens += t.cacheReadTokens; run.cacheCreationTokens += t.cacheCreationTokens;
    for (const m of t.models) if (!run.models.includes(m)) run.models.push(m);
    if (!run.model && t.models.length) run.model = t.models[0];
    run.numTurns += +ev.num_turns || 0; run.reportedCostUsd += r.costUsd;
    run.cumulative = r.snapshot; run.usageBasis = r.basis;
    if (ev.duration_ms && !run.cliDurationMs) run.cliDurationMs = +ev.duration_ms;
    run.isError = run.isError || !!ev.is_error;
    if (ev.session_id) run.sessionId = ev.session_id;
  }
  return run;
}
function finishRun(run, { code, env, billingMode, startedMs } = {}) {
  run.exitCode = code ?? null; run.endedAt = new Date().toISOString();
  if (startedMs) run.durationMs = Date.now() - startedMs;
  if (billingMode) run.billingMode = billingMode;
  const b = detectBilling(env || {}, run.apiKeySource);
  run.billingSource = b.source; run.billingDetail = b.detail;
  run.billingMismatch = !['auto', undefined].includes(run.billingMode) && b.source !== 'unknown' && b.source !== run.billingMode;
  return run;
}

// Group runs by a key ('nodeId' | 'taskId' | 'model' | 'billingSource' | 'projectId' | fn).
function summarize(runs, key) {
  const out = {};
  for (const r of runs) {
    const k = typeof key === 'function' ? key(r) : (r[key] || '');
    const s = (out[k] ||= { key: k, runs: 0, ...emptyTokens(), totalTokens: 0, numTurns: 0, durationMs: 0, reportedCostUsd: 0, subscriptionCostUsd: 0, billedCostUsd: 0 });
    s.runs++; for (const f of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'numTurns', 'durationMs', 'reportedCostUsd']) s[f] += r[f] || 0;
    s.totalTokens += totalTokens(r);
    if (r.billingSource === 'subscription') s.subscriptionCostUsd += r.reportedCostUsd || 0; else s.billedCostUsd += r.reportedCostUsd || 0;
  }
  return out;
}
const total = (runs) => summarize(runs, () => 'all').all || { key: 'all', runs: 0, ...emptyTokens(), totalTokens: 0, numTurns: 0, durationMs: 0, reportedCostUsd: 0, subscriptionCostUsd: 0, billedCostUsd: 0 };

// Per-model aggregate for snapshot.modelStats, shared by orchestrator/store and any consumer (UI, exports).
// Shape (one entry per model name seen in run.model / run.models):
//   { runs: number,            // agent runs (kind:'agent'; preflight/check runs excluded) whose primary model is this one
//     costUsd: number,         // sum of run.reportedCostUsd for those runs
//     tokens: number,          // sum of totalTokens(run) for those runs (input+output+cache read+cache creation)
//     tasksDone: number,       // tasks that reached status 'done', attributed to the model of the task's last agent run
//     firstPassAccepted: number, // of tasksDone, how many had never been sent back for changes (task.reopenCount falsy)
//     reopened: number }       // count of "changes requested" events (task.reopenCount) attributed to that model
// A task's outcome is attributed to the model of the most recent agent run recorded against its taskId;
// tasks with no recorded run (e.g. never actually ran an agent) are skipped.
function modelStats(runs = [], tasks = []) {
  const out = {};
  const bucket = (m) => (out[m] ||= { runs: 0, costUsd: 0, tokens: 0, tasksDone: 0, firstPassAccepted: 0, reopened: 0 });
  const primaryModel = (r) => r.model || (r.models && r.models[0]) || 'unknown';
  for (const r of runs) {
    if (r.kind !== 'agent') continue;
    const b = bucket(primaryModel(r));
    b.runs++; b.costUsd += r.reportedCostUsd || 0; b.tokens += totalTokens(r);
  }
  const lastModelForTask = {};
  for (const r of runs) if (r.kind === 'agent' && r.taskId) lastModelForTask[r.taskId] = primaryModel(r);
  for (const t of tasks) {
    const m = lastModelForTask[t.id]; if (!m) continue;
    if (t.status === 'done') { const b = bucket(m); b.tasksDone++; if (!t.reopenCount) b.firstPassAccepted++; }
    if (t.reopenCount) bucket(m).reopened += t.reopenCount;
  }
  return out;
}

const CSV_COLS = ['startedAt', 'endedAt', 'durationMs', 'projectId', 'kind', 'agent', 'nodeId', 'task', 'taskId', 'model', 'models', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'numTurns', 'billingMode', 'billingSource', 'billingDetail', 'apiKeySource', 'reportedCostUsd', 'costNote', 'exitCode', 'sessionId'];
const csvCell = (v) => { const s = Array.isArray(v) ? v.join(' ') : String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCSV(runs) {
  const rows = runs.map((r) => CSV_COLS.map((c) => csvCell(c === 'totalTokens' ? totalTokens(r) : c === 'costNote' ? costNote(r.billingSource) : r[c])).join(','));
  return [CSV_COLS.join(','), ...rows].join('\n') + '\n';
}

// Usage limits: subscription auth is rate-limited on rolling 5h / weekly windows (no cost, since it's covered by
// the plan); API-key auth is limited by tokens/cost instead. Limits are configurable per project; 0 means disabled.
const LIMITS_DEFAULTS = { fiveHourLimit: 0, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 };
function normalizeLimits(l = {}) {
  const num = (v, d = 0) => Math.max(0, Number(v) || d);
  const warnPct = Math.min(100, Math.max(1, Number(l.warnPct) || LIMITS_DEFAULTS.warnPct));
  return { fiveHourLimit: num(l.fiveHourLimit), weeklyLimit: num(l.weeklyLimit), tokenLimit: num(l.tokenLimit), costLimit: num(l.costLimit), warnPct };
}
// 'subscription' runs are rate-limited by request windows; anything else (api/proxy/bedrock/vertex/unknown) is
// billed, so it's limited by tokens/cost instead. No hard-coded runtime list: this only looks at how the run billed.
const authType = (billingSource) => (billingSource === 'subscription' ? 'subscription' : 'api');
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000, WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function windowUsage(runs, ms, now = Date.now()) {
  const cutoff = now - ms;
  return runs.filter((r) => r.kind === 'agent' && authType(r.billingSource) === 'subscription' && new Date(r.startedAt || 0).getTime() >= cutoff).length;
}
// Status against one limit: 0 disables it.
function limitStatus(used, limit, warnPct) {
  if (!limit) return { used, limit: 0, pct: 0, warn: false, pause: false };
  const pct = used / limit;
  return { used, limit, pct, warn: pct >= warnPct / 100, pause: pct >= 1 };
}
// Combined limits snapshot for a project's runs, split by auth type. Callers (orchestrator) use .warn/.pause
// to decide whether to surface a warning or pause dispatch; exposed to the renderer over IPC as-is.
function usageStatus(runs, limits, now = Date.now()) {
  const l = normalizeLimits(limits);
  const subRuns = runs.filter((r) => r.kind === 'agent' && authType(r.billingSource) === 'subscription');
  const apiRuns = runs.filter((r) => r.kind === 'agent' && authType(r.billingSource) === 'api');
  const fiveHour = limitStatus(windowUsage(runs, FIVE_HOURS_MS, now), l.fiveHourLimit, l.warnPct);
  const weekly = limitStatus(windowUsage(runs, WEEK_MS, now), l.weeklyLimit, l.warnPct);
  const tokens = limitStatus(apiRuns.reduce((a, r) => a + totalTokens(r), 0), l.tokenLimit, l.warnPct);
  const cost = limitStatus(apiRuns.reduce((a, r) => a + (r.reportedCostUsd || 0), 0), l.costLimit, l.warnPct);
  const hasSubscription = subRuns.length > 0, hasApi = apiRuns.length > 0;
  const authTypes = [...new Set([...(hasSubscription ? ['subscription'] : []), ...(hasApi ? ['api'] : [])])];
  const warn = fiveHour.warn || weekly.warn || tokens.warn || cost.warn;
  const pause = fiveHour.pause || weekly.pause || tokens.pause || cost.pause;
  return { authTypes, fiveHour, weekly, tokens, cost, warn, pause };
}

module.exports = { resultSnapshot, tokensForRun, BILLING_MODES, BILLING_SOURCES, normalizeBilling, applyBillingEnv, detectBilling, costNote, tokensFromResult, totalTokens, newRun, applyEvent, finishRun, summarize, total, modelStats, toCSV, CSV_COLS,
  LIMITS_DEFAULTS, normalizeLimits, authType, windowUsage, limitStatus, usageStatus };
