const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('working ring follows avatar shape (round lead, squircle others)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  const rule = css.match(/\.avatar\.working::after\s*\{([^}]*)\}/);
  assert.ok(rule, 'working ring rule exists');
  assert.match(rule[1], /border-radius:\s*inherit/);
});
