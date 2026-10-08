'use strict';
// Header is a window drag region; its buttons must opt out or they can't be clicked (regression from t_1efad5d8).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('header buttons are excluded from the drag region', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  assert.match(css, /header\s*\{\s*-webkit-app-region:\s*drag/);
  const m = css.match(/([^{}]*)\{\s*-webkit-app-region:\s*no-drag/);
  assert.ok(m, 'a no-drag rule exists');
  assert.match(m[1], /header button/);
});
