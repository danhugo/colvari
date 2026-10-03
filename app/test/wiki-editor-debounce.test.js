// Wiki editor debounce (t_37903ca1): the wiki tab's only keystroke-driven render is the page-list
// search (#wk-search), which must fire renderWiki once per typing pause (150ms trailing) — the
// same discipline as #logsearch. Renderer-level per the inbox-badge pattern: run the real
// renderWiki against a minimal DOM stub to lock the signature guard the debounce leans on
// (an unchanged-state render rebuilds nothing, a real edit always rebuilds), plus a source
// assertion that the oninput is still the debounced one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('let wkSig = null;');
const end = src.indexOf('// Dirty-editor guard', start);
assert.ok(start > 0 && end > start, 'renderWiki block found in renderer/app.js');
const block = src.slice(start, end);

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
  const fn = new Function('$', 'document', 'S', 'ctx', 'sel', 'wikiEdit', 'esc', 'agoTxt', 'loadPage', 'pages',
    block + '\nreturn { render: () => renderWiki() };');
  const api = fn((id) => els[id], { querySelectorAll: () => [] }, S, { p: 'p1' }, { page: null }, false,
    String, () => '', () => {}, pages);
  return { pages, els, render: api.render };
}

test('#wk-search oninput is debounced to one renderWiki per typing pause', () => {
  const m = src.match(/^\$\('#wk-search'\)\.oninput = .*$/m);
  assert.ok(m, '#wk-search oninput wiring found');
  assert.match(m[0], /clearTimeout\(wkSearchTimer\)/, 'cancels the pending render');
  assert.match(m[0], /setTimeout\(renderWiki, 150\)/, 'trailing-edge render after a 150ms pause');
});

test('renderWiki rebuilds the list once and identical state is a no-op', () => {
  const S = { wiki: { Runbook: { author: 'a', updatedAt: 1, content: '# r' } } };
  const w = makeWikiRunner(S);
  w.render(); w.render(); w.render();
  assert.equal(w.pages.rebuilds, 1, 'unchanged state between keystrokes must not rebuild the page list');
  assert.ok(w.pages.html.includes('Runbook'));
});

test('a real edit (updatedAt bump) still gets through the guard', () => {
  const S = { wiki: { Runbook: { author: 'a', updatedAt: 1, content: '# r' } } };
  const w = makeWikiRunner(S);
  w.render();
  S.wiki.Runbook.updatedAt = 2; // another agent rewrote the page mid-session
  w.render();
  assert.equal(w.pages.rebuilds, 2, 'the sig includes updatedAt, so an external rewrite re-renders');
});

test('typing a search query changes the render input, not just the timer', () => {
  const S = { wiki: { Runbook: { author: 'a', updatedAt: 1, content: '# r' }, Glossary: { author: 'b', updatedAt: 2, content: '# g' } } };
  const w = makeWikiRunner(S);
  w.render();
  const w2 = makeWikiRunner(S, 'glos'); // what the debounced oninput delivers after the pause
  w2.render();
  assert.ok(w2.pages.html.includes('Glossary') && !w2.pages.html.includes('Runbook'), 'query filters the list');
});
