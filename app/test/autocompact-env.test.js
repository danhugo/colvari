const test = require('node:test');
const assert = require('node:assert');
const { autoCompactEnv } = require('../src/orchestrator.js');

// Bug t_443dd1d4: orchestrator used to send CLAUDE_AUTOCOMPACT_PCT_OVERRIDE as a fraction
// (40 -> "0.4"), but claude >=2.1.284 parses the env as a PERCENT (0-100]:
// threshold = floor(window * pct/100). Verified live on 2.1.284 with a 1M-window model
// (claude-opus-5-5): env=0.4 auto-compacted at pre_tokens 30414 — 0.4% of 1M is 4k tokens,
// below the fixed ~25-30k system-prompt+tools floor, so every session compacted immediately
// and died "Autocompact is thrashing" — while env=40 (threshold 400k), env=10 (100k) and
// unset (window-13000) did not compact. The env must therefore carry the percent itself.
test('autoCompactEnv sends the percent the CLI expects, not the old fraction', () => {
  assert.equal(autoCompactEnv(40), '40'); // default project setting; old code sent "0.4"
  assert.equal(autoCompactEnv(85), '85');
  assert.equal(autoCompactEnv(1), '1');
  assert.equal(autoCompactEnv(100), '100');
  // the old fraction formula, kept here so a regression back to it fails this test
  assert.notEqual(autoCompactEnv(40), String(Math.min(1, 40 / 100)));
});

test('autoCompactEnv clamps out-of-range settings into the CLI-accepted (0,100] band', () => {
  assert.equal(autoCompactEnv(140), '100');
  assert.equal(autoCompactEnv(0.4), '1'); // would otherwise be rejected/thrash like the old "0.4"
  assert.equal(autoCompactEnv(1.4), '1');
});
