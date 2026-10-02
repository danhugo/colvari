const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { buildPrompt, Orchestrator, attachedFilesLines } = require('../src/orchestrator');
const { buildClaudeArgs } = require('../src/agent-config');
const { mktemp } = require('./harness/tmp');

const tmp = () => new Store(mktemp('squad-att-'));

test('saveAttachment writes bytes under <store>/attachments and returns the 4 fields', () => {
  const s = tmp();
  const r = s.saveAttachment({ name: 'shot.png', mime: 'image/png', bytes: Buffer.from([1, 2, 3, 255]) });
  assert.ok(!r.error, 'unexpected error: ' + JSON.stringify(r));
  assert.deepEqual(pick4(r), { path: r.path, name: 'shot.png', mime: 'image/png', size: 4 });
  assert.ok(r.path.startsWith(path.join(s.dir, 'attachments') + path.sep), 'file lives inside attachments/');
  assert.equal(fs.readFileSync(r.path).toString('hex'), '010203ff', 'exact bytes on disk');
});
const pick4 = (a) => ({ path: a.path, name: a.name, mime: a.mime, size: a.size });

test('saveAttachment cleans the name: basename only, safe chars, no traversal', () => {
  const s = tmp();
  for (const [input, want] of [
    ['../../etc/passwd', 'passwd'],
    ['my shot (1).png', 'my-shot-1-.png'], // safe chars only; the stored name is not meant to be pretty
    ['..\\..\\evil.gif', 'evil.gif'], // windows-style separators never survive the cleaning
    ['', 'file'],
  ]) {
    const r = s.saveAttachment({ name: input, mime: 'image/gif', bytes: Buffer.from([7]) });
    assert.ok(!r.error, input + ' -> unexpected error ' + JSON.stringify(r));
    assert.equal(r.name, want, input);
    assert.ok(!path.basename(r.path).includes('..'), 'no traversal in stored name');
    assert.ok(r.path.startsWith(path.join(s.dir, 'attachments') + path.sep), 'stays inside attachments/');
  }
});

