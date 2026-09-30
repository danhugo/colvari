const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

// Runtime failure classifier + dispatch pause (t_02b995a1): tests for the seam contract of
// t_419062e2 (Devon: capture + classify + pause + single ask_human + resume). Uma's renderer
// (t_d33685f3) already consumes exactly this API — the orchestrator side must match it.
//
// RED until the core lands: this file requires ../src/failures, a module created by t_419062e2
// (same pattern as t_dfb0219d's tests: they must pass on the implementer's branch, then go green
// here once master is merged into this branch). The full contract is in a comment on t_419062e2.
//
// Everything runs against a fake claude CLI (no real model): the script prints a chosen stderr
// payload and exits with a chosen code. "Fast" vs "slow" failures are timed against FAIL.FAIL.FAST_MS,
// which each test lowers for its own duration — the exported constant object must be read at
// failure time (like the orchestrator's WAKE/STALL), not captured at require time.
// Tests that REQUIRE a streak trip give FAST_MS wide headroom (10s): under full-suite load a
// fake-CLI spawn can exceed any tighter wall-clock threshold and be misclassified slow, so the
// breaker never reaches STREAK_MAX and the trip never happens.

const FAIL = require('../src/failures'); // classifyFailure(text) -> 'auth'|'model'|null, redactError(text) -> string, FAIL = { FAST_MS, STREAK_MAX, TAIL_CAP }

const AUTH_STDERR = [
  '✖ fatal: provider request failed: 401 Unauthorized',
  '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  'not logged in — please run `helpycode login`',
].join('\n');
const MODEL_STDERR = '✖ error: model not found: zai/glm-9.9-nonexistent (no such model)';
const GENERIC_A = 'Error: ENOSPC: no space left on device, write';
const GENERIC_B = 'Error: EACCES: permission denied, open \'/tmp/nope/nope\'';
const SUCCESS_RESULT = '{"type":"result","subtype":"success","session_id":"sess-1","total_cost_usd":0,"num_turns":1,"usage":{}}';

function cliBranch(r = {}) {
  return [
    r.sleepSecs ? `sleep ${r.sleepSecs} >/dev/null 2>&1` : '',
    r.stdout ? `printf '%s\\n' ${JSON.stringify(r.stdout)}` : '',
    r.stderr ? `cat >&2 <<'FAKE_EOF'\n${r.stderr}\nFAKE_EOF` : '',
    `exit ${r.code ?? 1}`,
  ].filter(Boolean).join('\n');
}

// Fixed behavior (stderr/code/sleepSecs/stdout), or routed: the task title lands in the prompt,
// which is a CLI arg, so a case over markers in "$*" switches the behavior per task.
// routes._ is the default branch.
function writeFakeCli(root, spec = {}) {
  const fake = path.join(root, 'fake-claude.sh');
  let body;
  if (spec.routes) {
    // no indentation inside arms: a heredoc's closing delimiter must sit at column 0
    const arms = Object.entries(spec.routes).filter(([k]) => k !== '_')
      .map(([k, r]) => `  *${k}*)\n${cliBranch(r)}\n  ;;`);
    arms.push(`  *)\n${cliBranch(spec.routes._ || {})}\n  ;;`);
    body = 'case "$*" in\n' + arms.join('\n') + '\nesac';
  } else body = cliBranch(spec);
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'\n${body}\n`);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function setup({ cli = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rtfail-'));
  writeFakeCli(root, cli);
  const store = new Store(path.join(root, 'data'));
  store.saveSettings({ claudePath: path.join(root, 'fake-claude.sh'), useWorktrees: false, maxConcurrency: 4, maxRuns: 50 });
  const mk = (name, i) => store.addNode({ name, role: 'Dev', workdir: path.join(root, 'w' + i) });
  const orch = new Orchestrator(store);
  clearInterval(orch._stallTimer); clearInterval(orch._wakeTimer); // fake clock: no background sweeps
  const startManual = () => { orch.start(); clearInterval(orch._tickTimer); }; // dispatch driven by run ends + explicit tick()
  return { root, store, orch, mk, startManual };
}

