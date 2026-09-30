// Perf (t_9d92c3d3): change-driven data — file-signature versions, tail readLogs, memoized
// snapshot parts, incremental log tail, and the renderer's no-op-render signature keys.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, pickChanged } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');
const O = require('../src/overview');
const Chat = require('../src/chat');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-store-'));
  return new Store(dir);
}

test('pickChanged: null since -> all keys; unchanged -> none; only diffs listed', () => {
  const v = { board: '1:1', runs: '2:2', settings: '3:3' };
  assert.deepEqual(pickChanged(v, null).sort(), ['board', 'runs', 'settings']);
  assert.deepEqual(pickChanged(v, { board: '1:1', runs: '2:2', settings: '3:3' }), []);
  assert.deepEqual(pickChanged(v, { board: '9:9', runs: '2:2', settings: '3:3' }), ['board']);
  assert.deepEqual(pickChanged(v, {}), ['board', 'runs', 'settings']);
});

test('versions(): stable when untouched, changes on writes to the right file', () => {
  const s = tmpStore();
  const v1 = s.versions();
  assert.equal(s.versions().board, v1.board); // unchanged store: identical sigs
  s.createTask({ title: 'a' });
  const v2 = s.versions();
  assert.notEqual(v2.board, v1.board);
  assert.equal(v2.settings, v1.settings); // other files untouched
  s.saveSettings({ stallTimeoutMin: 3 });
  assert.notEqual(s.versions().settings, v2.settings);
  // teams sig covers the project's team files (real projects have project.json listing them)
  fs.writeFileSync(s.file('project'), JSON.stringify({ id: 'p', teams: [{ id: 'tm', name: 'T' }] }));
  s.forTeam('tm').addNode({ name: 'A', role: 'Dev' });
  const teams1 = s.versions().teams;
  s.forTeam('tm').updateNode(s.forTeam('tm').getTeam().nodes[0].id, { name: 'A2' });
  assert.notEqual(s.versions().teams, teams1);
  s.appendLog({ nodeId: 'a', kind: 'system', text: 'x' });
  assert.notEqual(s.versions().logs, v2.logs);
});

test('readLogs tails a multi-MB log: last N lines, identical to a full parse', () => {
  const s = tmpStore();
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(JSON.stringify({ at: i, nodeId: 'n' + (i % 3), kind: 'system', text: 'line-' + i + ' padding padding padding' }));
  // long tail lines so the first tail window holds fewer than `limit` lines (exercises window growth)
  for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ at: 20000 + i, nodeId: 'nx', kind: 'error', text: 'big-' + i + ' ' + 'x'.repeat(20000) }));
  fs.writeFileSync(s.logFile(), lines.join('\n') + '\n');
  const baseline = lines.map((l) => JSON.parse(l));
  const got = s.readLogs(500);
  assert.equal(got.length, 500);
  assert.deepEqual(got.map((l) => l.text), baseline.slice(-500).map((l) => l.text));
  assert.deepEqual(got.map((l) => l.at), baseline.slice(-500).map((l) => l.at));
  assert.equal(got[got.length - 1].level, 'error');
  // Infinity reads the whole file (used by getSessionLog)
  assert.equal(s.readLogs(Infinity).length, baseline.length);
});

test('readLogs: file without trailing newline, and small files read whole', () => {
  const s = tmpStore();
  fs.writeFileSync(s.logFile(), JSON.stringify({ at: 1, nodeId: 'a', kind: 'system', text: 'one' }) + '\n' + JSON.stringify({ at: 2, nodeId: 'a', kind: 'system', text: 'two' }));
  assert.deepEqual(s.readLogs(10).map((l) => l.text), ['one', 'two']);
  assert.deepEqual(s.readLogs(1).map((l) => l.text), ['two']);
  assert.deepEqual(tmpStore().readLogs(10), []); // no file at all
});

function countingOrch(store) {
  const orch = new Orchestrator(store);
  clearInterval(orch._wakeTimer);
  clearInterval(orch._stallTimer);
  const counts = { listRuns: 0, listTasks: 0, readLogs: 0, listWiki: 0, nodeTeamMap: 0 };
  for (const m of Object.keys(counts)) { const orig = store[m].bind(store); store[m] = (...a) => { counts[m]++; return orig(...a); }; }
  return { orch, counts };
}

