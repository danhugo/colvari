const test = require('node:test'); const assert = require('node:assert');
const { Orchestrator } = require('../src/orchestrator.js');

// Regression for: Refresh restores a stale categorized:[] (Modes 0) even though slashCommands includes
// /goal, /loop, because discoverCapabilities/orchestrator copied prevCap.categorized verbatim instead of
// recomputing it from the snapshot's own slashCommands. Exercises the actual IPC/orchestrator merge path
// (Orchestrator.onEvent's init-event handler), not just the pure CAP.discoverCapabilities helper.
test('orchestrator onEvent init-event merge recomputes categorized so goal/loop show up as modes', () => {
  const updates = [];
  const o = Object.create(Orchestrator.prototype);
  o.agents = {}; o.procs = new Map(); o.totalCost = 0; o.runs = 0;
  require('events').EventEmitter.call(o);
  o.store = {
    appendLog() {},
    getSettings: () => ({}),
    updateNode: (id, patch) => updates.push(patch),
  };
  const node = {
    id: 'n1',
    runtime: 'claude',
    // A stale init-event snapshot: real slashCommands incl. /goal /loop, but modes/categorized were never
    // derived (the exact shape reported: Modes 0, Skills 58).
    capabilities: { source: 'init-event', slashCommands: ['/goal', '/loop', '/review'], skills: Array(58).fill(0).map((_, i) => `skill${i}`), modes: [], categorized: [] },
  };
  const ev = {
    type: 'system', subtype: 'init', model: 'claude-x',
    slash_commands: ['/goal', '/loop', '/review'],
    mcp_servers: [],
  };
  o.onEvent(node, JSON.stringify(ev), null, 'claude');
  assert.ok(updates.length, 'store.updateNode called');
  const cap = updates[updates.length - 1].capabilities;
  const modeNames = cap.categorized.filter((x) => x.category === 'mode').map((x) => x.name);
  assert.ok(modeNames.includes('goal') && modeNames.includes('loop'), modeNames);
  assert.ok(cap.modes.includes('goal') && cap.modes.includes('loop'), cap.modes);
});
