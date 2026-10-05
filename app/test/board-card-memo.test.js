// Card-html memo (t_d6c2be24): a store write anywhere on the board (any comment, any run push)
// bumps the board version and re-enters patchBoardColumns — the old path re-ran cardHtml for ALL
// cards (~500 strings on the grown board) just to diff them. The memo must reuse a card's html
// whenever nothing it reads moved, and rebuild it exactly when something did: the task's own
// updatedAt, the global envKey, the rendered age label, or this card's selection.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const block = js.slice(js.indexOf('const cardHtmlCache'), js.indexOf('function patchBoardColumns'));
assert.ok(block.includes('cardHtmlCached'), 'memo block must be extractable');

const load = (cardHtml, sel, ago = (ts) => String(ts).slice(0, 13)) => {
  const calls = [];
  const spy = (t) => { calls.push(t.id); return cardHtml(t); };
  const { cardHtmlCached } = new Function('cardHtml', 'ago', 'sel', `${block}\nreturn { cardHtmlCached };`)(spy, ago, sel);
  return { cardHtmlCached, calls };
};

const task = (over = {}) => ({ id: 't1', updatedAt: '2026-10-03T10:00:00Z', ...over });

test('unchanged inputs reuse the cached html: cardHtml runs once per card, not once per render', () => {
  const sel = { task: null };
  const { cardHtmlCached, calls } = load((t) => `<card>${t.id}@${t.updatedAt}</card>`, sel);
  const t = task();
  const first = cardHtmlCached(t, 'envA');
  for (let i = 0; i < 50; i++) assert.equal(cardHtmlCached(t, 'envA'), first); // a render storm over one unchanged card
  assert.deepEqual(calls, ['t1'], 'the html string must be built once, then served from the memo');
});

test('a task write (updatedAt moved) rebuilds that card — and only that card', () => {
  const sel = { task: null };
  const { cardHtmlCached, calls } = load((t) => `<card>${t.id}@${t.updatedAt}</card>`, sel);
  const a = task({ id: 'ta', updatedAt: '2026-10-03T10:00:00Z' });
  const b = task({ id: 'tb', updatedAt: '2026-10-03T10:00:00Z' });
  cardHtmlCached(a, 'env'); cardHtmlCached(b, 'env');
  const b2 = cardHtmlCached(b, 'env'); // tb untouched while ta moved under it
  const a2 = cardHtmlCached(task({ id: 'ta', updatedAt: '2026-10-03T11:00:00Z' }), 'env');
  assert.deepEqual(calls, ['ta', 'tb', 'ta'], 'only the updated task is rebuilt');
  assert.equal(b2, '<card>tb@2026-10-03T10:00:00Z</card>');
  assert.match(a2, /11:00/);
});

test('an env move (agent state, statuses, running set) rebuilds every card', () => {
  const sel = { task: null };
  const { cardHtmlCached, calls } = load((t) => `<card>${t.id}</card>`, sel);
  const t = task();
  cardHtmlCached(t, 'envA');
  cardHtmlCached(t, 'envA|busy'); // e.g. its assignee started a run
  assert.deepEqual(calls, ['t1', 't1']);
});

test('selection rides the key: only cards whose selection bit moved rebuild', () => {
  const sel = { task: null };
  const { cardHtmlCached, calls } = load((t) => `<card ${sel.task === t.id ? 'sel' : ''}>${t.id}</card>`, sel);
  const a = task({ id: 'ta' }); const b = task({ id: 'tb' });
  cardHtmlCached(a, 'env'); cardHtmlCached(b, 'env');
  sel.task = 'ta'; // select a: its class flips, b keeps its cached string
  cardHtmlCached(a, 'env'); cardHtmlCached(b, 'env');
  sel.task = null; // deselect: same two cards, still no full rebuild
  cardHtmlCached(a, 'env'); cardHtmlCached(b, 'env');
  sel.task = 'tb'; // move the selection a -> b: b's class flips; a is back to its cached unselected html
  cardHtmlCached(a, 'env'); cardHtmlCached(b, 'env');
  assert.deepEqual(calls, ['ta', 'tb', 'ta', 'ta', 'tb']);
});

test('the age label rides the key: the minute tick only rebuilds cards whose label actually moved', () => {
  // Real shape: boardSig carries a minute bucket, so renderBoard re-runs each minute even when
  // nothing changed; ago() labels only flip when a card crosses a boundary (59m -> 1h).
  const sel = { task: null };
  let hour = 10;
  const ago = (ts) => (ts.startsWith('2026-10-01') ? '2d' : `${hour - 10}h`); // day-grain for the old card, hour-grain for the fresh one
  const { cardHtmlCached, calls } = load((t) => `<card>${t.id}</card>`, sel, ago);
  const fresh = task({ id: 'tf', updatedAt: '2026-10-03T10:00:00Z' });
  const old = task({ id: 'to', updatedAt: '2026-10-01T10:00:00Z' });
  cardHtmlCached(fresh, 'env'); cardHtmlCached(old, 'env');
  hour = 11; // a minute boundary passed: boardSig moved, but only fresh's label changed
  cardHtmlCached(fresh, 'env'); cardHtmlCached(old, 'env');
  assert.deepEqual(calls, ['tf', 'to', 'tf'], 'the old card whose label did not move stays cached');
});
