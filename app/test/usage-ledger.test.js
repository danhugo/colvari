const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const U = require('../src/usage');
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
  assert.deepEqual(l.rows[0], { runtime: 'claude', provider: 'firstParty', model: 'claude-sonnet-4-5', key: 'claude¦firstParty¦claude-sonnet-4-5', runs: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 4, costUsd: 0.12, costSource: 'reported', costPartial: false });
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
  assert.equal(l.rows[0].costSource, 'estimated');
  assert.ok(l.rows[0].costUsd > 0);
});

test('modelUsage result builds one ledger entry per provider/model', () => {
  const r = U.newRun({ runtime: 'claude', billingSource: 'api' });
  U.applyEvent(r, { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5-20250929', apiKeySource: 'ANTHROPIC_API_KEY' });
  U.applyEvent(r, { type: 'result', total_cost_usd: 0.2, modelUsage: {
    'claude-sonnet-4-5-20250929': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, costUSD: 0.2, provider: 'firstParty', canonicalModel: 'claude-sonnet-4-5' },
    'claude-haiku-4-5-20251001': { inputTokens: 50, outputTokens: 10, provider: 'firstParty', canonicalModel: 'claude-haiku-4-5' },
  }, usage: { input_tokens: 150, output_tokens: 30 }, num_turns: 1 });
  const x = U.finishRun(r, { code: 0, env: { ANTHROPIC_API_KEY: 'x' }, billingMode: 'api' });
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
