const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const U = require('../src/usage');
const { normalizeNode } = require('../src/agent-config');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

test('detectBilling from env and apiKeySource', () => {
  assert.equal(U.detectBilling({}, 'none').source, 'subscription');
  assert.equal(U.detectBilling({ ANTHROPIC_API_KEY: 'x' }, 'ANTHROPIC_API_KEY').source, 'api');
  assert.equal(U.detectBilling({ ANTHROPIC_API_KEY: 'x' }).source, 'api');
  const p = U.detectBilling({ ANTHROPIC_BASE_URL: 'http://localhost:4000/v1' }, 'ANTHROPIC_API_KEY');
  assert.equal(p.source, 'proxy'); assert.match(p.detail, /localhost:4000/);
  assert.equal(U.detectBilling({ CLAUDE_CODE_USE_BEDROCK: '1' }, 'none').source, 'bedrock');
  assert.equal(U.detectBilling({ CLAUDE_CODE_USE_VERTEX: 'true' }).source, 'vertex');
  assert.equal(U.detectBilling({ CLAUDE_CODE_USE_BEDROCK: '0' }, 'none').source, 'subscription');
  assert.equal(U.detectBilling({}).source, 'unknown');
});

test('billing modes adjust the child env and validate', () => {
  const base = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://p', PATH: '/bin' };
  const sub = U.applyBillingEnv({ billingMode: 'subscription' }, base);
  assert.deepEqual(sub.env, { PATH: '/bin' }); assert.deepEqual(sub.warnings, []);
  const api = U.applyBillingEnv({ billingMode: 'api' }, base);
  assert.equal(api.env.ANTHROPIC_API_KEY, 'k'); assert.equal(api.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(U.applyBillingEnv({ billingMode: 'api' }, {}).warnings.length, 1);
  const px = U.applyBillingEnv({ billingMode: 'proxy', billingBaseUrl: 'https://llm.example.com' }, { PATH: '/bin' });
  assert.equal(px.env.ANTHROPIC_BASE_URL, 'https://llm.example.com');
  assert.equal(U.applyBillingEnv({ billingMode: 'auto' }, base).env.ANTHROPIC_BASE_URL, 'http://p');
  assert.throws(() => normalizeNode({ billingMode: 'proxy', billingBaseUrl: 'ftp://x' }), /base URL/);
  assert.equal(normalizeNode({ billingMode: 'bogus' }).billingMode, 'auto');
  assert.equal(normalizeNode({}).billingMode, 'auto');
});

test('run record takes exact tokens and models from stream events', () => {
  const r = U.newRun({ nodeId: 'n1' });
  U.applyEvent(r, { type: 'system', subtype: 'init', model: 'claude-sonnet-5', apiKeySource: 'none', session_id: 's1' });
  U.applyEvent(r, { type: 'result', num_turns: 3, total_cost_usd: 0.05, usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 }, 'claude-haiku-4-5': { inputTokens: 5, outputTokens: 6 } } });
  assert.equal(r.inputTokens, 15); assert.equal(r.outputTokens, 26); assert.equal(r.cacheReadTokens, 300); assert.equal(r.cacheCreationTokens, 40);
  assert.deepEqual(r.models, ['claude-sonnet-5', 'claude-haiku-4-5']); assert.equal(r.model, 'claude-sonnet-5');
  assert.equal(U.totalTokens(r), 381);
  U.finishRun(r, { code: 0, env: {}, billingMode: 'subscription' });
  assert.equal(r.billingSource, 'subscription'); assert.equal(r.billingMismatch, false);
  assert.equal(U.costNote('subscription'), 'Covered by subscription — not billed per token');
  assert.equal(U.costNote('api'), 'API-equivalent (reported by Claude CLI)');
  // usage fallback when no modelUsage
  const t = U.tokensFromResult({ usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 9, cache_creation_input_tokens: 10 } });
  assert.deepEqual(t, { inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheCreationTokens: 10, models: [] });
  // mismatch: asked for subscription, ran on API key
  const m = U.finishRun(U.newRun({ apiKeySource: 'ANTHROPIC_API_KEY' }), { env: {}, billingMode: 'subscription' });
  assert.equal(m.billingSource, 'api'); assert.equal(m.billingMismatch, true);
});

