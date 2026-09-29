const test = require('node:test'); const assert = require('node:assert');
const { normalizeRuntimeProfile, fillArgsTemplate } = require('../src/runtime-profile');

test('normalizeRuntimeProfile fills defaults and requires a binary', () => {
  assert.throws(() => normalizeRuntimeProfile({}), /binary/);
  const p = normalizeRuntimeProfile({ binary: 'helpycode' });
  assert.strictEqual(p.label, 'helpycode');
  assert.deepStrictEqual(p.argsTemplate, ['{prompt}']);
  assert.deepStrictEqual(p.mcp, { method: 'none', flag: '' });
  assert.deepStrictEqual(p.eventMapping.textPath, '');
});

test('normalizeRuntimeProfile validates mcp method and keeps custom fields', () => {
  const p = normalizeRuntimeProfile({ binary: 'x', mcp: { method: 'json-flag', flag: '--mcp' }, effortValues: ['low', 'high'], resumeFlag: '--resume' });
  assert.deepStrictEqual(p.mcp, { method: 'json-flag', flag: '--mcp' });
  assert.deepStrictEqual(p.effortValues, ['low', 'high']);
  assert.strictEqual(p.resumeFlag, '--resume');
  const bad = normalizeRuntimeProfile({ binary: 'x', mcp: { method: 'bogus' } });
  assert.strictEqual(bad.mcp.method, 'none');
});

test('fillArgsTemplate substitutes placeholders inside tokens', () => {
  const out = fillArgsTemplate(['run', '--model={model}', '--effort', '{variant}', '{prompt}'], { model: 'm1', variant: 'high', prompt: 'hi' });
  assert.deepStrictEqual(out, ['run', '--model=m1', '--effort', 'high', 'hi']);
  const missing = fillArgsTemplate(['{session}'], {});
  assert.deepStrictEqual(missing, ['']);
});
