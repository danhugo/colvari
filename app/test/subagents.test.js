// Subagent detection (t_c33656ba): Agent/Task tool_use -> record, parent_tool_use_id scoping,
// per-subagent tokens, run-end abort/persistence. Fixtures are REAL captured streams:
// subagents-claude.jsonl (claude 2.1.283, two parallel Agent spawns) and
// subagents-helpycode.jsonl (helpycode 0.3.5, two parallel task-tool parts).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const U = require('../src/usage');
const { normalizeNode } = require('../src/agent-config');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const { SubagentTracker, isSubagentTool, subagentId } = require('../src/subagents');
const RT = require('../src/runtimes');
const { logEntries } = require('../src/timeline');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const CLAUDE_EVENTS = fixture('subagents-claude.jsonl');
const HC_EVENTS = fixture('subagents-helpycode.jsonl');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-subs-'));
  const s = new Store(path.join(dir, 'p'));
  const n = s.addNode(normalizeNode({ name: 'Dev', role: 'Dev' }));
  const o = new Orchestrator(s);
  return { s, n, o };
}
// A run object shaped like spawnRun's (tracker attached), so onEvent can be driven directly.
function fakeRun(n) {
  const run = { sessionId: null, result: '', usage: U.newRun({ nodeId: n.id, agent: n.name }) };
  run.subs = new SubagentTracker(n.id);
  return run;
}

test('isSubagentTool + subagentId basics', () => {
  assert.ok(isSubagentTool('Task') && isSubagentTool('Agent') && isSubagentTool('task'));
  assert.ok(!isSubagentTool('Bash') && !isSubagentTool('TaskCreate'));
  assert.equal(subagentId('toolu_abc-1'), 'sa_toolu_abc-1');
});

test('real claude stream: two parallel subagents detected, tagged, tokenized, closed by their tool_results', () => {
  const { n, o } = setup();
  const run = fakeRun(n);
  const logs = [];
  o.on('log', (l) => logs.push(l));
  const subagentEvents = [];
  o.on('subagent', (e) => subagentEvents.push(e));
  for (const ev of CLAUDE_EVENTS) o.onEvent(n, JSON.stringify(ev), run, 'claude');
  const a = o.agent(n.id);
  assert.equal(a.subagents.length, 2);
  assert.equal(a.subagentCount, 2);
  const [alpha, beta] = a.subagents; // order of their Agent tool_use events in the stream
  assert.equal(alpha.id, 'sa_toolu_014gMoqPzoGn68taFaAahiA1');
  assert.equal(beta.id, 'sa_toolu_01BVqVhWCP4dPKnx2hCfptxs');
  for (const rec of [alpha, beta]) {
    assert.equal(rec.status, 'completed');
    assert.equal(rec.agentId, n.id);
    assert.equal(rec.parentAgentId, n.id);
    assert.equal(rec.depth, 0);
    assert.equal(rec.type, 'agent');
    assert.equal(rec.toolName, 'Agent');
    assert.ok(rec.parentToolUseId === undefined);
    assert.ok(rec.startedAt > 0 && rec.endedAt >= rec.startedAt);
  }
  assert.equal(alpha.description, 'Run alpha echo command');
  assert.equal(beta.description, 'Run beta echo command');
  // Child assistant turns reported their own message usage (10 in / 4 out each); parents' totals unchanged.
  assert.deepEqual(alpha.tokens, { inputTokens: 10, outputTokens: 4 });
  assert.deepEqual(beta.tokens, { inputTokens: 10, outputTokens: 4 });
  assert.deepEqual(a.subagentTokens, { inputTokens: 20, outputTokens: 8 });
  // Breakdown, not addition: agent inputTokens (claude path) are only touched by result events, none seen.
  assert.equal(a.inputTokens, 0); assert.equal(a.outputTokens, 0);
  // 2 starts + 2 ends signalled live.
  assert.equal(subagentEvents.length, 4);
  assert.equal(subagentEvents[0].record.status, 'running');
  assert.equal(subagentEvents[3].record.status, 'completed');
  // Child rows carry subagentId; the parent-level Agent tool_use row does not.
  const childRows = logs.filter((l) => l.subagentId);
  assert.ok(childRows.some((l) => l.subagentId === alpha.id && l.kind === 'tool'));
  assert.ok(childRows.every((l) => l.subagentId === alpha.id || l.subagentId === beta.id));
  assert.ok(logs.some((l) => !l.subagentId && l.kind === 'tool' && l.text.startsWith('Agent ')));
  // Children matched by id, not arrival order: beta's child rows exist despite interleaving.
  assert.ok(childRows.some((l) => l.subagentId === beta.id));
});

