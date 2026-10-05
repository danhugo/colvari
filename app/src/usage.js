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

// ---- per-model usage ledger (t_3318ff63): usage is recorded under {runtime, provider, model}
// keys; aggregates never sum tokens across keys (only $ totals are offered, flagged partial when
// any contributing row has unknown cost). ----

// Canonical ledger model id: dated build suffixes ("claude-haiku-4-5-20251001") and context-window
// variants ("…[1m]") collapse into the base id; an org prefix ("zai/glm-5.2") moves into the
// returned providerHint (used as the provider on direct multi-vendor channels). The CLI's own
// canonicalModel (claude modelUsage) wins over this when present.
function canonModel(m) {
  let s = String(m || '').trim();
  if (!s) return { model: 'unknown', providerHint: null };
  s = s.replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');
  const i = s.lastIndexOf('/');
  if (i > 0 && i < s.length - 1) return { model: s.slice(i + 1), providerHint: s.slice(0, i) };
  return { model: s || 'unknown', providerHint: null };
}

// Classify a CLI result event's total_cost_usd without collapsing "absent" into $0 (t_6ee6a70b —
// the ONE helper all four call sites share: usage.js resultSnapshot, agent-modes parseJudge,
// orchestrator's result handler, preflight). Reported >0 is a real cost. Reported $0 splits by
// channel: behind a proxy base URL (LiteLLM or similar) the model was likely just unpriced there
// ('proxy-unpriced': try the proxy's own per-request cost before trusting the zero), while on a
// direct channel the provider really reported $0. Absent/unparseable is reported:false — a missing
// cost, not a zero. ctx: { billingSource, env, viaProxy } — any one proxy signal is enough.
function reportedCostOf(ev = {}, ctx = {}) {
  const raw = ev.total_cost_usd;
  if (raw == null || raw === '') return { costUsd: null, reported: false, proxyUnpriced: false };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { costUsd: null, reported: false, proxyUnpriced: false };
  if (n > 0) return { costUsd: n, reported: true, proxyUnpriced: false };
  const viaProxy = ctx.billingSource === 'proxy' || !!ctx.viaProxy || !!(ctx.env && ctx.env.ANTHROPIC_BASE_URL);
  return { costUsd: 0, reported: true, proxyUnpriced: viaProxy };
}

// Resolve one ledger entry's cost through the source priority (t_6ee6a70b): 1) the provider/CLI
// reported it (nonzero, or a direct-channel $0 — really reported, kept as 0); 2) the proxy's own
// measured per-request cost for this entry's model (proxyCostUsd, source 'proxy'); 3) the runtime
// price list (the LiteLLM price JSON cached on disk, with user overrides — see litellm.js PriceBook;
// source 'estimated', costPartial when a flowed token class has no price); 4) unknown. Unknown is
// honest: no $0, no guessed number. ctx: { proxyUnpriced, priceBook, proxyCostUsd }.
function resolveEntryCost(e, { proxyUnpriced = false, priceBook = null, proxyCostUsd = null } = {}) {
  if (e.costUsd != null && e.costUsd > 0) { e.costSource = 'reported'; return e; }
  if (e.costUsd === 0 && !proxyUnpriced) { e.costSource = 'reported'; return e; }
  const flow = (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheCreationTokens || 0) > 0;
  if (flow && proxyCostUsd != null) { e.costUsd = proxyCostUsd; e.costSource = 'proxy'; delete e.costPartial; return e; }
  if (flow && priceBook) {
    const est = priceBook.estimate(e.model, e);
    if (est.costUsd != null) { e.costUsd = est.costUsd; e.costSource = 'estimated'; if (est.partial) e.costPartial = true; else delete e.costPartial; return e; }
    if (est.partial) { e.costUsd = null; e.costSource = 'unknown'; e.costPartial = true; return e; }
  }
  e.costUsd = null; e.costSource = 'unknown'; return e;
}
// Ledger key provider — the ACCOUNT a run's cost belongs to (t_f514cc2e), not the CLI's label
// vocabulary. For subscription-billed runs every label means the same claude.ai login (modelUsage
// says "firstParty", the channel fallback says "subscription"), so both collapse to 'subscription':
// one account, one row. Otherwise: the CLI's own modelUsage label (claude API keys also report
// "firstParty" — kept distinct from the subscription account on purpose), else the proxy host
// (multi-vendor channels: the vendor is already prefixed in the model id), else the model id's org
// prefix, else the billing channel. Two distinct logins on the same channel (two API keys on
// "firstParty") can't be told apart from what CLIs report and share a row by design.
function providerOf({ muProvider, providerHint, billingSource, proxyHost }) {
  if (billingSource === 'subscription') return 'subscription';
  const CH = { api: 'api', proxy: 'proxy', bedrock: 'bedrock', vertex: 'vertex' };
  return muProvider || (billingSource === 'proxy' && proxyHost) || providerHint || CH[billingSource] || 'unknown';
}

