// Log pane defer (t_54b2b829): while the user is scrolled away from the tail (reading history), a
// streaming burst used to fall through appendLogTail's pin check into a full renderLog rebuild of
// the whole window on every coalesced flush (~56ms each at profile sizes) only to anchor-scroll
// back to the same rows. flushLogTail now defers that rebuild (logTailDirty) until the tail comes
// back into view — the scroll handler rebuilds once there, and any explicit renderLog clears the
// flag via its stamp. Renderer-level per the chat-tail/log-pane-malformed pattern: extract the
// real windowing + flush/append blocks from renderer/app.js and run them against a DOM stub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const aStart = src.indexOf('const LOG_PAGE = 200;');
const aEnd = src.indexOf('function renderLog() {');
const bStart = src.indexOf('let logFlushQueued = false');
const bEnd = src.indexOf("// Direct 'log' pushes now carry");
assert.ok(aStart > 0 && aEnd > aStart, 'windowing block found in renderer/app.js');
assert.ok(bStart > 0 && bEnd > bStart, 'flush/append block found in renderer/app.js');
const block = src.slice(aStart, aEnd) + '\n' + src.slice(bStart, bEnd);
// The defer must be wired to both exits: the flush defers it and the scroll handler rebuilds it.
assert.ok(block.includes('logTailDirty = true'), 'flushLogTail sets the defer flag');
assert.ok(block.includes('else if (logTailDirty &&'), 'scroll handler rebuilds a deferred pane');
assert.ok(/logSig = lkey; logTailDirty = false;/.test(src), 'a full renderLog stamp clears the flag');

const el = (props) => Object.assign({
  innerHTML: '', value: '', scrollTop: 0, clientHeight: 1000, scrollHeight: 1000, checked: true,
  classList: { contains: () => true }, addEventListener: () => {},
  querySelector: () => null, insertAdjacentHTML(pos, html) { this.innerHTML += html; },
}, props);
const els = {
  '#tab-obs': el({}),
  '#log': el({}),
  '#logfilter': el({ value: '' }),
  '#logsearch': el({ value: '' }),
  '#logauto': el({ checked: true }),
};

const factory = (logs) => {
  let scrollFn = null;
  els['#log'] = el({}); // fresh box per instance
  els['#log'].addEventListener = (t, fn) => { scrollFn = fn; };
  const ctx = { p: 'p1' }, sel = { logTeam: '' };
  const renderLog = () => { renderLog.calls++; }; // test stub: the real one stamps logTailDirty=false
  renderLog.calls = 0; renderLog.total = 0; renderLog.winItems = 0;
  const renderLive = () => { renderLive.calls++; };
  renderLive.calls = 0;
  const names = ['$','document','requestAnimationFrame','logs','ctx','sel','logsLoaded','logTeamNodes','logLevels','logRow','renderLog','renderLive'];
  const args = [
    (x) => els[x],
    { hidden: false },
    (f) => f(),
    logs, ctx, sel, new Set(['p1']), () => [],
    new Set(['info', 'warn', 'error']),
    (l) => `<div class="logrow" data-at="${l.at}"></div>`,
    renderLog, renderLive,
  ];
  const api = new Function(...names, `${block}\nreturn { flushLogTail, appendLogTail, isDirty: () => logTailDirty, markRendered: () => { logTailDirty = false; } };`)(...args);
  api.renderLog = renderLog; api.renderLive = renderLive; api.box = els['#log']; api.scroll = () => scrollFn;
  return api;
};

const seeded = () => Array.from({ length: 10 }, (_, i) => ({ projectId: 'p1', nodeId: 'a1', at: i + 1, kind: 'text', text: 'line ' + (i + 1), _seq: i + 1 }));

test('flushLogTail defers the full rebuild while the user is scrolled away from the tail', () => {
  const logs = seeded(); const api = factory(logs);
  // First flush at the pinned tail: the fast append draws the 10 rows (winItems 190 + 10 = window).
  api.renderLog.winItems = 190;
  api.flushLogTail();
  assert.equal(api.renderLog.calls, 0, 'pinned burst rides the fast append, no full render');
  assert.ok(api.box.innerHTML.includes('data-at="10"'), 'fresh rows appended');
  // Burst continues while the user scrolled up to read history: no rebuild, just the defer flag.
  api.box.scrollHeight = 5000; api.box.scrollTop = 0; api.box.innerHTML += '<div class="logrow" data-at="0"></div>';
  logs.push({ projectId: 'p1', nodeId: 'a1', at: 11, kind: 'text', text: 'line 11', _seq: 11 });
  api.flushLogTail();
  assert.equal(api.renderLog.calls, 0, 'scrolled-away flush must not rebuild the whole window');
  assert.ok(api.isDirty(), 'rebuild deferred via logTailDirty');
  assert.ok(api.box.innerHTML.includes('data-at="0"'), 'DOM left exactly as the user is reading it');
  assert.equal(api.renderLive.calls, 2, 'renderLive still follows the stream on every flush');
});

test('scrolling back to the tail rebuilds a deferred pane exactly once', () => {
  const logs = seeded(); const api = factory(logs);
  api.renderLog.winItems = 190;
  api.flushLogTail(); // stamp the tail cursor at the pinned view
  api.box.scrollHeight = 5000; api.box.scrollTop = 0;
  logs.push({ projectId: 'p1', nodeId: 'a1', at: 11, kind: 'text', text: 'line 11', _seq: 11 });
  api.flushLogTail();
  assert.ok(api.isDirty());
  const scroll = api.scroll();
  assert.ok(scroll, 'scroll handler captured');
  api.box.scrollTop = 4000; // back within 20px of the (frozen) bottom
  scroll();
  assert.equal(api.renderLog.calls, 1, 'returning to the tail rebuilds once');
  api.markRendered(); // the real renderLog clears the flag in its stamp
  scroll();
  assert.equal(api.renderLog.calls, 1, 'later scroll ticks stay free');
});

test('a pinned flush is never deferred even when the fast append bails', () => {
  const logs = seeded(); const api = factory(logs);
  api.renderLog.winItems = 5; // 5 + 10 > logWin 200? no — but the search filter forces a full render
  els['#logsearch'].value = 'line 1';
  api.flushLogTail();
  assert.equal(api.renderLog.calls, 1, 'visible filtered view keeps rebuilding immediately');
  assert.ok(!api.isDirty(), 'nothing deferred while the user sits at the tail');
});

test('an unrendered pane (winItems 0) is never deferred', () => {
  const logs = seeded(); const api = factory(logs);
  api.box.scrollHeight = 5000; api.box.scrollTop = 0; // scrolled away, pane never drew
  api.flushLogTail();
  assert.equal(api.renderLog.calls, 1, 'first draw must go through renderLog, not the defer');
  assert.ok(!api.isDirty());
});
