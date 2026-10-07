const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager } = require('../src/projects');
const { Orchestrator, boardMcpCause } = require('../src/orchestrator');

// t_7509d1b0: board MCP failed at init → breaker trips at once with ONE askHuman; orphan resets cap at 3.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-boardmcp-'));
  const pm = new ProjectManager(dir);
  const s = pm.store(pm.list()[0].id);
  const node = s.getTeam().nodes[0] || s.addNode({ name: 'D', role: 'Dev' });
  return { s, node };
}
const init = (status) => JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', mcp_servers: [{ name: 'board', status }] });

test('board MCP failed at init pauses the runtime and asks the human once', () => {
  const { s, node } = setup();
  const o = new Orchestrator(s);
  const asks = []; s.askHuman = (q) => { asks.push(q); };
  o.onEvent(node, init('failed'), null, 'claude');
  o.onEvent(node, init('failed'), null, 'claude');
  assert.equal(o.runtimeState.claude.state, 'unavailable');
  assert.equal(asks.length, 1);
  assert.match(asks[0].question, /board MCP/);
});

test('board MCP connected does not trip', () => {
  const { s, node } = setup();
  const o = new Orchestrator(s);
  o.onEvent(node, init('connected'), null, 'claude');
  assert.ok(!o.runtimeState.claude);
});

test('boardMcpCause names a missing Electron binary / missing deps', () => {
  assert.match(boardMcpCause('failed', '/nope/electron'), /Electron binary not found.*npm install in app\//);
  assert.match(boardMcpCause('failed', process.execPath, os.tmpdir()), /MCP SDK not found/);
});

test('reconcileOrphanedTasks parks a task after 3 resets and alerts', () => {
  const { s, node } = setup();
  const t = s.createTask({ title: 'loop', assignee: node.id });
  const o = new Orchestrator(s);
  const alerts = []; o.alertCrashPark = (n, task, k) => alerts.push(k);
  for (let i = 0; i < 3; i++) { s.updateTask(t.id, { status: 'in_progress' }); o.reconcileOrphanedTasks(); assert.equal(s.getTask(t.id).status, 'todo'); }
  s.updateTask(t.id, { status: 'in_progress' });
  o.reconcileOrphanedTasks();
  const after = s.getTask(t.id);
  assert.equal(after.status, 'review'); assert.equal(after.parkedForHuman, true);
  assert.deepEqual(alerts, [4]);
});
