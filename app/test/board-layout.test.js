// Board storage contract (t_39b9d980 / t_1f6dc80f): the board is files an agent can read with
// cat/grep/jq — one pretty-JSON file per task at .squad/board/tasks/<id>.json, one markdown file
// per wiki page at .squad/wiki/<slug>.md, all under the store (project) dir. Reads are free;
// writes stay inside the store (atomic tmp+rename under the .lock mutex), so parallel writers
// from several processes lose nothing, and an old single-file store (board.json / wiki.json)
// migrates on open without losing or duplicating anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const { buildPrompt } = require('../src/orchestrator');

const tmp = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-board-')));
const tasksDir = (s) => path.join(s.dir, '.squad', 'board', 'tasks');
const taskFile = (s, tid) => path.join(tasksDir(s), tid + '.json');
const wikiDir = (s) => path.join(s.dir, '.squad', 'wiki');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const listFiles = (dir) => fs.readdirSync(dir).filter((f) => !f.startsWith('.'));

test('tasks live at .squad/board/tasks/<id>.json and track every write', () => {
  const s = tmp();
  const t = s.createTask({ title: 'Goal', assignee: 'n1' });
  const f = taskFile(s, t.id);
  assert.equal(fs.existsSync(f), true, 'task file must exist at .squad/board/tasks/<id>.json');
  let onDisk = readJson(f);
  assert.equal(onDisk.id, t.id);
  assert.equal(onDisk.title, 'Goal');
  assert.equal(onDisk.status, 'todo');

  s.updateTask(t.id, { status: 'in_progress' });
  s.commentTask(t.id, 'me', 'hi');
  onDisk = readJson(f);
  assert.equal(onDisk.status, 'in_progress');
  assert.equal(onDisk.comments.length, 1);
  assert.deepEqual(s.getTask(t.id), onDisk); // API view and file agree

  s.deleteTask(t.id);
  assert.equal(fs.existsSync(f), false, 'deleted task must not leave a file behind');
  assert.equal(s.getTask(t.id), undefined);
});

test('wiki pages live at .squad/wiki/<slug>.md; slugs are flat, sanitized and case-safe', () => {
  const s = tmp();
  s.writeWiki('Runbook', '# runbook steps', 'Pia');
  const files = listFiles(wikiDir(s));
  assert.equal(files.length, 1);
  assert.match(files[0], /\.md$/, 'wiki page must be a markdown file');
  assert.match(fs.readFileSync(path.join(wikiDir(s), files[0]), 'utf8'), /# runbook steps/);
  assert.equal(s.readWiki('Runbook').content, '# runbook steps');

  // awkward titles stay flat inside .squad/wiki (no subdirs, no traversal, no case clobber)
  s.writeWiki('API Design/v2', 'rest stuff', 'Devon');
  s.writeWiki('../../evil', 'gotcha', 'Cato');
  for (const title of ['API Design/v2', '../../evil']) {
    const page = s.readWiki(title);
    assert.ok(page, `title with path characters must round-trip: ${title}`);
    const md = listFiles(wikiDir(s)).find((f) => fs.readFileSync(path.join(wikiDir(s), f), 'utf8') === page.content);
    assert.ok(md, 'page content must be in a file directly under .squad/wiki');
    assert.ok(!md.includes('/') && !md.includes('..'), `slug must be flat and traversal-safe: ${md}`);
    assert.equal(fs.existsSync(path.join(s.dir, 'evil.md')), false, 'must not write outside .squad/wiki');
  }
  s.writeWiki('API Design', 'the real api', 'Uma');
  s.writeWiki('api design', 'the other api', 'Uma');
  assert.equal(s.readWiki('API Design').content, 'the real api');
  assert.equal(s.readWiki('api design').content, 'the other api'); // case-insensitive fs must not merge these

  const before = listFiles(wikiDir(s)).length;
  s.deleteWiki('Runbook');
  assert.equal(listFiles(wikiDir(s)).length, before - 1, 'deleteWiki removes the markdown file');
  assert.equal(s.readWiki('Runbook'), null);
});

test('parallel writers from separate processes lose nothing and leave valid JSON', async () => {
  const s = tmp();
  const shared = s.createTask({ title: 'shared' });
  const storeSrc = require.resolve('../src/store');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-writer-'));
  const child = path.join(d, 'writer.js');
  fs.writeFileSync(child, `
    const { Store } = require(process.argv[2]);
    const s = new Store(process.argv[3]);
    const tag = process.argv[5];
    for (let i = 0; i < +process.argv[4]; i++) {
      s.createTask({ title: tag + '-task-' + i });
      s.commentTask(process.argv[6], tag, 'comment ' + i);
    }
  `);
  const W = 4, N = 6;
  // all children at once: only simultaneous separate processes can lose updates
  const done = await Promise.all(Array.from({ length: W }, (_, w) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [child, storeSrc, s.dir, String(N), 'w' + w, shared.id], { stdio: ['ignore', 'inherit', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => (code === 0 ? res() : rej(new Error('writer w' + w + ' failed: ' + err))));
  })));
  assert.ok(done);

  const tasks = s.listTasks();
  assert.equal(tasks.length, W * N + 1, 'every create from every writer must survive');
  const got = s.getTask(shared.id);
  assert.equal(got.comments.length, W * N, 'comment appends from all writers must survive (no lost update)');
  const authors = new Set(got.comments.map((c) => c.author));
  assert.deepEqual([...authors].sort(), Array.from({ length: W }, (_, w) => 'w' + w).sort());
  for (const t of tasks) { // every file parses and agrees with the API view
    const raw = fs.readFileSync(taskFile(s, t.id), 'utf8');
    const onDisk = JSON.parse(raw);
    assert.equal(onDisk.id, t.id);
    assert.equal(onDisk.title, t.title);
    assert.match(raw, /\n\s+"id"/, 'files stay pretty-printed (cat/grep/jq friendly)');
  }
});

