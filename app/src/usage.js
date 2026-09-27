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

const CSV_COLS = ['startedAt', 'endedAt', 'durationMs', 'projectId', 'kind', 'agent', 'nodeId', 'task', 'taskId', 'model', 'models', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'numTurns', 'billingMode', 'billingSource', 'billingDetail', 'apiKeySource', 'reportedCostUsd', 'costNote', 'exitCode', 'sessionId'];
const csvCell = (v) => { const s = Array.isArray(v) ? v.join(' ') : String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCSV(runs) {
  const rows = runs.map((r) => CSV_COLS.map((c) => csvCell(c === 'totalTokens' ? totalTokens(r) : c === 'costNote' ? costNote(r.billingSource) : r[c])).join(','));
  return [CSV_COLS.join(','), ...rows].join('\n') + '\n';
}

module.exports = { resultSnapshot, tokensForRun, BILLING_MODES, BILLING_SOURCES, normalizeBilling, applyBillingEnv, detectBilling, costNote, tokensFromResult, totalTokens, newRun, applyEvent, finishRun, summarize, total, toCSV, CSV_COLS };
