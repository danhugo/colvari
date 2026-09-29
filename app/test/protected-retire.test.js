// Decision: protected-from-retirement. `protected` is a node property, separate from `core`:
// human-made nodes (no createdBy) are protected, recruits are not; only the human changes the flag
// (setNodeProtected IPC); every agent retire path refuses protected targets; update_agent is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');
const { canRetire, canManageAgent } = require('../src/scope');
const { normalizeNode } = require('../src/agent-config');
const { instantiate } = require('../src/projects');

// Core + one human-made node + one recruit, in team-a (same shape as dynamic-team.test.js).
function setup({ approval = 'auto' } = {}) {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-prot-')));
  s.write('project', { id: 'p', name: 'P', createdAt: new Date().toISOString(), teams: [{ id: 'a', name: 'A' }] });
  s.saveSettings({ teamChangeApproval: approval });
  const core = s.addNode({ name: 'Core', role: 'PM', core: true, x: 10, y: 20 });
  const human = s.addNode({ name: 'HumanMade', role: 'Reviewer' });
  const recruited = s.addNode({ name: 'Recruited', role: 'Dev', createdBy: core.id });
  s.addEdge(core.id, recruited.id);
  return { s, core, human, recruited, tools: makeTools(s, core.id) };
}

test('normalizeNode: absent flag derives from createdBy (human-made protected, recruits not); explicit wins', () => {
  assert.equal(normalizeNode({ name: 'A' }).protected, true, 'human-made default');
  assert.equal(normalizeNode({ name: 'A', createdBy: 'n1' }).protected, false, 'recruit default');
  assert.equal(normalizeNode({ name: 'A', protected: true, createdBy: 'n1' }).protected, true, 'explicit true on a recruit');
  assert.equal(normalizeNode({ name: 'A', protected: false }).protected, false, 'explicit false on a human-made node');
  assert.equal(normalizeNode({ name: 'A', protected: 'yes' }).protected, true, 'coerced to boolean');
});

test('instantiate (templates, imports, duplicates): nodes are human-made, so protected', () => {
  const g = instantiate({ nodes: [{ key: 'a', name: 'A', role: 'Dev' }, { key: 'b', name: 'B', role: 'QA' }], edges: [['a', 'b']] });
  assert.ok(g.nodes.every((n) => n.protected === true));
});

test('migration: nodes without createdBy get protected=true, recruits false, in every team file, marker written', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-prot-mig-'));
  fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({ id: 'p', teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }));
  fs.writeFileSync(path.join(d, 'team-a.json'), JSON.stringify({ nodes: [
    { id: 'n1', name: 'Human', role: 'Dev' },
    { id: 'n2', name: 'Rec', role: 'Dev', createdBy: 'n1', recruitedAt: '2026-01-01' },
    { id: 'n3', name: 'Kept', role: 'Dev', createdBy: '', protected: false }, // already-flagged human-made node is NOT flipped
  ], edges: [] }));
  fs.writeFileSync(path.join(d, 'team-b.json'), JSON.stringify({ nodes: [{ id: 'n4', name: 'Other', role: 'Dev' }], edges: [] }));
  const raw = (f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  new Store(d); // migration runs in the constructor
  const a = raw('team-a.json'), b = raw('team-b.json');
  assert.equal(a.nodes.find((n) => n.id === 'n1').protected, true, 'no createdBy -> protected');
  assert.equal(a.nodes.find((n) => n.id === 'n2').protected, false, 'recruit -> not protected');
  assert.equal(a.nodes.find((n) => n.id === 'n3').protected, false, 'explicit flag untouched');
  assert.equal(b.nodes.find((n) => n.id === 'n4').protected, true, 'second team file migrated too');
  assert.ok(fs.existsSync(path.join(d, '.nodes-protected')), 'marker written');
});

test('migration: legacy single-team stores (team.json, no project meta) are covered', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-prot-legacy-'));
  fs.writeFileSync(path.join(d, 'team.json'), JSON.stringify({ nodes: [{ id: 'n1', name: 'Solo', role: 'Dev' }], edges: [] }));
  new Store(d);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'team.json'), 'utf8')).nodes[0].protected, true);
});