// Runtime attribution for entries that predate the runtime stamp (from when claude was the only
// runtime). A claude-* model id proves the claude CLI; anything else stays an explicit 'unknown'
// (unattributed) row instead of being folded silently into a wrong account.
const accountRuntime = (runtime, model) => (runtime && runtime !== 'unknown') ? runtime
  : /^claude/i.test(String(model || '')) ? 'claude' : 'unknown';

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
    projectId: null, nodeId: null, agent: '', taskId: null, task: '', model: '', models: [], runtime: 'unknown', provider: '', apiKeySource: null, billingMode: 'auto', billingSource: 'unknown', billingDetail: '',
    ...emptyTokens(), ledger: [], numTurns: 0, reportedCostUsd: 0, costKnown: false, proxyUnpriced: false, exitCode: null, isError: false, sessionId: null, ...fields };
}
const TOK = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
// Raw cumulative-capable snapshot of a result event: per-model tokens (from modelUsage) + total_cost_usd.
// Each per-model entry keeps what the CLI itself reported: costUSD (null when absent), its provider label
// and canonicalModel, and `seen` — the token fields the CLI actually reported (unreported ones must stay
// unknown, i.e. null, in the ledger — never 0). The run-level cost keeps reportedCostOf's classification:
// costKnown (the CLI reported a total at all — absent ≠ $0) and proxyUnpriced (a $0 that came from behind
// a proxy base URL, i.e. the proxy had no price for the model).
function resultSnapshot(ev = {}) {
  const mu = ev.modelUsage && typeof ev.modelUsage === 'object' ? ev.modelUsage : null;
  const perModel = {};
  if (mu) for (const [m, u] of Object.entries(mu)) {
    const seen = TOK.filter((k) => u[{ inputTokens: 'inputTokens', outputTokens: 'outputTokens', cacheReadTokens: 'cacheReadInputTokens', cacheCreationTokens: 'cacheCreationInputTokens' }[k]] != null);
    perModel[m] = {
      inputTokens: +u.inputTokens || 0, outputTokens: +u.outputTokens || 0, cacheReadTokens: +u.cacheReadInputTokens || 0, cacheCreationTokens: +u.cacheCreationInputTokens || 0,
      costUsd: typeof u.costUSD === 'number' ? u.costUSD : null, provider: u.provider || null, canonicalModel: u.canonicalModel || null, seen,
    };
  }
  const rc = reportedCostOf(ev);
  return { perModel, costUsd: rc.costUsd ?? 0, costKnown: rc.reported, proxyUnpriced: rc.proxyUnpriced };
}
// Flat usage event -> one per-model entry (model id from the event or a fallback), with per-field
// `seen` so unreported cache fields stay unknown rather than zero.
function perModelFromUsage(u = {}, model) {
  const src = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens, cacheCreationTokens: u.cache_creation_input_tokens };
  return { [model || 'unknown']: {
    inputTokens: +u.input_tokens || 0, outputTokens: +u.output_tokens || 0, cacheReadTokens: +u.cache_read_input_tokens || 0, cacheCreationTokens: +u.cache_creation_input_tokens || 0,
    costUsd: null, provider: null, canonicalModel: null, seen: TOK.filter((k) => src[k] != null),
  } };
}
// On `claude -p --resume`, result.modelUsage and total_cost_usd are cumulative for the whole session,
// while result.usage covers only this call. Given the previous cumulative snapshot of the resumed session
// (baseline), return this run's own share. Without a baseline, fall back to per-call usage (cost unknown,
// flagged). If the numbers are not cumulative after all (any field shrinks), the raw values are used.
// Alongside the flat tokens, perModel carries the per-key split the ledger is built from: one entry per
// model with this run's own tokens, per-model cost delta (null when the baseline predates per-model costs),
// and the CLI's provider/canonicalModel labels. costKnown/proxyUnpriced describe the CURRENT event's
// reported cost (see resultSnapshot) — the proxy's per-request costs bypass this delta logic entirely.
function tokensForRun(ev, { resumed = false, baseline = null } = {}) {
  const raw = tokensFromResult(ev); const snap = resultSnapshot(ev);
  const rawPerModel = () => {
    const pm = {};
    for (const [m, e] of Object.entries(snap.perModel)) pm[m] = { ...e, seen: [...e.seen] };
    return pm;
  };
  const costFlags = { costKnown: snap.costKnown, proxyUnpriced: snap.proxyUnpriced };
  if (!resumed) return { tokens: raw, perModel: rawPerModel(), costUsd: snap.costUsd, snapshot: snap, basis: 'raw', ...costFlags };
  if (baseline && baseline.perModel) {
    const d = emptyTokens(); const pm = {}; let ok = snap.costUsd >= (baseline.costUsd || 0) - 1e-9;
    for (const [m, u] of Object.entries(snap.perModel)) {
      const b = baseline.perModel[m] || emptyTokens();
      const e = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, provider: u.provider, canonicalModel: u.canonicalModel, seen: [...u.seen] };
      for (const k of TOK) { const v = u[k] - (b[k] || 0); if (v < 0) ok = false; d[k] += v; e[k] = v; }
      e.costUsd = b.costUsd != null && u.costUsd != null ? Math.max(0, u.costUsd - b.costUsd) : null;
      pm[m] = e;
    }
    for (const m of Object.keys(baseline.perModel)) if (!snap.perModel[m]) ok = false;
    if (ok && Object.keys(snap.perModel).length) return { tokens: { ...d, models: raw.models }, perModel: pm, costUsd: Math.max(0, snap.costUsd - (baseline.costUsd || 0)), snapshot: snap, basis: 'delta', ...costFlags };
    if (!ok) return { tokens: raw, perModel: rawPerModel(), costUsd: snap.costUsd, snapshot: snap, basis: 'raw', ...costFlags };
  }
  const u = ev.usage || {};
  return { tokens: { inputTokens: +u.input_tokens || 0, outputTokens: +u.output_tokens || 0, cacheReadTokens: +u.cache_read_input_tokens || 0, cacheCreationTokens: +u.cache_creation_input_tokens || 0, models: raw.models }, perModel: perModelFromUsage(u, raw.models[0]), costUsd: 0, snapshot: snap, basis: 'usage-no-baseline', costKnown: false, proxyUnpriced: snap.proxyUnpriced };
}
// Merge one result's per-model split into the run's accumulator: token fields add up (unreported
// fields stay out of `seen`), costs add when both sides have values, labels take the latest report.
function mergePerModel(run, perModel) {
  if (!perModel) return;
  const dst = (run.perModel ||= {});
  for (const [m, e] of Object.entries(perModel)) {
    const cur = (dst[m] ||= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, provider: null, canonicalModel: null, seen: [] });
    for (const k of TOK) if (e[k] != null) { cur[k] += e[k]; if (!cur.seen.includes(k)) cur.seen.push(k); }
    if (e.costUsd != null) cur.costUsd = (cur.costUsd || 0) + e.costUsd;
    if (e.provider) cur.provider = e.provider;
    if (e.canonicalModel) cur.canonicalModel = e.canonicalModel;
  }
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
    mergePerModel(run, r.perModel);
    // which token fields this CLI reports on result.usage (flat, no modelUsage) — the ledger's flat
    // fallback needs it to keep unreported fields unknown instead of 0
    const u0 = ev.usage || {}; const fsn = (run.flatSeen ||= []);
    for (const [k, f] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['cache_read_input_tokens', 'cacheReadTokens'], ['cache_creation_input_tokens', 'cacheCreationTokens']])
      if (u0[k] != null && !fsn.includes(f)) fsn.push(f);
    for (const m of t.models) if (!run.models.includes(m)) run.models.push(m);
    if (!run.model && t.models.length) run.model = t.models[0];
    run.numTurns += +ev.num_turns || 0; run.reportedCostUsd += r.costUsd;
    if (r.costKnown) run.costKnown = true;
    if (r.proxyUnpriced) run.proxyUnpriced = true;
    run.cumulative = r.snapshot; run.usageBasis = r.basis;
    if (ev.duration_ms && !run.cliDurationMs) run.cliDurationMs = +ev.duration_ms;
    run.isError = run.isError || !!ev.is_error;
    if (ev.session_id) run.sessionId = ev.session_id;
  }
  return run;
}
// One run's ledger entries, from its accumulated per-model split (claude: real per-model tokens/cost
// from modelUsage) or — for runtimes without per-model reporting (codex, profile CLIs) — a single
// entry from the flat totals. costUsd starts as the raw reported value; resolveEntryCost decides the
// source (reported / proxy / estimated / unknown) with the run's ctx. Entries with no tokens at all
// are dropped. Each entry also carries `billed` — the part of its cost actually billed per token:
// $0 for subscription runs (covered by the plan; the $0 is known, not missing), else the same value
// as costUsd, null when that is unknown.
function buildLedger(run, { proxyHost = null, priceBook = null, proxySpend = null, proxyUnpriced = false } = {}) {
  const primary = canonModel(run.model || (run.models && run.models[0]) || '');
  const flat = () => {
    const seen = run.flatSeen && run.flatSeen.length ? run.flatSeen : ['inputTokens', 'outputTokens'];
    return { [primary.model]: { inputTokens: run.inputTokens || 0, outputTokens: run.outputTokens || 0, cacheReadTokens: run.cacheReadTokens || 0, cacheCreationTokens: run.cacheCreationTokens || 0, costUsd: null, provider: null, canonicalModel: null, seen } };
  };
  const pm = run.perModel && Object.keys(run.perModel).length ? run.perModel : flat();
  const entries = [];
  for (const [rawModel, e] of Object.entries(pm)) {
    const seen = e.seen;
    const tokens = { inputTokens: e.inputTokens || 0, outputTokens: e.outputTokens || 0,
      cacheReadTokens: seen.includes('cacheReadTokens') ? e.cacheReadTokens || 0 : null,
      cacheCreationTokens: seen.includes('cacheCreationTokens') ? e.cacheCreationTokens || 0 : null };
    if (!(tokens.inputTokens + tokens.outputTokens + (tokens.cacheReadTokens || 0) + (tokens.cacheCreationTokens || 0))) continue;
    const c = canonModel(e.canonicalModel || rawModel);
    const hint = c.providerHint || (rawModel === primary.model ? primary.providerHint : null);
    entries.push({ runtime: accountRuntime(run.runtime, c.model), provider: providerOf({ muProvider: e.provider, providerHint: hint, billingSource: run.billingSource, proxyHost }), model: c.model, ...tokens, costUsd: e.costUsd });
  }
  // Whole-run cost with no per-model split (resumed-run fallbacks, CLIs without modelUsage cost):
  // attribute it to the primary model's entry rather than losing or splitting it. Only KNOWN
  // reported totals attach — >0, or a direct-channel $0; an absent cost and a proxy's "model not
  // priced" $0 must not masquerade as a reported zero.
  const main = entries.find((e) => e.model === primary.model) || entries[0];
  const attachRunCost = run.reportedCostUsd > 0 || (run.costKnown && !proxyUnpriced);
  if (main && main.costUsd == null && attachRunCost) { main.costUsd = run.reportedCostUsd; }
  // The proxy's own per-request cost (joined + deduped from its spend logs), per model. Raw model
  // keys canonicalize so "zai/glm-5.2-20260101" style ids match the entry's canonical model.
  let sbm = null; let spendTotal = null;
  if (proxySpend && typeof proxySpend === 'object') {
    for (const [m, v] of Object.entries(proxySpend.byModel || {})) if (typeof v === 'number' && Number.isFinite(v)) { const c = canonModel(m).model; (sbm ||= {})[c] = (sbm[c] || 0) + v; }
    if (typeof proxySpend.total === 'number' && Number.isFinite(proxySpend.total)) spendTotal = proxySpend.total;
  }
  const spendOf = (e, isMain) => (sbm ? (sbm[e.model] ?? null) : (isMain ? spendTotal : null));
  for (const e of entries) { resolveEntryCost(e, { proxyUnpriced, priceBook, proxyCostUsd: spendOf(e, e === main) }); e.billed = run.billingSource === 'subscription' ? 0 : (e.costUsd != null ? e.costUsd : null); }
  return entries;
}
function finishRun(run, { code, env, billingMode, startedMs, priceBook = null, proxySpend = null } = {}) {
  run.exitCode = code ?? null; run.endedAt = new Date().toISOString();
  if (startedMs) run.durationMs = Date.now() - startedMs;
  if (billingMode) run.billingMode = billingMode;
  const b = detectBilling(env || {}, run.apiKeySource);
  run.billingSource = b.source; run.billingDetail = b.detail;
  run.billingMismatch = !['auto', undefined].includes(run.billingMode) && b.source !== 'unknown' && b.source !== run.billingMode;
  // A reported $0 only means "proxy had no price for this model" when the run really billed through one.
  // run.proxyUnpriced covers the paths that saw the event ctx (parseJudge/preflight); when only applyEvent
  // ran (no env there), a known total of exactly 0 over a proxy billing source is the same case.
  const proxyUnpriced = (!!run.proxyUnpriced || (run.costKnown && !(run.reportedCostUsd > 0))) && b.source === 'proxy';
  run.proxyUnpriced = proxyUnpriced;
  run.ledger = buildLedger(run, { proxyHost: env && env.ANTHROPIC_BASE_URL ? hostOf(env.ANTHROPIC_BASE_URL) : null, priceBook, proxySpend, proxyUnpriced });
  if (run.ledger.length) run.provider = run.ledger[0].provider;
  delete run.perModel; delete run.flatSeen; // internal accumulators; the ledger is the persisted split
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

// Usage ledger aggregate over persisted runs (t_3318ff63). One row per account
// {runtime, provider, model} key — provider is the paying account (see providerOf), and legacy
// runtime-less entries attribute to claude when their model id is claude-* (see accountRuntime) —
// plus the same per-key rows grouped per agent (run.agent name) and per task (run.taskId).
// Rows carry the four token types SEPARATELY — never a token total: cache fields stay null when no
// contributing run reported them (unknown ≠ 0). Cost is defined once (t_f514cc2e): per row `apiEq`
// is the API-equivalent $ (reported by the CLI or list-price estimated), null when unknown;
// `billed` is the part actually billed per token — $0 for subscription rows (covered by the plan),
// else the same value as apiEq. Totals are the raw (unrounded) sums of the per-row fields — never
// recomputed from rounded rows; `costUsd` is kept as the original name for apiEq.
// Shape:
//   rows: [{ runtime, provider, model, runs, inputTokens, outputTokens, cacheReadTokens,
//            cacheCreationTokens, costUsd, apiEq, billed,
//            costSource: 'reported'|'estimated'|'mixed'|'unknown', costPartial }]
//   byAgent: { [agent]: rows }   byTask: { [taskId]: { task, rows } }
//   costUsd, apiEq, billed, costPartial — $ totals across all keys (apiEq === costUsd)
// Instrumented (t_d0f0c9f3): usageLedger.stats accumulates the aggregate's own per-call cost —
// calls, runs scanned, ledger entries processed, runs served by the synthesized flat fallback
// (pre-ledger stragglers) and lastMs — complementing the orchestrator's memo-side counters
// (_ledgerRebuilds/_ledgerHits), which only see when the aggregate runs, not what it cost inside.
function usageLedger(runs = [], { priceBook = null } = {}) {
  const t0 = Date.now();
  const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
  const newRow = (e) => ({ runtime: e.runtime, provider: e.provider, model: e.model, runs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheCreationTokens: null,
    costUsd: null, billed: 0, reported: 0, estimated: 0, unknown: 0, billedUnknown: 0 });
  const add = (map, gk, e, sub) => {
    let row = map.get(gk);
    if (!row) { row = { ...newRow(e), key: gk }; map.set(gk, row); }
    row.runs++;
    for (const k of TOKEN_FIELDS) if (e[k] != null) row[k] = (row[k] || 0) + e[k];
    if (e.costUsd != null) { row.costUsd = (row.costUsd || 0) + e.costUsd; row[e.costSource === 'estimated' ? 'estimated' : 'reported']++; }
    else row.unknown++;
    if (!sub) { if (e.costUsd != null) row.billed += e.costUsd; else row.billedUnknown++; }
    // subscription runs contribute a KNOWN $0 (covered by the plan), never an unknown
  };
  const finish = (map) => [...map.values()].map(({ reported, estimated, unknown, billedUnknown, ...row }) => ({
    ...row,
    apiEq: row.costUsd,
    billed: billedUnknown > 0 && row.billed === 0 ? null : row.billed, // all non-sub contributions unpriced -> unknown, not $0
    costSource: reported && estimated ? 'mixed' : estimated ? 'estimated' : reported ? 'reported' : 'unknown',
    costPartial: unknown > 0 && row.costUsd != null,
  })).sort((a, b) => (a.runtime + a.provider + a.model).localeCompare(b.runtime + b.provider + b.model));
  const top = new Map(), byAgent = new Map(), byTask = new Map();
  let nEntries = 0, nSynth = 0;
  for (const r of runs) {
    const sub = r.billingSource === 'subscription';
    const persisted = Array.isArray(r.ledger) && r.ledger.length;
    for (const e0 of ledgerEntriesOf(r, { priceBook })) {
      nEntries++;
      if (!persisted) nSynth++;
      // canonicalize the account key at the aggregate layer too, so entries persisted before the
      // normalization fixes (dated suffixes, org prefixes, runtime-less rows, firstParty-vs-
      // subscription labels) still collapse into one row
      const model = canonModel(e0.model).model;
      const e = { ...e0, model, runtime: accountRuntime(e0.runtime, model), provider: providerOf({ muProvider: e0.provider, billingSource: r.billingSource }) };
      const gk = `${e.runtime}¦${e.provider}¦${model}`;
      add(top, gk, e, sub);
      add(byAgent, `${r.agent || r.nodeId || 'unknown'}¦${gk}`, e, sub);
      if (r.taskId) add(byTask, `${r.taskId}¦${gk}`, e, sub);
    }
  }
  const nest = (map) => {
    const o = {};
    for (const row of finish(map)) { const i = row.key.indexOf('¦'); const g = row.key.slice(0, i); const inner = { ...row, key: row.key.slice(i + 1) }; (o[g] ||= []).push(inner); }
    return o;
  };
  const rows = finish(top);
  const costUsd = rows.reduce((a, r) => a + (r.costUsd || 0), 0);
  const billed = rows.reduce((a, r) => a + (r.billed || 0), 0);
  const costPartial = rows.some((r) => r.costSource === 'unknown' || r.costPartial);
  const st = usageLedger.stats ||= { calls: 0, runs: 0, entries: 0, synthesized: 0, lastMs: 0 };
  st.calls++; st.runs += runs.length; st.entries += nEntries; st.synthesized += nSynth; st.lastMs = Date.now() - t0;
  return { rows, byAgent: nest(byAgent), byTask: nest(byTask), costUsd, apiEq: costUsd, billed, costPartial };
}
// One run's ledger entries: the persisted split, or — for pre-ledger stragglers that escaped the
// migration — a synthesized single entry from the flat totals (never crashes, never mis-splits).
// Persisted entries keep their stored costUsd/costSource as-is: rows the old hard-coded table once
// marked 'estimated' stay 'estimated' (their price basis was declared at the time; no recompute).
// Only the synthesized path resolves afresh, with the injected priceBook when the caller has one.
function ledgerEntriesOf(r, { priceBook = null } = {}) {
  if (Array.isArray(r.ledger) && r.ledger.length) return r.ledger;
  if (!r || !(r.inputTokens || r.outputTokens || r.cacheReadTokens || r.cacheCreationTokens)) return [];
  const c = canonModel(r.model || (r.models && r.models[0]) || '');
  const e = resolveEntryCost({ runtime: accountRuntime(r.runtime, c.model), provider: providerOf({ providerHint: c.providerHint, billingSource: r.billingSource, proxyHost: null }), model: c.model,
    inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0, cacheReadTokens: r.cacheReadTokens || 0, cacheCreationTokens: r.cacheCreationTokens || 0, costUsd: r.reportedCostUsd > 0 ? r.reportedCostUsd : null }, { priceBook });
  e.billed = r.billingSource === 'subscription' ? 0 : (e.costUsd != null ? e.costUsd : null);
  return [e];
}

// Late-arriving proxy cost (t_6ee6a70b): LiteLLM spend logs are written after the run, so the real
// per-request cost lands on a persisted run record after finishRun. Re-resolve the entries the join
// covers: the proxy's measured number replaces price-list estimates and fills unknowns; provider-
// reported costs stay. Entries whose model got no proxy spend keep their prior state. Never runs
// proxy numbers through the resume-delta logic (they are already per-run, joined + deduped).
// Returns the total $ newly applied (callers feed it to live counters), 0 when nothing changed.
function applyProxySpend(rec, proxySpend) {
  if (!rec || !proxySpend || typeof proxySpend !== 'object' || !Array.isArray(rec.ledger) || rec.proxySpend) return 0;
  let sbm = null; let spendTotal = null;
  for (const [m, v] of Object.entries(proxySpend.byModel || {})) if (typeof v === 'number' && Number.isFinite(v)) { const c = canonModel(m).model; (sbm ||= {})[c] = (sbm[c] || 0) + v; }
  if (typeof proxySpend.total === 'number' && Number.isFinite(proxySpend.total)) spendTotal = proxySpend.total;
  if (!sbm && spendTotal == null) return 0;
  const pm = canonModel(rec.model || (rec.models && rec.models[0]) || '').model;
  const mainE = rec.ledger.find((e) => e.model === pm) || rec.ledger[0];
  let applied = 0;
  for (const e of rec.ledger) {
    const pc = sbm ? (sbm[e.model] ?? null) : (e === mainE ? spendTotal : null);
    if (pc == null) continue;
    if (e.costUsd != null && e.costUsd > 0 && e.costSource === 'reported') continue;
    applied += pc;
    e.costUsd = pc; e.costSource = 'proxy'; delete e.costPartial;
    e.billed = rec.billingSource === 'subscription' ? 0 : pc;
  }
  if (applied > 0) rec.proxySpend = proxySpend; // applied marker: a second join must not double-count
  return applied;
}

const CSV_COLS = ['startedAt', 'endedAt', 'durationMs', 'projectId', 'kind', 'agent', 'nodeId', 'task', 'taskId', 'model', 'models', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'numTurns', 'billingMode', 'billingSource', 'billingDetail', 'apiKeySource', 'reportedCostUsd', 'costNote', 'exitCode', 'sessionId'];
const csvCell = (v) => { const s = Array.isArray(v) ? v.join(' ') : String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCSV(runs) {
  const rows = runs.map((r) => CSV_COLS.map((c) => csvCell(c === 'totalTokens' ? totalTokens(r) : c === 'costNote' ? costNote(r.billingSource) : r[c])).join(','));
  return [CSV_COLS.join(','), ...rows].join('\n') + '\n';
}

// Usage limits: subscription auth is rate-limited on rolling 5h / weekly windows (no cost, since it's covered by
// the plan); API-key auth is limited by tokens/cost instead. Limits are configurable per project; 0 means disabled.
const GUARD_DEFAULT_PCT = 90;
const LIMITS_DEFAULTS = { fiveHourLimit: 0, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80, guardThresholdPct: GUARD_DEFAULT_PCT };
function normalizeLimits(l = {}) {
  const num = (v, d = 0) => Math.max(0, Number(v) || d);
  const warnPct = Math.min(100, Math.max(1, Number(l.warnPct) || LIMITS_DEFAULTS.warnPct));
  const guardThresholdPct = Math.min(100, Math.max(1, Number(l.guardThresholdPct) || LIMITS_DEFAULTS.guardThresholdPct));
  return { fiveHourLimit: num(l.fiveHourLimit), weeklyLimit: num(l.weeklyLimit), tokenLimit: num(l.tokenLimit), costLimit: num(l.costLimit), warnPct, guardThresholdPct };
}
// 'subscription' runs are rate-limited by request windows; anything else (api/proxy/bedrock/vertex/unknown) is
// billed, so it's limited by tokens/cost instead. No hard-coded runtime list: this only looks at how the run billed.
const authType = (billingSource) => (billingSource === 'subscription' ? 'subscription' : 'api');
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000, WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function windowUsage(runs, ms, now = Date.now()) {
  const cutoff = now - ms;
  const inWindow = runs.filter((r) => r.kind === 'agent' && authType(r.billingSource) === 'subscription' && new Date(r.startedAt || 0).getTime() >= cutoff);
  // Rolling window: it "resets" ms after the oldest run still counted drops out of the window.
  const oldest = inWindow.reduce((min, r) => Math.min(min, new Date(r.startedAt || 0).getTime()), Infinity);
  const resetsAt = Number.isFinite(oldest) ? new Date(oldest + ms).toISOString() : null;
  return { used: inWindow.length, resetsAt };
}
// Status against one limit: 0 disables it.
function limitStatus({ used, resetsAt }, limit, warnPct) {
  if (!limit) return { used, limit: 0, pct: 0, warn: false, pause: false, resetsAt: null };
  const pct = used / limit;
  return { used, limit, pct, warn: pct >= warnPct / 100, pause: pct >= 1, resetsAt: used > 0 ? resetsAt : null };
}
// Combined limits snapshot for a project's runs, split by auth type. Callers (orchestrator) use .warn/.pause
// to decide whether to surface a warning or pause dispatch; exposed to the renderer over IPC as-is.
function usageStatus(runs, limits, now = Date.now()) {
  const l = normalizeLimits(limits);
  const subRuns = runs.filter((r) => r.kind === 'agent' && authType(r.billingSource) === 'subscription');
  const apiRuns = runs.filter((r) => r.kind === 'agent' && authType(r.billingSource) === 'api');
  const fiveHour = limitStatus(windowUsage(runs, FIVE_HOURS_MS, now), l.fiveHourLimit, l.warnPct);
  const weekly = limitStatus(windowUsage(runs, WEEK_MS, now), l.weeklyLimit, l.warnPct);
  const tokens = limitStatus({ used: apiRuns.reduce((a, r) => a + totalTokens(r), 0), resetsAt: null }, l.tokenLimit, l.warnPct);
  const cost = limitStatus({ used: apiRuns.reduce((a, r) => a + (r.reportedCostUsd || 0), 0), resetsAt: null }, l.costLimit, l.warnPct);
  const hasSubscription = subRuns.length > 0, hasApi = apiRuns.length > 0;
  const authTypes = [...new Set([...(hasSubscription ? ['subscription'] : []), ...(hasApi ? ['api'] : [])])];
  const warn = fiveHour.warn || weekly.warn || tokens.warn || cost.warn;
  const pause = fiveHour.pause || weekly.pause || tokens.pause || cost.pause;
  return { authTypes, fiveHour, weekly, tokens, cost, warn, pause };
}

// A stored reading (in-memory map or persisted node.rateLimits) whose resetsAt has since passed describes a
// window that already reset — its pct must not count (e.g. the >=90% reading that outlived its own reset and
// paused dispatch even though the real usage was ~3%). Keeps still-live windows, drops stale ones; null when
// nothing is left.
function liveRateLimits(rl) {
  if (!rl) return null;
  const isLive = (w) => !!(w && !(w.resetsAt && new Date(w.resetsAt).getTime() <= Date.now()));
  const fiveHour = isLive(rl.fiveHour) ? rl.fiveHour : null;
  const weekly = isLive(rl.weekly) ? rl.weekly : null;
  return (fiveHour || weekly) ? { fiveHour, weekly, ...(rl.runtime ? { runtime: rl.runtime } : {}) } : null;
}

// A node's effective runtime id — the same default the whole app uses (getRuntime: falsy -> claude;
// the orchestrator stamps runs `cfg.runtime || 'claude'`). A node JSON that predates the runtime
// field (or was created without one) drives the claude CLI everywhere else, so the usage model must
// not present it as a separate "unknown" provider.
const effectiveRuntime = (n) => (n && n.runtime) || 'claude';
// The live rate-limit reading for ONE node: liveRateLimits freshness plus a runtime match. Readings
// are stamped with the runtime whose CLI reported them (claude-dialect init/rate_limit_event paths
// only); a node repointed to another runtime (claude -> helpycode, say) must not keep advertising the
// old CLI's subscription windows as the new provider's quota. Unstamped readings predate the stamp,
// and back then the only writers were the claude-dialect paths — so they count for claude nodes and
// are ignored for everyone else (that CLI re-reports on a later run, or the provider honestly stays
// "limits unknown"). map is the orchestrator's in-memory per-node readings; node.rateLimits is the
// persisted fallback.
function nodeLiveRateLimits(node, map = {}) {
  const rl = liveRateLimits((map || {})[node.id] || (node && node.rateLimits));
  if (!rl) return null;
  return (rl.runtime || 'claude') === effectiveRuntime(node) ? rl : null;
}

// Fold each node's CLI-reported subscription rate-limit % (from rlAll — one parseRateLimits() result per node,
// live in-memory or the last persisted node.rateLimits snapshot) over the run-derived usageStatus. The CLI's own
// number is always the more trustworthy one when present: other clients sharing the same subscription window
// aren't reflected in this project's local run count, so it wins outright rather than only when higher.
// Stale readings (resetsAt already past) are ignored — the freshest still-live reading is what counts.
function applyCliRateLimits(status, rlAll, warnPct) {
  const live = (rlAll || []).map((rl) => liveRateLimits(rl)).filter(Boolean);
  const pick = (key) => {
    const cli = live.map((rl) => rl[key]).filter(Boolean).sort((a, b) => b.pct - a.pct)[0];
    const runBased = status[key];
    if (!cli) return runBased;
    return { used: runBased.used, limit: runBased.limit || 1, pct: cli.pct, warn: cli.pct * 100 >= warnPct, pause: cli.pct >= 1, resetsAt: cli.resetsAt };
  };
  const fiveHour = pick('fiveHour'), weekly = pick('weekly');
  return { ...status, fiveHour, weekly, warn: status.warn || fiveHour.warn || weekly.warn, pause: status.pause || fiveHour.pause || weekly.pause };
}

// Subscription rate-limit snapshot as reported by the CLI's init event (percent of window used + reset time,
// not $ — subscription auth isn't billed per token). Field names are read generically/defensively since they
// vary across CLI versions; an unrecognized shape just yields null rather than a guessed value.
function parseRateLimitWindow(o) {
  if (!o || typeof o !== 'object') return null;
  let pct = o.utilization != null ? Number(o.utilization) : o.pct != null ? Number(o.pct)
    : (o.used != null && o.limit) ? Number(o.used) / Number(o.limit) : null;
  if (pct == null || Number.isNaN(pct)) return null;
  if (pct > 1) pct = pct / 100; // some CLIs report 0-100 instead of 0-1
  let resetsAt = o.resets_at || o.resetsAt || o.reset_at || o.resetAt || null;
  if (typeof resetsAt === 'number') {
    // Epoch seconds vs milliseconds: seconds-since-epoch is ~10 digits (<1e12) through the year 5138;
    // some CLIs already report milliseconds, which would otherwise land centuries in the future.
    resetsAt = new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt).toISOString();
  }
  // Unparseable reset times aren't useful as a countdown — omit rather than show "↻0m". A reset time already
  // in the past means the window this reading describes has reset: the whole reading is stale and must not
  // count (its pct described the old window), so drop it entirely instead of keeping an orphaned pct.
  if (resetsAt) {
    const t = new Date(resetsAt).getTime();
    if (Number.isNaN(t)) resetsAt = null;
    else if (t <= Date.now()) return null;
  }
  return { pct: Math.max(0, Math.min(1, pct)), resetsAt };
}
// Two shapes the CLI reports rate limits in: a "system"/"init" event's rate_limits field (older/simpler), and
// the live "rate_limit_event" stream event's rate_limit_info.unifiedWindows (real shape seen on Claude Code
// 2.x: { five_hour: { utilization, resetsAt }, seven_day: { utilization, resetsAt } }, resetsAt in epoch seconds).
function parseRateLimits(ev = {}) {
  const info = ev.rate_limit_info && typeof ev.rate_limit_info === 'object' ? ev.rate_limit_info : null;
  const src = info ? (info.unifiedWindows || {}) : (ev.rate_limits || ev.rateLimits || {});
  const fiveHour = parseRateLimitWindow(src.five_hour || src.fiveHour || src['5h']);
  const weekly = parseRateLimitWindow(src.week || src.weekly || src.seven_day || src.sevenDay);
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly };
}
// Guard against the configured subscription-usage threshold (default 90%), independent of the count-based
// fiveHourLimit/weeklyLimit above: uses the CLI's own reported utilization + reset time, not a local request count.
// Only still-live readings count: one whose resetsAt has already passed describes a window that reset.
function subscriptionGuard(rateLimits, thresholdPct = GUARD_DEFAULT_PCT) {
  const rl = liveRateLimits(rateLimits);
  const mk = (w) => ({ pct: w ? w.pct : 0, resetsAt: w ? w.resetsAt : null, pause: !!(w && w.pct * 100 >= thresholdPct) });
  const fiveHour = mk(rl && rl.fiveHour);
  const weekly = mk(rl && rl.weekly);
  return { fiveHour, weekly, pause: fiveHour.pause || weekly.pause, thresholdPct };
}

