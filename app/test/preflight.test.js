const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const PF = require('../src/preflight');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

const init = (extra = {}) => ({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5', apiKeySource: 'none', mcp_servers: [{ name: 'board', status: 'connected' }], ...extra });
const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__board__list_team', input: {} }] } };
const res = (err) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: !!err, content: [{ type: 'text', text: err || '[]' }] }] } });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'OK', num_turns: 2, total_cost_usd: 0.002, usage: { input_tokens: 10, output_tokens: 3 }, ...extra });
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test('preflight args use the node config with a 3 turn cap and the list_team prompt', () => {
  const a = PF.preflightArgs({ model: 'haiku', permissionMode: 'acceptEdits', maxTurns: 40 }, { permissionMode: 'bypassPermissions' }, { mcpServers: {} });
  assert.equal(a[1], PF.PREFLIGHT_PROMPT); assert.match(a[1], /list_team/);
  assert.equal(a[a.indexOf('--model') + 1], 'haiku'); assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(a.filter((x) => x === '--max-turns').length, 1); assert.equal(a[a.indexOf('--max-turns') + 1], '3');
  assert.ok(a.includes('--strict-mcp-config'));
});

test('evaluate: all checks pass on a good stream', () => {
  const r = PF.evaluate({ version: '2.1.0', events: [init(), use, res(), result()], code: 0, latencyMs: 1234 });
  assert.equal(r.ok, true, r.error); assert.equal(r.apiKeySource, 'none'); assert.equal(r.billing, 'subscription');
  assert.deepEqual(r.checks.map((c) => c.id), ['binary', 'model', 'auth', 'mcp', 'tool', 'reply']);
  assert.equal(r.tokens.inputTokens, 10); assert.equal(r.latencyMs, 1234); assert.equal(r.model, 'claude-haiku-4-5');
});

test('evaluate: failures are reported per check', () => {
  let r = PF.evaluate({ spawnError: 'not found (nope): ENOENT' });
  assert.equal(r.ok, false); assert.equal(r.checks.length, 1); assert.match(r.error, /claude binary/);
  r = PF.evaluate({ version: '2', events: [init({ mcp_servers: [{ name: 'board', status: 'failed' }] }), result({ result: 'OK' })], code: 0 });
  assert.equal(byId(r).mcp.ok, false); assert.equal(byId(r).tool.ok, false); assert.match(r.error, /board MCP/);
  r = PF.evaluate({ version: '2', events: [init({ apiKeySource: 'ANTHROPIC_API_KEY' }), result({ is_error: true, subtype: 'error', result: 'Invalid API key · Please run /login' })], code: 1 });
  assert.equal(byId(r).auth.ok, false); assert.match(byId(r).auth.detail, /API key/);
  r = PF.evaluate({ version: '2', events: [init(), result({ is_error: true, result: 'API Error: 404 model: claude-nope not_found_error' })], code: 1 });
  assert.equal(byId(r).model.ok, false);
  r = PF.evaluate({ version: '2', events: [init(), use, res('permission denied'), result({ result: 'could not' })], code: 0 });
  assert.equal(byId(r).tool.ok, false); assert.match(byId(r).tool.detail, /permission/); assert.equal(byId(r).reply.ok, false);
});

test('preflight status: untested, pass, fail, stale after config change', () => {
  const s = { permissionMode: 'bypassPermissions', claudePath: 'claude' };
  const n = { name: 'A', model: 'haiku' };
  assert.equal(PF.preflightStatus(n, s), 'untested');
  n.preflight = { ok: true, configHash: PF.configHash(n, s) }; assert.equal(PF.preflightStatus(n, s), 'pass');
  n.preflight.ok = false; assert.equal(PF.preflightStatus(n, s), 'fail');
  assert.equal(PF.preflightStatus({ ...n, systemPrompt: 'x' }, s), 'fail'); // prompt changes do not invalidate
  assert.equal(PF.preflightStatus({ ...n, model: 'opus' }, s), 'stale');
  assert.equal(PF.parseVersion('2.1.3 (Claude Code)'), '2.1.3');
});

test('orchestrator.preflight runs the fake CLI with the node config and records usage', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pf-'));
  const fake = path.join(r, 'fake-claude.js'); const argsFile = path.join(r, 'args.json');
  const lines = [init(), use, res(), result()].map((e) => JSON.stringify(e));
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(a));\n${JSON.stringify(lines)}.forEach((l) => console.log(l));\n`);
  fs.chmodSync(fake, 0o755);
  const pm = new ProjectManager(r); const s = pm.store(pm.list()[0].id); s.saveSettings({ claudePath: fake });
  const node = s.addNode({ name: 'T', role: 'Dev', model: 'haiku', permissionMode: 'acceptEdits' });
  const o = new Orchestrator(s);
  const out = await o.preflight(s.getTeam().nodes.find((n) => n.id === node.id));
  assert.equal(out.ok, true, out.error); assert.equal(out.version, '9.9.9'); assert.ok(out.configHash);
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.equal(args[args.indexOf('--model') + 1], 'haiku'); assert.equal(args[args.indexOf('--max-turns') + 1], '3');
  assert.match(args[args.indexOf('--mcp-config') + 1], new RegExp(node.id));
  const runs = s.listRuns(); assert.equal(runs.length, 1); assert.equal(runs[0].kind, 'preflight'); assert.equal(runs[0].inputTokens, 10);
  s.saveSettings({ claudePath: path.join(r, 'missing') });
  const bad = await o.preflight(node);
  assert.equal(bad.ok, false); assert.match(bad.error, /claude binary/);
});
