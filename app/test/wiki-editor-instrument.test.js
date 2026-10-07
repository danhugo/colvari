// Wiki editor instrumentation (t_e5036ad3): state polls reach renderWiki on every tick, so the
// perf board reads wkStats — calls vs sig-guard absorbs vs real rebuilds, rebuild/preview timings,
// and a >= 50 ms slow-rebuild warning. Renderer-level per the debounce test: run the real blocks
// against a minimal DOM stub and lock the counters (absorbed renders stay silent, real edits count,
// slow rebuilds warn with the absorb count) so later refactors can't strand the instrumentation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('let wkSig = null;');
const end = src.indexOf('// Dirty-editor guard', start);
assert.ok(start > 0 && end > start, 'renderWiki block found in renderer/app.js');
const block = src.slice(start, end);
const shStart = src.indexOf('function showWiki()');
const shEnd = src.indexOf("$('#wk-edit').onclick", shStart);
assert.ok(shStart > 0 && shEnd > shStart, 'showWiki block found in renderer/app.js');
const showBlock = src.slice(shStart, shEnd);

function makeWikiRunner(S, q = '') {
  const els = {
    '#wk-search': { value: q },
    '#wk-empty': { classList: { toggle() {} } },
    '#wk-editor': { classList: { toggle() {} } },
    '#wk-empty h3': { textContent: '' },
  };
  const pages = { rebuilds: 0, html: '' };
  const pagesEl = {
    get innerHTML() { return pages.html; },
    set innerHTML(v) { pages.rebuilds++; pages.html = v; },
  };
  els['#wikipages'] = pagesEl;
  const fn = new Function('$', 'document', 'S', 'ctx', 'sel', 'wikiEdit', 'esc', 'agoTxt', 'loadPage', 'console',
    block + '\nreturn { render: () => renderWiki(), stats: wkStats };');
  const warns = [];
  const api = fn((id) => els[id], { querySelectorAll: () => [] }, S, { p: 'p1' }, { page: null }, false,
    String, () => '', () => {}, { warn: (m) => warns.push(m) });
  return { pages, els, render: api.render, stats: api.stats, warns };
}

test('wkStats counts calls, sig absorbs and real rebuilds separately', () => {
  const S = { wiki: { Runbook: { author: 'a', updatedAt: 1, content: '# r' } } };
  const w = makeWikiRunner(S);
  w.render(); w.render(); w.render();
  assert.deepEqual([w.stats.calls, w.stats.sigSkips, w.stats.renders], [3, 2, 1]);
  assert.ok(w.stats.lastMs >= 0 && w.stats.maxMs >= w.stats.lastMs, 'timings recorded');
  S.wiki.Runbook.updatedAt = 2; // another agent rewrote the page mid-session
  w.render();
  assert.equal(w.stats.renders, 2, 'a real edit flips a would-be skip into a rebuild');
  assert.equal(w.stats.sigSkips, 2);
});

test('a slow rebuild (>= 50 ms) warns with the absorb count; fast ones stay quiet', () => {
  const S = { wiki: { Runbook: { author: 'a', updatedAt: 1, content: '# r' } } };
  const w = makeWikiRunner(S);
  w.render(); w.render(); // second poll is absorbed by the sig guard
  assert.deepEqual(w.warns, [], 'fast rebuild does not warn');
  const orig = global.performance;
  let fake = 0;
  global.performance = { now: () => (fake += 60) };
  try {
    S.wiki.Runbook.updatedAt = 2;
    w.render();
  } finally { global.performance = orig; }
  assert.equal(w.stats.renders, 2);
  assert.ok(w.warns.length === 1, 'slow rebuild warns exactly once');
  assert.match(w.warns[0], /rebuilt in 60 ms over 1 page\(s\)/);
  assert.match(w.warns[0], /1 sig-skip\(s\) absorbed/);
});

function makeShowRunner(wikiEdit, content = '# hello') {
  const els = {
    '#wk-title': { value: 'Runbook' },
    '#wk-content': { value: content, classList: { toggle() {} } },
    '#wk-view': { innerHTML: '', classList: { toggle() {} }, querySelectorAll: () => [] },
  };
  const fn = new Function('$', 'wikiEdit', 'md', 'wikiBacklinks', 'esc', 'showTab', 'renderBoard', 'wkStats',
    showBlock + '\nreturn { show: () => showWiki(), stats: wkStats };');
  const api = fn((id) => els[id], wikiEdit, () => '<p>md</p>', () => [], String, () => {}, () => {},
    { calls: 0, sigSkips: 0, renders: 0, shows: 0, lastMs: 0, maxMs: 0 });
  return { els, show: api.show, stats: api.stats };
}

test('showWiki counts preview draws into the same wkStats', () => {
  const w = makeShowRunner(false);
  w.show(); w.show();
  assert.equal(w.stats.shows, 2, 'each preview/backlink draw is counted');
  assert.ok(w.stats.maxMs >= 0);
});
