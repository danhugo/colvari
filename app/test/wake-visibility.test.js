// Wake-run visibility: an idle agent whose only task sits in review is woken by a message. While the
// wake run is live, the state the Board/Team/Overview views render from shows the wake reason
// (working, no in_progress task, sender + message excerpt); when the run ends it clears. Fake CLI
// only — no real-model runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { Orchestrator, WAKE } = require('../src/orchestrator');

// Short timings so sweeps fire quickly; the semantics under test are unchanged.
WAKE.SWEEP_MS = 40; WAKE.DEBOUNCE_MS = 60;
test.after(() => { WAKE.SWEEP_MS = 1000; WAKE.DEBOUNCE_MS = 1500; });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (dir, body) => { const f = path.join(dir, 'fake-claude.sh'); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
const RESULT = `echo '{"type":"result","subtype":"success","session_id":"sess1","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}'\n`;
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

test('wake-run visibility: reason shows while the run is live, clears after', async () => {
  const d = tmp('squad-wakevis-');
  // Fake model slow enough to observe the mid-run state the UI renders.
  const fake = fakeClaude(d, `sleep 1\n` + RESULT);
  const s = new Store(path.join(d, 'p')); s.saveSettings({ claudePath: fake });
  const a = s.addNode({ name: 'Ada', role: 'Dev' }); const b = s.addNode({ name: 'Bo', role: 'Dev' });
  s.addEdge(a.id, b.id);
  // Bo's only task is in review: nothing in_progress, so any live run of his is a wake run.
  const t = s.createTask({ title: 'Review notes', assignee: b.id, createdBy: a.id });
  s.updateTask(t.id, { status: 'review' });
  const o = new Orchestrator(s);
  const woken = []; o.on('woken_by_message', (w) => woken.push(w));
  const ta = makeTools(s, a.id);

  ta.send_message({ to: 'Bo', text: 'please re-check the review notes on your task' });

  // While the wake run is live: working without an in_progress task, and the wake reason
  // (sender name + message excerpt) is visible in the pushed state.
  await waitFor(() => o.agent(b.id).status === 'working');
  const mid = o.snapshot();
  assert.equal(mid.agents[b.id].taskId, null, 'working, but not on a task');
  assert.ok(mid.active.some((x) => x.nodeId === b.id && x.taskId === null), 'live entry without a task');
  assert.equal(woken.length, 1, 'woken_by_message pushed once');
  assert.equal(woken[0].nodeId, b.id);
  assert.deepEqual(woken[0].by, [a.id]);
  const logText = JSON.stringify(mid.logs);
  assert.match(logText, /woken by message from Ada/, 'wake reason with sender name');
  assert.ok(logText.includes('please re-check the review notes'), 'message excerpt in the wake reason');
  assert.equal(s.getTask(t.id).status, 'review', 'review task untouched by the wake');

  // After the run: nothing live for Bo, status back to idle — the indicator clears.
  await waitFor(() => o.agent(b.id).status === 'idle' && !o.snapshot().active.some((x) => x.nodeId === b.id));
  const run = s.listRuns({ nodeId: b.id })[0];
  assert.equal(run.kind, 'agent');
  assert.equal(run.taskId, null);
  assert.equal(run.exitCode, 0);
  assert.equal(s.getTask(t.id).status, 'review');
});
