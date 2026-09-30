// app/.sizes ("live sizes logs=... runs=... boardKB=... taskn=...") is written by
// something OUTSIDE this repo — no commit ever contained a writer (t_953fcf13). It must
// stay git-ignored so an untracked copy in the main checkout can never trip the merge
// guard's dirty-tree check again.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('app/.sizes is git-ignored so a stray size snapshot cannot block merges', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
  assert.ok(lines.includes('app/.sizes'), '.gitignore must contain the exact line "app/.sizes"');
  execFileSync('git', ['check-ignore', '-q', 'app/.sizes'], { cwd: ROOT });
});
