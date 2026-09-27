const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TL = require('../src/timeline');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

test('timeline: keeps only agent runs, maps start/end per agent+task', () => {
  const runs = [
    { kind: 'agent', nodeId: 'n1', agent: 'Dev', taskId: 't1', task: 'Do X', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', durationMs: 60000, model: 'claude-x' },
    { kind: 'preflight', nodeId: 'n1', agent: 'Dev', taskId: null, task: 'preflight', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z' },
    { kind: 'agent', nodeId: null, agent: '', taskId: 't2', task: 'Do Y', startedAt: 'x', endedAt: null },
  ];
  const tl = TL.timeline(runs);
  assert.equal(tl.length, 1);
  assert.deepEqual(tl[0], { nodeId: 'n1', agent: 'Dev', taskId: 't1', task: 'Do X', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', durationMs: 60000, model: 'claude-x', isError: false });
});

test('logEntries: maps log lines to {ts, agentId, level, text, taskId, task}', () => {
  const lines = [
    { at: 1000, nodeId: 'n1', kind: 'system', text: 'started' },
    { at: 1001, nodeId: 'n1', kind: 'error', text: 'boom', taskId: 't1', task: 'Do X' },
    { at: 1002, nodeId: 'n2', kind: 'stderr', text: 'warn text' },
    { at: 1003, nodeId: null, kind: 'text', text: 'hello' },
  ];
  const es = TL.logEntries(lines);
  assert.deepEqual(es, [
    { ts: 1000, agentId: 'n1', level: 'info', text: 'started', taskId: null, task: '' },
    { ts: 1001, agentId: 'n1', level: 'error', text: 'boom', taskId: 't1', task: 'Do X' },
    { ts: 1002, agentId: 'n2', level: 'warn', text: 'warn text', taskId: null, task: '' },
    { ts: 1003, agentId: null, level: 'info', text: 'hello', taskId: null, task: '' },
  ]);
});

test('timeline: lanes sorted needs-attention first (waiting_for_human, blocked, error), then normal', () => {
  const tasks = [
    { id: 't1', status: 'in_progress', blockedBy: [] }, // normal (n1)
    { id: 't2', status: 'in_progress', blockedBy: [] }, // will error (n2)
    { id: 't3', status: 'in_progress', blockedBy: ['t4'] }, // blocked (n3)
    { id: 't4', status: 'in_progress', blockedBy: [] },
    { id: 't5', status: 'waiting_for_human', blockedBy: [] }, // n4
  ];
  const runs = [
    { kind: 'agent', nodeId: 'n1', agent: 'A', taskId: 't1', task: 'Normal', startedAt: '2026-01-01T00:00:00.000Z' },
    { kind: 'agent', nodeId: 'n2', agent: 'B', taskId: 't2', task: 'Errors', startedAt: '2026-01-01T00:00:00.000Z', isError: true },
    { kind: 'agent', nodeId: 'n3', agent: 'C', taskId: 't3', task: 'Blocked', startedAt: '2026-01-01T00:00:00.000Z' },
    { kind: 'agent', nodeId: 'n4', agent: 'D', taskId: 't5', task: 'Waiting', startedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const tl = TL.timeline(runs, tasks);
  assert.deepEqual(tl.map((e) => e.nodeId), ['n4', 'n3', 'n2', 'n1']);
});

test('wikiPages: maps store page map to a list with body/updatedAt/author', () => {
  const pages = { Foo: { title: 'Foo', content: 'body text', author: 'human', updatedAt: '2026-01-01T00:00:00.000Z' } };
  assert.deepEqual(TL.wikiPages(pages), [{ title: 'Foo', body: 'body text', updatedAt: '2026-01-01T00:00:00.000Z', author: 'human' }]);
  assert.deepEqual(TL.wikiPages({}), []);
});

test('orchestrator snapshot exposes timeline/logs/wiki from the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-timeline-'));
  const store = new Store(dir);
  store.addRun({ kind: 'agent', nodeId: 'n1', agent: 'Dev', taskId: 't1', task: 'Do X', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', durationMs: 60000, model: 'claude-x', isError: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostUsd: 0, billingSource: 'subscription' });
  store.appendLog({ nodeId: 'n1', kind: 'error', text: 'boom', at: 5 });
  store.writeWiki('Foo', 'body text', 'human');

  const orch = new Orchestrator(store);
  const snap = orch.snapshot();
  assert.equal(snap.timeline.length, 1);
  assert.equal(snap.timeline[0].taskId, 't1');
  assert.ok(snap.logs.some((l) => l.agentId === 'n1' && l.level === 'error' && l.text === 'boom'));
  assert.deepEqual(snap.wiki, [{ title: 'Foo', body: 'body text', updatedAt: store.readWiki('Foo').updatedAt, author: 'human' }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('orchestrator.log attaches the agent\'s current taskId+task to persisted log lines for deep-linking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-timeline-'));
  const store = new Store(dir);
  const orch = new Orchestrator(store);
  orch.agent('n1').taskId = 't1'; orch.agent('n1').task = 'Do X';
  orch.log('n1', 'error', 'boom');
  orch.log(null, 'system', 'no agent');
  const logs = orch.logs();
  const boom = logs.find((l) => l.text === 'boom');
  assert.deepEqual(boom, { ts: boom.ts, agentId: 'n1', level: 'error', text: 'boom', taskId: 't1', task: 'Do X' });
  assert.equal(logs.find((l) => l.text === 'no agent').taskId, null);

  fs.rmSync(dir, { recursive: true, force: true });
});
