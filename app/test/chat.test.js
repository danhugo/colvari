const test = require('node:test'); const assert = require('node:assert');
const C = require('../src/chat.js');
const nodes = [{ id: 'n1', name: 'Pia' }, { id: 'n2', name: 'Devon' }];

test('avatar colour is stable per id and independent of name', () => {
  assert.strictEqual(C.avatarColor('n1'), C.avatarColor('n1')); assert.notStrictEqual(C.avatarColor('n1'), C.avatarColor('n2'));
  assert.strictEqual(C.initials('Devon'), 'D'); assert.strictEqual(C.initials('Rhea Reviewer'), 'RR');
});

test('composer: @Name = task, @Name? = message, plain = goal, unknown = error', () => {
  assert.deepStrictEqual(C.parseComposer('@devon build it', nodes), { kind: 'task', nodeId: 'n2', name: 'Devon', text: 'build it' });
  assert.strictEqual(C.parseComposer('@Devon? how is it going', nodes).kind, 'message');
  assert.strictEqual(C.parseComposer('hi team', nodes).kind, 'goal');
  assert.strictEqual(C.parseComposer('@Zed do x', nodes).kind, 'error');
  assert.strictEqual(C.parseComposer('@Devon', nodes).kind, 'error');
  assert.strictEqual(C.parseComposer('  ', nodes), null);
  assert.deepStrictEqual(C.mentionMatches('hey @De', nodes).map((n) => n.id), ['n2']); assert.strictEqual(C.mentionMatches('no mention', nodes), null);
});

test('room events: thoughts, tool chips with results, handoffs, questions; linked to tasks; grouped', () => {
  const tasks = [{ id: 't1', title: 'Build', createdBy: 'n1', assignee: 'n2', createdAt: 1, comments: [{ author: 'n2', text: 'done', at: 90 }] }];
  const logs = [{ nodeId: 'n2', kind: 'system', text: '▶ Devon starts "Build" in /x', at: 10 }, { nodeId: 'n2', kind: 'text', text: 'thinking', at: 20 },
    { nodeId: 'n2', kind: 'tool', text: 'Bash {"command":"npm test"}', at: 30 }, { nodeId: 'n2', kind: 'tool_result', text: 'ok', at: 31 }];
  const ev = C.roomEvents(logs, tasks, [{ from: 'n1', to: 'n2', text: 'ping', at: 50 }], [{ id: 'i1', kind: 'question', nodeId: 'n2', question: 'Which?', choices: ['a'], at: 60 }]);
  assert.deepStrictEqual(ev.map((e) => e.type), ['handoff', 'action', 'thought', 'tool', 'message', 'question', 'comment']);
  const tool = ev.find((e) => e.type === 'tool'); assert.strictEqual(tool.label, 'Bash · npm test'); assert.strictEqual(tool.result, 'ok'); assert.strictEqual(tool.taskId, 't1');
  const g = C.group(ev); assert.deepStrictEqual(g.map((x) => [x.who, x.items.length]), [['n1', 1], ['n2', 3], ['n1', 1], ['n2', 1], ['n2', 1]]);
  assert.strictEqual(C.roomEvents(Array.from({ length: 700 }, (_, i) => ({ nodeId: 'n1', kind: 'text', text: 'x', at: i })), [], [], []).length, C.MAX);
});