// Real per-provider subscription usage (5h + weekly used %, reset time), with an explicit reason when it can't
// be reported. rateLimits is the CLI's own self-reported window (usage.js parseRateLimits, from the most recent
// init event) — there is no separate network call: the CLI is the provider's own client and already knows this.
// ctx: { installed, billingMode } — why it might be unavailable even before any rate-limit data exists.
function providerUsageStatus(rateLimits, ctx = {}) {
  if (ctx.installed === false) return { available: false, reason: 'runtime not installed', fiveHour: null, weekly: null };
  if (ctx.billingMode && ctx.billingMode !== 'auto' && ctx.billingMode !== 'subscription') {
    return { available: false, reason: `billing mode "${ctx.billingMode}" is not subscription-based`, fiveHour: null, weekly: null };
  }
  if (!rateLimits || (!rateLimits.fiveHour && !rateLimits.weekly)) {
    return { available: false, reason: 'no usage reported yet by the CLI (run this agent once to get real usage)', fiveHour: null, weekly: null };
  }
  return { available: true, reason: null, fiveHour: rateLimits.fiveHour || null, weekly: rateLimits.weekly || null };
}

// Provider-keyed usage limits (t_8f8ab37d): one entry per provider the team's agents actually run, shaped
// { provider, plan, status, reason, windows[{label,used,limit,pct,warn,pause,resetAt}] }. A provider is the
// runtime's CLI vendor (claude, codex, a custom runtime like helpycode) — Claude's 5h/weekly windows are one
// adapter here, not the model itself. Windows come from two sources per provider: the provider's own CLIs'
// self-reported utilization (live parseRateLimits readings only — a stale one describes a window that already
// reset) and the project's configured budget over that provider's windowed subscription runs. A provider whose
// CLIs reported nothing and that has no windowed usage is status 'unknown' with an explicit reason and no
// windows — never a fabricated 0%; a configured budget alone also doesn't make a silent provider "known".
const PROVIDER_WINDOW_LABELS = ['5h', 'weekly'];
const PROVIDER_WINDOW_KEYS = { '5h': 'fiveHour', weekly: 'weekly' }; // parseRateLimits reading keys per window label
const PROVIDER_UNKNOWN_REASON = 'no usage reported yet by the CLI (run this agent once to get real usage)';
function usageProviders({ runs = [], limits, nodes = [], rateLimitsByNode = {}, warnPct = 80, now = Date.now() } = {}) {
  const l = normalizeLimits(limits);
  const groups = new Map();
  for (const n of nodes || []) {
    if (!n) continue;
    // Effective runtime, not the raw field: a node without one runs claude everywhere else in the app
    // (getRuntime, run stamping). Keying it as its own "unknown" provider made its claude-CLI windows
    // render as a second, duplicate chip beside the real claude one.
    const provider = effectiveRuntime(n);
    const g = groups.get(provider) || { nodes: [], rl: [] };
    g.nodes.push(n);
    const rl = nodeLiveRateLimits(n, rateLimitsByNode);
    if (rl) g.rl.push(rl);
    groups.set(provider, g);
  }
  const claimed = new Set(groups.keys());
  // Runs can predate the runtime stamp (legacy persisted data, imports) and so name no provider. On a
  // single-provider team they can only belong to that one provider — count them there. With several
  // providers attribution would be a guess, so they stay uncounted rather than fabricating a split.
  const orphans = runs.filter((r) => r && r.kind === 'agent' && !claimed.has(r.runtime || 'unknown'));
  const providers = [];
  for (const [provider, g] of groups) {
    const pRuns = runs.filter((r) => r.kind === 'agent' && (r.runtime || 'unknown') === provider)
      .concat(groups.size === 1 ? orphans : []);
    // plan: how this provider's agents are billed — actual run billing wins, then a node's configured mode.
    const billed = new Set(pRuns.map((r) => authType(r.billingSource)));
    const plan = billed.has('subscription') ? 'subscription' : billed.has('api') ? 'api'
      : (g.nodes.find((n) => n.billingMode === 'subscription' || n.billingMode === 'api') || {}).billingMode || 'unknown';
    const subRuns = pRuns.filter((r) => authType(r.billingSource) === 'subscription');
    const cliOf = (label) => g.rl.map((rl) => rl[PROVIDER_WINDOW_KEYS[label]]).filter(Boolean).sort((a, b) => b.pct - a.pct)[0] || null;
    const runOf = (label) => windowUsage(subRuns, label === '5h' ? FIVE_HOURS_MS : WEEK_MS, now);
    const hasData = PROVIDER_WINDOW_LABELS.some((label) => cliOf(label) || runOf(label).used > 0);
    if (!hasData) { providers.push({ provider, plan, status: 'unknown', reason: PROVIDER_UNKNOWN_REASON, windows: [] }); continue; }
    const windows = [];
    for (const label of PROVIDER_WINDOW_LABELS) {
      const cli = cliOf(label), u = runOf(label), lim = label === '5h' ? l.fiveHourLimit : l.weeklyLimit;
      if (!cli && !lim && u.used === 0) continue; // nothing backs this window: omit it rather than show an empty row
      const pct = cli ? cli.pct : lim ? u.used / lim : null;
      windows.push({
        label,
        used: u.used,
        limit: lim,
        ...(pct != null ? { pct } : {}),
        warn: cli ? cli.pct * 100 >= warnPct : lim ? u.used / lim * 100 >= warnPct : false,
        pause: cli ? cli.pct >= 1 : lim ? u.used >= lim : false,
        resetAt: (cli && cli.resetsAt) || u.resetsAt || null,
      });
    }
    providers.push({ provider, plan, status: 'ok', reason: null, windows });
  }
  return providers;
}

