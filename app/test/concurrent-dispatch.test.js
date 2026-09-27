const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

function setup() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cc-'));
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 0.4\necho \'{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(r, 'data')); s.saveSettings({ claudePath: fake, maxConcurrency: 0 });
  const ns = ['A', 'B', 'C'].map((n) => s.addNode({ name: n, role: 'Dev', workdir: path.join(r, 'w' + n) }));
  return { s, ns };
}

test('3 independent tasks start 3 simultaneous runs', async () => {
  const { s, ns } = setup();
  ns.forEach((n, i) => s.createTask({ title: 't' + i, assignee: n.id }));
  const o = new Orchestrator(s); const done = new Promise((r) => o.on('done', r));
  o.start();
  assert.equal(o.snapshot().active.length, 3);
  await done;
  assert.ok(s.listTasks().every((t) => t.status === 'done'));
});

test('dependent task waits for its blocker', async () => {
  const { s, ns } = setup();
  const a = s.createTask({ title: 'a', assignee: ns[0].id });
  const b = s.createTask({ title: 'b', assignee: ns[1].id, blockedBy: [a.id] });
  const o = new Orchestrator(s); const done = new Promise((r) => o.on('done', r));
  o.start();
  assert.deepEqual(o.snapshot().active.map((x) => x.taskId), [a.id]);
  assert.equal(s.getTask(b.id).status, 'todo');
  await done;
  assert.equal(s.getTask(b.id).status, 'done');
});
