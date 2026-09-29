// t_8df2cab6: review hand-off chain (review-edge reviewer -> assignee's lead -> ask_human), the
// review watchdog (a task stale in review with an idle reviewer is re-woken once, then falls back
// down the chain, then parks for a human), and the idle-company wake (every agent idle while open
// work remains wakes each task's owner or their lead). No real-model runs: wakes are stubbed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const IDLE = require('../src/idle');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const MIN = 60000;

// Store re-reads task files on every call, so a test can backdate updatedAt by patching the file.
const backdate = (s, tid, minutesAgo) => {
  const f = s.taskFile(tid);
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  t.updatedAt = new Date(Date.now() - minutesAgo * MIN).toISOString();
  fs.writeFileSync(f, JSON.stringify(t, null, 2));
};

const reviewTask = (s, tid) => s.updateTask(tid, { status: 'review' });

// ---- chain pick: review-edge reviewer -> assignee's lead -> ask_human ----

test('chain: a review edge to the assignee wins', () => {
  const s = new Store(tmp('squad-chain1-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  s.addEdge(dev.id, rev.id, 'review');
  s.addEdge(pm.id, dev.id);
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  const o = new Orchestrator(s);
  const out = o.autoAdvanceReviews(s.getTeam());
  assert.equal(out.length, 1);
  assert.equal(out[0].node.id, rev.id, 'the review-edge reviewer is the first chain link');
  assert.equal(s.getTask(t.id).status, 'review');
});

test('chain: no review edge falls back to the assignee\'s lead', () => {
  const s = new Store(tmp('squad-chain2-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  s.addEdge(pm.id, dev.id); // assign edge: pm is dev's lead
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  const o = new Orchestrator(s);
  const out = o.autoAdvanceReviews(s.getTeam());
  assert.equal(out.length, 1);
  assert.equal(out[0].node.id, pm.id, 'without a review edge the lead picks up the review');
});

test('chain: neither reviewer nor lead asks the human (stays in review, surfaced once)', () => {
  const s = new Store(tmp('squad-chain3-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  const o = new Orchestrator(s);
  assert.equal(o.autoAdvanceReviews(s.getTeam()).length, 0);
  const after = s.getTask(t.id);
  assert.equal(after.status, 'review');
  assert.equal(after.awaitingApproval, undefined, 'not approval-gated: no human gate is forced here');
  assert.ok(after.comments.some((c) => /no reviewer is configured/.test(c.text)));
  o.autoAdvanceReviews(s.getTeam()); // second sweep: surfaced once, no duplicate comment
  assert.equal(s.getTask(t.id).comments.filter((c) => /no reviewer is configured/.test(c.text)).length, 1);
});

// ---- watchdog: stale review + idle reviewer -> re-wake, then fall back, then ask_human ----

test('watchdog: a fresh review with an idle reviewer is left alone', () => {
  const s = new Store(tmp('squad-wd1-'));
  s.saveSettings({ stallTimeoutMin: 10 });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(dev.id, rev.id, 'review');
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  const o = new Orchestrator(s);
  o.running = true;
  const woken = []; o.wakeForHuman = async (nodeId) => { woken.push(nodeId); return true; };
  o.sweepReviews();
  assert.deepEqual(woken, [], 'inside the window no reviewer is woken');
  assert.equal(o._reviewWatch.get(t.id).wakes, 0, 'no wake is recorded before the deadline');
});

test('watchdog: a stale review with an idle reviewer re-wakes that reviewer once', () => {
  const s = new Store(tmp('squad-wd2-'));
  s.saveSettings({ stallTimeoutMin: 10 });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(dev.id, rev.id, 'review');
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  backdate(s, t.id, 15);
  const o = new Orchestrator(s);
  o.running = true;
  const woken = []; o.wakeForHuman = async (nodeId, msgs, why) => { woken.push({ nodeId, why, text: msgs[0].text }); return true; };
  o.sweepReviews();
  assert.equal(woken.length, 1, 'the idle reviewer is re-woken');
  assert.equal(woken[0].nodeId, rev.id);
  assert.equal(woken[0].why.reason, 'review overdue');
  assert.deepEqual(woken[0].why.taskIds, [t.id]);
  assert.ok(s.listMessages({ to: rev.id }).some((m) => m.text.includes(t.id)), 'the reviewer gets a pointer to the task');
  assert.equal(o._reviewWatch.get(t.id).wakes, 1, 'the re-wake is recorded so it fires once per window');
  o.sweepReviews();
  assert.equal(woken.length, 1, 'no re-wake churn inside the same window');
});

test('watchdog: a busy reviewer is left alone', () => {
  const s = new Store(tmp('squad-wd3-'));
  s.saveSettings({ stallTimeoutMin: 10 });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(dev.id, rev.id, 'review');
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  backdate(s, t.id, 15);
  const o = new Orchestrator(s);
  o.running = true;
  o.agent(rev.id).status = 'working';
  const woken = []; o.wakeForHuman = async (nodeId) => { woken.push(nodeId); return true; };
  o.sweepReviews();
  assert.deepEqual(woken, [], 'a working reviewer may still pick the task up; no watchdog action');
});

test('watchdog: after a re-wake with still no action the review falls back to the lead', () => {
  const s = new Store(tmp('squad-wd4-'));
  s.saveSettings({ stallTimeoutMin: 10 });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  s.addEdge(dev.id, rev.id, 'review');
  s.addEdge(pm.id, dev.id);
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  backdate(s, t.id, 15);
  const o = new Orchestrator(s);
  o.running = true;
  o._reviewWatch.set(t.id, { link: 0, wakes: 1, lastWakeAt: Date.now() - 15 * MIN }); // woken once, long ago
  const woken = []; o.wakeForHuman = async (nodeId) => { woken.push(nodeId); return true; };
  o.sweepReviews();
  assert.deepEqual(woken, [], 'the same reviewer is not re-woken twice: the chain advances instead');
  const st = o._reviewWatch.get(t.id);
  assert.equal(st.link, 1, 'the lead is now the current chain link');
  assert.equal(st.wakes, 0, 'the new link starts with a fresh wake budget');
  assert.ok(s.getTask(t.id).comments.some((c) => /falls back to PM/.test(c.text)), 'the hand-off is commented on the task');
  const out = o.autoAdvanceReviews(s.getTeam());
  assert.equal(out.length, 1);
  assert.equal(out[0].node.id, pm.id, 'dispatch follows the fallback: the lead picks up the review');
});

test('watchdog: an exhausted chain parks the task for a human, once', () => {
  const s = new Store(tmp('squad-wd5-'));
  s.saveSettings({ stallTimeoutMin: 10 });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(dev.id, rev.id, 'review'); // reviewer, but no lead: the chain ends after the re-wake
  const t = reviewTask(s, s.createTask({ title: 'work', assignee: dev.id }).id);
  backdate(s, t.id, 15);
  const o = new Orchestrator(s);
  o.running = true;
  o._reviewWatch.set(t.id, { link: 0, wakes: 1, lastWakeAt: Date.now() - 15 * MIN });
  const woken = []; o.wakeForHuman = async (nodeId) => { woken.push(nodeId); return true; };
  o.sweepReviews();
  const after = s.getTask(t.id);
  assert.equal(after.awaitingApproval, true, 'nobody left to review: ask_human');
  assert.ok(after.comments.some((c) => /Review watchdog/.test(c.text) && /human/.test(c.text)));
  const n = after.comments.length;
  o.sweepReviews();
  assert.equal(s.getTask(t.id).comments.length, n, 'escalation is surfaced once');
  assert.deepEqual(woken, []);
});

// ---- idle company wake: everyone idle + open work -> wake the owner / their lead ----

test('company: all idle with an open task wakes the owner', () => {
  const s = new Store(tmp('squad-co1-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: dev.id });
  const wakes = IDLE.idleCompanyWakes(s.getTeam(), s.listTasks(), {});
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].nodeId, dev.id, 'the task owner is woken');
  assert.deepEqual(wakes[0].taskIds, [t.id]);
  assert.equal(wakes[0].kind, 'company');
});

test('company: a budget-stopped owner escalates to their lead', () => {
  const s = new Store(tmp('squad-co2-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  s.addEdge(pm.id, dev.id);
  s.createTask({ title: 'over budget', assignee: dev.id });
  const wakes = IDLE.idleCompanyWakes(s.getTeam(), s.listTasks(), { [dev.id]: { status: 'idle', budgetStop: 'over budget' } });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].nodeId, pm.id, 'the owner cannot be woken: the lead is');
});

test('company: a busy agent means no company wake', () => {
  const s = new Store(tmp('squad-co3-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  s.createTask({ title: 'work', assignee: dev.id });
  const wakes = IDLE.idleCompanyWakes(s.getTeam(), s.listTasks(), { [dev.id]: { status: 'working' } });
  assert.deepEqual(wakes, [], 'someone is still working: not an idle company');
});

test('company: human-gated and review tasks never wake agents', () => {
  const s = new Store(tmp('squad-co4-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' });
  s.addEdge(dev.id, rev.id, 'review');
  const a = s.createTask({ title: 'waiting', assignee: dev.id });
  s.updateTask(a.id, { status: 'waiting_for_human' });
  const b = reviewTask(s, s.createTask({ title: 'in review', assignee: dev.id }).id);
  s.updateTask(b.id, { parkedForHuman: true });
  const c = reviewTask(s, s.createTask({ title: 'open review', assignee: dev.id }).id);
  assert.deepEqual(IDLE.idleCompanyWakes(s.getTeam(), s.listTasks(), {}),
    [], 'review hand-offs belong to the review watchdog, human-gated tasks to humans');
  assert.ok(s.getTask(c.id).status === 'review');
});

test('company: nothing open means nothing to wake', () => {
  const s = new Store(tmp('squad-co5-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const t = s.createTask({ title: 'done work', assignee: dev.id });
  s.updateTask(t.id, { status: 'done' });
  assert.deepEqual(IDLE.idleCompanyWakes(s.getTeam(), s.listTasks(), {}), []);
});

test('nudgeIdle delivers the company wake to the owner and debounces the same set', () => {
  const s = new Store(tmp('squad-co6-'));
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const t = s.createTask({ title: 'stuck work', assignee: dev.id });
  const o = new Orchestrator(s);
  const woken = []; o.wakeForHuman = async (nodeId, msgs, why) => { woken.push({ nodeId, why }); return true; };
  o.nudgeIdle();
  assert.equal(woken.length, 1);
  assert.equal(woken[0].nodeId, dev.id);
  assert.equal(woken[0].why.reason, 'idle company with open work');
  assert.equal(woken[0].why.action, 'wake owner');
  assert.deepEqual(woken[0].why.taskIds, [t.id]);
  o.nudgeIdle();
  assert.equal(woken.length, 1, 'the same idle set does not re-wake');
});
