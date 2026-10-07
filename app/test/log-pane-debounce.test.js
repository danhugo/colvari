// Log-pane full-rebuild debounce (t_4d09a271): when the fast tail-append bails (search/level
// filter on, subagent lines), every streamed flush used to run the full renderLog (~56ms at
// profile sizes) — up to 60 rebuilds/s while agents stream. flushLogTail now coalesces the
// fallback through scheduleLogRebuild (150ms trailing). Renderer-level per the chat-patch
// pattern: extract the real flush block from renderer/app.js and run it against a minimal DOM
// stub; fails on pre-fix code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('let logFlushQueued = false, logTailDirty = false;');
const end = src.indexOf('// Fast append path');
assert.ok(start > 0 && end > start, 'log flush block found in renderer/app.js');
const block = src.slice(start, end);

const el = (props) => Object.assign({
  innerHTML: '', value: '', scrollTop: 0, clientHeight: 1000, scrollHeight: 1000, checked: true,
  classList: { contains: () => true },
}, props);
const els = {
  '#tab-obs': el({}),
  '#log': el({}),
};

const factory = (winItems = 40) => {
  const calls = { renderLog: 0, renderLive: 0 };
  const names = ['$', 'document', 'requestAnimationFrame', 'setTimeout', 'appendLogTail', 'renderLog', 'renderLive'];
  const args = [
    (x) => els[x],
    { hidden: false },
    () => {}, // rAF: never fires here — only the setTimeout fallback runs (occluded-window path)
    (fn, ms) => setTimeout(fn, Math.min(ms, 20)), // shrink the 150ms window for fast tests
    () => false, // appendLogTail always bails -> the full-render fallback
    Object.assign(() => { calls.renderLog++; }, { winItems, total: winItems }),
    () => { calls.renderLive++; },
  ];
  const api = new Function(...names, `${block}\nreturn { flushLogTail, scheduleLogRebuild, dirty: () => logTailDirty };`)(...args);
  return { api, calls };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('full-render fallback is coalesced: 10 rapid flushes run renderLog once', async () => {
  const { api, calls } = factory();
  for (let i = 0; i < 10; i++) api.flushLogTail();
  assert.strictEqual(calls.renderLog, 0, 'no synchronous rebuild while a trailing window is open');
  await wait(80);
  assert.strictEqual(calls.renderLog, 1, 'exactly one trailing rebuild landed');
  assert.strictEqual(calls.renderLive, 10, 'renderLive still follows every flush');
});

test('an empty pane paints immediately (first draw / tab activation)', () => {
  const { api, calls } = factory(0); // winItems 0: the pane has never drawn
  api.flushLogTail();
  assert.strictEqual(calls.renderLog, 1, 'empty pane rebuilds synchronously, no debounce');
});

test('scrolled away at fire time defers to the scroll handler instead of anchor-jumping', async () => {
  const { api, calls } = factory();
  els['#log'].scrollTop = 0; els['#log'].scrollHeight = 1000; // pinned at flush time
  api.flushLogTail();
  els['#log'].scrollTop = 500; els['#log'].scrollHeight = 2000; // user scrolled up before the timer
  await wait(80);
  assert.strictEqual(calls.renderLog, 0, 'no rebuild while the user reads history');
  assert.strictEqual(api.dirty(), true, 'the scroll handler owns the rebuild via logTailDirty');
});
