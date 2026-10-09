// Provider profiles (t_7a95202c, openrouter-runtimes): settings.providers shape + validation,
// per-runtime arg/env mapping (codex -c flags, pi --provider, env-only key passthrough),
// OpenRouter cost attribution, and redaction of sk-or- keys.
const test = require('node:test'); const assert = require('node:assert');
const AC = require('../src/agent-config');
const RT = require('../src/runtimes');
const U = require('../src/usage');
const { redactError } = require('../src/failures');

const OR = { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', kind: 'openrouter' };

test('normalizeProviders: shape contract {id,label,baseUrl,keyEnv,kind}', () => {
  assert.deepStrictEqual(AC.normalizeProviders([OR]), [OR]);
  assert.deepStrictEqual(AC.normalizeProviders(undefined), []);
  assert.deepStrictEqual(AC.normalizeProviders([]), []);
  // label defaults to id; native needs no baseUrl
  assert.deepStrictEqual(AC.normalizeProviders([{ id: 'x', kind: 'native' }]), [{ id: 'x', label: 'x', baseUrl: '', keyEnv: '', kind: 'native' }]);
});
test('normalizeProviders rejects bad kind, bad baseUrl, duplicate ids, bad keyEnv, openrouter without keyEnv', () => {
  assert.throws(() => AC.normalizeProviders([{ id: 'a', kind: 'weird' }]), /kind must be one of/);
  assert.throws(() => AC.normalizeProviders([{ id: 'a', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }]), /needs keyEnv/);
  assert.throws(() => AC.normalizeProviders([{ id: 'a', kind: 'litellm', baseUrl: 'localhost:4000' }]), /baseUrl must start with/);
  assert.throws(() => AC.normalizeProviders([OR, { ...OR, label: 'dupe' }]), /duplicate provider id/);
  assert.throws(() => AC.normalizeProviders([{ id: 'a', kind: 'native', keyEnv: 'not an env' }]), /keyEnv must be an environment variable name/);
  assert.throws(() => AC.normalizeProviders([{ id: 'bad id!', kind: 'native' }]), /letters, digits/);
  assert.throws(() => AC.normalizeProviders('nope'), /must be an array/);
});
test('resolveProvider: empty/unknown ids', () => {
  assert.strictEqual(AC.resolveProvider([OR], ''), null);
  assert.strictEqual(AC.resolveProvider([OR], null), null);
  assert.deepStrictEqual(AC.resolveProvider([OR], 'openrouter'), OR);
  assert.throws(() => AC.resolveProvider([OR], 'nope'), /unknown provider "nope"/);
});
test('agent provider field: defaults empty, passes through', () => {
  assert.strictEqual(AC.normalizeNode({}).provider, '');
  assert.strictEqual(AC.normalizeNode({ provider: 'openrouter' }).provider, 'openrouter');
  assert.strictEqual(AC.normalizeNode({ provider: '  ' }).provider, '');
});

test('codex buildArgs maps a provider profile to -c flags; key value never in argv', () => {
  const settings = { providers: [OR], permissionMode: 'bypassPermissions' };
  const a = RT.getRuntime('codex').buildArgs({ model: 'openai/gpt-4.1-mini', provider: 'openrouter' }, 'hi', settings, {});
  const i = a.indexOf('-c');
  assert.ok(i > 0, 'provider -c flags present');
  // provider flags are contiguous, right before extraArgs/resume/prompt (none set here)
  assert.deepStrictEqual(a.slice(i, -1), [
    '-c', 'model_provider="openrouter"',
    '-c', 'model_providers.openrouter.name="OpenRouter"',
    '-c', 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
    '-c', 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    '-c', 'model_providers.openrouter.wire_api="responses"',
  ]);
  assert.strictEqual(a[a.length - 1], 'hi');
  // the KEY VALUE must never ride argv (it travels env-only via env_key's NAME)
  assert.ok(!a.some((x) => String(x).includes('sk-or-')));
});
test('codex buildArgs without provider or with native kind: unchanged', () => {
  const base = ['exec', '--json', '--skip-git-repo-check', '-m', 'm1', 'hi'];
  assert.deepStrictEqual(RT.getRuntime('codex').buildArgs({ model: 'm1' }, 'hi', {}, {}), base);
  const native = { id: 'n', label: 'n', baseUrl: '', keyEnv: '', kind: 'native' };
  assert.deepStrictEqual(RT.getRuntime('codex').buildArgs({ model: 'm1', provider: 'n' }, 'hi', { providers: [native] }, {}), base);
  assert.throws(() => RT.getRuntime('codex').buildArgs({ provider: 'ghost' }, 'hi', { providers: [OR] }, {}), /unknown provider "ghost"/);
});
test('codex litellm profile: base_url + env_key, no wire_api override', () => {
  const litellm = { id: 'litellm', label: 'LiteLLM', baseUrl: 'http://localhost:4000', keyEnv: 'LITELLM_KEY', kind: 'litellm' };
  const a = RT.getRuntime('codex').buildArgs({ provider: 'litellm' }, 'hi', { providers: [litellm] }, {});
  assert.ok(a.includes('model_provider="litellm"'));
  assert.ok(a.includes('model_providers.litellm.base_url="http://localhost:4000"'));
  assert.ok(!a.some((x) => String(x).includes('wire_api')));
});
test('pi buildArgs: --provider only for a known profile', () => {
  const a = RT.getRuntime('pi').buildArgs({ provider: 'openrouter', model: 'x' }, 'hi', { providers: [OR] }, {});
  assert.deepStrictEqual(a, ['-p', '--mode', 'json', '--model', 'x', '--provider', 'openrouter', '--thinking', 'low', 'hi']);
  assert.throws(() => RT.getRuntime('pi').buildArgs({ provider: 'nope', model: 'x' }, 'hi', { providers: [OR] }, {}), /unknown provider "nope"/);
  assert.deepStrictEqual(RT.getRuntime('pi').buildArgs({}, 'hi', {}, {}), ['-p', '--mode', 'json', '--thinking', 'low', 'hi']);
});

test('applyProviderEnv: key rides env->env only, warns when nowhere', () => {
  const orig = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    let r = U.applyProviderEnv(OR, {});
    assert.deepStrictEqual(r.warnings, ['provider "openrouter" needs OPENROUTER_API_KEY in the environment (set it in the agent\'s env vars or your shell)']);
    assert.ok(!('OPENROUTER_API_KEY' in r.env));
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-testkeyvalue';
    r = U.applyProviderEnv(OR, { OTHER: '1' });
    assert.strictEqual(r.env.OPENROUTER_API_KEY, 'sk-or-v1-testkeyvalue'); assert.strictEqual(r.warnings.length, 0);
    r = U.applyProviderEnv(OR, { OPENROUTER_API_KEY: 'from-agent-env' });
    assert.strictEqual(r.env.OPENROUTER_API_KEY, 'from-agent-env'); // agent/project env wins
    assert.deepStrictEqual(U.applyProviderEnv(null, { A: '1' }).env, { A: '1' });
    assert.deepStrictEqual(U.applyProviderEnv({ id: 'n', kind: 'native' }, { A: '1' }).env, { A: '1' });
  } finally { if (orig != null) process.env.OPENROUTER_API_KEY = orig; else delete process.env.OPENROUTER_API_KEY; }
});
test('providerBaseOf: generalised beyond ANTHROPIC_BASE_URL', () => {
  assert.strictEqual(U.providerBaseOf({ ANTHROPIC_BASE_URL: 'http://proxy:4000' }, OR), 'http://proxy:4000');
  assert.strictEqual(U.providerBaseOf({ OTHER: '1' }, OR), 'https://openrouter.ai/api/v1');
  assert.strictEqual(U.providerBaseOf({ OTHER: '1' }, { id: 'n', kind: 'native', baseUrl: 'http://x' }), null);
  assert.strictEqual(U.providerBaseOf({}, null), null);
});

