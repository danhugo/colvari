// Real-process coverage: spawns test/fixtures/fake-agent-cli.js as an actual child process (not a
// stubbed exec/spawn function) through introspectRuntime and runProfile, so a break in real process
// wiring (arg quoting, stdout buffering, exit codes) shows up here even though other tests fake it.
const test = require('node:test'); const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { introspectRuntime } = require('../src/introspector');
const { runProfile } = require('../src/profile-runner');

const FIXTURE = path.join(__dirname, 'fixtures/fake-agent-cli.js');

test('introspectRuntime derives a working profile from a real spawned process', () => {
  const exec = (bin, args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  const profile = introspectRuntime(FIXTURE, exec, { id: 'fake', label: 'Fake' });
  assert.ok(profile.argsTemplate.includes('run'));
  assert.deepStrictEqual(profile.modelsCommand, ['models']);
  assert.deepStrictEqual(profile.effortValues, ['low', 'medium', 'high']);
  assert.strictEqual(profile.resumeFlag, '--resume');
  assert.deepStrictEqual(profile.mcp, { method: 'json-flag', flag: '--mcp-config' });
  assert.strictEqual(profile.eventMapping.textPath, 'text');
  assert.strictEqual(profile.eventMapping.sessionIdPath, 'session_id');
  assert.strictEqual(profile.eventMapping.costPath, 'total_cost_usd');
  assert.strictEqual(profile.eventMapping.inputPath, 'usage.input_tokens');

  return profile;
});

test('runProfile drives the real fixture process end-to-end (tokens, variant, resume)', async () => {
  const exec = (bin, args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  const profile = introspectRuntime(FIXTURE, exec, { id: 'fake', label: 'Fake' });

  const run1 = await runProfile(profile, { model: 'fake/small', variant: 'high', prompt: 'say pong' });
  assert.strictEqual(run1.exitCode, 0);
  assert.ok(run1.result.includes('variant=high'));
  assert.strictEqual(run1.inputTokens, 12);
  assert.strictEqual(run1.outputTokens, 6);
  assert.strictEqual(run1.reasoningTokens, 2);
  assert.ok(run1.reportedCostUsd > 0);
  assert.ok(run1.sessionId);

  const run2 = await runProfile(profile, { model: 'fake/small', prompt: 'continue', session: run1.sessionId });
  assert.strictEqual(run2.exitCode, 0);
  assert.strictEqual(run2.sessionId, run1.sessionId);
});