test('summarize separates subscription from billed cost; CSV escapes', () => {
  const runs = [
    { ...U.newRun({ nodeId: 'a', model: 'm1', billingSource: 'subscription', inputTokens: 10, reportedCostUsd: 1 }) },
    { ...U.newRun({ nodeId: 'a', model: 'm2', billingSource: 'api', outputTokens: 5, reportedCostUsd: 0.5 }) },
    { ...U.newRun({ nodeId: 'b', task: 'say "hi", ok', billingSource: 'proxy', cacheReadTokens: 2 }) },
  ];
  const by = U.summarize(runs, 'nodeId');
  assert.equal(by.a.runs, 2); assert.equal(by.a.totalTokens, 15); assert.equal(by.a.subscriptionCostUsd, 1); assert.equal(by.a.billedCostUsd, 0.5);
  assert.equal(U.total(runs).totalTokens, 17); assert.equal(U.total([]).runs, 0);
  const csv = U.toCSV(runs).trim().split('\n');
  assert.equal(csv.length, 4); assert.equal(csv[0], U.CSV_COLS.join(','));
  assert.ok(csv[3].includes('"say ""hi"", ok"'));
  assert.ok(csv[1].includes('Covered by subscription'));
});

test('orchestrator records per-run usage history with billing source', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-usage-'));
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"s9","model":"claude-sonnet-5","apiKeySource":"none","mcp_servers":[]}'
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"session_id\\":\\"s9\\",\\"total_cost_usd\\":0.02,\\"num_turns\\":2,\\"usage\\":{\\"input_tokens\\":3,\\"output_tokens\\":4,\\"cache_read_input_tokens\\":50,\\"cache_creation_input_tokens\\":6},\\"base\\":\\"$ANTHROPIC_BASE_URL\\"}"
`);
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(r, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'Sub', role: 'Dev', billingMode: 'subscription', env: { ANTHROPIC_API_KEY: 'should-be-dropped' } });
  const b = s.addNode({ name: 'Px', role: 'Dev', billingMode: 'proxy', billingBaseUrl: 'http://127.0.0.1:4000' });
  const t1 = s.createTask({ title: 'one', assignee: a.id }); s.createTask({ title: 'two', assignee: b.id });
  const o = new Orchestrator(s);
  const snap = await new Promise((res) => { o.on('done', res); o.start(); });
  const runs = s.listRuns();
  assert.equal(runs.length, 2);
  const ra = runs.find((x) => x.nodeId === a.id); const rb = runs.find((x) => x.nodeId === b.id);
  assert.equal(ra.billingSource, 'subscription'); assert.equal(ra.model, 'claude-sonnet-5'); assert.equal(ra.task, 'one'); assert.equal(ra.taskId, t1.id);
  assert.equal(ra.inputTokens, 3); assert.equal(ra.cacheReadTokens, 50); assert.equal(ra.cacheCreationTokens, 6); assert.equal(ra.numTurns, 2);
  assert.equal(rb.billingSource, 'proxy'); assert.match(rb.billingDetail, /127\.0\.0\.1:4000/);
  assert.ok(ra.durationMs >= 0 && ra.endedAt);
  assert.equal(snap.agents[a.id].billingSource, 'subscription');
  // t_3318ff63: no cross-model token totals in the API — per-key ledger rows instead
  assert.equal(snap.agents[a.id].cacheReadTokens, undefined);
  assert.equal(snap.tokens, undefined); assert.equal(snap.runTokens, undefined);
  const rowSub = snap.ledger.rows.find((x) => x.provider === 'subscription');
  assert.equal(rowSub.inputTokens, 3); assert.equal(rowSub.cacheReadTokens, 50); assert.equal(rowSub.cacheCreationTokens, 6);
  assert.equal(rowSub.costUsd, 0.02); assert.equal(rowSub.costSource, 'reported');
  assert.ok(snap.ledger.rows.some((x) => x.provider === '127.0.0.1:4000')); // proxy host is the key's provider
  assert.ok(Math.abs(snap.totalCost - 0.04) < 1e-9);
  assert.equal(s.listRuns({ nodeId: b.id }).length, 1);
});

// Resumed runs: modelUsage and total_cost_usd are session-cumulative; usage is per call.
const R1 = { type: 'result', session_id: 'S', total_cost_usd: 0.0147, num_turns: 1, usage: { input_tokens: 10, cache_read_input_tokens: 18099 }, modelUsage: { 'claude-haiku': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 18099, cacheCreationInputTokens: 0 } } };
const R2 = { type: 'result', session_id: 'S', total_cost_usd: 0.0187, num_turns: 1, usage: { input_tokens: 10, cache_read_input_tokens: 22982 }, modelUsage: { 'claude-haiku': { inputTokens: 20, outputTokens: 12, cacheReadInputTokens: 41081, cacheCreationInputTokens: 0 } } };

test('resumed run with baseline counts only its own share', () => {
  const r1 = U.applyEvent(U.newRun(), R1);
  assert.equal(r1.cacheReadTokens, 18099);
  const r2 = U.applyEvent(U.newRun({ resumedFrom: 'S', baseline: r1.cumulative }), R2);
  assert.equal(r2.inputTokens, 10); assert.equal(r2.outputTokens, 7); assert.equal(r2.cacheReadTokens, 22982);
  assert.ok(Math.abs(r2.reportedCostUsd - 0.004) < 1e-9); assert.equal(r2.usageBasis, 'delta');
  assert.equal(r1.cacheReadTokens + r2.cacheReadTokens, 41081);
});

test('resumed run without baseline falls back to per-call usage, never the cumulative total', () => {
  const r = U.applyEvent(U.newRun({ resumedFrom: 'S' }), R2);
  assert.equal(r.inputTokens, 10); assert.equal(r.cacheReadTokens, 22982); assert.equal(r.reportedCostUsd, 0); assert.equal(r.usageBasis, 'usage-no-baseline');
  // non-cumulative numbers (shrinking) are used as-is
  const r3 = U.applyEvent(U.newRun({ resumedFrom: 'S', baseline: U.resultSnapshot(R2) }), R1);
  assert.equal(r3.cacheReadTokens, 18099); assert.equal(r3.usageBasis, 'raw');
});

test('orchestrator: goal iterations over a resumed session are not double counted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-resume-'));
  const fake = path.join(dir, 'fake-claude.js');
  // Cumulative session state on disk: each agent call adds 100 cacheRead / $0.01 to the session.
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const st = ${JSON.stringify(path.join(dir, 'state'))};
if (a.includes('--json-schema')) { const c = fs.existsSync(st + 'j') ? +fs.readFileSync(st + 'j', 'utf8') + 1 : 1; fs.writeFileSync(st + 'j', String(c));
  console.log(JSON.stringify({ type: 'result', total_cost_usd: 0, structured_output: { met: c >= 3, reason: 'c' + c } })); process.exit(0); }
const resumed = a.includes('--resume'); let n = resumed && fs.existsSync(st) ? +fs.readFileSync(st, 'utf8') : 0; n++; fs.writeFileSync(st, String(n));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S', apiKeySource: 'none', mcp_servers: [] }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'S', total_cost_usd: 0.01 * n, num_turns: 1, usage: { input_tokens: 1, cache_read_input_tokens: 100 },
  modelUsage: { m: { inputTokens: n, outputTokens: 2 * n, cacheReadInputTokens: 100 * n, cacheCreationInputTokens: 0 } } }));
`);
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(dir, 'p')); s.saveSettings({ claudePath: fake, maxRuns: 20 });
  const n = s.addNode(normalizeNode({ name: 'D', role: 'Dev', mode: 'goal', goalCondition: 'x', maxIterations: 5 }));
  s.createTask({ title: 'job', assignee: n.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  const runs = s.listRuns({ kind: 'agent' });
  assert.equal(runs.length, 3);
  for (const r of runs) { assert.equal(r.cacheReadTokens, 100); assert.equal(r.inputTokens, 1); assert.ok(Math.abs(r.reportedCostUsd - 0.01) < 1e-9); assert.equal(r.baseline, undefined); }
  assert.equal(U.total(runs).cacheReadTokens, 300);
  assert.ok(Math.abs(o.snapshot().agents[n.id].cost - 0.03) < 1e-9);
  assert.equal(new Orchestrator(s).sessionBaseline('S').perModel.m.cacheReadTokens, 300); // survives restart via stored runs
});