test('claude: is_error tool_result marks the subagent failed', () => {
  const { n, o } = setup();
  const run = fakeRun(n);
  o.onEvent(n, JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_p', content: [{ type: 'tool_use', name: 'Task', id: 'toolu_T1', input: { description: 'boom', prompt: 'p', subagent_type: 'general-purpose' } }] } }), run, 'claude');
  o.onEvent(n, JSON.stringify({ type: 'user', parent_tool_use_id: 'toolu_T1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: false, content: 'ok' }] } }), run, 'claude');
  o.onEvent(n, JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_T1', is_error: true, content: 'subagent failed' }] } }), run, 'claude');
  const a = o.agent(n.id);
  assert.equal(a.subagents.length, 1);
  assert.equal(a.subagents[0].status, 'failed');
  assert.equal(a.subagents[0].type, 'task');
  assert.equal(a.subagents[0].tokens, null); // no child usage reported -> n/a, not 0
});

test('claude: child turns do not clobber the agent context, and usage dedupes by message id', () => {
  const { n, o } = setup();
  const run = fakeRun(n);
  o.onEvent(n, JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_p', model: 'claude-sonnet-5', usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Task', id: 'toolu_T1', input: { description: 'd', prompt: 'p' } }] } }), run, 'claude');
  assert.equal(o.agent(n.id).contextTokens, 1000);
  // Same child message emitted twice (content blocks) with identical usage: counted once.
  const child = { type: 'assistant', parent_tool_use_id: 'toolu_T1', message: { id: 'msg_c1', model: 'claude-haiku-4-5', usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 }, content: [{ type: 'text', text: 'working' }] } };
  o.onEvent(n, JSON.stringify(child), run, 'claude');
  o.onEvent(n, JSON.stringify(child), run, 'claude');
  assert.equal(o.agent(n.id).contextTokens, 1000); // child turn left the parent's context alone
  assert.deepEqual(o.agent(n.id).subagents[0].tokens, { inputTokens: 50, outputTokens: 7 });
});

