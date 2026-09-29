// JSON-file store shared by the Electron main process and MCP server processes.
// Layout: <dir>/team.json, messages.json, inbox.json, runs.json, settings.json, plus a readable
// board/wiki tree agents can cat/grep/jq: <dir>/.squad/board/tasks/<id>.json (one pretty-JSON file
// per task — the file IS the record) and <dir>/.squad/wiki/<slug>.md (one markdown file per page;
// title/slug/author/sha live in the hidden .pages.json index, only content in the .md).
// Private stores (messages, inbox, runs, settings, teams) deliberately stay OUTSIDE .squad/ so
// direct reads of the board tree never expose DMs.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const C = require('./controls');
const TL = require('./timeline');
const PRESET_FIELDS = ['systemPrompt', 'allowedTools', 'disallowedTools', 'permissionMode'];
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const { normalizeNode, normalizePatch, normalizePreset, applyPreset, EDGE_TYPES, SUGGESTED_ROLES } = require('./agent-config');
const WT = require('./worktree');

const ROLES = SUGGESTED_ROLES; // suggestions only: roles are free text
const STATUSES = ['todo', 'in_progress', 'review', 'done', 'waiting_for_human', 'merge_conflict'];

// Version-map keys whose getAll section changed since the client's last fetch (all keys when `since`
// is null = first load / project switch). Pure so the delta contract is testable without Electron.
function pickChanged(v, since) {
  if (!since) return Object.keys(v);
  return Object.keys(v).filter((k) => since[k] !== v[k]);
}

function defaultProjectDir(name = 'default') {
  return path.join(os.homedir(), '.agents-squad', name);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const id = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;

// Chat attachments: the renderer uploads bytes once, the file lands under <dir>/attachments/ and
// only its {path,name,mime,size} travels through messages/tasks — never the bytes (no base64).
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_FIELDS = ['path', 'name', 'mime', 'size'];
// Basename + safe-char filter so a hostile name ("../../x", "a/b") can never escape attachments/.
function cleanAttachmentName(name) {
  const safe = path.basename(String(name || '')).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 128);
  return safe || 'file';
}
function sanitizeAttachments(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = list.filter((a) => a && a.path).map((a) => pick({ path: String(a.path), name: String(a.name || ''), mime: String(a.mime || ''), size: Number(a.size) || 0 }, ATTACHMENT_FIELDS));
  return out.length ? out : null;
}