test('modelStats: per-model runs/cost/tokens + task outcomes attributed to a task\'s last agent run', () => {
  const runs = [
    { kind: 'agent', taskId: 't1', model: 'sonnet', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostUsd: 0.1 },
    { kind: 'agent', taskId: 't1', model: 'sonnet', inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostUsd: 0.2 },
    { kind: 'agent', taskId: 't2', model: 'haiku', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostUsd: 0.01 },
    { kind: 'preflight', taskId: null, model: 'sonnet', inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostUsd: 999 },
  ];
  const tasks = [
    { id: 't1', status: 'done', reopenCount: 1 }, // reopened once before being accepted -> not first-pass
    { id: 't2', status: 'done' }, // first try -> first-pass accepted
    { id: 't3', status: 'todo' }, // no runs recorded -> ignored
  ];
  const s = U.modelStats(runs, tasks);
  assert.equal(s.sonnet.runs, 2); assert.ok(Math.abs(s.sonnet.costUsd - 0.3) < 1e-9); assert.equal(s.sonnet.tokens, 40);
  assert.equal(s.sonnet.tasksDone, 1); assert.equal(s.sonnet.firstPassAccepted, 0); assert.equal(s.sonnet.reopened, 1);
  assert.equal(s.haiku.runs, 1); assert.equal(s.haiku.tasksDone, 1); assert.equal(s.haiku.firstPassAccepted, 1); assert.equal(s.haiku.reopened, 0);
  assert.equal(s.t3, undefined);
});

