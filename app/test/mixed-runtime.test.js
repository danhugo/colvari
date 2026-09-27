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
