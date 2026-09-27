const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const U = require('../src/usage');
const { normalizeNode } = require('../src/agent-config');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

test('contextWindowFor: 200k default, 1M for [1m] model ids', () => {
  assert.equal(U.contextWindowFor('claude-sonnet-5'), 200000);
  assert.equal(U.contextWindowFor('claude-sonnet-5[1m]'), 1000000);
  assert.equal(U.contextWindowFor(''), 200000);
});

test('contextFromAssistant: input + cache_read + cache_creation, not output', () => {
  const ev = { type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 4, cache_read_input_tokens: 34027, cache_creation_input_tokens: 16857, output_tokens: 335 } } };
  const c = U.contextFromAssistant(ev);
  assert.equal(c.messageId, 'msg_1'); assert.equal(c.model, 'claude-sonnet-5'); assert.equal(c.contextTokens, 4 + 34027 + 16857);
});
test('contextFromAssistant: not usable without usage/id, or wrong type', () => {
  assert.equal(U.contextFromAssistant({ type: 'assistant', message: { id: 'm' } }), null);
  assert.equal(U.contextFromAssistant({ type: 'result' }), null);
  assert.equal(U.contextFromAssistant(null), null);
});

test('parseCompactBoundary: real CLI shape (verified live with claude 2.1.283)', () => {
  const ev = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 52754, post_tokens: 4187 } };
  assert.deepEqual(U.parseCompactBoundary(ev), { preTokens: 52754, postTokens: 4187, trigger: 'auto' });
  assert.equal(U.parseCompactBoundary({ type: 'system', subtype: 'init' }), null);
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ctx-'));
  const s = new Store(path.join(dir, 'p'));
  const n = s.addNode(normalizeNode({ name: 'Dev', role: 'Dev' }));
  const o = new Orchestrator(s);
  return { s, n, o };
}

test('orchestrator.onEvent: tracks contextTokens/contextPct from assistant turns, dedupes repeated message ids', () => {
  const { n, o } = setup();
  const run = { usage: U.newRun({ nodeId: n.id, agent: n.name }) };
  const ev1 = { type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 }, content: [] } };
  o.onEvent(n, JSON.stringify(ev1), run, 'claude');
  let a = o.agent(n.id);
  assert.equal(a.contextTokens, 10002); assert.equal(a.contextWindow, 200000);
  assert.ok(Math.abs(a.contextPct - 10002 / 200000) < 1e-9);

  // Same message id repeated (a streaming delta of the same turn): must not be treated as a new turn.
  const ev1dup = { type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_read_input_tokens: 99999, cache_creation_input_tokens: 0 }, content: [] } };
  o.onEvent(n, JSON.stringify(ev1dup), run, 'claude');
  a = o.agent(n.id);
  assert.equal(a.contextTokens, 10002); // unchanged

  // A genuinely new turn updates it.
  const ev2 = { type: 'assistant', message: { id: 'msg_2', model: 'claude-sonnet-5', usage: { input_tokens: 4, cache_read_input_tokens: 34027, cache_creation_input_tokens: 16857 }, content: [] } };
  o.onEvent(n, JSON.stringify(ev2), run, 'claude');
  a = o.agent(n.id);
  assert.equal(a.contextTokens, 4 + 34027 + 16857);
});

test('orchestrator.onEvent: compact_boundary resets context to unknown and emits a compacted log + event', () => {
  const { n, o } = setup();
  const run = { usage: U.newRun({ nodeId: n.id, agent: n.name }) };
  const ev1 = { type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }, content: [] } };
  o.onEvent(n, JSON.stringify(ev1), run, 'claude');
  assert.equal(o.agent(n.id).contextTokens, 50002);

  const compactedEvents = []; o.on('compacted', (e) => compactedEvents.push(e));
  const logs = []; o.on('log', (l) => logs.push(l));
  const cb = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 52754, post_tokens: 4187 } };
  o.onEvent(n, JSON.stringify(cb), run, 'claude');

  const a = o.agent(n.id);
  assert.equal(a.contextTokens, null); assert.equal(a.contextPct, null); assert.equal(a.lastContextMessageId, null);
  assert.equal(compactedEvents.length, 1);
  assert.equal(compactedEvents[0].nodeId, n.id); assert.equal(compactedEvents[0].preTokens, 52754); assert.equal(compactedEvents[0].postTokens, 4187);
  assert.ok(logs.some((l) => l.kind === 'compacted' && /52754.*4187/.test(l.text)));

  // A fresh turn after the compact reports usage again.
  const ev2 = { type: 'assistant', message: { id: 'msg_2', model: 'claude-sonnet-5', usage: { input_tokens: 1, cache_read_input_tokens: 4186, cache_creation_input_tokens: 0 }, content: [] } };
  o.onEvent(n, JSON.stringify(ev2), run, 'claude');
  assert.equal(o.agent(n.id).contextTokens, 4187);
});

test('settings.autoCompactPct defaults to 40 and is persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ctx2-'));
  const s = new Store(path.join(dir, 'p'));
  assert.equal(s.getSettings().autoCompactPct, 40);
  s.saveSettings({ autoCompactPct: 70 });
  assert.equal(s.getSettings().autoCompactPct, 70);
  s.saveSettings({ autoCompactPct: 0 });
  assert.equal(s.getSettings().autoCompactPct, 0); // 0 = off
});
