const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const M = require('../src/agent-modes');
const { buildClaudeArgs, normalizeNode } = require('../src/agent-config');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

test('normalizeMode defaults and clamping', () => {
  assert.deepStrictEqual(M.normalizeMode({}), { ...M.MODE_DEFAULTS });
  const m = M.normalizeMode({ mode: 'bogus', maxIterations: '999', loopCount: 0, continueSession: 'true', slashCommand: ' /review ' });
  assert.equal(m.mode, 'single'); assert.equal(m.maxIterations, 50); assert.equal(m.loopCount, 1); assert.equal(m.continueSession, true); assert.equal(m.slashCommand, '/review');
  assert.equal(normalizeNode({ mode: 'goal' }).mode, 'goal');
});

test('slash prefix and iteration prompts', () => {
  assert.equal(M.slashPrefix('review'), '/review');
  assert.equal(M.slashPrefix('/plugin:skill arg'), '/plugin:skill arg');
  assert.equal(M.slashPrefix('please use the X skill'), '/please use the X skill');
  assert.equal(M.slashPrefix(''), '');
  const wf = M.normalizeMode({ mode: 'workflow', slashCommand: 'review' });
  assert.equal(M.iterationPrompt(wf, 'BASE', 0), '/review BASE');
  const g = M.normalizeMode({ mode: 'goal', goalCondition: 'tests pass' });
  assert.equal(M.iterationPrompt(g, 'BASE', 0), 'BASE');
  assert.match(M.iterationPrompt(g, 'BASE', 1, { reason: 'red' }), /NOT met yet: tests pass[\s\S]*Checker said: red/);
  assert.match(M.iterationPrompt(M.normalizeMode({ mode: 'loop' }), 'BASE', 2), /pass 3 of 3[\s\S]*BASE/);
});

test('nextStep decisions', () => {
  const g = M.normalizeMode({ mode: 'goal', goalCondition: 'x', maxIterations: 2 });
  assert.equal(M.nextStep(g, 1, { code: 0, judge: { met: false } }).again, true);
  assert.equal(M.nextStep(g, 1, { code: 0, judge: { met: true } }).again, false);
  assert.equal(M.nextStep(g, 2, { code: 0, judge: { met: false } }).why, 'max iterations');
  assert.equal(M.nextStep(g, 1, { code: 1 }).again, false);
  assert.equal(M.nextStep(g, 1, { code: 0, stopped: true }).again, false);
  const l = M.normalizeMode({ mode: 'loop', loopCount: 3 });
  assert.equal(M.nextStep(l, 1, { code: 0, taskStatus: 'in_progress' }).again, true);
  assert.equal(M.nextStep(l, 1, { code: 0, taskStatus: 'done' }).again, true, 'loop ignores an early done by the agent');
  assert.equal(M.nextStep(g, 1, { code: 0, judge: { met: false, inconclusive: true } }).why, 'checker inconclusive');
  assert.equal(M.nextStep(l, 3, { code: 0, taskStatus: 'review' }).again, false);
  assert.equal(M.nextStep(M.normalizeMode({}), 1, { code: 0 }).again, false);
});

test('judge args and parsing', () => {
  const a = M.judgeArgs(M.normalizeMode({ mode: 'goal', goalCondition: 'file exists' }), { title: 'T' }, 'did it');
  assert.ok(a.includes('--json-schema')); assert.ok(a.includes('--no-session-persistence'));
  assert.equal(a[a.indexOf('--model') + 1], 'haiku'); assert.match(a[1], /file exists/);
  assert.deepStrictEqual(M.parseJudge('{"structured_output":{"met":true,"reason":"ok"},"total_cost_usd":0.002}'), { met: true, reason: 'ok', cost: 0.002, costKnown: true, proxyUnpriced: false });
  assert.equal(M.parseJudge('{"structured_output":{"met":true},"total_cost_usd":0}', { env: { ANTHROPIC_BASE_URL: 'http://p/v1' } }).proxyUnpriced, true); // $0 behind a proxy: unpriced, not free
  assert.equal(M.parseJudge('{"result":"{\\"met\\":false,\\"reason\\":\\"no\\"}"}').reason, 'no');
  assert.equal(M.parseJudge('garbage').met, false); assert.equal(M.parseJudge('garbage').unreadable, true);
  const fenced = M.parseJudge(JSON.stringify({ type: 'result', result: 'Here you go:\n```json\n{"met": true, "reason": "file ok"}\n```' }));
  assert.equal(fenced.met, true); assert.ok(!fenced.unreadable);
  assert.equal(M.parseJudge(JSON.stringify({ structured_output: { met: 'false', reason: 'x' } })).met, false);
  const bad = M.parseJudge(JSON.stringify({ type: 'result', result: 'I think it is done', total_cost_usd: 0.01 }));
  assert.equal(bad.unreadable, true); assert.equal(bad.cost, 0.01);
});