function oldStore(dir) {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ tasks: [
    { id: 't_old1', title: 'First', description: '', assignee: 'n1', status: 'done', createdBy: 'human', parentId: null, blockedBy: [], comments: [{ author: 'me', text: 'note', at: now }], createdAt: now, updatedAt: now },
    { id: 't_old2', title: 'Second', description: 'd', assignee: null, status: 'todo', createdBy: 'human', parentId: null, blockedBy: ['t_old1'], comments: [], createdAt: now, updatedAt: now },
  ] }, null, 2));
  fs.writeFileSync(path.join(dir, 'wiki.json'), JSON.stringify({ pages: { Runbook: { title: 'Runbook', content: '# old page', author: 'Pia', updatedAt: now } } }, null, 2));
}

test('old single-file store migrates: complete, partial and reopened', () => {
  const open = (dir) => { const s = new Store(dir); s.listTasks(); s.listWiki(); return s; }; // touch board + wiki so migration has run
  const expectIntact = (s) => {
    const tasks = s.listTasks();
    assert.deepEqual(tasks.map((t) => t.id).sort(), ['t_old1', 't_old2']);
    assert.equal(s.getTask('t_old1').comments[0].text, 'note');
    assert.deepEqual(s.getTask('t_old2').blockedBy, ['t_old1']);
    for (const t of tasks) { const f = taskFile(s, t.id); assert.equal(fs.existsSync(f), true, 'migrated task must get a file'); assert.equal(readJson(f).id, t.id); }
    assert.equal(s.readWiki('Runbook').content, '# old page');
    assert.equal(listFiles(wikiDir(s)).length, 1);
  };

  // full migration
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mig-'));
  oldStore(d1);
  expectIntact(open(d1));

  // interrupted halfway: old board.json still present, only one task file written — heals, no dupes
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mig-'));
  oldStore(d2);
  fs.mkdirSync(tasksDir(d2), { recursive: true });
  fs.copyFileSync(taskFile(d1, 't_old1'), taskFile(d2, 't_old1'));
  expectIntact(open(d2));

  // reopening a migrated store is a no-op
  const s1 = open(d1);
  expectIntact(s1);
  s1.createTask({ title: 'post-migration' });
  assert.equal(open(d1).listTasks().length, 3);
  assert.equal(fs.existsSync(path.join(d1, 'board.json')), false, 'old board.json must be renamed away, not left to win');
  assert.ok(fs.readdirSync(d1).some((f) => f.startsWith('board.json')), 'a backup of the old store is kept (never deleted)');
});

test('agent prompt tells the agent where board and wiki files live', () => {
  const s = tmp();
  const a = s.addNode({ name: 'Dev', role: 'Dev' });
  const t = s.createTask({ title: 'x', assignee: a.id });
  const p = buildPrompt(s.getTeam(), s.getTeam().nodes.find((n) => n.id === a.id), t);
  assert.match(p, /\.squad\/board\/tasks/, 'prompt must mention the per-task file dir');
  assert.match(p, /\.squad\/wiki/, 'prompt must mention the wiki dir');
});
