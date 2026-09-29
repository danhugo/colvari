// Windowing (t_fb193107): chat + logs render only the latest window; scrolling near the top
// prepends the next older page. A 5k-message fixture proves the rendered window stays bounded,
// page growth is contiguous, and the prepend keeps the scroll anchor stable.
const test = require('node:test');
const assert = require('node:assert');
const Chat = require('../src/chat');

const ev5k = () => Array.from({ length: 5000 }, (_, i) => ({ at: i, who: i % 7 ? 'b' : 'a', type: 'thought', text: 'line-' + i }));
const logs5k = () => Array.from({ length: 5000 }, (_, i) => ({ nodeId: i % 7 ? 'b' : 'a', kind: 'text', text: 'line-' + i, at: i }));

test('pageOf: only the latest page is rendered, hidden counts the rest', () => {
  const ev = ev5k();
  const p = Chat.pageOf(ev, Chat.PAGE);
  assert.equal(p.items.length, Chat.PAGE);
  assert.equal(p.hidden, ev.length - Chat.PAGE);
  assert.deepEqual(p.items.map((e) => e.text), ev.slice(-Chat.PAGE).map((e) => e.text)); // newest page, in order
  assert.deepEqual(Chat.pageOf([], Chat.PAGE), { items: [], hidden: 0 });
  assert.deepEqual(Chat.pageOf(ev.slice(0, 3), Chat.PAGE).hidden, 0); // small history: no older bar
});

test('5k messages: roomEvents output stays capped and the default window renders one page', () => {
  const ev = Chat.roomEvents(logs5k(), [], [], []);
  assert.equal(ev.length, Chat.MAX); // compute cap unchanged (500)
  const page = Chat.pageOf(ev, Chat.PAGE);
  assert.ok(page.items.length <= Chat.PAGE);
  assert.ok(Chat.group(page.items).length <= page.items.length); // grouping never grows the DOM count
});

test('scroll-up loads older pages contiguously, and enough pages reach the oldest event', () => {
  const ev = Chat.roomEvents(logs5k(), [], [], []);
  const w1 = Chat.pageOf(ev, Chat.PAGE), w2 = Chat.pageOf(ev, 2 * Chat.PAGE);
  assert.equal(w2.items.length, 2 * Chat.PAGE);
  assert.deepEqual(w2.items.slice(-Chat.PAGE), w1.items); // the previous window is kept verbatim as the tail
  assert.equal(w1.hidden - w2.hidden, Chat.PAGE); // exactly one page prepended per growth
  let win = Chat.PAGE, page = w1;
  while (page.hidden > 0) { page = Chat.pageOf(ev, win += Chat.PAGE); }
  assert.equal(page.hidden, 0); // no older bar left
  assert.deepEqual(page.items, ev); // fully scrolled-back history (bounded by MAX)
});

test('anchorScroll: prepending above the viewport keeps the visible content in place', () => {
  assert.equal(Chat.anchorScroll(500, 2000, 2300), 800); // 300px added above -> shift down by 300
  assert.equal(Chat.anchorScroll(500, 2000, 2000), 500); // same height -> unchanged
  assert.equal(Chat.anchorScroll(500, 2000, 100), 0); // content shrank below the anchor -> clamp at top
});

test('windowing leaves the memo layer alone: feedKey ignores the window, MAX unchanged', () => {
  const base = () => ({ projectId: 'p1', thread: null, logs: logs5k().slice(0, 10), tasks: [], messages: [], inbox: [], nodes: [], working: new Set(), agents: {}, runs: [] });
  assert.equal(Chat.feedKey(base()), Chat.feedKey(base()));
  assert.equal(Chat.MAX, 500);
  assert.equal(Chat.PAGE, 100);
});
