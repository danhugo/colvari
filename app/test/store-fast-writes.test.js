// Lock-hold and write-cost regressions from t_7e53747c:
// - .hashes.json entries are sig-keyed ({sig, hash}); _verifyTaskIntegrity skips re-hashing files
//   whose size:mtime still matches — the full-board hash used to run under the lock on the first
//   board call of EVERY new process, and each agent run spawns a fresh board MCP process.
// - _withTasks' before-image reuses the per-file cache's compact form (one stringify pass per
//   write instead of two — both used to run inside the lock on every agent MCP call).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Store } = require('../src/store');
const { mktemp } = require('./harness/tmp');

test('task hashes are sig-keyed and a second verify pass rewrites nothing', () => {
  const dir = mktemp('squad-');
  const s = new Store(dir);
  const t = s.createTask({ title: 'sig one', status: 'todo' });
  s.updateTask(t.id, { status: 'in_progress' });
  const h1 = fs.readFileSync(dir + '/.squad/board/.hashes.json', 'utf8');
  const parsed = JSON.parse(h1);
  const entry = parsed[t.id + '.json'];
  assert.ok(entry && typeof entry === 'object' && entry.sig && entry.hash, 'entry is {sig, hash}');
  s._verifyTaskIntegrity(); // warm: every file's stat matches its recorded sig
  const h2 = fs.readFileSync(dir + '/.hashes.json'.replace(/^\/\.hashes/, '/.squad/board/.hashes'), 'utf8');
  assert.equal(h2, h1, 'no re-hash, no rewrite when sigs match');
});

test('an out-of-band edit is still adopted (and re-hashed) after the sig skip', () => {
  const dir = mktemp('squad-');
  const s = new Store(dir);
  const t = s.createTask({ title: 'sig two', status: 'todo' });
  const f = dir + '/.squad/board/tasks/' + t.id + '.json';
  fs.writeFileSync(f, JSON.stringify({ ...s.getTask(t.id), title: 'hand edit' }, null, 2) + '\n'); // no rename, no Store
  s._verifyTaskIntegrity();
  const parsed = JSON.parse(fs.readFileSync(dir + '/.squad/board/.hashes.json', 'utf8'));
  const entry = parsed[t.id + '.json'];
  assert.notEqual(entry.hash, 'x');
  const crypto = require('node:crypto');
  assert.equal(entry.hash, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), 'the adopted file is hashed');
  assert.equal(entry.sig, fs.statSync(f).size + ':' + fs.statSync(f).mtimeMs, 'sig recorded for the skip');
});

test('old plain-string hash maps upgrade to {sig, hash} on verify', () => {
  const dir = mktemp('squad-');
  const s = new Store(dir);
  const t = s.createTask({ title: 'sig three', status: 'todo' });
  const crypto = require('node:crypto');
  const f = dir + '/.squad/board/tasks/' + t.id + '.json';
  const oldMap = {};
  oldMap[t.id + '.json'] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); // pre-t_7e53747c shape
  fs.writeFileSync(dir + '/.squad/board/.hashes.json', JSON.stringify(oldMap));
  s._verifyTaskIntegrity();
  const parsed = JSON.parse(fs.readFileSync(dir + '/.squad/board/.hashes.json', 'utf8'));
  assert.ok(typeof parsed[t.id + '.json'] === 'object' && parsed[t.id + '.json'].sig, 'upgraded in place');
});

test('a no-op _withTasks writes nothing; a real change writes exactly once', () => {
  const dir = mktemp('squad-');
  const s = new Store(dir);
  const t = s.createTask({ title: 'cost one', status: 'todo' });
  let writes = 0;
  const orig = s._writeTask.bind(s);
  s._writeTask = (x) => { writes++; return orig(x); };
  s._withTasks(() => {}); // pure no-op over the whole board
  assert.equal(writes, 0, 'unchanged tasks must not rewrite (before-image matches)');
  s._withTasks((tasks) => { tasks.find((x) => x.id === t.id).status = 'in_progress'; });
  assert.equal(writes, 1, 'the mutated task writes once');
  s._writeTask = orig;
});

test('a task replaced by a new object in fn still persists', () => {
  const dir = mktemp('squad-');
  const s = new Store(dir);
  const t = s.createTask({ title: 'cost two', status: 'todo' });
  s._withTasks((tasks) => { const i = tasks.findIndex((x) => x.id === t.id); tasks[i] = { ...tasks[i], title: 'replaced' }; });
  assert.equal(s.getTask(t.id).title, 'replaced');
});
