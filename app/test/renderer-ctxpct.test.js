const test = require('node:test');
const assert = require('node:assert');

// orchestrator.js sets contextPct as a 0..1 fraction (tokens/window). The renderer
// must convert to a 0..100 percentage before formatting/rendering/comparing against
// thresholds like autoCompactPct (default 40) or the 85 danger cutoff.
function renderCtxPct(contextPct) {
  return typeof contextPct === 'number' ? Math.round(Math.max(0, Math.min(100, contextPct * 100))) : null;
}

test('renderCtxPct: converts 0..1 fraction to 0..100 percent', () => {
  assert.equal(renderCtxPct(100000 / 200000), 50);
  assert.equal(renderCtxPct(0.85), 85);
  assert.equal(renderCtxPct(0), 0);
  assert.equal(renderCtxPct(1), 100);
  assert.equal(renderCtxPct(null), null);
});
