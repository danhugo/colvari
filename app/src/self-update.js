// Self-update: watch the app repo for new commits and restart the app safely.
// State machine: idle -> pending (new commits on the base branch, or a request_self_update call,
// with auto-restart on) -> draining (no new dispatches; wait for running agents to finish — no
// timeout, interrupting mid-run would strand worktrees) -> testing (npm test in a throwaway
// worktree at the new sha so a bad checkout never touches the live tree) -> restarting (persist
// restart-state, relaunch). Any failure aborts back to idle and logs the reason.
// On boot, bootResume() resumes a Run interrupted by a restart, or rolls back to the previous sha
// and disables auto-restart after repeated boot failures. All git/npm/relaunch steps are injectable
// for tests.
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TL = require('./timeline');

const HISTORY_CAP = 50;

const stateFile = (dir) => path.join(dir, 'restart-state.json');
const historyFile = (dir) => path.join(dir, 'self-update-history.json');
const requestFile = (dir) => path.join(dir, 'self-update-request.json');

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch {} };
const readHistory = (dir) => readJson(historyFile(dir), { history: [] }).history || [];
function appendHistory(dir, entry) {
  const h = [...readHistory(dir), entry].slice(-HISTORY_CAP);
  writeJson(historyFile(dir), { history: h });
  return h;
}
const readRestartState = (dir) => readJson(stateFile(dir), null);
const writeRestartState = (dir, st) => writeJson(stateFile(dir), st);
const clearRestartState = (dir) => { try { fs.unlinkSync(stateFile(dir)); } catch {} };

// Default runners, never throwing: {code, out}. git runs in the app repo, npm in any cwd.
function defaultGit(repoDir) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    return { code: r.status == null ? 1 : r.status, out: (r.stdout || '') + (r.error ? ' ' + r.error : '') + (r.stderr || '') };
  };
}
function defaultNpm(repoDir) {
  return (args, cwd) => {
    const r = spawnSync('npm', args, { cwd: cwd || repoDir, encoding: 'utf8' });
    return { code: r.status == null ? 1 : r.status, out: (r.stdout || '') + (r.error ? ' ' + r.error : '') + (r.stderr || '') };
  };
}

class UpdateWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.store = opts.store;
    this.repoDir = opts.repoDir || process.cwd();
    // Package dir for npm (build/test/ci) when the app lives in a subdir of the git repo.
    this.npmDir = opts.npmDir || this.repoDir;
    this.pollMs = opts.pollMs || 60 * 1000;
    // Restart guards (a team merges constantly: without these every merge would restart the app).
    this.minIntervalMs = opts.minIntervalMs ?? 10 * 60 * 1000;
    this.maxRestartsPerHour = opts.maxRestartsPerHour ?? 3;
    this.git = opts.git || defaultGit(this.repoDir);
    this.npm = opts.npm || defaultNpm(this.npmDir);
    // Lockfile/worktree paths are repo-relative; npm's lives under the package dir.
    this.rel = path.relative(this.repoDir, this.npmDir) || '.';
    this.relaunch = opts.relaunch || (() => { const { app } = require('electron'); app.relaunch(); app.exit(0); });
    this.procCount = opts.procCount || (() => 0);
    this.runActive = opts.runActive || (() => false);
    this.setPaused = opts.setPaused || (() => {});
    this.now = opts.now || (() => Date.now());
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.phase = 'idle';
    this.reason = null; this.fromSha = null; this.toSha = null;
    this.waitingOn = 0; this.lastError = null; this.lastCheckAt = null;
    this._seenSha = null;
    this._deferred = null;
    this._busy = false;
    const restarting = readHistory(this.store.dir).filter((x) => x.result === 'restarting');
    this.lastRestartAt = restarting.length ? Date.parse(restarting[restarting.length - 1].ts) : 0;
    this._timer = setInterval(() => { this.tick().catch((e) => this._abort(e.message)); }, this.pollMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() { clearInterval(this._timer); this.setPaused(false); }

  // Async failure outside _flow's own abort handling (e.g. a store error mid-poll): abort back to
  // idle — setPhase('idle') unpauses dispatch, so a failed update never leaves the team paused.
  _abort(why) {
    if (this.phase === 'idle') return;
    this._log('error', `self-update aborted: ${why}`);
    appendHistory(this.store.dir, { ts: new Date().toISOString(), reason: this.reason, fromSha: this.fromSha, toSha: this.toSha, result: 'aborted: ' + why });
    this.lastError = why; this._busy = false;
    this.setPhase('idle');
  }

  autoRestart() { try { return !!this.store.getSettings().autoRestart; } catch { return false; } }
  baseBranch() {
    if (this.branch) return this.branch;
    const r = this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    this.branch = r.code === 0 && r.out.trim() ? r.out.trim() : 'master';
    return this.branch;
  }
  // Local HEAD plus fetched origin head; `to` is what we would update to (origin when ahead of local).
  shas() {
    const local = this.git(['rev-parse', 'HEAD']);
    if (local.code !== 0) return null;
    const sha = local.out.trim();
    this.git(['fetch', 'origin']); // best effort: offline / no remote is fine (local merges still count)
    const origin = this.git(['rev-parse', 'origin/' + this.baseBranch()]);
    const originSha = origin.code === 0 ? origin.out.trim() : null;
    return { local: sha, origin: originSha, to: originSha && originSha !== sha ? originSha : sha };
  }
  restartsLastHour() { const t = this.now(); return readHistory(this.store.dir).filter((x) => x.result === 'restarting' && t - Date.parse(x.ts) < 3600 * 1000).length; }
  status() {
    return {
      phase: this.phase, reason: this.reason, fromSha: this.fromSha, toSha: this.toSha,
      waitingOn: this.waitingOn, lastError: this.lastError, lastCheckAt: this.lastCheckAt,
      lastSeenSha: this._seenSha, deferredTo: this._deferred ? this._deferred.sha : null,
      branch: this.baseBranch(), autoRestart: this.autoRestart(),
      lastRestartAt: this.lastRestartAt || null, restartsLastHour: this.restartsLastHour(),
      history: readHistory(this.store.dir).slice(-10).reverse(),
    };
  }
  emitStatus() { this.emit('status', this.status()); }
  setPhase(phase) { this.phase = phase; this.setPaused(phase !== 'idle'); this.emitStatus(); }
  _log(kind, text) {
    const l = { nodeId: null, kind, text, at: this.now(), taskId: null, task: null, level: TL.levelOf(kind) };
    try { this.store.appendLog(l); } catch {}
    this.emit('log', l);
  }

  // Manual "restart now" (UI/IPC): starts the flow immediately, bypassing the interval/rate guards.
  restartNow() {
    if (this.phase !== 'idle') return;
    this._log('system', 'self-update: manual restart requested');
    this.tick(true).catch((e) => this._abort(e.message));
  }

  // One poll. Consumes a PM request_self_update file (if any) and starts the flow when there is
  // something to update, auto-restart is on, and the restart guards allow it. An update blocked by
  // a restart guard is deferred (keeping the from-sha captured when the commits were first seen)
  // and retried on later polls once the guard clears — skipping must not consume the commit.
  async tick(force = false) {
    if (this.phase !== 'idle' || this._busy) return;
    this.lastCheckAt = new Date().toISOString();
    const req = readJson(requestFile(this.store.dir), null);
    if (req) { try { fs.unlinkSync(requestFile(this.store.dir)); } catch {} }
    const s = this.shas();
    if (!s) { this.emitStatus(); return; }
    const prevSeen = this._seenSha;
    const baseline = prevSeen === null;
    if (baseline) this._seenSha = s.to;
    const isNew = !baseline && s.to !== this._seenSha;
    const keepDefer = !isNew && !!this._deferred && this._deferred.sha === s.to;
    this._seenSha = s.to;
    if (!isNew && !keepDefer && !req && !force) { this.emitStatus(); return; }
    const reason = (req && req.reason) || (keepDefer && this._deferred.reason) || `new commits on ${this.baseBranch()}`;
    if (!this.autoRestart()) {
      if (req) this._log('system', `self-update requested (${reason}) but auto-restart is off; ignoring.`);
      this.emitStatus(); return;
    }
    const defer = (why) => {
      if (!keepDefer) this._log('system', `self-update: ${reason} seen but ${why}; skipping — will retry when the guard clears.`);
      this._deferred = { sha: s.to, reason, from: keepDefer ? this._deferred.from : prevSeen };
      this.emitStatus();
    };
    if (!force && this.now() - this.lastRestartAt < this.minIntervalMs) {
      defer(`the last restart was ${Math.round((this.now() - this.lastRestartAt) / 60000)}min ago (< ${Math.round(this.minIntervalMs / 60000)}min)`);
      return;
    }
    if (!force && this.restartsLastHour() >= this.maxRestartsPerHour) {
      defer(`the restart guard (${this.maxRestartsPerHour}/hour) is hit`);
      return;
    }
    // fromSha is what we ran before the update: the previously seen sha. By detection time the
    // orchestrator's auto-merge has usually already landed the commits locally, so s.local is
    // often already == to and would make log/history/rollback all point at the new sha. A deferred
    // retry keeps the from-sha from when the commits were first seen.
    this.fromSha = (this._deferred && this._deferred.from) || (isNew && prevSeen ? prevSeen : s.local);
    this.toSha = s.to; this.reason = reason;
    this._deferred = null;
    await this._flow();
  }

  async _flow() {
    const from = this.fromSha; const to = this.toSha; const reason = this.reason;
    const abort = (why) => {
      this._log('error', `self-update aborted: ${why}`);
      appendHistory(this.store.dir, { ts: new Date().toISOString(), reason, fromSha: from, toSha: to, result: 'aborted: ' + why });
      this.lastError = why;
      this._busy = false;
      this.setPhase('idle');
    };
    try {
      this._busy = true;
      this.setPhase('pending');
      this._log('system', `self-update: ${reason} (${from.slice(0, 7)} -> ${to.slice(0, 7)}); pausing new runs.`);
      this.setPhase('draining');
      // Wait for running agents to finish. Indefinite by design (no interrupt: it would leave
      // half-done worktrees); the UI shows the count and can trigger a manual restart.
      while (this.procCount() > 0) { this.waitingOn = this.procCount(); this.emitStatus(); await this.sleep(500); }
      this.waitingOn = 0; this.emitStatus();
      const dirty = this.git(['status', '--porcelain']);
      if (dirty.code !== 0 || dirty.out.trim()) return abort('main checkout has uncommitted changes; refusing to fast-forward');
      if (to !== from) {
        const ff = this.git(['merge', '--ff-only', to]);
        if (ff.code !== 0) return abort('fast-forward failed: ' + ff.out.slice(0, 300));
        this._seenSha = to;
      }
      if (from === to ? this.git(['diff', '--name-only', to + '^', to, '--', path.join(this.rel, 'package-lock.json')]).out.trim()
        : this.git(['diff', '--name-only', from, to, '--', path.join(this.rel, 'package-lock.json')]).out.trim()) {
        this._log('system', 'self-update: package-lock.json changed; running npm ci.');
        const ci = this.npm(['ci']);
        if (ci.code !== 0) return abort('npm ci failed: ' + ci.out.slice(0, 300));
      }
      const build = this.npm(['run', 'build', '--if-present']);
      if (build.code !== 0) return abort('build failed: ' + build.out.slice(0, 300));
      this.setPhase('testing');
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-selfupdate-'));
      const wadd = this.git(['worktree', 'add', '--detach', wt, to]);
      if (wadd.code !== 0) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch {} return abort('could not create test worktree: ' + wadd.out.slice(0, 300)); }
      try {
        try { fs.symlinkSync(path.join(this.npmDir, 'node_modules'), path.join(wt, this.rel, 'node_modules'), 'dir'); } catch {}
        const t = this.npm(['test'], path.join(wt, this.rel));
        if (t.code !== 0) return abort('tests failed on new code: ' + t.out.slice(-500));
      } finally {
        try { fs.unlinkSync(path.join(wt, this.rel, 'node_modules')); } catch {}
        this.git(['worktree', 'remove', '--force', wt]);
        try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
      }
      this._log('system', `self-update: tests passed on ${to.slice(0, 7)}; restarting.`);
      const st = { phase: 'restarting', wasRunning: !!this.runActive(), reason, fromSha: from, toSha: to, ts: new Date().toISOString(), bootAttempts: 0 };
      writeRestartState(this.store.dir, st);
      this.lastRestartAt = this.now();
      appendHistory(this.store.dir, { ts: st.ts, reason, fromSha: from, toSha: to, result: 'restarting' });
      this._busy = false;
      this.setPhase('restarting');
      this.relaunch();
    } catch (e) { abort(e.message); }
  }
}

