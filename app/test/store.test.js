const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');

const tmp = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-')));

test('team nodes and edges', () => {
  const s = tmp();
  const a = s.addNode({ name: 'PM', role: 'PM' }); const b = s.addNode({ name: 'Dev', role: 'Dev' });
  s.addEdge(a.id, b.id); s.addEdge(a.id, b.id);
  assert.equal(s.getTeam().edges.length, 1);
  assert.throws(() => s.addEdge(a.id, a.id));
  assert.equal(s.addNode({ role: 'CEO' }).role, 'CEO'); // roles are free text
  assert.throws(() => s.addNode({ permissionMode: 'yolo' }));
  s.removeNode(b.id);
  assert.deepEqual(s.getTeam().edges, []);
});

test('board tasks: create, status, comment, persistence', () => {
  const s = tmp();
  const t = s.createTask({ title: 'Goal', assignee: 'n1' });
  assert.equal(t.status, 'todo');
  s.updateTask(t.id, { status: 'in_progress' });
  s.commentTask(t.id, 'me', 'hi');
  assert.throws(() => s.updateTask(t.id, { status: 'bogus' }));
  const s2 = new Store(s.dir);
  const got = s2.getTask(t.id);
  assert.equal(got.status, 'in_progress');
  assert.equal(got.comments[0].text, 'hi');
  assert.equal(s2.listTasks({ status: 'todo' }).length, 0);
});

test('wiki pages', () => {
  const s = tmp();
  s.writeWiki('Home', '# hi', 'x');
  assert.equal(s.readWiki('Home').content, '# hi');
  s.deleteWiki('Home');
  assert.equal(s.readWiki('Home'), null);
});

test('changing an agent role to a preset fills its empty prompt, tools and permission mode', () => {
  const { Store } = require('../src/store');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-role-')));
  s.savePreset({ name: 'Auditor', systemPrompt: 'Audit.', allowedTools: 'Read, Grep', disallowedTools: 'Bash', permissionMode: 'plan' });
  const n = s.addNode({ name: 'A', role: 'Dev' });
  const u = s.updateNode(n.id, { role: 'auditor', systemPrompt: '' });
  assert.equal(u.systemPrompt, 'Audit.'); assert.deepStrictEqual(u.allowedTools, ['Read', 'Grep']); assert.deepStrictEqual(u.disallowedTools, ['Bash']); assert.equal(u.permissionMode, 'plan');
  const n2 = s.addNode({ name: 'B', role: 'Dev', systemPrompt: 'mine' });
  assert.equal(s.updateNode(n2.id, { role: 'Auditor' }).systemPrompt, 'mine', 'explicit values win');
  s.updateNode(n.id, { systemPrompt: '' });
  assert.equal(s.getTeam().nodes.find((x) => x.id === n.id).systemPrompt, '', 'no refill without a role change');
});

test('human inbox: ask_human blocks until answered, approvals create items', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const { Store } = require('../src/store'); const { makeTools } = require('../src/board-tools');
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')));
  const n = s.addNode({ name: 'Dev', role: 'Dev' });
  const t = s.createTask({ title: 'x', assignee: n.id }); s.updateTask(t.id, { status: 'in_progress' });
  const p = makeTools(s, n.id).ask_human({ question: 'Which DB?', choices: ['pg', 'sqlite'], pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  const [q] = s.listInbox({ status: 'open' });
  assert.equal(q.question, 'Which DB?'); assert.equal(s.getTask(t.id).status, 'waiting_for_human');
  s.answerInbox(q.id, 'pg');
  assert.deepEqual(await p, { answer: 'pg' }); assert.equal(s.getTask(t.id).status, 'in_progress');
  s.updateTask(t.id, { status: 'review', awaitingApproval: true });
  const [a] = s.listInbox({ status: 'open' }); assert.equal(a.kind, 'approval');
  s.answerInbox(a.id, 'approve'); assert.equal(s.getTask(t.id).status, 'done'); assert.equal(s.listInbox({ status: 'open' }).length, 0);
});