// Context-window usage: the CLI resends the whole conversation as input on every turn, so the LAST assistant
// message's own (uncombined) usage is the live context size — never sum across turns like tokensFromResult does.
// 200k is the standard window; "[1m]" model ids (e.g. "claude-sonnet-5[1m]") get the 1M beta context window.
const CONTEXT_WINDOW_DEFAULT = 200000;
const CONTEXT_WINDOW_1M = 1000000;
function contextWindowFor(model) { return /\[1m\]/i.test(String(model || '')) ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT; }
// One assistant stream-json event -> { messageId, model, contextTokens } or null if not a usable usage event.
// Deliberately excludes output_tokens: context is what gets resent next turn, i.e. input + cache read + cache
// creation. Stream-json can emit several deltas for the same message id; caller dedupes by messageId.
function contextFromAssistant(ev) {
  if (!ev || ev.type !== 'assistant' || !ev.message) return null;
  const msg = ev.message; const u = msg.usage; const messageId = msg.id;
  if (!u || !messageId) return null;
  const contextTokens = (+u.input_tokens || 0) + (+u.cache_read_input_tokens || 0) + (+u.cache_creation_input_tokens || 0);
  return { messageId, model: msg.model || '', contextTokens };
}
// system/compact_boundary event -> { preTokens, postTokens, trigger } or null. Emitted by the CLI right after
// it compacts a session's history (manual /compact or automatic, incl. via CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).
function parseCompactBoundary(ev) {
  if (!ev || ev.type !== 'system' || ev.subtype !== 'compact_boundary') return null;
  const cm = ev.compact_metadata || {};
  return { preTokens: +cm.pre_tokens || 0, postTokens: +cm.post_tokens || 0, trigger: cm.trigger || 'unknown' };
}

module.exports = { resultSnapshot, tokensForRun, BILLING_MODES, BILLING_SOURCES, normalizeBilling, applyBillingEnv, detectBilling, costNote, tokensFromResult, totalTokens, newRun, applyEvent, finishRun, summarize, total, modelStats, toCSV, CSV_COLS,
  canonModel, reportedCostOf, resolveEntryCost, applyProxySpend, providerOf, accountRuntime, buildLedger, usageLedger, ledgerEntriesOf,
  LIMITS_DEFAULTS, normalizeLimits, authType, windowUsage, limitStatus, usageStatus, applyCliRateLimits, parseRateLimitWindow, parseRateLimits, liveRateLimits, nodeLiveRateLimits, effectiveRuntime, subscriptionGuard, providerUsageStatus, usageProviders, GUARD_DEFAULT_PCT,
  CONTEXT_WINDOW_DEFAULT, CONTEXT_WINDOW_1M, contextWindowFor, contextFromAssistant, parseCompactBoundary };
