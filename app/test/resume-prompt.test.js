const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, resumePrompt, commentsSince } = require('../src/orchestrator');
const { mktemp } = require('./harness/tmp');

// Resumed task session: send only what changed, not the full brief (t_0e476897).

const node = { id: 'n1', name: 'Dee', role: 'Dev' };
const c = (author, text) => ({ author, text, at: '2026-01-01T00:00:00Z' });

test('commentsSince: comments after the agent\'s last comment; null when it never commented', () => {
  assert.equal(commentsSince([], node), null);
  assert.equal(commentsSince([c('Pia', 'do it')], node), null);
  assert.deepEqual(commentsSince([c('Pia', 'a'), c('Dee', 'done'), c('Pia', 'b'), c('Dee', 'fixed'), c('Cato', 'c1'), c('human', 'c2')], node).map((x) => x.text), ['c1', 'c2']);
  assert.deepEqual(commentsSince([c('n1', 'by id'), c('Pia', 'x')], node).map((x) => x.text), ['x'], 'author may be the node id');
  assert.deepEqual(commentsSince([c('Dee', 'last')], node), []);
});

test('resumePrompt: id, title, same session, only new comments, unread hint, done line', () => {
  const task = { id: 't9', title: 'Fix thing', description: 'LONG BRIEF', comments: [c('Pia', 'old ask'), c('Dee', 'did it'), c('Cato', 'tests fail')] };
  const p = resumePrompt(node, task, { unread: 2 });
  assert.match(p, /t9/); assert.match(p, /Fix thing/); assert.match(p, /same session/);
  assert.match(p, /- Cato: tests fail/);
  assert.ok(!p.includes('old ask') && !p.includes('did it') && !p.includes('LONG BRIEF'), 'no old comments or brief');
  assert.match(p, /2 unread message\(s\): call read_messages/);
  assert.match(p, /update_task_status with taskId=t9 and status="done"/);
  assert.ok(!resumePrompt(node, task).includes('unread'), 'no unread hint without unread');
  assert.equal(resumePrompt(node, { ...task, comments: [c('Pia', 'x')] }), null, 'no earlier comment: full prompt');
});

// ---- integration through the orchestrator with a fake claude CLI ----

const SRESULT = (sid) => `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{},"session_id":"${sid}"}'`;
function setup(script) {
  const d = mktemp('squad-resumeprompt-');
  const argsLog = path.join(d, 'args.txt'); const count = path.join(d, 'calls');
  const fake = path.join(d, 'fake-claude.sh');
  fs.writeFileSync(fake, `#!/bin/sh\nn=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}\necho "$*" >> ${argsLog}\n${script}`);
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake, maxConcurrency: 4 });
  return { s, argsLog };
}
const readCalls = (argsLog) => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').split(/(?=^-p )/m).filter((x) => x.trim()) : []);
async function settle(o, ms = 5000) {
  const t0 = Date.now(); let quiet = 0;
  while (Date.now() - t0 < ms) {
    if (o.procs.size > 0) { quiet = 0; await new Promise((r) => setImmediate(r)); continue; }
    if (++quiet >= 25) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('settle timeout');
}
async function run(script, { comments = [], mode } = {}) {
  const { s, argsLog } = setup(script);
  const n = s.addNode({ name: 'Dee', role: 'Dev', ...(mode ? { mode, loopCount: 2 } : {}) });
  const t = s.createTask({ title: 'resume me', assignee: n.id, description: 'FULL BRIEF TEXT' });
  for (const [a, x] of comments) s.commentTask(t.id, a, x);
  s.updateTask(t.id, { status: 'in_progress', sessions: { [`${n.id}:claude`]: 'old-1' } });
  const o = new Orchestrator(s); o.running = true; o.preflight = async () => ({ ok: true });
  const r = await o.retestAndResume(t.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  await settle(o);
  return readCalls(argsLog);
}

test('resumed task session gets the short delta prompt', async () => {
  const calls = await run(SRESULT('old-1'), { comments: [['Pia', 'OLD ASK'], ['Dee', 'did it'], ['Cato', 'NEW FINDING']] });
  assert.match(calls[0], /--resume old-1/);
  assert.match(calls[0], /same session/); assert.match(calls[0], /NEW FINDING/);
  assert.ok(!calls[0].includes('FULL BRIEF TEXT') && !calls[0].includes('OLD ASK'), 'no full brief, no old comments');
});

test('fallback: full prompt when the agent never commented', async () => {
  const calls = await run(SRESULT('old-1'), { comments: [['Pia', 'OLD ASK']] });
  assert.match(calls[0], /--resume old-1/); assert.match(calls[0], /FULL BRIEF TEXT/);
});

test('fallback: full prompt in loop mode', async () => {
  const calls = await run(SRESULT('old-1'), { comments: [['Dee', 'did it'], ['Cato', 'more']], mode: 'loop' });
  assert.match(calls[0], /FULL BRIEF TEXT/);
});

test('fallback: failed resume retries fresh with the full prompt', async () => {
  const calls = await run(`if [ "$n" = 1 ]; then echo 'No conversation found with session ID: old-1' >&2; exit 1; fi\n` + SRESULT('new-1'), { comments: [['Dee', 'did it'], ['Cato', 'NEW']] });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /--resume old-1/); assert.ok(!calls[0].includes('FULL BRIEF TEXT'));
  assert.ok(!calls[1].includes('--resume')); assert.match(calls[1], /FULL BRIEF TEXT/);
});
