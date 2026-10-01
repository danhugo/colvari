const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultName, WORDS } = require('../src/agent-name');

test('defaultName: same id -> same word; no duplicates inside a team', () => {
  assert.equal(defaultName('n_abc', 'Dev', []), defaultName('n_abc', 'Dev', []));
  assert.match(defaultName('n_abc', 'Dev', []), /^\w+ · Dev$/);
  const nodes = [];
  for (let i = 0; i < WORDS.length + 3; i++) nodes.push({ name: defaultName('n_same', 'Dev', nodes) });
  assert.equal(new Set(nodes.map((n) => n.name)).size, nodes.length);
});
