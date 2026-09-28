// t_72309c30: one function anywhere in a state push / getAll payload fails Electron's structured
// clone and the message is dropped ("Failed to serialize arguments") — the renderer then never
// updates, and a UI freshly booted by a self-restart stays blank forever. The live run record
// (a.currentRun) carried a SubagentTracker whose .now is a function; snapshotSlim() must project
// agents to clone-safe data.
const test = require('node:test'); const assert = require('node:assert');
const { Orchestrator } = require('../src/orchestrator.js');
const { SubagentTracker } = require('../src/subagents.js');

const orch = () => {
  const o = Object.create(Orchestrator.prototype); o.agents = {}; o.procs = new Map(); o.store = { appendLog() {} };
  require('events').EventEmitter.call(o); o.totalCost = 0; o.runs = 0;
  return o;
};
const hasFunction = (v, seen = new Set()) => {
  if (typeof v === 'function') return true;
  if (!v || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  return Object.values(v).some((x) => hasFunction(x, seen));
};

test('state payload is structured-cloneable while a run is live (t_72309c30)', () => {
  const o = orch();
  const run = { sessionId: 's1', result: '', usage: {} };
  run.subs = new SubagentTracker('n1'); // owns .now = function: the poison
  run.stall = { state: 'stalled', attempt: 1, max: 2, taskId: 't1' };
  o.agents.n1 = { status: 'working', pendingHuman: [], currentRun: run };
  o.agents.idle = { status: 'idle', pendingHuman: [], currentRun: null };
  let snap = null; o.on('state', (s) => { snap = s; });
  o.changed();
  assert.ok(snap, 'changed() emitted');
  const clone = structuredClone(snap); // must not throw
  assert.equal(clone.agents.n1.run.sessionId, 's1');
  assert.deepEqual(clone.agents.n1.run.stall, { state: 'stalled', attempt: 1, max: 2, taskId: 't1' });
  assert.ok(!hasFunction(snap), 'no function values anywhere in the payload');
  // projection exposes only what the renderer reads off a.run — not the tracker or the raw record
  assert.deepEqual(Object.keys(snap.agents.n1.run).sort(), ['sessionId', 'stall']);
  assert.ok(!('currentRun' in snap.agents.n1), 'raw currentRun stays off the wire');
  assert.equal(snap.agents.idle.run, undefined, 'idle agent has no run field');
});

test('raw run record with a SubagentTracker cannot cross structured clone (why this exists)', () => {
  const run = { sessionId: 's1', result: '', usage: {} };
  run.subs = new SubagentTracker('n1');
  const old = { agents: { n1: { status: 'working', pendingHuman: 0, currentRun: run } } };
  assert.throws(() => structuredClone(old), /could not be cloned|serialize/i);
});
