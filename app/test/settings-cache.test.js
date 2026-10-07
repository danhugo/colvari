// Settings memo (t_38e12d55): getSettings is polled by periodic main-thread timers (stall sweep
// every 5s, nudge/review watchdogs) — warm reads must be memory-only (one stat), with the stat sig
// invalidating on own-process and out-of-process writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { mktemp } = require('./harness/tmp');

test('warm getSettings hits no disk', () => {
  const d = mktemp('setcache-warm-');
  const s = new Store(d);
  s.getSettings(); // cold call seeds the memo (file absent -> defaults)
  const orig = fs.readFileSync; let reads = 0;
  fs.readFileSync = (...a) => { reads++; return orig(...a); };
  try {
    assert.equal(s.getSettings().stallTimeoutMin, 10);
    assert.equal(s.getSettings().maxAgents, 6);
    assert.equal(reads, 0, 'warm getSettings must not read any file');
  } finally { fs.readFileSync = orig; }
  fs.rmSync(d, { recursive: true, force: true });
});

test('out-of-process settings write is picked up on the next read', () => {
  const d = mktemp('setcache-ext-');
  const s = new Store(d);
  assert.equal(s.getSettings().maxConcurrency, 8);
  const tmp = path.join(d, '.settings.json.tmp'); // another process's atomic write shape
  fs.writeFileSync(tmp, JSON.stringify({ maxConcurrency: 3 }));
  fs.renameSync(tmp, path.join(d, 'settings.json'));
  assert.equal(s.getSettings().maxConcurrency, 3);
  fs.rmSync(d, { recursive: true, force: true });
});

test('own saveSettings is visible immediately and re-memoized', () => {
  const d = mktemp('setcache-own-');
  const s = new Store(d);
  assert.equal(s.saveSettings({ stallTimeoutMin: 2 }).stallTimeoutMin, 2);
  const orig = fs.readFileSync; let reads = 0;
  fs.readFileSync = (...a) => { reads++; return orig(...a); };
  try {
    assert.equal(s.getSettings().stallTimeoutMin, 2);
    assert.equal(reads, 0, 'post-save warm read must be memoized too');
  } finally { fs.readFileSync = orig; }
  fs.rmSync(d, { recursive: true, force: true });
});
