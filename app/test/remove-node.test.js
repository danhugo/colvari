// Decision: delete-agent backend (t_749f4cc1). store.removeNode is the one delete path (human IPC;
// retire_agent lands here after its own pre-reassign): the core is refused, an agent owning an
// in_progress task is refused (it may be running it right now), and its other open tasks go to the
// first incoming edge source (the manager), else the team core — never stranded on a deleted node.
// Done tasks keep their assignee as history; unknown ids stay a silent no-op.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

function setup() {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-delnode-')));
  s.write('project', { id: 'p', name: 'P', createdAt: new Date().toISOString(), teams: [{ id: 'a', name: 'A' }] });
  const core = s.addNode({ name: 'Core', role: 'PM', core: true, x: 10, y: 20 });
  const mgr = s.addNode({ name: 'Mgr', role: 'PM', x: 200, y: 20 });
  const w = s.addNode({ name: 'Wally', role: 'Dev', x: 400, y: 20 });
  s.addEdge(mgr.id, w.id);
  return { s, core, mgr, w };
}

test('removeNode refuses the core agent (backend, not just a hidden button)', () => {
  const { s, core } = setup();
  assert.throws(() => s.removeNode(core.id), /core/);
  assert.ok(s.getTeam().nodes.some((n) => n.id === core.id), 'node still there');
});

test('removeNode refuses while the agent owns an in_progress task; task untouched', () => {
  const { s, w } = setup();
  const run = s.createTask({ title: 'Running now', assignee: w.id });
  s.updateTask(run.id, { status: 'in_progress' });
  assert.throws(() => s.removeNode(w.id), /in_progress/);
  assert.ok(s.getTeam().nodes.some((n) => n.id === w.id), 'node still there');
  assert.equal(s.getTask(run.id).status, 'in_progress');
  assert.equal(s.getTask(run.id).assignee, w.id);
});

test('removeNode reassigns open tasks to the manager (first incoming edge), done keeps history', () => {
  const { s, mgr, w } = setup();
  const todo = s.createTask({ title: 'Open work', assignee: w.id });
  const review = s.createTask({ title: 'In review', assignee: w.id });
  s.updateTask(review.id, { status: 'review' });
  const done = s.createTask({ title: 'Shipped', assignee: w.id });
  s.updateTask(done.id, { status: 'done' });
  s.removeNode(w.id);
  assert.equal(s.getTask(todo.id).assignee, mgr.id, 'todo to the manager');
  assert.equal(s.getTask(review.id).assignee, mgr.id, 'review to the manager');
  assert.equal(s.getTask(done.id).assignee, w.id, 'done keeps its assignee');
  assert.equal(s.getTeam().nodes.some((n) => n.id === w.id), false, 'node gone');
  assert.equal(s.getTeam().edges.some((e) => e.from === w.id || e.to === w.id), false, 'edges gone');
});

test('removeNode with no incoming edge hands the open tasks to the team core', () => {
  const { s, core, w } = setup();
  s.removeEdge(s.getTeam().edges[0].id);
  const t = s.createTask({ title: 'Orphan work', assignee: w.id });
  s.removeNode(w.id);
  assert.equal(s.getTask(t.id).assignee, core.id);
});

test('removeNode of an unknown id stays a silent no-op (idempotent delete)', () => {
  const { s } = setup();
  s.removeNode('n_ghost');
  assert.ok(s.getTeam().nodes.length >= 3);
});
