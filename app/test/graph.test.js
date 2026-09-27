const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager } = require('../src/projects');

function setup() {
  const pm = new ProjectManager(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-graph-')));
  const pid = pm.list()[0].id; const t1 = pm.get(pid).teams[0].id; const t2 = pm.createTeam(pid, 'B').id;
  const a = pm.store(pid, t1).addNode({ name: 'A' }); const b = pm.store(pid, t2).addNode({ name: 'B' });
  return { pm, pid, t1, t2, a, b };
}

test('cross-team edge: validated, persisted in source team, visible to target team, removed with node', () => {
  const { pm, pid, t1, t2, a, b } = setup();
  const e = pm.store(pid, t1).addEdge(a.id, b.id, 'message');
  assert.ok(pm.store(pid, t1).getTeam().edges.some((x) => x.id === e.id));
  assert.deepEqual(pm.store(pid, t2).incomingCrossEdges().map((x) => [x.id, x.crossTeam, x.fromTeam]), [[e.id, true, t1]]);
  assert.ok(pm.store(pid).getTeam().edges.some((x) => x.id === e.id));
  assert.throws(() => pm.store(pid, t1).addEdge(a.id, 'n_nope'), /unknown node/);
  assert.throws(() => pm.store(pid, t2).addEdge(a.id, b.id), /unknown node/); // source must be in this team
  pm.store(pid, t2).removeNode(b.id);
  assert.equal(pm.store(pid, t1).getTeam().edges.length, 0);
});

test('positions and viewport persist per team', () => {
  const { pm, pid, t1, t2, a } = setup();
  pm.store(pid, t1).setPositions({ [a.id]: { x: 300, y: 120 }, bogus: { x: 1, y: 1 } });
  const n = pm.store(pid, t1).getTeam().nodes.find((x) => x.id === a.id);
  assert.deepEqual([n.x, n.y], [300, 120]);
  assert.deepEqual(pm.store(pid, t1).setViewport({ x: -10, y: 5, zoom: 99 }), { x: -10, y: 5, zoom: 4 });
  assert.deepEqual(pm.store(pid, t1).getViewport(), { x: -10, y: 5, zoom: 4 });
  assert.equal(pm.store(pid, t2).getViewport(), null);
});
