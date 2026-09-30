'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pct, gateDecision } = require('./perf/ab-gate.js');

const mk = (pair, tabMs, attempted, dropped = 0) => ({ pair, tabMs, attempted: attempted || tabMs.length + dropped, dropped, load: { start1m: 5, mid1m: 5, end1m: 5 } });
// 100 samples 20..119 ms: p95 = 20 + floor(99*0.95) = 20 + 94 = 114, p50 = 20 + 49 = 69
const seq = (f) => Array.from({ length: 100 }, (_, i) => f(i));
const A = seq((i) => 20 + (i % 100));
const scale = (a, k) => a.map((x) => x * k);

test('pct matches the harness convention (floor((n-1)*p) on sorted)', () => {
  assert.equal(pct([], 0.5), 0);
  assert.equal(pct([7], 0.95), 7);
  assert.equal(pct(A, 0.95), 114);
  assert.equal(pct(A, 0.5), 69);
});

test('gate passes a clean winner: every pair + >=20% pooled p95 + p50 not worse', () => {
  const d = gateDecision({
    baseRuns: [mk(1, A), mk(2, A), mk(3, A)],
    trackRuns: [mk(1, scale(A, 0.7)), mk(2, scale(A, 0.7)), mk(3, scale(A, 0.7))],
  });
  assert.equal(d.verdict, 'PASS');
  assert.ok(d.everyPair && d.p95Win && d.p50NotWorse);
  assert.equal(d.pooled.base.p95, 114);
  assert.equal(d.pooled.track.p95, 79.8);
});

test('gate fails when the track loses a single pair', () => {
  const d = gateDecision({
    baseRuns: [mk(1, A), mk(2, A), mk(3, A)],
    trackRuns: [mk(1, scale(A, 0.7)), mk(2, scale(A, 1.05)), mk(3, scale(A, 0.7))],
  });
  assert.equal(d.verdict, 'FAIL');
  assert.equal(d.everyPair, false);
  assert.ok(d.reasons.some((r) => r.includes('pair')));
});

test('gate fails on pooled improvement below 20% even if every pair wins', () => {
  const d = gateDecision({
    baseRuns: [mk(1, A), mk(2, A), mk(3, A)],
    trackRuns: [mk(1, scale(A, 0.9)), mk(2, scale(A, 0.9)), mk(3, scale(A, 0.9))],
  });
  assert.equal(d.verdict, 'FAIL');
  assert.equal(d.p95Win, false);
  assert.ok(d.reasons.some((r) => r.includes('pooled p95')));
});

test('gate fails on equal p95 (20% improvement required, ties lose)', () => {
  const d = gateDecision({ baseRuns: [mk(1, A), mk(2, A)], trackRuns: [mk(1, A.slice()), mk(2, A.slice())] });
  assert.equal(d.verdict, 'FAIL');
});

test('gate fails when pooled p50 regresses, even with a big p95 win', () => {
  // track: p95 way lower but p50 higher — long quiet tail, worse typical click
  const track = seq((i) => (i < 60 ? 90 : 30));
  const d = gateDecision({ baseRuns: [mk(1, A), mk(2, A)], trackRuns: [mk(1, track), mk(2, track)] });
  assert.equal(d.p95Win, true);
  assert.equal(d.p50NotWorse, false);
  assert.equal(d.verdict, 'FAIL');
});

test('a run with >20% unresolved clicks drops its pair; counts surface in reasons', () => {
  const d = gateDecision({
    baseRuns: [mk(1, A, 72, 30), mk(2, A)],
    trackRuns: [mk(1, scale(A, 0.5)), mk(2, scale(A, 0.5))],
  });
  assert.equal(d.perPair[0].base, undefined);
  assert.equal(d.perPair[1].trackWinsPair, true);
  assert.ok(d.reasons.some((r) => r.includes('invalid runs dropped: base 1')));
  assert.equal(d.verdict, 'PASS');
});

test('all-invalid runs yield INVALID (rerun, no verdict)', () => {
  const d = gateDecision({
    baseRuns: [mk(1, A, 72, 60), mk(2, A, 72, 50)],
    trackRuns: [mk(1, scale(A, 0.5), 72, 40), mk(2, scale(A, 0.5), 72, 30)],
  });
  assert.equal(d.verdict, 'INVALID');
  assert.ok(d.reasons.some((r) => r.includes('no complete pair')));
});

test('runs with acceptable drop rates still count (boundary 20%)', () => {
  const d = gateDecision({
    baseRuns: [mk(1, A, 100, 20)],
    trackRuns: [mk(1, scale(A, 0.5), 100, 20)],
  });
  assert.equal(d.verdict, 'PASS');
});