test('protected persists to disk and setNodeProtected is the only writer', () => {
  const { s, human } = setup();
  assert.equal(s.getTeam().nodes.find((n) => n.id === human.id).protected, true);
  s.setNodeProtected(human.id, false);
  assert.equal(s.getTeam().nodes.find((n) => n.id === human.id).protected, false);
  assert.equal(JSON.parse(fs.readFileSync(s.file(s.teamFile()), 'utf8')).nodes.find((n) => n.id === human.id).protected, false, 'persisted');
  s.setNodeProtected(human.id, true);
  assert.equal(s.getTeam().nodes.find((n) => n.id === human.id).protected, true);
  assert.throws(() => s.updateNode(human.id, { protected: false }), /human-only.*setNodeProtected/, 'generic patch may not carry the key');
  assert.throws(() => s.setNodeProtected('ghost', false), /no node/);
});

test('canRetire (pure): manageable + not protected; cores and self stay refused', () => {
  const core = { id: 'c', core: true };
  assert.equal(canRetire(core, { id: 'r', core: false, createdBy: 'c' }), true, 'recruit retirable');
  assert.equal(canRetire(core, { id: 'r', core: false, createdBy: 'c', protected: true }), false, 'protected blocks');
  assert.equal(canRetire(core, { id: 'c', core: true }), false, 'never self');
  assert.equal(canRetire(core, { id: 'x', core: true }), false, 'never a core node');
  assert.equal(canRetire(null, { id: 'r' }), false);
  assert.equal(canManageAgent(core, { id: 'r', core: false, protected: true }), true, 'update scope unchanged');
});

test('retire_agent refuses a protected human-made teammate; update_agent still works on it', () => {
  const { s, human, tools } = setup();
  assert.throws(() => tools.retire_agent({ nodeId: human.id, reason: 'r' }), /protected from retirement/);
  assert.ok(s.getTeam().nodes.some((n) => n.id === human.id), 'node still there');
  // unprotect (human action) -> retire goes through
  s.setNodeProtected(human.id, false);
  assert.equal(tools.retire_agent({ nodeId: human.id, reason: 'r' }).retired, true);
  assert.equal(s.getTeam().nodes.some((n) => n.id === human.id), false);
});

test('retire_agent in ask mode refuses BEFORE filing an approval request', () => {
  const { s, human, tools } = setup({ approval: 'ask' });
  assert.throws(() => tools.retire_agent({ nodeId: human.id, reason: 'r' }), /protected/);
  assert.equal(s.listInbox().filter((i) => i.kind === 'question').length, 0, 'no ask filed for a protected target');
});

test('update_agent: protected target stays manageable, and the patch whitelist keeps `protected` unreachable', () => {
  const { s, human, tools } = setup();
  const n = tools.update_agent({ nodeId: human.id, patch: { role: 'QA' }, reason: 'adopt' });
  assert.equal(n.role, 'QA');
  assert.equal(s.getTeam().nodes.find((x) => x.id === human.id).protected, true, 'flag untouched by update_agent');
  assert.throws(() => tools.update_agent({ nodeId: human.id, patch: { protected: false }, reason: 'r' }), /not allowed.*protected/);
});

test('recruits default to protected=false and are retirable; recruited flag survives updates', () => {
  const { s, core, tools } = setup();
  const rec = tools.recruit_agent({ name: 'Rookie', role: 'Dev', reason: 'r' });
  assert.equal(rec.protected, false, 'recruit unprotected');
  assert.equal(tools.retire_agent({ nodeId: rec.id, reason: 'r' }).retired, true, 'recruit retirable');
  const rec2 = tools.recruit_agent({ name: 'Keeper', role: 'Dev', reason: 'r' });
  s.updateNode(rec2.id, { role: 'QA' });
  assert.equal(s.getTeam().nodes.find((x) => x.id === rec2.id).protected, false, 'role update does not touch the flag');
  assert.equal(core.protected, true, 'the core itself is protected (human-made)');
});

test('gui-e2e style seed: recruiting via addNode + updateNode(createdBy) keeps the derived flags sane', () => {
  const { s, core } = setup();
  const ra = s.addNode({ name: 'RA', role: 'Dev' });
  assert.equal(ra.protected, true, 'created human-made');
  s.updateNode(ra.id, { createdBy: core.id }); // gui-e2e seeds a recruited chip this way; the flag stays as stored
  const stored = s.getTeam().nodes.find((n) => n.id === ra.id);
  assert.equal(stored.protected, true, 'updateNode without the key never rewrites the flag');
  s.setNodeProtected(ra.id, false);
  assert.equal(s.getTeam().nodes.find((n) => n.id === ra.id).createdBy, core.id);
});
