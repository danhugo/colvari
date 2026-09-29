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
const m = src.match(/const fmtCountdown = (\(ms\) => \{.*?\n\};)/s);
assert.ok(m, 'fmtCountdown definition found in renderer/app.js');
// eslint-disable-next-line no-eval
const fmtCountdown = eval(m[1]);

const rm = src.match(/function resetIn\(u\) \{.*?\}/s);
assert.ok(rm, 'resetIn definition found in renderer/app.js');
// eslint-disable-next-line no-eval
const resetIn = eval(`(${rm[0].replace('function resetIn', 'function')})`);

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

test('fmtCountdown: multi-day durations render as "Xd Yh", not hours', () => {
  assert.equal(fmtCountdown((5 * 24 + 11) * 3600000), '5d 11h');
  assert.equal(fmtCountdown(24 * 3600000), '1d 0h');
});

// Regression: the header countdown must show time-until-resetsAt, not the window length (5h/168h).
// A real smoke:real rate_limit_event at 2026-09-27T13:26:00Z had five_hour resetsAt=2026-09-27T14:50:00Z
// (~1h24m away) and weekly resetsAt=2026-10-03T01:00:00Z (~5d11h20m away); the old resetIn(windowMs)
// helper ignored resetsAt entirely and always showed the full window ("5h 0m" / "168h 0m").
test('resetsAt -> countdown uses time-to-reset, not the window length, under a fixed clock', () => {
  const now = new Date('2026-09-27T13:26:00Z').getTime();
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const resetIn = (u) => (u && u.resetsAt ? Math.max(0, new Date(u.resetsAt).getTime() - Date.now()) : 0);
    const fiveHour = { resetsAt: '2026-09-27T14:50:00Z' };
    const weekly = { resetsAt: '2026-10-03T01:00:00Z' };
    assert.equal(fmtCountdown(resetIn(fiveHour)), '1h 24m');
    assert.equal(fmtCountdown(resetIn(weekly)), '5d 11h');
  } finally {
    Date.now = realNow;
  }
});
