// Scheduled task reminders (t_22fa32e9): due/repeat/skip-missed math, parsing, and the idle watch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../src/remind');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

const T0 = Date.parse('2026-10-12T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('remind: not due before remindAt; one-shot clears after firing', () => {
  assert.equal(R.due({ remindAt: iso(T0) }, T0 - 1), false);
  assert.equal(R.due({ remindAt: iso(T0) }, T0), true);
  assert.equal(R.due({}, T0), false);
  assert.equal(R.next({ remindAt: iso(T0) }, T0 + 5000), null);
});

test('remind: repeat advances by remindEveryMin and skips missed slots', () => {
  assert.equal(R.next({ remindAt: iso(T0), remindEveryMin: 30 }, T0), iso(T0 + 30 * 60000));
  // 5h downtime: one send, next slot is the first one in the future
  assert.equal(R.next({ remindAt: iso(T0), remindEveryMin: 60 }, T0 + 5 * 3600000 + 1), iso(T0 + 6 * 3600000));
});

test('remind: parse ISO and relative, min repeat 30', () => {
  assert.equal(R.parseAt('+30m', T0), iso(T0 + 30 * 60000));
  assert.equal(R.parseAt('+2h', T0), iso(T0 + 2 * 3600000));
  assert.equal(R.parseAt('2026-10-12T11:00:00Z', T0), '2026-10-12T11:00:00.000Z');
  assert.throws(() => R.parseAt('soon', T0));
  assert.throws(() => R.parseEvery(10));
  assert.equal(R.parseEvery(45), 45);
});

test('remind: orchestrator sweep sends a system message and reschedules', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-remind-'));
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const o = new Orchestrator(s);
  clearInterval(o._wakeTimer); clearInterval(o._stallTimer); clearInterval(o._tickTimer); clearInterval(o._restartTimer); clearInterval(o._remindTimer);
  const t = s.createTask({ title: 'X', assignee: a.id, remindAt: iso(Date.now() - 1000), remindEveryMin: 30 });
  s.updateTask(t.id, { status: 'done' });
  o.sweepReminders();
  const m = s.listMessages({ to: a.id }).find((x) => /Scheduled check/.test(x.text));
  assert.ok(m, 'reminder sent');
  assert.match(m.text, new RegExp(`task ${t.id} 'X' \\(status done\\)`));
  assert.ok(Date.parse(s.getTask(t.id).remindAt) > Date.now(), 'rescheduled into the future');
  o.sweepReminders();
  assert.equal(s.listMessages({ to: a.id }).filter((x) => /Scheduled check/.test(x.text)).length, 1, 'not sent twice');
});

test('watch: runs when no agent is running but tasks are open', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-remind-'));
  const s = new Store(path.join(d, 'p'));
  const a = s.addNode({ name: 'A', role: 'Dev' });
  const o = new Orchestrator(s);
  clearInterval(o._wakeTimer); clearInterval(o._stallTimer); clearInterval(o._tickTimer); clearInterval(o._restartTimer); clearInterval(o._remindTimer);
  o.sweepWatch();
  assert.equal(o.watchStatus().active, false, 'empty board: off');
  s.createTask({ title: 'open', assignee: a.id });
  o.sweepWatch();
  assert.equal(o.watchStatus().active, true, 'quiet board with open work: on');
});

test('schedule_task: assignee/creator/PM only; relative time; clear; create_task params', () => {
  const { makeTools } = require('../src/board-tools');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-remind-'));
  const s = new Store(path.join(d, 'p'));
  const pm = s.addNode({ name: 'PM', role: 'PM' }); const a = s.addNode({ name: 'A', role: 'Dev' }); const b = s.addNode({ name: 'B', role: 'Dev' });
  s.addEdge(pm.id, a.id);
  const tk = makeTools(s, pm.id).create_task({ title: 'x', assignee: a.id, remindAt: '+2h', remindEveryMin: 60 });
  assert.ok(Date.parse(tk.remindAt) > Date.now() + 3500000); assert.equal(tk.remindEveryMin, 60);
  assert.throws(() => makeTools(s, b.id).schedule_task({ taskId: tk.id, remindAt: '+30m' }), /scope/);
  assert.throws(() => makeTools(s, a.id).schedule_task({ taskId: tk.id, remindEveryMin: 5 }), /30/);
  makeTools(s, a.id).schedule_task({ taskId: tk.id, remindAt: '+30m' });
  assert.ok(Date.parse(s.getTask(tk.id).remindAt) < Date.now() + 1900000);
  makeTools(s, pm.id).schedule_task({ taskId: tk.id, clear: true });
  assert.equal(s.getTask(tk.id).remindAt, null);
});
