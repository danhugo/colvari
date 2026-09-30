const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

function setup() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cc-'));
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 0.4\necho \'{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(r, 'data')); s.saveSettings({ claudePath: fake, maxConcurrency: 0 });
  const ns = ['A', 'B', 'C'].map((n) => s.addNode({ name: n, role: 'Dev', workdir: path.join(r, 'w' + n) }));
  const rev = s.addNode({ name: 'Rev', role: 'Reviewer' }); // clean hand-offs complete via reviewer pickup
  for (const n of ns) s.addEdge(n.id, rev.id, 'review');
  return { s, ns };
}

test('3 independent tasks start 3 simultaneous runs', async () => {
  const { s, ns } = setup();
  ns.forEach((n, i) => s.createTask({ title: 't' + i, assignee: n.id }));
  const o = new Orchestrator(s); const done = new Promise((r) => { o.on('done', r); o.once('idle', r); }); // drain idles now (t_b2273507)
  o.start();
  assert.equal(o.snapshot().active.length, 3);
  await done;
  assert.ok(s.listTasks().every((t) => t.status === 'done'));
});

test('dependent task waits for its blocker', async () => {
  const { s, ns } = setup();
  const a = s.createTask({ title: 'a', assignee: ns[0].id });
  const b = s.createTask({ title: 'b', assignee: ns[1].id, blockedBy: [a.id] });
  const o = new Orchestrator(s); const done = new Promise((r) => { o.on('done', r); o.once('idle', r); }); // drain idles now (t_b2273507)
  o.start();
  assert.deepEqual(o.snapshot().active.map((x) => x.taskId), [a.id]);
  assert.equal(s.getTask(b.id).status, 'todo');
  await done;
  assert.equal(s.getTask(b.id).status, 'done');
});

// t_f2571504 regression: the board MCP config (--node <id>) used to be written into the SHARED cwd's
// helpycode.json, so two concurrent dispatches raced and one session's board connection bound to the
// other node ("scope violation: task not visible"). Now each dispatch gets its own temp config via
// <BIN>_CONFIG; the fake CLI copies whatever config it was handed into its own workdir.
test('two concurrent helpycode dispatches keep distinct board node ids', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hc-race-'));
  const sh = (n, body) => { const f = path.join(d, n); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
  const ev = (o) => `echo '${JSON.stringify(o).replace(/'/g, `'\\''`)}'`;
  const events = [
    { type: 'step_start', sessionID: 'S', part: { type: 'step-start' } },
    { type: 'text', sessionID: 'S', part: { type: 'text', text: 'working...' } },
    { type: 'tool_use', sessionID: 'S', part: { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'probe-tvok', metadata: { exit: 0 } } } },
    { type: 'step_finish', sessionID: 'S', part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0 } }, cost: 0 } },
    { type: 'text', sessionID: 'S', part: { type: 'text', text: 'done' } },
    { type: 'step_finish', sessionID: 'S', part: { type: 'step-finish', reason: 'stop', tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0 } }, cost: 0.0001 } },
  ];
  const fixtures = path.join(__dirname, 'fixtures');
  const helpy = sh('helpycode.sh', `
if [ "$1" = "--version" ]; then echo 'helpycode 0.3.5'; exit 0; fi
if [ "$1" = "--help" ] || [ "$2" = "--help" ]; then
  if [ "$1" = "run" ]; then cat '${fixtures}/help-helpycode-real-run.txt'; else cat '${fixtures}/help-helpycode-real-top.txt'; fi
  exit 0
fi
if [ "$1" = "run" ]; then
  if [ -f "$PWD/.dispatch-here" ]; then cp "$HELPYCODE_SH_CONFIG" "$PWD/captured-config.json"; fi
${events.map(ev).join('\n')}
  exit 0
fi
exit 1
`);
  const claude = sh('claude.sh', `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}'\n`);
  const s = new Store(path.join(d, 'data'));
  s.saveSettings({ claudePath: claude, helpycodePath: helpy, maxConcurrency: 0, billingMode: 'api' });
  const mk = (name) => {
    const w = path.join(d, 'w' + name);
    fs.mkdirSync(w, { recursive: true }); fs.writeFileSync(path.join(w, '.dispatch-here'), '');
    return s.addNode({ name, role: 'Dev', runtime: 'helpycode', workdir: w, billingMode: 'api' });
  };
  const a = mk('A'); const b = mk('B');
  s.createTask({ title: 'a', assignee: a.id }); s.createTask({ title: 'b', assignee: b.id });
  const o = new Orchestrator(s);
  await new Promise((res) => { o.once('done', res); o.once('idle', res); o.start(); }); // drain idles now (t_b2273507)
  const ca = JSON.parse(fs.readFileSync(path.join(d, 'wA', 'captured-config.json'), 'utf8'));
  const cb = JSON.parse(fs.readFileSync(path.join(d, 'wB', 'captured-config.json'), 'utf8'));
  assert.deepStrictEqual(ca.mcp.board.command.slice(-2), ['--node', a.id]);
  assert.deepStrictEqual(cb.mcp.board.command.slice(-2), ['--node', b.id]);
  assert.notStrictEqual(a.id, b.id);
  assert.ok(!fs.existsSync(path.join(d, 'wA', 'helpycode.json')), 'no shared config file in the workdir');
  assert.ok(!fs.existsSync(path.join(d, 'wB', 'helpycode.json')), 'no shared config file in the workdir');
});