test('detectBilling: provider profile routes attribution (openrouter api / litellm proxy)', () => {
  const b = U.detectBilling({ OPENROUTER_API_KEY: 'k' }, null, OR);
  assert.strictEqual(b.source, 'api'); assert.strictEqual(b.providerId, 'openrouter');
  assert.match(b.detail, /openrouter \(openrouter\.ai\)/);
  const l = U.detectBilling({ LITELLM_KEY: 'k' }, null, { id: 'litellm', label: 'LiteLLM', baseUrl: 'http://localhost:4000', keyEnv: 'LITELLM_KEY', kind: 'litellm' });
  assert.strictEqual(l.source, 'proxy'); assert.strictEqual(l.providerId, 'litellm');
  // key env missing -> the run did not bill through it; generic detection carries on
  assert.strictEqual(U.detectBilling({}, null, OR).source, 'unknown');
  // claude proxy env still wins its own path when no profile applies
  assert.strictEqual(U.detectBilling({ ANTHROPIC_BASE_URL: 'http://p' }, null, null).source, 'proxy');
});
test('providerOf: an explicit providerId beats the model-id hint', () => {
  assert.strictEqual(U.providerOf({ providerHint: 'openai', billingSource: 'api', providerId: 'openrouter' }), 'openrouter');
  assert.strictEqual(U.providerOf({ muProvider: 'firstParty', providerId: 'openrouter' }), 'firstParty'); // CLI's own label still wins
  assert.strictEqual(U.providerOf({ providerHint: 'openai', billingSource: 'api' }), 'openai');
});