function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try { if (predicate()) return resolve(); } catch (e) { return reject(e); }
      if (Date.now() - started > timeout) return reject(new Error('timed out waiting for condition'));
      setTimeout(check, 10);
    };
    check();
  });
}

const rtState = (orch, rt = 'claude') => (orch.runtimeState || {})[rt];
const tripped = (orch, rt = 'claude') => !!(rtState(orch, rt) && rtState(orch, rt).state === 'unavailable');
const openQuestions = (store) => store.listInbox().filter((i) => i.status === 'open' && i.kind === 'question');

// Lower FAIL.FAIL.FAST_MS for the test's duration; restored however the body ends.
function withFastMs(ms, fn) {
  const prev = FAIL.FAIL.FAST_MS;
  FAIL.FAIL.FAST_MS = ms;
  return Promise.resolve().then(fn).finally(() => { FAIL.FAIL.FAST_MS = prev; });
}

// ---- unit: the classifier (src/failures.js) ----

test('classifyFailure: auth and model-matching errors classify, everything else fails open', () => {
  for (const t of [
    'not logged in — please run `helpycode login`',
    '✖ fatal: provider request failed: 401 Unauthorized',
    'invalid x-api-key provided',
    'Invalid API key. Check ANTHROPIC_API_KEY and try again.',
    'authentication failed: unauthorized',
    'login required before running',
  ]) assert.equal(FAIL.classifyFailure(t), 'auth', JSON.stringify(t));
  for (const t of [
    'model not found: zai/glm-9',
    '404 {"error":{"type":"not_found_error","message":"model_not_found"}}',
    'no such model: fake/mini',
    'unknown model: gpt-9',
    "model 'opus-4.9' does not exist",
  ]) assert.equal(FAIL.classifyFailure(t), 'model', JSON.stringify(t));
  for (const t of [
    '', GENERIC_A, GENERIC_B, 'ECONNRESET', 'SyntaxError: Unexpected token',
    'warning: retrying request (1/3)', 'spawn ENOENT', 'exit code 137',
  ]) assert.ok(!FAIL.classifyFailure(t), 'must fail open on: ' + JSON.stringify(t));
});

test('redactError: api keys, bearer tokens and tokens are masked, text survives, output is capped', () => {
  const raw = [
    'x-api-key: sk-ant-api03-9f2XkQ7LmNp3vWxY8zR5tB6cD1eF4gH0jK2',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart_9f2XkQ',
    'token=abcdef0123456789abcdef0123456789',
    'not logged in — please run `helpycode login`',
  ].join('\n');
  const out = FAIL.redactError(raw);
  assert.ok(!out.includes('9f2XkQ7LmNp3vWxY8zR5tB6cD1eF4gH0jK2'), 'api key value must be masked');
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0'), 'bearer token must be masked');
  assert.ok(!out.includes('abcdef0123456789abcdef0123456789'), 'token value must be masked');
  assert.ok(/not logged in/.test(out), 'readable error text must survive redaction');
  assert.ok(/helpycode login/.test(out), 'classification-relevant wording must survive');
  assert.ok(FAIL.redactError('x'.repeat(9999)).length <= FAIL.FAIL.TAIL_CAP + 128, 'output capped near TAIL_CAP');
  // named constants (Cato: define "fast" and N as named constants and document them)
  assert.equal(FAIL.FAIL.FAST_MS, 30000);
  assert.equal(FAIL.FAIL.STREAK_MAX, 3);
});

// ---- integration: breaker through the real Store + Orchestrator + fake CLI ----

