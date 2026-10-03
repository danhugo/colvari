const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const U = require('../src/usage');
const L = require('../src/litellm');
const { Store } = require('../src/store');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

const run = (fields) => U.finishRun(U.newRun({ runtime: 'claude', ...fields }), { code: 0, env: {}, billingMode: 'api' });

test('usage ledger keeps runtime/provider/model keys and token types separate', () => {
  const a = U.newRun({ runtime: 'claude' });
  U.applyEvent(a, { type: 'result', total_cost_usd: 0.12, modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 4, costUSD: 0.12, provider: 'firstParty', canonicalModel: 'claude-sonnet-4-5' } } });
  U.finishRun(a, { code: 0, env: { ANTHROPIC_API_KEY: 'x' } });
  const b = U.newRun({ runtime: 'codex', model: 'gpt-5' });
  b.inputTokens = 50; b.outputTokens = 10; b.cacheReadTokens = 8; b.flatSeen = ['inputTokens', 'outputTokens', 'cacheReadTokens']; b.reportedCostUsd = 0.03;
  U.finishRun(b, { code: 0, env: {} });
  const l = U.usageLedger([a, b]);
  assert.equal(l.rows.length, 2);
  assert.deepEqual(l.rows.map((x) => [x.runtime, x.provider, x.model]), [['claude', 'firstParty', 'claude-sonnet-4-5'], ['codex', 'unknown', 'gpt-5']]);
  assert.deepEqual(l.rows[0], { runtime: 'claude', provider: 'firstParty', model: 'claude-sonnet-4-5', key: 'claude¦firstParty¦claude-sonnet-4-5', runs: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 4, costUsd: 0.12, apiEq: 0.12, billed: 0.12, costSource: 'reported', costPartial: false });
  assert.equal(l.rows[1].cacheCreationTokens, null); // codex reports no cache writes: unknown, not 0
  assert.equal(Object.hasOwn(l.rows[0], 'totalTokens'), false);
  assert.equal(Object.hasOwn(l, 'tokens'), false);
});

test('usage ledger groups the same key per agent and task', () => {
  const entry = (io, out) => ({ runtime: 'helpycode', provider: 'zai', model: 'mistral-large', inputTokens: io, outputTokens: out, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, costSource: 'unknown' });
  const mk = (io, out) => { const r = U.newRun({ runtime: 'helpycode', model: 'mistral-large' }); r.inputTokens = io; r.outputTokens = out; r.ledger = [entry(io, out)]; return r; };
  const a = { ...mk(10, 2), agent: 'A', taskId: 't1' };
  const b = { ...mk(5, 1), agent: 'A', taskId: 't1' };
  const l = U.usageLedger([a, b]);
  assert.equal(l.byAgent.A.length, 1); assert.equal(l.byAgent.A[0].inputTokens, 15);
  assert.equal(l.byTask.t1.length, 1); assert.equal(l.byTask.t1[0].outputTokens, 3);
  assert.equal(l.costUsd, 0); assert.equal(l.costPartial, true);
});

test('canonical model aliases collapse and unknown cache/cost stay explicit', () => {
  assert.deepEqual(U.canonModel('zai/glm-5[1m]'), { model: 'glm-5', providerHint: 'zai' });
  const a = run({ model: 'claude-haiku-4-5-20251001', inputTokens: 1000, outputTokens: 1000, billingSource: 'api', ledger: [{ runtime: 'claude', provider: 'firstParty', model: 'claude-haiku-4-5-20251001', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, costSource: 'unknown' }] });
  const l = U.usageLedger([a]);
  assert.equal(l.rows[0].model, 'claude-haiku-4-5');
  assert.equal(l.rows[0].cacheReadTokens, null);
  assert.equal(l.rows[0].costSource, 'unknown'); // no price book: unknown, never a guessed $0
  assert.equal(l.rows[0].costUsd, null);
  // pre-ledger stragglers synthesize an entry at aggregate time and CAN resolve through a book
  const book = new L.PriceBook({ overrides: { 'claude-haiku-4-5': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 } } });
  const straggler = { ...U.newRun({ runtime: 'claude', model: 'claude-haiku-4-5-20251001', billingSource: 'api' }), inputTokens: 1000, outputTokens: 1000 };
  const l2 = U.usageLedger([straggler], { priceBook: book });
  assert.equal(l2.rows[0].model, 'claude-haiku-4-5');
  assert.equal(l2.rows[0].costSource, 'estimated');
  assert.ok(l2.rows[0].costUsd > 0);
});

