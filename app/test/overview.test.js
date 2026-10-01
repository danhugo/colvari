const test = require('node:test');
const assert = require('node:assert');
const O = require('../src/overview');

const M = 60000;
test('stuck detection: working agents with no output for N minutes', () => {
  const agents = { a: { status: 'working' }, b: { status: 'working' }, c: { status: 'idle' }, d: { status: 'working', startedAt: 0 } };
  const logs = [{ nodeId: 'a', at: 0 }, { nodeId: 'b', at: 8 * M }, { nodeId: 'c', at: 0 }];
  assert.deepEqual(O.stuckAgents(agents, logs, 10 * M, 5).sort(), ['a', 'd']);
  assert.deepEqual(O.stuckAgents(agents, logs, 10 * M, 15), []);
  assert.deepEqual(O.stuckAgents(agents, logs, 10 * M, 1).sort(), ['a', 'b', 'd']);
});

test('timeline: runs, tool ticks and status markers per lane', () => {
  const logs = [
    { nodeId: 'a', kind: 'system', text: '▶ Pia starts "Goal" in /x [mode=single]', at: 100 },
    { nodeId: 'a', kind: 'tool', text: 'mcp__board__create_task {"title":"t","assignee":"b"}', at: 150 },
    { nodeId: 'a', kind: 'tool', text: 'mcp__board__update_task_status {"taskId":"t1","status":"done"}', at: 180 },
    { nodeId: 'a', kind: 'result', text: 'success cost=$0 turns=1', at: 200 },
    { nodeId: 'b', kind: 'system', text: '▶ Dev starts "t" in /x', at: 210 },
    { nodeId: 'z', kind: 'tool', text: 'Read {}', at: 220 },
  ];
  const L = O.timeline(logs, ['a', 'b'], 500);
  assert.deepEqual(L.a.runs, [{ start: 100, end: 200, task: 'Goal' }]);
  assert.deepEqual(L.a.ticks.map((t) => t.name), ['create_task', 'update_task_status']);
  assert.deepEqual(L.a.marks, [{ at: 180, status: 'done', taskId: 't1' }]);
  assert.deepEqual(L.b.runs, [{ start: 210, end: 500, task: 't', live: true }]);
  assert.equal(L.z, undefined);
});

test('timeline: wake runs show a bar labelled with who woke it, live until the run ends', () => {
  const logs = [
    { nodeId: 'a', kind: 'system', text: '▶ Pia wakes to handle messages from Critic in /x', at: 300 },
    { nodeId: 'a', kind: 'system', text: '■ Pia finished the wake run (exit 0)', at: 400 },
    { nodeId: 'b', kind: 'system', text: '▶ Dev wakes to handle messages from you in /x [resume s1]', at: 350 },
  ];
  const L = O.timeline(logs, ['a', 'b'], 500);
  assert.deepEqual(L.a.runs, [{ start: 300, end: 400, task: 'wake: Critic' }]);
  assert.deepEqual(L.b.runs, [{ start: 350, end: 500, task: 'wake: you', live: true }]);
});

test('edge flashes: assign / send_message light the matching edge for 10s', () => {
  const edges = [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'a' }];
  const logs = [{ nodeId: 'a', kind: 'tool', text: 'mcp__board__create_task {"assignee":"b"}', at: 5000 }, { nodeId: 'b', kind: 'tool', text: 'mcp__board__send_message {"to":"a","text":"hi"}', at: 0 }];
  assert.deepEqual([...O.edgeFlashes(logs, edges, 12000)], ['e1']);
  assert.deepEqual([...O.edgeFlashes(logs, edges, 20000)], []);
});

test('task thread: comments, messages and tool chips in time order', () => {
  const task = { id: 't1', title: 'T', assignee: 'b', createdAt: new Date(0).toISOString(), comments: [{ author: 'b', text: 'done', at: new Date(300).toISOString() }] };
  const logs = [{ nodeId: 'b', kind: 'system', text: '▶ Dev starts "Other" in /x', at: 50 }, { nodeId: 'b', kind: 'tool', text: 'Bash {"command":"ls"}', at: 60 },
    { nodeId: 'b', kind: 'system', text: '▶ Dev starts "T" in /x', at: 100 }, { nodeId: 'b', kind: 'tool', text: 'Write {"file_path":"a.txt","content":"x"}', at: 120 }];
  const msgs = [{ from: 'a', to: 'b', text: 'go', at: new Date(110).toISOString() }];
  const th = O.taskThread(task, logs, msgs);
  assert.deepEqual(th.map((x) => x.type), ['message', 'tool', 'comment']);
  assert.equal(th[1].summary, 'Write · a.txt');
});

test('laneAttention: waiting_for_human beats blocked beats error; idle lane is null', () => {
  const tasks = [
    { id: 't1', status: 'waiting_for_human' },
    { id: 't2', status: 'todo', blockedBy: ['t3'] },
    { id: 't3', status: 'in_progress' },
  ];
  const agents = { a: { taskId: 't1' }, b: { taskId: 't2' }, c: { taskId: null, lastError: { text: 'boom' } }, d: { taskId: null } };
  assert.deepEqual(O.laneAttention(['a', 'b', 'c', 'd'], agents, tasks), { a: 'waiting_for_human', b: 'blocked', c: 'error', d: null });
});

test('sortByAttention: needs-attention lanes sort first, ties keep input order', () => {
  const tasks = [{ id: 't1', status: 'waiting_for_human' }, { id: 't2', status: 'in_progress' }];
  const agents = { Cx1: { taskId: null }, Cx2: { taskId: 't1' }, Cx3: { taskId: null, lastError: { text: 'x' } }, Cx4: { taskId: 't2' } };
  assert.deepEqual(O.sortByAttention(['Cx1', 'Cx2', 'Cx3', 'Cx4'], agents, tasks), ['Cx2', 'Cx3', 'Cx1', 'Cx4']);
});
