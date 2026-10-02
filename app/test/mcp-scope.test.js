const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { mktemp } = require('./harness/tmp');

function setup() {
  const s = new Store(mktemp('squad-'));
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const qa = s.addNode({ name: 'QA', role: 'QA' });
  s.addEdge(pm.id, dev.id);
  return { s, pm, dev, qa };
}

test('create_task allowed along outgoing edge and to self', () => {
  const { s, pm, dev } = setup();
  const t = makeTools(s, pm.id);
  assert.equal(t.create_task({ title: 'x', assignee: dev.id }).assignee, dev.id);
  assert.equal(t.create_task({ title: 'y', assignee: 'Dev' }).assignee, dev.id); // by name
  assert.equal(t.create_task({ title: 'z' }).assignee, pm.id); // self
});

test('create_task rejected without edge (reverse or unrelated)', () => {
  const { s, pm, dev, qa } = setup();
  assert.throws(() => makeTools(s, dev.id).create_task({ title: 'x', assignee: pm.id }), /scope violation/);
  assert.throws(() => makeTools(s, pm.id).create_task({ title: 'x', assignee: qa.id }), /scope violation/);
  assert.throws(() => makeTools(s, pm.id).create_task({ title: 'x', assignee: 'nobody' }), /unknown assignee/);
  assert.equal(s.listTasks().length, 0);
});

test('status/comment/visibility scope', () => {
  const { s, pm, dev, qa } = setup();
  const t = makeTools(s, pm.id).create_task({ title: 'x', assignee: dev.id });
  makeTools(s, dev.id).update_task_status({ taskId: t.id, status: 'done' });
  assert.throws(() => makeTools(s, qa.id).update_task_status({ taskId: t.id, status: 'todo' }), /scope/);
  assert.throws(() => makeTools(s, qa.id).comment_task({ taskId: t.id, text: 'hi' }), /scope/);
  assert.equal(makeTools(s, qa.id).list_tasks().length, 0);
  assert.equal(makeTools(s, pm.id).list_tasks().length, 0); // done tasks excluded by default
  assert.equal(makeTools(s, pm.id).list_tasks({ includeDone: true }).length, 1);
  const team = makeTools(s, pm.id).list_team();
  assert.deepEqual(team.canAssignTo.map((n) => n.name), ['Dev']);
  assert.throws(() => makeTools(s, 'ghost').list_tasks(), /unknown caller/);
});

test('real stdio MCP server enforces scope', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const { s, pm, dev } = setup();
  // AGENTS_SQUAD_DEV=1 is what the app exports to its children in dev mode; without it the server
  // runs as a packaged build would (no restart tools — the t_2e729984 gate).
  const connect = async (node, env = { ...process.env, AGENTS_SQUAD_DEV: '1' }) => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../src/mcp-server.js'), '--project', s.dir, '--node', node], env }));
    return c;
  };
  const cd = await connect(dev.id);
  const cp = await connect(pm.id);
  try {
    const names = (await cd.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['ask_human', 'comment_task', 'create_task', 'list_tasks', 'list_team', 'read_messages', 'read_wiki', 'reassign_task', 'request_self_update', 'schedule_restart', 'send_message', 'update_task_status', 'write_wiki']);
    const bad = await cd.callTool({ name: 'create_task', arguments: { title: 'x', assignee: pm.id } });
    assert.equal(bad.isError, true);
    const ok = await cp.callTool({ name: 'create_task', arguments: { title: 'x', assignee: dev.id } });
    assert.ok(!ok.isError);
    assert.equal(s.listTasks({ assignee: dev.id }).length, 1);
  } finally { await cd.close(); await cp.close(); }
  // Packaged build: the restart tools are not even registered (never listed to any agent).
  // NODE_PATH (when the suite runs against an out-of-tree node_modules) is kept: only the dev
  // marker must be absent, not the module resolution.
  const cn = await connect(pm.id, { ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), PATH: process.env.PATH || '' });
  try {
    const names = (await cn.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('schedule_restart') && !names.includes('request_self_update'), 'packaged build: restart tools are not advertised');
  } finally { await cn.close(); }
});

test('reassign_task: PM-only, needs assign edge, refuses non-todo, keeps comments', () => {
  const { s, pm, dev, qa } = setup();
  s.addEdge(pm.id, qa.id);
  const t = makeTools(s, pm.id);
  const tk = t.create_task({ title: 'x', assignee: dev.id });
  assert.equal(t.reassign_task({ taskId: tk.id, assignee: 'QA' }).assignee, qa.id);
  assert.match(s.getTask(tk.id).comments.at(-1).text, /Reassigned from Dev to QA/);
  assert.throws(() => makeTools(s, dev.id).reassign_task({ taskId: tk.id, assignee: dev.id }), /PM-only/);
  const lone = s.addNode({ name: 'Lone', role: 'Dev' });
  assert.throws(() => t.reassign_task({ taskId: tk.id, assignee: lone.id }), /no assign edge/);
  s.updateTask(tk.id, { status: 'in_progress' });
  assert.throws(() => t.reassign_task({ taskId: tk.id, assignee: dev.id }), /only todo/);
});

test('list_tasks sorts by assignee then priority; read_messages defaults to unread + limit', () => {
  const { s, pm, dev } = setup();
  const t = makeTools(s, pm.id);
  t.create_task({ title: 'low', assignee: dev.id, priority: 'P3' });
  t.create_task({ title: 'urgent', assignee: dev.id, priority: 'P0' });
  assert.deepEqual(t.list_tasks().map((x) => x.title), ['urgent', 'low']);
  for (let i = 0; i < 3; i++) s.sendMessage({ from: pm.id, to: dev.id, text: 'm' + i });
  const d = makeTools(s, dev.id);
  assert.deepEqual(d.read_messages({ limit: 2 }).map((m) => m.text), ['m1', 'm2']);
  assert.equal(d.read_messages().length, 1); // m0 still unread; m1, m2 were marked read
  assert.equal(d.read_messages().length, 0);
  assert.equal(d.read_messages({ unreadOnly: false }).length, 3);
});
