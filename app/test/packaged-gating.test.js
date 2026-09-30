// Audit-closure test for packaged-mode gating (Cato's audit on t_c13f2e6a, QA t_2563af39):
// one cheap file that forces devMode=false the way main.js wires a packaged build
// (DEV_MODE = !app.isPackaged unless AGENTS_SQUAD_DEV) and asserts every item from the audit
// is gated. Per-implementation unit detail lives next to each gate (restart.test.js packaged
// block, alerts.test.js, mcp-scope.test.js); this file is the checklist — if any gate
// regresses, it fails naming the audit item. No real-model runs, no gui-e2e (the DOM hiding
// has its own cheap gui-e2e scenario: AGENTS_SQUAD_GUI_E2E_ONLY=packaged). The rule itself is
// documented in docs/dev-vs-packaged.md.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator, buildPrompt } = require('../src/orchestrator');
const { makeTools, enabledTools } = require('../src/board-tools');
const A = require('../src/alerts');
const MG = require('../src/merge-gate');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeClaude = (d) => {
  const f = path.join(d, 'fake-claude.sh');
  fs.writeFileSync(f, '#!/bin/sh\necho \'{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(f, 0o755);
  return f;
};
// main.js packaged wiring: Orchestrator({devMode:false}) (which forces store.devMode=false too),
// a non-dev updater stub, timers disarmed. Store ops below run as the agent MCP servers would
// see them (store.devMode false → merges count nothing, tools refuse).
const packagedSetup = (d) => {
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fakeClaude(d) });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const a = s.addNode({ name: 'A', role: 'Dev' });
  s.addEdge(pm.id, a.id);
  const o = new Orchestrator(s, { devMode: false });
  o.wakeRun = async () => {};
  clearInterval(o._wakeTimer); clearInterval(o._stallTimer); clearInterval(o._tickTimer); clearInterval(o._restartTimer);
  o.updater = { status: () => ({ phase: 'idle', enabled: false, devMode: false }), restartNow() {} };
  return { s, o, pm, a };
};
const collect = (state) => A.collect({ now: 1759000000000, ...state });

// Audit 2 — the Restart pending/now chip must have no data source in packaged mode: neither the
// restart-state IPC/push channel (Devon t_f64a079e) nor the bell alerts row (Uma t_7fbee55f).
test('packaged: no restart-chip data reaches the renderer despite stale stored state', () => {
  const d = tmp('squad-pkg-');
  const { s, o, pm } = packagedSetup(d);
  // Boot wiped a schedule carried over from a dev run of the same project…
  s.setRestartPending({ scheduledNow: true, count: 7 });
  const o2 = new Orchestrator(s, { devMode: false });
  clearInterval(o2._wakeTimer); clearInterval(o2._stallTimer); clearInterval(o2._tickTimer); clearInterval(o2._restartTimer);
  assert.equal(s.restartPending(), null, 'audit: boot wipes the impossible schedule');
  // …and a stale state written after boot (out-of-band writer) still reads as dark:
  s.setRestartPending({ scheduledNow: true, count: 7, afterTaskId: s.createTask({ title: 'anchor', assignee: pm.id, createdBy: 'human' }).id });
  let pushed = null;
  o2.on('restart-state', (r) => { pushed = r; });
  o2.sweepRestart();
  const st = o2.restartState();
  assert.equal(st.pendingCount, 0, 'audit: restartState (getRestartState IPC) reports nothing');
  assert.equal(st.scheduledNow, false); assert.equal(st.scheduledAfter, null);
  const rows = collect({ devMode: false, rst: { pendingCount: 2, scheduledAfter: 't_1234567', stub: false } });
  assert.ok(!rows.some((r) => r.kind === 'restart-pending'), 'audit: no Restart pending bell row');
  assert.ok(pushed && pushed.pendingCount === 0 && !pushed.scheduledNow, "audit: the 'restart-state' push is zeroed too");
});

