// Log pane timestamp cache (t_2a3c6ec1): every full renderLog rebuild re-formats each visible
// row's clock with toLocaleTimeString — ~6.5 ms per 200-row window (93% of the row-build compute,
// measured at profile sizes). logTime now caches the formatted string keyed on the raw timestamp
// the line carries (the locale options are fixed, so it is a pure function of the input), with a
// size cap that simply resets the map. Renderer-level per the log-pane-defer pattern: extract the
// real logTime/logRow block from renderer/app.js and run it against a counting format spy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const bStart = src.indexOf('const logTimeCache = new Map();');
const bEnd = src.indexOf('// ---------- subagents');
assert.ok(bStart > 0 && bEnd > bStart, 'logTime block found in renderer/app.js');
const block = src.slice(bStart, bEnd);
// The cache must be on the logRow path and the inline per-render format must be gone.
assert.ok(block.includes('const tm = logTime(l.at);'), 'logRow sources its clock from logTime');
assert.ok(!/toLocaleTimeString/.test(src.slice(src.indexOf('function logRow(l)'), src.indexOf('// ---------- subagents'))), 'logRow no longer formats inline');
assert.ok(block.includes('logTimeCache.size >= 20000') && block.includes('logTimeCache.clear()'), 'the cache is capped');

let formats = 0;
const realFmt = Date.prototype.toLocaleTimeString;
Date.prototype.toLocaleTimeString = function (...args) { formats++; return realFmt.apply(this, args); };
test.after(() => { Date.prototype.toLocaleTimeString = realFmt; });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = new Function('esc', 'who', 'LOG_LEVEL', 'monitorText', 'humanLog', 'shortTaskId', 'avatarBg', 'avatarBody',
  `${block}\nreturn { logTime, logTimeCache, logRow };`)(esc,
  () => ({ name: 'Pia', role: 'Dev', color: 'c', bg: 'b', ini: 'P' }), {}, () => 'm', () => null, () => 't1', () => 'bg', () => 'face');

test('logTime formats a timestamp once and serves repeats from the cache', () => {
  formats = 0;
  const at = Date.now();
  const first = api.logTime(at);
  assert.ok(/^\d\d?:\d\d:\d\d/.test(first), 'returns a clock string');
  assert.equal(formats, 1, 'exactly one toLocaleTimeString on the cold path');
  assert.equal(api.logTime(at), first, 'warm path returns the same string');
  assert.equal(formats, 1, 'the repeat did not format again');
  const rows = Array.from({ length: 200 }, (_, i) => api.logRow({ nodeId: 'a1', kind: 'text', at, text: 'line ' + i }));
  assert.equal(rows.filter((r) => r.includes(first)).length, 200, 'every row carries the cached clock');
  assert.equal(formats, 1, 'a 200-row rebuild formats once, not 200 times');
  const other = at + 1000;
  api.logTime(other);
  assert.equal(formats, 2, 'a distinct timestamp still formats on its own cold path');
});

test('logTime keeps the old malformed-input behavior: invalid stamps render empty', () => {
  formats = 0;
  assert.equal(api.logTime(undefined), '', 'undefined stays empty');
  assert.equal(api.logTime('garbage'), '', 'unparseable text stays empty');
  assert.equal(formats, 0, 'invalid input never reaches toLocaleTimeString');
  // new Date(null) is a valid epoch-0 date — the old inline code formatted it, so must the cache.
  assert.equal(api.logTime(null), api.logTime(0), 'null formats like the epoch, same as before');
});

test('the cache is capped: filling it resets instead of growing without bound', () => {
  api.logTimeCache.clear();
  const base = 1.7e12;
  for (let i = 0; i <= 20000; i++) api.logTime(base + i);
  assert.ok(api.logTimeCache.size <= 1, `map resets at the cap (size ${api.logTimeCache.size})`);
  const first = api.logTime(base + 5);
  assert.ok(/^\d\d?:\d\d:\d\d/.test(first), 'a post-reset timestamp formats fresh and correct');
});
