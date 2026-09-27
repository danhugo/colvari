const test = require('node:test'); const assert = require('node:assert');
const RT = require('../src/runtimes');
const { buildClaudeArgs, normalizeNode } = require('../src/agent-config');

test('claude adapter is the unchanged buildClaudeArgs and default runtime', () => {
  assert.strictEqual(RT.getRuntime('claude').buildArgs, buildClaudeArgs);
  assert.strictEqual(RT.getRuntime(undefined).id, 'claude');
  assert.strictEqual(normalizeNode({}).runtime, 'claude');
  assert.strictEqual(normalizeNode({ runtime: 'bogus' }).runtime, 'claude');
  assert.strictEqual(RT.RUNTIMES.claude.bin({ claudePath: '/x/claude' }), '/x/claude');
});
test('codex args: exec --json, model, bypass, resume', () => {
  const a = RT.getRuntime('codex').buildArgs({ model: 'gpt-5.6-terra' }, 'hi', { permissionMode: 'bypassPermissions' }, {}, { resume: 'T1' });
  assert.deepStrictEqual(a, ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-terra', 'resume', 'T1', 'hi']);
  assert.ok(!RT.getRuntime('codex').buildArgs({}, 'hi', { permissionMode: 'default' }, {}).includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('codex event parsing (real event shapes from codex-cli 0.144.6)', () => {
  assert.strictEqual(RT.parseCodexEvent({ type: 'thread.started', thread_id: 'T1' }).sessionId, 'T1');
  const m = RT.parseCodexEvent({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'PONG' } });
  assert.strictEqual(m.result, 'PONG'); assert.deepStrictEqual(m.logs, [['text', 'PONG']]);
  const t = RT.parseCodexEvent({ type: 'turn.completed', usage: { input_tokens: 14351, cached_input_tokens: 9984, output_tokens: 6, reasoning_output_tokens: 0 } });
  assert.deepStrictEqual(t.tokens, { inputTokens: 14351, outputTokens: 6, cachedInputTokens: 9984 });
  assert.ok(RT.parseCodexEvent({ type: 'turn.failed', error: { message: 'bad model' } }).failed);
  assert.strictEqual(RT.parseCodexEvent({ type: 'error', message: 'x' }).logs[0][0], 'error');
});
test('capabilities are honest: opencode claims nothing, codex no cost/mcp', () => {
  assert.deepStrictEqual(RT.RUNTIMES.opencode.capabilities, { tokens: false, cost: false, mcp: false, resume: false });
  assert.strictEqual(RT.RUNTIMES.codex.capabilities.cost, false); assert.strictEqual(RT.RUNTIMES.codex.capabilities.mcp, false);
});
test('detectRuntimes marks missing binaries not installed', () => {
  const exec = (bin) => { if (bin === 'opencode') { const e = new Error('spawn opencode ENOENT'); e.code = 'ENOENT'; throw e; } return bin === 'codex' ? 'codex-cli 0.144.6\n' : '2.1.0 (Claude Code)\n'; };
  const d = RT.detectRuntimes({}, {}, exec);
  assert.deepStrictEqual([d.claude.installed, d.codex.installed, d.opencode.installed], [true, true, false]);
  assert.strictEqual(d.codex.version, '0.144.6'); assert.strictEqual(d.opencode.error, 'not installed');
});
test('detectRuntimes on this machine', () => {
  const d = RT.detectRuntimes({}, { ...process.env, PATH: process.env.PATH + ':' + require('os').homedir() + '/.local/bin' });
  assert.strictEqual(typeof d.opencode.installed, 'boolean');
});
