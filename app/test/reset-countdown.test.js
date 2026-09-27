// Regression: the top-bar/discovery limit meter's reset countdown (renderer/app.js fmtCountdown) must never
// show "0m" for a resetsAt that is still in the future, however close — sub-minute remainders used to floor
// to 0 minutes with 0 hours, rendering the misleading "0m" (looks like it already reset). Extracted straight
// out of the renderer source (not requireable as a module: top-level DOM globals) so this exercises the real
// implementation, not a reimplementation that could drift from it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const m = src.match(/const fmtCountdown = (\(ms\) => \{.*?\});/s);
assert.ok(m, 'fmtCountdown definition found in renderer/app.js');
// eslint-disable-next-line no-eval
const fmtCountdown = eval(m[1]);

test('fmtCountdown: never renders "0m" for a future resetsAt, seconds away', () => {
  for (const ms of [1, 500, 1000, 30000, 59000, 59999]) {
    const out = fmtCountdown(ms);
    assert.notEqual(out, '0m', `ms=${ms} rendered "${out}"`);
  }
});

test('fmtCountdown: never renders "0m" for a future resetsAt, milliseconds away', () => {
  assert.notEqual(fmtCountdown(1), '0m');
  assert.notEqual(fmtCountdown(0.5), '0m');
});

test('fmtCountdown: "now" only for a resetsAt at/before the present', () => {
  assert.equal(fmtCountdown(0), 'now');
  assert.equal(fmtCountdown(-1), 'now');
});

test('fmtCountdown: whole-minute and whole-hour boundaries still format normally', () => {
  assert.equal(fmtCountdown(60000), '1m');
  assert.equal(fmtCountdown(3600000), '1h 0m');
  assert.equal(fmtCountdown(3660000), '1h 1m');
});