// Audit 3 — agents in a packaged build cannot schedule restarts or self-updates, and the tools
// are not advertised anywhere (board-tools.enabledTools, agent-config prompt).
test('packaged: schedule_restart/request_self_update refuse and are advertised nowhere', () => {
  const d = tmp('squad-pkg-');
  const { s, pm } = packagedSetup(d);
  assert.throws(() => makeTools(s, pm.id).schedule_restart({ now: true }), /unavailable in packaged build/, 'audit: schedule_restart refused');
  assert.equal(s.restartPending(), null, 'the refused call armed nothing');
  assert.throws(() => makeTools(s, pm.id).request_self_update({ reason: 'x' }), /unavailable in packaged build/, 'audit: request_self_update refused');
  const node = s.getTeam().nodes.find((n) => n.id === pm.id);
  const tools = enabledTools(node, false);
  assert.ok(!tools.includes('schedule_restart') && !tools.includes('request_self_update'), 'audit: not advertised in enabledTools');
  const p = buildPrompt(s.getTeam(), node, { id: 't1', title: 'T', comments: [] }, { devMode: false });
  assert.ok(!p.includes('schedule_restart') && !p.includes('request_self_update'), 'audit: prompt omits them (agent-config)');
});

// Audit 1 (Cato's challenge: the real leak was the hold, not the chip) — merges past the cap arm
// nothing, gate nothing, tell nobody, and todo tasks still dispatch.
test('packaged: merges past the restart cap hold no tasks and notify nobody', () => {
  const d = tmp('squad-pkg-');
  const { s, o, pm, a } = packagedSetup(d);
  s.saveSettings({ restartCap: 2 });
  const orig = MG.gateMerge;
  const root = tmp('squad-pkg-root-');
  try {
    MG.gateMerge = () => ({ merged: true, base: 'master', root, gate: { state: 'green', tests: 1, flaky: [] } });
    for (let i = 0; i < 3; i++) {
      s.updateTask(s.createTask({ title: 'm' + i, assignee: a.id, createdBy: 'human' }).id, { worktreePath: '/w' + i, worktreeBranch: 'squad/m' + i, status: 'done' });
    }
  } finally { MG.gateMerge = orig; }
  assert.equal(s.restartPending(), null, 'audit: landed merges count nothing');
  o.sweepRestart();
  assert.equal(o._restartGate, false, 'audit: the cap never arms the dispatch gate');
  assert.equal(s.listMessages({ to: pm.id }).length, 0, 'audit: no cap message (no schedule_restart hint without the tool)');
  const ran = [];
  o.runTask = async (node, task) => { ran.push(task.id); o.procs.set(node.id, { kill() {} }); };
  o.running = true;
  const t1 = s.createTask({ title: 'next', assignee: a.id, createdBy: 'human' });
  o.tick();
  assert.deepEqual(ran, [t1.id], 'audit: todos still dispatch after the cap');
});

// Audit 4 — the watch digest never offers agents a restart fact (or schedule_restart hint) that
// has no tool behind it.
test('packaged: the watch digest never mentions restarts', () => {
  const d = tmp('squad-pkg-');
  const { s, o } = packagedSetup(d);
  s.setRestartPending({ count: 5 });
  assert.ok(!o.watchDigest().includes('restart'), 'audit: no restart line in the packaged digest');
});

// Audit 3 at the surface agents actually call: the stdio MCP server spawned WITHOUT
// AGENTS_SQUAD_DEV (what a packaged build's agent gets) lists no restart tools, and calling one
// fails — mcp-scope.test.js pins the listing; this pins the refusal too.
test('packaged: live stdio MCP server lists no restart tools and refuses the call', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const d = tmp('squad-pkg-');
  const s = new Store(path.join(d, 'p'), null, { devMode: false });
  const pm = s.addNode({ name: 'PM', role: 'PM' });
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../src/mcp-server.js'), '--project', s.dir, '--node', pm.id],
    // The packaged marker is exactly what must be absent; keep module resolution intact.
    env: { ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), PATH: process.env.PATH || '' },
  }));
  try {
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('schedule_restart') && !names.includes('request_self_update'), 'audit: not listed to agents');
    const call = await c.callTool({ name: 'schedule_restart', arguments: { now: true } }).catch((e) => ({ isError: true, text: String(e.message || e) }));
    assert.ok(call.isError, 'audit: calling it fails on the packaged server');
    assert.equal(s.restartPending(), null, 'and nothing was armed');
  } finally { await c.close(); }
});