class Store {
  // teamId: which team graph this store edits. Without it, getTeam() returns the union of all
  // teams in the project (used by the orchestrator and MCP server: node ids are globally unique).
  constructor(dir, teamId = null) {
    this.dir = dir;
    this.teamId = teamId;
    fs.mkdirSync(dir, { recursive: true });
    this.migrateUsageLedger();
    this.migrateNodeProtection();
  }
  // Per-key usage ledger (t_3318ff63): runs recorded before the ledger existed carry flat totals
  // that mix models — they cannot be split retroactively, so they are dropped (migrate by reset)
  // and the project notes when per-key tracking started (project.usageTrackingSince, surfaced as
  // "tracking since" in the UI). Guarded by a marker file: pm.store() constructs a Store per call,
  // so the runs.json scan may run only once per project. Never throws on old/corrupt files.
  migrateUsageLedger() {
    const marker = path.join(this.dir, '.usage-ledger');
    try {
      if (fs.existsSync(marker)) return;
      this.withLock(() => {
        const d = this.read('runs', { runs: [] });
        if ((d.runs || []).some((r) => !r || !Array.isArray(r.ledger))) {
          d.runs = [];
          this.write('runs', d);
          const m = this.read('project', null);
          if (m && !m.usageTrackingSince) { m.usageTrackingSince = new Date().toISOString(); this.write('project', m); }
        }
      });
      fs.writeFileSync(marker, '');
    } catch {}
  }
  // Decision: protected-from-retirement. Nodes stored before `protected` existed carry no flag:
  // every node WITHOUT createdBy (human-made, never recruited) gets protected=true, recruits
  // (createdBy set) get protected=false — matched on field absence, never on names, in every team
  // file of the project (the legacy single 'team' file included). Marker-guarded like the ledger
  // migration: pm.store() constructs a Store per call. Never throws on old/corrupt files.
  migrateNodeProtection() {
    const marker = path.join(this.dir, '.nodes-protected');
    try {
      if (fs.existsSync(marker)) return;
      this.withLock(() => {
        const files = new Set(this.teamIds().map((tid) => 'team-' + tid));
        files.add('team'); // pre-multi-team stores (teamFile() fallback)
        for (const name of files) {
          const t = this.read(name, null);
          if (!t || !Array.isArray(t.nodes)) continue;
          let changed = false;
          for (const n of t.nodes) if (n && n.protected === undefined) { n.protected = !n.createdBy; changed = true; }
          if (changed) this.write(name, t);
        }
      });
      fs.writeFileSync(marker, new Date().toISOString());
    } catch {}
  }
  forTeam(teamId) { return new Store(this.dir, teamId); }
  meta() { return this.read('project', null); }
  teamFile() {
    if (this.teamId) return 'team-' + this.teamId;
    const m = this.meta();
    return m && m.teams && m.teams[0] ? 'team-' + m.teams[0].id : 'team';
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  logFile() { return path.join(this.dir, 'logs.jsonl'); }
  // Cheap change fingerprint for change-driven refreshes: 'size:mtimeMs' (or '' when absent).
  // 'board' and 'wiki' are directories in the per-file layout; their sig is every file's stat.
  sigFile(name) {
    if (name === 'board' || name === 'wiki') return this._sectionSig(name);
    try { const st = fs.statSync(this.file(name)); return st.size + ':' + st.mtimeMs; } catch { return ''; }
  }
  _sectionSig(name) {
    const dir = name === 'board' ? this.tasksDir() : this.wikiDir();
    let ents;
    try { ents = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort(); } catch { return ''; }
    let sig = '';
    for (const f of ents) { try { const st = fs.statSync(path.join(dir, f)); sig += '|' + f + ':' + st.size + ':' + st.mtimeMs; } catch {} }
    return sig;
  }
  logsSig() { try { const st = fs.statSync(this.logFile()); return st.size + ':' + st.mtimeMs; } catch { return ''; } }
  // Signature of every team file in the project (+ project.json, which lists them) — covers the
  // union-of-teams "allNodes" view. Not a substitute for a per-team sig (that's sigFile(teamFile())).
  teamsSig() {
    let sig = this.sigFile('project');
    const m = this.meta();
    for (const t of (m && m.teams) || []) sig += '|' + this.sigFile('team-' + t.id);
    return sig;
  }
  // One stats pass over everything the renderer's getAll is built from; the renderer polls this
  // instead of re-fetching whole files, then asks only for sections whose sig changed.
  versions() {
    return { project: this.sigFile('project'), board: this.sigFile('board'), wiki: this.sigFile('wiki'), settings: this.sigFile('settings'), messages: this.sigFile('messages'), runs: this.sigFile('runs'), inbox: this.sigFile('inbox'), logs: this.logsSig(), teams: this.teamsSig() };
  }
  read(name, dflt) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return dflt; }
  }
  write(name, data) {
    const tmp = this.file(name) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file(name));
  }
  // cross-process mutex (mkdir is atomic)
  withLock(fn) {
    const lock = path.join(this.dir, '.lock');
    const start = Date.now();
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (Date.now() - start > 5000) { try { fs.rmdirSync(lock); } catch {} continue; } // stale
        sleepSync(10);
      }
    }
    try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
  }
  update(name, dflt, fn) {
    return this.withLock(() => { const d = this.read(name, dflt); const r = fn(d); this.write(name, d); return r; });
  }

  // ---- scheduled restarts (plan t_42f310cf item 1) ----
  // Merges only bump the pending counter; a restart happens solely through an armed schedule
  // (schedule_restart tool, human pill, or the cap). The state lives in project.json so it
  // survives relaunches and is writable from every process that holds the store.
  restartPending() { return (this.meta() || {}).restartPending || null; }
  // withLock + explicit read/write (not update('project', null, fn)): a fresh project has no
  // project.json yet, and update() writes the object it read — a null dflt would clobber the file.
  setRestartPending(patch) {
    return this.withLock(() => {
      const m = this.read('project', null) || {};
      m.restartPending = { ...(m.restartPending || { count: 0 }), ...patch };
      this.write('project', m);
      return m.restartPending;
    });
  }
  // One more landed merge waits for the next restart. `since` anchors the first change that the
  // running process has not picked up yet.
  bumpRestartPending() {
    return this.withLock(() => {
      const m = this.read('project', null) || {};
      const rp = m.restartPending || {};
      m.restartPending = { ...rp, count: (Number(rp.count) || 0) + 1, since: rp.since || new Date().toISOString() };
      this.write('project', m);
      return m.restartPending;
    });
  }
  // Consumed by the orchestrator AFTER the relaunch (a fired marker proves the new process booted):
  // clearing before the restart would lose the schedule if the relaunch crashed; never clearing
  // would restart-loop.
  clearRestartPending() {
    return this.withLock(() => {
      const m = this.read('project', null);
      const rp = (m && m.restartPending) || null;
      if (m) { delete m.restartPending; this.write('project', m); }
      return rp;
    });
  }
  // Arm a restart. afterTaskId must reference a task that can actually finish: already-done is
  // fine (eligible immediately), but waiting_for_human or a blocked todo may stall forever, so
  // those are rejected at schedule time (Cato t_42f310cf #2).
  scheduleRestart({ afterTaskId = null, now = false } = {}) {
    if (!afterTaskId && !now) throw new Error('nothing requested: pass {afterTaskId} or {now:true}');
    if (afterTaskId && now) throw new Error('pass afterTaskId or now:true, not both');
    return this.withLock(() => {
      if (afterTaskId) {
        const t = this._readTaskFile(afterTaskId + '.json');
        if (!t) throw new Error('unknown afterTaskId ' + afterTaskId);
        if (t.status === 'waiting_for_human') throw new Error(`afterTaskId ${afterTaskId} is waiting_for_human and may never finish; resolve it first or schedule {now:true}`);
        if (t.status === 'todo' && C.isBlocked(t, this.listTasks())) throw new Error(`afterTaskId ${afterTaskId} is blocked by unfinished dependencies; pick a reachable task or schedule {now:true}`);
      }
      const m = this.read('project', null) || {};
      const rp = m.restartPending || { count: 0 };
      if (afterTaskId) rp.afterTaskId = afterTaskId;
      if (now) rp.scheduledNow = true;
      if (!rp.since) rp.since = new Date().toISOString();
      m.restartPending = rp;
      this.write('project', m);
      return rp;
    });
  }

  // ---- board/wiki file layout (.squad/) ----
  // tmp is created in the TARGET directory (rename is only atomic within one filesystem) and
  // fsynced before rename, so a crash never leaves a truncated file at the real path.
  _writeFileSync(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, data);
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  _sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
  tasksDir() { return path.join(this.dir, '.squad', 'board', 'tasks'); }
  taskFile(tid) { return path.join(this.tasksDir(), tid + '.json'); }
  wikiDir() { return path.join(this.dir, '.squad', 'wiki'); }
  _wikiIndexPath() { return path.join(this.wikiDir(), '.pages.json'); }
  _hashesFile() { return path.join(this.dir, '.squad', 'board', '.hashes.json'); }
  _readHashes() { try { return JSON.parse(fs.readFileSync(this._hashesFile(), 'utf8')); } catch { return null; } }
  _saveHashes(h) { this._writeFileSync(this._hashesFile(), JSON.stringify(h, null, 2)); }
  // sha256 bookkeeping per task file: lets the next load detect (and log) out-of-band edits —
  // hand edits would otherwise silently diverge from what the board tools handed out.
  _recordHash(file, data) {
    const h = this._readHashes() || {};
    h[path.basename(file)] = this._sha256(data);
    this._saveHashes(h);
  }
  // Callers hold the .lock (all writes happen inside _withTasks/_migrate/withLock).
  _writeTask(t) {
    const data = JSON.stringify(t, null, 2) + '\n';
    this._writeFileSync(this.taskFile(t.id), data);
    this._recordHash(t.id + '.json', data);
  }
  _unlinkTask(tid) {
    try { fs.unlinkSync(this.taskFile(tid)); } catch {}
    const h = this._readHashes();
    if (h && h[tid + '.json']) { delete h[tid + '.json']; this._saveHashes(h); }
  }
  _taskFiles() { try { return fs.readdirSync(this.tasksDir()).filter((f) => !f.startsWith('.') && f.endsWith('.json')).sort(); } catch { return []; } }
  // Readers race writers by design (agents cat/jq these files directly), so any single file may
  // be missing or half-swapped: tolerate and skip instead of failing the whole listing.
  _readTaskFile(f) { try { return JSON.parse(fs.readFileSync(path.join(this.tasksDir(), f), 'utf8')); } catch { return null; } }
  // Read-modify-write over the whole task set under ONE lock hold. fn mutates the array in place
  // (push/splice/field edits); tasks whose JSON changed are rewritten, removed ids unlinked.
  _withTasks(fn) {
    this._ensureBoard();
    return this.withLock(() => {
      const tasks = this._taskFiles().map((f) => this._readTaskFile(f)).filter(Boolean);
      const before = new Map(tasks.map((t) => [t.id, JSON.stringify(t)]));
      const r = fn(tasks);
      for (const t of tasks) if (JSON.stringify(t) !== before.get(t.id)) this._writeTask(t);
      const ids = new Set(tasks.map((t) => t.id));
      for (const tid0 of before.keys()) if (!ids.has(tid0)) this._unlinkTask(tid0);
      return r;
    });
  }
  // One-time per process: heal an interrupted migration, then verify out-of-board edits.
  // Lock is taken per step here; callers must NOT already hold it.
  _ensureBoard() {
    if (this._boardReady) return;
    this._migrate();
    this._verifyTaskIntegrity();
    this._boardReady = true;
  }
  _ensureWiki() {
    if (this._wikiReady) return;
    this._migrate();
    this._verifyWikiIntegrity();
    this._wikiReady = true;
  }
  _migrate() {
    if (this._migrated) return;
    this._migrated = true;
    this.withLock(() => { this._migrateBoard(); this._migrateWiki(); });
  }
  _migrateBoard() {
    const old = this.read('board', null);
    const oldTasks = old && Array.isArray(old.tasks) ? old.tasks.filter((t) => t && t.id) : null;
    if (!oldTasks) return;
    const have = new Set(this._taskFiles().map((f) => f.replace(/\.json$/, '')));
    // New store wins: per-file records that already exist are kept, only the missing ones are
    // (re)written — so an interrupted migration heals without duplicating or clobbering.
    for (const t of oldTasks) if (!have.has(t.id)) this._writeTask(t);
    // Retire the old file only when every old task has a file; otherwise leave it for the next open.
    if (this._taskFiles().length < oldTasks.length) return;
    const bak = this.file('board') + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(this.file('board'), bak); } catch { return; }
    this._snapshotTaskHashes();
    this._logStore(`migrated board.json -> .squad/board/tasks/ (${oldTasks.length} tasks${have.size ? `, ${have.size} already on disk kept` : ''}); old file kept as ${path.basename(bak)}`);
  }
  _migrateWiki() {
    const old = this.read('wiki', null);
    const pages = old && old.pages && typeof old.pages === 'object' ? old.pages : null;
    if (!pages) return;
    const idx = this._readWikiIndex();
    for (const [title, p] of Object.entries(pages)) if (!idx[title]) idx[title] = this._writeWikiPage(title, p.content || '', p.author || '', p.updatedAt || null);
    this._saveWikiIndex(idx);
    if (Object.keys(idx).length < Object.keys(pages).length) return;
    const bak = this.file('wiki') + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(this.file('wiki'), bak); } catch { return; }
    this._logStore(`migrated wiki.json -> .squad/wiki/ (${Object.keys(pages).length} pages); old file kept as ${path.basename(bak)}`);
  }
  // Baseline the hash map from disk (migration just wrote everything; nothing to warn about).
  _snapshotTaskHashes() {
    const h = {};
    for (const f of this._taskFiles()) { try { h[f] = this._sha256(fs.readFileSync(path.join(this.tasksDir(), f))); } catch {} }
    try { this._saveHashes(h); } catch {}
  }
  _verifyTaskIntegrity() {
    this.withLock(() => {
      try {
        const hashes = this._readHashes();
        if (!hashes) { this._snapshotTaskHashes(); return; } // first open of a per-file store: adopt as baseline
        const seen = new Set();
        let changed = false;
        for (const f of this._taskFiles()) {
          seen.add(f);
          let h = null;
          try { h = this._sha256(fs.readFileSync(path.join(this.tasksDir(), f))); } catch { continue; }
          if (hashes[f] && hashes[f] !== h) this._logStore(`out-of-band edit: .squad/board/tasks/${f} was modified outside the board tools; adopting the file as-is`);
          else if (!hashes[f]) this._logStore(`out-of-band file: .squad/board/tasks/${f} appeared outside the board tools; adopting it as a task`);
          if (hashes[f] !== h) { hashes[f] = h; changed = true; }
        }
        for (const f of Object.keys(hashes)) if (!seen.has(f)) { this._logStore(`out-of-band delete: .squad/board/tasks/${f} is gone`); delete hashes[f]; changed = true; }
        if (changed) this._saveHashes(hashes);
      } catch {}
    });
  }
  _verifyWikiIntegrity() {
    this.withLock(() => {
      try {
        const idx = this._readWikiIndex();
        let changed = false;
        for (const [title, e] of Object.entries(idx)) {
          let h = null;
          try { h = this._sha256(fs.readFileSync(path.join(this.wikiDir(), e.slug + '.md'))); } catch { continue; }
          if (e.hash && e.hash !== h) this._logStore(`out-of-band edit: .squad/wiki/${e.slug}.md (wiki "${title}") was modified outside the board tools; adopting the file as-is`);
          if (e.hash !== h) { e.hash = h; changed = true; }
        }
        if (changed) this._saveWikiIndex(idx);
      } catch {}
    });
  }
  _logStore(text) {
    try { console.warn('[store] ' + text); } catch {}
    try { this.appendLog({ at: Date.now(), nodeId: null, kind: 'store.integrity', text }); } catch {}
  }

  // ---- team ----
  getTeam() {
    if (!this.teamId) {
      const m = this.meta();
      if (m && m.teams && m.teams.length) {
        const all = { nodes: [], edges: [] };
        for (const t of m.teams) { const g = this.read('team-' + t.id, { nodes: [], edges: [] }); all.nodes.push(...g.nodes.map((n) => ({ ...n, teamId: t.id }))); all.edges.push(...g.edges); }
        return all;
      }
    }
    return this.read(this.teamFile(), { nodes: [], edges: [] });
  }
  saveTeam(team) { this.withLock(() => this.write(this.teamFile(), team)); return team; }
  addNode(n) {
    const presets = this.getSettings().rolePresets;
    const node = { id: n.id || id('n'), ...normalizeNode(applyPreset(n, presets)), x: n.x, y: n.y };
    this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      // Explicit x/y (context menu, toolbar add, duplicate, seeds) is kept; otherwise claim the first
      // free grid cell inside the lock so nodes created back-to-back never stack at (80,80). An
      // explicit spot that lands on a placed node (toolbar add staggers by only 20px) is not free
      // either — it falls through to the same search so cards never overlap.
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || this.overlaps(node.x, node.y, t.nodes)) Object.assign(node, this.freeSpot(t.nodes));
      t.nodes.push(node);
    });
    return node;
  }
  // Agent cards are ~200x110: points closer than that on BOTH axes read as overlapping cards.
  overlaps(x, y, nodes) { return nodes.some((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Math.abs(n.x - x) < 200 && Math.abs(n.y - y) < 110); }
  // First cell of a 220x140-step grid (agent card ~200x110) that clears every placed node;
  // row-major from (80,80), so new agents flow left-to-right, top-to-bottom.
  freeSpot(nodes) {
    for (let row = 0; ; row++) for (let col = 0; col < 8; col++) {
      const x = 80 + col * 220, y = 80 + row * 140;
      if (!this.overlaps(x, y, nodes)) return { x, y };
    }
  }
  // Changing the role to a preset's name fills the node's empty prompt / tools / permission mode from that preset.
  updateNode(nid, patch) {
    // `protected` has exactly one writer (the human's setNodeProtected below): no generic patch —
    // renderer save, update_agent whitelist or any future caller — may smuggle it through here.
    if (patch && 'protected' in patch) throw new Error('protected is human-only: use setNodeProtected');
    const p = normalizePatch(patch); const presets = this.getSettings().rolePresets;
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      const n = t.nodes.find((x) => x.id === nid); if (!n) throw new Error('no node');
      const roleChanged = p.role !== undefined && String(p.role).toLowerCase() !== String(n.role || '').toLowerCase();
      // A rate-limit snapshot describes the runtime that reported it: switching runtimes invalidates it
      // (it must not resurface as the new provider's quota), and the new CLI reports fresh on its next run.
      const runtimeChanged = p.runtime !== undefined && String(p.runtime || '') !== String(n.runtime || '');
      Object.assign(n, p, { id: nid });
      if (runtimeChanged) { delete n.rateLimits; delete n.rateLimitsAt; }
      if (roleChanged) Object.assign(n, normalizePatch(pick(applyPreset(n, presets), PRESET_FIELDS)));
      return n;
    });
  }
  // The single writer of the protected flag: called only from the human-only IPC (main.js api).
  setNodeProtected(nid, v) {
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      const n = t.nodes.find((x) => x.id === nid); if (!n) throw new Error('no node');
      n.protected = !!v; return n;
    });
  }
  removeNode(nid) {
    this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => { t.nodes = t.nodes.filter((n) => n.id !== nid); t.edges = t.edges.filter((e) => e.from !== nid && e.to !== nid); });
    for (const tid of this.teamIds()) if ('team-' + tid !== this.teamFile()) this.update('team-' + tid, { nodes: [], edges: [] }, (t) => { t.edges = t.edges.filter((e) => e.to !== nid); });
  }
  teamIds() { const m = this.meta(); return (m && m.teams || []).map((t) => t.id); }
  teamName(tid) { const m = this.meta(); const t = m && m.teams && m.teams.find((x) => x.id === tid); return t ? t.name : null; }
  nodeTeam(nid) { return this.teamIds().find((tid) => this.read('team-' + tid, { nodes: [] }).nodes.some((n) => n.id === nid)) || null; }
  // {nodeId: {teamId, teamName}} for every node across all teams; used to tag log/timeline entries for renderer filtering.
  nodeTeamMap() {
    const out = {};
    for (const tid of this.teamIds()) {
      const teamName = this.teamName(tid);
      for (const n of this.read('team-' + tid, { nodes: [] }).nodes) out[n.id] = { teamId: tid, teamName };
    }
    return out;
  }
  // Edges from other teams that point into this team (stored in the source team's file), flagged crossTeam.
  incomingCrossEdges() {
    const mine = new Set(this.getTeam().nodes.map((n) => n.id)); const out = [];
    for (const tid of this.teamIds()) if ('team-' + tid !== this.teamFile()) for (const e of this.read('team-' + tid, { edges: [] }).edges) if (mine.has(e.to)) out.push({ ...e, crossTeam: true, fromTeam: tid });
    return out;
  }
  // Canvas viewport { x, y, zoom } persisted per team graph.
  getViewport() { return this.read(this.teamFile(), {}).viewport || null; }
  setViewport(v) {
    const vp = { x: Number(v.x) || 0, y: Number(v.y) || 0, zoom: Math.min(4, Math.max(0.1, Number(v.zoom) || 1)) };
    this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => { t.viewport = vp; }); return vp;
  }
  // Bulk position save after drag / auto-layout: { nodeId: { x, y } }.
  setPositions(pos) {
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      for (const n of t.nodes) { const p = pos[n.id]; if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) { n.x = +p.x; n.y = +p.y; } }
      return t.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
    });
  }
  // type: assign (can create tasks for target, implies message), message (send_message only), review (target reviews source's tasks)
  addEdge(from, to, type = 'assign') {
    if (!EDGE_TYPES.includes(type)) throw new Error('bad edge type ' + type);
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      if (from === to) throw new Error('self edge not allowed');
      // source must be in this team; target may be in any team of the project (cross-team edge)
      if (!t.nodes.find((n) => n.id === from) || !(t.nodes.find((n) => n.id === to) || this.nodeTeam(to))) throw new Error('unknown node');
      let e = t.edges.find((x) => x.from === from && x.to === to && (x.type || 'assign') === type);
      if (!e) { e = { id: id('e'), from, to, type }; t.edges.push(e); }
      return e;
    });
  }
  updateEdge(eid, patch) {
    if (patch.type !== undefined && !EDGE_TYPES.includes(patch.type)) throw new Error('bad edge type ' + patch.type);
    return this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => {
      const e = t.edges.find((x) => x.id === eid); if (!e) throw new Error('no edge');
      if (patch.type && t.edges.some((x) => x !== e && x.from === e.from && x.to === e.to && (x.type || 'assign') === patch.type)) throw new Error('an edge of that type already exists');
      if (patch.type) e.type = patch.type;
      return e;
    });
  }
  removeEdge(eid) { this.update(this.teamFile(), { nodes: [], edges: [] }, (t) => { t.edges = t.edges.filter((e) => e.id !== eid); }); }

  // ---- board ----
  listTasks(filter = {}) {
    this._ensureBoard();
    let ts = this._taskFiles().map((f) => this._readTaskFile(f)).filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    if (filter.status) ts = ts.filter((t) => t.status === filter.status);
    if (filter.assignee) ts = ts.filter((t) => t.assignee === filter.assignee);
    return ts;
  }
  getTask(tid) { this._ensureBoard(); return this._readTaskFile(tid + '.json') || undefined; }
  createTask({ title, description = '', assignee = null, createdBy = 'human', parentId = null, blockedBy = [], priority, attachments = null }) {
    if (!title) throw new Error('title required');
    const now = new Date().toISOString();
    const task = { id: id('t'), title, description, assignee, status: 'todo', priority: C.normalizePriority(priority), createdBy, parentId, blockedBy: [], comments: [], createdAt: now, updatedAt: now };
    const atts = sanitizeAttachments(attachments);
    if (atts) task.attachments = atts;
    this._withTasks((tasks) => { task.blockedBy = C.validateDeps(task.id, blockedBy, tasks); tasks.push(task); });
    return task;
  }
  updateTask(tid, patch) {
    let t = this._updateTask(tid, patch);
    // Every approval request also shows up in the human inbox.
    if (patch.awaitingApproval && !this.listInbox({ status: 'open' }).some((i) => i.kind === 'approval' && i.taskId === tid)) this.addInbox({ kind: 'approval', taskId: tid, nodeId: t.assignee, question: `Approve "${t.title}"?`, choices: ['approve'] });
    // Never strand finished work in its worktree branch: auto-merge on done, or park as merge_conflict.
    if (patch.status === 'done' && t.worktreePath && t.worktreeBranch) t = this._mergeOnDone(t);
    return t;
  }
  // Merge a done task's squad/<id> branch into base. On conflict, abort, mark the task 'merge_conflict'
  // (not done) and hand the SAME branch to a follow-up conflict-resolution task (never a new branch),
  // so resolving it re-merges the original work instead of stranding it behind a chain of tasks.
  _mergeOnDone(t) {
    try {
      const r = WT.worktreeMerge(t);
      if (r.refused) {
        // Dirty main checkout: park in review (not merge_conflict) so cleaning main and
        // re-marking done retries the same merge instead of spawning a resolve task.
        this._updateTask(t.id, { status: 'review' });
        this.commentTask(t.id, 'system', WT.dirtyMergeMessage(r.dirty));
        return this.getTask(t.id);
      }
      // A landed merge no longer restarts the app; it only counts toward the next scheduled one
      // (conflicts/refusals are not landed work — the count covers merges that actually merged).
      if (r.merged) this.bumpRestartPending();
      this.commentTask(t.id, 'system', r.merged ? `auto-merged ${t.worktreeBranch} into base` : `nothing merged: no commits on ${t.worktreeBranch} ahead of ${r.base}`);
      return this.getTask(t.id);
    } catch (e) {
      return this._onMergeConflict(t, e);
    }
  }
  static MAX_CONFLICT_RETRIES = 3;
  _onMergeConflict(t, e) {
    this._updateTask(t.id, { status: 'merge_conflict' });
    this.commentTask(t.id, 'system', `auto-merge blocked, task moved to merge_conflict: ${e.message}`);
    // A resolve task's own completion re-runs this same merge. If it still conflicts, reopen the
    // *same* task (bounded retries) instead of spawning another "Resolve merge conflict: ..." task.
    if (t.isConflictResolution) {
      const retries = (t.conflictRetries || 0) + 1;
      if (retries >= Store.MAX_CONFLICT_RETRIES) {
        this.commentTask(t.id, 'system', `merge of ${t.worktreeBranch} still conflicts after ${retries} attempts; escalating to a human instead of retrying again.`);
        this.askHuman({ taskId: t.id, nodeId: t.assignee, question: `Merge conflict on ${t.worktreeBranch} persists after ${retries} attempts: ${e.message}. Please resolve manually.` });
        return this.getTask(t.id);
      }
      this.commentTask(t.id, 'system', `still conflicts; reopening this same task to retry resolving ${t.worktreeBranch} (attempt ${retries}/${Store.MAX_CONFLICT_RETRIES}).`);
      return this._updateTask(t.id, { status: 'todo', conflictRetries: retries });
    }
    // Dedupe by branch + flag (not by title prefix): at most one open resolve task per branch.
    const dup = this.listTasks().find((x) => x.isConflictResolution && x.conflictBranch === t.worktreeBranch && x.status !== 'done');
    if (dup) {
      this.commentTask(t.id, 'system', `an open resolve task already exists for ${t.worktreeBranch} (${dup.id}); not creating another.`);
      return this.getTask(t.id);
    }
    const baseTitle = t.title.replace(/^Resolve merge conflict:\s*/, '');
    const task = this.createTask({
      title: `Resolve merge conflict: ${baseTitle}`,
      description: `Auto-merge of ${t.worktreeBranch} failed:\n${e.message}\n\nResolve the conflict directly on ${t.worktreeBranch} (rebase on the base branch, fix conflicts, commit), then mark this task done — that re-runs the merge of the SAME branch. Do not create another conflict task.`,
      assignee: t.assignee, createdBy: 'system', parentId: t.id,
    });
    this._updateTask(task.id, { isConflictResolution: true, conflictBranch: t.worktreeBranch, worktreePath: t.worktreePath, worktreeBranch: t.worktreeBranch });
    return this.getTask(t.id);
  }
  // Unmerged squad/<id> branches across every git repo referenced by a task's worktreePath.
  listUnmergedBranches() {
    const roots = new Set(this.listTasks().filter((t) => t.worktreePath).map((t) => path.resolve(t.worktreePath, '..', '..', '..')));
    return [...roots].flatMap((root) => WT.unmergedSquadBranches(root));
  }
  _updateTask(tid, patch) {
    return this._withTasks((tasks) => {
      const t = tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      if (patch.status && !STATUSES.includes(patch.status)) throw new Error('bad status ' + patch.status);
      if (patch.blockedBy !== undefined) t.blockedBy = C.validateDeps(tid, patch.blockedBy, tasks);
      if (patch.status && patch.status !== 'review') t.awaitingApproval = false;
      if (patch.priority !== undefined) t.priority = C.normalizePriority(patch.priority);
      for (const k of ['title', 'description', 'assignee', 'status', 'sessionId', 'sessions', 'iterations', 'awaitingApproval', 'reopenCount', 'worktreePath', 'worktreeBranch', 'isConflictResolution', 'conflictBranch', 'conflictRetries', 'parkedForHuman', 'stallRecoveries', 'drainCuts']) if (patch[k] !== undefined) t[k] = patch[k];
      t.updatedAt = new Date().toISOString();
      // Parent auto-complete: when the last open subtask is done, the parent moves to done.
      for (let c = t; c.status === 'done' && c.parentId;) {
        const parent = tasks.find((x) => x.id === c.parentId);
        if (!parent || parent.status === 'done' || tasks.some((x) => x.parentId === parent.id && x.status !== 'done')) break;
        parent.status = 'done'; parent.awaitingApproval = false; parent.updatedAt = t.updatedAt; c = parent;
      }
      return t;
    });
  }
  deleteTask(tid) { this._withTasks((tasks) => { const i = tasks.findIndex((t) => t.id === tid); if (i >= 0) tasks.splice(i, 1); for (const t of tasks) if (t.blockedBy) t.blockedBy = t.blockedBy.filter((x) => x !== tid); }); }
  // Human approval gate: approve -> done, reject -> todo (with the note as a comment, so the agent reworks it).
  approveTask(tid, approve = true, note = '') {
    const t = this.getTask(tid); if (!t) throw new Error('no task ' + tid);
    if (note || !approve) this.commentTask(tid, 'human', (approve ? 'Approved' : 'Changes requested') + (note ? ': ' + note : ''));
    this.closeInbox((i) => i.kind === 'approval' && i.taskId === tid && i.status === 'open', approve ? 'approved' : 'changes requested');
    // "reopened": sent back for changes at least once, so it can't count as first-pass-accepted in modelStats.
    if (!approve) this._updateTask(tid, { reopenCount: (t.reopenCount || 0) + 1 });
    return this.updateTask(tid, { status: approve ? 'done' : 'todo', awaitingApproval: false });
  }

  // ---- human inbox: questions (ask_human) and approval requests ----
  listInbox(filter = {}) { let xs = this.read('inbox', { items: [] }).items; if (filter.status) xs = xs.filter((i) => i.status === filter.status); return xs; }
  getInboxItem(iid) { return this.listInbox().find((i) => i.id === iid); }
  // `change` (optional) fingerprints a core-agent team-change request, so recruit/retire/update can
  // find their own inbox item again when the core re-calls the tool after the human answered — and
  // doubles as the stored payload the main process applies on the answer (team-answers.js). `reason`
  // rides alongside it (the tool requires one, but it must stay out of the fingerprint).
  addInbox({ kind = 'question', taskId = null, nodeId = null, question, choices = [], change = null, reason = null }) {
    if (!question) throw new Error('question required');
    const item = { id: id('q'), kind, taskId, nodeId, question, choices: (choices || []).map(String), status: 'open', answer: null, at: new Date().toISOString(), ...(change ? { change } : {}), ...(reason ? { reason } : {}) };
    this.update('inbox', { items: [] }, (d) => { d.items.push(item); });
    return item;
  }
  closeInbox(match, answer) { this.update('inbox', { items: [] }, (d) => { for (const i of d.items) if (match(i)) Object.assign(i, { status: 'answered', answer, answeredAt: new Date().toISOString() }); }); }
  // One-shot team-change approvals: once the core has used an answer (applied or declined) the item
  // is marked consumed so the same request can never replay a stale answer.
  consumeInbox(iid) { this.update('inbox', { items: [] }, (d) => { for (const i of d.items) if (i.id === iid) i.consumed = true; }); }
  // ask_human: store the question and park the task in waiting_for_human.
  askHuman({ taskId, nodeId, question, choices, change, reason }) {
    const item = this.addInbox({ kind: 'question', taskId, nodeId, question, choices, change, reason });
    if (taskId && this.getTask(taskId)) this.updateTask(taskId, { status: 'waiting_for_human' });
    return item;
  }
  // Answer an item. Questions: the task goes back to in_progress (the blocked agent tool call returns the answer).
  // Approvals: answer 'approve' / anything else = changes requested with that note.
  answerInbox(iid, answer) {
    const it = this.getInboxItem(iid); if (!it) throw new Error('no inbox item ' + iid);
    if (it.status !== 'open') throw new Error('already answered');
    answer = String(answer ?? '').trim(); if (!answer) throw new Error('answer required');
    if (it.kind === 'approval') { const ok = answer === 'approve'; return this.approveTask(it.taskId, ok, ok ? '' : answer); }
    this.closeInbox((i) => i.id === iid, answer);
    const t = it.taskId && this.getTask(it.taskId);
    if (t) { this.commentTask(t.id, 'human', `Q: ${it.question}\nA: ${answer}`); if (t.status === 'waiting_for_human') this.updateTask(t.id, { status: 'in_progress' }); }
    return this.getInboxItem(iid);
  }
  commentTask(tid, author, text) {
    return this._withTasks((tasks) => {
      const t = tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      const c = { author, text, at: new Date().toISOString() }; t.comments.push(c); t.updatedAt = c.at; return c;
    });
  }

  // ---- attachments (main-process save; renderer gets {path,name,mime,size}|{error}) ----
  attachmentsDir() { return path.join(this.dir, 'attachments'); }
  saveAttachment({ name, mime, bytes }) {
    try {
      const buf = Buffer.isBuffer(bytes) ? bytes
        : bytes instanceof ArrayBuffer ? Buffer.from(bytes)
        : ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : null;
      if (!buf || !buf.length) return { error: 'attachment has no bytes (send the file content as bytes)' };
      if (buf.length > ATTACHMENT_MAX_BYTES) return { error: `attachment too large: ${name} is ${(buf.length / 1048576).toFixed(1)} MB (limit is 10 MB)` };
      const clean = cleanAttachmentName(name);
      const dir = this.attachmentsDir();
      const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${clean}`);
      if (!file.startsWith(dir + path.sep)) return { error: 'attachment name escaped the attachments directory' };
      this._writeFileSync(file, buf);
      return { path: file, name: clean, mime: String(mime || ''), size: buf.length };
    } catch (e) { return { error: 'attachment save failed: ' + e.message }; }
  }

  // ---- messages (agent to agent, scope checked in board-tools) ----
  listMessages(filter = {}) {
    let ms = this.read('messages', { messages: [] }).messages;
    if (filter.to) ms = ms.filter((m) => m.to === filter.to);
    if (filter.from) ms = ms.filter((m) => m.from === filter.from);
    return ms;
  }
  sendMessage({ from, to, text, taskId = null, attachments = null }) {
    if (!text) throw new Error('text required');
    const m = { id: id('m'), from, to, text, taskId, at: new Date().toISOString(), read: false };
    const atts = sanitizeAttachments(attachments);
    if (atts) m.attachments = atts;
    this.update('messages', { messages: [] }, (d) => { d.messages.push(m); });
    return m;
  }
  markMessagesRead(ids, read = true) {
    const set = new Set(ids); if (!set.size) return;
    this.update('messages', { messages: [] }, (d) => { for (const m of d.messages) if (set.has(m.id)) m.read = !!read; });
  }

  // ---- wiki (one readable .md per page; the index keeps title/slug/author/hash) ----
  // Slug: flatten the title to a safe single path segment, plus a hash of the EXACT title so
  // case-insensitive filesystems never merge two pages ('API Design' vs 'api design').
  _wikiSlug(title) {
    const base = String(title).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'page';
    return base + '-' + this._sha256(String(title)).slice(0, 8);
  }
  _readWikiIndex() { try { return JSON.parse(fs.readFileSync(this._wikiIndexPath(), 'utf8')) || {}; } catch { return {}; } }
  _saveWikiIndex(idx) { fs.mkdirSync(this.wikiDir(), { recursive: true }); this._writeFileSync(this._wikiIndexPath(), JSON.stringify(idx, null, 2)); }
  _wikiFiles() { try { return fs.readdirSync(this.wikiDir()).filter((f) => !f.startsWith('.') && f.endsWith('.md')).sort(); } catch { return []; } }
  _writeWikiPage(title, content, author, updatedAt) {
    fs.mkdirSync(this.wikiDir(), { recursive: true });
    const data = String(content ?? '');
    const slug = this._wikiSlug(title);
    this._writeFileSync(path.join(this.wikiDir(), slug + '.md'), data);
    return { slug, author: author || '', updatedAt: updatedAt || new Date().toISOString(), hash: this._sha256(data) };
  }
  listWiki() {
    this._ensureWiki();
    const idx = this._readWikiIndex();
    // .md files with no index entry were dropped there out-of-band: adopt (never silently drop).
    this.withLock(() => {
      const known = new Set(Object.values(idx).map((e) => e.slug + '.md'));
      let changed = false;
      for (const f of this._wikiFiles()) {
        if (known.has(f)) continue;
        let content = '';
        try { content = fs.readFileSync(path.join(this.wikiDir(), f), 'utf8'); } catch { continue; }
        const title = f.replace(/\.md$/, '');
        idx[title] = { slug: title, author: 'unknown', updatedAt: new Date().toISOString(), hash: this._sha256(content) };
        this._logStore(`out-of-band file: .squad/wiki/${f} appeared outside the board tools; adopting it as wiki page "${title}"`);
        changed = true;
      }
      if (changed) this._saveWikiIndex(idx);
    });
    const pages = {};
    for (const [title, e] of Object.entries(idx)) {
      let content = null;
      try { content = fs.readFileSync(path.join(this.wikiDir(), e.slug + '.md'), 'utf8'); } catch {}
      if (content === null) continue; // vanished mid-rename or deleted: skip, never crash a reader
      pages[title] = { title, content, author: e.author || '', updatedAt: e.updatedAt || null };
    }
    return pages;
  }
  readWiki(title) { return this.listWiki()[title] || null; }
  writeWiki(title, content, author = 'human') {
    if (!title) throw new Error('title required');
    this._ensureWiki();
    return this.withLock(() => {
      const idx = this._readWikiIndex();
      idx[title] = this._writeWikiPage(title, content, author, new Date().toISOString());
      this._saveWikiIndex(idx);
      return { title, content, author, updatedAt: idx[title].updatedAt };
    });
  }
  deleteWiki(title) {
    this._ensureWiki();
    this.withLock(() => {
      const idx = this._readWikiIndex();
      const e = idx[title];
      delete idx[title];
      this._saveWikiIndex(idx);
      if (e) { try { fs.unlinkSync(path.join(this.wikiDir(), e.slug + '.md')); } catch {} }
    });
  }
  // Page list without body content, newest first: [{title, author, updatedAt}].
  listWikiSummaries() {
    return Object.values(this.listWiki())
      .map((p) => ({ title: p.title, author: p.author || '', updatedAt: p.updatedAt || null }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  // Case-insensitive full-text search over title + content. Returns matches with a short snippet
  // around the first hit, newest first.
  searchWiki(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const p of Object.values(this.listWiki())) {
      const content = p.content || '';
      const hitTitle = p.title.toLowerCase().includes(q);
      const idx = content.toLowerCase().indexOf(q);
      if (!hitTitle && idx < 0) continue;
      const at = idx >= 0 ? idx : 0;
      const start = Math.max(0, at - 40);
      const snippet = (start > 0 ? '…' : '') + content.slice(start, at + q.length + 40).trim() + (start + 80 < content.length ? '…' : '');
      out.push({ title: p.title, author: p.author || '', updatedAt: p.updatedAt || null, snippet });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // ---- usage: one record per claude run (see usage.js), newest last, capped ----
  addRun(r) { this.update('runs', { runs: [] }, (d) => { d.runs.push(r); if (d.runs.length > 5000) d.runs.splice(0, d.runs.length - 5000); }); return r; }
  listRuns(filter = {}) {
    let rs = this.read('runs', { runs: [] }).runs;
    for (const k of ['nodeId', 'taskId', 'billingSource', 'kind']) if (filter[k]) rs = rs.filter((r) => r[k] === filter[k]);
    return rs;
  }
  clearRuns() { this.update('runs', { runs: [] }, (d) => { d.runs = []; }); }

  // ---- persisted orchestrator log (logs.jsonl, trimmed to the last LOG_CAP lines) ----
  appendLog(l) {
    const f = path.join(this.dir, 'logs.jsonl');
    fs.appendFileSync(f, C.logLine(l) + '\n');
    try { if (fs.statSync(f).size > 3e6) { const keep = C.parseLogs(fs.readFileSync(f, 'utf8'), C.LOG_CAP); this.withLock(() => fs.writeFileSync(f, keep.map(C.logLine).join('\n') + '\n')); } } catch {}
  }
  // level (info/warn/error, derived from kind via TL.levelOf) lets the UI default its filter to warn+error.
  // Tails logs.jsonl instead of reading it whole: reads backward from EOF in growing windows until
  // `limit` complete lines are available, so a multi-MB log costs one small read, not a full parse.
  readLogs(limit = 2000) {
    try {
      const f = this.logFile(); const st = fs.statSync(f);
      let bytes = Math.min(st.size, Math.max(256 * 1024, limit * 300));
      let out = [];
      for (;;) {
        const buf = Buffer.alloc(bytes);
        const fd = fs.openSync(f, 'r');
        try { fs.readSync(fd, buf, 0, bytes, st.size - bytes); } finally { fs.closeSync(fd); }
        let text = buf.toString('utf8');
        if (bytes < st.size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
        out = C.parseLogs(text, limit);
        if (out.length >= limit || bytes >= st.size) break;
        bytes = Math.min(st.size, bytes * 4);
      }
      return out.map((l) => ({ ...l, level: TL.levelOf(l.kind) }));
    } catch { return []; }
  }
  clearLogs() { try { fs.unlinkSync(path.join(this.dir, 'logs.jsonl')); } catch {} }

  // ---- sessions: claude sessions grouped from persisted runs (see usage.js newRun) ----
  // One entry per distinct sessionId, newest first: [{sessionId, nodeId, agent, taskId, task, startedAt, endedAt, model, models, runs, reportedCostUsd}].
  // No token totals: a session mixes models, so its only offered sum is cost (per-key tokens live in the usage ledger).
  listSessions(filter = {}) {
    const rs = this.listRuns({ nodeId: filter.nodeId }).filter((r) => r.kind === 'agent' && r.sessionId);
    const byId = new Map();
    for (const r of rs) {
      const s = byId.get(r.sessionId) || { sessionId: r.sessionId, nodeId: r.nodeId, agent: r.agent || '', taskId: r.taskId || null, task: r.task || '', startedAt: r.startedAt || null, endedAt: r.endedAt || null, models: [], runs: 0, reportedCostUsd: 0 };
      s.runs++; s.reportedCostUsd += r.reportedCostUsd || 0;
      if (r.startedAt && (!s.startedAt || r.startedAt < s.startedAt)) s.startedAt = r.startedAt;
      if (r.endedAt && (!s.endedAt || r.endedAt > s.endedAt)) s.endedAt = r.endedAt;
      if (r.taskId) { s.taskId = r.taskId; s.task = r.task || s.task; } // last run's task wins
      for (const m of r.model ? [r.model] : []) if (!s.models.includes(m)) s.models.push(m);
      byId.set(r.sessionId, s);
    }
    return [...byId.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
  // Full conversation/log for one session, paginated oldest-first: {total, offset, limit, entries}.
  // Bounded by the session's runs' [startedAt, endedAt] window on that node (only one run is active per node at a time).
  getSessionLog(sessionId, { offset = 0, limit = 200 } = {}) {
    const rs = this.listRuns().filter((r) => r.sessionId === sessionId);
    if (!rs.length) return { total: 0, offset, limit, entries: [] };
    const nodeId = rs[0].nodeId;
    const startMs = Math.min(...rs.map((r) => (r.startedAt ? Date.parse(r.startedAt) : Infinity)));
    const endsOpen = rs.some((r) => !r.endedAt);
    const endMs = endsOpen ? Infinity : Math.max(...rs.map((r) => Date.parse(r.endedAt)));
    const all = this.readLogs(Infinity).filter((l) => l.nodeId === nodeId && l.at >= startMs && l.at <= endMs);
    const entries = TL.logEntries(all.slice(offset, offset + limit));
    return { total: all.length, offset, limit, entries };
  }

  // ---- settings ----
  getSettings() { return { claudePath: 'claude', maxConcurrency: 8, maxRuns: 30, permissionMode: 'bypassPermissions', rolePresets: [], budgetUsd: 0, budgetTokens: 0, requireApproval: false, useWorktrees: true, usageLimits: {}, autoCompactPct: 40, stallTimeoutMin: 10, watchIntervalMin: 10, autoRestart: false, maxAgents: 6, teamChangeApproval: 'ask', ...this.read('settings', {}) }; }
  saveSettings(s) {
    const next = { ...this.getSettings(), ...s };
    if (s.rolePresets) {
      next.rolePresets = s.rolePresets.map(normalizePreset);
      const names = next.rolePresets.map((p) => p.name.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error('duplicate preset name');
    }
    // Core-agent team limits (see the dynamic-team plan): team size cap and approval mode.
    if (s.maxAgents !== undefined) { const n = Number(s.maxAgents); if (!Number.isInteger(n) || n < 1) throw new Error('maxAgents must be an integer >= 1'); next.maxAgents = n; }
    if (s.teamChangeApproval !== undefined && !['ask', 'auto'].includes(s.teamChangeApproval)) throw new Error('teamChangeApproval must be "ask" or "auto"');
    this.withLock(() => this.write('settings', next)); return this.getSettings();
  }
  // Role presets are per project (stored in settings.json).
  savePreset(p) { const np = normalizePreset(p); const rest = this.getSettings().rolePresets.filter((x) => x.name.toLowerCase() !== np.name.toLowerCase()); return this.saveSettings({ rolePresets: [...rest, np] }).rolePresets; }
  deletePreset(name) { return this.saveSettings({ rolePresets: this.getSettings().rolePresets.filter((x) => x.name !== name) }).rolePresets; }
}

module.exports = { Store, ROLES, STATUSES, PRIORITIES: C.PRIORITIES, defaultProjectDir, pickChanged };
