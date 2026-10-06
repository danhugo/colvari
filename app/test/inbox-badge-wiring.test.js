// Inbox badge wiring (t_d57ab91e): the sidebar badge is always-visible chrome — it must track
// S.inbox on every render, not only while the inbox tab itself is drawn (the stale-badge bug the
// renderChrome extraction fixed). Renderer-level per the obs-highlight pattern: extract the real
// renderInboxBadge from renderer/app.js and run it against a minimal DOM stub, plus a source
// assertion that renderChrome (the every-render path) still calls it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('function renderInboxBadge');
const end = src.indexOf('window.__perf', start);
assert.ok(start > 0 && end > start, 'renderInboxBadge block found in renderer/app.js');
const block = src.slice(start, end);

function runBadge(S) {
  const el = { textContent: 'stale' };
  const fn = new Function('$', 'S', 'performance', 'PERF', block + '\nrenderInboxBadge();');
  fn(() => el, S, { now: () => 0 }, { inboxBadge: { samples: [], slow: 0, SLOW_MS: 2 } });
  return el.textContent;
}

test('badge shows the inbox count and clears to :empty when there are no items', () => {
  assert.equal(runBadge({ inbox: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), '3');
  assert.equal(runBadge({ inbox: [] }), '', 'empty badge text so the CSS .badge:empty hides it');
  assert.equal(runBadge({}), '', 'missing inbox state must not render the string "undefined"');
});

test('renderChrome — the every-render path — redraws the badge', () => {
  const m = src.match(/function renderChrome\(\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'renderChrome found in renderer/app.js');
  assert.match(m[1], /\brenderInboxBadge\(\)/, 'renderChrome must call renderInboxBadge');
  const renderAll = src.match(/function renderAll\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(renderAll, /\brenderChrome\(\)/, 'renderAll must draw the chrome');
});
