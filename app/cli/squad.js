#!/usr/bin/env node
// Headless runner: give a goal to a persistent team and run it to completion.
// Usage: node cli/squad.js --project <dir> --workdir <repo> --goal "..." [--max-runs 20]
const fs = require('fs'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const goal = arg('goal'); if (!goal) { console.error('--goal is required'); process.exit(2); }
const work = path.resolve(arg('workdir', process.cwd()));
const store = new Store(path.resolve(arg('project', path.join(require('os').homedir(), '.agents-squad', 'dogfood'))));
store.saveSettings({ maxRuns: +arg('max-runs', 20), maxConcurrency: 1 });

if (!store.getTeam().nodes.length) {
  const common = 'You work on the Agents Squad desktop app in your working directory (git repo). Coordinate only through the board tools. Commit your work with git when a task is complete.';
  const pm = store.addNode({ name: 'Pia', role: 'PM', model: 'opus', workdir: work, systemPrompt: `${common} You own the product. Turn the human intention into small, concrete, testable tasks, assign them to Dev, then assign verification to Reviewer. Write decisions to the wiki. Do not write code yourself.` });
  const dev = store.addNode({ name: 'Devon', role: 'Dev', model: 'opus', workdir: work, systemPrompt: `${common} Implement tasks in app/. Keep the vanilla JS style. Run "npm test" in app/ before marking done.` });
  const rev = store.addNode({ name: 'Rhea', role: 'Reviewer', model: 'opus', workdir: work, systemPrompt: `${common} Verify the Dev's work: read the diff (git log/diff), run "npm test" and when UI changed "npm run gui-e2e" in app/ and look at app/e2e-shots. If broken, create a fix task for Dev. Otherwise mark done.` });
  store.addEdge(pm.id, dev.id, 'assign'); store.addEdge(pm.id, rev.id, 'assign'); store.addEdge(rev.id, dev.id, 'assign'); store.addEdge(dev.id, rev.id, 'message');
}
const team = store.getTeam();
const lead = team.nodes.find((n) => !team.edges.some((e) => e.to === n.id && e.type === 'assign')) || team.nodes[0];
store.createTask({ title: goal.slice(0, 80), description: goal, assignee: lead.id });
const name = (id) => (team.nodes.find((n) => n.id === id) || {}).name || 'SYS';
const orch = new Orchestrator(store);
orch.on('log', (l) => { if (['text', 'tool', 'result', 'error', 'system'].includes(l.kind)) console.log(`[${name(l.nodeId)}] ${l.kind}: ${String(l.text).slice(0, 300)}`); });
orch.on('done', () => {
  for (const t of store.listTasks()) console.log(` - [${t.status}] ${t.title} -> ${name(t.assignee)}`);
  const runs = store.listRuns(); const tok = runs.reduce((a, r) => a + (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0), 0);
  console.log(`runs=${runs.length} tokens=${tok}`); process.exit(0);
});
orch.start();
