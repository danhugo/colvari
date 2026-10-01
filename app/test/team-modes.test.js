const test = require('node:test');
const assert = require('node:assert');
const TM = require('../src/team-modes');

test('team modes: Watch is the default whenever any agent is running', () => {
  assert.equal(TM.resolveMode(null, true), 'watch');
  assert.equal(TM.resolveMode(null, false), 'edit');
  assert.equal(TM.resolveMode(undefined, true), 'watch');
});

test('team modes: an explicit user choice wins, no auto-return to Watch', () => {
  assert.equal(TM.resolveMode('watch', false), 'watch');
  assert.equal(TM.resolveMode('edit', true), 'edit');
});

test('team modes: Watch disables every mutation (drag, connect, delete, rename, add, layout, menus)', () => {
  const w = TM.can('watch'); const e = TM.can('edit');
  for (const k of ['drag', 'connect', 'del', 'rename', 'add', 'layout', 'menu']) {
    assert.equal(w[k], false, `watch must disable ${k}`);
    assert.equal(e[k], true, `edit must allow ${k}`);
  }
});
