const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

// Fake bins log their argv so we can prove which vendor CLI (and model) ran each task.
const fakeClaude = (log) => `#!/bin/sh\necho "@@@claude $*" >> ${log}\necho '{"type":"result","subtype":"success","session_id":"cs","total_cost_usd":0.01,"num_turns":1,"usage":{"input_tokens":5,"output_tokens":2}}'\n`;
const fakeCodex = (log) => `#!/bin/sh\necho "@@@codex $*" >> ${log}\necho '{"type":"thread.started","thread_id":"T1"}'\necho '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"added hello.txt"}}'\necho '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7,"reasoning_output_tokens":3}}'\n`;

test('mixed vendors: Claude/Opus PM -> Codex Dev -> Claude/Haiku Reviewer complete a chain through the board', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mix-')); const log = path.join(d, 'argv.log');
  const cl = path.join(d, 'claude.sh'); const cx = path.join(d, 'codex.sh');
  fs.writeFileSync(cl, fakeClaude(log)); fs.writeFileSync(cx, fakeCodex(log)); fs.chmodSync(cl, 0o755); fs.chmodSync(cx, 0o755);
  const pm = new ProjectManager(path.join(d, 'root')); const pid = pm.list()[0].id; const s = pm.store(pid);
  s.saveSettings({ claudePath: cl, codexPath: cx, maxRuns: 10 });
  const P = s.addNode({ name: 'Pia', role: 'PM', runtime: 'claude', model: 'opus' });
  const D = s.addNode({ name: 'Cody', role: 'Dev', runtime: 'codex', model: 'gpt-5.6-terra' });
  const R = s.addNode({ name: 'Rex', role: 'Reviewer', runtime: 'claude', model: 'haiku' });
  const R2 = s.addNode({ name: 'Rex2', role: 'Reviewer', runtime: 'claude', model: 'haiku' });
  s.addEdge(P.id, R.id, 'review'); // plan's hand-off is verified by the reviewer (t_699b67b7: no auto-done)
  s.addEdge(D.id, R.id, 'review'); // impl's hand-off is verified by the reviewer
  s.addEdge(R.id, R2.id, 'review'); // Rex's own review task needs a reviewer too (no self edges)
  const plan = s.createTask({ title: 'plan', assignee: P.id });
  const impl = s.createTask({ title: 'impl', assignee: D.id, blockedBy: [plan.id] });
  const rev = s.createTask({ title: 'review', assignee: R.id, blockedBy: [impl.id] });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.once('done', res); o.start(); });
  assert.deepStrictEqual([plan, impl, rev].map((t) => s.getTask(t.id).status), ['done', 'done', 'done']);
  const lines = fs.readFileSync(log, 'utf8').split('@@@').filter(Boolean);
  // plan, Rex's pickup of plan, impl, Rex's pickup of impl, Rex's review task, Rex2's pickup of that.
  assert.deepStrictEqual(lines.map((l) => l.split(' ')[0]), ['claude', 'claude', 'codex', 'claude', 'claude', 'claude'], 'vendors ran in dependency order');
  assert.match(lines[0], /--model opus/); assert.match(lines[1], /--model haiku/); assert.match(lines[3], /--model haiku/);
  assert.match(lines[2], /^codex exec --json .*-m gpt-5\.6-terra/);
  const runs = s.listRuns().filter((r) => r.kind === 'agent');
  const byAgent = (t, n) => runs.find((r) => r.taskId === t.id && r.nodeId === n.id); // the assignee's run, not a reviewer pickup
  assert.deepStrictEqual([[plan, P], [impl, D], [rev, R]].map(([t, n]) => byAgent(t, n).runtime), ['claude', 'codex', 'claude']);
  assert.strictEqual(byAgent(impl, D).inputTokens, 100); assert.strictEqual(byAgent(impl, D).outputTokens, 10);
  assert.strictEqual(byAgent(impl, D).sessionId, 'T1');
});
