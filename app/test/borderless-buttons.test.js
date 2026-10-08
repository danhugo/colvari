const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// t_2d23aa3d: buttons have no border or glow; inputs keep their 1px edge and focus ring.
test('buttons are borderless, primary is a flat fill', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  assert.match(css, /button \{ cursor:pointer; border-color:transparent;/);
  assert.doesNotMatch(css, /button\.on \{ outline/);
  assert.doesNotMatch(css, /button\.primary[^{]*\{[^}]*(linear-gradient|accent-deep|text-shadow)/);
  assert.match(css, /button, input, select, textarea \{[^}]*border:1px solid var\(--line\)/);
  assert.match(css, /button:focus-visible[^{]*\{[^}]*box-shadow:var\(--ring\)/);
});