test('modelUsage result builds one ledger entry per provider/model', () => {
  const r = U.newRun({ runtime: 'claude', billingSource: 'api' });
  U.applyEvent(r, { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5-20250929', apiKeySource: 'ANTHROPIC_API_KEY' });
  U.applyEvent(r, { type: 'result', total_cost_usd: 0.2, modelUsage: {
    'claude-sonnet-4-5-20250929': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, costUSD: 0.2, provider: 'firstParty', canonicalModel: 'claude-sonnet-4-5' },
    'claude-haiku-4-5-20251001': { inputTokens: 50, outputTokens: 10, provider: 'firstParty', canonicalModel: 'claude-haiku-4-5' },
  }, usage: { input_tokens: 150, output_tokens: 30 }, num_turns: 1 });
  const book = new L.PriceBook({ overrides: { 'claude-haiku-4-5': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 } } });
  const x = U.finishRun(r, { code: 0, env: { ANTHROPIC_API_KEY: 'x' }, billingMode: 'api', priceBook: book });
  assert.equal(x.ledger.length, 2);
  assert.equal(x.ledger.find((e) => e.model === 'claude-sonnet-4-5').costSource, 'reported');
  assert.equal(x.ledger.find((e) => e.model === 'claude-haiku-4-5').costSource, 'estimated');
});

test('store migration: pre-ledger runs reset once, tracking start recorded, corrupt files never crash', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ledger-mig-'));
  const runsFile = path.join(d, 'runs.json');
  fs.writeFileSync(runsFile, JSON.stringify({ runs: [{ id: 'r_old', inputTokens: 10, outputTokens: 2, model: 'claude-3' }] }));
  fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({ id: 'p_x', name: 'x' }));
  const s = new Store(d);
  assert.deepEqual(s.listRuns(), []);
  const since = s.meta().usageTrackingSince;
  assert.ok(since, 'usageTrackingSince set on reset');
  assert.ok(fs.existsSync(path.join(d, '.usage-ledger')), 'marker written');
  s.addRun(U.newRun({}));
  const s2 = new Store(d); // second construction must not re-reset
  assert.equal(s2.listRuns().length, 1);
  assert.equal(s2.meta().usageTrackingSince, since);
  fs.rmSync(path.join(d, '.usage-ledger'));
  fs.writeFileSync(runsFile, '{oops');
  assert.doesNotThrow(() => new Store(d));
});

test('orchestrator snapshot exposes the ledger, never cross-model token totals', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ledger-snap-'));
  const pm = new ProjectManager(path.join(d, 'root')); const pid = pm.list()[0].id; const s = pm.store(pid);
  const o = new Orchestrator(s);
  const a = s.addNode({ name: 'A', role: 'Dev' });
  o.agents[a.id] = { ...o.agent(a.id), inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 1, cacheTokens: 2 };
  const snap = o.snapshot();
  assert.equal(snap.tokens, undefined); assert.equal(snap.runTokens, undefined);
  assert.equal(snap.agents[a.id].inputTokens, undefined); assert.equal(snap.agents[a.id].cacheTokens, undefined);
  assert.deepEqual(snap.ledger.rows, []); assert.ok('usageSince' in snap);
  assert.doesNotThrow(() => JSON.stringify(snap)); // must survive the renderer state push
});

test('ledger() instrumentation counts rebuilds vs memo hits and stays quiet under the slow threshold', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ledger-inst-'));
  const pm = new ProjectManager(path.join(d, 'root')); const pid = pm.list()[0].id; const s = pm.store(pid);
  const o = new Orchestrator(s);
  const lines = [];
  o.log = (id, kind, text) => lines.push(text);
  assert.deepEqual(o.ledger().rows, []);
  assert.equal(o._ledgerRebuilds, 1);
  o.ledger(); o.ledger(); // unchanged runs file: absorbed by the signature memo
  assert.equal(o._ledgerRebuilds, 1);
  assert.equal(o._ledgerHits, 2);
  assert.ok(typeof o._ledgerLastMs === 'number' && o._ledgerLastMs >= 0);
  assert.deepEqual(lines, []); // fast rebuild under the 50 ms slow-log threshold
  s.addRun(U.newRun({ runtime: 'claude', model: 'claude-sonnet-4-5' }));
  o.ledger();
  assert.equal(o._ledgerRebuilds, 2, 'a runs-file write invalidates the memo');
  assert.equal(o._ledgerHits, 2);
});

