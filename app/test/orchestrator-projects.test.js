const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

test('orchestrators run different projects concurrently and independently', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-orch-'));
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 0.3\necho \'{"type":"result","subtype":"success","total_cost_usd":0.01,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(fake, 0o755);
  const pm = new ProjectManager(r);
  const pids = [pm.list()[0].id, pm.create('B', 'solo').id];
  const orchs = pids.map((pid) => {
    const s = pm.store(pid); s.saveSettings({ claudePath: fake });
    const node = s.getTeam().nodes[0] || s.addNode({ name: 'D', role: 'Dev' });
    s.createTask({ title: 'job ' + pid, assignee: node.id });
    return new Orchestrator(s);
  });
  const done = orchs.map((o) => new Promise((res) => o.on('done', res)));
  orchs.forEach((o) => o.start());
  assert.ok(orchs.every((o) => o.running));
  const snaps = await Promise.all(done);
  for (const [i, pid] of pids.entries()) {
    const ts = pm.store(pid).listTasks();
    assert.equal(ts.length, 1); assert.equal(ts[0].status, 'done');
    assert.equal(snaps[i].runs, 1); assert.ok(Math.abs(snaps[i].totalCost - 0.01) < 1e-9);
  }
});
