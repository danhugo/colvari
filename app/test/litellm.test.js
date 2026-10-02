const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const U = require('../src/usage');
const L = require('../src/litellm');
const { mktemp } = require('./harness/tmp');

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'litellm-prices.json'), 'utf8'));

test('reportedCostOf distinguishes absent, direct zero, and proxy-unpriced zero', () => {
  assert.deepEqual(U.reportedCostOf({}), { costUsd: null, reported: false, proxyUnpriced: false });
  assert.deepEqual(U.reportedCostOf({ total_cost_usd: 0 }), { costUsd: 0, reported: true, proxyUnpriced: false });
  assert.deepEqual(U.reportedCostOf({ total_cost_usd: 0 }, { env: { ANTHROPIC_BASE_URL: 'http://proxy/v1' } }), { costUsd: 0, reported: true, proxyUnpriced: true });
  assert.equal(U.reportedCostOf({ total_cost_usd: 0.04 }).costUsd, 0.04);
});

test('PriceBook loads fixture prices, keeps missing models unknown, and honors overrides', () => {
  const dir = mktemp('prices-');
  const cachePath = path.join(dir, 'prices.json');
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), prices: fixture() }));
  const book = new L.PriceBook({ cachePath, overrides: { 'zai/glm-5.2': { input_cost_per_token: 1e-6, output_cost_per_token: 3e-6 } } });
  assert.deepEqual(book.priceFor('zai/glm-5.2'), { input: 1e-6, output: 3e-6, cacheRead: null, cacheWrite: null });
  const est = book.estimate('claude-sonnet-4-5-20250929', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheCreationTokens: 2 });
  assert.equal(est.partial, false); assert.equal(est.priced, true);
  assert.ok(Math.abs(est.costUsd - 0.0006105) < 1e-12); // cache read AND write tokens are priced
  assert.deepEqual(book.estimate('unknown-model', { inputTokens: 2 }), { costUsd: null, partial: false, priced: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('joinSpendLogs filters by session and dedupes request ids', () => {
  const logs = [{ request_id: 'r1', model: 'zai/glm-5.2', spend: 0.12, metadata: { session_id: 'S' } }, { request_id: 'r2', model: 'zai/glm-5.2', response_cost: 0.03, metadata: { tags: ['agents-squad:session:S'] } }, { request_id: 'other', spend: 9, metadata: { session_id: 'X' } }];
  const seen = new Set();
  assert.deepEqual(L.joinSpendLogs(logs, { sessionId: 'S', seenRequestIds: seen }), { costUsd: 0.15, byModel: { 'zai/glm-5.2': 0.15 }, requests: 2, keys: ['r1', 'r2'] });
  assert.equal(L.joinSpendLogs(logs, { sessionId: 'S', seenRequestIds: seen }), null);
});

test('proxy spend replaces an estimated/unknown ledger entry once', () => {
  // ledger entry models are canonical (org prefix moved to providerHint); the spend log's raw id
  // ("zai/glm-5.2-20260101") canonicalizes to the same key
  const r = U.newRun({ nodeId: 'n', model: 'zai/glm-5.2', billingSource: 'proxy', ledger: [{ model: 'glm-5.2', inputTokens: 100, outputTokens: 10, costUsd: null, costSource: 'unknown' }] });
  assert.equal(U.applyProxySpend(r, { total: 0.07, byModel: { 'zai/glm-5.2-20260101': 0.07 } }), 0.07);
  assert.equal(r.ledger[0].costUsd, 0.07);
  assert.equal(U.applyProxySpend(r, { total: 0.08, byModel: { 'zai/glm-5.2-20260101': 0.08 } }), 0);
});

// ---- the four cost-source cases the task requires (fixtures from litellm-prices.json) ----

// a book whose disk cache IS the fixture (finishRun reads cached() without a refresh)
const bookFromFixture = (over = {}) => {
  const dir = mktemp('prices-');
  const cachePath = path.join(dir, 'prices.json');
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), prices: fixture() }));
  return new L.PriceBook({ cachePath, ...over });
};
const glmResult = () => ({ type: 'result', session_id: 'sesG', total_cost_usd: 0, modelUsage: { 'zai/glm-5.2-20260101': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 50, costUSD: 0, provider: 'anthropic', canonicalModel: 'glm-5.2', seen: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] } } });

test('GLM via LiteLLM proxy: a $0 from the proxy prices through the list, cache tokens included', () => {
  const r = U.newRun({ runtime: 'claude' });
  U.applyEvent(r, glmResult());
  U.finishRun(r, { code: 0, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_AUTH_TOKEN: 'sk' }, billingMode: 'api', priceBook: bookFromFixture() });
  assert.equal(r.proxyUnpriced, true);
  const e = r.ledger[0];
  assert.equal(e.model, 'glm-5.2');
  assert.equal(e.costSource, 'estimated');
  assert.equal(e.costPartial, undefined);
  assert.ok(Math.abs(e.costUsd - 0.001155) < 1e-12); // 1000*6e-7 + 200*2.2e-6 + 500*1.1e-7 + 50*1.2e-6
  assert.ok(Math.abs(e.billed - e.costUsd) < 1e-12);
});

