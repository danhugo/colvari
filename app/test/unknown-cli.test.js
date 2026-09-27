// Proves the onboarding claim for a CLI the codebase has never heard of: a fake agent CLI with a
// deliberately NON-standard interface (help on stderr + exit 1, "Sub-commands:" rows prefixed with
// the binary name, a run command named "ask", boolean -j/--json, short -m/--model, effort/resume
// flag names the heuristics don't know, no models command, a different event envelope) yields a
// usable draft RuntimeProfile and a working end-to-end run through the existing generic pipeline —
// no src/ changes needed. Also covers the ask-agent fallback path (stubbed): the agent's own JSON
// answer is parsed with introspector.parseJsonLines and schema-validated with
// runtime-profile.normalizeRuntimeProfile before it can drive the runner.
const test = require('node:test'); const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { introspectRuntime, parseJsonLines } = require('../src/introspector');
const { normalizeRuntimeProfile } = require('../src/runtime-profile');
const { runProfile, buildProfileArgs } = require('../src/profile-runner');

const FIXTURE = path.join(__dirname, 'fixtures/fake-odd-cli.js');

// Mirrors the introspector's defaultExec contract (merge stdout+stderr, never throw) but routes
// through `node <fixture>` like fake-cli-fixture.test.js, so the exit-1 --help is exercised too.
const exec = (bin, args) => {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  return String((r.stdout || '') + (r.stderr || ''));
};

test('unknown non-standard CLI: sub-command rows are parsed despite the binary-name prefix', () => {
  const cmds = require('../src/introspector').parseCommands(exec(FIXTURE, ['--help']));
  assert.deepStrictEqual(cmds.map((c) => c.name), ['ask', 'ls-models']);
});

test('unknown non-standard CLI: a usable profile is derived with zero new code', () => {
  const profile = introspectRuntime(FIXTURE, exec, { id: 'oddctl', label: 'Oddctl' });
  assert.strictEqual(profile.binary, FIXTURE);
  assert.deepStrictEqual(profile.argsTemplate, ['ask', '--json', 'json', '--model', '{model}', '{prompt}']);
  assert.deepStrictEqual(profile.modelsCommand, []); // no `models` subcommand -> degrades to unsupported
  assert.deepStrictEqual(profile.effortValues, []); // "--focus (e.g., low, high)" is not a known effort flag
  assert.strictEqual(profile.resumeFlag, ''); // "-c, --continue" is not a known resume shape
  assert.deepStrictEqual(profile.mcp, { method: 'none', flag: '' });
  // The probe run still derived the event mapping from the alien envelope {kind, content,
  // meta.threadId, usage.*, cost_usd} with no per-CLI code:
  assert.strictEqual(profile.eventMapping.textPath, 'content');
  assert.strictEqual(profile.eventMapping.sessionIdPath, 'threadId');
  assert.strictEqual(profile.eventMapping.inputPath, 'usage.prompt_tokens');
  assert.strictEqual(profile.eventMapping.outputPath, 'usage.completion_tokens');
  assert.strictEqual(profile.eventMapping.reasoningPath, 'usage.reasoning_output_tokens');
  assert.strictEqual(profile.eventMapping.costPath, 'cost_usd');
});

test('unknown non-standard CLI: the derived profile drives a real end-to-end run', async () => {
  const profile = introspectRuntime(FIXTURE, exec, { id: 'oddctl', label: 'Oddctl' });
  const run = await runProfile(profile, { model: 'odd/mini', prompt: 'say pong' });
  assert.strictEqual(run.exitCode, 0);
  assert.ok(run.result.includes('odd reply to "say pong" (model=odd/mini)'), run.result);
  assert.ok(/^T-\d+$/.test(run.sessionId), run.sessionId);
  assert.strictEqual(run.inputTokens, 7);
  assert.strictEqual(run.outputTokens, 4);
  assert.strictEqual(run.reasoningTokens, 1);
  assert.strictEqual(run.reportedCostUsd, 0.0002);
});

// Last-resort onboarding path: instead of parsing --help, run the CLI once with a prompt asking the
// agent to describe itself as a RuntimeProfile JSON line. This test stubs the agent's answer; the
// composition it proves is real code: parseJsonLines (tolerates prose around the JSON line) ->
// normalizeRuntimeProfile (schema validation: binary required, types coerced, unknown mcp methods
// degraded, so a hallucinated or prompt-injected profile can't inject arbitrary config).
test('ask-agent fallback (stubbed): agent-emitted JSON is validated and then drives the runner', () => {
  const agentAnswer = [
    'Sure, here is my profile as JSON:',
    JSON.stringify({
      binary: 'oddctl', argsTemplate: ['ask', '--json', '{prompt}'], modelsCommand: [],
      effortValues: [], effortFlag: '', resumeFlag: '-c',
      mcp: { method: 'bogus-method', flag: '--x' }, // invalid on purpose: must degrade to 'none'
      eventMapping: { textPath: 'content', sessionIdPath: 'threadId', inputPath: 'usage.prompt_tokens' },
    }),
  ].join('\n');
  const candidate = parseJsonLines(agentAnswer).reverse().find((e) => e && typeof e === 'object' && !Array.isArray(e));
  assert.ok(candidate, 'agent answer contained no JSON object');
  const profile = normalizeRuntimeProfile({ ...candidate, id: 'oddctl', label: 'Oddctl' });
  assert.strictEqual(profile.binary, 'oddctl');
  assert.strictEqual(profile.resumeFlag, '-c');
  assert.strictEqual(profile.mcp.method, 'none'); // bogus method rejected, not passed through

  const args = buildProfileArgs(profile, { prompt: 'hello' });
  assert.deepStrictEqual(args, ['ask', '--json', 'hello']);

  // And against the real fixture process: the fallback profile runs end-to-end just like an
  // introspector-derived one.
  return runProfile({ ...profile, binary: FIXTURE }, { prompt: 'hello' }).then((run) => {
    assert.strictEqual(run.exitCode, 0);
    assert.ok(run.result.includes('odd reply to "hello"'), run.result);
    assert.ok(/^T-\d+$/.test(run.sessionId), run.sessionId); // meta.threadId via the agent-declared mapping
  });
});

test('ask-agent fallback (stubbed): an answer without a binary is rejected by the schema validator', () => {
  const malicious = JSON.stringify({ argsTemplate: ['sh', '-c', 'evil'], note: 'no binary on purpose' });
  const candidate = parseJsonLines(malicious)[0];
  assert.throws(() => normalizeRuntimeProfile(candidate), /binary/);
});