test('claude: nesting - a Task inside a subagent gets depth 1 and a subagent parentAgentId', () => {
  const { n, o } = setup();
  const run = fakeRun(n);
  o.onEvent(n, JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Task', id: 'toolu_outer', input: { description: 'outer', prompt: 'p' } }] } }), run, 'claude');
  o.onEvent(n, JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_outer', message: { id: 'm2', content: [{ type: 'tool_use', name: 'Task', id: 'toolu_inner', input: { description: 'inner', prompt: 'q' } }] } }), run, 'claude');
  o.onEvent(n, JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_inner', message: { id: 'm3', usage: { input_tokens: 3, output_tokens: 1 }, content: [{ type: 'text', text: 'deep' }] } }), run, 'claude');
  const [outer, inner] = o.agent(n.id).subagents;
  assert.equal(outer.depth, 0);
  assert.equal(inner.depth, 1);
  assert.equal(inner.parentAgentId, outer.id);
  assert.equal(inner.parentToolUseId, 'toolu_outer'); // the Agent call that spawned it
  assert.deepEqual(inner.tokens, { inputTokens: 3, outputTokens: 1 }); // grandchild usage accrues to its direct parent
  assert.equal(outer.tokens, null); // not to the grandparent
});

test('real helpycode stream: task tool parts surface as completed subagents with child session ids', () => {
  const { n, o } = setup();
  // Stub runtime so the profile path runs without introspecting a real binary.
  RT.RUNTIMES.stubsub = { id: 'stubsub', parseEvent: (ev) => RT.parseProfileEvent(ev, { label: 'Stub', eventMapping: {} }) };
  try {
    const run = fakeRun(n);
    for (const ev of HC_EVENTS) o.onEvent(n, JSON.stringify(ev), run, 'stubsub');
    const a = o.agent(n.id);
    assert.equal(a.subagents.length, 2);
    for (const rec of a.subagents) {
      assert.equal(rec.status, 'completed');
      assert.equal(rec.type, 'task');
      assert.equal(rec.toolName, 'task');
      assert.ok(/^sa_call_/.test(rec.id));
      assert.ok(rec.childSessionId && /^ses_/.test(rec.childSessionId));
      assert.equal(rec.tokens, null); // child events never stream: no per-subagent usage exists
    }
    assert.deepEqual([...a.subagents].map((r) => r.description).sort(), ['Run echo alpha command', 'Run echo beta command']);
    assert.deepEqual(a.subagentTokens, { inputTokens: 0, outputTokens: 0 });
  } finally { delete RT.RUNTIMES.stubsub; }
});

test('parseProfileEvent: pending task part is a start; subtask part maps to type subtask', () => {
  const profile = { label: 'Stub', eventMapping: {} };
  const start = RT.parseProfileEvent({ type: 'tool_use', timestamp: 111, part: { type: 'tool', tool: 'task', callID: 'call_1', state: { status: 'running', input: { description: 'desc', prompt: 'pp' } } } }, profile);
  assert.equal(start.subagent.phase, 'start');
  assert.equal(start.subagent.status, 'running');
  assert.equal(start.subagent.toolUseId, 'call_1');
  assert.equal(start.subagent.description, 'desc');
  const subtask = RT.parseProfileEvent({ type: 'tool_use', timestamp: 222, part: { type: 'subtask', callID: 'call_2', description: 'st', prompt: 'q' } }, profile);
  assert.equal(subtask.subagent.phase, 'start');
  assert.equal(subtask.subagent.type, 'subtask');
  assert.equal(subtask.subagent.toolUseId, 'call_2');
  // Non-subagent tools produce no signal.
  const bash = RT.parseProfileEvent({ type: 'tool_use', timestamp: 333, part: { type: 'tool', tool: 'bash', callID: 'call_3', state: { status: 'completed', input: {}, output: 'x' } } }, profile);
  assert.equal(bash.subagent, undefined);
});

test('tracker: idempotent re-emit, first end wins, unknown-parent placeholder, abort on close', () => {
  const t = new SubagentTracker('n1', () => 1000);
  t.start({ toolUseId: 't1', toolName: 'Task', description: 'd' });
  t.start({ toolUseId: 't1', toolName: 'Task', description: 'd' }); // stream re-emits the part
  assert.equal(t.records.length, 1);
  t.end('t1', { status: 'completed', endedAt: 2000 });
  t.end('t1', { status: 'failed', endedAt: 3000 }); // a second result must not flip it
  assert.equal(t.records[0].status, 'completed');
  assert.equal(t.records[0].endedAt, 2000);
  const tag = t.tagFor('toolu_unknown'); // child of an unseen Task call still groups under one id
  assert.equal(tag.placeholder, true);
  assert.equal(tag.status, 'running');
  assert.deepEqual(t.totals(), { inputTokens: 0, outputTokens: 0 });
  const aborted = t.close(4000);
  assert.deepEqual(aborted.map((r) => r.id), [tag.id]);
  assert.equal(tag.status, 'aborted');
  assert.equal(t.snapshot()[0].tokens, null);
});

test('run close aborts still-running subagents and persists records on the run', async () => {
  const { s, n, o } = setup();
  s.saveSettings({ claudePath: process.execPath });
  const script = path.join(s.dir, 'fake-subagent-cli.js');
  fs.writeFileSync(script, [
    '#!/usr/bin/env node',
    `const evs = ${JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'sess_close', model: 'claude-haiku-4-5' },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', name: 'Task', id: 'toolu_A1', input: { description: 'never finishes', prompt: 'p', subagent_type: 'general-purpose' } }] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_A1', message: { id: 'm2', usage: { input_tokens: 9, output_tokens: 2 }, content: [{ type: 'text', text: 'child working' }] } },
    ])};`,
    'for (const e of evs) process.stdout.write(JSON.stringify(e) + "\\n");',
    'process.exit(0);', // CLI dies mid-subagent: no tool_result ever arrives
  ].join('\n'));
  const r = await o.spawnRun(n, [script], s.dir, { ...process.env }, s.getSettings(), { runtime: 'claude' });
  assert.equal(r.code, 0);
  const a = o.agent(n.id);
  assert.equal(a.subagents.length, 1);
  assert.equal(a.subagents[0].status, 'aborted');
  assert.equal(a.subagents[0].description, 'never finishes');
  assert.deepEqual(a.subagents[0].tokens, { inputTokens: 9, outputTokens: 2 });
  const [rec] = s.listRuns({ nodeId: n.id });
  assert.equal(rec.subagents.length, 1);
  assert.equal(rec.subagents[0].status, 'aborted'); // reload path: history rebuilds from the stored run
});

test('log persistence and logEntries keep subagentId', () => {
  const { s } = setup();
  s.appendLog({ at: 123, nodeId: 'n1', kind: 'tool', text: 'child row', taskId: 't1', task: 'T', subagentId: 'sa_x' });
  s.appendLog({ at: 124, nodeId: 'n1', kind: 'text', text: 'parent row' });
  const [kept, plain] = s.readLogs(10);
  assert.equal(kept.subagentId, 'sa_x');
  assert.equal(plain.subagentId, null);
  const entries = logEntries(s.readLogs(10));
  assert.equal(entries[0].subagentId, 'sa_x');
  assert.equal(entries[1].subagentId, null);
});

test('snapshot exposes per-agent subagent totals without double counting', () => {
  const { n, o } = setup();
  const run = fakeRun(n);
  o.onEvent(n, JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Agent', id: 'toolu_A', input: { description: 'd', prompt: 'p' } }] } }), run, 'claude');
  o.onEvent(n, JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_A', message: { id: 'm2', usage: { input_tokens: 4, output_tokens: 2 }, content: [{ type: 'text', text: 'x' }] } }), run, 'claude');
  o.onEvent(n, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'done' }] } }), run, 'claude');
  const snap = o.snapshot();
  const a = snap.agents[n.id];
  assert.equal(a.subagentCount, 1);
  assert.deepEqual(a.subagentTokens, { inputTokens: 4, outputTokens: 2 });
  assert.equal(a.subagents[0].status, 'completed');
});