test('openrouter run attribution: provider openrouter, cost estimated from the PriceBook when unreported', () => {
  const usage = U.newRun({ runtime: 'codex', model: 'openai/gpt-4.1-mini' });
  // a codex turn.completed event: tokens reported, cost never
  U.applyEvent(usage, { type: 'result', usage: { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 500 } });
  const run = U.finishRun(usage, {
    code: 0, env: { OPENROUTER_API_KEY: 'k' }, billingMode: 'auto', startedMs: Date.now() - 10,
    provider: OR, priceBook: { estimate: (m, t) => ({ costUsd: (t.inputTokens * 0.4 + t.outputTokens * 1.6) / 1e6, partial: false }) },
  });
  assert.strictEqual(run.billingSource, 'api');
  assert.strictEqual(run.ledger.length, 1);
  const e = run.ledger[0];
  assert.strictEqual(e.provider, 'openrouter');
  assert.strictEqual(e.model, 'gpt-4.1-mini');
  assert.strictEqual(e.costSource, 'estimated');
  assert.ok(e.costUsd > 0);
  assert.strictEqual(e.billed, e.costUsd);
  // usageLedger aggregate keeps the account on its persisted entries
  const agg = U.usageLedger([run]);
  assert.strictEqual(agg.rows.length, 1);
  assert.strictEqual(agg.rows[0].provider, 'openrouter');
  assert.strictEqual(agg.rows[0].costSource, 'estimated');
});
test('openrouter run with no price: cost stays unknown, provider still attributed', () => {
  const usage = U.newRun({ runtime: 'codex', model: 'cheap/model-x' });
  U.applyEvent(usage, { type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
  const run = U.finishRun(usage, { code: 0, env: { OPENROUTER_API_KEY: 'k' }, provider: OR, priceBook: { estimate: () => ({ costUsd: null, partial: false, priced: false }) } });
  assert.strictEqual(run.ledger[0].provider, 'openrouter');
  assert.strictEqual(run.ledger[0].costSource, 'unknown');
  assert.strictEqual(run.ledger[0].costUsd, null);
});
test('runs without a provider profile keep today\'s attribution', () => {
  const usage = U.newRun({ runtime: 'codex', model: 'openai/gpt-4.1-mini' });
  U.applyEvent(usage, { type: 'result', usage: { input_tokens: 1000, output_tokens: 100 } });
  const run = U.finishRun(usage, { code: 0, env: {}, provider: null });
  assert.strictEqual(run.billingSource, 'unknown');
  assert.strictEqual(run.ledger[0].provider, 'openai'); // from the model id's org prefix, as before
});

test('redactError covers sk-or-v1 keys and the codex argv shape leaks no key value', () => {
  const key = 'sk-or-v1-REDACTED';
  assert.strictEqual(redactError(`request failed: ${key} rejected`), 'request failed: [REDACTED] rejected');
  // argv only ever carries the env var NAME (env_key) — simulate an error embedding the full argv
  const argv = ['exec', '-c', 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"', '-m', 'openai/gpt-4.1-mini'];
  const out = redactError(`codex ${argv.join(' ')} failed: 401 for key ${key}`);
  assert.ok(!out.includes('sk-or-'));
  assert.ok(out.includes('OPENROUTER_API_KEY')); // the name is fine to surface
});