// Boot, called from main.js before the window is useful. If the last session restarted into new
// code, count the boot attempt; if it fails to reach markBootOk twice, roll back to fromSha (never
// through uncommitted changes) and disable auto-restart. Returns {resume}: restart the interrupted
// Run. The activity feed gets one line either way.
function bootResume(store, { repoDir } = {}) {
  const dir = store.dir;
  const st = readRestartState(dir);
  if (!st || st.phase !== 'restarting') return { resume: false };
  st.bootAttempts = (st.bootAttempts || 0) + 1;
  const feed = (kind, text) => { try { store.appendLog({ nodeId: null, kind, text, at: Date.now() }); } catch {} };
  if (st.bootAttempts >= 3) {
    let rollbackNote = '';
    const dirty = repoDir && defaultGit(repoDir)(['status', '--porcelain']);
    if (dirty && dirty.code === 0 && !dirty.out.trim()) {
      const r = defaultGit(repoDir)(['reset', '--hard', st.fromSha]);
      rollbackNote = r.code === 0 ? `rolled back to ${String(st.fromSha).slice(0, 7)}` : `automatic rollback failed: ${r.out.slice(0, 200)}`;
    } else rollbackNote = 'not rolled back (checkout has uncommitted changes)';
    try { store.saveSettings({ autoRestart: false }); } catch {}
    feed('error', `self-update: new code (${String(st.toSha).slice(0, 7)}) failed to boot ${st.bootAttempts - 1} time(s) after the restart; ${rollbackNote} and auto-restart is now off.`);
    appendHistory(dir, { ts: new Date().toISOString(), reason: st.reason, fromSha: st.fromSha, toSha: st.toSha, result: 'rolled_back' });
    clearRestartState(dir);
    return { resume: false, rolledBack: true, state: st };
  }
  writeRestartState(dir, st);
  feed('system', `self-update: booted new code ${String(st.toSha).slice(0, 7)} (attempt ${st.bootAttempts})${st.wasRunning ? '; resuming the interrupted Run' : ''}.`);
  return { resume: !!st.wasRunning, state: st };
}

// Called ~15s after a healthy boot: the new code is proven good, so a crash after this point is not
// a boot failure. Keeps the wasRunning record until the Run is resumed.
function markBootOk(store) {
  const st = readRestartState(store.dir);
  if (st && st.phase === 'restarting') writeRestartState(store.dir, { ...st, phase: 'idle' });
}

module.exports = { UpdateWatcher, bootResume, markBootOk, defaultGit, defaultNpm, requestFile, readRestartState, writeRestartState, clearRestartState, readHistory, appendHistory };
