const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { capPermissionMode, canManageAgent } = require('../src/scope');

// Core + one human-made node + one node already recruited by the core, in team-a of a 1- or 2-team
// project. Tools are built from the ROOT store (no teamId) exactly like the MCP server does, so the
// tests also prove the per-call re-scoping to the core's own team file.
function setup({ teams = 1, approval = 'auto', maxAgents = 6 } = {}) {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dt-')));
  s.write('project', { id: 'p', name: 'P', createdAt: new Date().toISOString(), teams: [{ id: 'a', name: 'A' }, ...(teams > 1 ? [{ id: 'b', name: 'B' }] : [])] });
  s.saveSettings({ teamChangeApproval: approval, maxAgents });
  const core = s.addNode({ name: 'Core', role: 'PM', core: true, x: 10, y: 20 });
  const human = s.addNode({ name: 'HumanMade', role: 'Reviewer' });
  const recruited = s.addNode({ name: 'Recruited', role: 'Dev', createdBy: core.id });
  s.addEdge(core.id, recruited.id); // every recruit carries this edge (see recruit_agent)
  if (teams > 1) s.forTeam('b').addNode({ name: 'Outsider', role: 'Dev', createdBy: core.id });
  return { s, core, human, recruited, tools: makeTools(s, core.id) };
}

test('non-core refused by all three team tools; guard is re-checked at call time', () => {
  const { s, human, recruited } = setup();
  const t = makeTools(s, human.id);
  assert.throws(() => t.recruit_agent({ name: 'X', role: 'Dev', reason: 'r' }), /core-agent only/);
  assert.throws(() => t.retire_agent({ nodeId: recruited.id, reason: 'r' }), /core-agent only/);
  assert.throws(() => t.update_agent({ nodeId: recruited.id, patch: { role: 'QA' }, reason: 'r' }), /core-agent only/);
  // the human flips the flag after the tools object was created: next call sees it (no registration gate here)
  s.updateNode(human.id, { core: true });
  assert.equal(t.recruit_agent({ name: 'ByNewCore', role: 'Dev', reason: 'r' }).createdBy, human.id);
  assert.throws(() => makeTools(s, 'ghost').recruit_agent({ name: 'X', role: 'Dev', reason: 'r' }), /unknown caller/);
});

test('core cannot touch self, another core, a human-made node, or another team', () => {
  const { s, core, human, tools } = setup({ teams: 2 });
  const otherCore = s.addNode({ name: 'Core2', role: 'PM', core: true });
  assert.throws(() => tools.retire_agent({ nodeId: core.id, reason: 'r' }), /cannot manage itself/);
  assert.throws(() => tools.update_agent({ nodeId: core.id, patch: { role: 'QA' }, reason: 'r' }), /cannot manage itself/);
  assert.throws(() => tools.retire_agent({ nodeId: otherCore.id, reason: 'r' }), /core node can never/);
  assert.throws(() => tools.retire_agent({ nodeId: human.id, reason: 'r' }), /not recruited/);
  assert.throws(() => tools.update_agent({ nodeId: human.id, patch: { role: 'QA' }, reason: 'r' }), /not recruited/);
  const outsider = s.forTeam('b').getTeam().nodes.find((n) => n.name === 'Outsider');
  assert.throws(() => tools.retire_agent({ nodeId: outsider.id, reason: 'r' }), /unknown agent/);
  assert.throws(() => tools.update_agent({ nodeId: outsider.id, patch: { role: 'QA' }, reason: 'r' }), /unknown agent/);
});

