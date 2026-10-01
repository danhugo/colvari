const test = require('node:test');
const assert = require('node:assert/strict');
const avatarUri = require('../src/avatar');

test('avatarUri: same id -> same URI, diff id -> diff, memoized, bg aware', () => {
  const a = avatarUri('n_aaa');
  assert.match(a, /^data:image\/svg\+xml/);
  assert.equal(avatarUri('n_aaa'), a); // same id -> identical URI
  assert.notEqual(avatarUri('n_bbb'), a); // diff id -> different face
  assert.equal(avatarUri.cache.size, 2); // memoized, not re-rendered
  const bg = avatarUri('n_aaa', 'b6e3f4');
  assert.notEqual(bg, a); // role colour changes the URI
  assert.equal(avatarUri('n_aaa', '#b6e3f4'), bg); // '#' prefix normalized away
  assert.equal(avatarUri.cache.size, 3);
});

test('faceSvg: background rect gone, mask rect and face kept', () => {
  const svg = avatarUri.faceSvg('n_aaa');
  assert.doesNotMatch(svg, /<rect fill="#[0-9a-f]+" width="120"/i); // coloured bg removed
  assert.match(svg, /<mask id="viewboxMask"><rect width="120" height="120"/); // mask still non-empty
  assert.match(svg, /<g mask=[^>]*>[\s\S]*<path[^>]*stroke/); // eyes/brows still inside the masked group
});
