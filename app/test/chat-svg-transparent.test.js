const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('chat SVG image has no background box', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  const rule = css.match(/\.cgroup \.bubble img\.chat-svg\s*\{([^}]*)\}/);
  assert.ok(rule, 'chat-svg rule exists');
  assert.doesNotMatch(rule[1], /background/);
});
