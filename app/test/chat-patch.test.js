// Room patch surgery (t_1fb02462): applyChatAppend / applyChatPrepend / patchChatAvatars are the
// DOM half of the append-don't-rebuild chat path — the group walk, whole-group eviction with front
// drift, group-granular rebuild, the older page prepend with its boundary merge, and the books
// (CH.evFp) that must mirror the DOM exactly after every step. Renderer-level per the
// wake-selector pattern: extract the real functions from renderer/app.js and run them against a
// minimal DOM stub — no Electron, no gui-e2e. The real src/chat.js supplies tailPlan/prependPlan/
// eventFp so plans and books are production code end to end. Fixtures keep the invariant the
// renderer guarantees: groups tile the drawn events, same-author runs, and CH.evFp mirrors them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Chat = require('../src/chat');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('function applyChatAppend');
const end = src.indexOf('function chatPreview');
assert.ok(start > 0 && end > start, 'patch block found in renderer/app.js');
const block = src.slice(start, end);

// ---- minimal DOM stubs ----
const makeAvatarEl = () => { const a = { classes: new Set(), title: '', getAttribute(k) { return this[k]; }, setAttribute(k, v) { this[k] = v; } };
  a.classList = { contains: (c) => a.classes.has(c), toggle: (c, on) => { if (on) a.classes.add(c); else a.classes.delete(c); } }; return a; };
const makeGroup = (who, cnt) => ({
  classes: new Set(['cgroup']), dataset: { cnt: String(cnt), who }, parent: null,
  children: [makeAvatarEl(), { classes: new Set(['cbody']), innerHTML: '' }],
  remove() { const p = this.parent; if (p) p.children = p.children.filter((c) => c !== this); },
  querySelector(sel) { return sel === '.avatar' ? this.children[0] : sel === '.cbody' ? this.children[1] : null; },
});
const matches = (n, sel) => n.classes && n.classes.has(sel.slice(1));

function buildRenderer(env) {
  const room = env.room;
  const stubs = {
    Chat, CH: env.CH, S: env.S,
    $: (sel) => (sel === '#chat-room' ? room : env.els[sel] || null),
    document: { createElement: () => ({ set innerHTML(v) { /* recorded via renderGroups */ }, get content() { return { children: env.__rendered }; } }) },
    requestAnimationFrame: () => {},
    esc: (s) => String(s ?? ''),
    who: (id) => ({ name: id }),
    groupHeadHtml: (g) => `head:${g.who}`,
    bubbleRuns: (items) => `runs:${items.length}`,
    mergeGroups: (gs) => gs,
    needsYou: () => env.ask,
    renderGroups: (events) => { env.__renderCaptured = events; env.__rendered = events.map((e) => { const g = makeGroup(e.who, 1); g.parent = room; return g; }); return ''; },
    bindChatBubbles: (scope) => { env.__bound.push(scope); },
    repinBottom: () => { env.__repins++; },
    updateNewPill: () => { env.__pills++; },
    subRecOf: () => null,
    chatSched: { force() {} },
  };
  return new Function(...Object.keys(stubs), `${block}\nreturn { applyChatAppend, applyChatPrepend, patchChatAvatars, syncThreadPanel };`)(...Object.values(stubs));
}

function makeRoom(groups, withOb) {
  const room = { children: [], scrollTop: 0, scrollHeight: 100, clientHeight: 50,
    appendChild(x) { for (const c of x.children) { c.parent = room; room.children.push(c); } },
    insertBefore(x, anchor) { let i = anchor ? room.children.indexOf(anchor) : 0; for (const c of x.children) { c.parent = room; room.children.splice(i++, 0, c); } },
    querySelectorAll(sel) { return room.children.filter((c) => matches(c, sel)); },
    querySelector(sel) { return room.children.find((c) => matches(c, sel)) || null; },
    get firstChild() { return room.children[0] || null; } };
  for (const g of groups) { g.parent = room; room.children.push(g); }
  const ob = withOb ? { textContent: '', nextSibling: null, classes: new Set(['olderbar']), remove() { room.children = room.children.filter((c) => c !== ob); } } : null;
  return { room, ob };
}

