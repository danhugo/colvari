const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { ProjectManager } = require('../src/projects');
const { Orchestrator, buildPrompt } = require('../src/orchestrator');
const AC = require('../src/agent-config');

const tmp = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-perm-')));

test('splitArgs, toList, toEnv', async () => {
  assert.deepEqual(AC.splitArgs(`--foo bar "a b" 'c d' e\\ f ""`), ['--foo', 'bar', 'a b', 'c d', 'e f', '']);
  assert.deepEqual(AC.splitArgs('  '), []);
  assert.throws(() => AC.splitArgs('"open'), /unbalanced/);
  assert.deepEqual(AC.toList('Read, Bash(git log:*)\nEdit'), ['Read', 'Bash(git log:*)', 'Edit']);
  assert.deepEqual(AC.toEnv('A=1\n bad line\nB_2 = x=y\n1X=no'), { A: '1', B_2: 'x=y' });
  assert.equal(AC.envToText({ A: '1', B: '2' }), 'A=1\nB=2');
});

test('buildClaudeArgs maps per-agent settings to claude flags', async () => {
  const mcp = { mcpServers: {} };
  const base = AC.buildClaudeArgs({ name: 'x' }, 'P', { permissionMode: 'acceptEdits' }, mcp);
  assert.deepEqual(base.slice(0, 2), ['-p', 'P']);
  assert.equal(base[base.indexOf('--permission-mode') + 1], 'acceptEdits'); // project default
  assert.ok(!base.includes('--allowedTools') && !base.includes('--max-turns'));
  const a = AC.buildClaudeArgs({ permissionMode: 'plan', model: 'haiku', allowedTools: 'Read, Bash(git log:*)', disallowedTools: ['WebFetch'], maxTurns: '7',
    appendSystemPrompt: 'be brief', addDirs: '/tmp/a\n/tmp/b', extraArgs: '--foo "x y"' }, 'P', { permissionMode: 'acceptEdits' }, mcp);
  const v = (f) => a[a.indexOf(f) + 1];
  assert.equal(v('--permission-mode'), 'plan');
  assert.equal(v('--model'), 'haiku');
  assert.equal(v('--allowedTools'), 'Read,Bash(git log:*),mcp__board');
  assert.equal(v('--disallowedTools'), 'WebFetch');
  assert.equal(v('--max-turns'), '7');
  assert.equal(v('--append-system-prompt'), 'be brief');
  assert.deepEqual(a.filter((_, i) => a[i - 1] === '--add-dir'), ['/tmp/a', '/tmp/b']);
  assert.deepEqual(a.slice(-2), ['--foo', 'x y']);
  assert.throws(() => AC.buildClaudeArgs({ permissionMode: 'nope' }, 'P', {}, mcp), /permission mode/);
});

test('free-form roles and per-project role presets', async () => {
  const s = tmp();
  s.savePreset({ name: 'Architect', systemPrompt: 'Design first.', allowedTools: 'Read,Grep', permissionMode: 'plan' });
  assert.throws(() => s.savePreset({ name: '' }), /name/);
  assert.throws(() => s.saveSettings({ rolePresets: [{ name: 'A' }, { name: 'a' }] }), /duplicate/);
  const n = s.addNode({ name: 'Ann', role: 'architect' });
  assert.equal(n.systemPrompt, 'Design first.'); assert.deepEqual(n.allowedTools, ['Read', 'Grep']); assert.equal(n.permissionMode, 'plan');
  const m = s.addNode({ name: 'Bo', role: 'Architect', systemPrompt: 'mine' });
  assert.equal(m.systemPrompt, 'mine');
  const c = s.addNode({ name: 'Cy', role: 'Growth hacker' });
  assert.equal(c.role, 'Growth hacker'); assert.equal(c.systemPrompt, '');
  const upd = s.updateNode(c.id, { env: 'FOO=bar', maxTurns: '5', disabledBoardTools: ['write_wiki', 'bogus'] });
  assert.deepEqual(upd.env, { FOO: 'bar' }); assert.equal(upd.maxTurns, 5); assert.deepEqual(upd.disabledBoardTools, ['write_wiki']);
  assert.ok(AC.roleSuggestions(s.getSettings().rolePresets, s.getTeam().nodes).includes('Growth hacker'));
  // presets are per project
  assert.equal(tmp().getSettings().rolePresets.length, 0);
  s.deletePreset('Architect'); assert.equal(s.getSettings().rolePresets.length, 0);
});

function team() {
  const s = tmp();
  const pm = s.addNode({ name: 'PM', role: 'PM' }); const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); const qa = s.addNode({ name: 'QA', role: 'QA' });
  s.addEdge(pm.id, dev.id, 'assign'); s.addEdge(dev.id, qa.id, 'message'); s.addEdge(dev.id, rev.id, 'review');
  return { s, pm, dev, rev, qa };
}

