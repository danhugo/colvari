// Wiki editor remote delete (seed 475): another agent can delete the selected page through the
// board tools while a human has it open. renderWiki used to keep the stale sel.page alive, so the
// editor pane showed a ghost of the deleted page and Save would silently recreate it. The fix
// drops the selection in view mode (no draft to lose); an active edit keeps its draft, same
// philosophy as the dirty guard. Renderer-level per the wiki-editor-debounce pattern: run the
// real renderWiki against a minimal DOM stub, plus a source assertion that the guard stays wired.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('let wkSig = null;');
const end = src.indexOf('// Dirty-editor guard', start);
assert.ok(start > 0 && end > start, 'renderWiki block found in renderer/app.js');
const block = src.slice(start, end);

test('renderWiki drops a selection whose page was deleted elsewhere (view mode)', () => {
  const S = { wiki: { Runbook: { author: 'a', updatedAt: 1, content: '# r' } } };
  const sel = { page: 'Runbook' };
  const toggles = [];
  const els = {
    '#wk-search': { value: '' },
    '#wk-empty': { classList: { toggle: (c, on) => toggles.push(['empty', on]) } },
    '#wk-editor': { classList: { toggle: (c, on) => toggles.push(['editor', on]) } },
    '#wk-empty h3': { textContent: '' },
    '#wikipages': { set innerHTML(v) {} },
  };
  const fn = new Function('$', 'document', 'S', 'ctx', 'sel', 'wikiEdit', 'esc', 'agoTxt', 'loadPage',
    block + '\nreturn { render: () => renderWiki() };');
  const api = fn((id) => els[id], { querySelectorAll: () => [] }, S, { p: 'p1' }, sel, false,
    String, () => '', () => {});
  api.render();
  assert.equal(sel.page, 'Runbook', 'sanity: page selected');
  delete S.wiki.Runbook; // another agent deleted the page through the board tools
  api.render();
  assert.equal(sel.page, null, 'stale selection must be dropped, not left as a ghost editor');
  const lastEmpty = [...toggles].reverse().find(([el]) => el === 'empty')[1];
  const lastEditor = [...toggles].reverse().find(([el]) => el === 'editor')[1];
  assert.equal(lastEmpty, false, 'empty state becomes visible');
  assert.equal(lastEditor, true, 'editor pane is hidden');
});

test('an active edit survives a remote delete so the draft is not wiped', () => {
  const S = { wiki: { Runbook: { author: 'a', updatedAt: 1, content: '# r' } } };
  const sel = { page: 'Runbook' };
  const els = {
    '#wk-search': { value: '' },
    '#wk-empty': { classList: { toggle() {} } },
    '#wk-editor': { classList: { toggle() {} } },
    '#wk-empty h3': { textContent: '' },
    '#wikipages': { set innerHTML(v) {} },
  };
  const fn = new Function('$', 'document', 'S', 'ctx', 'sel', 'wikiEdit', 'esc', 'agoTxt', 'loadPage',
    block + '\nreturn { render: () => renderWiki() };');
  const api = fn((id) => els[id], { querySelectorAll: () => [] }, S, { p: 'p1' }, sel, true,
    String, () => '', () => {});
  api.render();
  delete S.wiki.Runbook;
  api.render();
  assert.equal(sel.page, 'Runbook', 'editing session keeps the draft (dirty-guard philosophy)');
});

test('source: the remote-delete guard sits inside renderWiki before the signature key', () => {
  const m = block.match(/if \(sel\.page && !S\.wiki\[sel\.page\] && !wikiEdit\) sel\.page = null;/);
  assert.ok(m, 'remote-delete selection guard found in renderWiki');
  assert.ok(block.indexOf(m[0]) < block.indexOf('const pages ='), 'guard runs before the sig key is built');
});
