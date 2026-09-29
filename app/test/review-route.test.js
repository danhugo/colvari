// Review routing, review watchdog, idle-company wake (t_8df2cab6):
//   routing  : review-edge agent (live, never the assignee) -> assignee's lead -> human approval
//   watchdog : review waiting > reviewWatchdogMin with an idle reviewer -> re-wake (x2) -> escalate
//   company  : Run up, nothing running anywhere, workable todo -> wake the task owner's lead
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const IDLE = require('../src/idle');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rrev-'));

// Pia (lead) -> Dev, Dev -> Rev (review edge): the canonical graph.
const setup = () => {
  const s = new Store(path.join(tmp(), 'p'));
  const pm = s.addNode({ name: 'Pia', role: 'PM' });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(pm.id, dev.id);
  s.addEdge(dev.id, rev.id, 'review');
  const o = new Orchestrator(s);
  clearInterval(o._wakeTimer); clearInterval(o._stallTimer);
  o.running = true;
  return { s, o, pm, dev, rev };
};

// ---- pickReviewer: pure routing branches ----

test('pickReviewer: review edge wins; lead next; human last; stage skips routes', () => {
  const { s, pm, dev, rev } = setup();
  const team = s.getTeam();
  const t = s.createTask({ title: 'x', assignee: dev.id, createdBy: pm.id });
  assert.deepEqual(
    { reviewer: IDLE.pickReviewer(team, t).reviewer.id, route: IDLE.pickReviewer(team, t).route },
    { reviewer: rev.id, route: 'review' },
  );
  // no review edge anywhere -> the lead
  s.updateEdge(s.getTeam().edges.find((e) => e.type === 'review').id, { type: 'message' });
  assert.equal(IDLE.pickReviewer(s.getTeam(), t).route, 'lead');
  assert.equal(IDLE.pickReviewer(s.getTeam(), t).reviewer.id, pm.id);
  // no edges at all -> human
  for (const e of s.getTeam().edges) s.removeEdge(e.id);
  assert.equal(IDLE.pickReviewer(s.getTeam(), t).route, 'human');
});

test('pickReviewer: never self-review, skips vanished (retired) and unavailable agents', () => {
  // Hand-built team: Dev has ONLY a self review edge (store forbids self edges, the graph is
  // hand-merged here) — self must be skipped all the way to 'human'.
  const selfTeam = { nodes: [{ id: 'A', name: 'A' }], edges: [{ from: 'A', to: 'A', type: 'review' }] };
  const task = { id: 't', assignee: 'A' };
  assert.equal(IDLE.pickReviewer(selfTeam, task).route, 'human');
  // retired = removed from the team: a review edge to a gone node must not route there.
  const gone = { nodes: [{ id: 'A', name: 'A' }, { id: 'L', name: 'L' }], edges: [{ from: 'A', to: 'GONE', type: 'review' }, { from: 'L', to: 'A', type: 'assign' }] };
  const r = IDLE.pickReviewer(gone, task);
  assert.equal(r.route, 'lead');
  assert.equal(r.reviewer.id, 'L');
  // availability injection: an unavailable lead falls through to human.
  assert.equal(IDLE.pickReviewer(gone, task, (n) => n.id !== 'L').route, 'human');
  // stage: 1 skips a live review-edge reviewer (already re-woken, never came), 2 goes to the human.
  const { s, pm, dev, rev } = setup();
  const t2 = s.createTask({ title: 'y', assignee: dev.id, createdBy: pm.id });
  assert.equal(IDLE.pickReviewer(s.getTeam(), t2, () => true, 1).route, 'lead');
  assert.equal(IDLE.pickReviewer(s.getTeam(), t2, () => true, 2).route, 'human');
});

// ---- autoAdvanceReviews: dispatch routing ----

