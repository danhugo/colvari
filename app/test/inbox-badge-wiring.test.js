// Inbox badge wiring + debounce (t_d57ab91e, t_51966c9b): the sidebar badge is always-visible
// chrome — it must track S.inbox on every render, not only while the inbox tab itself is drawn
// (the stale-badge bug the renderChrome extraction fixed). renderInboxBadge is leading+trailing
// debounced like the usage ledger (t_6cbe12ed): a quiet render draws at once, a burst coalesces
// into one trailing draw. Renderer-level per the obs-highlight pattern: extract the real block
// from renderer/app.js and run it against a minimal DOM stub with an injected clock, plus a
// source assertion that renderChrome (the every-render path) still calls it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('const INBOX_BADGE_DEBOUNCE_MS');
const end = src.indexOf('window.__perf', start);
assert.ok(start > 0 && end > start, 'renderInboxBadge debounce block found in renderer/app.js');
const block = src.slice(start, end);

function makeRunner(inject) {
  const clockHolder = { now: 1000 };
  const timers = new Map(); let nextId = 1;
  const setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clockHolder.now + ms }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const FakeDate = { now: () => clockHolder.now };
  let writes = 0, cur = 'stale';
  const el = {};
  Object.defineProperty(el, 'textContent', { get: () => cur, set: (v) => { writes++; cur = v; } });
  const PERF = { inboxBadge: { samples: [], slow: 0, SLOW_MS: 2 } };
  const fn = new Function('$', 'S', 'performance', 'PERF', 'Date', 'setTimeout', 'clearTimeout',
    block + '\nreturn { renderInboxBadge, state: () => ({ badgeLastDraw, badgeTimer }) };');
  const api = fn(
    () => el,
    { inbox: inject && inject.inbox },
    { now: () => 0 },
    PERF,
    FakeDate, setTimeout, clearTimeout
  );
  return {
    api, el, PERF,
    get writes() { return writes; },
    get pendingTimers() { return timers.size; },
    setNow(t) { clockHolder.now = t; },
    advance(ms) { // move the clock, firing due timers in order
      const target = clockHolder.now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clockHolder.now = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      clockHolder.now = target;
    },
  };
}

// One real-clock call: the leading edge draws synchronously (what every quiet render does).
function runBadge(S) {
  const r = makeRunner({ inbox: S && S.inbox });
  r.api.renderInboxBadge();
  return r.el.textContent;
}

test('badge shows the inbox count and clears to :empty when there are no items', () => {
  assert.equal(runBadge({ inbox: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), '3');
  assert.equal(runBadge({ inbox: [] }), '', 'empty badge text so the CSS .badge:empty hides it');
  assert.equal(runBadge({}), '', 'missing inbox state must not render the string "undefined"');
});

test('leading edge draws at once; a burst coalesces into one trailing draw', () => {
  const r = makeRunner({ inbox: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  r.api.renderInboxBadge(); // t=1000, quiet: leading draw
  assert.equal(r.el.textContent, '3', 'quiet render draws immediately');
  assert.equal(r.pendingTimers, 0);
  r.advance(50); r.api.renderInboxBadge(); // t=1050, inside the window
  assert.equal(r.PERF.inboxBadge.samples.length, 1, 'inside the window nothing redraws');
  assert.equal(r.pendingTimers, 1, 'one trailing draw is scheduled');
  r.advance(25); r.api.renderInboxBadge(); // t=1075, still the same window
  assert.equal(r.PERF.inboxBadge.samples.length, 1);
  assert.equal(r.pendingTimers, 1, 'the pending trailing draw is not duplicated');
  r.advance(50); // t=1125 = last draw + 100ms, timer fires
  assert.equal(r.PERF.inboxBadge.samples.length, 2, 'trailing call lands the last state');
  assert.equal(r.el.textContent, '3');
  assert.equal(r.pendingTimers, 0);
  assert.equal(r.api.state().badgeTimer, 0);
  assert.equal(r.api.state().badgeLastDraw, 1100, 'trailing draw stamps its own fire time');
});

test('a leading draw cancels the pending trailing draw', () => {
  const r = makeRunner({ inbox: [] });
  r.api.renderInboxBadge(); // t=1000, leading
  r.advance(50); r.api.renderInboxBadge(); // t=1050, trailing due at 1100
  r.setNow(1150); r.api.renderInboxBadge(); // 150ms after the last draw: leading again
  assert.equal(r.PERF.inboxBadge.samples.length, 2);
  assert.equal(r.pendingTimers, 0, 'the stale trailing timer was cleared');
  r.advance(100);
  assert.equal(r.PERF.inboxBadge.samples.length, 2, 'and it never fires late');
});

test('cache: an unchanged count skips the DOM write, a change writes again', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const r = makeRunner({ inbox: items });
  r.api.renderInboxBadge(); // t=1000, leading: 'stale' -> '3'
  assert.equal(r.el.textContent, '3');
  assert.equal(r.writes, 1);
  r.advance(150); r.api.renderInboxBadge(); // quiet again, same count: cache absorbs the write
  assert.equal(r.PERF.inboxBadge.samples.length, 2, 'the call is still drawn and instrumented');
  assert.equal(r.el.textContent, '3');
  assert.equal(r.writes, 1, 'unchanged count does not touch the DOM');
  r.advance(150); items.push({ id: 'd' }, { id: 'e' }); r.api.renderInboxBadge(); // count changed
  assert.equal(r.el.textContent, '5', 'a count change writes as before');
  assert.equal(r.writes, 2);
});

test('renderChrome — the every-render path — redraws the badge', () => {
  const m = src.match(/function renderChrome\(\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'renderChrome found in renderer/app.js');
  assert.match(m[1], /\brenderInboxBadge\(\)/, 'renderChrome must call renderInboxBadge');
  const renderAll = src.match(/function renderAll\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(renderAll, /\brenderChrome\(\)/, 'renderAll must draw the chrome');
});
