// Graph layout cache (t_38aa0017): buildView re-runs treeLayout on every render while graphAuto
// is on, but the tidy tree is a pure function of the visible ids (core flag included), the assign
// edges and the canvas aspect. Renderer-level per the log-pane-defer pattern: extract the real
// treeLayout block from renderer/app.js and run it against a DOM stub — an unchanged signature
// must return the SAME position map (no re-placement), and any layout-relevant change must
// recompute. Non-assign edges are deliberately absent from the signature: the layout ignores them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const aStart = src.indexOf('let tlCache = { sig: \'\', pos: null };');
const aEnd = src.indexOf('function buildView() {');
assert.ok(aStart > 0 && aEnd > aStart, 'treeLayout + cache block found in renderer/app.js');
const block = src.slice(aStart, aEnd);
// The cache check must sit before the placement work and the result must be stored back.
assert.ok(block.indexOf('if (tlCache.sig === sig) return tlCache.pos;') < block.indexOf('const place ='), 'cache hit short-circuits before placement');
assert.ok(block.includes('tlCache = { sig, pos };'), 'computed layout is stored in the cache');

const makeTreeLayout = (rect) => {
  const fn = new Function('$', 'W', 'H', block + '\nreturn treeLayout;');
  return fn(() => ({ getBoundingClientRect: () => rect }), 184, 80);
};
const N = (id, core) => ({ id, core: !!core });
const E = (from, to) => ({ id: from + '-' + to, from, to, type: 'assign' });
const rect = { width: 1200, height: 700 };

test('an unchanged signature returns the same position map without re-placing', () => {
  const tl = makeTreeLayout(rect);
  const nodes = [N('a', true), N('b'), N('c')], edges = [E('a', 'b'), E('a', 'c')];
  const p1 = tl(nodes, edges);
  const p2 = tl(nodes, edges);
  assert.strictEqual(p2, p1, 'second identical call is a cache hit (same object)');
  assert.ok(p1.a && p1.b && p1.c, 'all nodes placed');
});

test('layout-relevant changes recompute: edges, core flag, aspect', () => {
  const tl = makeTreeLayout(rect);
  const nodes = [N('a', true), N('b'), N('c')], edges = [E('a', 'b'), E('a', 'c')];
  const p1 = tl(nodes, edges);
  assert.notStrictEqual(tl(nodes, [E('a', 'b'), E('b', 'c')]), p1, 'edge change recomputes');
  assert.notStrictEqual(tl([N('a'), N('b'), N('c')], edges), p1, 'core-flag change recomputes');
  const p3 = tl(nodes, edges); // back to the first shape: fresh compute (cache holds one entry)
  assert.notStrictEqual(p3, p1, 'cache is single-entry: the evicted signature recomputes');
  const tl2 = makeTreeLayout({ width: 500, height: 900 });
  assert.notStrictEqual(tl2(nodes, edges), p3, 'aspect change recomputes');
});

test('non-assign edges stay a cache hit — the layout ignores them', () => {
  const tl = makeTreeLayout(rect);
  const nodes = [N('a', true), N('b')], edges = [E('a', 'b')];
  const p1 = tl(nodes, edges);
  assert.strictEqual(tl(nodes, [E('a', 'b'), { id: 'w', from: 'b', to: 'a', type: 'watch' }]), p1, 'watch edge does not invalidate');
});
