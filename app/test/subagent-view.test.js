const test = require('node:test'); const assert = require('node:assert');
const SA = require('../src/subagent-view.js');

const NODE = 'n1';
// Contract shape from Devon (t_c33656ba): records on the owning agent, parentAgentId = node at depth 0
// or another sa_ id when nested; rows gain subagentId on child events.
const rec = (id, parent, over = {}) => ({ id, agentId: NODE, parentAgentId: parent, depth: parent && parent.startsWith('sa_') ? 1 : 0, type: 'task', toolName: 'Task', description: id, startedAt: 1000, endedAt: 2000, status: 'completed', tokens: null, ...over });
const recOfFrom = (recs) => (id) => recs.find((r) => r.id === id);

test('flat rows without subagentId pass through untouched', () => {
  const rows = [{ text: 'a' }, { text: 'b' }];
  assert.deepStrictEqual(SA.nestRows(rows, () => null, NODE), [{ kind: 'row', l: rows[0] }, { kind: 'row', l: rows[1] }]);
});

test('child rows group into one block at the first child event, in time order', () => {
  const rows = [
    { text: 'start', at: 1 },
    { text: 'c1', at: 2, subagentId: 'sa_1' },
    { text: 'parent-between', at: 3 },
    { text: 'c2', at: 4, subagentId: 'sa_1' },
  ];
  const out = SA.nestRows(rows, recOfFrom([rec('sa_1', NODE)]), NODE);
  assert.deepStrictEqual(out.map((x) => x.kind), ['row', 'sub', 'row']);
  assert.strictEqual(out[0].l.text, 'start');
  assert.deepStrictEqual(out[1].rows.map((x) => x.l.text), ['c1', 'c2']);
  assert.strictEqual(out[1].rec.id, 'sa_1');
  assert.strictEqual(out[2].l.text, 'parent-between');
});

test('parallel subagents with interleaved events stay separate (matched by parentAgentId, not order)', () => {
  const recs = [rec('sa_A', NODE), rec('sa_B', NODE)];
  const rows = [
    { text: 'a1', at: 1, subagentId: 'sa_A' },
    { text: 'b1', at: 2, subagentId: 'sa_B' },
    { text: 'a2', at: 3, subagentId: 'sa_A' },
    { text: 'b2', at: 4, subagentId: 'sa_B' },
  ];
  const out = SA.nestRows(rows, recOfFrom(recs), NODE);
  assert.deepStrictEqual(out.map((x) => x.kind), ['sub', 'sub']);
  assert.deepStrictEqual(out[0].rows.map((x) => x.l.text), ['a1', 'a2']);
  assert.deepStrictEqual(out[1].rows.map((x) => x.l.text), ['b1', 'b2']);
});

test('nested subagents: a child of a child nests inside its parent block (depth 2)', () => {
  const recs = [rec('sa_P', NODE), rec('sa_C', 'sa_P'), rec('sa_G', 'sa_C')];
  const rows = [
    { text: 'p1', at: 1, subagentId: 'sa_P' },
    { text: 'c1', at: 2, subagentId: 'sa_C' },
    { text: 'g1', at: 3, subagentId: 'sa_G' },
    { text: 'c2', at: 4, subagentId: 'sa_C' },
    { text: 'p2', at: 5, subagentId: 'sa_P' },
  ];
  const out = SA.nestRows(rows, recOfFrom(recs), NODE);
  assert.deepStrictEqual(out.map((x) => x.kind), ['sub']); // everything nests under the depth-0 parent
  const p = out[0];
  assert.deepStrictEqual(p.rows.map((x) => x.kind), ['row', 'sub', 'row']);
  const c = p.rows[1];
  assert.strictEqual(c.rec.id, 'sa_C');
  // the G block lands at its first child event (between c1 and c2), parent rows keep flowing around it
  assert.deepStrictEqual(c.rows.map((x) => x.kind), ['row', 'sub', 'row']);
  assert.strictEqual(c.rows[1].rec.id, 'sa_G');
  assert.deepStrictEqual(c.rows[1].rows.map((x) => x.l.text), ['g1']);
});

test('unknown records still group top-level with a minimal record; rows inside a known block with no record render as rows', () => {
  const rows = [
    { text: 'x1', at: 1, subagentId: 'sa_unknown' },
    { text: 'x2', at: 2, subagentId: 'sa_unknown' },
  ];
  const out = SA.nestRows(rows, () => undefined, NODE);
  assert.deepStrictEqual(out.map((x) => x.kind), ['sub']);
  assert.strictEqual(out[0].rec.id, 'sa_unknown');
  assert.deepStrictEqual(out[0].rows.map((x) => x.l.text), ['x1', 'x2']);
});

test('durationMs: ended uses endedAt, running uses now, missing start is null', () => {
  assert.strictEqual(SA.durationMs({ startedAt: 1000, endedAt: 2500 }), 1500);
  assert.strictEqual(SA.durationMs({ startedAt: 1000, endedAt: null, status: 'running' }, 4000), 3000);
  assert.strictEqual(SA.durationMs({ startedAt: 1000, endedAt: null, status: 'aborted' }, 4000), null);
  assert.strictEqual(SA.durationMs(null), null);
  assert.strictEqual(SA.durationMs({ endedAt: 2500 }), null);
});

test('tokensLabel: null tokens -> n/a, never 0; values format compactly', () => {
  assert.strictEqual(SA.tokensLabel(null), 'n/a');
  assert.strictEqual(SA.tokensLabel({ inputTokens: null, outputTokens: null }), 'n/a');
  assert.strictEqual(SA.tokensLabel({ inputTokens: 0, outputTokens: 0 }), '0 / 0 tok');
  assert.strictEqual(SA.tokensLabel({ inputTokens: 15000, outputTokens: 2500000 }), '15k / 2.5M tok');
});

test('fmtDuration renders sub-second precision, seconds, then minutes', () => {
  assert.strictEqual(SA.fmtDuration(1500), '1.5s');
  assert.strictEqual(SA.fmtDuration(59000), '59s');
  assert.strictEqual(SA.fmtDuration(84000), '1m 24s');
  assert.strictEqual(SA.fmtDuration(null), '');
});

test('badge: prefers convenience totals, falls back to the records array, empty when absent', () => {
  assert.deepStrictEqual(SA.badge({ subagentCount: 3, subagentTokens: { inputTokens: 10, outputTokens: 20 } }), { count: 3, tokens: { inputTokens: 10, outputTokens: 20 }, label: '🤖 3' });
  assert.strictEqual(SA.badge({ subagents: [rec('sa_1', NODE), rec('sa_2', NODE)] }).count, 2);
  assert.strictEqual(SA.badge({}).count, 0);
  assert.strictEqual(SA.badge({}).label, '');
});