const ev = (at, who, type, extra) => ({ at, who, type: type || 'message', text: `m${at}`, ...extra });
const fps = (events) => events.map((e) => Chat.eventFp(e));

// env: drawn = the events the DOM groups were drawn from (books mirror them exactly).
function envFor(drawn, groups, win, withOb) {
  const { room, ob } = makeRoom(groups, withOb);
  const env = { room, CH: { thread: null, win, domWin: win, evFp: fps(drawn), pendingNew: 1, thKey: null },
    S: { tasks: [], orch: { agents: {} }, allNodes: [] }, ask: new Set(),
    els: { '#chat-older': ob, '#chat-thread': { classes: new Set(), classList: { toggle() {} }, innerHTML: '' }, '#ch-close': { onclick: null }, '#chat-newpill': { classes: new Set(['hidden']), querySelector: () => ({ textContent: '' }) } },
    __rendered: [], __renderCaptured: null, __bound: [], __repins: 0, __pills: 0 };
  return env;
}

test('append: new groups join the room, books mirror the feed exactly', () => {
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b'), ev(5, 'a'), ev(6, 'a'), ev(7, 'b'), ev(8, 'a')];
  const groups = [makeGroup('a', 2), makeGroup('b', 2), makeGroup('a', 2)]; // events 1..6, window far from full
  const env = envFor(feed.slice(0, 6), groups, 100, false);
  const R = buildRenderer(env);
  const plan = Chat.tailPlan(env.CH.evFp, feed, 100);
  assert.ok(plan);
  assert.equal(R.applyChatAppend(feed, plan, new Set()), true);
  assert.deepEqual(env.room.children.map((g) => +g.dataset.cnt), [2, 2, 2, 1, 1]); // kept groups + one per fresh event
  assert.equal(env.CH.evFp.length, 8);
  assert.deepEqual(env.CH.evFp, fps(feed)); // books exactly mirror the feed
  assert.deepEqual(env.__renderCaptured.map((e) => e.at), [7, 8]); // only the fresh tail was re-rendered
  assert.ok(env.__bound.length >= 1, 'fresh bubbles were re-bound');
});

test('append: whole-group eviction + fresh tail keep the books exact (window full)', () => {
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b'), ev(5, 'a'), ev(6, 'a'), ev(7, 'b'), ev(8, 'a')];
  const groups = [makeGroup('a', 2), makeGroup('b', 2), makeGroup('a', 2)]; // drawn from events 1..6, win 6
  const env = envFor(feed.slice(0, 6), groups, 6, true);
  const R = buildRenderer(env);
  const plan = Chat.tailPlan(env.CH.evFp, feed, 6); // target = events 3..8: slide 2
  assert.deepEqual([plan.slide, plan.alignFrom, plan.alignLen], [2, 0, 4]);
  assert.equal(R.applyChatAppend(feed, plan, new Set()), true);
  assert.deepEqual(env.room.children.map((g) => g.dataset.who), ['b', 'a', 'b', 'a']);
  assert.deepEqual(env.CH.evFp, fps(feed.slice(2)));
  assert.deepEqual(env.__renderCaptured.map((e) => e.at), [7, 8]);
});

test('append: a mutated older bubble rebuilds only its own group', () => {
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b'), ev(5, 'a', 'tool', { result: 'late' }), ev(6, 'a')];
  const groups = [makeGroup('a', 2), makeGroup('b', 2), makeGroup('a', 2)];
  const env = envFor(feed.map((e, i) => (i === 4 ? ev(5, 'a', 'tool') : e)), groups, 100, false);
  const R = buildRenderer(env);
  const plan = Chat.tailPlan(env.CH.evFp, feed, 100);
  assert.ok(plan, 'the late result must patch, not force a full render');
  assert.equal(R.applyChatAppend(feed, plan, new Set()), true);
  assert.deepEqual(env.room.children.map((g) => +g.dataset.cnt), [2, 2, 1, 1]); // g3 rebuilt as per-event groups
  assert.deepEqual(env.CH.evFp, fps(feed));
  assert.deepEqual(env.__renderCaptured.map((e) => e.at), [5, 6]);
});

