// Chat append/patch room planning (t_1fb02462, extends t_fe51eee9): Chat.tailPlan must plan the
// minimal DOM change — evict what slid out, keep fp-confirmed groups, rebuild from the first
// group that isn't — and return null (full render) whenever the DOM can't be mapped onto the
// fresh window. prependPlan must plan a scroll-up older page only when the drawn room is exactly
// the fp-matching tail of the grown window.
const test = require('node:test');
const assert = require('node:assert');
const Chat = require('../src/chat');

const ev = (at, who, type, extra) => ({ at, who, type: type || 'message', text: `m${at}`, ...extra });
const fps = (events, recOf) => events.map((e) => Chat.eventFp(e, recOf));

test('tailPlan: pure tail append keeps the whole DOM window', () => {
  const dom = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b')];
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b'), ev(5, 'a')];
  const p = Chat.tailPlan(fps(dom), feed, 100);
  assert.equal(p.slide, 0);
  assert.equal(p.alignLen, 3); // all three drawn events confirmed
  assert.deepEqual(p.target.slice(3).map((e) => e.at), [4, 5]); // rebuild region = the fresh tail
});

test('tailPlan: sliding window evicts exactly what a full render would', () => {
  const dom = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b')];
  const feed = dom.concat([ev(5, 'a'), ev(6, 'a')]);
  const p = Chat.tailPlan(fps(dom), feed, 4);
  assert.equal(p.slide, 2); // two leading events left the window
  assert.equal(p.alignLen, 2); // [3b, 4b] confirmed at their new positions
  assert.deepEqual(p.target.map((e) => e.at), [3, 4, 5, 6]);
});

test('tailPlan: nothing new is a zero-work plan, not a rebuild', () => {
  const dom = [ev(1, 'a'), ev(2, 'b')];
  const p = Chat.tailPlan(fps(dom), dom.slice(), 100);
  assert.ok(p);
  assert.equal(p.slide, 0);
  assert.equal(p.alignLen, 2);
  assert.equal(p.target.length, 2);
});

test('tailPlan: a shrunken window plans as front eviction, not a rebuild', () => {
  const dom = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd')];
  const p = Chat.tailPlan(fps(dom), [ev(3, 'c'), ev(4, 'd')], 2);
  assert.ok(p, 'shrinking to the last events is a whole-front eviction the walk can do');
  assert.deepEqual([p.slide, p.alignLen], [2, 2]);
});

test('tailPlan: drift (DOM ahead of the window) still finds its tail anchor', () => {
  // A whole-group eviction left one extra group at the front: books hold 5 events, win is 4.
  const dom = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd'), ev(5, 'e')];
  const feed = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd'), ev(5, 'e'), ev(6, 'f'), ev(7, 'g')];
  const p = Chat.tailPlan(fps(dom), feed, 4);
  assert.ok(p, 'drift must not force a full render on every later draw');
  assert.deepEqual([p.slide, p.alignFrom, p.alignLen], [3, 0, 2]); // drop [1,2,3], confirm [4,5], append [6,7]
});

test('tailPlan: a tool result attached to an older bubble patches from its group, not a rebuild', () => {
  const dom = [ev(1, 'a', 'tool'), ev(2, 'b'), ev(3, 'c')];
  const feed = [ev(1, 'a', 'tool', { result: 'ok' }), ev(2, 'b'), ev(3, 'c'), ev(4, 'a')]; // m1 mutated
  const p = Chat.tailPlan(fps(dom), feed, 100);
  assert.ok(p, 'the mutation must not force a whole-room rebuild');
  assert.deepEqual([p.slide, p.alignFrom, p.alignLen], [0, 1, 2]); // [2b, 3c] confirmed; m1 re-renders
  // A mutation behind a stable front only rebuilds from the mutated group:
  const dom2 = [ev(1, 'a'), ev(2, 'b', 'tool'), ev(3, 'c')];
  const feed2 = [ev(1, 'a'), ev(2, 'b', 'tool', { result: 'ok' }), ev(3, 'c'), ev(4, 'a')];
  const p2 = Chat.tailPlan(fps(dom2), feed2, 100);
  assert.ok(p2);
  assert.deepEqual([p2.slide, p2.alignFrom, p2.alignLen], [0, 0, 1]); // m1 confirmed, rebuild from m2's group
  assert.deepEqual(p2.target.slice(2).map((e) => e.at), [3, 4]);
});

test('tailPlan: subagent record state rides the fingerprint via recOf', () => {
  const dom = [ev(1, 'a', 'subagent', { subagentId: 's1', total: 3 }), ev(2, 'b')];
  const rec = { id: 's1', status: 'running', tokens: { inputTokens: 10, outputTokens: 5 } };
  const recOf = () => rec;
  const drawTimeFps = fps(dom, recOf); // the renderer stores one fp per event at draw time
  assert.ok(Chat.tailPlan(drawTimeFps, [ev(1, 'a', 'subagent', { subagentId: 's1', total: 3 }), ev(2, 'b'), ev(3, 'a')], 100, recOf));
  rec.status = 'completed'; // record changed under the same event: the DOM must refresh
  const p = Chat.tailPlan(drawTimeFps, [ev(1, 'a', 'subagent', { subagentId: 's1', total: 3 }), ev(2, 'b'), ev(3, 'a')], 100, recOf);
  assert.ok(p);
  assert.deepEqual([p.slide, p.alignFrom, p.alignLen], [0, 1, 1]); // only m2 confirmed; the subagent bubble re-renders
});

