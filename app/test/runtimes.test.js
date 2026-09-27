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
  // helpycode now reports what the (fake) CLI itself shows: installed, but help-only derivation
  // honestly claims no capabilities
  assert.strictEqual(d.helpycode.installed, true);
  assert.deepStrictEqual(d.helpycode.capabilities, { tokens: false, cost: false, mcp: false, resume: false });
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

// Fake exec serving real captured helpycode --help output plus documented event shapes, so the
// profile-driven helpycode adapter is exercised without a live binary. Each test uses a distinct
// bin path: deriveRuntimeProfile caches per binary+version.
const path = require('node:path');
const fs = require('node:fs');
const realHelpycodeTop = fs.readFileSync(path.join(__dirname, 'fixtures/help-helpycode-real-top.txt'), 'utf8');
const realHelpycodeRun = fs.readFileSync(path.join(__dirname, 'fixtures/help-helpycode-real-run.txt'), 'utf8');
const probeLines = fs.readFileSync(path.join(__dirname, 'fixtures/probe-helpycode-real.jsonl'), 'utf8');
const agentProfileJson = JSON.stringify({
  argsTemplate: ['run', '--format', 'json', '--model', '{model}', '--variant', '{variant}', '{prompt}'],
  resumeFlag: '-s', effortFlag: '--variant', effortValues: ['low', 'medium', 'high', 'max', 'minimal'],
  mcp: { method: 'file', flag: 'helpycode.json' },
  eventMapping: { textPath: 'text', sessionIdPath: 'session_id', costPath: 'total_cost_usd', inputPath: 'usage.input_tokens', outputPath: 'usage.output_tokens', reasoningPath: 'usage.reasoning_tokens', cachePath: 'usage.cache_read_tokens' },
});
function fakeHelpyExec(bin, args) {
  if (args[0] === '--version') return 'helpycode 0.3.5\n';
  if (args[0] === 'run' && args.includes('--help')) return realHelpycodeRun;
  if (args.includes('--help')) return realHelpycodeTop;
  if (args[0] === 'models') return 'elice/z-ai/glm-5.3-flash\nelice/z-ai/glm-5.3\n';
  if (args.join(' ').includes('argsTemplate')) return agentProfileJson; // ask-agent profile request
  if (args[0] === 'run') return probeLines; // probe run
  throw new Error('unexpected exec ' + JSON.stringify(args));
}