test('append: no-op plan (nothing changed) is a zero-mutation draw', () => {
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b')];
  const groups = [makeGroup('a', 2), makeGroup('b', 1)];
  const env = envFor(feed, groups, 100, false);
  const R = buildRenderer(env);
  const plan = Chat.tailPlan(env.CH.evFp, feed, 100);
  assert.equal(R.applyChatAppend(feed, plan, new Set()), true);
  assert.equal(env.__renderCaptured, null, 'nothing re-rendered');
  assert.deepEqual(env.CH.evFp, fps(feed));
});

test('append: refuses when the older bar does not match the window boundary', () => {
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b'), ev(4, 'b')];
  const groups = [makeGroup('a', 4)];
  const env = envFor(feed, groups, 2, false); // ev.length 4 > win 2 but no older bar
  const R = buildRenderer(env);
  const plan = Chat.tailPlan(env.CH.evFp, feed, 2);
  assert.equal(R.applyChatAppend(feed, plan, new Set()), false);
  assert.deepEqual(env.CH.evFp, fps(feed), 'books untouched on refusal');
});

test('avatars: working/needs-you rings patch in place from the books', () => {
  const feed = [ev(1, 'a'), ev(2, 'a'), ev(3, 'b')];
  const groups = [makeGroup('a', 2), makeGroup('b', 1)];
  const env = envFor(feed, groups, 100, false);
  const R = buildRenderer(env);
  R.patchChatAvatars(env.room, new Set(['b']));
  const [ga, gb] = env.room.children;
  assert.equal(ga.children[0].classes.has('working'), false);
  assert.equal(gb.children[0].classes.has('working'), true, 'b is working');
  assert.equal(gb.children[0].title, 'b · working');
  R.patchChatAvatars(env.room, new Set()); // b stopped working
  assert.equal(gb.children[0].classes.has('working'), false);
  assert.equal(gb.children[0].title, 'b');
});

test('prepend: the older page slides in under the older bar, books grow to the window', () => {
  const feed = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd'), ev(5, 'a'), ev(6, 'b'), ev(7, 'c'), ev(8, 'd'), ev(9, 'a'), ev(10, 'b')];
  const groups = [makeGroup('a', 1), makeGroup('b', 1), makeGroup('c', 1), makeGroup('d', 1), makeGroup('a', 1), makeGroup('b', 1)]; // events 5..10, win 6
  const env = envFor(feed.slice(4), groups, 6, true);
  const R = buildRenderer(env);
  env.CH.win = 10; // chatGrow grew the window
  const ob = env.els['#chat-older'];
  ob.nextSibling = env.room.children[0];
  assert.equal(R.applyChatPrepend(feed, new Set(), 0, 100), true);
  assert.deepEqual(env.room.children.map((g) => g.dataset.who), ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'a', 'b']);
  assert.equal(env.CH.evFp.length, 10);
  assert.deepEqual(env.CH.evFp, fps(feed));
  assert.equal(env.CH.domWin, 10);
  assert.equal(env.__renderCaptured.length, 4, 'only the older slice rendered');
});

test('prepend: a same-author boundary merges into the room\'s first group', () => {
  // Slice ends 2s before the room's first event, same author: Chat.group would make them one group.
  const t0 = 10_000;
  const feed = [ev(t0 - 6000, 'a'), ev(t0 - 4000, 'a'), ev(t0 - 2000, 'a'), ev(t0, 'a'), ev(t0 + 1000, 'b'), ev(t0 + 2000, 'a')];
  const groups = [makeGroup('a', 2), makeGroup('b', 1), makeGroup('a', 1)]; // drawn from events 3..6 (win 4)
  const env = envFor(feed.slice(2), groups, 4, false);
  const R = buildRenderer(env);
  env.CH.win = 6;
  assert.equal(R.applyChatPrepend(feed, new Set(), 0, 100), true);
  const first = env.room.children[0];
  assert.equal(+first.dataset.cnt, 4, 'the boundary group absorbed the merged events');
  assert.match(first.children[1].innerHTML, /runs:4/);
  assert.deepEqual(env.room.children.slice(1).map((g) => +g.dataset.cnt), [1, 1]);
  assert.deepEqual(env.CH.evFp, fps(feed));
  assert.equal(env.__renderCaptured, null, 'nothing else rendered: the slice fully merged');
});
