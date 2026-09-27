const test = require('node:test'); const assert = require('node:assert');
const RT = require('../src/runtimes');
const { buildClaudeArgs, normalizeNode } = require('../src/agent-config');

test('claude adapter is the unchanged buildClaudeArgs and default runtime', () => {
  assert.strictEqual(RT.getRuntime('claude').buildArgs, buildClaudeArgs);
  assert.strictEqual(RT.getRuntime(undefined).id, 'claude');
  assert.strictEqual(normalizeNode({}).runtime, 'claude');
  assert.strictEqual(normalizeNode({ runtime: 'bogus' }).runtime, 'bogus');
  assert.throws(() => RT.getRuntime('bogus'), /unknown runtime "bogus"/);
  assert.throws(() => RT.getRuntime('Codex'), /unknown runtime/);
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
  assert.strictEqual(RT.RUNTIMES.codex.capabilities.cost, false); assert.strictEqual(RT.RUNTIMES.codex.capabilities.mcp, true);
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

test('codex gets board MCP via -c overrides and honors model', () => {
  const R = require('../src/runtimes');
  const mcp = { mcpServers: { board: { command: '/bin/node', args: ['srv.js', '--node', 'n1'], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
  const a = R.RUNTIMES.codex.buildArgs({ model: 'gpt-5' }, 'hi', {}, mcp);
  assert.ok(a.includes('mcp_servers.board.command="/bin/node"'));
  assert.ok(a.includes('mcp_servers.board.args=["srv.js","--node","n1"]'));
  assert.ok(a.includes('mcp_servers.board.env.ELECTRON_RUN_AS_NODE="1"'));
  assert.deepEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2), ['-m', 'gpt-5']);
  assert.equal(a[a.length - 1], 'hi');
});

test('helpycode args: run --format json, model, variant, resume, writes mcp config file to cwd', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'));
  const mcp = { mcpServers: { board: { command: '/bin/node', args: ['srv.js', '--node', 'n1'], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
  const a = RT.getRuntime('helpycode').buildArgs({ model: 'elice/z-ai/glm-5.3-flash', effort: 'high' }, 'hi', {}, mcp, { resume: 'S1', cwd });
  assert.deepStrictEqual(a, ['run', '-s', 'S1', '--format', 'json', '--model', 'elice/z-ai/glm-5.3-flash', '--variant', 'high', 'hi']);
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, 'helpycode.json'), 'utf8'));
  assert.deepStrictEqual(cfg.mcp.board.command, ['/bin/node', 'srv.js', '--node', 'n1']);
  assert.strictEqual(cfg.mcp.board.enabled, true);
  assert.deepStrictEqual(cfg.mcp.board.environment, { ELECTRON_RUN_AS_NODE: '1' });
  fs.rmSync(cwd, { recursive: true, force: true });
});
test('helpycode args: no cwd means no mcp file written, still builds args', () => {
  const a = RT.getRuntime('helpycode').buildArgs({ model: 'm1' }, 'hi', {}, { mcpServers: { board: {} } }, {});
  assert.ok(a.includes('--model') && a.includes('m1') && a[a.length - 1] === 'hi');
});
test('helpycode event parsing (real event shapes captured from helpycode 0.3.5)', () => {
  // every event carries the session id top-level as sessionID; payload lives under part
  const sid = RT.parseHelpycodeEvent({ type: 'step_start', sessionID: 'S1', part: { type: 'step-start' } });
  assert.strictEqual(sid.sessionId, 'S1'); assert.deepStrictEqual(sid.logs, []);
  const t = RT.parseHelpycodeEvent({ type: 'text', sessionID: 'S1', part: { type: 'text', text: 'pong' } });
  assert.strictEqual(t.result, 'pong'); assert.deepStrictEqual(t.logs, [['text', 'pong']]);
  const tool = RT.parseHelpycodeEvent({ type: 'tool_use', sessionID: 'S1', part: { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'echo hi' } } } });
  assert.deepStrictEqual(tool.logs, [['tool', 'bash {"command":"echo hi"}']]);
  const done = RT.parseHelpycodeEvent({ type: 'tool_use', sessionID: 'S1', part: { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'hi\n', metadata: { exit: 0 } } } });
  assert.deepStrictEqual(done.logs, [['tool_result', 'bash: hi\n']]);
  const failed = RT.parseHelpycodeEvent({ type: 'tool_use', sessionID: 'S1', part: { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'nope', metadata: { exit: 1 } } } });
  assert.strictEqual(failed.logs[0][0], 'tool_error');
  // each step_finish is one step's usage; the caller sums them per run. done only on the final (reason 'stop') step.
  const step = RT.parseHelpycodeEvent({ type: 'step_finish', sessionID: 'S1', part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 12301, output: 27, reasoning: 9, cache: { read: 5696 } }, cost: 0 } });
  assert.deepStrictEqual(step.tokens, { inputTokens: 12301, outputTokens: 36, cachedInputTokens: 5696 });
  assert.strictEqual(step.cost, 0); assert.ok(!step.done); assert.strictEqual(step.logs[0][0], 'system');
  const stop = RT.parseHelpycodeEvent({ type: 'step_finish', sessionID: 'S1', part: { type: 'step-finish', reason: 'stop', tokens: { input: 61, output: 3, reasoning: 0, cache: { read: 17984 } }, cost: 0.0002 } });
  assert.deepStrictEqual(stop.tokens, { inputTokens: 61, outputTokens: 3, cachedInputTokens: 17984 });
  assert.strictEqual(stop.cost, 0.0002); assert.ok(stop.done); assert.strictEqual(stop.logs[0][0], 'result');
  assert.ok(RT.parseHelpycodeEvent({ type: 'error', message: 'bad model' }).failed);
});
test('capabilities: helpycode claims tokens/cost/mcp/resume (verified live, helpycode 0.3.5)', () => {
  assert.deepStrictEqual(RT.RUNTIMES.helpycode.capabilities, { tokens: true, cost: true, mcp: true, resume: true });
});