test('snapshot(): unchanged files are not re-read; changed runs re-read exactly once', () => {
  const { orch, counts } = countingOrch(tmpStore());
  orch.agent('a');
  orch.snapshot();
  const afterFirst = { ...counts };
  orch.snapshot();
  assert.deepEqual(counts, afterFirst); // memo hit: zero re-reads
  orch.store.addRun({ id: 'r1', kind: 'agent', nodeId: 'a', startedAt: '2026-01-01T00:00:00Z', inputTokens: 1, outputTokens: 1 });
  orch.snapshot();
  assert.equal(counts.listRuns, afterFirst.listRuns + 1); // one shared re-read serves modelStats + timeline + ledger (t_3318ff63)
  assert.equal(counts.listTasks, afterFirst.listTasks + 2);
  assert.equal(counts.readLogs, afterFirst.readLogs); // logs unaffected by a run append
});

test('snapshot logs: appends are picked up incrementally without re-reading the whole log', () => {
  const { orch, counts } = countingOrch(tmpStore());
  orch.store.appendLog({ nodeId: 'a', kind: 'system', text: 'first' });
  const s1 = orch.snapshot();
  assert.equal(s1.logs.length, 1);
  assert.equal(counts.readLogs, 1); // one full read seeds the tail cache
  orch.store.appendLog({ nodeId: 'a', kind: 'system', text: 'second' });
  orch.store.appendLog({ nodeId: 'a', kind: 'error', text: 'third' });
  const s2 = orch.snapshot();
  assert.equal(s2.logs.length, 3);
  assert.deepEqual(s2.logs.map((l) => l.text), ['first', 'second', 'third']);
  assert.equal(counts.readLogs, 1); // appends read only the new bytes, not a second full read
  assert.equal(s2.logs[2].level, 'error');
});

test('logs(): truncate/shrink of logs.jsonl falls back to a full re-read', () => {
  const { orch, counts } = countingOrch(tmpStore());
  for (let i = 0; i < 5; i++) orch.store.appendLog({ nodeId: 'a', kind: 'system', text: 'm' + i });
  orch.snapshot();
  const before = counts.readLogs;
  fs.writeFileSync(orch.store.logFile(), JSON.stringify({ at: Date.now(), nodeId: 'a', kind: 'system', text: 'fresh' }) + '\n');
  const s = orch.snapshot();
  assert.deepEqual(s.logs.map((l) => l.text), ['fresh']);
  assert.equal(counts.readLogs, before + 1);
});

test('versionSig(): stable when nothing changed, reacts to memory and file changes', () => {
  const { orch } = countingOrch(tmpStore());
  orch.agent('a');
  const sig1 = orch.versionSig();
  assert.equal(orch.versionSig(), sig1);
  orch.agent('a').status = 'working';
  assert.notEqual(orch.versionSig(), sig1);
  const sig2 = orch.versionSig();
  orch.store.createTask({ title: 't' });
  assert.notEqual(orch.versionSig(), sig2);
});

