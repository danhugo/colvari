// Static budget gate (t_e116438b): keeps the idle-CPU budget from creeping back.
// The t_09b11191 baseline showed what breaks it: infinite CSS animations (repaint every frame,
// the #1 idle/streaming culprit) and fast always-on renderer timers that rebuild signatures or
// DOM when nothing changed. Both are cheap to assert statically, so every npm test runs this.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('style.css infinite animations are compositor-only, paused when hidden, off for reduced motion (t_edaa52ea)', () => {
  const css = read('renderer/style.css');
  const names = [...css.matchAll(/animation[^;{}]*infinite/gi)].map((m) => (m[0].match(/animation\s*:\s*([\w-]+)/) || [])[1]);
  for (const n of names) {
    const kf = css.match(new RegExp(`@keyframes ${n}\\s*\\{((?:[^{}]*\\{[^}]*\\})*)[^{}]*\\}`));
    assert.ok(kf, `missing @keyframes ${n}`);
    const props = [...kf[1].matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual(props.filter((p) => p !== 'transform' && p !== 'opacity'), [], `@keyframes ${n} repaints every frame — animate only transform/opacity`);
  }
  assert.deepEqual([...new Set(names)], ['ringspin'], 'only the working ring may loop');
  assert.match(css, /\.anim-paused [^{]*\{[^}]*animation-play-state:\s*paused/, 'ring must pause when the window is hidden/blurred');
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{[^@]*\.avatar\.working::after[^}]*animation:\s*none/, 'ring must stop for reduced motion');
  assert.match(read('renderer/app.js'), /anim-paused/, 'renderer toggles .anim-paused on hide/blur');
});

test('renderer keeps no fast fixed timers: every setInterval is >= 2s and none drives chat', () => {
  const src = read('renderer/app.js');
  const intervals = [...src.matchAll(/setInterval\(([\s\S]*?),\s*(\d+(?:[eE]\d+)?)\s*\)\s*;/g)];
  assert.ok(intervals.length >= 2, 'sanity: expected the slow backstop intervals to still exist');
  for (const [, body, ms] of intervals) {
    assert.ok(Number(ms) >= 2000, `renderer setInterval fires every ${ms}ms (${body.trim().slice(0, 60)}...) — sub-2s fixed timers are how the idle CPU budget was lost`);
  }
  assert.ok(!/setInterval\([^)]*renderChat/.test(src), 'chat must stay event-driven (chatSched bumps), never timer-driven');
});

test('chat skips renders with an O(1) counter, not a signature over the feed (t_e116438b bar)', () => {
  const src = read('renderer/app.js');
  assert.ok(src.includes('RenderSched.create'), 'chat scheduling must go through the event-driven scheduler');
  assert.ok(!/Chat\.feedKey\s*\(/.test(src), 'renderer must not rebuild an all-events signature per render check — use the epoch counter');
});
