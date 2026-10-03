// Whole-patch fast path (t_005acd70): with the board tab open, patchBoardColumns runs on every
// state push (~15/s in a streaming burst), so a signature over everything the patch reads lets a
// matching push return without touching the DOM. Three things must hold for that to be safe: the
// signature covers every input the patch reads, a matching signature short-circuits before any DOM
// work, and the signature is stamped only after a full successful patch (a throw mid-patch must
// leave the stale signature rejected — the renderLog t_9f57b293 lesson).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = js.indexOf('let boardPatchSig');
assert.ok(start > -1, 'the fast-path signature must be declared');
const block = js.slice(start, js.indexOf('function renderBoard', start));
assert.ok(block.includes('patchBoardColumns'), 'the sig must live with the patcher it guards');

test('the signature covers everything the patch reads', () => {
  for (const part of ['envKey', 'sel.task', 'doneOpen', 'showAllDone', 'BOARD_SIG_CLOCK_MS', 't.updatedAt']) {
    assert.ok(block.slice(0, block.indexOf('if (sig === boardPatchSig)')).includes(part), `sig must read ${part}`);
  }
  assert.equal(js.match(/BOARD_SIG_CLOCK_MS = (\d+)/)[1], '30000', 'clock bucket stays ≤ half the 60s ago() step so age labels stay fresh');
});

test('a matching signature short-circuits before any DOM work', () => {
  assert.ok(/const sig = \[[^\]]*\]\.join\('\|'\);\s*if \(sig === boardPatchSig\) return;/.test(block),
    'the early return must sit immediately after the signature build');
});

test('the signature is stamped only after a full successful patch', () => {
  assert.equal((block.match(/boardPatchSig = sig/g) || []).length, 1, 'exactly one stamp site');
  const stamp = block.indexOf('boardPatchSig = sig;');
  const loop = block.indexOf('.forEach(');
  const evict = block.indexOf('cardHtmlCache.size > tasks.length');
  assert.ok(stamp > loop, 'the stamp must come after the column loop it guards');
  assert.ok(stamp < evict, 'the stamp must land before the end of the function body');
});
