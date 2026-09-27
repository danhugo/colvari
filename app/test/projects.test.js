const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager, TEMPLATES } = require('../src/projects');
const { Store } = require('../src/store');
const { makeTools } = require('../src/board-tools');

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'squad-root-'));

test('fresh root gets a Default project with one team', () => {
  const pm = new ProjectManager(root());
  const ps = pm.list();
  assert.equal(ps.length, 1);
  assert.equal(ps[0].name, 'Default');
  assert.equal(ps[0].teams.length, 1);
});

test('migrates legacy default dir into a "Default" project once', () => {
  const r = root();
  const legacy = new Store(path.join(r, 'default'));
  const a = legacy.addNode({ name: 'PM', role: 'PM' }); const b = legacy.addNode({ name: 'Dev' });
  legacy.addEdge(a.id, b.id);
  legacy.createTask({ title: 'old goal', assignee: a.id });
  legacy.writeWiki('Home', 'hi');
  legacy.saveSettings({ maxRuns: 7 });
  const pm = new ProjectManager(r);
  const ps = pm.list();
  assert.equal(ps.length, 1);
  assert.equal(ps[0].name, 'Default');
  const s = pm.store(ps[0].id);
  assert.equal(s.getTeam().nodes.length, 2);
  assert.equal(s.getTeam().edges.length, 1);
  assert.equal(s.listTasks()[0].title, 'old goal');
  assert.equal(s.readWiki('Home').content, 'hi');
  assert.equal(s.getSettings().maxRuns, 7);
  new ProjectManager(r); // idempotent
  assert.equal(pm.list().length, 1);
});

test('project create / rename / delete, isolated boards', () => {
  const pm = new ProjectManager(root());
  const p1 = pm.list()[0]; const p2 = pm.create('Second', 'startup');
  pm.store(p1.id).createTask({ title: 'in p1' });
  assert.equal(pm.store(p2.id).listTasks().length, 0);
  pm.rename(p2.id, 'Renamed');
  assert.equal(pm.get(p2.id).name, 'Renamed');
  pm.remove(p2.id);
  assert.equal(pm.list().length, 1);
  assert.throws(() => pm.remove(p1.id), /last project/);
  assert.throws(() => pm.store('../etc'), /bad project id/);
});

test('templates produce expected graphs', () => {
  const pm = new ProjectManager(root());
  const pid = pm.list()[0].id;
  for (const [k, n, e] of [['startup', 4, 3], ['solo', 1, 0], ['research', 4, 4]]) {
    const t = pm.createTeam(pid, k, k);
    const g = pm.store(pid, t.id).getTeam();
    assert.equal(g.nodes.length, n, k); assert.equal(g.edges.length, e, k);
  }
  const st = pm.get(pid).teams.find((t) => t.name === 'startup');
  const g = pm.store(pid, st.id).getTeam();
  const name = (id) => g.nodes.find((x) => x.id === id).name;
  assert.deepEqual(g.edges.map((x) => `${name(x.from)}>${name(x.to)}`), ['PM>Dev', 'Dev>Reviewer', 'PM>Critic']);
  assert.throws(() => pm.createTeam(pid, 'x', 'nope'), /unknown template/);
  assert.ok(TEMPLATES.startup.label);
});

test('multiple teams: per-team edits, merged view for orchestrator/MCP', () => {
  const pm = new ProjectManager(root());
  const pid = pm.list()[0].id;
  const t1 = pm.get(pid).teams[0].id; const t2 = pm.createTeam(pid, 'B', 'startup').id;
  const s1 = pm.store(pid, t1); const n = s1.addNode({ name: 'Solo', role: 'Dev' });
  assert.equal(s1.getTeam().nodes.length, 1);
  assert.equal(pm.store(pid, t2).getTeam().nodes.length, 4);
  const all = pm.store(pid).getTeam();
  assert.equal(all.nodes.length, 5);
  assert.equal(all.nodes.find((x) => x.id === n.id).teamId, t1);
  // MCP tools see the merged graph: PM in team B can assign to its Dev
  const g2 = pm.store(pid, t2).getTeam();
  const pmNode = g2.nodes.find((x) => x.role === 'PM'); const dev = g2.nodes.find((x) => x.role === 'Dev');
  const tools = makeTools(new Store(pm.dir(pid)), pmNode.id);
  assert.equal(tools.create_task({ title: 'x', assignee: dev.id }).assignee, dev.id);
  assert.throws(() => tools.create_task({ title: 'x', assignee: n.id }), /scope violation/);
  pm.renameTeam(pid, t2, 'Bee');
  assert.equal(pm.get(pid).teams[1].name, 'Bee');
  pm.removeTeam(pid, t2);
  assert.equal(pm.store(pid).getTeam().nodes.length, 1);
  assert.throws(() => pm.removeTeam(pid, t1), /last team/);
});

test('duplicate / export / import team with fresh ids', () => {
  const pm = new ProjectManager(root());
  const pid = pm.list()[0].id;
  const t = pm.createTeam(pid, 'Orig', 'research');
  const ex = pm.exportTeam(pid, t.id);
  assert.equal(ex.format, 'agents-squad-team'); assert.equal(ex.nodes.length, 4);
  const dup = pm.duplicateTeam(pid, t.id);
  assert.equal(dup.name, 'Orig copy');
  const a = pm.store(pid, t.id).getTeam(); const b = pm.store(pid, dup.id).getTeam();
  assert.equal(b.nodes.length, 4); assert.equal(b.edges.length, 4);
  assert.ok(b.nodes.every((n) => !a.nodes.some((m) => m.id === n.id)));
  const ids = new Set(b.nodes.map((n) => n.id));
  assert.ok(b.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
  const other = pm.create('Other');
  const imp = pm.importTeam(other.id, JSON.stringify(ex));
  assert.equal(imp.name, 'Orig');
  assert.equal(pm.store(other.id, imp.id).getTeam().nodes.length, 4);
  assert.throws(() => pm.importTeam(other.id, '{"x":1}'), /not an agents-squad/);
});
