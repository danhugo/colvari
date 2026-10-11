const test = require('node:test');
const assert = require('node:assert');
const { RUNTIMES, getRuntime } = require('../src/runtimes');

test('RUNTIMES registry invariants for every built-in runtime', async () => {
  assert.ok(Object.keys(RUNTIMES).length > 0, 'RUNTIMES should not be empty');

  for (const [key, entry] of Object.entries(RUNTIMES)) {
    assert.strictEqual(entry.id, key, `entry.id for "${key}" must equal its key`);
    assert.strictEqual(typeof entry.label, 'string', `entry.label for "${key}" must be a string`);
    assert.ok(entry.label.length > 0, `entry.label for "${key}" must be a non-empty string`);

    assert.strictEqual(typeof entry.bin, 'function', `entry.bin for "${key}" must be a function`);
    const bin = entry.bin({});
    assert.strictEqual(typeof bin, 'string', `entry.bin({}) for "${key}" must return a string`);
    assert.ok(bin.length > 0, `entry.bin({}) for "${key}" must return a non-empty string`);

    const caps = typeof entry.capabilities === 'function' ? await entry.capabilities({}) : entry.capabilities;
    assert.ok(caps && typeof caps === 'object', `capabilities for "${key}" must be an object`);
    assert.strictEqual(typeof caps.tokens, 'boolean', `capabilities.tokens for "${key}" must be boolean`);
    assert.strictEqual(typeof caps.cost, 'boolean', `capabilities.cost for "${key}" must be boolean`);
    assert.strictEqual(typeof caps.mcp, 'boolean', `capabilities.mcp for "${key}" must be boolean`);
    assert.strictEqual(typeof caps.resume, 'boolean', `capabilities.resume for "${key}" must be boolean`);

    assert.strictEqual(typeof entry.buildArgs, 'function', `entry.buildArgs for "${key}" must be a function`);
  }
});

test('getRuntime invariants', () => {
  const defaultRuntime = getRuntime('');
  assert.strictEqual(defaultRuntime, RUNTIMES.claude, "getRuntime('') must return the claude runtime");

  assert.throws(() => {
    getRuntime('nope');
  }, /unknown runtime "nope"/);
});