test('one classified auth failure: breaker trips immediately, real error captured, single ask_human', async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: AUTH_STDERR, code: 1 } });
  const node = mk('Dev', 1);
  const task = store.createTask({ title: 'doomed task', assignee: node.id });
  const unavailable = []; const available = [];
  orch.on('runtime.unavailable', (e) => unavailable.push(e));
  orch.on('runtime.available', (e) => available.push(e));
  startManual();
  await waitFor(() => tripped(orch));
  await waitFor(() => !orch.procs.has(node.id));

  // breaker state (Uma's renderer shape: { state, error, agents, since })
  const st = rtState(orch);
  assert.equal(st.state, 'unavailable');
  assert.ok(/not logged in|401/.test(st.error), 'state carries the real error, got: ' + st.error);
  assert.deepEqual([...st.agents].sort(), [node.id], 'agents lists the nodeIds on the runtime');
  assert.ok(Number.isFinite(st.since), 'since is a ms epoch');
  assert.equal(unavailable.length, 1, 'runtime.unavailable emitted once');
  assert.equal(available.length, 0);
  assert.equal(unavailable[0].runtime, 'claude');

  // the real (redacted) error text is captured — agent log with kind 'error' and a task comment
  const logs = store.readLogs(Infinity);
  assert.ok(logs.some((l) => l.kind === 'error' && /not logged in|401/.test(l.text)), 'error log carries the stderr tail');
  assert.ok(store.getTask(task.id).comments.some((c) => /not logged in|401/.test(c.text)), 'task comment carries the stderr tail');

  // exactly one human question for the episode, naming the runtime, the error and what to do
  const qs = openQuestions(store);
  assert.equal(qs.length, 1);
  assert.ok(qs[0].question.includes('claude'), 'question names the runtime');
  assert.ok(/not logged in|401/.test(qs[0].question), 'question carries the real error');
  assert.ok(/resume|retry|fixed/i.test(qs[0].question), 'question tells the human how to proceed');

  // the banner survives a page reload: snapshotSlim carries runtimeState
  const snap = orch.snapshotSlim();
  assert.ok(snap.runtimeState && snap.runtimeState.claude && snap.runtimeState.claude.state === 'unavailable', 'snapshotSlim.runtimeState present');
});

test('two agents failing at once on the runtime still yield one unavailable event and one ask_human', async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: AUTH_STDERR, code: 1 } });
  const n1 = mk('Dev', 1); const n2 = mk('Dev2', 2);
  store.createTask({ title: 'a', assignee: n1.id });
  store.createTask({ title: 'b', assignee: n2.id });
  const unavailable = [];
  orch.on('runtime.unavailable', (e) => unavailable.push(e));
  startManual();
  await waitFor(() => tripped(orch) && !orch.procs.has(n1.id) && !orch.procs.has(n2.id));
  await new Promise((r) => setTimeout(r, 60)); // let the second failure's handler settle
  assert.equal(unavailable.length, 1, 'event is edge-triggered per episode');
  assert.equal(openQuestions(store).length, 1, 'ask_human deduped across concurrent failures');
  assert.deepEqual([...rtState(orch).agents].sort(), [n1.id, n2.id].sort());
});

test('a classified model-missing failure trips the breaker immediately too', async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: MODEL_STDERR, code: 1 } });
  const node = mk('Dev', 1);
  store.createTask({ title: 'bad model', assignee: node.id });
  startManual();
  await waitFor(() => tripped(orch));
  assert.ok(/model not found|no such model/.test(rtState(orch).error), 'real model error surfaced');
  assert.equal(openQuestions(store).length, 1);
});