test('tailPlan: equal-at arrivals and mid-window inserts patch from the affected group', () => {
  const dom = [ev(2, 'a'), ev(3, 'b')];
  const p = Chat.tailPlan(fps(dom), [ev(2, 'a'), ev(3, 'b'), ev(3, 'c')], 100); // same at as the tail
  assert.ok(p);
  assert.deepEqual(p.target.slice(2).map((e) => e.at), [3]);
  const ins = Chat.tailPlan(fps(dom), [ev(2, 'a'), ev(2, 'a', 'message', { text: 'other' }), ev(3, 'b')], 100);
  assert.ok(ins); // a second event sorts between drawn ones: rebuild from its group
  assert.equal(ins.alignLen, 1);
});

test('tailPlan: a backfilled older event (above the DOM) falls back to a full render', () => {
  const dom = [ev(2, 'a'), ev(3, 'b')];
  assert.equal(Chat.tailPlan(fps(dom), [ev(1, 'c'), ev(2, 'a'), ev(3, 'b')], 100), null);
});

test('tailPlan: end-to-end over roomEvents — a straggler tool result patches one group', () => {
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
  const p = Chat.tailPlan(fps(feed1), feed2, 100);
  assert.ok(p, 'the straggler result must patch its group, not rebuild the room');
  assert.equal(p.alignLen, 1); // only the leading text bubble survives
  // A same-burst tool + result is a plain append: the bubble is new, its result rides along.
  const burst1 = Chat.roomEvents([{ at: 1, nodeId: 'n1', kind: 'text', text: 'go' }], [], [], []);
  const burst2 = Chat.roomEvents([
    { at: 1, nodeId: 'n1', kind: 'text', text: 'go' },
    { at: 2, nodeId: 'n1', kind: 'tool', text: 'Bash ls' },
    { at: 3, nodeId: 'n1', kind: 'tool_result', text: 'file.txt' },
  ], [], [], []);
  const a = Chat.tailPlan(fps(burst1), burst2, 100);
  assert.equal(a.slide, 0);
  assert.equal(a.alignLen, 1);
  assert.deepEqual(a.target.slice(1).map((e) => e.at), [2]);
});

// ---- prependPlan (scroll-up older page) ----

test('prependPlan: prepends the fp-verified older slice', () => {
  const dom = [ev(5, 'a'), ev(6, 'b')];
  const feed = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'a'), ev(5, 'a'), ev(6, 'b')];
  const p = Chat.prependPlan(fps(dom), feed, 6);
  assert.ok(p);
  assert.deepEqual(p.slice.map((e) => e.at), [1, 2, 3, 4]);
  assert.equal(p.target.length, 6);
});

test('prependPlan: null when the DOM is not the exact tail (append raced the grow, mutation)', () => {
  const dom = [ev(5, 'a'), ev(6, 'b')];
  assert.equal(Chat.prependPlan(fps(dom), [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(5, 'a'), ev(6, 'b'), ev(7, 'c')], 6), null);
  const mutated = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(5, 'a', 'tool', { result: 'late' }), ev(6, 'b')];
  assert.equal(Chat.prependPlan(fps(dom), mutated, 5), null);
  assert.equal(Chat.prependPlan(fps(dom), [ev(5, 'a'), ev(6, 'b')], 2), null); // nothing older to add
});

// t_7e53747c: progressive first paint splits the page at a group boundary — the seam must be one
// a one-shot render (mergeGroups) would also keep separate, and both halves must tile the page.
test('splitPage: splits at a group boundary, halves tile the page', () => {
  const items = [];
  for (let i = 0; i < 80; i++) items.push({ at: i * 1000, who: i % 2 ? 'a' : 'b', type: 'message', text: 'm' + i });
  const sp = Chat.splitPage(items);
  assert.ok(sp);
  assert.deepEqual(sp.head.concat(sp.tail), items); // exact tiling, order preserved
  assert.ok(sp.tail.length >= 36, 'tail is at least the newest window');
  // seam not mergeable: head-last and tail-first differ in author or one is a question
  assert.ok(sp.head.length && sp.tail.length);
  const seamA = sp.head[sp.head.length - 1], seamB = sp.tail[0];
  assert.ok(seamA.who !== seamB.who || seamA.type === 'question' || seamB.type === 'question');
});

test('splitPage: the seam respects question boundaries in a same-author run', () => {
  const items = [];
  for (let i = 0; i < 80; i++) items.push({ at: i * 1000, who: 'a', type: 'message', text: 'm' + i });
  items[40].type = 'question'; // question mid-run: the only non-mergeable seam must land there
  const sp = Chat.splitPage(items);
  assert.ok(sp);
  const seamA = sp.head[sp.head.length - 1], seamB = sp.tail[0];
  assert.ok(seamA.who !== seamB.who || seamA.type === 'question' || seamB.type === 'question');
  assert.deepEqual(sp.head.concat(sp.tail), items);
});

test('splitPage: null below the threshold and for un-splittable pages', () => {
  assert.equal(Chat.splitPage([{ at: 1, who: 'a', type: 'message', text: 'x' }]), null);
  const few = []; for (let i = 0; i < 40; i++) few.push({ at: i, who: 'a', type: 'message', text: 'm' + i });
  assert.equal(Chat.splitPage(few), null, 'below minLen');
  const oneRun = []; for (let i = 0; i < 80; i++) oneRun.push({ at: i * 1000, who: 'a', type: 'message', text: 'm' + i });
  assert.equal(Chat.splitPage(oneRun), null, 'one mergeable run has no valid seam');
});