test('approveTask(false) bumps task.reopenCount, feeding modelStats.reopened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  const s = new Store(path.join(dir, 'p'));
  const n = s.addNode(normalizeNode({ name: 'D', role: 'Dev' }));
  const t = s.createTask({ title: 'x', assignee: n.id });
  s.updateTask(t.id, { status: 'review', awaitingApproval: true });
  s.approveTask(t.id, false, 'nope');
  assert.equal(s.getTask(t.id).reopenCount, 1);
  assert.equal(s.getTask(t.id).status, 'todo');
  s.updateTask(t.id, { status: 'review', awaitingApproval: true });
  s.approveTask(t.id, true);
  assert.equal(s.getTask(t.id).reopenCount, 1);
  assert.equal(s.getTask(t.id).status, 'done');
});

test('modelStats end-to-end: 3 models (mixed runtime w/ unknown cost, a reopen, a rejection), persisted and re-derived after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-modelstats-'));
  const s = new Store(path.join(dir, 'p'));
  const opus = s.addNode(normalizeNode({ name: 'PM', role: 'PM', model: 'claude-opus-4' }));
  const sonnet = s.addNode(normalizeNode({ name: 'Dev', role: 'Dev', model: 'claude-sonnet-5' }));
  const codex = s.addNode(normalizeNode({ name: 'CodexDev', role: 'Dev', runtime: 'codex' }));

  // claude-opus-4: one task, done first try.
  const tPlan = s.createTask({ title: 'plan', assignee: opus.id });
  s.addRun(U.newRun({ kind: 'agent', nodeId: opus.id, taskId: tPlan.id, model: 'claude-opus-4', inputTokens: 100, outputTokens: 50, reportedCostUsd: 0.5 }));
  s.updateTask(tPlan.id, { status: 'done' });

  // claude-sonnet-5: one task, sent back for changes once before being accepted (reopen).
  const tBuild = s.createTask({ title: 'build', assignee: sonnet.id });
  s.addRun(U.newRun({ kind: 'agent', nodeId: sonnet.id, taskId: tBuild.id, model: 'claude-sonnet-5', inputTokens: 40, outputTokens: 20, reportedCostUsd: 0.2 }));
  s.updateTask(tBuild.id, { status: 'review', awaitingApproval: true });
  s.approveTask(tBuild.id, false, 'not quite'); // reopen: back to todo, reopenCount 1
  s.addRun(U.newRun({ kind: 'agent', nodeId: sonnet.id, taskId: tBuild.id, model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 10, reportedCostUsd: 0.1 }));
  s.updateTask(tBuild.id, { status: 'review', awaitingApproval: true });
  s.approveTask(tBuild.id, true); // now done, but not first-pass (reopenCount stays 1)

  // codex (mixed runtime): reportedCostUsd unknown -> 0, task still open (rejected review, never reopened count towards done).
  const tCheck = s.createTask({ title: 'check', assignee: codex.id });
  s.addRun(U.newRun({ kind: 'agent', nodeId: codex.id, taskId: tCheck.id, model: 'gpt-5-codex', inputTokens: 30, outputTokens: 15, reportedCostUsd: 0 }));
  s.updateTask(tCheck.id, { status: 'review', awaitingApproval: true });
  s.approveTask(tCheck.id, false, 'needs work'); // rejected: reopenCount 1, back to todo (not done)

  const check = (store) => {
    const stats = new Orchestrator(store).snapshot().modelStats;
    assert.equal(stats['claude-opus-4'].runs, 1);
    assert.ok(Math.abs(stats['claude-opus-4'].costUsd - 0.5) < 1e-9);
    assert.equal(stats['claude-opus-4'].tasksDone, 1); assert.equal(stats['claude-opus-4'].firstPassAccepted, 1); assert.equal(stats['claude-opus-4'].reopened, 0);

    assert.equal(stats['claude-sonnet-5'].runs, 2);
    assert.ok(Math.abs(stats['claude-sonnet-5'].costUsd - 0.3) < 1e-9);
    assert.equal(stats['claude-sonnet-5'].tasksDone, 1); assert.equal(stats['claude-sonnet-5'].firstPassAccepted, 0); assert.equal(stats['claude-sonnet-5'].reopened, 1);

    assert.equal(stats['gpt-5-codex'].runs, 1);
    assert.equal(stats['gpt-5-codex'].costUsd, 0); // unknown/unreported cost never counted as a positive number
    assert.equal(stats['gpt-5-codex'].tasksDone, 0); assert.equal(stats['gpt-5-codex'].firstPassAccepted, 0); assert.equal(stats['gpt-5-codex'].reopened, 1);
  };
  check(s);
  check(new Store(s.dir)); // aggregates are re-derived from persisted runs/tasks, not in-memory counters -> survive a restart
});
