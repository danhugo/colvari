// Per-chat composer drafts (t_bc5d19c7): text typed in one chat must not follow you to another.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const a0 = src.indexOf('const chatDrafts');
const a1 = src.indexOf('function renderChatBody');
assert.ok(a0 > 0 && a1 > a0, 'draft block found in renderer/app.js');
const { swapDraft } = new Function(`${src.slice(a0, a1)}\nreturn { swapDraft };`)();

test('each chat keeps its own draft across A -> B -> A', () => {
  let v = swapDraft(undefined, 'A|t1|', '');           // first draw
  v = 'hello A';                                        // user types in A
  v = swapDraft('A|t1|', 'B|t2|', v);                   // switch to B
  assert.strictEqual(v, '', 'new room starts empty');
  v = 'hello B';
  v = swapDraft('B|t2|', 'A|t1|', v);                   // back to A
  assert.strictEqual(v, 'hello A');
  v = '';                                               // send in A clears only A
  v = swapDraft('A|t1|', 'B|t2|', v);
  assert.strictEqual(v, 'hello B');
  assert.strictEqual(swapDraft('B|t2|', 'B|t2|', 'x'), 'x', 'same chat: untouched');
});