test('recruit: node built from allowed fields only, protected fields set server-side, right team file, edges, position', () => {
  const { s, core, tools } = setup({ teams: 2 });
  const n = tools.recruit_agent({ name: 'Rookie', role: 'QA', prompt: 'be careful', runtime: 'codex', model: 'gpt-5', reason: 'need a tester' });
  assert.equal(n.core, false);
  assert.equal(n.createdBy, core.id);
  assert.ok(n.recruitedAt);
  assert.equal(n.systemPrompt, 'be careful');
  assert.equal(n.runtime, 'codex');
  assert.equal(n.x, core.x + 220);
  assert.equal(n.y, core.y + 120 * 2); // one recruit already exists in setup
  const a = s.forTeam('a').getTeam();
  assert.ok(a.nodes.some((x) => x.id === n.id), 'recruit lands in the core team file');
  assert.equal(s.forTeam('b').getTeam().nodes.some((x) => x.id === n.id), false, 'other team file untouched');
  assert.ok(a.edges.some((e) => e.from === core.id && e.to === n.id && (e.type || 'assign') === 'assign'), 'core -> recruit assign edge');
  assert.ok(a.edges.some((e) => e.from === n.id && e.to === core.id && e.type === 'message'), 'recruit -> core message edge');
  // core/createdBy are never taken from the caller: passing them changes nothing
  const n2 = tools.recruit_agent({ name: 'Sneaky', role: 'Dev', core: true, createdBy: 'someone-else', reason: 'r' });
  assert.equal(n2.core, false);
  assert.equal(n2.createdBy, core.id);
});

test('list_team adds core and createdBy', () => {
  const { core, recruited, tools } = setup();
  const t = tools.list_team();
  assert.equal(t.self.core, true);
  const r = t.canAssignTo.find((x) => x.id === recruited.id);
  assert.equal(r.createdBy, core.id);
  assert.equal(r.core, false);
});

test('maxAgents: default 6, recruits refused at the limit, settings validated', () => {
  const { s, tools } = setup();
  // project defaults, independent of what setup saved
  const fresh = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dt-')));
  assert.equal(fresh.getSettings().maxAgents, 6);
  assert.equal(fresh.getSettings().teamChangeApproval, 'ask');
  for (let i = 0; i < 3; i++) tools.recruit_agent({ name: 'R' + i, role: 'Dev', reason: 'r' }); // 3 + 3 = 6
  assert.throws(() => tools.recruit_agent({ name: 'One', role: 'Dev', reason: 'r' }), /maxAgents 6/);
  s.saveSettings({ maxAgents: 3 });
  assert.throws(() => tools.recruit_agent({ name: 'Two', role: 'Dev', reason: 'r' }), /maxAgents 3/);
  s.saveSettings({ maxAgents: 7 });
  assert.ok(tools.recruit_agent({ name: 'Two', role: 'Dev', reason: 'r' }).id);
  assert.throws(() => s.saveSettings({ maxAgents: 0 }), /integer >= 1/);
  assert.throws(() => s.saveSettings({ maxAgents: 2.5 }), /integer >= 1/);
  assert.throws(() => s.saveSettings({ teamChangeApproval: 'later' }), /"ask" or "auto"/);
});

test('unknown runtime refused (runtimes.js is the registry); model stays free text', () => {
  const { recruited, tools } = setup();
  assert.throws(() => tools.recruit_agent({ name: 'X', role: 'Dev', runtime: 'nope', reason: 'r' }), /unknown runtime/);
  assert.throws(() => tools.update_agent({ nodeId: recruited.id, patch: { runtime: 'nope' }, reason: 'r' }), /unknown runtime/);
  assert.equal(tools.recruit_agent({ name: 'Y', role: 'Dev', runtime: 'codex', model: 'whatever-model', reason: 'r' }).model, 'whatever-model');
});

