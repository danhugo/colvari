#!/usr/bin/env node
// Headless end-to-end: real claude CLI, PM -> Dev, goal: create hello.txt.
const fs = require('fs'); const os = require('os'); const path = require('path');
// Track every spawned claude child and reap it on exit/timeout, before the orchestrator loads.
require('../test/harness/procguard').install();
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-e2e-'));
const work = path.join(root, 'work');
const store = new Store(path.join(root, 'project'));
store.saveSettings({ maxRuns: 8 });
const pm = store.addNode({ name: 'Pam', role: 'PM', workdir: work });
const dev = store.addNode({ name: 'Dave', role: 'Dev', workdir: work, systemPrompt: 'Work only inside your current working directory.' });
store.addEdge(pm.id, dev.id);
store.createTask({ title: 'Ship hello.txt', description: 'Delegate to the Dev: create a file named hello.txt in the working directory containing exactly the text "hello world".', assignee: pm.id });

console.log('project dir:', store.dir, '\nwork dir:', work);
const orch = new Orchestrator(store);
orch.on('log', (l) => console.log(`[${l.nodeId === pm.id ? 'PM ' : l.nodeId === dev.id ? 'DEV' : 'SYS'}] ${l.kind}: ${String(l.text).slice(0, 200)}`));
const timer = setTimeout(() => { console.error('TIMEOUT'); orch.stop(); }, 10 * 60 * 1000);
// Phase 2 (after the PM -> Dev run): loop and workflow modes with haiku, checked on disk.
let phase = 1; let loopNode; let wfNode;
function startModes() {
  phase = 2;
  fs.mkdirSync(path.join(work, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(work, '.claude', 'commands', 'e2ecmd.md'), 'Write a file cmd.txt in the current directory whose content is exactly: CMD-RAN $ARGUMENTS\nThen stop.\n');
  loopNode = store.addNode({ name: 'Looper', role: 'Dev', workdir: work, model: 'haiku', mode: 'loop', loopCount: 2 });
  wfNode = store.addNode({ name: 'Flow', role: 'Dev', workdir: work, model: 'haiku', mode: 'workflow', slashCommand: '/e2ecmd' });
  store.createTask({ title: 'Loop append', description: 'Append exactly one line containing only the letter L to the file loop.txt in the working directory (create it if missing). Do this once per pass.', assignee: loopNode.id });
  store.createTask({ title: 'ARGTEXT', assignee: wfNode.id });
  orch.start();
}
function checkModes() {
  const fails = [];
  const loopTxt = path.join(work, 'loop.txt'); const cmdTxt = path.join(work, 'cmd.txt');
  const ls = fs.existsSync(loopTxt) ? fs.readFileSync(loopTxt, 'utf8').split('\n').filter((l) => l.trim() === 'L').length : 0;
  const loopRuns = store.listRuns().filter((r) => r.nodeId === loopNode.id && r.kind === 'agent').length;
  console.log(`loop.txt L lines=${ls}, loop agent runs=${loopRuns}`);
  if (loopRuns !== 2) fails.push(`loop mode ran ${loopRuns} time(s), expected 2`);
  if (ls !== 2) fails.push(`loop.txt has ${ls} L line(s), expected 2`);
  const lr = store.listRuns().filter((r) => r.nodeId === loopNode.id && r.kind === 'agent');
  const cumCR = (r) => (r && r.cumulative ? Object.values(r.cumulative.perModel).reduce((a, u) => a + u.cacheReadTokens, 0) : 0);
  if (lr[1] && (!lr[1].resumedFrom || lr[1].usageBasis !== 'delta' || lr[1].cacheReadTokens >= cumCR(lr[1]))) fails.push('loop pass 2 usage is not per-run (double counted): ' + JSON.stringify(lr.map((r) => [r.usageBasis, r.cacheReadTokens, cumCR(r)])));
  console.log('loop usage per pass:', JSON.stringify(lr.map((r) => ({ basis: r.usageBasis, cacheRead: r.cacheReadTokens, sessionCumulative: cumCR(r), cost: r.reportedCostUsd }))));
  const cmd = fs.existsSync(cmdTxt) ? fs.readFileSync(cmdTxt, 'utf8').trim() : null;
  console.log('cmd.txt:', JSON.stringify(cmd));
  if (!cmd || !/^CMD-RAN ARGTEXT$/.test(cmd)) fails.push('workflow $ARGUMENTS is not just the task text');
  return fails;
}
orch.on('done', (snap) => {
  // Review gate (t_699b67b7): a clean run hands its task off to review and — with no reviewer
  // configured for the assignee — it STAYS in review instead of auto-advancing to done. The driver
  // stands in as the reviewer: every task must have reached the hand-off, then each review task is
  // approved through the store's own approval gate before the all-done assertions run.
  const stranded = store.listTasks().filter((t) => t.status !== 'review' && t.status !== 'done');
  for (const t of store.listTasks()) if (t.status === 'review') store.approveTask(t.id, true, 'e2e driver approves the review hand-off (no reviewer configured)');
  if (phase === 1) {
    const early = !stranded.length && store.listTasks().every((t) => t.status === 'done') && fs.existsSync(path.join(work, 'hello.txt'));
    if (early && !process.env.E2E_SKIP_MODES) return startModes();
  }
  clearTimeout(timer);
  const tasks = store.listTasks();
  console.log('\nTasks:'); for (const t of tasks) console.log(` - [${t.status}] ${t.title} -> ${(store.getTeam().nodes.find((n) => n.id === t.assignee) || {}).name}`);
  console.log('Total cost: $' + snap.totalCost.toFixed(4));
  const fails = [];
  if (stranded.length) fails.push('tasks never reached the review hand-off: ' + stranded.map((t) => `${t.title} (${t.status})`).join(', '));
  if (!tasks.every((t) => t.status === 'done')) fails.push('not all tasks done');
  if (!tasks.some((t) => t.assignee === dev.id)) fails.push('PM never delegated to Dev');
  const runs = store.listRuns();
  console.log('Runs:'); for (const r of runs) console.log(` - ${r.kind} ${r.agent} model=${r.model} in=${r.inputTokens} out=${r.outputTokens} cacheR=${r.cacheReadTokens} cacheW=${r.cacheCreationTokens} turns=${r.numTurns} billing=${r.billingSource} (${r.billingDetail}) reported=$${r.reportedCostUsd.toFixed(4)}`);
  if (!runs.length) fails.push('no usage records');
  if (!runs.every((r) => r.outputTokens > 0 && r.model)) fails.push('usage record without tokens/model');
  if (!runs.every((r) => r.billingSource !== 'unknown')) fails.push('billing source not detected');
  if (!(snap.totalCost > 0) && !runs.some((r) => r.billingSource === 'subscription')) fails.push('cost not > 0');
  const hello = path.join(work, 'hello.txt');
  if (!fs.existsSync(hello)) fails.push('hello.txt missing'); else console.log('hello.txt:', JSON.stringify(fs.readFileSync(hello, 'utf8')));
  if (phase === 2) fails.push(...checkModes()); else if (!process.env.E2E_SKIP_MODES) fails.push('modes phase did not run');
  if (fails.length) { console.error('E2E FAIL:', fails.join('; ')); process.exit(1); }
  console.log('E2E PASS'); process.exit(0);
});
// F5 preflight: test both agents with their exact config before the run (cheap, max 3 turns each).
(async () => {
  for (const n of [pm, dev]) {
    const r = await orch.preflight(n);
    store.updateNode(n.id, { preflight: r });
    console.log(`preflight ${n.name}: ${r.ok ? 'PASS' : 'FAIL ' + r.error} apiKeySource=${r.apiKeySource} ${r.latencyMs}ms in=${r.tokens && r.tokens.inputTokens} out=${r.tokens && r.tokens.outputTokens}`);
    if (!r.ok) { console.error('E2E FAIL: preflight failed for ' + n.name); process.exit(1); }
  }
  orch.start();
})();