test('Claude reported cost wins over the price book', () => {
  const r = U.newRun({ runtime: 'claude' });
  U.applyEvent(r, { type: 'result', total_cost_usd: 0.12, modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 100, outputTokens: 20, costUSD: 0.12, provider: 'firstParty', canonicalModel: 'claude-sonnet-4-5' } } });
  U.finishRun(r, { code: 0, env: { ANTHROPIC_API_KEY: 'x' }, billingMode: 'api', priceBook: bookFromFixture() });
  assert.equal(r.costKnown, true);
  assert.equal(r.ledger[0].costSource, 'reported');
  assert.equal(r.ledger[0].costUsd, 0.12);
});

test('an unknown model with tokens flowing stays unknown, never a guessed $0', () => {
  const r = U.newRun({ runtime: 'claude', model: 'mystery/model-x' });
  U.applyEvent(r, { type: 'result', total_cost_usd: 0, usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: { 'mystery/model-x': { inputTokens: 100, outputTokens: 10, costUSD: 0, canonicalModel: 'model-x' } } });
  U.finishRun(r, { code: 0, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_AUTH_TOKEN: 'sk' }, billingMode: 'api', priceBook: bookFromFixture() });
  const e = r.ledger[0];
  assert.equal(e.costUsd, null);
  assert.equal(e.costSource, 'unknown');
  assert.equal(e.billed, null);
});

test('a missing price list degrades to unknown, and a fresh fetch repopulates the disk cache', () => {
  const dir = mktemp('prices-');
  const r = U.newRun({ runtime: 'claude', model: 'zai/glm-5.2' });
  U.applyEvent(r, glmResult());
  U.finishRun(r, { code: 0, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_AUTH_TOKEN: 'sk' }, billingMode: 'api', priceBook: new L.PriceBook({ cachePath: path.join(dir, 'none.json') }) });
  assert.equal(r.ledger[0].costSource, 'unknown');
  assert.equal(r.ledger[0].costUsd, null);
  const book = new L.PriceBook({ cachePath: path.join(dir, 'prices.json'), fetchImpl: async () => ({ ok: true, json: async () => fixture() }) });
  return book.refresh().then((res) => {
    assert.equal(res.source, 'fresh');
    assert.ok(fs.existsSync(path.join(dir, 'prices.json'))); // cached for the next boot
    assert.equal(book.estimate('zai/glm-5.2', { inputTokens: 10 }).costUsd, 6e-6);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---- orchestrator wiring: the late proxy-cost join lands on the persisted run and counters ----

test('resolveProxyCost joins spend logs after close, once per request id', async () => {
  const { Store } = require('../src/store');
  const { Orchestrator } = require('../src/orchestrator');
  const dir = mktemp('proxycost-');
  const s = new Store(path.join(dir, 'p'));
  const logs = [{ request_id: 'req-1', model: 'zai/glm-5.2', spend: 0.07, prompt_tokens: 1000, completion_tokens: 200, metadata: { session_id: 'sesG' } }];
  const o = new Orchestrator(s, { fetchSpendLogs: async () => ({ ok: true, logs }), priceBook: new L.PriceBook({}) });
  const rec = U.newRun({ runtime: 'claude', model: 'zai/glm-5.2', nodeId: 'nT' });
  U.applyEvent(rec, glmResult());
  U.finishRun(rec, { code: 0, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_AUTH_TOKEN: 'sk' }, billingMode: 'api', priceBook: bookFromFixture() });
  o.record(rec);
  const before = o.totalCost;
  assert.equal(o.resolveProxyCost(rec, {}), null); // no proxy base URL -> no-op
  await o.resolveProxyCost(rec, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_AUTH_TOKEN: 'sk' });
  assert.equal(o._proxyJobs.length, 0);
  assert.equal(rec.ledger[0].costSource, 'proxy');
  assert.ok(Math.abs(rec.ledger[0].costUsd - 0.07) < 1e-12);
  assert.ok(Math.abs(o.totalCost - (before + 0.07)) < 1e-12);
  const persisted = s.listRuns().find((x) => x.id === rec.id);
  assert.equal(persisted.ledger[0].costSource, 'proxy');
  assert.equal(persisted.proxySpend.requests, 1);
  assert.deepEqual([...s.read('proxy-spend', { seenIds: [] }).seenIds], ['req-1']);
  // a second run of the same session must not re-count the cumulative log entry
  const rec2 = U.newRun({ runtime: 'claude', model: 'zai/glm-5.2', nodeId: 'nT' });
  U.applyEvent(rec2, { ...glmResult(), session_id: 'sesG' });
  U.finishRun(rec2, { code: 0, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_AUTH_TOKEN: 'sk' }, billingMode: 'api', priceBook: bookFromFixture() });
  o.record(rec2);
  await o.resolveProxyCost(rec2, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_AUTH_TOKEN: 'sk' });
  assert.equal(rec2.ledger[0].costSource, 'estimated'); // nothing new joined; estimate stays
  fs.rmSync(dir, { recursive: true, force: true });
});
