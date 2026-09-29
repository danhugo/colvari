const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-reconcile-'));
  const pm = new ProjectManager(dir);
  const s = pm.store(pm.list()[0].id);
  const node = s.getTeam().nodes[0] || s.addNode({ name: 'D', role: 'Dev' });
  return { s, node };
}

test('reconcileOrphanedTasks resets in_progress task with no live process to todo', () => {
  const { s, node } = setup();
  const t = s.createTask({ title: 'orphan', assignee: node.id });
  s.updateTask(t.id, { status: 'in_progress' });
  const o = new Orchestrator(s);
  const changed = o.reconcileOrphanedTasks();
  assert.equal(changed, true);
  const after = s.getTask(t.id);
  assert.equal(after.status, 'todo');
  assert.ok(after.comments.some((c) => c.author === 'orchestrator' && /no live session/i.test(c.text)));
});

test('reconcileOrphanedTasks leaves in_progress task alone when its agent has a live process', () => {
  const { s, node } = setup();
  const t = s.createTask({ title: 'live', assignee: node.id });
  s.updateTask(t.id, { status: 'in_progress' });
  const o = new Orchestrator(s);
  o.agent(node.id).taskId = t.id;
  o.procs.set(node.id, { kill() {} });
  const changed = o.reconcileOrphanedTasks();
  assert.equal(changed, false);
  assert.equal(s.getTask(t.id).status, 'in_progress');
});

test('tick() sweeps orphaned in_progress tasks and re-dispatches instead of stopping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-reconcile-'));
  const fake = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"type":"result","subtype":"success","total_cost_usd":0.01,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(fake, 0o755);
  const pm = new ProjectManager(dir);
  const s = pm.store(pm.list()[0].id);
  s.saveSettings({ claudePath: fake });
  const node = s.getTeam().nodes[0] || s.addNode({ name: 'D', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // the re-dispatched hand-off completes via reviewer pickup
  s.addEdge(node.id, rev.id, 'review');
  const t = s.createTask({ title: 'stranded', assignee: node.id });
  s.updateTask(t.id, { status: 'in_progress' }); // simulate a crashed prior run, no live process
  const o = new Orchestrator(s);
  const done = new Promise((res) => o.on('done', res));
  o.start();
  await done;
  assert.equal(s.getTask(t.id).status, 'done');
});
