const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

// Regression for: a run that ends (crash/restart) with in_progress tasks whose agents have no
// live process must reset+re-dispatch those tasks, never report "Stopped: ... blocked by unfinished
// dependencies" while orphaned in_progress tasks are the actual reason nothing is running.
// Reproduces via the real orchestrator IPC path (Store + Orchestrator.tick/start), not a pure helper.
function setup(n) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stuck-'));
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(r, 'data')); s.saveSettings({ claudePath: fake, maxConcurrency: 0 });
  const ns = Array.from({ length: n }, (_, i) => s.addNode({ name: 'N' + i, role: 'Dev', workdir: path.join(r, 'w' + i) }));
  return { s, ns };
}

test('orchestrator resets and re-dispatches orphaned in_progress tasks instead of stopping blocked', async () => {
  const { s, ns } = setup(7);
  // A reviewer so hand-offs can complete: since t_699b67b7 a clean exit lands in review and only a
  // reviewer pickup (or owner) moves it to done — with no reviewer the run would legitimately strand.
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  for (const n of ns) s.addEdge(n.id, rev.id, 'review');
  // 6 in_progress tasks whose assignees have no live process (simulating a prior run that ended
  // without a clean handoff: app restart, crash, etc.)
  const stuck = ns.slice(0, 6).map((n, i) => {
    const t = s.createTask({ title: 'stuck' + i, assignee: n.id });
    s.updateTask(t.id, { status: 'in_progress' });
    return s.getTask(t.id);
  });
  // 1 more todo task blocked by one of the orphaned in_progress tasks.
  const blockedTask = s.createTask({ title: 'blocked', assignee: ns[6].id, blockedBy: [stuck[0].id] });

  const logs = [];
  const o = new Orchestrator(s);
  o.on('log', (l) => logs.push(l.text));
  const done = new Promise((resolve) => o.on('done', resolve));
  o.start();
  await done;

  const stopReason = logs.find((t) => /^Stopped:|^No more todo|orphan|reconcil/i.test(t)) || '';
  assert.ok(!/blocked by unfinished dependencies/.test(stopReason), `stop reason must not blame "blocked" deps while orphans exist: "${stopReason}"`);

  const finalTasks = s.listTasks();
  const stillOrphaned = finalTasks.filter((t) => stuck.some((x) => x.id === t.id) && t.status === 'in_progress');
  assert.equal(stillOrphaned.length, 0, `no in_progress task should remain orphaned: ${JSON.stringify(stillOrphaned.map((t) => t.title))}`);

  assert.ok(finalTasks.every((t) => t.status === 'done'), `all tasks (incl. the previously blocked one) should complete: ${JSON.stringify(finalTasks.map((t) => [t.title, t.status]))}`);
});

// Regression for t_d79c74fc: a run that ends with an undispatchable task in review (reviewer session
// died before sign-off) must tell the human why it stopped, never log "Finished." with work still open.
test('run with a task in review and nothing dispatchable stops with a reason naming the task', async () => {
  const { s, ns } = setup(2);
  const t = s.createTask({ title: 'open review', assignee: ns[0].id });
  s.updateTask(t.id, { status: 'review', awaitingApproval: true }); // approval-gated review: autoAdvanceReviews must not move it

  const logs = [];
  const o = new Orchestrator(s);
  o.on('log', (l) => logs.push(l.text));
  const done = new Promise((resolve) => o.on('done', resolve));
  o.start();
  await done;

  const stop = logs.find((l) => /^Stopped:|^No more todo/.test(l)) || '';
  assert.ok(!/Finished/.test(stop), `run must not claim Finished with a task still in review: "${stop}"`);
  assert.ok(/^Stopped: 1 unfinished task\(s\)/.test(stop) && stop.includes(t.id) && stop.includes('review'), `stop reason must name the stuck task and its state: "${stop}"`);
});
