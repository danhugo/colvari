// Multi-project / multi-team management.
// Layout: <root>/projects/<projectId>/{project.json, team-<teamId>.json, messages.json, settings.json,
//          .squad/board/tasks/<taskId>.json, .squad/wiki/<slug>.md}
// project.json: { id, name, createdAt, teams: [{ id, name }] }
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Store } = require('./store');
const { normalizeNode, NODE_FIELDS, EDGE_TYPES } = require('./agent-config');

const rid = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;
const DATA_FILES = ['team', 'board', 'wiki', 'settings', 'messages'];

function defaultRoot() { return process.env.AGENTS_SQUAD_HOME || process.env.AGENTS_SQUAD_PROJECT || path.join(os.homedir(), '.agents-squad'); }

// Data root for test instances (gui-e2e / smoke, called from main.js before any store opens).
// AGENTS_SQUAD_HOME is the live app's root and leaks in from ambient shells, so in test mode an
// explicit AGENTS_SQUAD_PROJECT wins over it; with neither set a throwaway temp root is created
// instead of falling through to the real ~/.agents-squad. The dir is pre-created because some
// drivers assume an existing AGENTS_SQUAD_PROJECT.
function isolateTestRoot(env = process.env, tmp = os.tmpdir()) {
  if (env.AGENTS_SQUAD_PROJECT) return env.AGENTS_SQUAD_PROJECT;
  delete env.AGENTS_SQUAD_HOME;
  const root = fs.mkdtempSync(path.join(tmp, 'agents-squad-e2e-'));
  env.AGENTS_SQUAD_PROJECT = root;
  return root;
}

// Team templates: nodes are given by key, edges reference keys.
const TEMPLATES = {
  blank: { label: 'Blank', nodes: [], edges: [] },
  startup: {
    label: 'Startup (PM -> Critic, Dev -> Reviewer)',
    nodes: [
      { key: 'pm', name: 'PM', role: 'PM', x: 60, y: 80 },
      { key: 'dev', name: 'Dev', role: 'Dev', x: 280, y: 80 },
      { key: 'rev', name: 'Reviewer', role: 'Reviewer', x: 500, y: 80 },
      { key: 'crit', name: 'Critic', role: 'Critic', x: 280, y: 220 },
    ],
    edges: [['pm', 'dev'], ['dev', 'rev'], ['pm', 'crit']],
  },
  solo: { label: 'Solo (one Dev)', nodes: [{ key: 'dev', name: 'Solo Dev', role: 'Dev', x: 60, y: 80, systemPrompt: 'You work alone: plan, implement and verify the task yourself.' }], edges: [] },
  research: {
    label: 'Research (Planner -> 2 researchers -> QA)',
    nodes: [
      { key: 'lead', name: 'Lead', role: 'Planner', x: 60, y: 140 },
      { key: 'r1', name: 'Researcher A', role: 'Dev', x: 280, y: 60, systemPrompt: 'Research the assigned question. Write findings to the wiki.' },
      { key: 'r2', name: 'Researcher B', role: 'Dev', x: 280, y: 220, systemPrompt: 'Research the assigned question. Write findings to the wiki.' },
      { key: 'qa', name: 'Fact checker', role: 'QA', x: 500, y: 140, systemPrompt: 'Check wiki findings for accuracy and gaps. Comment on the task.' },
    ],
    edges: [['lead', 'r1'], ['lead', 'r2'], ['r1', 'qa'], ['r2', 'qa']],
  },
};

// Build a graph with fresh ids from { nodes: [{key|id,...}], edges: [[a,b]] | [{from,to}] }.
function instantiate(spec) {
  const map = {};
  const nodes = (spec.nodes || []).map((n, i) => {
    const nid = rid('n'); map[n.key || n.id] = nid;
    return { id: nid, ...normalizeNode(n), x: n.x ?? 60 + i * 200, y: n.y ?? 80 };
  });
  const edges = [];
  for (const e of spec.edges || []) {
    const [a, b, type = 'assign'] = Array.isArray(e) ? e : [e.from, e.to, e.type];
    if (map[a] && map[b] && map[a] !== map[b] && EDGE_TYPES.includes(type)) edges.push({ id: rid('e'), from: map[a], to: map[b], type });
  }
  return { nodes, edges };
}