test('autoAdvanceReviews: routes to reviewer, then lead, then human gate', () => {
  const { s, o, pm, dev, rev } = setup();
  const t = s.createTask({ title: 'w', assignee: dev.id, createdBy: pm.id });
  s.updateTask(t.id, { status: 'review' });
  let picks = o.autoAdvanceReviews(s.getTeam());
  assert.equal(picks.length, 1);
  assert.equal(picks[0].node.id, rev.id);
  assert.equal(picks[0].route, 'review');

  // review edge demoted: the lead (Pia) reviews instead.
  s.updateEdge(s.getTeam().edges.find((e) => e.type === 'review').id, { type: 'message' });
  picks = o.autoAdvanceReviews(s.getTeam());
  assert.equal(picks[0].node.id, pm.id);
  assert.equal(picks[0].route, 'lead');

  // no candidates at all: surfaced once, and gated when the project requires approval.
  for (const e of s.getTeam().edges) s.removeEdge(e.id);
  s.saveSettings({ requireApproval: true });
  picks = o.autoAdvanceReviews(s.getTeam());
  assert.equal(picks.length, 0);
  const r = s.getTask(t.id);
  assert.equal(r.status, 'review');
  assert.equal(r.awaitingApproval, true, 'the human approval gate is armed (ask_human semantics)');
  assert.equal(r.reviewStage, 2);
  assert.ok(r.comments.some((c) => /no reviewer is available/.test(c.text)));
  assert.ok(s.listInbox({ status: 'open' }).some((i) => i.kind === 'approval' && i.taskId === t.id), 'approval inbox item exists');
  assert.equal(o.autoAdvanceReviews(s.getTeam()).length, 0, 'no repeat: the gate holds the task');
});

// ---- sweepReviews: watchdog with a fake clock ----

