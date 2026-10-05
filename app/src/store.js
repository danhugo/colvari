// JSON-file store shared by the Electron main process and MCP server processes.
// Layout: <dir>/team.json, messages.json, inbox.json, runs.json, settings.json, plus a readable
// board/wiki tree agents can cat/grep/jq: <dir>/.squad/board/tasks/<id>.json (one pretty-JSON file
// per task — the file IS the record) and <dir>/.squad/wiki/<slug>.md (one markdown file per page;
// title/slug/author/sha live in the hidden .pages.json index, only content in the .md).
// Private stores (messages, inbox, runs, settings, teams) deliberately stay OUTSIDE .squad/ so
// direct reads of the board tree never expose DMs.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const C = require('./controls');
const TL = require('./timeline');
const PRESET_FIELDS = ['systemPrompt', 'allowedTools', 'disallowedTools', 'permissionMode'];
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const { normalizeNode, normalizePatch, normalizePreset, applyPreset, EDGE_TYPES, SUGGESTED_ROLES } = require('./agent-config');
const { defaultName } = require('./agent-name');
const WT = require('./worktree');
const MG = require('./merge-gate');
const LI = require('./log-index');
const { BoardCache } = require('./board-cache');

// Bounce payload for a gate-blocked merge: failing test names + a capped output tail (#8).
const blockPayload = (r) => `${(r.names || []).length ? (r.names || []).map((n) => '- ' + n).join('\n') : '- (test names unavailable)'}\n\ntail of the test output:\n\`\`\`\n${r.output || '(none)'}\n\`\`\``;

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

// Lock-steal policy (t_1857d0d5: the 5s "stale" steal could rip the lock out of a live holder
// mid read-modify-write and lose its update). A waiter may take an existing .lock over only when
// the holder is provably gone: the holder records its pid in .lock/pid right after mkdir (written
// via tmp+rename, so the file is never seen half-written), and kill(pid, 0) tells dead (ESRCH)
// from alive (success, or EPERM = alive under another user). A pid-less lock (holder crashed
// between mkdir and the pid rename) is stolen only once older than pidlessMs, and a live-pid lock
// only once older than lastResortMs (pid reuse / wedged holder — a real hold is a handful of file
// ops, seconds at worst on a loaded machine, so a 5-minute-old lock with a living pid is not a
// holder anymore). One object so tests can shrink the waits instead of sleeping minutes; not
// runtime configuration.
const LOCK = { waitMs: 5000, pidlessMs: 30000, lastResortMs: 300000 };
// Decision table for taking the lock at <dir> over. Ages come from the dir mtime (≈ acquisition
// time). An unreadable or corrupt pid counts as pid-less. Never throws; a lock that just vanished
// is not stealable (poll again and race mkdir).
function lockHolderDead(dir, now = Date.now()) {
  let age = 0;
  try { age = now - fs.statSync(dir).mtimeMs; } catch { return false; }
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) pid = null;
  } catch { pid = null; }
  if (pid !== null) {
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    return alive ? age > LOCK.lastResortMs : true;
  }
  return age > LOCK.pidlessMs;
}

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

// ---- async buffered log appends (t_d22a6cf2, wiki change 1) ----
// appendLog used to appendFileSync + statSync EVERY line and, past 3MB, read-and-rewrite the whole
// file under the lock — all on the calling thread, which in the app is the Electron main process,
// so every IPC reply queued behind log writes while agents streamed. Lines now go into a per-dir
// buffer (shared by every Store instance in the process, so per-process ordering is preserved) that
// one async appendFile flushes per batch; the file size is tracked in memory instead of a stat per
// line, and rotation (logs.jsonl -> logs.jsonl.1) replaces the read-and-rewrite trim. The flush is
// armed with setImmediate (not a timer): a sync burst coalesces into exactly one append at the end
// of the tick, no polling timer handle is ever created, and cross-process visibility lags by a tick
// at most. Crash risk: a hard kill loses the last flush window of log lines — acceptable for a
// diagnostic log (task files keep their sync writes). A normal exit flushes synchronously instead.
const LOG_LIMITS = { flushBytes: 256 * 1024, rotateBytes: 3e6 }; // one object so tests can shrink them (same pattern as LOCK); not runtime configuration
const LOG_BUFS = new Map(); // resolved dir -> { dir, store, lines, flying, bytes, size, armed, flushing, idxLive }
function logBufState(dir, store) {
  const key = path.resolve(dir);
  let st = LOG_BUFS.get(key);
  if (!st) { st = { dir: key, store, lines: [], flying: [], bytes: 0, size: null, armed: false, flushing: false, idxLive: null }; LOG_BUFS.set(key, st); }
  return st;
}
let _logExitHooked = false;
function hookLogExitFlush() {
  if (_logExitHooked) return; _logExitHooked = true;
  process.on('exit', () => {
    for (const st of LOG_BUFS.values()) {
      const lines = st.flying.concat(st.lines); st.flying = []; st.lines = []; st.bytes = 0;
      if (lines.length) { try { fs.appendFileSync(path.join(st.dir, 'logs.jsonl'), lines.map((o) => o.s).join('')); } catch {} }
    }
  });
}

