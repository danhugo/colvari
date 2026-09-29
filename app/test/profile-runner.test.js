const test = require('node:test'); const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { buildProfileArgs, applyProfileEvent, runProfile } = require('../src/profile-runner');

const PROFILE = {
  binary: 'helpycode',
  argsTemplate: ['run', '--format', 'json', '--model', '{model}', '--effort', '{variant}', '{prompt}'],
  effortValues: ['low', 'high'],
  effortFlag: '--effort',
  resumeFlag: '--resume',
  bypassFlag: '--dangerously-skip-permissions',
  mcp: { method: 'json-flag', flag: '--mcp-config' },
  eventMapping: { textPath: 'text', sessionIdPath: 'session_id', costPath: 'total_cost_usd', inputPath: 'usage.input_tokens', outputPath: 'usage.output_tokens', reasoningPath: 'usage.reasoning_tokens', cachePath: 'usage.cache_read_tokens' },
};

test('buildProfileArgs fills template, rejects unknown effort, injects resume + mcp', () => {
  const args = buildProfileArgs(PROFILE, { model: 'm1', variant: 'high', prompt: 'hi', session: 'S1', mcpConfig: { mcpServers: { board: { command: '/bin/node', args: ['x'] } } } });
  assert.deepStrictEqual(args.slice(0, 3), ['run', '--resume', 'S1']);
  assert.ok(args.includes('--model') && args.includes('m1'));
  assert.ok(args.includes('hi'));
  assert.ok(args.includes('--mcp-config'));
  assert.ok(!args.includes('--dangerously-skip-permissions'), 'no bypass unless asked');
  assert.deepStrictEqual(buildProfileArgs(PROFILE, { prompt: 'hi', bypass: true }).slice(0, 2), ['run', '--dangerously-skip-permissions']);
  assert.throws(() => buildProfileArgs(PROFILE, { variant: 'bogus', prompt: 'x' }), /unknown effort "bogus"/);
});

test('applyProfileEvent accumulates text/usage/cost/session via the mapping', () => {
  const run = { result: '', inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, reportedCostUsd: 0, sessionId: null };
  applyProfileEvent(run, { session_id: 'S1' }, PROFILE.eventMapping);
  applyProfileEvent(run, { text: 'pong' }, PROFILE.eventMapping);
  applyProfileEvent(run, { usage: { input_tokens: 10, output_tokens: 4, reasoning_tokens: 1, cache_read_tokens: 2 }, total_cost_usd: 0.01 }, PROFILE.eventMapping);
  assert.strictEqual(run.sessionId, 'S1'); assert.strictEqual(run.result, 'pong');
  assert.strictEqual(run.inputTokens, 10); assert.strictEqual(run.outputTokens, 4);
  assert.strictEqual(run.reasoningTokens, 1); assert.strictEqual(run.cacheReadTokens, 2);
  assert.strictEqual(run.reportedCostUsd, 0.01);
});

// Fake child_process.spawn: emits JSON lines on stdout then closes.
function fakeSpawn(lines, code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    process.nextTick(() => {
      for (const l of lines) child.stdout.emit('data', Buffer.from(l + '\n'));
      child.emit('close', code);
    });
    return child;
  };
}

test('runProfile spawns from the profile and feeds usage into a usage.js-shaped run', async () => {
  const lines = [
    JSON.stringify({ session_id: 'S1' }),
    JSON.stringify({ text: 'pong' }),
    JSON.stringify({ usage: { input_tokens: 8, output_tokens: 3, reasoning_tokens: 1, cache_read_tokens: 0 }, total_cost_usd: 0.002 }),
  ];
  const events = [];
  const run = await runProfile(PROFILE, { model: 'm1', prompt: 'hi', onEvent: (ev) => events.push(ev) }, fakeSpawn(lines));
  assert.strictEqual(run.result, 'pong');
  assert.strictEqual(run.sessionId, 'S1');
  assert.strictEqual(run.inputTokens, 8); assert.strictEqual(run.outputTokens, 3);
  assert.strictEqual(run.reasoningTokens, 1); assert.strictEqual(run.reportedCostUsd, 0.002);
  assert.strictEqual(run.exitCode, 0); assert.strictEqual(run.isError, false);
  assert.strictEqual(events.length, 3);
});

test('runProfile marks non-zero exit as an error', async () => {
  const run = await runProfile(PROFILE, { model: 'm1', prompt: 'hi' }, fakeSpawn([JSON.stringify({ text: 'oops' })], 1));
  assert.strictEqual(run.exitCode, 1); assert.strictEqual(run.isError, true);
});
