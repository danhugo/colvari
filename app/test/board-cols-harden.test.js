// Board column hardening (t_c505dc64): boardCols is the renderer's lockstep contract with the
// store's STATUSES, so two things must hold when the contract drifts — a task with an unknown or
// missing status must not crash the render (the card-memo env key used to read status[0]
// unguarded) and must not vanish from the board (colStOf routes it into an "other" column).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const block = js.slice(js.indexOf('const boardCols'), js.indexOf('const cardSigs'));
assert.ok(block.includes('colStOf'), 'the hardening helper must sit with the column contract');
assert.ok(/S\.tasks\.map\(\(x\) => colStOf\(x\)\[0\]\)/.test(js), 'the env key must read statuses through colStOf, never bare status[0]');

const { boardCols, colStOf } = new Function(`${block}\nreturn { boardCols, colStOf };`)();

test('every known column status maps to itself', () => {
  for (const st of boardCols) assert.equal(colStOf({ status: st }), st);
});

test('an unknown or missing status buckets into "other" instead of vanishing', () => {
  assert.equal(colStOf({ status: 'backlog' }), 'other'); // store-side status without a column
  assert.equal(colStOf({ status: undefined }), 'other');
  assert.equal(colStOf({}), 'other');
});