test('edge types: assign vs message vs review', async () => {
  const { s, pm, dev, rev, qa } = team();
  assert.throws(() => s.addEdge(pm.id, qa.id, 'weird'), /edge type/);
  assert.equal(s.getTeam().edges.length, 3);
  // message edge does not allow create_task
  assert.throws(() => makeTools(s, dev.id).create_task({ title: 'x', assignee: qa.id }), /scope violation/);
  // message edge allows send_message; reverse direction does not
  makeTools(s, dev.id).send_message({ to: 'QA', text: 'ping' });
  assert.throws(() => makeTools(s, qa.id).send_message({ to: dev.id, text: 'pong' }), /scope violation/);
  // assign edge implies messaging
  makeTools(s, pm.id).send_message({ to: dev.id, text: 'hi dev' });
  const inbox = makeTools(s, qa.id).read_messages();
  assert.deepEqual(inbox.map((m) => [m.fromName, m.text]), [['Dev', 'ping']]);
  assert.equal(makeTools(s, qa.id).read_messages({ unreadOnly: true }).length, 0);
  assert.equal(makeTools(s, dev.id).read_messages({ from: 'PM' }).length, 1);
  // review edge Dev -> Rev: Rev may move Dev's task to review/done but not back to todo
  const t = makeTools(s, pm.id).create_task({ title: 'impl', assignee: dev.id });
  assert.equal(makeTools(s, rev.id).list_tasks().length, 1);
  await assert.rejects(() => makeTools(s, rev.id).update_task_status({ taskId: t.id, status: 'todo' }), /scope/);
  assert.equal((await makeTools(s, rev.id).update_task_status({ taskId: t.id, status: 'done' })).status, 'done');
  await assert.rejects(() => makeTools(s, qa.id).update_task_status({ taskId: t.id, status: 'done' }), /scope/);
  const lt = makeTools(s, rev.id).list_team();
  assert.deepEqual(lt.reviews.map((n) => n.name), ['Dev']);
  assert.deepEqual(makeTools(s, dev.id).list_team().canMessage.map((n) => n.name), ['QA']);
  // change edge type: message -> assign now lets Dev create tasks for QA
  const e = s.getTeam().edges.find((x) => x.to === qa.id);
  s.updateEdge(e.id, { type: 'assign' });
  assert.equal(makeTools(s, dev.id).create_task({ title: 'check', assignee: qa.id }).assignee, qa.id);
  // legacy edges without type behave as assign
  const s2 = tmp(); const a = s2.addNode({ name: 'A' }); const b = s2.addNode({ name: 'B' });
  s2.saveTeam({ ...s2.getTeam(), edges: [{ id: 'e1', from: a.id, to: b.id }] });
  assert.equal(makeTools(s2, a.id).create_task({ title: 'x', assignee: b.id }).assignee, b.id);
});

test('board tools can be disabled per agent', async () => {
  const { s, pm, dev } = team();
  s.updateNode(pm.id, { disabledBoardTools: ['write_wiki', 'send_message'] });
  assert.throws(() => makeTools(s, pm.id).write_wiki({ title: 'x', content: 'y' }), /disabled/);
  assert.throws(() => makeTools(s, pm.id).send_message({ to: dev.id, text: 'y' }), /disabled/);
  makeTools(s, dev.id).write_wiki({ title: 'x', content: 'y' });
  const p = buildPrompt(s.getTeam(), s.getTeam().nodes.find((n) => n.id === pm.id), { id: 't1', title: 'T', comments: [] });
  assert.ok(!/write_wiki/.test(p) && /create_task/.test(p));
});

test('MCP server only registers enabled tools and enforces message edges', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const { s, dev, qa } = team();
  s.updateNode(qa.id, { disabledBoardTools: ['write_wiki', 'create_task'] });
  const connect = async (node) => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../src/mcp-server.js'), '--project', s.dir, '--node', node] }));
    return c;
  };
  const cq = await connect(qa.id);
  try {
    const names = (await cq.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('write_wiki') && !names.includes('create_task') && names.includes('send_message'));
    const bad = await cq.callTool({ name: 'send_message', arguments: { to: dev.id, text: 'x' } });
    assert.equal(bad.isError, true);
  } finally { await cq.close(); }
  const cd = await connect(dev.id);
  try {
    const ok = await cd.callTool({ name: 'send_message', arguments: { to: 'QA', text: 'hello' } });
    assert.ok(!ok.isError);
  } finally { await cd.close(); }
  assert.equal(s.listMessages({ to: qa.id }).length, 1);
});

test('export/import keeps per-agent settings and edge types', async () => {
  const pm = new ProjectManager(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-perm-pm-')));
  const pid = pm.list()[0].id; const tid = pm.get(pid).teams[0].id; const s = pm.store(pid, tid);
  const a = s.addNode({ name: 'A', role: 'Designer', allowedTools: 'Read', env: { X: '1' }, maxTurns: 3 });
  const b = s.addNode({ name: 'B' }); s.addEdge(a.id, b.id, 'review');
  const copy = pm.duplicateTeam(pid, tid);
  const g = pm.store(pid, copy.id).getTeam();
  const na = g.nodes.find((n) => n.name === 'A');
  assert.equal(na.role, 'Designer'); assert.deepEqual(na.allowedTools, ['Read']); assert.deepEqual(na.env, { X: '1' }); assert.equal(na.maxTurns, 3);
  assert.equal(g.edges[0].type, 'review');
});

test('orchestrator passes per-agent flags, env and cwd to claude', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-perm-orch-'));
  const out = path.join(r, 'out.json'); const work = path.join(r, 'work');
  const fake = path.join(r, 'fake-claude.js');
  fs.writeFileSync(fake, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), foo: process.env.SQUAD_FOO }));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1, usage: {} }));\n`);
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(r, 'p')); s.saveSettings({ claudePath: fake, permissionMode: 'default' });
  const n = s.addNode({ name: 'D', role: 'Dev', workdir: work, env: 'SQUAD_FOO=bar', maxTurns: 4, disallowedTools: 'Bash', extraArgs: '--x 1' });
  s.createTask({ title: 'job', assignee: n.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.on('done', res); o.start(); });
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(fs.realpathSync(got.cwd), fs.realpathSync(work));
  assert.equal(got.foo, 'bar');
  const v = (f) => got.argv[got.argv.indexOf(f) + 1];
  assert.equal(v('--permission-mode'), 'default'); assert.equal(v('--max-turns'), '4'); assert.equal(v('--disallowedTools'), 'Bash');
  assert.deepEqual(got.argv.slice(-2), ['--x', '1']);
});