test('helpycode is profile-driven: args derive from the introspector (no hand-built profile)', () => {
  const rt = RT.getRuntime('helpycode');
  const a = rt.buildArgs({ model: 'elice/z-ai/glm-5.3-flash', effort: 'high' }, 'hi', { helpycodePath: '/fake/hc-args' }, {}, { resume: 'S1', exec: fakeHelpyExec });
  assert.deepStrictEqual(a, ['run', '-s', 'S1', '--format', 'json', '--model', 'elice/z-ai/glm-5.3-flash', '--variant', 'high', 'hi']);
});
test('helpycode args: no cwd means no mcp file written, still builds args', () => {
  const a = RT.getRuntime('helpycode').buildArgs({ model: 'm1' }, 'hi', { helpycodePath: '/fake/hc-nocwd' }, { mcpServers: { board: {} } }, { exec: fakeHelpyExec });
  assert.ok(a.includes('--model') && a.includes('m1') && a[a.length - 1] === 'hi');
});
test('helpycode mcp: derived mcp is file-method via the ask-agent layer; config written to cwd', () => {
  const fs2 = require('fs'); const os = require('os');
  const cwd = fs2.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'));
  const mcp = { mcpServers: { board: { command: '/bin/node', args: ['srv.js', '--node', 'n1'], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
  const rt = RT.getRuntime('helpycode');
  const a = rt.buildArgs({ model: 'm1' }, 'hi', { helpycodePath: '/fake/hc-mcp' }, mcp, { cwd, exec: fakeHelpyExec, askAgent: true });
  assert.ok(a.includes('--model') && a.includes('m1') && a[a.length - 1] === 'hi');
  const cfg = JSON.parse(fs2.readFileSync(path.join(cwd, 'helpycode.json'), 'utf8'));
  assert.deepStrictEqual(cfg.mcp.board.command, ['/bin/node', 'srv.js', '--node', 'n1']);
  assert.strictEqual(cfg.mcp.board.enabled, true);
  assert.deepStrictEqual(cfg.mcp.board.environment, { ELECTRON_RUN_AS_NODE: '1' });
  fs2.rmSync(cwd, { recursive: true, force: true });
});
test('helpycode parseEvent is generic profile-driven parsing (older documented event shapes)', () => {
  const { normalizeRuntimeProfile } = require('../src/runtime-profile');
  const profile = normalizeRuntimeProfile({ id: 'helpycode', label: 'HelpyCode', binary: 'helpycode', eventMapping: { textPath: 'text', sessionIdPath: 'session_id', costPath: 'total_cost_usd', inputPath: 'usage.input_tokens', outputPath: 'usage.output_tokens', reasoningPath: 'usage.reasoning_tokens', cachePath: 'usage.cache_read_tokens' } });
  assert.strictEqual(RT.parseProfileEvent({ type: 'session', session_id: 'S1' }, profile).sessionId, 'S1');
  const m = RT.parseProfileEvent({ type: 'message', text: 'pong' }, profile);
  assert.strictEqual(m.result, 'pong'); assert.deepStrictEqual(m.logs, [['text', 'pong']]);
  const r = RT.parseProfileEvent({ type: 'result', usage: { input_tokens: 12, output_tokens: 6, reasoning_tokens: 2 }, total_cost_usd: 0.0003 }, profile);
  assert.deepStrictEqual(r.tokens, { inputTokens: 12, outputTokens: 8 });
  assert.strictEqual(r.cost, 0.0003); assert.ok(r.done);
  assert.ok(RT.parseProfileEvent({ type: 'error', message: 'boom' }, profile).failed);
});
test('helpycode parseEvent on the CURRENT stream shape: totals fire on usage-bearing step_finish', () => {
  // derived from the real fixtures end-to-end (help -> probe -> mapping), no hand-built mapping
  const rt = RT.getRuntime('helpycode');
  const profile = RT.deriveRuntimeProfile('/fake/hc-live-events', { exec: fakeHelpyExec, label: 'HelpyCode' });
  const lines = probeLines.trim().split('\n').map((l) => JSON.parse(l));
  const stepFinish = rt.parseEvent(lines[2], { helpycodePath: '/fake/hc-live-events' }, { exec: fakeHelpyExec });
  assert.deepStrictEqual(stepFinish.tokens, { inputTokens: 10, outputTokens: 29 }); // 3 output + 26 reasoning
  assert.strictEqual(stepFinish.cost, 0.0003);
  assert.strictEqual(stepFinish.sessionId, 'ses_f1c951611ffePHhIOfr10tisqA');
  assert.ok(stepFinish.done);
  const text = rt.parseEvent(lines[1], { helpycodePath: '/fake/hc-live-events' }, { exec: fakeHelpyExec });
  assert.strictEqual(text.result, 'pong');
});
test('capabilities derive from the profile, honestly: help-only sees resume only', () => {
  // help-only derivation (no probe/model call) knows the resume flag but nothing about the event stream
  assert.deepStrictEqual(RT.getRuntime('helpycode').capabilities({ helpycodePath: '/fake/hc-caps' }, fakeHelpyExec), { tokens: false, cost: false, mcp: false, resume: true });
  // with a probe + ask-agent-derived profile, every claim is backed by a profile field
  const full = RT.deriveRuntimeProfile('/fake/hc-caps-full', { exec: fakeHelpyExec, label: 'HelpyCode', askAgent: true });
  assert.deepStrictEqual(RT.capabilitiesFromProfile(full), { tokens: true, cost: true, mcp: true, resume: true });
});
test('derived profiles are cached per binary and re-derived when the CLI version changes', () => {
  let version = 'helpycode 0.3.5\n'; let helpCalls = 0;
  const countingExec = (bin, args) => { if (args[0] === '--version') return version; if (args.includes('--help')) { helpCalls++; return realHelpycodeTop; } return ''; };
  const p1 = RT.deriveRuntimeProfile('/fake/hc-cache', { exec: countingExec, probe: false });
  const callsAfterFirst = helpCalls;
  const p2 = RT.deriveRuntimeProfile('/fake/hc-cache', { exec: countingExec, probe: false });
  assert.strictEqual(p2, p1); // same version -> cache hit, no re-derivation
  assert.strictEqual(helpCalls, callsAfterFirst);
  version = 'helpycode 0.4.0\n'; // upgrade -> the cached profile goes stale
  const p3 = RT.deriveRuntimeProfile('/fake/hc-cache', { exec: countingExec, probe: false });
  assert.notStrictEqual(p3, p1);
  assert.ok(helpCalls > callsAfterFirst, 'expected re-derivation after version change');
});
