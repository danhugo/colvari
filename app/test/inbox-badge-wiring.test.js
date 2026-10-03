// Inbox badge wiring (t_d57ab91e) + debounce (t_94f9b9f0): the sidebar badge is always-visible
// chrome — it must track S.inbox on every render, not only while the inbox tab itself is drawn
// (the stale-badge bug the renderChrome extraction fixed). Renderer-level per the obs-highlight
// pattern: extract the real renderInboxBadge (+ its ibBadgeWrite helper) from renderer/app.js and
// run it against a minimal DOM stub, plus a source assertion that renderChrome (the every-render
// path) still calls it. The debounce keeps the leading write synchronous (the badge never lags
// its render) and collapses further changed renders inside the window into one trailing write —
// exercised here with fake timers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('const PERF');
const end = src.indexOf('window.__perf', start);
assert.ok(start > 0 && end > start, 'renderInboxBadge block found in renderer/app.js');
const block = src.slice(start, end);

function makeRunner(S) {
  const el = { textContent: '' };
  const timers = new Map();
  let seq = 0;
  const fn = new Function('$', 'S', 'performance', 'setTimeout', 'clearTimeout',
    block + '\nreturn { render: () => renderInboxBadge() };');
  const api = fn(() => el, S, { now: () => 0 },
    (f) => { timers.set(++seq, f); return seq; },
    (id) => timers.delete(id));
  return {
    el,
    render: api.render,
    pending: () => timers.size,
    flush: () => { const fs2 = [...timers.values()]; timers.clear(); for (const f of fs2) f(); },
  };
}

const items = (n) => Array.from({ length: n }, (_, i) => ({ id: 'i' + i }));

test('badge shows the inbox count and clears to :empty when there are no items', () => {
  const a = makeRunner({ inbox: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  a.render();
  assert.equal(a.el.textContent, '3', 'leading write lands synchronously');
  const b = makeRunner({ inbox: [] });
  b.render();
  assert.equal(b.el.textContent, '', 'empty badge text so the CSS .badge:empty hides it');
  const c = makeRunner({});
  c.render();
  assert.equal(c.el.textContent, '', 'missing inbox state must not render the string "undefined"');
});

test('renderChrome — the every-render path — redraws the badge', () => {
  const m = src.match(/function renderChrome\(\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'renderChrome found in renderer/app.js');
  assert.match(m[1], /\brenderInboxBadge\(\)/, 'renderChrome must call renderInboxBadge');
  const renderAll = src.match(/function renderAll\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(renderAll, /\brenderChrome\(\)/, 'renderAll must draw the chrome');
});

test('a changed render inside the burst window coalesces into one trailing write', () => {
  const s = { inbox: items(3) };
  const r = makeRunner(s);
  r.render(); // leading edge of the burst
  assert.equal(r.el.textContent, '3');
  assert.equal(r.pending(), 1, 'the leading write arms exactly one window timer');
  s.inbox = items(5);
  r.render(); // changed, but inside the window: must not write yet
  assert.equal(r.el.textContent, '3', 'the coalesced write is deferred');
  assert.ok(r.pending() >= 1, 'a trailing timer is pending');
  r.flush();
  assert.equal(r.el.textContent, '5', 'the trailing write lands the last value');
});

test('a count that flips back mid-burst still ends on the true value', () => {
  const s = { inbox: items(3) };
  const r = makeRunner(s);
  r.render(); // writes 3
  s.inbox = items(5); r.render(); // schedules the trailing write for 5
  s.inbox = items(3); r.render(); // same as shown: no-op — but the pending write re-reads S
  r.flush();
  assert.equal(r.el.textContent, '3', 'the trailing write re-reads S.inbox at fire time');
});

test('unchanged re-renders arm no timer and cost no DOM write', () => {
  const s = { inbox: items(3) };
  const r = makeRunner(s);
  r.render();
  r.flush();
  r.render(); // unchanged: early return
  assert.equal(r.pending(), 0, 'no window timer armed for an unchanged render');
  assert.equal(r.el.textContent, '3');
});
