// Chat append-only room rendering (t_fe51eee9, wiki paperclip-vs-us-perf #5): Chat.tailPlan must
// plan a tail append exactly when the DOM can be extended by the feed's new trailing events, and
// return null (full render) whenever an older event changed, moved, or the window can't slide.
const test = require('node:test');
const assert = require('node:assert');
const Chat = require('../src/chat');

const ev = (at, who, type, extra) => ({ at, who, type: type || 'message', text: `m${at}`, ...extra });

test('tailPlan: pure tail append keeps the whole DOM window', () => {
  const dom = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b')];
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b'), ev(5, 'a')];
  const p = Chat.tailPlan(dom, feed, 100);
  assert.deepEqual(p.fresh.map((e) => e.at), [4, 5]);
  assert.equal(p.keep, 3); // window far from full: nothing evicted
});

test('tailPlan: sliding window evicts exactly what a full render would', () => {
  const dom = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b')];
  const feed = dom.concat([ev(5, 'a'), ev(6, 'a')]);
  const p = Chat.tailPlan(dom, feed, 4);
  assert.deepEqual(p.fresh.map((e) => e.at), [5, 6]);
  assert.equal(p.keep, 2); // last 4 events of the feed = keep 2 old + 2 fresh
});

test('tailPlan: null for empty dom, no news, or a burst bigger than the window', () => {
  const dom = [ev(1, 'a'), ev(2, 'b')];
  assert.equal(Chat.tailPlan([], dom, 100), null);
  assert.equal(Chat.tailPlan(dom, [ev(1, 'a'), ev(2, 'b')], 100), null); // nothing new
  assert.equal(Chat.tailPlan(dom, dom.concat([ev(3, 'a'), ev(4, 'a'), ev(5, 'a')]), 2), null); // delta > win
  assert.equal(Chat.tailPlan(dom, [], 100), null);
});

test('tailPlan: a tool result attached to an older bubble falls back to a full render', () => {
  const dom = [ev(1, 'a', 'tool'), ev(2, 'b')];
  const feed = [ev(1, 'a', 'tool', { result: 'ok' }), ev(2, 'b'), ev(3, 'a')]; // m1 mutated
  assert.equal(Chat.tailPlan(dom, feed, 100), null);
  // ...but the same mutation inside the fresh suffix is a normal append (the bubble is new)
  const ok = [ev(1, 'a', 'tool'), ev(2, 'b'), ev(3, 'a', 'tool', { result: 'ok' })];
  assert.ok(Chat.tailPlan(dom, ok, 100));
});

test('tailPlan: subagent totals and repeat counts on older bubbles fall back', () => {
  const dom = [ev(1, 'a', 'subagent', { total: 3 }), ev(2, 'b')];
  assert.equal(Chat.tailPlan(dom, [ev(1, 'a', 'subagent', { total: 4 }), ev(2, 'b'), ev(3, 'a')], 100), null);
  const domR = [ev(1, 'a', 'message', { count: 2 }), ev(2, 'b')];
  assert.equal(Chat.tailPlan(domR, [ev(1, 'a', 'message', { count: 3 }), ev(2, 'b'), ev(3, 'a')], 100), null);
});

test('tailPlan: a backfilled older event (or equal-at arrival) falls back instead of hiding it', () => {
  const dom = [ev(2, 'a'), ev(3, 'b')];
  assert.equal(Chat.tailPlan(dom, [ev(1, 'c'), ev(2, 'a'), ev(3, 'b')], 100), null); // older straggler
  assert.equal(Chat.tailPlan(dom, [ev(2, 'a'), ev(3, 'b'), ev(3, 'c')], 100), null); // equal-at uncounted by the at-cursor
});

test('tailPlan: end-to-end over roomEvents — a straggler tool result falls back to a full render', () => {
  const logs = () => [
    { at: 1, nodeId: 'n1', kind: 'text', text: 'hello' },
    { at: 2, nodeId: 'n1', kind: 'tool', text: 'Bash ls' },
  ];
  const feed1 = Chat.roomEvents(logs(), [], [], []);
  const later = logs().concat([
    { at: 3, nodeId: 'n1', kind: 'tool_result', text: 'file.txt' }, // attaches to the tool bubble the DOM already drew
    { at: 4, nodeId: 'n1', kind: 'text', text: 'done' },
  ]);
  const feed2 = Chat.roomEvents(later, [], [], []);
  assert.equal(Chat.tailPlan(feed1, feed2, 100), null); // mutated older bubble -> full render, nothing hidden
  // A same-burst tool + result is a normal append: the bubble is new, its result rides along.
  const burst1 = Chat.roomEvents([{ at: 1, nodeId: 'n1', kind: 'text', text: 'go' }], [], [], []);
  const burst2 = Chat.roomEvents([
    { at: 1, nodeId: 'n1', kind: 'text', text: 'go' },
    { at: 2, nodeId: 'n1', kind: 'tool', text: 'Bash ls' },
    { at: 3, nodeId: 'n1', kind: 'tool_result', text: 'file.txt' },
  ], [], [], []);
  const p = Chat.tailPlan(burst1, burst2, 100);
  assert.deepEqual(p.fresh.map((e) => e.at), [2]);
  assert.equal(p.keep, 1);
});