test('sweepReviews: re-wakes an idle reviewer twice, then escalates lead, then human', () => {
  const { s, o, pm, dev, rev } = setup();
  s.saveSettings({ reviewWatchdogMin: 1 });
  const t = s.createTask({ title: 'stale review', assignee: dev.id, createdBy: pm.id });
  s.updateTask(t.id, { status: 'review' });
  const wakes = [];
  o.wakeForHuman = async (id, msgs, why) => { wakes.push([id, why.action]); return true; };

  const advance = (min) => { const real = Date.now; Date.now = () => real.call(Date) + min * 60000; try { o.sweepReviews(); } finally { Date.now = real; } };

  advance(2); // overdue -> first reminder to the reviewer
  assert.equal((s.getTask(t.id).reviewWakes || 0), 1);
  assert.ok(s.listMessages({ to: rev.id }).some((m) => /review reminder/.test(m.text)));
  assert.deepEqual(wakes, [[rev.id, 'wake reviewer']]);

  advance(0.5); // inside the window anchored on the last wake: no second wake yet
  assert.equal((s.getTask(t.id).reviewWakes || 0), 1);
  advance(2); // second reminder
  assert.equal((s.getTask(t.id).reviewWakes || 0), 2);
  assert.equal(wakes.length, 2);

  advance(2); // twice reminded -> escalate to the lead, wake the LEAD (not the reviewer again)
  let r = s.getTask(t.id);
  assert.equal(r.reviewStage, 1);
  assert.equal(r.reviewWakes, 0, 'wake budget resets for the new route');
  assert.ok(r.comments.some((c) => /escalating to the assignee's lead/.test(c.text)));
  advance(2); // the lead's window: the LEAD is woken now (not the old reviewer again)
  assert.deepEqual(wakes[2], [pm.id, 'wake reviewer']);
  assert.ok(s.listMessages({ to: pm.id }).some((m) => /review reminder/.test(m.text)));

  advance(2); advance(2); // lead also ignores twice -> stage 2
  r = s.getTask(t.id);
  assert.equal(r.reviewStage, 2);
  advance(2); // stage 2 has no candidates: parked for the human gate, no more wakes
  const gateWakes = wakes.length;
  o.autoAdvanceReviews(s.getTeam());
  assert.equal(s.getTask(t.id).awaitingApproval, true, 'no lead left: human approval gate');
  advance(2);
  assert.equal(wakes.length, gateWakes, 'no further wakes once gated');
});

test('sweepReviews: busy or claimed reviewer is never re-woken; disabled setting no-ops', () => {
  const { s, o, pm, dev, rev } = setup();
  s.saveSettings({ reviewWatchdogMin: 1 });
  const t = s.createTask({ title: 'busy', assignee: dev.id, createdBy: pm.id });
  s.updateTask(t.id, { status: 'review' });
  const wakes = [];
  o.wakeForHuman = async () => { wakes.push(1); return true; };
  const advance = (min) => { const real = Date.now; Date.now = () => real.call(Date) + min * 60000; try { o.sweepReviews(); } finally { Date.now = real; } };

  o.agent(rev.id).status = 'working'; // reviewer mid-run on something else
  advance(2);
  assert.equal(wakes.length, 0);
  o.agents[rev.id].status = 'idle';
  o.procs.set(rev.id, { kill() {} }); // or holds a live process slot
  advance(2);
  assert.equal(wakes.length, 0);
  o.procs.clear();

  s.saveSettings({ reviewWatchdogMin: 0 }); // <=0 disables the watchdog
  advance(2);
  assert.equal(wakes.length, 0);
  assert.equal((s.getTask(t.id).reviewWakes || 0), 0);
});

// ---- idle company: workable open work wakes the owner's lead ----

test('idleNudges: open-work entry goes to the lead, only for genuinely workable tasks', () => {
  const { s, pm, dev } = setup();
  const ok = s.createTask({ title: 'ready', assignee: dev.id, createdBy: dev.id }); // dev-created: not covered by the PM's own idle nudge
  const blocked = s.createTask({ title: 'blocked', assignee: dev.id, createdBy: dev.id, blockedBy: [ok.id] });
  const gated = s.createTask({ title: 'gated', assignee: dev.id, createdBy: dev.id });
  s.updateTask(gated.id, { status: 'waiting_for_human' });
  const pmGoal = s.createTask({ title: 'pm own', assignee: pm.id, createdBy: pm.id }); // covered by the PM idle nudge
  const team = s.getTeam();
  const entries = IDLE.idleNudges(team, s.listTasks(), {}, { companyIdle: true });
  const open = entries.filter((e) => e.kind === 'open');
  assert.equal(open.length, 1, 'exactly one open entry (work reachable, nothing double-covered)');
  assert.equal(open[0].pmId, pm.id);
  assert.deepEqual(open[0].taskIds, [ok.id], 'blocked, gated and PM-covered tasks are excluded');
  // company busy (no live runs per orchestrator) -> no entry at all
  assert.equal(IDLE.idleNudges(team, s.listTasks(), {}, {}).filter((e) => e.kind === 'open').length, 0);
  // a leadless assignee falls back to the core node
  const solo = s.addNode({ name: 'Solo', role: 'Dev' });
  const soloTask = s.createTask({ title: 'solo work', assignee: solo.id, createdBy: solo.id });
  const open2 = IDLE.idleNudges(team, s.listTasks(), {}, { companyIdle: true }).filter((e) => e.kind === 'open');
  assert.equal(open2.length, 1, 'same target: entries merge');
  assert.ok(open2[0].taskIds.includes(soloTask.id), 'the leadless task is reported');
  assert.ok(open2[0].taskIds.includes(ok.id));
  assert.equal(open2[0].pmId, pm.id, 'the root PM is the core fallback');
});

test('nudgeIdle: open work wakes the lead once, then the condition debounce holds', () => {
  const { s, o, pm, dev } = setup();
  const t = s.createTask({ title: 'open work', assignee: dev.id, createdBy: dev.id }); // dev-created: the PM idle nudge does not cover it
  const wakes = [];
  o.wakeForHuman = async (id, msgs, why) => { wakes.push([id, why.reason, why.action]); return true; };
  o.nudgeIdle();
  assert.ok(s.listMessages({ to: pm.id }).some((m) => /ready but nobody is working/.test(m.text)), 'system message stored');
  assert.ok(wakes.some((w) => w[0] === pm.id && w[1] === 'open work with everyone idle' && w[2] === 'wake lead'), 'the open-work condition wakes the lead');
  const afterFirst = wakes.length;
  o.nudgeIdle(); // same condition, nothing changed: no repeat
  assert.equal(wakes.length, afterFirst);
  // a dispatch happened (live run anywhere): the condition is off, no new wakes even if keys change
  o.procs.set(dev.id, { kill() {} });
  const before = s.listMessages({ to: pm.id }).length;
  s.createTask({ title: 'more work', assignee: dev.id, createdBy: dev.id });
  o.nudgeIdle();
  assert.equal(s.listMessages({ to: pm.id }).length, before);
});
