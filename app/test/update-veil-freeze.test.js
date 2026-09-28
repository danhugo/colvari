// Regression (t_9dea9325, narrowed by t_93ffac88): while a store-touching update phase runs, this
// app can share its store with mixed-version processes — once the watcher ff-merges, newly spawned
// children run the NEW code while the app still runs the old, and a new-code store open can
// migrate files away mid-run (board.json was renamed to .bak under the live app, whose old-code
// reads then silently returned an empty board, and the change-driven layer swapped that emptiness
// onto the screen). Only testing/restarting run after the fast-forward and block the main process
// with sync npm, so only they freeze refresh() — plus a 60s grace tracked from those phases only,
// since children also spawn right after an aborted post-merge update. pending/draining touch no
// store, so there the UI must keep following real agent state (t_93ffac88: freezing them staled
// every spinner and swallowed sidebar team clicks for as long as the drain waited on an agent).
// The freeze logic lives in renderer/app.js (not requireable: top-level DOM globals), so extract
// the real implementation and exercise it, per the reset-countdown.test.js pattern.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const grab = (what, re) => { const m = src.match(re); assert.ok(m, `${what} found in renderer/app.js`); return m[0]; };

// Build the freeze closure from the real source with a controllable clock and update state.
// frozenAtAgeMs seeds updFrozenAt (when the last freeze-worthy phase was seen); null means
// "never seen" (0), which is how a session that only ever saw pending/draining/idle behaves.
function build({ state = 'idle', frozenAtAgeMs = null, now = 1_000_000_000_000 } = {}) {
  const seed = frozenAtAgeMs === null ? '0' : `Date_.now() - ${frozenAtAgeMs}`;
  const code = [
    `const Date_ = { now: () => ${now} };`,
    grab('UPD_STATES', /const UPD_STATES = \{.*?\};/),
    grab('UPD_FREEZE_GRACE_MS', /const UPD_FREEZE_GRACE_MS = .*?;/),
    `let upd = { state: ${JSON.stringify(state)} };`,
    `let updFrozenAt = ${seed};`,
    grab('updIsLive', /const updIsLive = [^\n]*/),
    grab('updFreezes', /const updFreezes = [^\n]*/),
    grab('updFrozen', /const updFrozen = [^\n]*/),
    grab('trackUpd', /const trackUpd = [^\n]*/),
    'return { get upd() { return upd; }, set upd(s) { upd = s; }, updIsLive, updFreezes, updFrozen, trackUpd, Date_ };',
  ].join('\n').replaceAll('Date.now()', 'Date_.now()');
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

test('freeze is on for the store-touching phases (testing/restarting)', () => {
  for (const state of ['testing', 'restarting']) {
    assert.equal(build({ state }).updFrozen(), true, `state=${state} must freeze the data snapshot`);
  }
});

test('pending/draining/failed never freeze: the UI keeps following real agent state', () => {
  for (const state of ['pending', 'draining', 'failed']) {
    assert.equal(build({ state }).updFrozen(), false, `state=${state} must not freeze`);
  }
});

test('freeze is off when idle and no freeze-worthy phase ran recently', () => {
  assert.equal(build({ state: 'idle' }).updFrozen(), false);
});

test('grace period: the snapshot stays frozen after a store-touching phase hides, then thaws', () => {
  const fresh = build({ state: 'idle', frozenAtAgeMs: 59_000 });
  assert.equal(fresh.updFrozen(), true, 'within the grace window after a freeze-worthy phase');
  const gone = build({ state: 'idle', frozenAtAgeMs: 60_001 });
  assert.equal(gone.updFrozen(), false, 'past the grace window');
});

test('trackUpd() during a store-touching phase holds the freeze after the phase ends', () => {
  const env = build({ state: 'testing', now: 5_000_000_000_000 });
  env.trackUpd();
  env.upd = { state: 'idle' }; // update aborted/finished
  assert.equal(env.updFrozen(), true, 'freshly-seen freeze-worthy phase keeps the grace freeze');
});

test('trackUpd() ignores non-freezing states — the grace only tracks freeze-worthy phases', () => {
  for (const state of ['pending', 'draining', 'failed', 'idle']) {
    const env = build({ state, now: 5_000_000_000_000 });
    env.trackUpd();
    env.upd = { state: 'idle' };
    assert.equal(env.updFrozen(), false, `trackUpd() during ${state} must not start the grace`);
  }
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
