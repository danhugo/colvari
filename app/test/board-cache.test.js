const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { ProjectManager } = require('../src/projects');
const { BoardCache } = require('../src/board-cache');
const { spawnSync } = require('child_process');
const { mktemp } = require('./harness/tmp');

// Slow hints / no automatic reconcile: each test controls exactly which path (watch hint vs
// reconcile backstop) is under test.
const cachedStore = (dir, over = {}) => new Store(dir, null, { cache: { debounceMs: 10, reconcileMs: 3600_000, ...over } });
const atomicWrite = (file, data) => { // the way out-of-process writers do it (Store._writeFileSync shape)
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};
const mkTask = (id, patch = {}) => JSON.stringify({ id, title: 't ' + id, status: 'todo', comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch }, null, 2) + '\n';
const until = async (fn, ms = 2000) => { for (let t = 0; t < ms; t += 25) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return fn(); };

test('warm cache: list/get and the board sig hit no disk', () => {
  const d = mktemp('bc-hit-');
  const s = cachedStore(d);
  s.createTask({ title: 'one' });
  s.listTasks(); s.getTask(s.listTasks()[0].id); s.sigFile('board'); // warm
  const orig = fs.readFileSync; let reads = 0;
  fs.readFileSync = (...a) => { reads++; return orig(...a); };
  try {
    const ts = s.listTasks();
    assert.equal(ts.length, 1);
    assert.ok(s.getTask(ts[0].id));
    s.sigFile('board'); s.sigFile('wiki');
    assert.equal(reads, 0, 'warm list/get/sig must not read any file');
  } finally { fs.readFileSync = orig; }
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('own write: consistent immediately, exactly one delta, disk matches', async () => {
  const d = mktemp('bc-own-');
  const s = cachedStore(d);
  const events = [];
  s.cache.on('change', (e) => events.push(e));
  const t = s.createTask({ title: 'own' });
  assert.equal(s.getTask(t.id).title, 'own'); // write-through, no wait
  assert.equal(events.length, 1);
  s.updateTask(t.id, { status: 'in_progress' });
  assert.equal(s.getTask(t.id).status, 'in_progress');
  assert.equal(events.filter((e) => e.id === t.id).length, 2); // create + update, no more
  await new Promise((r) => setTimeout(r, 300)); // let the watcher echo land
  assert.equal(events.filter((e) => e.id === t.id).length, 2, 'watcher echo of our own write must not add a delta');
  assert.equal(JSON.parse(fs.readFileSync(s.taskFile(t.id), 'utf8')).status, 'in_progress'); // disk is truth
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq is monotonic');
  assert.ok(events.every((e) => e.version >= 1));
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('external edit via watch hint: adopted and reflected within ms', async () => {
  const d = mktemp('bc-ext-');
  const s = cachedStore(d);
  const t = s.createTask({ title: 'before' });
  atomicWrite(s.taskFile(t.id), mkTask(t.id, { title: 'after', status: 'review' }));
  const events = [];
  s.cache.on('change', (e) => events.push(e));
  assert.ok(await until(() => s.getTask(t.id).title === 'after'), 'watch hint must adopt the external edit');
  assert.equal(s.getTask(t.id).status, 'review');
  assert.ok(events.some((e) => e.id === t.id && e.type === 'put'));
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('external write from a separate node process lands via hint or one reconcile (Cato a)', async () => {
  const d = mktemp('bc-proc-');
  const s = cachedStore(d);
  s.listTasks(); // warm + start watchers
  const fid = 't_extprocess1';
  const script = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(s.tasksDir())},{recursive:true});fs.writeFileSync(${JSON.stringify(s.taskFile(fid))},${JSON.stringify(mkTask(fid, { title: 'from another process' }))});`;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 10000 });
  assert.equal(r.status, 0, r.stderr && r.stderr.toString());
  const seen = await until(() => s.listTasks().some((x) => x.id === fid), 1500);
  if (!seen) s.cache.reconcile(); // dropped event: one full reconcile must be enough
  assert.ok(s.listTasks().some((x) => x.id === fid && x.title === 'from another process'));
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('reconcile backstop adopts external edits and deletes when hints are lost', () => {
  const d = mktemp('bc-rec-');
  const s = cachedStore(d, { debounceMs: 3600_000 }); // watch hints never drain: reconcile is the only path
  const a = s.createTask({ title: 'a' });
  const b = s.createTask({ title: 'b' });
  atomicWrite(s.taskFile(a.id), mkTask(a.id, { title: 'a2' }));
  fs.unlinkSync(s.taskFile(b.id));
  const events = [];
  s.cache.on('change', (e) => events.push(e));
  s.cache.reconcile();
  assert.equal(s.listTasks().find((x) => x.id === a.id).title, 'a2');
  assert.equal(s.getTask(b.id), undefined);
  assert.ok(events.some((e) => e.id === a.id && e.type === 'put'));
  assert.ok(events.some((e) => e.id === b.id && e.type === 'delete'));
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('partial write from another process: last good entry kept, never evicted, no delete (Cato c)', async () => {
  const d = mktemp('bc-part-');
  const s = cachedStore(d, { debounceMs: 3600_000 });
  const t = s.createTask({ title: 'good' });
  const events = [];
  s.cache.on('change', (e) => events.push(e));
  const base = events.length;
  atomicWrite(s.taskFile(t.id), '{"id":"' + t.id + '","title":"trunc'); // half-swapped file
  s.cache.reconcile();
  assert.equal(s.getTask(t.id).title, 'good', 'unparseable file must not evict the cached entry');
  assert.equal(events.length, base, 'a partial write must not emit any delta');
  atomicWrite(s.taskFile(t.id), mkTask(t.id, { title: 'complete' })); // the write finishes
  s.cache.reconcile();
  assert.ok(await until(() => s.getTask(t.id).title === 'complete'));
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('burst of 50 writes ends in the correct final state, one delta each (Cato d)', () => {
  const d = mktemp('bc-burst-');
  const s = cachedStore(d);
  const events = [];
  s.cache.on('change', (e) => events.push(e));
  const t = s.createTask({ title: 'burst' });
  for (let i = 0; i < 50; i++) s.updateTask(t.id, { title: 'burst ' + i });
  assert.equal(s.getTask(t.id).title, 'burst 49');
  assert.equal(JSON.parse(fs.readFileSync(s.taskFile(t.id), 'utf8')).title, 'burst 49');
  assert.equal(events.length, 51); // create + 50 updates, no duplicates
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('delete: external unlink evicts and emits delete only when the file is really gone', async () => {
  const d = mktemp('bc-del-');
  const s = cachedStore(d);
  const t = s.createTask({ title: 'gone soon' });
  await new Promise((r) => setTimeout(r, 250)); // let FSEvents flush the create first (it folds create+delete otherwise)
  const events = [];
  s.cache.on('change', (e) => events.push(e));
  fs.unlinkSync(s.taskFile(t.id));
  if (!(await until(() => s.getTask(t.id) === undefined, 1000))) s.cache.reconcile(); // dropped event -> one reconcile
  assert.equal(s.getTask(t.id), undefined);
  assert.ok(events.some((e) => e.id === t.id && e.type === 'delete'));
  assert.ok(!s.listTasks().some((x) => x.id === t.id));
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('wiki: own write visible immediately without a duplicate delta; external edit adopted', async () => {
  const d = mktemp('bc-wiki-');
  const s = cachedStore(d);
  const events = [];
  s.cache.on('change', (e) => { if (e.section === 'wiki') events.push(e); });
  s.writeWiki('Plan', 'hello', 'devon');
  assert.equal(s.readWiki('Plan').content, 'hello'); // write-through
  assert.equal(events.length, 1);
  const slug = s.cache.wiki.get('Plan').slug;
  await new Promise((r) => setTimeout(r, 200)); // watcher echoes of .md + .pages.json
  assert.equal(events.length, 1, 'echoes of our own wiki write must not add deltas');
  atomicWrite(path.join(s.wikiDir(), slug + '.md'), 'rewritten externally');
  assert.ok(await until(() => s.readWiki('Plan').content === 'rewritten externally'));
  s.deleteWiki('Plan');
  assert.equal(s.readWiki('Plan'), null);
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});

test('project close closes the watchers: no deltas after close (Cato e)', async () => {
  const root = mktemp('bc-close-');
  const pm = new ProjectManager(root);
  const pid = pm.list()[0].id;
  pm.create('spare'); // remove() refuses to delete the last project
  const s = pm.store(pid);
  assert.ok(s.cache, 'ProjectManager stores are cached by default');
  s.listTasks(); // force load + watchers
  const cache = s.cache;
  const events = [];
  cache.on('change', (e) => events.push(e));
  s.createTask({ title: 'doomed' });
  pm.remove(pid); // project close
  assert.equal(cache.closed, true);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(events.filter((e) => e.id === 't_afterclose').length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('uncached Stores (MCP shape) keep reading disk and share nothing', async () => {
  const d = mktemp('bc-plain-');
  const s = cachedStore(d);
  const t = s.createTask({ title: 'shared' });
  const plain = new Store(d); // what mcp-server.js builds
  assert.equal(plain.cache, null);
  assert.equal(plain.getTask(t.id).title, 'shared');
  plain.updateTask(t.id, { status: 'review' }); // another process writes
  assert.ok(await until(() => s.getTask(t.id).status === 'review'), 'the cached store must see the MCP write');
  s.cache.close();
  fs.rmSync(d, { recursive: true, force: true });
});
