const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');

function setup() {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-')));
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
  assert.equal(makeTools(s, pm.id).list_tasks().length, 1);
  const team = makeTools(s, pm.id).list_team();
  assert.deepEqual(team.canAssignTo.map((n) => n.name), ['Dev']);
  assert.throws(() => makeTools(s, 'ghost').list_tasks(), /unknown caller/);
});

test('real stdio MCP server enforces scope', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const { s, pm, dev } = setup();
  const connect = async (node) => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../src/mcp-server.js'), '--project', s.dir, '--node', node] }));
    return c;
  };
  const cd = await connect(dev.id);
  const names = (await cd.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['comment_task', 'create_task', 'list_tasks', 'list_team', 'read_messages', 'read_wiki', 'send_message', 'update_task_status', 'write_wiki']);
  const bad = await cd.callTool({ name: 'create_task', arguments: { title: 'x', assignee: pm.id } });
  assert.equal(bad.isError, true);
  await cd.close();
  const cp = await connect(pm.id);
  const ok = await cp.callTool({ name: 'create_task', arguments: { title: 'x', assignee: dev.id } });
  assert.ok(!ok.isError);
  assert.equal(s.listTasks({ assignee: dev.id }).length, 1);
  await cp.close();
});