test('update patch whitelist: core:true / disabledBoardTools rejected; allowed fields applied', () => {
  const { s, recruited, tools } = setup();
  assert.throws(() => tools.update_agent({ nodeId: recruited.id, patch: { core: true }, reason: 'r' }), /not allowed.*core/);
  assert.throws(() => tools.update_agent({ nodeId: recruited.id, patch: { disabledBoardTools: ['ask_human'] }, reason: 'r' }), /not allowed.*disabledBoardTools/);
  assert.throws(() => tools.update_agent({ nodeId: recruited.id, patch: { createdBy: 'x' }, reason: 'r' }), /not allowed/);
  assert.throws(() => tools.update_agent({ nodeId: recruited.id, patch: {}, reason: 'r' }), /patch object required/);
  const n = tools.update_agent({ nodeId: recruited.id, patch: { role: 'QA', prompt: 'new prompt', effort: 'high' }, reason: 'r' });
  assert.equal(n.role, 'QA');
  assert.equal(n.systemPrompt, 'new prompt');
  assert.equal(n.effort, 'high');
  assert.equal(s.forTeam('a').getTeam().nodes.find((x) => x.id === recruited.id).core, false);
});

test('retire: refused while an in_progress task remains; todo tasks reassigned to core BEFORE removal', () => {
  const { s, core, recruited, tools } = setup();
  const active = s.createTask({ title: 'active', assignee: recruited.id });
  s.updateTask(active.id, { status: 'in_progress' });
  assert.throws(() => tools.retire_agent({ nodeId: recruited.id, reason: 'r' }), /in_progress/);
  const todo = s.createTask({ title: 'todo', assignee: recruited.id });
  const done = s.createTask({ title: 'done', assignee: recruited.id });
  s.updateTask(done.id, { status: 'done' });
  s.updateTask(active.id, { status: 'todo' });
  assert.deepEqual(tools.retire_agent({ nodeId: recruited.id, reason: 'r' }), { retired: true, nodeId: recruited.id });
  assert.equal(s.getTask(active.id).assignee, core.id);
  assert.equal(s.getTask(todo.id).assignee, core.id);
  assert.equal(s.getTask(done.id).assignee, recruited.id, 'finished tasks keep their history');
  const a = s.forTeam('a').getTeam();
  assert.equal(a.nodes.some((n) => n.id === recruited.id), false);
  assert.equal(a.edges.some((e) => e.from === recruited.id || e.to === recruited.id), false);
});

test('recruit permission mode is capped at the core\'s (never more permissive)', () => {
  const { s, core, tools } = setup();
  s.updateNode(core.id, { permissionMode: 'default' }); // project default stays bypassPermissions
  const n = tools.recruit_agent({ name: 'B', role: 'Dev', reason: 'r' }); // would inherit bypassPermissions
  assert.equal(n.permissionMode, 'default');
  assert.ok(s.readLogs(50).some((l) => l.kind === 'team.change' && l.text.includes('recruited')), 'timeline entry logged');
});

test('ask mode (default): returns pending at once, waiting_for_human, nothing changes until approved', () => {
  const { s, core, tools } = setup({ approval: 'ask' });
  const task = s.createTask({ title: 'core work', assignee: core.id });
  s.updateTask(task.id, { status: 'in_progress' });
  const before = s.forTeam('a').getTeam().nodes.length;
  const req = { name: 'Rookie', role: 'QA', reason: 'need a tester' };
  const t0 = Date.now();
  const r1 = tools.recruit_agent({ ...req }); // must NOT block on the human
  assert.ok(Date.now() - t0 < 5000, 'returns immediately');
  assert.equal(r1.pending, true);
  assert.equal(s.forTeam('a').getTeam().nodes.length, before, 'nothing applied yet');
  assert.equal(s.getTask(task.id).status, 'waiting_for_human');
  const item = s.listInbox({ status: 'open' }).find((i) => i.kind === 'question');
  assert.ok(item, 'request filed in the human inbox');
  assert.deepEqual(item.choices, ['approve']);
  assert.equal(tools.recruit_agent({ ...req }).pending, true, 're-call while still open stays pending');
  assert.equal(s.listInbox().filter((i) => i.status === 'open' && i.kind === 'question').length, 1, 'no duplicate ask');
  s.answerInbox(item.id, 'approve');
  assert.equal(s.getTask(task.id).status, 'in_progress', 'un-parked by the answer');
  const r2 = tools.recruit_agent({ ...req }); // re-call after approval applies it
  assert.equal(r2.name, 'Rookie');
  assert.equal(s.forTeam('a').getTeam().nodes.length, before + 1);
  assert.ok(s.getTask(task.id).comments.some((c) => c.text.includes('recruited')), 'comment on the core\'s current task');
});

