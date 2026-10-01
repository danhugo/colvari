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

test('new nodes without coordinates get a free position (no stacking)', () => {
  const s = tmp();
  const a = s.addNode({ name: 'Brand Designer', role: 'Dev' });
  const b = s.addNode({ name: 'UI Dev', role: 'Dev' });
  assert.notDeepEqual([a.x, a.y], [b.x, b.y]);
  assert.ok(Math.abs(a.x - b.x) >= 200 || Math.abs(a.y - b.y) >= 110, 'node cards must not overlap');
  const seed = s.addNode({ name: 'Pinned', role: 'PM', x: 80, y: 360 });
  assert.deepEqual([seed.x, seed.y], [80, 360]); // explicit x/y with no collision is kept
  const next = s.addNode({ name: 'Next', role: 'Dev' });
  assert.ok(Math.abs(next.x - seed.x) >= 200 || Math.abs(next.y - seed.y) >= 110, 'placed nodes are skipped');
});

test('explicit x/y that overlaps a placed node claims a free spot instead', () => {
  const s = tmp();
  const a = s.addNode({ name: 'First', role: 'Dev', x: 420, y: 300 });
  // toolbar add staggers by (count%3)*20, so back-to-back adds are 20px apart
  const b = s.addNode({ name: 'Second', role: 'Dev', x: 440, y: 300 });
  assert.ok(Math.abs(a.x - b.x) >= 200 || Math.abs(a.y - b.y) >= 110, 'back-to-back adds must not overlap');
  const free = s.addNode({ name: 'Free', role: 'Dev', x: 700, y: 300 });
  assert.deepEqual([free.x, free.y], [700, 300]); // a collision-free explicit spot is still kept
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

test('wiki: list summaries (no body) and full-text search', () => {
  const s = tmp();
  s.writeWiki('Runbook', 'How the team operates. See the deploy steps.', 'Pia');
  s.writeWiki('Glossary', 'PM: plans the work. Dev: builds it.', 'Devon');
  const list = s.listWikiSummaries();
  assert.equal(list.length, 2);
  assert.deepEqual(Object.keys(list[0]).sort(), ['author', 'title', 'updatedAt']);
  const byTitle = s.searchWiki('runbook');
  assert.equal(byTitle.length, 1); assert.equal(byTitle[0].title, 'Runbook');
  const byBody = s.searchWiki('deploy steps');
  assert.equal(byBody.length, 1); assert.equal(byBody[0].title, 'Runbook');
  assert.match(byBody[0].snippet, /deploy steps/);
  assert.equal(s.searchWiki('nonexistent').length, 0);
  assert.deepEqual(s.searchWiki(''), []);
});

test('sessions: grouped from runs, paginated log scoped to the session window', () => {
  const { newRun } = require('../src/usage');
  const s = tmp();
  const n = s.addNode({ name: 'Devon', role: 'Dev' });
  const t = s.createTask({ title: 'Build it', assignee: n.id });
  s.addRun(newRun({ nodeId: n.id, agent: n.name, taskId: t.id, task: t.title, sessionId: 'sess-1', model: 'claude-x', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.1 }));
  s.addRun(newRun({ nodeId: n.id, agent: n.name, taskId: t.id, task: t.title, sessionId: 'sess-1', model: 'claude-x', startedAt: '2026-01-01T00:02:00.000Z', endedAt: '2026-01-01T00:03:00.000Z', inputTokens: 3, outputTokens: 2, reportedCostUsd: 0.05 }));
  s.addRun(newRun({ nodeId: n.id, agent: n.name, taskId: t.id, task: t.title, sessionId: 'sess-2', model: 'claude-x', startedAt: '2026-01-01T00:10:00.000Z', endedAt: '2026-01-01T00:11:00.000Z', inputTokens: 1, outputTokens: 1, reportedCostUsd: 0.01 }));

  const at = (iso) => new Date(iso).getTime();
  const l = (at_, text) => s.appendLog({ nodeId: n.id, kind: 'text', text, at: at_ });
  l(at('2026-01-01T00:00:10.000Z'), 'session1 line A');
  l(at('2026-01-01T00:02:30.000Z'), 'session1 line B');
  l(at('2026-01-01T00:10:30.000Z'), 'session2 line A');

  const sessions = s.listSessions({ nodeId: n.id });
  assert.equal(sessions.length, 2);
  const sess1 = sessions.find((x) => x.sessionId === 'sess-1');
  assert.equal(sess1.runs, 2);
  assert.equal(Math.round((sess1.reportedCostUsd + Number.EPSILON) * 100) / 100, 0.15);
  assert.equal(sess1.taskId, t.id);

  const log1 = s.getSessionLog('sess-1', { offset: 0, limit: 1 });
  assert.equal(log1.total, 2);
  assert.equal(log1.entries.length, 1);
  assert.equal(log1.entries[0].text, 'session1 line A');
  const log1p2 = s.getSessionLog('sess-1', { offset: 1, limit: 1 });
  assert.equal(log1p2.entries[0].text, 'session1 line B');

  const log2 = s.getSessionLog('sess-2');
  assert.equal(log2.total, 1);
  assert.equal(log2.entries[0].text, 'session2 line A');

  assert.deepEqual(s.getSessionLog('no-such-session'), { total: 0, offset: 0, limit: 200, entries: [] });
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

test('switching a node runtime drops its rate-limit snapshot (readings are runtime-scoped)', () => {
  const s = tmp();
  const n = s.addNode({ name: 'A', role: 'Dev', runtime: 'claude' });
  const rl = { fiveHour: { pct: 0.91, resetsAt: new Date(Date.now() + 3600000).toISOString() }, weekly: { pct: 0.28, resetsAt: new Date(Date.now() + 96 * 3600000).toISOString() }, runtime: 'claude' };
  s.updateNode(n.id, { rateLimits: rl, rateLimitsAt: new Date().toISOString() });
  assert.equal(s.getTeam().nodes.find((x) => x.id === n.id).rateLimits.weekly.pct, 0.28);
  // claude -> helpycode: the claude CLI's windows must not resurface as helpycode quota
  s.updateNode(n.id, { runtime: 'helpycode' });
  const after = s.getTeam().nodes.find((x) => x.id === n.id);
  assert.equal(after.rateLimits, undefined);
  assert.equal(after.rateLimitsAt, undefined);
  // an update that doesn't touch runtime keeps the reading
  s.updateNode(n.id, { rateLimits: rl, rateLimitsAt: new Date().toISOString() });
  s.updateNode(n.id, { name: 'A2' });
  assert.equal(s.getTeam().nodes.find((x) => x.id === n.id).rateLimits.weekly.pct, 0.28);
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

test('parent task auto-completes when all subtasks are done', () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-')));
  const root = s.createTask({ title: 'goal' });
  const p = s.createTask({ title: 'p', parentId: root.id });
  const a = s.createTask({ title: 'a', parentId: p.id });
  const b = s.createTask({ title: 'b', parentId: p.id });
  s.updateTask(a.id, { status: 'done' });
  assert.equal(s.getTask(p.id).status, 'todo');
  s.updateTask(b.id, { status: 'done' });
  assert.equal(s.getTask(p.id).status, 'done');
  assert.equal(s.getTask(root.id).status, 'done');
});

test('listTasks uncached: status and assignee filters AND together', () => {
  const s = tmp();
  const both = s.createTask({ title: 'both', assignee: 'n1' });
  s.createTask({ title: 'todo other assignee', assignee: 'n2' });
  const mine = s.createTask({ title: 'n1 in progress', assignee: 'n1' });
  s.updateTask(mine.id, { status: 'in_progress' });
  const got = s.listTasks({ status: 'todo', assignee: 'n1' });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, both.id);
  assert.equal(s.listTasks({ assignee: 'n1' }).length, 2);
  assert.equal(s.listTasks({ status: 'todo' }).length, 2);
  assert.equal(s.listTasks().length, 3);
});
