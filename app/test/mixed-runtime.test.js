const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

const setup = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mix-'));
  const sh = (n, body) => { const f = path.join(d, n); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
  const claude = sh('claude.sh', `echo '{"type":"result","subtype":"success","session_id":"s","total_cost_usd":0.25,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":5}}'\n`);
  const codex = sh('codex.sh', `echo '{"type":"thread.started","thread_id":"T1"}'\necho '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'\necho '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":7}}'\n`);
  const pm = new ProjectManager(path.join(d, 'root')); const pid = pm.list()[0].id; const s = pm.store(pid);
  s.saveSettings({ claudePath: claude, codexPath: codex, maxConcurrency: 4, maxRuns: 20, billingMode: 'api' });
  return s;
};

test('mixed claude+codex team: codex runs report tokens but never add to billedCost', async () => {
  const s = setup();
  const c = s.addNode({ name: 'Cl', role: 'Dev', runtime: 'claude', billingMode: 'api' });
  const x = s.addNode({ name: 'Cx', role: 'Dev', runtime: 'codex', model: 'gpt-5.6-terra', billingMode: 'api' });
  s.createTask({ title: 'claude task', assignee: c.id }); s.createTask({ title: 'codex task', assignee: x.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.once('done', res); o.start(); });
  const snap = o.snapshot();
  assert.strictEqual(snap.agents[x.id].runtime, 'codex'); assert.strictEqual(snap.agents[x.id].model, 'gpt-5.6-terra');
  assert.strictEqual(snap.agents[x.id].cost, 0); assert.ok(snap.agents[x.id].inputTokens >= 100);
  const codexRuns = s.listRuns().filter((r) => r.nodeId === x.id);
  assert.ok(codexRuns.length && codexRuns.every((r) => !r.reportedCostUsd));
  assert.ok(Math.abs(snap.billedCost + snap.subCost - 0.25) < 1e-9, 'only the claude run is costed: ' + JSON.stringify(snap));
});

test('unknown runtime errors the run instead of falling back to claude', async () => {
  const s = setup();
  const n = s.addNode({ name: 'Typo', role: 'Dev', runtime: 'codx' });
  const t = s.createTask({ title: 'typo task', assignee: n.id });
  const o = new Orchestrator(s); const logs = [];
  o.on('log', (e) => logs.push(e));
  await new Promise((res) => { o.once('done', res); o.start(); });
  assert.notStrictEqual(s.getTask(t.id).status, 'done');
  assert.strictEqual(s.listRuns().filter((r) => r.nodeId === n.id && r.reportedCostUsd).length, 0);
  assert.ok(logs.some((e) => e.kind === 'error' && e.text.includes('unknown runtime "codx"')));
});

// t_9d30cabe regression: real helpycode `run --format json` streams step_start/text/tool_use/step_finish
// events (captured live from helpycode 0.3.5) — the parser used to drop all of them, so a helpycode run
// looked hung between start and finish. The fake CLI below replays that real stream.
test('helpycode runs stream live text/tool/token logs, not just start+finish', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hc-'));
  const sh = (n, body) => { const f = path.join(d, n); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
  const ev = (o) => `echo '${JSON.stringify(o).replace(/'/g, `'\\''`)}'`;
  const helpy = sh('helpycode.sh', [
    ev({ type: 'step_start', sessionID: 'S-hc', part: { type: 'step-start' } }),
    ev({ type: 'text', sessionID: 'S-hc', part: { type: 'text', text: 'working...' } }),
    ev({ type: 'tool_use', sessionID: 'S-hc', part: { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'probe-tvok', metadata: { exit: 0 } } } }),
    ev({ type: 'step_finish', sessionID: 'S-hc', part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50 } }, cost: 0 } }),
    ev({ type: 'text', sessionID: 'S-hc', part: { type: 'text', text: 'done via helpycode' } }),
    ev({ type: 'step_finish', sessionID: 'S-hc', part: { type: 'step-finish', reason: 'stop', tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0 } }, cost: 0.0003 } }),
  ].join('\n') + '\n');
  const claude = sh('claude.sh', `echo '{"type":"result","subtype":"success","session_id":"s","total_cost_usd":0,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}'\n`);
  const pm = new ProjectManager(path.join(d, 'root')); const pid = pm.list()[0].id; const s = pm.store(pid);
  s.saveSettings({ claudePath: claude, helpycodePath: helpy, maxConcurrency: 4, maxRuns: 20, billingMode: 'api' });
  const h = s.addNode({ name: 'Hy', role: 'Dev', runtime: 'helpycode', billingMode: 'api' });
  s.createTask({ title: 'helpycode task', assignee: h.id });
  const o = new Orchestrator(s); const logs = [];
  o.on('log', (e) => logs.push(e));
  await new Promise((res) => { o.once('done', res); o.start(); });
  const finishIdx = logs.findIndex((e) => e.kind === 'system' && e.text.includes('finished'));
  const liveKinds = logs.slice(0, finishIdx).map((e) => e.kind);
  assert.ok(liveKinds.includes('text'), 'text streamed live: ' + JSON.stringify(logs));
  assert.ok(liveKinds.includes('tool_result'), 'tool result streamed live: ' + JSON.stringify(logs));
  assert.ok(logs.some((e) => e.kind === 'text' && e.text === 'done via helpycode'));
  assert.ok(logs.some((e) => e.kind === 'result' && /helpycode step: 10 in \/ 2 out/.test(e.text)));
  const a = o.snapshot().agents[h.id];
  assert.strictEqual(a.inputTokens, 110); assert.strictEqual(a.outputTokens, 27); // per-step usage summed once (record() at run end)
  assert.ok(Math.abs(a.cost - 0.0003) < 1e-9, 'reported step cost lands on the agent ledger: ' + a.cost);
  const run = s.listRuns().find((r) => r.nodeId === h.id && r.reportedCostUsd);
  assert.ok(run && Math.abs(run.reportedCostUsd - 0.0003) < 1e-9);
  assert.strictEqual(run.sessionId, 'S-hc');
});
