// LiteLLM integrations for real cost accounting (t_6ee6a70b): the proxy's own per-request cost and
// the runtime price list. There are NO price literals here or anywhere in src/ — every number comes
// from the proxy's spend data, the LiteLLM price JSON (fetched, cached on disk, refreshed daily) or
// the user's per-model overrides in settings. Pure Node: no Electron, no app imports.

const fs = require('fs');

const PRICE_JSON_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
// LiteLLM's native field names, so a user override can be pasted straight from the price JSON.
const PRICE_FIELDS = { input: 'input_cost_per_token', output: 'output_cost_per_token', cacheRead: 'cache_read_input_token_cost', cacheWrite: 'cache_creation_input_token_cost' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// x-litellm-response-cost response header (or the same value as a spend-log field): dollars, stringy.
function parseHeaderCost(v) {
  if (v == null) return null;
  const n = Number(String(v).trim().replace(/^\$/, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// One spend-log entry -> { requestId, model, costUsd, tokens, sessionTags } | null. Cost comes from
// the entry's own fields (spend / response_cost / metadata.usage_object.cost — first numeric wins;
// the x-litellm-response-cost header value is accepted too). Unrecognized shapes -> null, never a guess.
function normalizeSpendEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const meta = e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
  const uo = meta.usage_object && typeof meta.usage_object === 'object' ? meta.usage_object : {};
  const costUsd = num(e.spend) ?? num(e.response_cost) ?? num(e._response_cost) ?? num(uo.cost) ?? num(meta.response_cost) ?? parseHeaderCost(e['x-litellm-response-cost']) ?? parseHeaderCost(meta['x-litellm-response-cost']);
  if (costUsd == null) return null;
  const tags = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === 'string' ? meta.tags.split(',') : [];
  const sessionTags = [meta.session_id, meta.litellm_session_id, e.session_id, ...tags].map(str).filter(Boolean);
  const model = str(e.model) || str(meta.model_group);
  const requestId = str(e.request_id) || str(e.call_id) || str(e.id);
  const tokens = {
    inputTokens: num(e.prompt_tokens) ?? num(uo.prompt_tokens) ?? 0,
    outputTokens: num(e.completion_tokens) ?? num(uo.completion_tokens) ?? 0,
    cacheReadTokens: num(e.cache_read_input_tokens) ?? num(uo.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: num(e.cache_creation_input_tokens) ?? num(uo.cache_creation_input_tokens) ?? 0,
  };
  return { requestId, model, costUsd, tokens, sessionTags };
}

// The dedupe key for one entry: the proxy's request id when it has one, else a content key (entries
// without an id cannot be told apart, so identical content is treated as the same re-reported request).
const spendKeyOf = (e) => e.requestId || `n:${e.model}|${e.costUsd}|${Object.values(e.tokens).join(',')}|${e.sessionTags.join(',')}`;

// Sum the per-request spend that belongs to one agent run. The join key is the session id: entries
// must carry it in their metadata/tags (session_id / litellm_session_id / a `session:<id>` or
// `agents-squad:session:<id>` tag) — without it nothing is attributed (no time-window guessing).
// seenRequestIds dedupes across fetches and resumed sessions' cumulative logs; keys of everything
// counted here are added to the set and returned so callers can persist them. Proxy costs are
// per-request by definition — they never go through the resume-delta logic.
function joinSpendLogs(logs, { sessionId, seenRequestIds = new Set() } = {}) {
  const sid = str(sessionId);
  if (!sid) return null;
  const entries = []; const keys = [];
  for (const raw of Array.isArray(logs) ? logs : []) {
    const e = normalizeSpendEntry(raw);
    if (!e) continue;
    const hit = e.sessionTags.includes(sid) || e.sessionTags.some((t) => { const m = t.match(/^(?:agents-squad:)?session:(.+)$/); return m && m[1] === sid; });
    if (!hit) continue;
    const key = spendKeyOf(e);
    if (seenRequestIds.has(key)) continue;
    seenRequestIds.add(key);
    entries.push(e); keys.push(key);
  }
  if (!entries.length) return null;
  const byModel = {};
  let costUsd = 0;
  for (const e of entries) { costUsd += e.costUsd; const m = e.model || 'unknown'; byModel[m] = (byModel[m] || 0) + e.costUsd; }
  return { costUsd, byModel, requests: entries.length, keys };
}

// Which env var can read the proxy's spend API. Spend logs are an admin endpoint: a virtual key
// usually cannot read them, so the master key wins when present; the run's own auth token is the
// last resort (works on proxies that allow key-holder self-reads).
function proxyApiKey(env = {}) {
  return str(env.LITELLM_MASTER_KEY) || str(env.LITELLM_API_KEY) || str(env.LITELLM_KEY) || str(env.ANTHROPIC_AUTH_TOKEN) || str(env.ANTHROPIC_API_KEY) || null;
}

// GET <base>/spend/logs with a short timeout. Base URL is the CLI's ANTHROPIC_BASE_URL; a trailing
// /v1 belongs to the model API, not the admin API, and is stripped. Resolves
// { ok: true, logs: [...] } | { ok: false, reason } — never throws.
async function fetchSpendLogs({ baseUrl, apiKey, timeoutMs = 5000, fetchImpl = global.fetch } = {}) {
  if (!str(baseUrl) || !str(apiKey)) return { ok: false, reason: 'proxy base URL or API key missing' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no fetch available' };
  const root = String(baseUrl).trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  if (timer && timer.unref) timer.unref();
  try {
    const res = await fetchImpl(`${root}/spend/logs`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ac ? ac.signal : undefined });
    if (!res.ok) return { ok: false, reason: `spend/logs HTTP ${res.status}` };
    const body = await res.json();
    const logs = Array.isArray(body) ? body : Array.isArray(body && body.data) ? body.data : [];
    return { ok: true, logs };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e && e.message) || 'fetch failed' };
  } finally { if (timer) clearTimeout(timer); }
}

// Keep only entries the app can actually price with — a plain object keyed by model id where each
// value carries a numeric input or output per-token price. Drops error pages, mode-only specs and
// truncated junk; an empty result fails the schema check.
function validatePrices(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {}; let priced = 0;
  for (const [k, v] of Object.entries(body)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (num(v[PRICE_FIELDS.input]) == null && num(v[PRICE_FIELDS.output]) == null) continue;
    out[k] = v; priced++;
  }
  return priced >= 1 ? out : null;
}

// Canonical price-list lookup key: lowercase, context-window suffix and dated build suffix stripped
// (mirrors usage.js canonModel — kept local so this module stays import-free).
const canonPriceKey = (model) => {
  const s = str(model);
  return s ? s.toLowerCase().replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '') : null;
};

function writeCacheAtomic(cachePath, data) {
  const tmp = `${cachePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, cachePath);
}

// The runtime price list: LiteLLM's model_prices_and_context_window.json fetched from GitHub, cached
// on disk and refreshed at most daily; a failed fetch falls back to the stale cache (or nothing —
// models then price as unknown, never from a guessed number). Per-model user overrides (same field
// names as the JSON) always beat the fetched price, and can price models the JSON is missing
// entirely (e.g. zai/glm behind a LiteLLM proxy).
class PriceBook {
  constructor({ cachePath = null, url = PRICE_JSON_URL, overrides = null, fetchImpl = global.fetch, timeoutMs = 8000, ttlMs = 24 * 60 * 60 * 1000, retryMs = 10 * 60 * 1000, now = null } = {}) {
    this.cachePath = cachePath; this.url = url; this.overrides = overrides;
    this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.ttlMs = ttlMs; this.retryMs = retryMs;
    this.now = now || (() => Date.now());
    this._cache = null; this._cacheRead = false; this._refreshing = null; this._nextTryAt = 0; this._lastError = null;
  }
  // Last-known prices: memoized read of the on-disk cache. null when there is none (first run before
  // any successful fetch) — estimation then reports unknown rather than inventing a price.
  cached() {
    if (!this._cacheRead) {
      this._cacheRead = true;
      if (this.cachePath) {
        try {
          const d = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
          const prices = validatePrices(d && d.prices);
          if (prices) this._cache = { prices, fetchedAt: str(d.fetchedAt) };
        } catch {}
      }
    }
    return this._cache;
  }
  // Refresh from the source, throttled: within ttlMs of a successful fetch (or retryMs of a failed
  // one) this is a no-op unless force. Concurrent callers share one in-flight refresh. Never throws.
  async refresh({ force = false } = {}) {
    const c = this.cached();
    const t = this.now();
    if (!force && c && c.fetchedAt && t - Date.parse(c.fetchedAt) < this.ttlMs) return { source: 'cache', fetchedAt: c.fetchedAt };
    if (!force && t < this._nextTryAt) return { source: c ? 'stale' : 'none', error: this._lastError };
    if (typeof this.fetchImpl !== 'function') return { source: c ? 'stale' : 'none', error: 'no fetch available' };
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), this.timeoutMs) : null;
      if (timer && timer.unref) timer.unref();
      try {
        const res = await this.fetchImpl(this.url, { signal: ac ? ac.signal : undefined });
        if (!res.ok) throw new Error(`price list HTTP ${res.status}`);
        const prices = validatePrices(await res.json());
        if (!prices) throw new Error('price list failed the schema check');
        const fetchedAt = new Date(this.now()).toISOString();
        this._cache = { prices, fetchedAt }; this._cacheRead = true; this._nextTryAt = 0; this._lastError = null;
        if (this.cachePath) { try { writeCacheAtomic(this.cachePath, { fetchedAt, prices }); } catch {} }
        return { source: 'fresh', fetchedAt };
      } catch (e) {
        this._nextTryAt = this.now() + this.retryMs; this._lastError = (e && e.message) || 'fetch failed';
        const stale = this.cached();
        return { source: stale ? 'stale' : 'none', error: this._lastError };
      } finally {
        if (timer) clearTimeout(timer);
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  }
  overridesNow() {
    try { const o = typeof this.overrides === 'function' ? this.overrides() : this.overrides; return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
  }
  // Per-token prices for one model: { input, output, cacheRead, cacheWrite } (null when that class
  // is unpriced), or null when the model is in neither overrides nor the price list. Lookup tries
  // the raw id and its canonical form, with and without an org prefix ("zai/glm-5.2"). Overrides
  // are checked first across all key shapes: a user override always beats the fetched price.
  priceFor(model) {
    const raw = str(model); if (!raw) return null;
    const canon = canonPriceKey(raw);
    const bare = canon && canon.includes('/') ? canon.slice(canon.lastIndexOf('/') + 1) : null;
    const rawBare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : null;
    const keys = [raw, raw.toLowerCase(), canon, bare, rawBare && rawBare.toLowerCase(), rawBare];
    const sources = [this.overridesNow() || {}, (this.cached() || {}).prices || {}];
    let hit = null;
    for (const src of sources) {
      for (const k of keys) {
        const v = k != null ? src[k] : null;
        if (v && typeof v === 'object' && !Array.isArray(v)) { hit = v; break; }
      }
      if (hit) break;
    }
    // The ledger's canonical ids have no org prefix ("glm-5.2") while list keys usually do
    // ("zai/glm-5.2"): fall back to matching the bare suffix of each list key. First hit wins.
    if (!hit && canon) {
      const target = canon.includes('/') ? canon.slice(canon.lastIndexOf('/') + 1) : canon;
      for (const src of sources) {
        for (const k of Object.keys(src)) {
          const kb = canonPriceKey(k);
          if (kb && kb.includes('/') && kb.slice(kb.lastIndexOf('/') + 1) === target) {
            const v = src[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) { hit = v; break; }
          }
        }
        if (hit) break;
      }
    }
    if (!hit) return null;
    const p = { input: num(hit[PRICE_FIELDS.input]), output: num(hit[PRICE_FIELDS.output]), cacheRead: num(hit[PRICE_FIELDS.cacheRead]), cacheWrite: num(hit[PRICE_FIELDS.cacheWrite]) };
    if (p.input == null && p.output == null) return null;
    return p;
  }
  // Cost for one ledger entry's tokens. Every class that flowed is priced or the result is flagged:
  // tokens flowing in an unpriced class make the whole cost unknown (partial) — skipping the class
  // would silently under-count, which is exactly the bug this replaces. Returns
  // { costUsd, partial, priced } — costUsd null when unknown.
  estimate(model, t = {}) {
    const p = this.priceFor(model);
    if (!p) return { costUsd: null, partial: false, priced: false };
    let cost = 0; let partial = false;
    for (const [field, price] of [['inputTokens', p.input], ['outputTokens', p.output], ['cacheReadTokens', p.cacheRead], ['cacheCreationTokens', p.cacheWrite]]) {
      const n = t[field] || 0; // null (unreported) counts as "did not flow"
      if (n > 0 && price == null) { partial = true; continue; }
      cost += n * (price || 0);
    }
    if (partial) return { costUsd: null, partial: true, priced: true };
    return { costUsd: cost, partial: false, priced: true };
  }
}

module.exports = { PRICE_JSON_URL, PRICE_FIELDS, parseHeaderCost, normalizeSpendEntry, joinSpendLogs, proxyApiKey, fetchSpendLogs, validatePrices, PriceBook };
