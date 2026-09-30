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
  await new Promise((res) => { o.once('done', res); o.once('idle', res); o.start(); }); // drain idles now (t_b2273507)
  const snap = o.snapshot();
  assert.strictEqual(snap.agents[x.id].runtime, 'codex'); assert.strictEqual(snap.agents[x.id].model, 'gpt-5.6-terra');
  assert.strictEqual(snap.agents[x.id].cost, 0);
  assert.equal(snap.agents[x.id].inputTokens, undefined); // flat per-agent token sums are no longer offered (t_3318ff63)
  const codexRow = (snap.ledger.rows || []).find((r) => r.runtime === 'codex');
  assert.ok(codexRow && codexRow.inputTokens >= 100, 'codex tokens land in the per-key ledger: ' + JSON.stringify(snap.ledger && snap.ledger.rows));
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
  await new Promise((res) => { o.once('done', res); o.once('idle', res); o.start(); }); // drain idles now (t_b2273507)
  assert.notStrictEqual(s.getTask(t.id).status, 'done');
  assert.strictEqual(s.listRuns().filter((r) => r.nodeId === n.id && r.reportedCostUsd).length, 0);
  assert.ok(logs.some((e) => e.kind === 'error' && e.text.includes('unknown runtime "codx"')));
});

// t_9d30cabe regression: real helpycode `run --format json` streams step_start/text/tool_use/step_finish
// events (captured live from helpycode 0.3.5) — the generic parser used to drop all of them, so a
// helpycode run looked hung between start and finish. The fake CLI replays that real stream and answers
// --help/--version like the real binary so the introspector derives a usable profile (probe included).
test('helpycode runs stream live text/tool/token logs, not just start+finish', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hc-'));
  const sh = (n, body) => { const f = path.join(d, n); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
  const ev = (o) => `echo '${JSON.stringify(o).replace(/'/g, `'\\''`)}'`;
  const events = [
    { type: 'step_start', sessionID: 'S-hc', part: { type: 'step-start' } },
    { type: 'text', sessionID: 'S-hc', part: { type: 'text', text: 'working...' } },
    { type: 'tool_use', sessionID: 'S-hc', part: { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'probe-tvok', metadata: { exit: 0 } } } },
    { type: 'step_finish', sessionID: 'S-hc', part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50 } }, cost: 0 } },
    { type: 'text', sessionID: 'S-hc', part: { type: 'text', text: 'done via helpycode' } },
    { type: 'step_finish', sessionID: 'S-hc', part: { type: 'step-finish', reason: 'stop', tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0 } }, cost: 0.0003 } },
  ];
  const fixtures = path.join(__dirname, 'fixtures');
  const helpy = sh('helpycode.sh', `
if [ "$1" = "--version" ]; then echo 'helpycode 0.3.5'; exit 0; fi
if [ "$1" = "--help" ] || [ "$2" = "--help" ]; then
  if [ "$1" = "run" ]; then cat '${fixtures}/help-helpycode-real-run.txt'; else cat '${fixtures}/help-helpycode-real-top.txt'; fi
  exit 0
fi
if [ "$1" = "run" ]; then
${events.map(ev).join('\n')}
  exit 0
fi
exit 1
`);
  const claude = sh('claude.sh', `echo '{"type":"result","subtype":"success","session_id":"s","total_cost_usd":0,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}'\n`);
  const pm = new ProjectManager(path.join(d, 'root')); const pid = pm.list()[0].id; const s = pm.store(pid);
  s.saveSettings({ claudePath: claude, helpycodePath: helpy, maxConcurrency: 4, maxRuns: 20, billingMode: 'api' });
  const h = s.addNode({ name: 'Hy', role: 'Dev', runtime: 'helpycode', billingMode: 'api' });
  s.createTask({ title: 'helpycode task', assignee: h.id });
  const o = new Orchestrator(s); const logs = [];
  o.on('log', (e) => logs.push(e));
  await new Promise((res) => { o.once('done', res); o.once('idle', res); o.start(); }); // drain idles now (t_b2273507)
  const finishIdx = logs.findIndex((e) => e.kind === 'system' && e.text.includes('finished'));
  const liveKinds = logs.slice(0, finishIdx).map((e) => e.kind);
  assert.ok(liveKinds.includes('text'), 'text streamed live: ' + JSON.stringify(logs));
  assert.ok(liveKinds.includes('tool_result'), 'tool result streamed live: ' + JSON.stringify(logs));
  assert.ok(logs.some((e) => e.kind === 'text' && e.text === 'done via helpycode'));
  assert.ok(logs.some((e) => e.kind === 'system' && /HelpyCode step: 100 in \/ 25 out/.test(e.text)), 'intermediate step logged as a step: ' + JSON.stringify(logs));
  assert.ok(logs.some((e) => e.kind === 'result' && /HelpyCode result: 10 in \/ 2 out/.test(e.text)));
  const a = o.snapshot().agents[h.id];
  assert.ok(Math.abs(a.cost - 0.0003) < 1e-9, 'reported step cost lands on the agent ledger: ' + a.cost);
  const run = s.listRuns().find((r) => r.nodeId === h.id && r.reportedCostUsd);
  assert.ok(run && Math.abs(run.reportedCostUsd - 0.0003) < 1e-9);
  assert.strictEqual(run.inputTokens, 110); assert.strictEqual(run.outputTokens, 27); // per-step usage summed once (record() at run end)
  assert.strictEqual(run.sessionId, 'S-hc');
  const hcRow = (o.snapshot().ledger.rows || []).find((r) => r.runtime === 'helpycode');
  assert.ok(hcRow && hcRow.inputTokens === 110 && hcRow.costUsd > 0, 'helpycode usage lands in the per-key ledger: ' + JSON.stringify(o.snapshot().ledger.rows));
});
