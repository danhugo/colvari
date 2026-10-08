const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// .hidden must beat later `display:flex` rules of equal specificity (e.g. .wk-emptystate),
// otherwise the wiki "No page selected" empty state shows while a page is open.
test('.hidden class uses display:none !important', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  assert.match(css, /(^|[\s}])\.hidden\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
});