test('ask mode: a declined request changes nothing and is announced', () => {
  const { s, core, tools } = setup({ approval: 'ask' });
  const task = s.createTask({ title: 'core work', assignee: core.id });
  s.updateTask(task.id, { status: 'in_progress' });
  const req = { name: 'Nope', role: 'Dev', reason: 'r' };
  tools.recruit_agent(req);
  s.answerInbox(s.listInbox({ status: 'open' })[0].id, 'no');
  const r = tools.recruit_agent(req);
  assert.equal(r.applied, false);
  assert.ok(/declined/.test(r.note));
  assert.equal(s.forTeam('a').getTeam().nodes.length, 3);
  assert.ok(s.readLogs(50).some((l) => l.kind === 'team.change' && l.text.includes('declined')));
});

test('ask mode: maxAgents is re-checked after the human approves', () => {
  const { s, core, tools } = setup({ approval: 'ask', maxAgents: 4 });
  s.createTask({ title: 'core work', assignee: core.id });
  const req = { name: 'Late', role: 'Dev', reason: 'r' };
  assert.equal(tools.recruit_agent(req).pending, true); // 3 < 4 at ask time
  s.addNode({ name: 'Filler', role: 'Dev' }); // team grows to 4 while the request is pending
  s.answerInbox(s.listInbox({ status: 'open' })[0].id, 'approve');
  assert.throws(() => tools.recruit_agent(req), /maxAgents 4/);
  assert.equal(s.forTeam('a').getTeam().nodes.length, 4, 'still nothing applied');
});

test('auto mode: change applied immediately, no inbox item', () => {
  const { s, tools } = setup({ approval: 'auto' });
  const n = tools.recruit_agent({ name: 'Auto', role: 'Dev', reason: 'r' });
  assert.equal(n.name, 'Auto');
  assert.equal(s.listInbox().length, 0);
  const out = tools.retire_agent({ nodeId: n.id, reason: 'r' });
  assert.equal(out.retired, true);
});

test('scope helpers: capPermissionMode and canManageAgent (pure)', () => {
  assert.equal(capPermissionMode('default', 'bypassPermissions'), 'default');
  assert.equal(capPermissionMode('bypassPermissions', 'default'), 'default');
  assert.equal(capPermissionMode('plan', 'acceptEdits'), 'plan');
  assert.equal(capPermissionMode('acceptEdits', 'default'), 'default');
  const core = { id: 'c', core: true };
  assert.equal(canManageAgent(core, { id: 'r', core: false, createdBy: 'c' }), true);
  assert.equal(canManageAgent(core, { id: 'c', core: true, createdBy: 'c' }), false, 'never self');
  assert.equal(canManageAgent(core, { id: 'x', core: true, createdBy: 'c' }), false, 'never a core node');
  assert.equal(canManageAgent(core, { id: 'x', core: false, createdBy: '' }), false, 'never a human-made node');
  assert.equal(canManageAgent(null, { id: 'r', createdBy: 'c' }), false);
});

test('real stdio MCP server lists the team tools only for a core node', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const { s, core, human } = setup();
  const connect = async (node) => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../src/mcp-server.js'), '--project', s.dir, '--node', node] }));
    return c;
  };
  const ch = await connect(human.id);
  const names = (await ch.listTools()).tools.map((t) => t.name);
  assert.equal(names.includes('recruit_agent'), false, 'non-core: not registered at startup');
  await ch.close();
  const cc = await connect(core.id);
  const names2 = (await cc.listTools()).tools.map((t) => t.name);
  for (const n of ['recruit_agent', 'retire_agent', 'update_agent']) assert.ok(names2.includes(n), n + ' registered for the core');
  await cc.close();
});
