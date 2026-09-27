const test = require('node:test'); const assert = require('node:assert');
const { Orchestrator } = require('../src/orchestrator.js');
test('error log sets agent lastError and emits state immediately', () => {
  const o = Object.create(Orchestrator.prototype); o.agents = {}; o.procs = new Map(); o.store = { appendLog() {} };
  require('events').EventEmitter.call(o); o.totalCost = 0; o.runs = 0;
  let snap = null; o.on('state', (s) => { snap = s; });
  o.log('n1', 'error', 'spawn failed: ENOENT');
  assert.equal(snap.agents.n1.lastError.text, 'spawn failed: ENOENT');
  snap = null; o.log('n1', 'system', 'hi'); assert.equal(snap, null);
});