test('buildClaudeArgs adds --resume', () => {
  const a = buildClaudeArgs({}, 'p', { permissionMode: 'default' }, {}, { resume: 'sess-1' });
  assert.equal(a[a.indexOf('--resume') + 1], 'sess-1');
  assert.ok(!buildClaudeArgs({}, 'p', {}, {}).includes('--resume'));
});

// Fake claude: logs each invocation's args; agent runs emit a session id; judge runs report met on the 2nd check.
function setup(node) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-modes-'));
  const logf = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logf)}, JSON.stringify(a) + '\\n');
const n = fs.readFileSync(${JSON.stringify(logf)}, 'utf8').trim().split('\\n').length;
if (a.includes('--json-schema')) {
  const checks = fs.readFileSync(${JSON.stringify(logf)}, 'utf8').split('\\n').filter((l) => l.includes('--json-schema')).length;
  console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.001, structured_output: { met: checks >= 2, reason: 'check ' + checks } }));
} else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-' + n, mcp_servers: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'r' + n, session_id: 'sess-' + n, total_cost_usd: 0.01, num_turns: 1, usage: {} }));
}
`);
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(dir, 'proj'));
  s.saveSettings({ claudePath: fake, maxRuns: 20 });
  const n = s.addNode({ name: 'D', role: 'Dev', ...node });
  const calls = () => (fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const run = () => new Promise((res) => { const o = new Orchestrator(s); o.on('done', res); o.start(); });
  return { s, n, calls, run };
}

test('goal mode resumes the session until the checker says met', async () => {
  const { s, n, calls, run } = setup({ mode: 'goal', goalCondition: 'hello.txt exists', maxIterations: 5 });
  const t = s.createTask({ title: 'job', assignee: n.id });
  await run();
  const c = calls();
  assert.equal(c.filter((a) => a.includes('--json-schema')).length, 2);
  const agentRuns = c.filter((a) => !a.includes('--json-schema'));
  assert.equal(agentRuns.length, 2);
  assert.ok(!agentRuns[0].includes('--resume'));
  assert.equal(agentRuns[1][agentRuns[1].indexOf('--resume') + 1], 'sess-1');
  assert.match(agentRuns[1][1], /NOT met yet/);
  const done = s.getTask(t.id);
  // t_699b67b7: the checker's "met" ends the run, but the hand-off lands in review —
  // done requires reviewer/owner verification.
  assert.equal(done.status, 'review'); assert.equal(done.iterations, 2);
  assert.ok(done.sessions && done.sessions[`${n.id}:claude`], 'the last run stores its session under the agent+runtime key');
});

test('goal mode stops at max iterations and sends the task to review', async () => {
  const { s, n, calls, run } = setup({ mode: 'goal', goalCondition: 'never', maxIterations: 1 });
  const t = s.createTask({ title: 'job', assignee: n.id });
  await run();
  assert.equal(calls().length, 2);
  assert.equal(s.getTask(t.id).status, 'review');
});

test('loop mode repeats N times; workflow mode prefixes the slash command', async () => {
  const l = setup({ mode: 'loop', loopCount: 3 });
  l.s.createTask({ title: 'job', assignee: l.n.id });
  await l.run();
  assert.equal(l.calls().length, 3);
  const w = setup({ mode: 'workflow', slashCommand: 'review' });
  w.s.createTask({ title: 'job', assignee: w.n.id });
  await w.run();
  assert.equal(w.calls().length, 1); assert.equal(w.calls()[0][1], '/review job');
  const wa = w.calls()[0]; assert.match(wa[wa.indexOf('--append-system-prompt') + 1], /You are "D"[\s\S]*Coordinate ONLY/);
});

test('workflow $ARGUMENTS is only the task text; node append prompt is kept', async () => {
  assert.equal(M.taskText({ title: 'Fix bug', description: 'Fix bug in parser' }), 'Fix bug in parser');
  assert.equal(M.taskText({ title: 'T', description: 'details' }), 'T\n\ndetails');
  const w = setup({ mode: 'workflow', slashCommand: '/qacmd', appendSystemPrompt: 'MINE' });
  w.s.createTask({ title: 'Write cmd.txt', description: 'Write cmd.txt with CMD-RAN', assignee: w.n.id });
  await w.run();
  const a = w.calls()[0];
  assert.equal(a[1], '/qacmd Write cmd.txt with CMD-RAN');
  assert.equal(a.filter((x) => x === '--append-system-prompt').length, 1);
  assert.match(a[a.indexOf('--append-system-prompt') + 1], /Coordinate ONLY[\s\S]*MINE$/);
});

test('loop mode: only the final pass asks for done, and an early done does not stop the loop', async () => {
  const l = setup({ mode: 'loop', loopCount: 3 });
  const t = l.s.createTask({ title: 'append L', assignee: l.n.id });
  // Simulate an agent that marks the task done on every pass.
  const orig = l.s.updateTask.bind(l.s); let n = 0;
  const o = new Orchestrator(l.s);
  o.on('run', (r) => { if (r.kind === 'agent') { n++; orig(t.id, { status: 'done' }); } });
  await new Promise((res) => { o.on('done', res); o.start(); });
  const c = l.calls();
  assert.equal(c.length, 3); assert.equal(n, 3);
  assert.match(c[0][1], /Do NOT call update_task_status with status="done"/); assert.doesNotMatch(c[0][1], /status="done"\.$/m);
  assert.match(c[1][1], /pass 2 of 3/); assert.match(c[1][1], /Do NOT call update_task_status/);
  assert.match(c[2][1], /pass 3 of 3 \(the final pass\)/); assert.doesNotMatch(c[2][1], /Do NOT call/); assert.match(c[2][1], /status="done"/);
  assert.equal(l.s.getTask(t.id).status, 'done'); assert.equal(l.s.getTask(t.id).iterations, 3);
});

test('goal checker: unreadable answer is retried, then inconclusive (not fed back as not met)', async () => {
  const { s, n, calls, run } = setup({ mode: 'goal', goalCondition: 'x', maxIterations: 5 });
  const fake = s.getSettings().claudePath; const fs2 = require('fs');
  fs2.writeFileSync(fake, fs2.readFileSync(fake, 'utf8').replace("structured_output: { met: checks >= 2, reason: 'check ' + checks }", "result: 'no json here'"));
  const t = s.createTask({ title: 'job', assignee: n.id });
  const logs = []; const o = new Orchestrator(s); o.on('log', (l) => logs.push(l.text));
  await new Promise((res) => { o.on('done', res); o.start(); });
  const c = calls();
  assert.equal(c.filter((a) => a.includes('--json-schema')).length, 2, 'one retry');
  assert.equal(c.filter((a) => !a.includes('--json-schema')).length, 1, 'no extra agent iteration');
  assert.ok(logs.some((l) => /raw checker output: .*no json here/.test(l)));
  assert.equal(s.getTask(t.id).status, 'review');
  assert.ok(s.getTask(t.id).comments.some((x) => /inconclusive/.test(x.text)));
  void run;
});

test('continueSession resumes the previous task session', async () => {
  const { s, n, calls, run } = setup({ continueSession: true });
  s.createTask({ title: 'first', assignee: n.id });
  await run();
  s.createTask({ title: 'second', assignee: n.id });
  await run();
  const c = calls();
  assert.ok(!c[0].includes('--resume'));
  assert.equal(c[1][c[1].indexOf('--resume') + 1], 'sess-1');
});

test('buildPrompt keeps node id and lists outgoing teammates', () => {
  const { buildPrompt } = require('../src/orchestrator');
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-bp-')));
  const a = s.addNode({ name: 'Pam', role: 'PM' }); const b = s.addNode({ name: 'Dave', role: 'Dev' }); s.addEdge(a.id, b.id);
  const p = buildPrompt(s.getTeam(), s.getTeam().nodes[0], s.createTask({ title: 'x', assignee: a.id }));
  assert.match(p, new RegExp(`node id: ${a.id}`)); assert.match(p, /assign tasks to: Dave/);
});

test('buildPrompt worktree rule: only when the run actually got a worktree', () => {
  const { buildPrompt } = require('../src/orchestrator');
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-bp-')));
  const a = s.addNode({ name: 'Pam', role: 'Dev' });
  const t = s.createTask({ title: 'x', assignee: a.id });
  const team = s.getTeam(); const node = team.nodes.find((n) => n.id === a.id);
  const wt = buildPrompt(team, node, t, { worktree: true });
  assert.match(wt, /Write code only in your task worktree \(your cwd\)\. Never edit the main checkout; only the merge step changes it\./);
  assert.ok(!buildPrompt(team, node, t).includes('Never edit the main checkout'), 'no worktree rule for runs in the shared dir');
});
