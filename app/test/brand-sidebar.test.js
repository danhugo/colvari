const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');

test('brand lives at the top of the left panel, not in the top bar', () => {
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.ok(!/class="brand"/.test(header), 'top bar must not carry the brand');
  const aside = html.slice(html.indexOf('<aside id="sidebar">'));
  assert.match(aside, /^<aside id="sidebar">\s*<strong class="brand">/, 'brand is the first item of the sidebar');
});