class Store {
  // teamId: which team graph this store edits. Without it, getTeam() returns the union of all
  // teams in the project (used by the orchestrator and MCP server: node ids are globally unique).
  // devMode: whether the app this store belongs to can ever restart itself (main.js DEV_MODE —
  // false in packaged builds). Only merges consult it: they must not count toward a restart that
  // can never happen. Merges run in whichever process holds the store (the app AND each agent's
  // board MCP server), so every production entry point threads the flag; default true keeps tests
  // and hand-wired stores on the dev behavior.
  constructor(dir, teamId = null, opts = {}) {
    this.dir = dir;
    this.teamId = teamId;
    this.devMode = opts.devMode !== false;
    fs.mkdirSync(dir, { recursive: true });
    // Main-process board cache (t_479e7290): opt-in, one shared instance per project dir (the
    // cache outlives the throwaway Store instances). The board MCP server processes construct
    // their Store without opts and keep reading disk — the cache must never cross processes.
    this.cache = opts.cache ? BoardCache.forStore(this, typeof opts.cache === 'object' ? opts.cache : undefined) : null;
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
  forTeam(teamId) { return new Store(this.dir, teamId, { devMode: this.devMode }); }
  meta() { return this.read('project', null); }
  teamFile() {
    if (this.teamId) return 'team-' + this.teamId;
    const m = this.meta();
    return m && m.teams && m.teams[0] ? 'team-' + m.teams[0].id : 'team';
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  logFile() { return path.join(this.dir, 'logs.jsonl'); }
  // Cheap change fingerprint for change-driven refreshes: 'size:mtimeMs' (or '' when absent).
  // 'wiki' is a directory in the per-file layout; its sig is every file's stat. The board dir
  // would cost a 550+-file stat walk per poll on the real board (t_8d586961), so its sig is one
  // dir stat plus this instance's write generation: every task write goes through
  // _writeFileSync, which renames through the dir and bumps its mtime, and same-process writes
  // additionally bump _tgen (mtime granularity can swallow two writes in one tick).
  sigFile(name) {
    if ((name === 'board' || name === 'wiki') && this.cache && !this.cache.closed) return this.cache.sectionSig(name);
    if (name === 'wiki') return this._sectionSig('wiki');
    if (name === 'board') { try { const st = fs.statSync(this.tasksDir()); return this._tgen + ':' + st.size + ':' + st.mtimeMs; } catch { return ''; } }
    try { const st = fs.statSync(this.file(name)); return st.size + ':' + st.mtimeMs; } catch { return ''; }
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
  // cross-process mutex (mkdir is atomic; steal policy: LOCK / lockHolderDead above)
  // One-shot lock attempt for periodic background work on the main thread: never spins. Contention
  // (an agent's MCP process mid-write-burst) used to block the whole main thread in sleepSync(10)
  // slices here — getAll queued behind the spin and measured as a multi-second stall (Quinn
  // t_f4f6d15e). A stale lock is taken over with withLock's own steal policy (t_7e53747c); a live
  // holder means the caller skips this round (safe to retry next tick). Release removes only a
  // lock whose pid is still ours — a stealer that took it over mid-hold must keep its lock.
  withLockTry(fn) {
    const lock = path.join(this.dir, '.lock');
    try { fs.mkdirSync(lock); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!lockHolderDead(lock)) return false;
      const stolen = lock + '.stolen.' + process.pid;
      try { fs.rmSync(stolen, { recursive: true, force: true }); fs.renameSync(lock, stolen); fs.rmSync(stolen, { recursive: true, force: true }); } catch { return false; }
      try { fs.mkdirSync(lock); } catch { return false; }
    }
    try {
      const tmp = path.join(lock, 'pid.' + process.pid + '.tmp');
      fs.writeFileSync(tmp, String(process.pid));
      fs.renameSync(tmp, path.join(lock, 'pid'));
    } catch {}
    // Same depth contract as withLock/withLockAsync (write-through hooks consult it).
    this._lockDepth = (this._lockDepth || 0) + 1;
    try { fn(); return true; } finally {
      this._lockDepth--;
      let ours = true;
      try { ours = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() === String(process.pid); }
      catch (e) { ours = e.code === 'ENOENT'; }
      if (ours) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
    }
  }
  // Async twin of withLock for the main process's own dispatch/run-end task writes: the WAIT for
  // a busy lock yields the event loop (setTimeout) instead of sleepSync(10)-spinning, so a burst
  // of agent MCP writes no longer freezes main while it queues (t_a2566d54 — getAll tail). The
  // critical section itself stays SYNCHRONOUS: `fn` must not await. Holding this lock across an
  // await would let the same process's sync writers self-deadlock (single thread: their
  // Atomics.wait spin would block the very continuation that would release us). Same steal policy
  // and pid-checked release as the sync lock.
  withLockAsync(fn) {
    const lock = path.join(this.dir, '.lock');
    const start = Date.now();
    const attempt = () => {
      try { fs.mkdirSync(lock); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (Date.now() - start > LOCK.waitMs && lockHolderDead(lock)) {
          const stolen = lock + '.stolen.' + process.pid;
          try { fs.rmSync(stolen, { recursive: true, force: true }); fs.renameSync(lock, stolen); fs.rmSync(stolen, { recursive: true, force: true }); return attempt(); } catch {}
        }
        if (Date.now() - start > LOCK.waitMs + 30000) throw new Error('store lock busy (async wait timed out)');
        return null; // still busy: keep waiting
      }
      try {
        try {
          const tmp = path.join(lock, 'pid.' + process.pid + '.tmp');
          fs.writeFileSync(tmp, String(process.pid));
          fs.renameSync(tmp, path.join(lock, 'pid'));
        } catch {}
        // Same depth contract as withLock: write-through hooks fire inside this lock and consult
        // _lockDepth to skip the re-entrant _ensureBoard/_ensureWiki baselines.
        this._lockDepth = (this._lockDepth || 0) + 1;
        try { return fn(); }
        finally {
          this._lockDepth--;
          let ours = true;
          try { ours = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() === String(process.pid); } catch (e) { ours = e.code === 'ENOENT'; }
          if (ours) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
        }
      } catch (e) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
        throw e;
      }
    };
    const run = () => { const r = attempt(); if (r !== null) return Promise.resolve(r); return new Promise((res) => setTimeout(res, 10)).then(run); };
    return run();
  }
  withLock(fn) {
    const lock = path.join(this.dir, '.lock');
    const start = Date.now();
    for (;;) {
      try { fs.mkdirSync(lock); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (Date.now() - start > LOCK.waitMs && lockHolderDead(lock)) {
          // Take the lock over with a RENAME: atomic, so of two simultaneous stealers exactly
          // one wins (rmSync would let the second delete the first's fresh lock instead).
          const stolen = lock + '.stolen.' + process.pid;
          try { fs.rmSync(stolen, { recursive: true, force: true }); fs.renameSync(lock, stolen); fs.rmSync(stolen, { recursive: true, force: true }); } catch {}
          continue;
        }
        sleepSync(10);
        continue;
      }
      try {
        const tmp = path.join(lock, 'pid.' + process.pid + '.tmp');
        fs.writeFileSync(tmp, String(process.pid));
        fs.renameSync(tmp, path.join(lock, 'pid'));
        // The dir can vanish under us (a steal raced the pid write): only a read-back that says
        // OUR pid makes us the holder; anything else goes back to contending.
        if (fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() === String(process.pid)) break;
      } catch {}
    }
    try { this._lockDepth = (this._lockDepth || 0) + 1; return fn(); } finally {
      this._lockDepth--;
      // Remove only a lock that is still ours: a stealer that took it over wrote its own pid, and
      // deleting the dir here would pull the live lock out from under it (the old rmdir bug).
      let ours = true;
      try { ours = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() === String(process.pid); }
      catch (e) { ours = e.code === 'ENOENT'; } // no pid file: ours only if our pid write never landed
      if (ours) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
    }
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
  // One more landed merge waits for the next restart. Collapses (t_7e590e54): every merge moves
  // the SAME pending restart to the new base tip ({sha}) and the count reads as the commits the
  // running build is behind — so "21 merges" can never pile up again. `behind` comes from the
  // merge site (meta.buildSha..sha); callers without it keep the plain one-merge-per-bump tally.
  bumpRestartPending({ sha = null, behind = null } = {}) {
    return this.withLock(() => {
      const m = this.read('project', null) || {};
      const rp = m.restartPending || {};
      const next = { ...rp, count: (Number(rp.count) || 0) + 1, since: rp.since || new Date().toISOString() };
      if (sha) {
        next.sha = sha;
        if (Number.isFinite(behind) && behind > 0) next.count = behind;
      }
      m.restartPending = next;
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
    let sig = '';
    try { const st = fs.statSync(path.join(this.tasksDir(), file)); sig = st.size + ':' + st.mtimeMs; } catch {}
    h[path.basename(file)] = { sig, hash: this._sha256(data) };
    this._saveHashes(h);
  }
  // Callers hold the .lock (all writes happen inside _withTasks/_migrate/withLock). Writes are
  // tmp+fsync+rename (atomic), serialized by the lock — the per-key write queue Cato asked for is
  // the lock itself. Write-through: the main-process cache gets the same bytes before the watcher
  // echo arrives, so the echo is a hash no-op (never a duplicate delta).
  _writeTask(t) {
    const data = JSON.stringify(t, null, 2) + '\n';
    this._writeFileSync(this.taskFile(t.id), data);
    this._recordHash(t.id + '.json', data);
    if (this._tcache) this._tcache.delete(t.id + '.json'); // same-ms + same-size writes would fool the stat key
    this._afterTaskWrite();
    if (this.cache && !this.cache.closed) this.cache.noteTaskPut(t, data);
  }
  _unlinkTask(tid) {
    try { fs.unlinkSync(this.taskFile(tid)); } catch {}
    if (this._tcache) this._tcache.delete(tid + '.json');
    this._afterTaskWrite();
    const h = this._readHashes();
    if (h && h[tid + '.json']) { delete h[tid + '.json']; this._saveHashes(h); }
    if (this.cache && !this.cache.closed) this.cache.noteTaskDelete(tid);
  }
  // Board-signature bookkeeping shared by every task write: the generation invalidates sig/memo
  // holders immediately, and _ownDir snapshots the dir stat AFTER the rename so listTasks can
  // tell "the dir only moved because I wrote" (fast path) from "someone else wrote" (rescan).
  _afterTaskWrite() {
    this._tgen = (this._tgen || 0) + 1;
    try { const st = fs.statSync(this.tasksDir()); this._ownDir = st.size + ':' + st.mtimeMs; } catch { this._ownDir = ''; }
  }
  _taskFiles() { try { return fs.readdirSync(this.tasksDir()).filter((f) => !f.startsWith('.') && f.endsWith('.json')).sort(); } catch { return []; } }
  // Readers race writers by design (agents cat/jq these files directly), so any single file may
  // be missing or half-swapped: tolerate and skip instead of failing the whole listing.
  // Parsed-task cache (t_8d586961): with a 550+ task board, every board change — i.e. most
  // refreshes while agents stream — re-read and re-parsed all task files in listTasks, the
  // single biggest main-process IPC cost under load (~100ms per getAll). Entries are keyed by
  // the file's size:mtime stat pair, so only files whose stat changed are re-read; a read that
  // raced a writer between stat and read is returned but not cached, and failed parses are
  // never cached (half-swapped files must stay skippable). Same-process writes drop their
  // entry in _writeTask/_unlinkTask. Callers treat the returned tasks as read-only snapshots —
  // every mutation goes through _withTasks, which persists what it changes.
  _readTaskFile(f) {
    const p = path.join(this.tasksDir(), f);
    let st; try { st = fs.statSync(p); } catch { if (this._tcache) this._tcache.delete(f); return null; }
    const sig = st.size + ':' + st.mtimeMs;
    const hit = this._tcache && this._tcache.get(f);
    if (hit && hit.sig === sig) return hit.task;
    let task; try { task = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { if (this._tcache) this._tcache.delete(f); return null; }
    try { const st2 = fs.statSync(p); if (st2.size + ':' + st2.mtimeMs === sig) (this._tcache || (this._tcache = new Map())).set(f, { sig, task, str: JSON.stringify(task) }); } catch {}
    return task;
  }
  // Read-modify-write over the whole task set under ONE lock hold. fn mutates the array in place
  // (push/splice/field edits); tasks whose JSON changed are rewritten, removed ids unlinked.
  // The before-image reuses the per-file cache's compact form (t_7e53747c): the old code
  // stringified every task twice per write, all inside the lock — every agent MCP call paid it,
  // and main-process writers queued behind those holds.
  _taskWritePass(fn) {
    return () => {
      const tasks = this._taskFiles().map((f) => this._readTaskFile(f)).filter(Boolean);
      const beforeIds = new Set(tasks.map((t) => t.id));
      const beforeStr = new Map();
      for (const t of tasks) {
        const hit = this._tcache && this._tcache.get(t.id + '.json');
        beforeStr.set(t, hit && hit.str !== undefined ? hit.str : JSON.stringify(t));
      }
      let r;
      try { r = fn(tasks); }
      catch (e) { this._tcache = this._tlast = null; this._ownDir = undefined; throw e; } // fn may have mutated cached tasks it never wrote
      for (const t of tasks) if (JSON.stringify(t) !== beforeStr.get(t)) this._writeTask(t);
      for (const t of tasks) beforeIds.delete(t.id);
      for (const tid0 of beforeIds) this._unlinkTask(tid0);
      return r;
    };
  }
  _withTasks(fn) {
    if (this.cache && !this.cache.closed) this.cache.prewarm();
    this._ensureBoard();
    return this.withLock(this._taskWritePass(fn));
  }
  // Async twin of _withTasks (see withLockAsync): same read/diff/write pass under the async lock.
  async _withTasksAsync(fn) {
    if (this.cache && !this.cache.closed) this.cache.prewarm();
    this._ensureBoard();
    return this.withLockAsync(this._taskWritePass(fn));
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
    for (const f of this._taskFiles()) {
      try {
        const fp = path.join(this.tasksDir(), f);
        const st = fs.statSync(fp);
        h[f] = { sig: st.size + ':' + st.mtimeMs, hash: this._sha256(fs.readFileSync(fp)) };
      } catch {}
    }
    try { this._saveHashes(h); } catch {}
  }
  _verifyTaskIntegrity() {
    // Try-lock, not spin (t_a2566d54): the verify is advisory — out-of-band edits are adopted with a
    // store-log line, and every sanctioned write maintains the hash map itself — so skipping the
    // round while an agent's MCP process holds the lock costs nothing. Spinning here put a
    // multi-second main-thread freeze on every first board load that raced a write burst (the
    // getAll tail that survived the dispatch fixes).
    this.withLockTry(() => {
      try {
        const hashes = this._readHashes();
        if (!hashes) { this._snapshotTaskHashes(); return; } // first open of a per-file store: adopt as baseline
        const seen = new Set();
        let changed = false;
        for (const f of this._taskFiles()) {
          seen.add(f);
          // Sig-keyed (t_7e53747c): while the size:mtime pair still matches the recorded hash the
          // content cannot have changed (every write renames) — skip the read+sha256. This loop
          // used to re-hash ALL task files under the lock on the first board call of EVERY new
          // process, and every agent run spawns a fresh board MCP process: a full board hash at
          // every run start held the lock while dispatches queued behind it.
          const prev = hashes[f];
          let sig = null;
          try { const st = fs.statSync(path.join(this.tasksDir(), f)); sig = st.size + ':' + st.mtimeMs; } catch { continue; }
          if (prev && typeof prev === 'object' && prev.sig === sig) continue;
          let h = null;
          try { h = this._sha256(fs.readFileSync(path.join(this.tasksDir(), f))); } catch { continue; }
          const prevHash = typeof prev === 'string' ? prev : prev && prev.hash;
          if (prev && prevHash !== h) this._logStore(`out-of-band edit: .squad/board/tasks/${f} was modified outside the board tools; adopting the file as-is`);
          else if (!prev) this._logStore(`out-of-band file: .squad/board/tasks/${f} appeared outside the board tools; adopting it as a task`);
          if (prevHash !== h || typeof prev === 'string') { hashes[f] = { sig, hash: h }; changed = true; } // plain-string entries upgrade too
        }
        for (const f of Object.keys(hashes)) if (!seen.has(f)) { this._logStore(`out-of-band delete: .squad/board/tasks/${f} is gone`); delete hashes[f]; changed = true; }
        if (changed) this._saveHashes(hashes);
      } catch {}
    });
  }
  _verifyWikiIntegrity() {
    // Try-lock, not spin — same contract as _verifyTaskIntegrity (t_a2566d54).
    this.withLockTry(() => {
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
      if (!String(n.name || '').trim()) node.name = defaultName(node.id, node.role, t.nodes);
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
    // The one delete path (human IPC; retire_agent lands here after its own reassign). Guards first:
    // the core is not deletable, and an agent owning an in_progress task may be running it right now
    // (refusing, like retire_agent, avoids two workers on one task). Remaining open tasks go to the
    // first incoming edge source (the manager), else the team core — never stranded on a deleted
    // node; done tasks keep their assignee as history.
    const node = this.getTeam().nodes.find((n) => n.id === nid);
    if (node) {
      if (node.core) throw new Error('cannot delete the core agent');
      const inProg = this.listTasks({ assignee: nid, status: 'in_progress' });
      if (inProg.length) throw new Error(`refused: "${node.name}" still owns ${inProg.length} in_progress task(s) (${inProg.map((t) => t.id).join(', ')}) — stop the run or let it finish first`);
      const open = this.listTasks({ assignee: nid }).filter((t) => t.status !== 'done');
      if (open.length) {
        const to = (this.getTeam().edges.find((e) => e.to === nid) || {}).from || (this.getTeam().nodes.find((n) => n.core) || {}).id;
        if (!to) throw new Error('no manager or core to take the open tasks of "' + node.name + '"');
        for (const tk of open) this.updateTask(tk.id, { assignee: to });
      }
    }
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
    // Cached path (t_479e7290): warm reads are pure memory. The cache loads + migrates once per
    // project dir; the memo tiers in _tlistWhole are only for uncached (MCP/scripts) Stores.
    if (this.cache && !this.cache.closed) return this.cache.listTasks(filter);
    let ts = this._tlistWhole();
    // Filters AND together (same shape as board-cache.listTasks) — an early return on status
    // used to drop assignee, making retire_agent's todo-reassign reassign the whole board.
    if (filter.status) ts = ts.filter((t) => t.status === filter.status);
    if (filter.assignee) ts = ts.filter((t) => t.assignee === filter.assignee);
    return ts;
  }
  // The whole board, sorted, memoized (t_8d586961): with a 550+ task board every listing used to
  // readdir + read + parse all task files, and the orchestrator's per-tick filtered scans kept
  // that hot from the main process while agents stream — getAll's p50 grew to ~100ms and clicks
  // queued behind it. Three tiers, cheapest first:
  //  - generation+dir memo: nothing changed anywhere we can see — return the last build.
  //  - same-writer fast path: the dir moved but only under our own pen (every task write renames
  //    through the dir and _afterTaskWrite re-stat'd it): collect the per-file cache, re-reading
  //    just the entries a write dropped. One readdir + one array build, no stats, no reads.
  //  - scan: cold, or a dir entry moved that we did not write (another Store instance/process):
  //    stat-scan every file; the per-file stat cache makes it a stats-only pass, gone files are
  //    pruned. NB an out-of-contract IN-PLACE write (no rename, no Store) moves no dir entry and
  //    stays unseen until the next rename in the dir — the board contract routes edits through
  //    the board tools, which always rename. Callers treat results as read-only snapshots;
  //    mutations go through _withTasks, which persists what it changes.
  _tlistWhole() {
    this._ensureBoard();
    let dst; try { dst = fs.statSync(this.tasksDir()); } catch { dst = null; }
    const dirKey = dst ? dst.size + ':' + dst.mtimeMs : '';
    const key = (this._tgen || 0) + ':' + dirKey;
    if (this._tlast && this._tlast.key === key) return this._tlast.tasks;
    const files = this._taskFiles();
    let ts;
    if (this._tlast && this._ownDir === dirKey) {
      ts = files.map((f) => { const hit = this._tcache && this._tcache.get(f); return hit ? hit.task : this._readTaskFile(f); }).filter(Boolean);
    } else {
      if (this._tcache) { const live = new Set(files); for (const f of [...this._tcache.keys()]) if (!live.has(f)) this._tcache.delete(f); }
      ts = files.map((f) => this._readTaskFile(f)).filter(Boolean);
      this._ownDir = dirKey;
    }
    ts = ts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    this._tlast = { key, files, tasks: ts };
    return ts;
  }
  getTask(tid) {
    if (this.cache && !this.cache.closed) return this.cache.getTask(tid);
    this._ensureBoard(); return this._readTaskFile(tid + '.json') || undefined;
  }
  createTask({ title, description = '', assignee = null, createdBy = 'human', parentId = null, blockedBy = [], priority, attachments = null }) {
    if (!title) throw new Error('title required');
    const now = new Date().toISOString();
    const task = { id: id('t'), title, description, assignee, status: 'todo', priority: C.normalizePriority(priority), createdBy, parentId, blockedBy: [], comments: [], createdAt: now, updatedAt: now };
    const atts = sanitizeAttachments(attachments);
    if (atts) task.attachments = atts;
    this._withTasks((tasks) => { task.blockedBy = C.validateDeps(task.id, blockedBy, tasks); tasks.push(task); });
    return task;
  }
  updateTask(tid, patch, opts) {
    let t = this._updateTask(tid, patch);
    // Every approval request also shows up in the human inbox.
    if (patch.awaitingApproval && !this.listInbox({ status: 'open' }).some((i) => i.kind === 'approval' && i.taskId === tid)) this.addInbox({ kind: 'approval', taskId: tid, nodeId: t.assignee, question: `Approve "${t.title}"?`, choices: ['approve'] });
    // Never strand finished work in its worktree branch: auto-merge on done, or park as merge_conflict.
    // Async fire-and-forget (t_5a78aa95): the old sync gate ran the whole unit suite on the caller's
    // thread (minutes on the app's main process). The merge queue serializes merges; the post-gate
    // state lands via the queue's own writes. Returns the post-FLIP view — await updateTaskAsync /
    // mergeTask (or store.mergeQueue) for the post-gate state.
    if (patch.status === 'done' && t.worktreePath && t.worktreeBranch) this._mergeOnDone(t, opts).catch((e) => { try { this._logStore('merge gate error: ' + (e && e.message || e)); } catch {} });
    return t;
  }
  // Async twin of _updateTask (dispatch/run-end writes on the main process: see withLockAsync).
  // Uncontended, the write completes SYNCHRONOUSLY in the caller's span — no await suspension —
  // so dispatch invariants like "slot reserved ⇒ agent marked, disk status written" stay atomic
  // exactly as with the sync write (tests and the sweep observe no intermediate states). Only a
  // contended lock defers to the yielding wait, which is the case that never froze the loop before.
  _updateTaskAsync(tid, patch) {
    const body = (tasks) => {
      const t = tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      if (patch.status && !STATUSES.includes(patch.status)) throw new Error('bad status ' + patch.status);
      if (patch.blockedBy !== undefined) t.blockedBy = C.validateDeps(tid, patch.blockedBy, tasks);
      if (patch.status && patch.status !== 'review') t.awaitingApproval = false;
      if (patch.priority !== undefined) t.priority = C.normalizePriority(patch.priority);
      for (const k of ['title', 'description', 'assignee', 'status', 'sessionId', 'sessions', 'iterations', 'awaitingApproval', 'reopenCount', 'worktreePath', 'worktreeBranch', 'isConflictResolution', 'conflictBranch', 'conflictRetries', 'parkedForHuman', 'stallRecoveries', 'drainCuts', 'redMaster', 'reviewStage', 'reviewWakes', 'reviewWakeAt', 'autoResumeTried', 'noAutoResume', 'stuckAlertFor']) if (patch[k] !== undefined) t[k] = patch[k];
      t.updatedAt = new Date().toISOString();
      for (let c = t; c.status === 'done' && c.parentId;) {
        const parent = tasks.find((x) => x.id === c.parentId);
        if (!parent || parent.status === 'done' || tasks.some((x) => x.parentId === parent.id && x.status !== 'done')) break;
        parent.status = 'done'; parent.awaitingApproval = false; parent.updatedAt = t.updatedAt; c = parent;
      }
      return t;
    };
    const pass = this._taskWritePass(body);
    if (this.cache && !this.cache.closed) this.cache.prewarm();
    this._ensureBoard();
    let out, done = false;
    try { done = this.withLockTry(() => { out = pass(); }); } catch (e) { throw e; }
    if (done) return Promise.resolve(out);
    return this.withLockAsync(pass);
  }
  // Fire-and-forget twin used by the dispatch path (t_a2566d54): with the lock free it takes the
  // EXACT sync updateTask path (hooks, merge gate, test mocks — master behavior bit-for-bit).
  // Only a busy lock defers: the write lands via the yielding async lock a few ms later instead of
  // sleepSync-spinning the main thread behind an agent MCP write burst (the getAll tail). Every
  // consumer of these writes — agent MCP reads, board UI, review chains — reads strictly after.
  // Returns the task view at call time on the deferred path; errors surface in the store log.
  updateTaskSoon(tid, patch, opts) {
    const lock = path.join(this.dir, '.lock');
    let free = false;
    try { fs.mkdirSync(lock); free = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (free) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
    if (free) return this.updateTask(tid, patch, opts);
    const pass = this._taskWritePass((tasks) => {
      const t = tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      if (patch.status && !STATUSES.includes(patch.status)) throw new Error('bad status ' + patch.status);
      if (patch.blockedBy !== undefined) t.blockedBy = C.validateDeps(tid, patch.blockedBy, tasks);
      if (patch.status && patch.status !== 'review') t.awaitingApproval = false;
      if (patch.priority !== undefined) t.priority = C.normalizePriority(patch.priority);
      for (const k of ['title', 'description', 'assignee', 'status', 'sessionId', 'sessions', 'iterations', 'awaitingApproval', 'reopenCount', 'worktreePath', 'worktreeBranch', 'isConflictResolution', 'conflictBranch', 'conflictRetries', 'parkedForHuman', 'stallRecoveries', 'drainCuts', 'redMaster', 'reviewStage', 'reviewWakes', 'reviewWakeAt', 'autoResumeTried', 'noAutoResume', 'stuckAlertFor']) if (patch[k] !== undefined) t[k] = patch[k];
      t.updatedAt = new Date().toISOString();
      for (let c = t; c.status === 'done' && c.parentId;) {
        const parent = tasks.find((x) => x.id === c.parentId);
        if (!parent || parent.status === 'done' || tasks.some((x) => x.parentId === parent.id && x.status !== 'done')) break;
        parent.status = 'done'; parent.awaitingApproval = false; parent.updatedAt = t.updatedAt; c = parent;
      }
      return t;
    });
    this.withLockAsync(pass).then((t) => {
      try {
        if (patch.awaitingApproval && !this.listInbox({ status: 'open' }).some((i) => i.kind === 'approval' && i.taskId === tid)) this.addInbox({ kind: 'approval', taskId: tid, nodeId: t.assignee, question: `Approve "${t.title}"?`, choices: ['approve'] });
        if (patch.status === 'done' && t.worktreePath && t.worktreeBranch) this._mergeOnDone(t, opts).catch((e) => { try { this._logStore('updateTaskSoon merge failed: ' + (e && e.message || e)); } catch {} });
      } catch (e) { try { this._logStore('updateTaskSoon deferred hook failed: ' + e.message); } catch {} }
    }).catch((e) => { try { this._logStore('updateTaskSoon deferred write failed: ' + e.message); } catch {} });
    return this.getTask(tid);
  }
  async updateTaskAsync(tid, patch, opts) {
    let t = await this._updateTaskAsync(tid, patch);
    if (patch.awaitingApproval && !this.listInbox({ status: 'open' }).some((i) => i.kind === 'approval' && i.taskId === tid)) this.addInbox({ kind: 'approval', taskId: tid, nodeId: t.assignee, question: `Approve "${t.title}"?`, choices: ['approve'] });
    // The merge gate awaits here (agents' board MCP flips done through this and reads the
    // post-gate state); sync updateTask fires it in the background instead.
    if (patch.status === 'done' && t.worktreePath && t.worktreeBranch) t = await this._mergeOnDone(t, opts);
    return t;
  }
  // Merge a done task's squad/<id> branch into base — through the pre-merge test gate
  // (src/merge-gate.js, async since t_5a78aa95; the old synchronous gate froze the main process
  // for the whole suite): base is merged into the branch in its worktree, the unit suite runs on
  // exactly that tree, and only a green run lands the base.
  // opts flows into the gate ({runTests} / {testCmd} for tests and the human merge button;
  // production omits it and runs the real suite). On red/infra the task is reopened to its
  // assignee with the capped failing output. On conflict, abort, mark the task 'merge_conflict'
  // (not done) and hand the SAME branch to a follow-up conflict-resolution task (never a new
  // branch), so resolving it re-merges the original work instead of stranding it.
  // Human "merge now" (main.js taskMerge IPC): the same gated merge as a done flip, callable
  // in any task state; returns the task in its post-gate state.
  mergeTask(tid, opts) { return this._mergeOnDone(this.getTask(tid), { ...(opts || {}), mergeNow: true }); }
  // Double-merge guard (Cato t_f7c42eef #2): merges in this process run ONE at a time through
  // this._mergeQueue, so a done→review→done re-flip or a double done-flip queues behind a live
  // gate instead of racing it (the gate's cross-process merge.lock covers sibling processes, and
  // its ahead/base re-checks make an already-merged queue slot a cheap no-op).
  _mergeOnDone(t, opts = {}) {
    const run = () => this._mergeGateRun(t, opts);
    const prev = Promise.resolve(this._mergeQueue).catch(() => {});
    this._mergeQueue = prev.then(run, run);
    return this._mergeQueue;
  }
  async _mergeGateRun(t, opts = {}) {
    const tid = t.id;
    // Re-check after the queue wait: the flip that queued this merge may have been undone
    // meanwhile (review park, reopen) — only an explicit merge (human button) proceeds from a
    // non-done state.
    const cur = this.getTask(tid);
    if (!cur) return t;
    if (!opts.mergeNow && cur.status !== 'done') return cur;
    t = cur;
    this.commentTask(tid, 'system', `merge gate: running the unit suite on ${t.worktreeBranch} before merging into base${process.env.AGENTS_SQUAD_GATE_DISABLED ? ' (gate disabled — merging untested)' : ''}`);
    let r;
    try { r = await MG.gateMerge(t, opts); }
    catch (e) { return this._onMergeConflict(t, e); }
    if (r.refused) {
      // Dirty main checkout: park in review (not merge_conflict) so cleaning main and
      // re-marking done retries the same merge instead of spawning a resolve task.
      this._updateTask(tid, { status: 'review' });
      this.commentTask(tid, 'system', WT.dirtyMergeMessage(r.dirty));
      return this.getTask(tid);
    }
    if (r.merged) {
      const flaky = r.gate && r.gate.flaky && r.gate.flaky.length ? `green after one flaky rerun (${r.gate.flaky.join(', ')})` : (r.gate && r.gate.state) || 'green';
      this.commentTask(tid, 'system', `auto-merged ${t.worktreeBranch} into ${r.base} (merge gate: npm test ${flaky}${r.gate && r.gate.tests ? `, ${r.gate.tests} tests` : ''})`);
      // A landed merge no longer restarts the app; it only counts toward the next scheduled one
      // (conflicts/refusals are not landed work — the count covers merges that actually merged).
      // Collapse (t_7e590e54): point the one pending restart at the new base tip; the count is the
      // commits the running build (meta.buildSha, written by the app at boot) is behind. Without a
      // buildSha — fresh store, or the merge ran where the boot sha was never recorded — the plain
      // merge tally holds, and a failed rev-list falls back the same way.
      // Packaged build (devMode=false): nothing can ever restart, so merges count nothing —
      // otherwise the tally would grow forever and a later dev run of the same project would
      // inherit a bogus "commits behind".
      if (this.devMode) {
        let bump = { sha: r.sha || null };
        try {
          const build = (this.meta() || {}).buildSha;
          if (bump.sha && build && build !== bump.sha) {
            const n = await WT.commitsBehind(r.root, build, bump.sha);
            if (n > 0) bump.behind = n;
          }
        } catch {}
        this.bumpRestartPending(bump);
      }
      if (r.reason === 'tree-mismatch') {
        // Landed, but the base tree is not the tree we tested — someone bypassed the lock.
        MG.ensureRedMasterTask(this, { root: r.root, tests: ['(post-merge tree mismatch — base changed outside the gate)'], base: r.base, source: 'post-merge verification', lastMergedTask: t.id, lastMergedBranch: t.worktreeBranch });
      } else {
        MG.markMasterGreen(this, { root: r.root, tree: r.gate && r.gate.tree, base: r.base, source: 'merge gate', lastMergedTask: t.id, lastMergedBranch: t.worktreeBranch });
      }
      // Landed: the worktree dir is disposable now — the branch (kept) recreates it on reopen.
      await this._cleanupWorktree(t);
      return this.getTask(tid);
    }
    if (!r.gate || r.gate.state === 'skipped') {
      this.commentTask(tid, 'system', `nothing merged: no commits on ${t.worktreeBranch} ahead of ${r.base}`);
      // Branch is already an ancestor of base (nothing to lose) — drop the dir too. Fields stay:
      // a repeated done-flip then walks the (cheap) worktree-gone guard and still comments.
      await this._cleanupWorktree(t);
      return this.getTask(tid);
    }
    // Blocked by the gate: reopen to the assignee with the capped failing output.
    MG.recordGateBlock(this, { root: r.root, taskId: tid, tests: r.names || [] });
    if (r.reason === 'master-red') {
      MG.ensureRedMasterTask(this, { root: r.root, tests: r.names, output: r.output, base: r.base, source: 'merge gate', detail: `detected while merging ${t.worktreeBranch}`, lastMergedTask: undefined });
      this.commentTask(tid, 'system', `merge gate: NOT merged — the base branch (${r.base}@${String(r.baseSha || '').slice(0, 8)}) itself fails the unit suite, so this may not be your branch's fault. A P0 fix task has been created.\nFailing on base:\n${blockPayload(r)}`);
    } else if (r.reason === 'infra') {
      this.commentTask(tid, 'system', `merge gate: NOT merged — the unit suite could not run (infrastructure error, retried once; not counted as a test failure). Fix the environment or retry.\n${blockPayload(r)}`);
    } else {
      this._updateTask(tid, { status: 'todo', reopenCount: (t.reopenCount || 0) + 1 });
      this.commentTask(tid, 'system', `merge gate: tests failed, task reopened: fix and mark done to retry.\nFailing tests:\n${blockPayload(r)}`);
      return this.getTask(tid);
    }
    this._updateTask(tid, { status: 'todo', reopenCount: (t.reopenCount || 0) + 1 });
    return this.getTask(tid);
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
  // Worktree lifecycle (t_9b662983): once a branch is safely in base (or was already an ancestor),
  // the worktree dir goes away; removeWorktree refuses dirty/unmerged trees, so a retained
  // worktree here means real uncommitted work — flag it, never force. The task's worktreePath/
  // branch fields stay: they name the kept branch (ensureWorktree recreates the dir from it if
  // the task reopens), and a repeated done-flip hits the worktree-gone guard instead of failing.
  async _cleanupWorktree(t) {
    try {
      const r = await WT.removeWorktree(t);
      if (!r.removed) return;
      this.commentTask(t.id, 'system', `worktree removed after merge (branch ${t.worktreeBranch} kept for reopen)`);
    } catch (e) {
      try { this.commentTask(t.id, 'system', `worktree retained: ${String(e.message).slice(0, 200)}`); } catch {}
    }
  }
  // Unmerged squad/<id> branches across every git repo referenced by a task's worktreePath.
  async listUnmergedBranches() {
    const roots = new Set(this.listTasks().filter((t) => t.worktreePath).map((t) => path.resolve(t.worktreePath, '..', '..', '..')));
    const out = [];
    for (const root of roots) out.push(...(await WT.unmergedSquadBranches(root)));
    return out;
  }
  _updateTask(tid, patch) {
    return this._withTasks((tasks) => {
      const t = tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      if (patch.status && !STATUSES.includes(patch.status)) throw new Error('bad status ' + patch.status);
      if (patch.blockedBy !== undefined) t.blockedBy = C.validateDeps(tid, patch.blockedBy, tasks);
      if (patch.status && patch.status !== 'review') t.awaitingApproval = false;
      if (patch.priority !== undefined) t.priority = C.normalizePriority(patch.priority);
      for (const k of ['title', 'description', 'assignee', 'status', 'sessionId', 'sessions', 'iterations', 'awaitingApproval', 'reopenCount', 'worktreePath', 'worktreeBranch', 'isConflictResolution', 'conflictBranch', 'conflictRetries', 'parkedForHuman', 'stallRecoveries', 'drainCuts', 'redMaster', 'reviewStage', 'reviewWakes', 'reviewWakeAt', 'autoResumeTried', 'noAutoResume', 'stuckAlertFor']) if (patch[k] !== undefined) t[k] = patch[k];
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
  commentTask(tid, author, text, attachments = null) {
    return this._withTasks((tasks) => {
      const t = tasks.find((x) => x.id === tid); if (!t) throw new Error('no task ' + tid);
      const c = { author, text, at: new Date().toISOString() };
      const atts = sanitizeAttachments(attachments);
      if (atts) c.attachments = atts;
      t.comments.push(c); t.updatedAt = c.at; return c;
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
  // Stat-keyed cache for messages.json (t_a2566d54): every getAll parsed the whole file (~0.7MB
  // and growing). Same size:mtime contract as the task/runs caches — out-of-band edits bust it,
  // our own writes invalidate up front.
  _readMsgs() {
    let st; try { st = fs.statSync(this.file('messages')); } catch { return []; }
    const sig = st.size + ':' + st.mtimeMs;
    if (this._msgsMemo && this._msgsMemo.sig === sig) return this._msgsMemo.ms;
    let ms; try { ms = JSON.parse(fs.readFileSync(this.file('messages'), 'utf8')).messages || []; } catch { return []; }
    this._msgsMemo = { sig, ms };
    return ms;
  }
  listMessages(filter = {}) {
    let ms = this._readMsgs().slice();
    if (filter.to) ms = ms.filter((m) => m.to === filter.to);
    if (filter.from) ms = ms.filter((m) => m.from === filter.from);
    return ms;
  }
  sendMessage({ from, to, text, taskId = null, attachments = null, wake = false }) {
    if (!text) throw new Error('text required');
    const m = { id: id('m'), from, to, text, taskId, at: new Date().toISOString(), read: false };
    const atts = sanitizeAttachments(attachments);
    if (atts) m.attachments = atts;
    if (wake) m.wake = true; // the one message kind that may wake an idle agent (see orchestrator.wakeUnread)
    this._msgsMemo = null;
    this.update('messages', { messages: [] }, (d) => { d.messages.push(m); });
    return m;
  }
  markMessagesRead(ids, read = true) {
    const set = new Set(ids); if (!set.size) return;
    this._msgsMemo = null;
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
    if (this.cache && !this.cache.closed) return this.cache.listWiki();
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
    if (this.cache && !this.cache.closed) this.cache.prewarm();
    this._ensureWiki();
    return this.withLock(() => {
      const idx = this._readWikiIndex();
      idx[title] = this._writeWikiPage(title, content, author, new Date().toISOString());
      this._saveWikiIndex(idx);
      if (this.cache && !this.cache.closed) this.cache.noteWikiSync(idx[title].slug);
      return { title, content, author, updatedAt: idx[title].updatedAt };
    });
  }
  deleteWiki(title) {
    if (this.cache && !this.cache.closed) this.cache.prewarm();
    this._ensureWiki();
    this.withLock(() => {
      const idx = this._readWikiIndex();
      const e = idx[title];
      delete idx[title];
      this._saveWikiIndex(idx);
      if (e) { try { fs.unlinkSync(path.join(this.wikiDir(), e.slug + '.md')); } catch {} }
      if (this.cache && !this.cache.closed) this.cache.noteWikiSync(e ? e.slug : null);
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
  // runs.json is rewritten whole on every run record and re-read whole by every consumer
  // (listRuns, ledger, modelStats, usageStatus, the delta pump) — at board scale that was a
  // per-run-event main-process stall (Quinn t_f4f6d15e: ~1.8s getAll outliers at run start and
  // finish, growing with board age). Two changes: the parsed array is cached behind the same
  // size:mtime stat key the task cache uses (an out-of-band edit busts it), and writes are
  // compact — runs are machine-read, pretty-printing tripled the stringify+write cost. Same-ms
  // same-size rewrites can't serve stale data because writes are write-through (t_8d586961
  // deletes instead; here we know the bytes). Callers treat the returned records as read-only
  // snapshots, like listTasks.
  _runsCached() {
    let st; try { st = fs.statSync(this.file('runs')); } catch {
      // No file yet: a seeded memo (sig null) is this process's memory truth until the first
      // flush installs the real stat key — addRun must be immediately visible to listRuns.
      return this._runsMemo && this._runsMemo.sig === null ? this._runsMemo.runs : null;
    }
    const sig = st.size + ':' + st.mtimeMs;
    if (this._runsMemo && this._runsMemo.sig === sig) return this._runsMemo.runs;
    let d; try { d = JSON.parse(fs.readFileSync(this.file('runs'), 'utf8')); } catch { return null; }
    this._runsMemo = { sig, runs: d.runs || [] };
    return this._runsMemo.runs;
  }
  _writeRuns(runs) {
    const tmp = this.file('runs') + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ runs }));
      fs.renameSync(tmp, this.file('runs'));
    } catch (e) {
      // The caller already mutated the shared cached array; the disk never saw it. Drop the memo
      // so the next read re-parses the file instead of serving a phantom record (t_7e53747c).
      this._runsMemo = null;
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e;
    }
    try { const st = fs.statSync(this.file('runs')); this._runsMemo = { sig: st.size + ':' + st.mtimeMs, runs }; } catch { this._runsMemo = null; }
  }
  // Run records are telemetry: the orchestrator records a run at start and rewrites it with proxy
  // cost at the end — exactly when agents' MCP processes hold the store lock in write bursts.
  // Persisting synchronously sleepSync-spun the main thread behind those bursts, and getAll queued
  // behind the spin as a 1.3-1.6s stall (Argo t_44b45119). Memory updates synchronously (listRuns/
  // getAll never see a gap); the disk write retries from an unref'd timer instead. A hard crash
  // may lose the last pending records — runs are telemetry, tasks are not. Under the lock the
  // flush re-reads the file and re-applies this process's pending records, so a second writer's
  // records can never be dropped by our write.
  _persistRunsSoon(delayMs = 5) {
    if (this._runsFlushTimer || !this._runsPending || !this._runsPending.size) return;
    const t = setTimeout(() => {
      this._runsFlushTimer = null;
      if (!this._runsPending || !this._runsPending.size) return;
      this._runsFlushDelay = Math.min((this._runsFlushDelay || 5) * 2, 500);
      if (this.flushRunsNow()) this._runsFlushDelay = 5;
      else this._persistRunsSoon(this._runsFlushDelay);
    }, delayMs);
    if (t.unref) t.unref();
    this._runsFlushTimer = t;
  }
  flushRunsNow() {
    if (!this._runsPending || !this._runsPending.size) return true;
    let ok = false;
    try {
      this.withLockTry(() => {
        try {
          let fileRuns;
          try {
            // Skip the cross-instance merge re-read when the file still matches our own write
            // (the common case) — the full parse is only for records another process may have added.
            let st; try { st = fs.statSync(this.file('runs')); } catch { st = null; }
            const sig = st ? st.size + ':' + st.mtimeMs : null;
            if (this._runsMemo && this._runsMemo.sig !== null && sig === this._runsMemo.sig) fileRuns = this._runsMemo.runs;
            else fileRuns = JSON.parse(fs.readFileSync(this.file('runs'), 'utf8')).runs || [];
          } catch { fileRuns = []; }
          const byId = new Map();
          fileRuns.forEach((x, i) => { if (x) byId.set(x.id != null ? x.id : '#idx' + i, x); }); // id-less records keep their slot
          for (const [k, r] of this._runsPending) byId.set(k, r);
          let fresh = [...byId.values()];
          if (fresh.length > 5000) fresh = fresh.slice(fresh.length - 5000);
          this._writeRuns(fresh);
          this._runsPending.clear();
          ok = true;
        } catch { ok = false; } // _writeRuns already dropped the memo; the retry loop takes it from here
      });
    } catch { ok = false; } // even the lock is unwritable (read-only dir): stay pending, never throw
    return ok;
  }
  _stageRun(r) {
    if (!this._runsPending) this._runsPending = new Map();
    this._runsPending.set(r.id != null ? r.id : 'anon-' + (++this._runsAnon || (this._runsAnon = 1)), r);
    // Fast path: uncontended locks write through immediately (cross-instance readers stay exact).
    // Contended — the agent MCP-burst case that sleepSync-stalled getAll — defers to the timer.
    if (this._runsFlushTimer) return; // a retry is already scheduled; it takes this record too
    if (!this.flushRunsNow()) this._persistRunsSoon();
  }
  addRun(r) {
    let runs = this._runsCached();
    if (!runs) { runs = []; if (!this._runsMemo) this._runsMemo = { sig: null, runs }; } // no file yet: memory is truth
    runs.push(r); if (runs.length > 5000) runs.splice(0, runs.length - 5000);
    this._stageRun(r);
    return r;
  }
  // Re-persist one run after a late in-place update (proxy cost): replaces by id, appends when the
  // run is not present (trimmed the same way), so resolveProxyCost never duplicates or loses it.
  replaceRun(r) {
    let runs = this._runsCached();
    if (!runs) { runs = []; if (!this._runsMemo) this._runsMemo = { sig: null, runs }; }
    const i = runs.findIndex((x) => x.id === r.id);
    if (i >= 0) runs[i] = r; else { runs.push(r); if (runs.length > 5000) runs.splice(0, runs.length - 5000); }
    this._stageRun(r);
    return r;
  }
  listRuns(filter = {}) {
    let rs = this._runsCached();
    if (!rs) rs = this.read('runs', { runs: [] }).runs || [];
    for (const k of ['nodeId', 'taskId', 'billingSource', 'kind']) if (filter[k]) rs = rs.filter((r) => r[k] === filter[k]);
    return rs;
  }
  clearRuns() { this.withLock(() => this._writeRuns([])); }

  // ---- persisted orchestrator log (logs.jsonl, rotated to logs.jsonl.1 past LOG_LIMITS.rotateBytes) ----
  // O(1) per call: queue the line and arm the tick-end flush (see the buffer note at the top).
  // Each queued item also carries the index meta (at, nodeKey, byte length — log-index.js) the
  // flush needs for the sidecar offset index, so the hot path never re-parses the line.
  appendLog(l) {
    hookLogExitFlush();
    const st = logBufState(this.dir, this);
    const at = l.at || Date.now(); // stamped once, so the index meta matches the serialized line
    const line = C.logLine({ ...l, at }) + '\n';
    st.lines.push({ s: line, len: Buffer.byteLength(line), at, key: LI.nodeKeyOf(l.nodeId) });
    st.bytes += st.lines[st.lines.length - 1].len;
    if (st.bytes >= LOG_LIMITS.flushBytes) this._flushLogs();
    else if (!st.armed && !st.flushing) {
      st.armed = true;
      setImmediate(() => { st.armed = false; this._flushLogs(); });
    }
  }
  // Lines accepted but not yet confirmed on disk, oldest first — in-flight (write pending) ones
  // included, so readers in THIS process (orchestrator incremental logs()) never see a gap between
  // "left the buffer" and "visible in the file". Read-only; the flush consumes the queues itself.
  pendingLogLines() {
    const st = LOG_BUFS.get(path.resolve(this.dir));
    if (!st || (!st.flying.length && !st.lines.length)) return [];
    try { return st.flying.concat(st.lines).map((o) => JSON.parse(o.s)); } catch { return []; }
  }
  // One async append per batch, then the matching index records (log-index.js). A batch in flight
  // never blocks appendLog: lines landing during the await stay in st.lines for the tail re-flush.
  // `flushing` also keeps two appends from racing into an out-of-order file. st.flying is cleared
  // only after the index append confirms, so an in-flight batch is never read twice (readers dedup
  // the landed tail against the buffer; see getSessionLog). Errors requeue the batch (front, order
  // preserved) and retry on the next flush — a failing disk must not take down the caller.
  _flushLogs() {
    const st = logBufState(this.dir, this);
    if (st.flushing) return;
    if (!st.lines.length) return;
    st.flushing = true;
    st.flying = st.lines.splice(0); // handed to the write, still visible to readers until confirmed
    st.bytes = 0;
    const batch = st.flying;
    const data = batch.map((o) => o.s).join('');
    (async () => {
      try {
        const file = this.logFile();
        const size0 = await fsp.stat(file).then((s) => s.size, () => 0);
        await fsp.appendFile(file, data);
        await this._appendLogIndex(batch, size0); // records point at the bytes confirmed above
        st.size = size0 + Buffer.byteLength(data);
        if (st.size >= LOG_LIMITS.rotateBytes) {
          // Our in-memory size under-counts what other processes append, so confirm against the
          // real file; a foreign rotation already shrank it. The rename itself goes under the lock.
          try { st.size = (await fsp.stat(file)).size; } catch { st.size = 0; }
          if (st.size >= LOG_LIMITS.rotateBytes) { this._rotateLogs(); st.size = 0; }
        }
        st.flying = []; // fully confirmed (data + index): readers stop merging them from the buffer
      } catch {
        st.size = null; // unknown again: next flush re-stats
        st.lines = st.flying.concat(st.lines); // put the batch back, order preserved, retry next flush
        st.flying = [];
        st.bytes = st.lines.reduce((a, o) => a + o.len, 0);
      } finally {
        st.flushing = false;
        if (st.lines.length) this._flushLogs();
      }
    })();
  }
  // Best-effort tail append of the batch's index records. st.idxLive tracks whether the live
  // index exists: false is re-checked every batch (a background rebuild may create it), and an
  // append error drops the index — getSessionLog falls back to its gap scan and rebuilds.
  async _appendLogIndex(batch, startOffset) {
    const st = logBufState(this.dir, this);
    const idxFile = LI.idxPath(this.logFile());
    if (st.idxLive !== true) st.idxLive = await fsp.stat(idxFile).then(() => true, () => false);
    if (!st.idxLive) return;
    const flat = [];
    let off = startOffset;
    for (const o of batch) { flat.push(off, o.at, o.len, o.key); off += o.len; }
    await LI.appendRows(this.logFile(), flat);
  }
  // Rotation instead of the old read-and-rewrite trim: the full file becomes the single backup and
  // the live file starts empty. Under the lock because every Store process may rotate; the fresh
  // stat inside decides (a foreign rotation already reset the size). The backup takes its index
  // with it; a backup without one just gap-scans until its first read rebuilds an index.
  _rotateLogs() {
    this.withLock(() => {
      let size = 0;
      try { size = fs.statSync(this.logFile()).size; } catch { return; }
      if (size < LOG_LIMITS.rotateBytes) return;
      try { fs.rmSync(this.logFile() + '.1', { force: true }); } catch {}
      try { fs.rmSync(this.logFile() + '.1.idx', { force: true }); } catch {}
      try { fs.renameSync(this.logFile(), this.logFile() + '.1'); } catch { return; }
      try { fs.renameSync(LI.idxPath(this.logFile()), this.logFile() + '.1.idx'); } catch {}
      const st = LOG_BUFS.get(path.resolve(this.dir));
      if (st) st.idxLive = null; // the live index just moved away: re-check on the next flush
      LI.dropIndex(this.logFile());
      LI.dropIndex(this.logFile() + '.1');
    });
  }
  // level (info/warn/error, derived from kind via TL.levelOf) lets the UI default its filter to warn+error.
  // Tail reads: backward from EOF in growing windows until `limit` complete lines are available, so a
  // multi-MB log costs one small read, not a full parse. The rotated backup tops up a short read (the
  // live file is empty right after a rotation), and this process's queued + in-flight lines are merged
  // last, so append -> read stays coherent within a process without waiting for the flush. When the
  // in-flight write has already landed at the file tail (write visible, splice pending) it is counted
  // once — dropped from the disk side, read from the buffer.
  readLogs(limit = 2000) {
    try {
      let out = this._readLogTail(this.logFile(), limit);
      if (out.length < limit) out = this._readLogTail(this.logFile() + '.1', limit === Infinity ? Infinity : limit - out.length).concat(out);
      const st = LOG_BUFS.get(path.resolve(this.dir));
      if (st) {
        const flying = st.flying;
        if (flying.length && out.length >= flying.length) {
          const tail = out.slice(-flying.length);
          if (flying.every((o, i) => JSON.stringify(tail[i]) === o.s.replace(/\n$/, ''))) out = out.slice(0, out.length - flying.length);
        }
        if (flying.length || st.lines.length) {
          try { out = out.concat(flying.concat(st.lines).map((o) => JSON.parse(o.s))); } catch {}
        }
      }
      return out.slice(-limit).map((l) => ({ ...l, level: TL.levelOf(l.kind) }));
    } catch { return []; }
  }
  _readLogTail(file, limit) {
    try {
      const st = fs.statSync(file);
      let bytes = Math.min(st.size, limit === Infinity ? st.size : Math.max(256 * 1024, limit * 300));
      let out = [];
      for (;;) {
        const buf = Buffer.alloc(bytes);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buf, 0, bytes, st.size - bytes); } finally { fs.closeSync(fd); }
        let text = buf.toString('utf8');
        if (bytes < st.size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
        out = C.parseLogs(text, limit);
        if (out.length >= limit || bytes >= st.size) break;
        bytes = Math.min(st.size, bytes * 4);
      }
      return out;
    } catch { return []; }
  }
  clearLogs() {
    const st = LOG_BUFS.get(path.resolve(this.dir));
    if (st) { st.lines = []; st.flying = []; st.bytes = 0; st.size = 0; st.idxLive = null; }
    for (const f of [this.logFile(), this.logFile() + '.1', LI.idxPath(this.logFile()), this.logFile() + '.1.idx']) { try { fs.unlinkSync(f); } catch {} }
    LI.dropIndex(this.logFile());
    LI.dropIndex(this.logFile() + '.1');
  }

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
  // Bounded by the session's runs' [startedAt, endedAt] window on that node (only one run is active
  // per node at a time). Pages come from the <logs.jsonl>.idx byte-offset index (log-index.js):
  // matching lines are located in the index without parsing the log, only the page's byte span is
  // read, and the rotated backup tops up the older rows. This process's queued + in-flight lines
  // merge last (read-through for a fresh append) with the landed-tail dedup described inside. A
  // missing or stale index degrades that read to an async gap scan and repairs itself in the
  // background; every line on a page is re-checked against the exact session window, so at worst a
  // stale index skews `total`, never the returned lines.
  async getSessionLog(sessionId, { offset = 0, limit = 200 } = {}) {
    const rs = this.listRuns().filter((r) => r.sessionId === sessionId);
    if (!rs.length) return { total: 0, offset, limit, entries: [] };
    const nodeId = rs[0].nodeId;
    const startMs = Math.min(...rs.map((r) => (r.startedAt ? Date.parse(r.startedAt) : Infinity)));
    const endsOpen = rs.some((r) => !r.endedAt);
    const endMs = endsOpen ? Infinity : Math.max(...rs.map((r) => Date.parse(r.endedAt)));
    const match = (l) => l.nodeId === nodeId && l.at >= startMs && l.at <= endMs;
    // Synchronous snapshot of this process's queued + in-flight lines before any await: however
    // the in-flight flush resolves during the reads below, disk + snapshot together contain every
    // line (the dedup below drops the snapshot's copy of lines the reads saw on disk).
    const st = LOG_BUFS.get(path.resolve(this.dir));
    const buffered = st ? st.flying.concat(st.lines) : [];
    const flyingCount = st ? st.flying.length : 0;
    const backupFile = this.logFile() + '.1';
    const liveFile = this.logFile();
    // Append order across the rotation boundary: backup rows first, then live.
    const backup = await LI.matchLogRecords(backupFile, nodeId, startMs, endMs);
    const live = await LI.matchLogRecords(liveFile, nodeId, startMs, endMs);
    const segs = [
      { file: backupFile, pairs: backup.pairs, np: backup.pairs.length / 2, gap: backup.gapObjs },
      { file: liveFile, pairs: live.pairs, np: live.pairs.length / 2, gap: live.gapObjs },
    ];
    const diskTotal = segs[0].np + segs[0].gap.length + segs[1].np + segs[1].gap.length;
    // The in-flight batch may already be on disk (both writes confirmed, splice pending). Readers
    // dedup it two ways: gap-scan hits drop by raw-string identity (data landed, its index records
    // not read yet), and the indexed tail by parsed content — the last `flyingCount` disk rows are
    // that batch once the index write confirms. Content comparison is the same heuristic readLogs
    // uses: two byte-identical log lines can drop one copy in this window.
    const gapStrings = new Set(backup.gapStrings);
    for (const s of live.gapStrings) gapStrings.add(s);
    let landed = null;
    if (flyingCount && diskTotal >= flyingCount) {
      const tail = await this._diskObjectsAt(segs, diskTotal - flyingCount, diskTotal, nodeId, startMs, endMs);
      landed = new Set(tail.map((o) => JSON.stringify(o)));
    }
    const bufMatches = [];
    for (let i = 0; i < buffered.length; i++) {
      const o = buffered[i];
      const raw = o.s.endsWith('\n') ? o.s.slice(0, -1) : o.s;
      if (gapStrings.has(raw)) continue;
      let l;
      try { l = JSON.parse(raw); } catch { continue; }
      if (!match(l)) continue;
      if (landed && i < flyingCount && landed.has(JSON.stringify(l))) continue;
      bufMatches.push(l);
    }
    const total = diskTotal + bufMatches.length;
    const from = Math.max(0, offset), to = Math.min(total, offset + limit);
    const page = [];
    if (from < to) {
      const dTo = Math.min(to, diskTotal);
      if (from < dTo) page.push(...(await this._diskObjectsAt(segs, from, dTo, nodeId, startMs, endMs)));
      if (dTo < to) page.push(...bufMatches.slice(Math.max(0, from - diskTotal), to - diskTotal));
    }
    return { total, offset, limit, entries: TL.logEntries(page) };
  }
  // Disk matches are laid out flat as [backup index rows | backup gap | live index rows | live gap];
  // resolve #kFrom..#kTo (exclusive) to parsed objects: index rows via one byte-range read per
  // file, gap objects directly (already parsed + exact-checked by the scan).
  async _diskObjectsAt(segs, kFrom, kTo, nodeId, startMs, endMs) {
    const key = LI.nodeKeyOf(nodeId);
    const win = segs.map(() => null);
    let k = 0;
    for (let s = 0; s < segs.length; s++) {
      const np = segs[s].np, ng = segs[s].gap.length;
      win[s] = {
        a: Math.max(0, Math.min(kFrom - k, np)), b: Math.max(0, Math.min(kTo - k, np)),
        c: Math.max(0, Math.min(kFrom - k - np, ng)), d: Math.max(0, Math.min(kTo - k - np, ng)),
      };
      k += np + ng;
    }
    const pairObjs = await Promise.all(segs.map((seg, s) => (win[s].b > win[s].a
      ? LI.readPageRows(seg.file, seg.pairs, win[s].a, win[s].b, key, startMs, endMs)
      : Promise.resolve([]))));
    const out = [];
    for (let s = 0; s < segs.length; s++) { out.push(...pairObjs[s]); out.push(...segs[s].gap.slice(win[s].c, win[s].d)); }
    return out;
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

module.exports = { Store, ROLES, STATUSES, PRIORITIES: C.PRIORITIES, defaultProjectDir, pickChanged, LOCK, lockHolderDead, LOG_LIMITS };
