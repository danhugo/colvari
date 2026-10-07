// Log pane instrumentation (t_a5eb243c): renderLog timings land in PERF.logPane — a ring of the
// last 120 durations plus a slow count above SLOW_MS, inspected via window.__perf.logPane
// (same discipline as the inbox badge ring, t_f6b343a5). Renderer-level per the obs-highlight
// pattern: extract the timing tail of the real renderLog from renderer/app.js and run it against
// a minimal stub, plus source assertions that both early-return paths skip the sampler.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('function renderLog()');
const end = src.indexOf("$('#logteam').onchange", start);
assert.ok(start > 0 && end > start, 'renderLog block found in renderer/app.js');
const block = src.slice(start, end);

function runTail(t0, t1, PERF) {
  const box = { scrollTop: 10, clientHeight: 100, scrollHeight: 200 };
  const fn = new Function('$', 'box', 't0', 'PERF', 'prevTop', 'prevH', 'Chat', 'performance', `
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    ${timingTail}
  `);
  fn(() => box, box, t0, PERF, 0, 0, { anchorScroll: () => 0 }, { now: () => t1 });
  return PERF.logPane;
}

// The exact timing tail of the real renderLog (from the t0 capture to before the closing brace).
const timingTail = block.slice(block.indexOf('const ms = performance.now()')).replace(/\}\s*$/, '');
assert.ok(timingTail.includes('PERF.logPane'), 'timing tail samples PERF.logPane');

test('render duration is pushed into the PERF.logPane ring', () => {
  const PERF = { logPane: { samples: [], slow: 0, SLOW_MS: 16 } };
  const p = runTail(0, 5, PERF);
  assert.equal(p.samples.length, 1);
  assert.equal(Math.round(p.samples[0]), 5);
  assert.equal(p.slow, 0, '5ms is under SLOW_MS=16 — no slow count, no log');
});

test('slow renders bump the counter and cap the ring at 120 samples', () => {
  const PERF = { logPane: { samples: [], slow: 0, SLOW_MS: 16 } };
  runTail(0, 20, PERF);
  const p = runTail(0, 30, PERF);
  assert.equal(p.slow, 2, 'both renders exceeded SLOW_MS');
  assert.deepEqual(p.samples, [20, 30]);
  for (let i = 0; i < 130; i++) runTail(0, 1, PERF);
  assert.equal(PERF.logPane.samples.length, 120, 'ring never grows past 120');
  assert.equal(PERF.logPane.slow, 2, 'fast renders do not count as slow');
});

test('both early-return paths skip the sampler (inactive tab, unchanged signature)', () => {
  const head = block.slice(0, block.indexOf('const t0 = performance.now()'));
  assert.match(head, /if \(!\$\('#tab-obs'\)\.classList\.contains\('active'\)\) return;/);
  assert.match(head, /if \(lkey === logSig\) return;/);
  assert.equal(head.includes('PERF.logPane'), false, 'no sampling before the gates');
});