test('saveAttachment rejects over the 10 MB limit with a clear message and writes nothing', () => {
  const s = tmp();
  const dir = path.join(s.dir, 'attachments');
  const r = s.saveAttachment({ name: 'big.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(10 * 1024 * 1024 + 1) });
  assert.ok(r.error && /too large/.test(r.error) && /10 MB/.test(r.error), 'clear limit error, got: ' + r.error);
  try { assert.equal(fs.readdirSync(dir).length, 0); } catch { assert.ok(!fs.existsSync(dir), 'nothing written'); }
});

test('saveAttachment without bytes returns an error', () => {
  const s = tmp();
  assert.ok(s.saveAttachment({ name: 'x.png' }).error);
  assert.ok(s.saveAttachment({}).error);
});

test('sendMessage stores attachments with exactly the 4 fields (no base64 in messages.json)', () => {
  const s = tmp();
  const n = s.addNode({ name: 'Dev', role: 'Dev' });
  const m = s.sendMessage({ from: 'human', to: n.id, text: 'look at this', attachments: [{ path: '/p/a.png', name: 'a.png', mime: 'image/png', size: 9, data: 'AAAAbase64nope' }] });
  assert.deepEqual(m.attachments, [{ path: '/p/a.png', name: 'a.png', mime: 'image/png', size: 9 }]);
  const raw = fs.readFileSync(path.join(s.dir, 'messages.json'), 'utf8');
  assert.ok(!raw.includes('base64nope'), 'extra keys never reach messages.json');
  assert.ok(!raw.includes('data'), 'no data key on the record');
  assert.ok(!s.sendMessage({ from: 'human', to: n.id, text: 'plain' }).hasOwnProperty('attachments'));
});

test('createTask accepts attachments as extra payload keys and persists them', () => {
  const s = tmp();
  const t = s.createTask({ title: 'fix logo', attachments: [{ path: '/p/logo.png', name: 'logo.png', mime: 'image/png', size: 4 }] });
  assert.deepEqual(s.getTask(t.id).attachments, [{ path: '/p/logo.png', name: 'logo.png', mime: 'image/png', size: 4 }]);
  assert.equal(s.getTask(s.createTask({ title: 'no atts' }).id).attachments, undefined);
});

test('attachedFilesLines renders absolute paths; buildPrompt includes them for the task', () => {
  assert.equal(attachedFilesLines([]), '');
  assert.equal(attachedFilesLines(undefined), '');
  const lines = attachedFilesLines([{ path: '/p/attachments/1-ab.png', name: '1-ab.png', mime: 'image/png', size: 12 }]);
  assert.match(lines, /^Attached files: \/p\/attachments\/1-ab\.png \(image\/png, 12 bytes\)$/);

  const s = tmp();
  const a = s.addNode({ name: 'Dev', role: 'Dev' });
  const team = s.getTeam(); const node = team.nodes.find((n) => n.id === a.id);
  const plain = s.createTask({ title: 'plain', assignee: a.id });
  assert.ok(!buildPrompt(team, node, plain).includes('Attached files:'), 'no attachment lines without attachments');
  const withAtt = s.createTask({ title: 'with shot', assignee: a.id, attachments: [{ path: '/p/attachments/2-cd.png', name: '2-cd.png', mime: 'image/png', size: 3 }] });
  const p = buildPrompt(team, node, withAtt);
  assert.ok(p.includes('Attached files: /p/attachments/2-cd.png (image/png, 3 bytes)'), p);
});

test('humanPrompt appends attachment paths from the human message', () => {
  const { humanPrompt } = require('../src/orchestrator');
  const p = humanPrompt('fix this', null, [{ path: '/p/attachments/3-ef.png', name: '3-ef.png', mime: 'image/png', size: 5 }]);
  assert.ok(p.includes('Message from the human operator'));
  assert.ok(p.includes('Attached files: /p/attachments/3-ef.png (image/png, 5 bytes)'));
  assert.ok(!humanPrompt('plain', null, []).includes('Attached files:'));
});

test('orchestrator sendToAgent accepts a 3rd-arg {attachments} and stores it on the message', () => {
  const s = tmp();
  const n = s.addNode({ name: 'Dev', role: 'Dev' });
  const o = new Orchestrator(s);
  const r = o.sendToAgent(n.id, 'use this', null, { attachments: [{ path: '/p/attachments/4-aa.png', name: '4-aa.png', mime: 'image/png', size: 1 }] });
  const rec = s.listMessages({ to: n.id }).find((m) => m.id === r.id);
  assert.deepEqual(rec.attachments, [{ path: '/p/attachments/4-aa.png', name: '4-aa.png', mime: 'image/png', size: 1 }]);
});

test('buildClaudeArgs adds --add-dir for opts.attachDir after the node addDirs', () => {
  const node = { name: 'Dev', role: 'Dev', addDirs: ['/repo/extra'] };
  const without = buildClaudeArgs(node, 'p', {}, null, {});
  assert.equal(without.filter((a) => a === '--add-dir').length, 1);
  assert.deepEqual(without.slice(without.indexOf('--add-dir') + 1), ['/repo/extra']);
  const withAtt = buildClaudeArgs(node, 'p', {}, null, { attachDir: '/store/attachments' });
  assert.deepEqual(withAtt.slice(withAtt.lastIndexOf('--add-dir') + 1), ['/store/attachments']);
  const only = buildClaudeArgs({ name: 'Dev', role: 'Dev' }, 'p', {}, null, { attachDir: '/store/attachments' });
  assert.deepEqual(only.slice(only.indexOf('--add-dir') + 1), ['/store/attachments']);
});

test('two uploads with the same name never overwrite each other', () => {
  const s = tmp();
  const a = s.saveAttachment({ name: 'dup.png', mime: 'image/png', bytes: Buffer.from([1]) });
  const b = s.saveAttachment({ name: 'dup.png', mime: 'image/png', bytes: Buffer.from([2, 2]) });
  assert.ok(!a.error && !b.error);
  assert.notEqual(a.path, b.path, 'each upload gets its own file');
  assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
  assert.deepEqual([...fs.readFileSync(a.path)], [1]);
  assert.deepEqual([...fs.readFileSync(b.path)], [2, 2]);
});

// Every prompt that prints "Attached files:" must run with opts.attachDir, else the agent gets a
// path it cannot read. wakeRun is its own args path (task+human share runTask's runAtts line), so it
// is the one that can drift — drive it with a stubbed runtime + spawnRun and record the opts.
test('wakeRun passes attachDir when its messages carry attachments, and not otherwise', async () => {
  const RT = require('../src/runtimes');
  const orig = RT.getRuntime;
  const seen = [];
  RT.getRuntime = () => ({ buildArgs: (cfg, prompt, settings, mcp, opts) => { seen.push(opts); return ['echo']; } });
  try {
    const s = tmp();
    const n = s.addNode({ name: 'Dev', role: 'Dev' });
    const o = new Orchestrator(s);
    o.spawnRun = async () => ({ code: 0 });
    const team = s.getTeam();
    const node = team.nodes.find((x) => x.id === n.id);
    const att = [{ path: path.join(s.attachmentsDir(), '5-bc.png'), name: '5-bc.png', mime: 'image/png', size: 2 }];
    await o.wakeRun(node, [{ id: 'm_1', from: 'human', to: n.id, text: 'look', attachments: att }], team, s.getSettings());
    assert.equal(seen[0].attachDir, s.attachmentsDir(), 'wake run with attachments gets the dir');
    await o.wakeRun(node, [{ id: 'm_2', from: 'human', to: n.id, text: 'plain' }], team, s.getSettings());
    assert.equal(seen[1].attachDir, undefined, 'plain wake run gets no dir');
  } finally { RT.getRuntime = orig; }
});

// ---- Agent-posted attachments (t_6628894d): send_message/comment_task copy {path} files into the
// store and keep only the reference. The allowed root is the caller's cwd (the agent's worktree).
const { makeTools } = require('../src/board-tools');

const agentPair = () => {
  const s = tmp();
  const a = s.addNode({ name: 'Dev A', role: 'Dev' });
  const b = s.addNode({ name: 'Dev B', role: 'Dev' });
  s.addEdge(a.id, b.id, 'message');
  // wt sits inside a sibling-parent dir so '../' escape targets exist on disk next to it.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-wtp-'));
  const wt = path.join(parent, 'wt');
  fs.mkdirSync(wt);
  return { s, a, b, wt, parent };
};
const inWt = (wt, fn) => { const prev = process.cwd(); process.chdir(wt); try { return fn(); } finally { process.chdir(prev); } };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('send_message with a worktree png: copy saved, only the 4-field reference stored', () => {
  const { s, a, b, wt } = agentPair();
  fs.writeFileSync(path.join(wt, 'shot.png'), PNG);
  const m = inWt(wt, () => makeTools(s, a.id).send_message({ to: b.id, text: 'see shot', attachments: [{ path: 'shot.png' }] }));
  assert.equal(m.attachments.length, 1);
  const att = m.attachments[0];
  assert.deepEqual(pick4(att), { path: att.path, name: 'shot.png', mime: 'image/png', size: PNG.length });
  assert.ok(att.path.startsWith(path.join(s.dir, 'attachments') + path.sep), 'the copy lives in the store');
  assert.notEqual(att.path, path.join(wt, 'shot.png'), 'the stored path is the copy, not the agent file');
  assert.equal(fs.readFileSync(att.path).toString('hex'), PNG.toString('hex'), 'exact bytes copied');
  const raw = fs.readFileSync(path.join(s.dir, 'messages.json'), 'utf8');
  assert.ok(!raw.includes(wt), 'the agent-provided worktree path never reaches messages.json');
});

test('comment_task accepts attachments; the task prompt carries the copy path', () => {
  const { s, a, wt } = agentPair();
  fs.writeFileSync(path.join(wt, 'ui.png'), PNG.subarray(0, 4));
  const t = s.createTask({ title: 'polish ui', assignee: a.id, createdBy: a.id });
  const c = inWt(wt, () => makeTools(s, a.id).comment_task({ taskId: t.id, text: 'screenshot attached', attachments: [{ path: './ui.png' }] }));
  assert.deepEqual(c.attachments.map(pick4), [{ path: c.attachments[0].path, name: 'ui.png', mime: 'image/png', size: 4 }]);
  assert.ok(c.attachments[0].path.startsWith(path.join(s.dir, 'attachments') + path.sep), 'copied into the store');
  const team = s.getTeam(); const node = team.nodes.find((x) => x.id === a.id);
  assert.ok(buildPrompt(team, node, s.getTask(t.id)).includes(`Attached files: ${c.attachments[0].path} (image/png, 4 bytes)`), 'prompt line for comment attachments');
  assert.equal(s.commentTask(t.id, a.id, 'plain').attachments, undefined, 'no attachments key without them');
});

test('attachment rejections: ../ escape, absolute outside, symlink escape, svg, oversize, missing', () => {
  const { s, a, b, wt, parent } = agentPair();
  const t = s.createTask({ title: 'x', assignee: a.id, createdBy: a.id });
  const call = (atts, which) => inWt(wt, () => makeTools(s, a.id)[which](
    which === 'send_message' ? { to: b.id, text: 'x', attachments: atts } : { taskId: t.id, text: 'x', attachments: atts }));
  // ../ escape: the file exists one level up the worktree, realpath lands outside the root.
  const outside = path.join(parent, 'secret.png');
  fs.writeFileSync(outside, PNG);
  fs.writeFileSync(path.join(wt, 'inside.png'), PNG);
  fs.symlinkSync(outside, path.join(wt, 'trap.png'));
  assert.throws(() => call([{ path: '../secret.png' }], 'send_message'), /outside your working directory/);
  assert.throws(() => call([{ path: outside }], 'send_message'), /outside your working directory/);
  assert.throws(() => call([{ path: 'trap.png' }], 'send_message'), /outside your working directory|not found/, 'symlink escape');
  // SVG is scriptable: rejected by the extension allowlist (not found vs unsupported are both fine).
  fs.writeFileSync(path.join(wt, 'evil.svg'), '<svg/>');
  assert.throws(() => call([{ path: 'evil.svg' }], 'send_message'), /unsupported attachment/);
  assert.throws(() => call([{ path: 'notes.txt' }], 'send_message'), /unsupported attachment/);
  // Size checked by stat BEFORE reading: an over-limit file is refused without a copy.
  fs.writeFileSync(path.join(wt, 'big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.throws(() => call([{ path: 'big.png' }], 'send_message'), /too large.*10 MB/);
  assert.throws(() => call([{ path: 'ghost.png' }], 'send_message'), /attachment not found/);
  assert.throws(() => call([{}], 'send_message'), /each attachment needs/);
  assert.throws(() => call([{ path: 'inside.png' }, { path: 'inside.png' }, { path: 'inside.png' }, { path: 'inside.png' }, { path: 'inside.png' }, { path: 'inside.png' }], 'send_message'), /max 5 per call/);
  // Nothing was copied and no message/comment row holds an attachment.
  try { assert.equal(fs.readdirSync(s.attachmentsDir()).length, 0, 'rejected calls never copied anything'); } catch { assert.ok(!fs.existsSync(s.attachmentsDir()), 'nothing copied (no attachments dir at all)'); }
  assert.equal(s.listMessages({ to: b.id }).length, 0, 'no message stored when a ref fails');
  assert.equal(s.getTask(t.id).comments.length, 0, 'no comment stored when a ref fails');
});

test('all-or-nothing: one bad ref among good ones rejects the call and copies nothing', () => {
  const { s, a, b, wt } = agentPair();
  fs.writeFileSync(path.join(wt, 'good1.png'), PNG);
  fs.writeFileSync(path.join(wt, 'good2.png'), PNG);
  fs.writeFileSync(path.join(wt, 'evil.svg'), '<svg/>');
  assert.throws(() => inWt(wt, () => makeTools(s, a.id).send_message({ to: b.id, text: 'x', attachments: [{ path: 'good1.png' }, { path: 'good2.png' }, { path: 'evil.svg' }] })), /unsupported attachment/);
  try { assert.equal(fs.readdirSync(s.attachmentsDir()).length, 0, 'validated good files were NOT copied'); } catch { assert.ok(!fs.existsSync(s.attachmentsDir()), 'no attachments dir at all'); }
  assert.equal(s.listMessages({ to: b.id }).length, 0, 'no message row');
});