test('one fast unclassified failure fails open: no breaker, no ask, dispatch continues', async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: GENERIC_B, code: 1 } });
  const node = mk('Dev', 1);
  const t1 = store.createTask({ title: 'fails 1', assignee: node.id });
  const t2 = store.createTask({ title: 'fails 2', assignee: node.id });
  startManual();
  await waitFor(() => !orch.procs.has(node.id) && store.getTask(t2.id).status !== 'todo');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tripped(orch), false, 'a normal task failure must not trip the breaker');
  assert.equal(openQuestions(store).length, 0);
  assert.equal(orch.runs, 2, 'both tasks were dispatched');
  assert.ok(store.readLogs(Infinity).some((l) => l.kind === 'error' && /EACCES/.test(l.text)), 'real error text still captured for plain failures');
  assert.ok(store.getTask(t1.id).comments.length > 0);
});

test('three fast unclassified failures with the same signature trip the breaker (streak rule)', () => withFastMs(10000, async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: GENERIC_A, code: 1 } });
  const node = mk('Dev', 1);
  const tasks = [1, 2, 3, 4].map((i) => store.createTask({ title: 'flaky ' + i, assignee: node.id }));
  const unavailable = [];
  orch.on('runtime.unavailable', (e) => unavailable.push(e));
  startManual();
  await waitFor(() => tripped(orch));
  await waitFor(() => !orch.procs.has(node.id));
  assert.equal(orch.runs, 3, 'the breaker tripped at the third failure');
  assert.equal(store.getTask(tasks[3].id).status, 'todo', 'the 4th task stays queued, not failed');
  assert.equal(unavailable.length, 1);
  assert.equal(openQuestions(store).length, 1, 'streak trips also ask the human once');
  // the queued task says why it is held (dispatch hold-log)
  await waitFor(() => store.readLogs(Infinity).some((l) => /ready but not dispatched/.test(l.text) && /unavailable/i.test(l.text)));
}));

test('the streak needs the third failure: dispatch continues through two', () => withFastMs(10000, async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: GENERIC_A, code: 1 } });
  const node = mk('Dev', 1);
  const t3 = [1, 2, 3].map((i) => store.createTask({ title: 'flaky ' + i, assignee: node.id }))[2];
  startManual();
  await waitFor(() => !orch.procs.has(node.id) && store.getTask(t3.id).status !== 'todo');
  assert.equal(orch.runs, 3, 'the third task dispatched — two failures had not tripped yet');
  // the third failure is the one that trips (STREAK_MAX=3)
  await waitFor(() => tripped(orch));
  assert.equal(openQuestions(store).length, 1);
}));

test('fast failures with different signatures do not accumulate into a streak', () => withFastMs(1000, async () => {
  const { store, orch, mk, startManual } = setup({ cli: { routes: { 'RTSIG-A': { stderr: GENERIC_A }, 'RTSIG-B': { stderr: GENERIC_B } } } });
  const node = mk('Dev', 1);
  const ts = ['A 1', 'B 1', 'A 2', 'B 2'].map((s, i) => store.createTask({ title: `RTSIG-${s} task`, assignee: node.id }));
  startManual();
  await waitFor(() => !orch.procs.has(node.id) && ts.every((t) => store.getTask(t.id).status !== 'todo'), 8000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tripped(orch), false, 'alternating errors must never reach STREAK_MAX');
  assert.equal(orch.runs, 4, 'all four tasks ran');
  assert.equal(openQuestions(store).length, 0);
}));

test('slow failures never trip via the streak rule, even with the same signature', () => withFastMs(1000, async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: GENERIC_A, code: 1, sleepSecs: 2 } });
  const node = mk('Dev', 1);
  const ts = [1, 2, 3].map((i) => store.createTask({ title: 'slow fail ' + i, assignee: node.id }));
  startManual();
  await waitFor(() => !orch.procs.has(node.id) && ts.every((t) => store.getTask(t.id).status !== 'todo'), 15000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tripped(orch), false, 'slow failures at STREAK_MAX with the same signature still fail open');
  assert.equal(orch.runs, 3);
  assert.equal(openQuestions(store).length, 0);
}));