test('overviewKey: same inputs -> same key; any rendered change -> new key; unrendered fields ignored', () => {
  const node = { id: 'a', x: 1, y: 2, name: 'A', role: 'Dev', runtime: 'claude', model: 'opus', capabilities: { big: 'blob' } };
  const base = () => ({
    projectId: 'p1', nodes: [{ ...node }], edges: [{ id: 'e1', from: 'a', to: 'b' }],
    agents: { a: { status: 'idle' } }, tasks: [{ id: 't1', title: 'T', status: 'todo', assignee: 'a', updatedAt: 'x' }],
    messages: [{ at: 5 }], logs: [{ at: 1 }, { at: 9 }], stuckMinutes: 5, selectedTask: '', bucket: 0,
  });
  assert.equal(O.overviewKey(base()), O.overviewKey(base()));
  assert.equal(O.overviewKey(base()), O.overviewKey({ ...base(), nodes: [{ ...node, capabilities: { other: 1 } }] })); // unrendered field
  assert.equal(O.overviewKey(base()), O.overviewKey({ ...base(), edges: [{ id: 'e1', from: 'a', to: 'b', type: 'assign' }] })); // default edge type
  const diff = (mut) => assert.notEqual(O.overviewKey(base()), O.overviewKey(mut(base())), mut.toString());
  diff((b) => ({ ...b, nodes: [{ ...node, x: 9 }] })); // node moved
  diff((b) => ({ ...b, nodes: [{ ...node, name: 'B' }] })); // renamed
  diff((b) => ({ ...b, agents: { a: { status: 'working' } } }));
  diff((b) => ({ ...b, agents: { a: { status: 'idle', taskId: 't9' } } }));
  diff((b) => ({ ...b, tasks: [{ id: 't1', title: 'T', status: 'done', assignee: 'a', updatedAt: 'x' }] }));
  diff((b) => ({ ...b, messages: [{ at: 5 }, { at: 6 }] }));
  diff((b) => ({ ...b, logs: [{ at: 1 }, { at: 9 }, { at: 10 }] }));
  diff((b) => ({ ...b, projectId: 'p2' }));
  diff((b) => ({ ...b, bucket: 1 }));
  diff((b) => ({ ...b, selectedTask: 't1' }));
});

test('feedKey: same inputs -> same key; visible feed changes -> new key', () => {
  const base = () => ({
    projectId: 'p1', thread: null,
    logs: [{ at: 1 }, { at: 9 }], tasks: [{ id: 't1', updatedAt: 'u', comments: [] }],
    messages: [{ at: 3 }], inbox: [{ id: 'i1' }], nodes: [{ id: 'a', name: 'A', role: 'Dev' }], working: new Set(),
    agents: { a: { subagents: [{ id: 's1', status: 'running', tokens: { inputTokens: 5, outputTokens: 2 } }] } },
    runs: [{ subagents: [{ id: 's1', status: 'running' }] }],
  });
  assert.equal(Chat.feedKey(base()), Chat.feedKey(base()));
  const diff = (mut) => assert.notEqual(Chat.feedKey(base()), Chat.feedKey(mut(base())));
  diff((b) => ({ ...b, thread: 't1' }));
  diff((b) => ({ ...b, logs: [{ at: 1 }, { at: 9 }, { at: 10 }] }));
  diff((b) => ({ ...b, tasks: [{ id: 't1', updatedAt: 'u2', comments: [] }] }));
  diff((b) => ({ ...b, tasks: [{ id: 't1', updatedAt: 'u', comments: [{ text: 'c' }] }] }));
  diff((b) => ({ ...b, messages: [{ at: 3 }, { at: 4 }] }));
  diff((b) => ({ ...b, inbox: [{ id: 'i1' }, { id: 'i2' }] }));
  diff((b) => ({ ...b, nodes: [{ id: 'a', name: 'Renamed', role: 'Dev' }] }));
  diff((b) => ({ ...b, working: new Set(['a']) }));
  diff((b) => ({ ...b, projectId: 'p2' }));
  diff((b) => ({ ...b, agents: { a: { subagents: [{ id: 's1', status: 'done', tokens: { inputTokens: 5, outputTokens: 2 } }] } } })); // subagent status
  diff((b) => ({ ...b, agents: { a: { subagents: [{ id: 's1', status: 'running', tokens: { inputTokens: 9, outputTokens: 2 } }] } } })); // subagent tokens
  diff((b) => ({ ...b, runs: [{ subagents: [{ id: 's1', status: 'done' }] }] }));
});

test('overviewKey: subagent record changes produce a new key', () => {
  const base = (sub) => ({ projectId: 'p', nodes: [], edges: [], agents: { a: { status: 'working', subagents: sub } }, tasks: [], messages: [], logs: [], stuckMinutes: 5, selectedTask: '', bucket: 0 });
  const sub = [{ id: 's1', status: 'running', tokens: { inputTokens: 1, outputTokens: 1 } }];
  assert.equal(O.overviewKey(base(sub)), O.overviewKey(base(sub.map((x) => ({ ...x })))));
  assert.notEqual(O.overviewKey(base(sub)), O.overviewKey(base(sub.map((x) => ({ ...x, status: 'done' })))));
});

