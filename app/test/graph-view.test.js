const test = require('node:test');
const assert = require('node:assert');
const { clusterView, mapEdges, CLUSTER_MIN, GROUP_MIN } = require('../src/graph-view');

const N = (id, x = 0, y = 0) => ({ id, name: id, role: 'Dev', x, y });
const E = (from, to, type = 'assign') => ({ id: `${from}>${to}:${type}`, from, to, type });
// One flat "cell" of 6 like the critique fixture: lead + 3 reports, plus a reviewer and a critic
// attached only through message/review edges (no assign edges to them).
const cell = (g) => {
  const ids = [`pm${g}`, `d${g}1`, `d${g}2`, `d${g}3`, `rev${g}`, `crit${g}`];
  const edges = [];
  for (const d of [1, 2, 3]) { edges.push(E(`pm${g}`, `d${g}${d}`), E(`d${g}${d}`, `rev${g}`, 'message'), E(`crit${g}`, `d${g}${d}`, 'review')); }
  edges.push(E(`rev${g}`, `pm${g}`, 'review'));
  return { ids, edges };
};

test(`teams of ${CLUSTER_MIN} or fewer never cluster`, () => {
  const nodes = Array.from({ length: CLUSTER_MIN }, (_, i) => N('n' + i));
  const cv = clusterView(nodes, [], new Set());
  assert.equal(cv.clustered, false);
  assert.equal(cv.nodes, nodes);
  assert.deepEqual(cv.remap, {});
});

test('flat 24-agent team: each 6-agent cell collapses into one cluster card, reviewers/critics absorbed', () => {
  const nodes = [], edges = [];
  for (let g = 0; g < 4; g++) { const c = cell(g); c.ids.forEach((id, i) => nodes.push(N(id, 40 + i * 220, 40 + g * 130))); edges.push(...c.edges); }
  const cv = clusterView(nodes, edges, new Set());
  assert.equal(cv.clustered, true);
  assert.equal(cv.nodes.length, 4);
  assert.ok(cv.nodes.every((n) => n.cluster));
  const members = cv.nodes.flatMap((n) => n.members.map((m) => m.id)).sort();
  assert.deepEqual(members, nodes.map((n) => n.id).sort()); // nobody lost
  assert.ok(Object.keys(cv.remap).length === 24);
  const c0 = cv.nodes.find((n) => n.head === 'pm0');
  assert.equal(c0.name, 'pm0 team'); assert.equal(c0.role, '6 agents');
  assert.deepEqual([c0.x, c0.y], [40, 40]); // card sits at its head's stored position
  const mapped = mapEdges(edges, cv.remap);
  assert.equal(mapped.length, 0); // all intra-group edges dissolve into the cluster
});

test('deep hierarchy: lead + 12 reports collapse into a single cluster', () => {
  const nodes = [N('lead')], edges = [];
  for (let i = 0; i < 12; i++) { nodes.push(N('r' + i)); edges.push(E('lead', 'r' + i)); }
  const cv = clusterView(nodes, edges, new Set());
  assert.equal(cv.nodes.length, 1);
  assert.equal(cv.nodes[0].members.length, 13);
});

test('a node bridging two groups stays individual while both groups collapse', () => {
  const nodes = [], edges = [];
  for (let g = 0; g < 5; g++) { // 5 groups of 3 (lead + 2 reports)
    nodes.push(N(`L${g}`), N(`a${g}`), N(`b${g}`));
    edges.push(E(`L${g}`, `a${g}`), E(`L${g}`, `b${g}`));
  }
  nodes.push(N('bridge')); // reviews reports in group 0 and group 1
  edges.push(E('bridge', 'a0', 'review'), E('bridge', 'a1', 'review'));
  const cv = clusterView(nodes, edges, new Set());
  assert.equal(cv.nodes.length, 6); // 5 clusters + the bridge
  const br = cv.nodes.find((n) => n.id === 'bridge');
  assert.ok(br && !br.cluster);
  const mapped = mapEdges(edges, cv.remap);
  assert.deepEqual(mapped.map((e) => [e.from, e.to]).sort(), [['bridge', 'cl:L0'], ['bridge', 'cl:L1']].sort());
});

test('an expanded head keeps its group visible while the rest collapse', () => {
  const nodes = [], edges = [];
  for (let g = 0; g < 5; g++) { nodes.push(N(`L${g}`), N(`a${g}`), N(`b${g}`)); edges.push(E(`L${g}`, `a${g}`), E(`L${g}`, `b${g}`)); }
  const cv = clusterView(nodes, edges, new Set(['L2']));
  assert.equal(cv.nodes.length, 7); // 4 clusters + L2, a2, b2
  assert.ok(cv.nodes.some((n) => n.id === 'a2' && !n.cluster));
  assert.ok(!cv.nodes.some((n) => n.head === 'L2'));
});

test(`groups smaller than ${GROUP_MIN} stay expanded`, () => {
  const nodes = [], edges = [];
  for (let g = 0; g < 7; g++) { nodes.push(N(`L${g}`), N(`a${g}`)); edges.push(E(`L${g}`, `a${g}`)); } // pairs only
  const cv = clusterView(nodes, edges, new Set());
  assert.equal(cv.clustered, false);
  assert.equal(cv.nodes.length, 14);
});

test('a review chain outside the assign tree collects into its own card-sized group, unclustered', () => {
  const nodes = [], edges = [];
  for (let g = 0; g < 5; g++) { nodes.push(N(`L${g}`), N(`a${g}`), N(`b${g}`)); edges.push(E(`L${g}`, `a${g}`), E(`L${g}`, `b${g}`)); }
  edges.push(E('c2', 'c1', 'review'), E('c1', 'a0', 'review')); // c1 bridges {c2} and group 0 -> stays out
  nodes.push(N('c1'), N('c2'));
  const cv = clusterView(nodes, edges, new Set());
  assert.equal(cv.nodes.length, 7); // 5 clusters + c1 + c2
  assert.deepEqual(cv.nodes.filter((n) => !n.cluster).map((n) => n.id).sort(), ['c1', 'c2']);
});

test('mapEdges rewrites endpoints, drops self-loops and duplicates', () => {
  const edges = [E('a', 'b'), E('b', 'a'), E('a', 'b'), E('a', 'c', 'message')];
  const mapped = mapEdges(edges, { a: 'cl:x', b: 'cl:x' }); // a and b land in the same cluster -> self-loops
  assert.deepEqual(mapped.map((e) => [e.from, e.to, e.type || 'assign']), [['cl:x', 'c', 'message']]);
  const mapped2 = mapEdges([E('a', 'b'), E('a', 'b'), E('b', 'c', 'message')], { b: 'cl:b' });
  assert.deepEqual(mapped2.map((e) => [e.from, e.to, e.type || 'assign']), [['a', 'cl:b', 'assign'], ['cl:b', 'c', 'message']]);
});
