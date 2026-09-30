const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

// Fake claude: each run lasts ~1.5s, so overlap cannot come from near-simultaneous starts alone.
const RESULT = `echo '{"type":"result","subtype":"success","session_id":"s","total_cost_usd":0,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}'\n`;

test('parallel: 3 independent dev tasks across 2 teams overlap; dependent waits for its blocker', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-par-'));
  const fake = path.join(d, 'fake-claude.sh'); fs.writeFileSync(fake, '#!/bin/sh\nsleep 1.5\n' + RESULT); fs.chmodSync(fake, 0o755);
  const pm = new ProjectManager(path.join(d, 'root'));
  const pid = pm.list()[0].id; const t1 = pm.get(pid).teams[0].id; const t2 = pm.createTeam(pid, 'Second').id;
  const s = pm.store(pid); s.saveSettings({ claudePath: fake, maxConcurrency: 8, maxRuns: 20 });
  const a = pm.store(pid, t1).addNode({ name: 'DevA', role: 'Dev' });
  const b = pm.store(pid, t1).addNode({ name: 'DevB', role: 'Dev' });
  const c = pm.store(pid, t2).addNode({ name: 'DevC', role: 'Dev' });
  const rev = pm.store(pid, t1).addNode({ name: 'Rev', role: 'Reviewer' }); // hand-offs complete via reviewer pickup
  pm.store(pid, t1).addEdge(a.id, rev.id, 'review');
  pm.store(pid, t1).addEdge(b.id, rev.id, 'review');
  pm.store(pid, t2).addEdge(c.id, rev.id, 'review'); // cross-team review edge
  const ta = s.createTask({ title: 'A', assignee: a.id });
  const tb = s.createTask({ title: 'B', assignee: b.id });
  const tc = s.createTask({ title: 'C', assignee: c.id });
  const tdep = s.createTask({ title: 'dep', assignee: c.id, blockedBy: [ta.id] });
  const o = new Orchestrator(s);
  let depStartedWhileBlockerOpen = false;
  o.on('state', () => { if (s.getTask(tdep.id).status !== 'todo' && s.getTask(ta.id).status !== 'done') depStartedWhileBlockerOpen = true; });
  await new Promise((res) => { o.once('done', res); o.once('idle', res); o.start(); }); // drain idles now (t_b2273507)
  assert.ok(s.listTasks().every((t) => t.status === 'done'));
  const run = (tid) => s.listRuns().find((r) => r.taskId === tid && r.kind === 'agent' && r.nodeId !== rev.id); // the dev's run, not the reviewer pickup
  const win = (tid) => { const r = run(tid); return [Date.parse(r.startedAt), Date.parse(r.endedAt)]; };
  const [A, B, C, D] = [ta, tb, tc, tdep].map((t) => win(t.id));
  for (const w of [A, B, C]) assert.ok(w[1] - w[0] >= 1000, 'run lasts >= 1s');
  const overlap = (x, y) => x[0] < y[1] && y[0] < x[1];
  assert.ok(overlap(A, B) && overlap(A, C) && overlap(B, C), 'all three independent runs overlap pairwise (incl. across teams)');
  assert.ok(D[0] >= A[1], 'dependent starts only after its blocker ended');
  assert.ok(!depStartedWhileBlockerOpen, 'dependent never left todo before blocker was done');
});