// ---- task-file cache (t_8d586961): listTasks must not re-read unchanged task files ----
const utime = (p, ms) => fs.utimesSync(p, new Date(ms), new Date(ms));

test('task cache: external Store-style writes (tmp+rename) are picked up; failed parses never cached', () => {
  const s = tmpStore();
  const a = s.createTask({ title: 'alpha' });
  s.createTask({ title: 'beta' });
  assert.deepEqual(s.listTasks().map((t) => t.title).sort(), ['alpha', 'beta']); // populates cache + memo
  // Another writer (agent's board MCP server, bulk seed) writes the way every Store write does:
  // tmp file + rename. The rename bumps the dir entry, so the memo must miss and rescan.
  const file = s.taskFile(a.id);
  const overwrite = (obj) => { const tmp = file + '.ext.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n'); fs.renameSync(tmp, file); };
  overwrite({ ...s.getTask(a.id), title: 'alpha2' });
  assert.equal(s.listTasks().find((t) => t.id === a.id).title, 'alpha2');
  // half-swapped file (invalid JSON): skipped, and the failure is not cached — repair shows through
  const whole = s.getTask(a.id);
  const broken = file + '.ext.tmp'; fs.writeFileSync(broken, '{broken'); fs.renameSync(broken, file);
  assert.equal(s.listTasks().find((t) => t.id === a.id), undefined);
  overwrite({ ...whole, title: 'alpha3' });
  assert.equal(s.listTasks().find((t) => t.id === a.id).title, 'alpha3');
});

test('task memo: repeated reads return the same array until something writes, then fresh data', () => {
  const s = tmpStore();
  const a = s.createTask({ title: 'one' });
  const r1 = s.listTasks();
  const r2 = s.listTasks();
  assert.equal(r1, r2); // nothing changed: memo serves the build
  s.updateTask(a.id, { title: 'uno' });
  const r3 = s.listTasks();
  assert.notEqual(r3, r1);
  assert.equal(r3.find((t) => t.id === a.id).title, 'uno');
  assert.equal(s.listTasks(), r3); // new memo generation
});

test('task memo: an out-of-contract in-place edit (no rename) stays unseen until the next Store write', () => {
  const s = tmpStore();
  const a = s.createTask({ title: 'quiet' });
  s.listTasks();
  const file = s.taskFile(a.id);
  fs.writeFileSync(file, JSON.stringify({ ...s.getTask(a.id), title: 'sneaky' }, null, 2) + '\n'); // cat > file: no dir entry move
  assert.equal(s.listTasks().find((t) => t.id === a.id).title, 'quiet'); // invisible, as designed
  const b = s.createTask({ title: 'noise' }); // any Store write renames through the dir -> rescan
  assert.equal(s.listTasks().find((t) => t.id === a.id).title, 'sneaky'); // and heals
  assert.ok(s.getTask(b.id));
});

test('task cache: same-size + same-mtime in-process writes still invalidate (write-through)', () => {
  const s = tmpStore();
  const a = s.createTask({ title: 'aaaa' });
  s.listTasks(); // cache it
  const st = fs.statSync(s.taskFile(a.id));
  s.updateTask(a.id, { title: 'bbbb' }); // same byte length -> identical size
  utime(s.taskFile(a.id), st.mtimeMs); // and force the same mtime tick
  assert.equal(s.listTasks().find((t) => t.id === a.id).title, 'bbbb');
});

test('task cache: a throwing _withTasks mutates cached tasks — the cache is dropped, not served', () => {
  const s = tmpStore();
  const a = s.createTask({ title: 'keep' });
  s.listTasks(); // cache
  assert.throws(() => s._withTasks((ts) => { ts.find((t) => t.id === a.id).title = 'MUTATED'; throw new Error('boom'); }), /boom/);
  assert.equal(s.listTasks().find((t) => t.id === a.id).title, 'keep');
});

test('task cache: file removal drops the entry; recreated files show up', () => {
  const s = tmpStore();
  const a = s.createTask({ title: 'gone' });
  const whole = s.getTask(a.id);
  s.listTasks(); // cache
  s._unlinkTask(a.id);
  assert.equal(s.listTasks().length, 0);
  s._writeTask({ ...whole, title: 'back' });
  assert.equal(s.listTasks().length, 1);
});