test('a success resets the failure streak', () => withFastMs(1000, async () => {
  const { store, orch, mk, startManual } = setup({ cli: { routes: { 'RTSIG-OK': { stdout: SUCCESS_RESULT, code: 0 }, _: { stderr: GENERIC_A } } } });
  const node = mk('Dev', 1);
  const ts = ['A', 'OK', 'B', 'C'].map((m, i) => store.createTask({ title: `RTSIG-${m} reset ${i}`, assignee: node.id }));
  startManual();
  await waitFor(() => !orch.procs.has(node.id) && ts.every((t) => store.getTask(t.id).status !== 'todo'), 8000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tripped(orch), false, 'f, success, f, f = streak 2, not 3');
  assert.equal(orch.runs, 4);
  assert.equal(openQuestions(store).length, 0);
}));

test('secrets are redacted on every surface (logs, state, comment, inbox) and the tail is capped', async () => {
  const SECRET_KEY = 'sk-ant-api03-9f2XkQ7LmNp3vWxY8zR5tB6cD1eF4gH0jK2';
  const SECRET_BEARER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart_9f2XkQ';
  const stderr = 'x'.repeat(4000) + '\n'
    + `x-api-key: ${SECRET_KEY}\nAuthorization: Bearer ${SECRET_BEARER}\n` + AUTH_STDERR;
  const { store, orch, mk, startManual } = setup({ cli: { stderr, code: 1 } });
  const node = mk('Dev', 1);
  const task = store.createTask({ title: 'leaky', assignee: node.id });
  startManual();
  await waitFor(() => tripped(orch)); // still classified auth despite redaction
  const surfaces = [
    ['logs', JSON.stringify(store.readLogs(Infinity))],
    ['state', JSON.stringify(rtState(orch))],
    ['comments', JSON.stringify(store.getTask(task.id).comments)],
    ['inbox', JSON.stringify(store.listInbox())],
  ];
  for (const [where, blob] of surfaces) {
    assert.ok(!blob.includes(SECRET_KEY), `api key leaked into ${where}`);
    assert.ok(!blob.includes(SECRET_BEARER), `bearer token leaked into ${where}`);
  }
  assert.ok(rtState(orch).error.length <= 2048 + 128, 'state error capped near TAIL_CAP');
  assert.ok(/not logged in|401/.test(rtState(orch).error), 'classification wording survives the cap (tail kept)');
});

test('resume clears the breaker, re-dispatches queued tasks, and a new episode may ask again', async () => {
  const { store, orch, mk, startManual } = setup({ cli: { stderr: AUTH_STDERR, code: 1 } });
  const node = mk('Dev', 1);
  store.createTask({ title: 'first', assignee: node.id });
  const unavailable = []; const available = [];
  orch.on('runtime.unavailable', (e) => unavailable.push(e));
  orch.on('runtime.available', (e) => available.push(e));
  startManual();
  await waitFor(() => tripped(orch) && !orch.procs.has(node.id));
  assert.equal(openQuestions(store).length, 1, 'first episode asked once');

  // the Run has stopped by now (nothing dispatchable while paused); work queued for the
  // paused runtime must wait, not fail
  const queued = store.createTask({ title: 'queued behind the breaker', assignee: node.id });
  try { orch.tick(); } catch {}
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(store.getTask(queued.id).status, 'todo', 'paused runtime: task stays queued');
  assert.equal(available.length, 0);

  await orch.resumeRuntime('claude');
  assert.equal(available.length, 1, 'runtime.available emitted on resume');
  assert.equal(available[0].runtime, 'claude');
  assert.equal(tripped(orch), false, 'breaker cleared');
  // queued work flows again even though the Run had stopped: resume re-arms dispatch
  await waitFor(() => store.getTask(queued.id).status !== 'todo');

  // same auth failure again = a NEW unavailable episode: it trips and asks AGAIN
  await waitFor(() => tripped(orch), 8000);
  assert.equal(unavailable.length, 2);
  assert.equal(openQuestions(store).length, 2, 'one ask per episode, not one forever');
});
