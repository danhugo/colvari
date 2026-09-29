// Extras over board-layout.test.js for the per-file store (t_4ef7235d): the change-detection
// signatures the renderer polls, the out-of-band-edit integrity check Cato required (log, adopt),
// and the privacy boundary — private stores never appear under the readable .squad/ tree.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');

const tmp = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-bf-')));
const tasksDir = (s) => path.join(s.dir, '.squad', 'board', 'tasks');
const wikiDir = (s) => path.join(s.dir, '.squad', 'wiki');

test('sigFile("board"/"wiki") track per-file writes so change-driven refresh still fires', () => {
  const s = tmp();
  assert.equal(s.sigFile('board'), '');
  assert.equal(s.sigFile('wiki'), '');
  const b0 = s.sigFile('board');
  const t = s.createTask({ title: 'sig' });
  assert.notEqual(s.sigFile('board'), b0);
  const b1 = s.sigFile('board');
  s.commentTask(t.id, 'me', 'c');
  assert.notEqual(s.sigFile('board'), b1);
  const w0 = s.sigFile('wiki');
  s.writeWiki('Page', 'text', 'Pia');
  assert.notEqual(s.sigFile('wiki'), w0);
  s.deleteWiki('Page');
  assert.equal(s.sigFile('wiki'), '');
  // versions() is what the renderer polls; both sections must move with writes
  const v0 = s.versions();
  s.createTask({ title: 'sig2' });
  s.writeWiki('P2', 'x', 'Pia');
  const v1 = s.versions();
  assert.notEqual(v0.board, v1.board);
  assert.notEqual(v0.wiki, v1.wiki);
});

test('private stores stay outside .squad/ — readable tree holds only tasks and wiki', () => {
  const s = tmp();
  s.createTask({ title: 't' });
  s.writeWiki('W', 'x', 'Pia');
  s.sendMessage({ from: 'a', to: 'b', text: 'dm' });
  s.addInbox({ kind: 'question', question: 'q?' });
  s.addRun({ kind: 'agent', sessionId: 'x' });
  s.saveSettings({ budgetUsd: 1 });
  const squad = path.join(s.dir, '.squad');
  const tree = fs.readdirSync(squad);
  assert.deepEqual(tree.sort(), ['board', 'wiki']);
  assert.deepEqual(fs.readdirSync(path.join(squad, 'board')).filter((f) => !f.startsWith('.')).sort(), ['tasks']);
  for (const f of ['messages.json', 'inbox.json', 'runs.json', 'settings.json']) {
    assert.equal(fs.existsSync(path.join(s.dir, f)), true, f + ' stays at the store root');
  }
});

test('out-of-band task edits are logged (then adopted) on the next load', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ooe-'));
  const s1 = tmpStore(d);
  const t = s1.createTask({ title: 'watched' });
  s1.commentTask(t.id, 'me', 'note');

  fs.writeFileSync(path.join(tasksDir(s1), t.id + '.json'), JSON.stringify({ ...s1.getTask(t.id), status: 'done' }, null, 2)); // hand edit
  const s2 = tmpStore(d);
  assert.equal(s2.getTask(t.id).status, 'done'); // file content wins, edit not silently dropped
  assert.ok(s2.readLogs(100).some((l) => l.kind === 'store.integrity' && l.text.includes('out-of-band edit') && l.text.includes(t.id)), 'edit must be logged');

  // a whole task file dropped into the dir is adopted (and logged), not ignored
  fs.writeFileSync(path.join(tasksDir(s2), 't_rogue.json'), JSON.stringify({ id: 't_rogue', title: 'rogue', status: 'todo', comments: [], blockedBy: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }));
  const s3 = tmpStore(d);
  assert.equal(s3.getTask('t_rogue').title, 'rogue');
  assert.ok(s3.readLogs(100).some((l) => l.kind === 'store.integrity' && l.text.includes('t_rogue.json')));
  // second load is quiet: adopting re-baselined the hashes
  const before = s3.readLogs(100).filter((l) => l.kind === 'store.integrity').length;
  assert.equal(tmpStore(d).readLogs(100).filter((l) => l.kind === 'store.integrity').length, before);
});

test('out-of-band wiki edits and new .md files are logged; new files are adopted as pages', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ww-'));
  const s1 = tmpStore(d);
  s1.writeWiki('Runbook', '# v1', 'Pia');

  const slug = s1._readWikiIndex()['Runbook'].slug;
  fs.writeFileSync(path.join(wikiDir(s1), slug + '.md'), '# hand edited');
  const s2 = tmpStore(d);
  assert.equal(s2.readWiki('Runbook').content, '# hand edited');
  assert.ok(s2.readLogs(100).some((l) => l.kind === 'store.integrity' && l.text.includes('out-of-band edit') && l.text.includes(slug)));

  fs.writeFileSync(path.join(wikiDir(s2), 'notes-from-agent.md'), 'agent notes');
  const s3 = tmpStore(d);
  assert.equal(s3.readWiki('notes-from-agent').content, 'agent notes');
  assert.ok(s3.readLogs(100).some((l) => l.kind === 'store.integrity' && l.text.includes('notes-from-agent.md')));
});

test('migration leaves the old store as .bak even when reopening repeatedly', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-bak-'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(d, 'board.json'), JSON.stringify({ tasks: [{ id: 't_old', title: 'Old', description: '', assignee: null, status: 'todo', createdBy: 'human', parentId: null, blockedBy: [], comments: [], createdAt: now, updatedAt: now }] }, null, 2));
  fs.writeFileSync(path.join(d, 'wiki.json'), JSON.stringify({ pages: { W: { title: 'W', content: 'w', author: 'Pia', updatedAt: now } } }, null, 2));
  for (let i = 0; i < 3; i++) {
    const s = tmpStore(d);
    assert.equal(s.listTasks().length, 1);
    assert.equal(s.readWiki('W').content, 'w');
  }
  assert.equal(fs.existsSync(path.join(d, 'board.json')), false);
  assert.equal(fs.existsSync(path.join(d, 'wiki.json')), false);
  assert.ok(fs.readdirSync(d).filter((f) => f.startsWith('board.json.bak-')).length === 1, 'exactly one board backup');
  assert.ok(fs.readdirSync(d).filter((f) => f.startsWith('wiki.json.bak-')).length === 1, 'exactly one wiki backup');
  const bak = JSON.parse(fs.readFileSync(fs.readdirSync(d).filter((f) => f.startsWith('board.json.bak-')).map((f) => path.join(d, f))[0], 'utf8'));
  assert.equal(bak.tasks.length, 1, 'backup keeps the old data readable');
});

// Fresh Store instance per call, like the app after a restart: the load-time checks run each time.
function tmpStore(dir) { const s = new Store(dir); s.listTasks(); s.listWiki(); return s; }
