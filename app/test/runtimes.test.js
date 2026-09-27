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
test('helpycode event parsing (fake-agent-cli / documented real event shapes)', () => {
  assert.strictEqual(RT.parseHelpycodeEvent({ type: 'session', session_id: 'S1' }).sessionId, 'S1');
  const m = RT.parseHelpycodeEvent({ type: 'message', text: 'pong' });
  assert.strictEqual(m.result, 'pong'); assert.deepStrictEqual(m.logs, [['text', 'pong']]);
  const r = RT.parseHelpycodeEvent({ type: 'result', usage: { input_tokens: 12, output_tokens: 6, reasoning_tokens: 2 }, total_cost_usd: 0.0003 });
  assert.deepStrictEqual(r.tokens, { inputTokens: 12, outputTokens: 8 });
  assert.strictEqual(r.cost, 0.0003); assert.ok(r.done);
});
test('capabilities: helpycode claims tokens/cost/mcp/resume (verified live, helpycode 0.3.5)', () => {
  assert.deepStrictEqual(RT.RUNTIMES.helpycode.capabilities, { tokens: true, cost: true, mcp: true, resume: true });
});