class ProjectManager {
  constructor(root = defaultRoot()) {
    this.root = root;
    this.pdir = path.join(root, 'projects');
    this._stores = new Map(); // (dir|teamId) -> Store — hot path reuse, see store()
    fs.mkdirSync(this.pdir, { recursive: true });
    this.migrate();
    if (!this.list().length) this.create('Default', 'blank');
  }
  dir(pid) { if (!/^[\w-]+$/.test(pid || '')) throw new Error('bad project id'); return path.join(this.pdir, pid); }
  // One Store instance per (project dir, teamId), reused across calls (t_8d586961): the renderer's
  // getAll builds ST(c)/TS(c) several times a second while agents stream, and every fresh Store
  // paid cold construction migrations plus — with the task-file cache — a full re-read + re-parse
  // of every board task file (~110ms of getAll on the 550-task board). Store is disk-backed and
  // its locks are file-based, so sharing one instance across call sites changes no semantics;
  // out-of-band writes are still seen (reads hit the disk every call). Entries live as long as
  // the project; remove() drops them with the directory.
  store(pid, teamId = null) {
    const d = this.dir(pid);
    if (!fs.existsSync(path.join(d, 'project.json'))) throw new Error('no project ' + pid);
    const key = d + '|' + (teamId || '');
    let s = this._stores.get(key);
    if (!s) this._stores.set(key, (s = new Store(d, teamId)));
    return s;
  }
  get(pid) { return this.store(pid).meta(); }
  list() {
    return fs.readdirSync(this.pdir).map((d) => { try { return JSON.parse(fs.readFileSync(path.join(this.pdir, d, 'project.json'), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  saveMeta(pid, fn) { const s = this.store(pid); return s.update('project', null, (m) => { fn(m); return m; }); }

  // Copy legacy <root>/default (single project) into a project named "Default", once.
  migrate() {
    const legacy = path.join(this.root, 'default');
    const marker = path.join(legacy, '.migrated');
    if (!fs.existsSync(legacy) || fs.existsSync(marker)) return null;
    if (!DATA_FILES.some((f) => fs.existsSync(path.join(legacy, f + '.json')))) return null;
    const pid = rid('p'); const teamId = rid('team');
    const d = path.join(this.pdir, pid); fs.mkdirSync(d, { recursive: true });
    for (const f of DATA_FILES) {
      const src = path.join(legacy, f + '.json'); if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(d, (f === 'team' ? 'team-' + teamId : f) + '.json'));
    }
    // Legacy dirs written by the per-file store keep board/wiki under .squad/ — copy that tree too.
    const sq = path.join(legacy, '.squad');
    if (fs.existsSync(sq)) fs.cpSync(sq, path.join(d, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({ id: pid, name: 'Default', createdAt: new Date(0).toISOString(), migratedFrom: legacy, teams: [{ id: teamId, name: 'Main' }] }, null, 2));
    fs.writeFileSync(marker, pid);
    return pid;
  }

  create(name, template = 'blank') {
    const pid = rid('p'); const d = path.join(this.pdir, pid); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({ id: pid, name: name || 'Project', createdAt: new Date().toISOString(), teams: [] }, null, 2));
    this.createTeam(pid, 'Main', template);
    return this.get(pid);
  }
  rename(pid, name) { if (!name) throw new Error('name required'); return this.saveMeta(pid, (m) => { m.name = name; }); }
  remove(pid) {
    if (this.list().length <= 1) throw new Error('cannot delete the last project');
    fs.rmSync(this.dir(pid), { recursive: true, force: true });
    for (const k of [...this._stores.keys()]) if (k.startsWith(this.dir(pid) + '|')) this._stores.delete(k);
  }

  // ---- teams ----
  createTeam(pid, name, template = 'blank', graph = null) {
    const tpl = TEMPLATES[template]; if (!graph && !tpl) throw new Error('unknown template ' + template);
    const teamId = rid('team');
    const s = this.store(pid, teamId);
    s.write('team-' + teamId, graph || instantiate(tpl));
    this.saveMeta(pid, (m) => { m.teams.push({ id: teamId, name: name || 'Team' }); });
    return { id: teamId, name: name || 'Team' };
  }
  renameTeam(pid, teamId, name) {
    if (!name) throw new Error('name required');
    return this.saveMeta(pid, (m) => { const t = m.teams.find((x) => x.id === teamId); if (!t) throw new Error('no team'); t.name = name; });
  }
  removeTeam(pid, teamId) {
    const m = this.get(pid);
    if (!m.teams.find((t) => t.id === teamId)) throw new Error('no team');
    if (m.teams.length <= 1) throw new Error('cannot delete the last team');
    this.saveMeta(pid, (mm) => { mm.teams = mm.teams.filter((t) => t.id !== teamId); });
    try { fs.unlinkSync(path.join(this.dir(pid), 'team-' + teamId + '.json')); } catch {}
  }
  exportTeam(pid, teamId) {
    const t = this.get(pid).teams.find((x) => x.id === teamId); if (!t) throw new Error('no team');
    const g = this.store(pid, teamId).getTeam();
    return { format: 'agents-squad-team', version: 1, name: t.name,
      nodes: g.nodes.map((n) => ({ id: n.id, ...Object.fromEntries(NODE_FIELDS.map((k) => [k, n[k]])), x: n.x, y: n.y })),
      edges: g.edges.map(({ from, to, type }) => ({ from, to, type: type || 'assign' })) };
  }
  importTeam(pid, data, name) {
    if (typeof data === 'string') data = JSON.parse(data);
    if (!data || data.format !== 'agents-squad-team' || !Array.isArray(data.nodes)) throw new Error('not an agents-squad team export');
    return this.createTeam(pid, name || data.name || 'Imported team', null, instantiate(data));
  }
  duplicateTeam(pid, teamId, name) {
    const ex = this.exportTeam(pid, teamId);
    return this.importTeam(pid, ex, name || ex.name + ' copy');
  }
}

module.exports = { ProjectManager, TEMPLATES, instantiate, defaultRoot, isolateTestRoot };
