// Regression (t_9dea9325): while an update veil is up the renderer must keep showing the last
// known-good data instead of swapping in whatever a mid-update read returns. Real incident: after
// the watcher ff-merged but the update aborted, a newly spawned new-code child migrated board.json
// away under the still-running old app; its reads silently returned an empty board and the
// change-driven layer blanked the UI while the veil said "waiting for agents". The freeze logic
// lives in renderer/app.js (not requireable: top-level DOM globals), so extract the real
// implementation and exercise it, per the reset-countdown.test.js pattern.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const grab = (what, re) => { const m = src.match(re); assert.ok(m, `${what} found in renderer/app.js`); return m[0]; };

// Build the freeze closure from the real source with a controllable clock and update state.
function build({ state = 'idle', liveAtAgeMs = 0, now = 1_000_000_000_000 } = {}) {
  const code = [
    `const Date_ = { now: () => ${now} };`,
    grab('UPD_STATES', /const UPD_STATES = \{.*?\};/),
    grab('UPD_FREEZE_GRACE_MS', /const UPD_FREEZE_GRACE_MS = .*?;/),
    `let upd = { state: ${JSON.stringify(state)} };`,
    `let updLiveAt = Date_.now() - ${liveAtAgeMs};`,
    grab('updIsLive', /const updIsLive = [^\n]*/),
    grab('updFrozen', /const updFrozen = [^\n]*/),
    grab('trackUpd', /const trackUpd = [^\n]*/),
    'return { get upd() { return upd; }, set upd(s) { upd = s; }, updIsLive, updFrozen, trackUpd, Date_ };',
  ].join('\n').replaceAll('Date.now()', 'Date_.now()');
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

test('freeze is on for every live update phase', () => {
  for (const state of ['pending', 'draining', 'testing', 'restarting', 'failed']) {
    assert.equal(build({ state }).updFrozen(), true, `state=${state} must freeze the data snapshot`);
  }
});

test('freeze is off when idle and no update ran recently', () => {
  assert.equal(build({ state: 'idle', liveAtAgeMs: 61_000 }).updFrozen(), false);
});

test('grace period: the snapshot stays frozen after the veil hides, then thaws', () => {
  const fresh = build({ state: 'idle', liveAtAgeMs: 59_000 });
  assert.equal(fresh.updFrozen(), true, 'within the grace window after a live phase');
  const gone = build({ state: 'idle', liveAtAgeMs: 60_001 });
  assert.equal(gone.updFrozen(), false, 'past the grace window');
});

test('trackUpd() during a live phase holds the freeze after the phase ends', () => {
  const env = build({ state: 'draining', now: 5_000_000_000_000 });
  env.trackUpd();
  env.upd = { state: 'idle' }; // update aborted/finished
  assert.equal(env.updFrozen(), true, 'freshly-seen live phase keeps the grace freeze');
});

test('trackUpd() ignores idle states', () => {
  const env = build({ state: 'idle', liveAtAgeMs: 999_999_999, now: 5_000_000_000_000 });
  env.trackUpd();
  assert.equal(env.updFrozen(), false, 'an idle-only session never freezes');
});

// The freeze must gate the whole fetch-and-swap, before any IPC: refresh() opens with the guard
// and only then does the version poll, and every place that learns an update is live records it.
test('refresh() checks updFrozen() before fetching anything', () => {
  assert.match(src, /async function refresh\(\) \{\n(  \/\/[^\n]*\n)+  if \(updFrozen\(\)\) \{ await loadSelfUpdate\(\); renderSelfUpdate\(\); return; \}/);
});

test('every upd intake point calls trackUpd()', () => {
  const intake = (what, re) => { const m = src.match(re); assert.ok(m, `${what} body found`); assert.match(m[0], /trackUpd\(\)/, `${what} must call trackUpd()`); };
  intake('loadSelfUpdate', /async function loadSelfUpdate\(\) \{[\s\S]*?\n\}/);
  intake('onUpdPush', /const onUpdPush = [^\n]*/);
  intake('st-autorestart handler', /setAutoRestart', ctx, on[\s\S]*?renderSelfUpdate/);
});
