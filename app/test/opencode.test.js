// Built-in opencode runtime (t_eddfd6eb): derived profile, args, per-run config (board MCP + provider),
// and event parsing — all against REAL opencode 1.18 help/stream recorded from the installed binary.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const RT = require('../src/runtimes');
const IN = require('../src/introspector');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const events = fx('probe-opencode-live.jsonl').trim().split('\n').map((l) => JSON.parse(l));
const exec = (bin, a) => (a.join(' ') === '--version' ? '1.18.0\n' : a.includes('run') ? fx('help-opencode-real-run.txt') : fx('help-opencode-real-top.txt'));
const mcp = { mcpServers: { board: { command: '/bin/node', args: ['srv.js'], env: { SQUAD_NODE: 'n1' } } } };
const readCfg = (env) => JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf8'));

test('opencode is a derived profileRuntime: run --format json, -s resume, --auto bypass, file MCP', async () => {
  const rt = RT.getRuntime('opencode');
  const env = {};
  const a = await rt.buildArgs({ model: 'openrouter/x/y', effort: 'high' }, 'hi', {}, mcp, { exec, probe: false, env, resume: 'ses_1' });
  assert.strictEqual(a[0], 'run'); assert.ok(a.join(' ').includes('--format json'));
  for (const f of ['--model', 'openrouter/x/y', '--variant', 'high', '-s', 'ses_1', '--auto']) assert.ok(a.includes(f), f);
  assert.strictEqual(a[a.length - 1], 'hi');
  assert.deepStrictEqual(readCfg(env).mcp.board, { type: 'local', command: ['/bin/node', 'srv.js'], enabled: true, environment: { SQUAD_NODE: 'n1' } });
  assert.ok(!('provider' in readCfg(env)));
});

test('provider profile: custom endpoint rides the per-run config by env NAME only; native openrouter adds nothing', async () => {
  const rt = RT.getRuntime('opencode');
  const settings = { providers: [{ id: 'lite', label: 'Lite', baseUrl: 'https://p.example/v1', keyEnv: 'LITE_KEY', kind: 'openai' }, { id: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }] };
  const env = {};
  const a = await rt.buildArgs({ model: 'gpt-x', provider: 'lite' }, 'hi', settings, mcp, { exec, probe: false, env });
  assert.strictEqual(a[a.indexOf('--model') + 1], 'lite/gpt-x');
  const cfg = readCfg(env);
  assert.strictEqual(cfg.provider.lite.options.apiKey, '{env:LITE_KEY}');
  assert.strictEqual(cfg.provider.lite.options.baseURL, 'https://p.example/v1');
  assert.ok(cfg.provider.lite.models['gpt-x']);
  assert.ok(!JSON.stringify(a).includes('LITE_KEY'));
  const env2 = {};
  await rt.buildArgs({ model: 'google/gemini-flash', provider: 'openrouter' }, 'hi', settings, mcp, { exec, probe: false, env: env2 });
  assert.ok(!('provider' in readCfg(env2)));
  assert.strictEqual(RT.providerModelArg(settings.providers[1], 'openrouter/a/b'), 'openrouter/a/b');
});

test('opencode flag derivation: --auto is found as the bypass flag from its own description', () => {
  assert.strictEqual(IN.findBypassFlag(fx('help-opencode-real-run.txt')), '--auto');
});

test('opencode parsing on the recorded live stream: tools, text, usage per finished step', async () => {
  const rt = RT.getRuntime('opencode');
  const probeExec = (bin, a) => (a.includes('--format') ? fx('probe-opencode-live.jsonl') : exec(bin, a));
  await rt.buildArgs({}, 'hi', {}, null, { exec: probeExec, env: {} }); // caches the probed profile for parseEvent
  const kinds = new Set(); let tokens = 0;
  for (const ev of events) {
    const o = rt.parseEvent(ev, {});
    for (const [k] of o.logs) { kinds.add(k); assert.notStrictEqual(k, 'error', JSON.stringify(o.logs)); }
    if (o.tokens) tokens++;
  }
  assert.ok(kinds.has('tool_result'));
  assert.ok(tokens <= events.filter((e) => e.type === 'step_finish').length);
});

test('opencode run with no reported cost gets an "estimated" cost from the OpenRouter list price', () => {
  const U = require('../src/usage');
  const priceBook = { estimate: (m, t) => ({ costUsd: t.inputTokens * 2.5e-7 + t.outputTokens * 2e-6, partial: false }) };
  const run = { runtime: 'opencode', model: 'openrouter/openai/gpt-5-mini', inputTokens: 1000, outputTokens: 500, reportedCostUsd: 0, costKnown: false, billingSource: 'api' };
  const [e] = U.buildLedger(run, { priceBook });
  assert.strictEqual(e.costSource, 'estimated'); assert.ok(Math.abs(e.costUsd - 0.00125) < 1e-9);
});
