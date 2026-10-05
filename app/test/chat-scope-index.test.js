// Chat team-scope id indexes (t_94b8df1f): nodeTeamOf/taskTeamOf used to scan S.allNodes and the
// whole S.tasks array linearly for every chat event — a grown 550-task board made the teamSwitch
// probe a 139ms long task inside taskTeamOf (Argo re-verify on 8d542d4). Renderer-level per the
// wake-selector pattern: extract the real index + scope functions from renderer/app.js and run
// them in node against Argo-shaped state (many tasks, few nodes), asserting correctness across
// refresh()/delta mutations AND that steady-state lookups perform zero array scans.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const a0 = src.indexOf('const _idx = {};');
const a1 = src.indexOf('const teamNameOf');
assert.ok(a0 > 0 && a1 > a0, 'id-index block found in renderer/app.js');
const indexBlock = src.slice(a0, a1);
const t0 = src.indexOf('// Thread-linked bubble titles ride the shared taskById index');
const t1 = src.indexOf('function openBlockers');
assert.ok(t0 > 0 && t1 > t0, 'taskTitle found in renderer/app.js');
const titleBlock = src.slice(t0, t1);
const s0 = src.indexOf('const chatInScope');
const s1 = src.indexOf('const who = ', s0);
assert.ok(s0 > 0 && s1 > s0, 'chat scope block found in renderer/app.js');
const scopeBlock = src.slice(s0, s1);

const teamHue = (tid) => ({ t1: 1, t2: 2 }[tid] || 0);

function build(state) {
  return new Function('S', 'teamHue', `${indexBlock}\nreturn { nodeById, taskById, nodeTeamOf, teamScoped, taskTeamOf, agentColor, agentStep };`)(state, teamHue);
}
function buildTitle(state) {
  return new Function('S', 'taskById', `${titleBlock}\nreturn { taskTitle };`)(state.S || state, build(state).taskById);
}
function buildScope(state, sel) {
  const ix = build(state);
  return new Function('S', 'sel', 'nodeTeamOf', 'taskTeamOf', `${scopeBlock}\nreturn { chatInScope, crossTeamOf };`)(state, sel, ix.nodeTeamOf, ix.taskTeamOf);
}

// Argo-shaped fixture: 2 teams, 6 nodes, 550 tasks split by assignee.
function fixture() {
  const nodes = [
    { id: 'n1', teamId: 't1', name: 'A1', role: 'Dev' },
    { id: 'n2', teamId: 't1', name: 'A2', role: 'Dev' },
    { id: 'n3', teamId: 't1', name: 'A3', role: 'Dev' },
    { id: 'n4', teamId: 't2', name: 'B1', role: 'Dev' },
    { id: 'n5', teamId: 't2', name: 'B2', role: 'Dev' },
    { id: 'n6', teamId: 't2', name: 'B3', role: 'Dev' },
  ];
  const tasks = [];
  for (let i = 0; i < 550; i++) tasks.push({ id: `t_${i}`, title: `task ${i}`, assignee: i % 2 ? 'n4' : 'n1' });
  return { allNodes: nodes, tasks, orch: { agents: {} } };
}

const tid = (i) => `t_${i}`;

test('taskTeamOf/nodeTeamOf resolve team ids, humans and unknown ids', () => {
  const S = fixture();
  const ix = build(S);
  assert.equal(ix.taskTeamOf(tid(0)), 't1'); // even → n1 (t1)
  assert.equal(ix.taskTeamOf(tid(1)), 't2'); // odd → n4 (t2)
  assert.equal(ix.taskTeamOf('nope'), null);
  assert.equal(ix.taskTeamOf(null), null);
  assert.equal(ix.nodeTeamOf('n5'), 't2');
  assert.equal(ix.nodeTeamOf('human'), null); // chat events from the human have no node
  assert.equal(ix.nodeTeamOf(undefined), null);
});

test('delta-style push onto the SAME tasks array is found (miss falls back to the scan)', () => {
  const S = fixture();
  const ix = build(S);
  assert.equal(ix.taskTeamOf(tid(0)), 't1'); // warm the cache
  S.tasks.push({ id: 't_new', title: 'fresh', assignee: 'n5' }); // delta-client mutates in place
  assert.equal(ix.taskTeamOf('t_new'), 't2');
  assert.equal(ix.taskById('t_new').title, 'fresh');
});

test('refresh-style array swap invalidates: reassignment shows up at once', () => {
  const S = fixture();
  const ix = build(S);
  assert.equal(ix.taskTeamOf(tid(0)), 't1');
  const nt = S.tasks.slice(); nt[0] = { ...nt[0], assignee: 'n4' };
  S.tasks = nt; // refresh() replaces the array wholesale (S = {...S, ...s})
  assert.equal(ix.taskTeamOf(tid(0)), 't2');
});

test('steady-state lookups perform ZERO array scans (the 139ms fix)', () => {
  const scans = { tasks: 0, nodes: 0 };
  const counting = (arr, key) => ({ find: (...a) => { scans[key]++; return arr.find(...a); }, filter: (...a) => arr.filter(...a) });
  const S = fixture();
  S.tasks = counting(S.tasks, 'tasks');
  S.allNodes = counting(S.allNodes, 'nodes');
  const ix = build(S);
  const ev = [];
  for (let i = 0; i < 500; i++) ev.push(tid(i % 550)); // a chat window's worth of task-scoped events
  for (const e of ev) ix.taskTeamOf(e); // first pass fills the caches (a few scans)
  const warm = { ...scans };
  for (let round = 0; round < 20; round++) for (const e of ev) { const tt = ix.taskTeamOf(e); assert.ok(tt === 't1' || tt === 't2'); }
  assert.equal(scans.tasks, warm.tasks, 'no task scans after warm-up (was O(events × 550))');
  assert.equal(scans.nodes, warm.nodes, 'no node scans after warm-up');
});

test('agentStep stays correct with the memo and mixes colours within a team', () => {
  const S = fixture();
  const ix = build(S);
  assert.deepEqual([ix.agentStep('n1'), ix.agentStep('n2'), ix.agentStep('n3')], [0, 1, 2]);
  assert.equal(ix.agentStep('n4'), 0);
  assert.equal(ix.agentStep('human'), 0);
  S.allNodes = S.allNodes.slice(); // identity swap: memo re-inits, steps unchanged
  assert.equal(ix.agentStep('n3'), 2);
});

test('chatInScope/crossTeamOf route events by task team through the indexes', () => {
  const S = fixture();
  const scope = buildScope(S, { chatTeam: 't1' });
  assert.equal(scope.chatInScope({ who: 'n1', type: 'thought' }), true, 'sender in team passes');
  assert.equal(scope.chatInScope({ who: 'human', type: 'comment', taskId: tid(1) }), false, 'task team decides for human comments');
  assert.equal(scope.chatInScope({ who: 'human', type: 'comment', taskId: tid(0) }), true);
  assert.equal(scope.chatInScope({ who: 'system' }), true, 'no node, no task — visible everywhere');
  assert.equal(scope.crossTeamOf({ who: 'n4', type: 'message' }), 't2', 'out-of-team sender is the badge');
  assert.equal(scope.crossTeamOf({ who: 'human', type: 'comment', taskId: tid(1) }), 't2');
  assert.equal(scope.crossTeamOf({ who: 'n1', type: 'thought' }), null, 'in-team: no badge');
});

test('taskTitle keeps its fallback and rides the shared index', () => {
  const S = fixture();
  const T = buildTitle(S);
  assert.equal(T.taskTitle(tid(3)), 'task 3');
  assert.equal(T.taskTitle('nope'), 'nope');
});