test('usageLedger() instrumentation accumulates per-call stats including the synthesized fallback', () => {
  U.usageLedger.stats = { calls: 0, runs: 0, entries: 0, synthesized: 0, lastMs: 0 }; // isolate from earlier suites
  const a = U.newRun({ runtime: 'claude', model: 'claude-sonnet-4-5', inputTokens: 10, outputTokens: 5 });
  U.usageLedger([a]);
  let st = U.usageLedger.stats;
  assert.equal(st.calls, 1); assert.equal(st.runs, 1); assert.equal(st.entries, 1);
  assert.equal(st.synthesized, 1, 'a run without a persisted ledger is served by the flat fallback');
  assert.ok(typeof st.lastMs === 'number' && st.lastMs >= 0);
  const b = { ...a, id: 'r_other', ledger: [{ runtime: 'claude', provider: 'api', model: 'claude-sonnet-4-5', inputTokens: 3, outputTokens: 1, costUsd: 0.01, costSource: 'reported', billed: 0.01 }] };
  U.usageLedger([a, b]);
  st = U.usageLedger.stats;
  assert.equal(st.calls, 2); assert.equal(st.runs, 3); assert.equal(st.entries, 3, 'entries accumulate like the other counters');
  assert.equal(st.synthesized, 2, 'the flat straggler synthesizes again; the persisted-ledger run does not count');
});

// ---- account-keyed rows (t_f514cc2e): firstParty==subscription for claude, legacy runtime-less
// runs attribute to claude, one cost definition (apiEq vs billed) ----

const entryOf = (over = {}) => ({ runtime: 'claude', provider: 'subscription', model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheCreationTokens: null, costUsd: 0.02, costSource: 'reported', billed: 0, ...over });
const runOf = (over = {}) => ({ kind: 'agent', billingSource: 'subscription', model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 2, reportedCostUsd: 0.02, ledger: [entryOf()], ...over });
const approx = (a, b) => Math.abs(a - b) < 1e-9;

test('subscription-billed claude runs key one account: the CLI label firstParty collapses to subscription', () => {
  const r = U.newRun({ runtime: 'claude' });
  U.applyEvent(r, { type: 'system', subtype: 'init', model: 'claude-opus-5-5', apiKeySource: 'none' });
  U.applyEvent(r, { type: 'result', total_cost_usd: 0.2, modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, costUSD: 0.2, provider: 'firstParty', canonicalModel: 'claude-opus-5-5' } } });
  const x = U.finishRun(r, { code: 0, env: {} });
  assert.equal(x.billingSource, 'subscription');
  assert.deepEqual(x.ledger.map((e) => [e.runtime, e.provider, e.model, e.billed]), [['claude', 'subscription', 'claude-opus-5-5', 0]]);
});

test('the three observed claude-subscription row shapes collapse into one account row', () => {
  // t_4e6295b9 live shapes: modelUsage label, channel fallback, legacy preflight without a runtime stamp
  const runs = [
    runOf({ ledger: [entryOf({ provider: 'firstParty', costUsd: 0.2 })], reportedCostUsd: 0.2 }),
    runOf({ ledger: [entryOf({ provider: 'subscription', costUsd: 0.1 })], reportedCostUsd: 0.1 }),
    { ...runOf({ runtime: 'unknown' }), kind: 'preflight', ledger: [entryOf({ runtime: 'unknown', provider: 'firstParty', costUsd: 0.02 })] },
  ];
  const l = U.usageLedger(runs);
  assert.equal(l.rows.length, 1);
  assert.deepEqual([l.rows[0].runtime, l.rows[0].provider, l.rows[0].model], ['claude', 'subscription', 'claude-opus-5-5']);
  assert.equal(l.rows[0].runs, 3);
  assert.ok(approx(l.rows[0].apiEq, 0.32), 'API-equivalent value still reported per row: ' + l.rows[0].apiEq);
  assert.equal(l.rows[0].billed, 0); // covered by the plan: a KNOWN $0, not a missing $
  assert.ok(approx(l.costUsd, 0.32) && approx(l.apiEq, 0.32));
  assert.equal(l.billed, 0);
});

