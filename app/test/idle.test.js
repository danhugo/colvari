const test = require('node:test');
const assert = require('node:assert');
const { agentStates, idleNudges } = require('../src/idle');

const team = { nodes: [{ id: 'pm', name: 'Pia' }, { id: 'a', name: 'Devon' }, { id: 'b', name: 'Uma' }], edges: [{ from: 'pm', to: 'a', type: 'assign' }, { from: 'pm', to: 'b' }] };

test('agentStates: busy via in_progress task or working run', () => {
  const tasks = [{ assignee: 'a', status: 'in_progress' }, { assignee: 'b', status: 'todo' }];
  assert.deepStrictEqual(agentStates(team, tasks, { pm: { status: 'working' } }), { pm: 'busy', a: 'busy', b: 'idle' });
});

test('idleNudges: PM with open goals is told about idle reports', () => {
  const tasks = [{ assignee: 'pm', status: 'todo' }, { assignee: 'a', status: 'in_progress' }];
  assert.deepStrictEqual(idleNudges(team, tasks), [{ pmId: 'pm', idle: ['b'], text: '1 agent idle: Uma' }]);
  assert.strictEqual(idleNudges(team, [{ createdBy: 'pm', status: 'review' }])[0].text, '2 agents idle: Devon, Uma');
});

test('idleNudges: no nudge without open goals or idle agents', () => {
  assert.deepStrictEqual(idleNudges(team, [{ assignee: 'pm', status: 'done' }]), []);
  assert.deepStrictEqual(idleNudges(team, [{ assignee: 'pm', status: 'todo' }], { a: { status: 'working' }, b: { status: 'working' } }), []);
});
