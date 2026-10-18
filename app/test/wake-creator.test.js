// t_2c11c485: a task's creator (a lead with a multi-step plan) is woken once when the task is done.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

test('creator gets a message + wake on child done, once; none when self-assigned', () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-wakecreator-')));
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const dev = s.addNode({ name: 'Dev', role: 'Dev' });
  const o = new Orchestrator(s);
  const wakes = [];
  o.wakeForHuman = async (id, msgs, why) => { wakes.push({ id, msgs, why }); return true; };
  const child = s.updateTask(s.createTask({ title: 'step 1', assignee: dev.id, createdBy: pm.id }).id, { status: 'done' });
  o.wakeCreatorOnDone(child);
  o.wakeCreatorOnDone(child);
  assert.equal(wakes.length, 1, 'woken exactly once');
  assert.equal(wakes[0].id, pm.id);
  assert.match(wakes[0].msgs[0].text, /step 1.*is done/);
  assert.deepEqual(wakes[0].why.taskIds, [child.id]);
  const self = s.updateTask(s.createTask({ title: 'own', assignee: pm.id, createdBy: pm.id }).id, { status: 'done' });
  o.wakeCreatorOnDone(self);
  const open = s.createTask({ title: 'open', assignee: dev.id, createdBy: pm.id });
  o.wakeCreatorOnDone(open);
  const human = s.updateTask(s.createTask({ title: 'h', assignee: dev.id, createdBy: 'human' }).id, { status: 'done' });
  o.wakeCreatorOnDone(human);
  assert.equal(wakes.length, 1, 'no wake for self-assigned, open, or non-node creator');
});