test('legacy runtime-less runs with a non-claude model stay an explicit unattributed row', () => {
  const other = { kind: 'agent', runtime: 'unknown', billingSource: 'unknown', model: 'mistral-large', inputTokens: 10, outputTokens: 2,
    ledger: [{ runtime: 'unknown', provider: 'zai', model: 'mistral-large', inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, costSource: 'unknown' }] };
  const l = U.usageLedger([runOf(), other]);
  assert.deepEqual(l.rows.map((x) => [x.runtime, x.provider, x.model]), [['claude', 'subscription', 'claude-opus-5-5'], ['unknown', 'zai', 'mistral-large']]);
  assert.equal(l.rows[1].apiEq, null);
  assert.equal(l.rows[1].billed, null); // unpriced non-subscription $: unknown, not 0
});

test('API-key claude runs keep their firstParty account — never merged into the subscription row', () => {
  const api = { kind: 'agent', runtime: 'claude', billingSource: 'api', model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 2, reportedCostUsd: 0.5,
    ledger: [entryOf({ provider: 'firstParty', costUsd: 0.5, billed: 0.5 })] };
  const l = U.usageLedger([runOf({ ledger: [entryOf({ costUsd: 0.2 })], reportedCostUsd: 0.2 }), api]);
  assert.deepEqual(l.rows.map((x) => [x.provider, x.runs, x.apiEq, x.billed]), [['firstParty', 1, 0.5, 0.5], ['subscription', 1, 0.2, 0]]);
  assert.ok(approx(l.apiEq, 0.7) && approx(l.costUsd, 0.7));
  assert.ok(approx(l.billed, 0.5));
});

test('totals are the raw sums of the per-row fields (round once, at display)', () => {
  const mk = (model) => ({ kind: 'agent', runtime: 'claude', billingSource: 'api', model, inputTokens: 10, outputTokens: 1,
    ledger: [{ runtime: 'claude', provider: 'firstParty', model, inputTokens: 10, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null, costUsd: 0.00345, costSource: 'reported', billed: 0.00345 }] });
  const l = U.usageLedger([mk('claude-haiku-4-5'), mk('claude-sonnet-5')]);
  assert.ok(l.rows.every((r) => r.apiEq === 0.00345 && r.billed === 0.00345), 'per-row values stay unrounded');
  assert.ok(approx(l.apiEq, 0.0069), 'totals are raw sums: ' + l.apiEq);
  assert.ok(Math.abs(l.apiEq - 0.007) > 1e-4, 'not the sum of per-row 4-decimal roundings');
  assert.equal(l.billed, l.apiEq);
});

test('totals equal the sum of the rows (the header invariant), billed and apiEq alike', () => {
  const hc = { kind: 'agent', runtime: 'helpycode', billingSource: 'unknown', model: 'glm-5.3-flash', inputTokens: 100, outputTokens: 20,
    ledger: [{ runtime: 'helpycode', provider: 'elice/z-ai', model: 'glm-5.3-flash', inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheCreationTokens: null, costUsd: 0.2710154, costSource: 'estimated', billed: 0.2710154 }] };
  const l = U.usageLedger([runOf({ ledger: [entryOf({ costUsd: 0.2 })], reportedCostUsd: 0.2 }), hc]);
  assert.equal(l.costUsd, l.rows.reduce((a, r) => a + (r.costUsd || 0), 0));
  assert.equal(l.apiEq, l.rows.reduce((a, r) => a + (r.apiEq || 0), 0));
  assert.equal(l.billed, l.rows.reduce((a, r) => a + (r.billed || 0), 0));
  assert.ok(approx(l.billed, 0.2710154)); // only the per-token-billed account contributes
});
