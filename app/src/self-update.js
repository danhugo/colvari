// Self-update: watch the app repo for new commits and restart the app safely.
// State machine: idle -> pending (new commits on the base branch, or a request_self_update call,
// with auto-restart on) -> draining (no new dispatches; wait for running agents to finish, at most
// drainTimeoutMin minutes (default 30) — past that grace the runs that were never cut before are
// stopped (a task already cut once for a restart is spared and waited for indefinitely; its persisted
// drainCuts marker survives the relaunch), and a stopped task resumes from its persisted session
// after the restart, so one long run cannot freeze the whole team's dispatch indefinitely) ->
// testing (npm test in a throwaway worktree at the new sha so a bad checkout never touches the live
// tree; the worktree is locked so the worktree sweeps cannot delete it mid-run, and the step runs
// in its own process group with a hard timeout — a hung run kills the group,
// fails the restart and resumes dispatch instead of freezing the app) -> restarting (persist
// restart-state, relaunch). A restart whose target equals the commit the app process is already
// running is skipped entirely: no code change, no team freeze. Any failure aborts back to idle and
// logs the reason. On boot, bootResume() resumes a Run interrupted by a restart, or rolls back to
// the previous sha and disables auto-restart after repeated boot failures. All git/npm/relaunch
// steps are injectable for tests.
const CP = require('./cp');
const { spawn } = require('child_process');
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
// Async since t_5a78aa95 (the old spawnSync blocked the app's main thread per poll/step); all
// call sites await, so tests' sync {code, out} fakes keep working unchanged.
function defaultGit(repoDir) {
  return async (args) => {
    const r = await CP.run('git', args, { cwd: repoDir, timeoutMs: 60_000 });
    return { code: r.status, out: r.stdout + (r.error ? ' ' + (r.error.message || r.error) : '') + r.stderr };
  };
}
function defaultNpm(repoDir) {
  return async (args, cwd) => {
    const r = await CP.run('npm', args, { cwd: cwd || repoDir, timeoutMs: 10 * 60_000 });
    return { code: r.status, out: r.stdout + (r.error ? ' ' + (r.error.message || r.error) : '') + r.stderr };
  };
}

// Hard cap for the restart test step: a hung suite (wake.test.js once stalled 8.5 min against the
// live app) must fail the restart, not freeze the team forever. The child also queues in the
// machine-wide heavy slot (test/harness/heavy-slot.js, up to 20 min) before its tests start —
// the cap must cover the wait PLUS the suite (Pia relay of t_h0a1c2fe).
const HEAVY_SLOT_WAIT_MS = Number(process.env.AGENTS_SQUAD_HEAVY_MAX_WAIT_MS) || 20 * 60_000;
const TEST_TIMEOUT_MS = HEAVY_SLOT_WAIT_MS + 10 * 60 * 1000;

// The restart test step: `npm test` in its own process group with a hard timeout. The old
// spawnSync blocked the app's main thread for the whole suite and had no ceiling; now the app
// stays responsive and, past the deadline, the whole group (npm -> node --test -> per-file
// children) is SIGKILLed so nothing outlives the failed step. Resolves {code, out, timedOut?}.
// (bin defaults to npm; the fourth parameter exists so tests can drive a fake runner.)
function defaultTestRun(args, cwd, timeoutMs, bin = 'npm') {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = ''; let killed = false; let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    const cap = (d) => { out = (out + d).slice(-65536); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (e) => finish({ code: 1, out: out + '\n' + ((e && e.message) || e), spawnError: String((e && e.code) || (e && e.message) || 'spawn') }));
    child.on('close', (code) => finish(killed
      ? { code: code == null ? 1 : code, out, timedOut: true }
      : { code: code == null ? 1 : code, out }));
  });
}

// Harness-level spawn failure (t_a91c68ce): child_process itself could not spawn — the node
// binary or the suite's cwd vanished mid-run (a concurrent worktree sweep) — NOT a test
// assertion. Matches the child_process 'error' event (spawnError) and the failure objects
// node --test / npm print into the output (inspect style `code: 'ENOENT' … syscall: 'spawn …'`,
// npm style `code ENOENT … syscall spawn`). Assertion failures never carry this shape, and a
// timed-out run is its own abort — never a retry.
const INFRA_SPAWN_FAIL = new RegExp([
  "code:\\s*'(?:ENOENT|EAGAIN|EPERM|EACCES)'[\\s\\S]{0,300}?syscall:\\s*'spawn",
  "syscall:\\s*'spawn[^'\\n]*'[\\s\\S]{0,300}?code:\\s*'(?:ENOENT|EAGAIN|EPERM|EACCES)'",
  "code\\s+(?:ENOENT|EAGAIN|EPERM|EACCES)[\\s\\S]{0,300}?syscall\\s+spawn",
  "syscall\\s+spawn[\\s\\S]{0,300}?code\\s+(?:ENOENT|EAGAIN|EPERM|EACCES)",
].join('|'));
function isInfraSpawnFailure(t) {
  if (!t || t.code === 0 || t.timedOut) return false;
  if (t.spawnError) return true;
  return INFRA_SPAWN_FAIL.test(String(t.out || ''));
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
    // Test step runner + its hard cap. An injected npm (tests) keeps the sync {code, out}
    // signature and runs without the process-group treatment; defaultTestRun is the real thing.
    this._injectedNpm = opts.npm != null;
    this.testTimeoutMs = opts.testTimeoutMs ?? TEST_TIMEOUT_MS;
    this.testRun = opts.testRun
      || ((cwd) => (this._injectedNpm ? Promise.resolve(this.npm(['test'], cwd)) : defaultTestRun(['test'], cwd, this.testTimeoutMs)));
    // The commit this app process is actually running (the sha it launched on, captured by main.js
    // before any watcher exists). A restart targeting it is a no-op and is skipped; null (git
    // failed at boot) falls back to the old restart-anyway behavior — never skip on unknown state.
    // Async capture (t_5a78aa95): with no explicit bootSha, git resolves in the background — the
    // first tick reads it long after. Explicit opts (tests, main.js) win as before.
    this.bootSha = opts.bootSha !== undefined ? opts.bootSha : null;
    // Explicit bootSha (main.js resolves it before the window opens; tests pass it): ready at once.
    // Otherwise (null or absent) capture it async (t_5a78aa95) and hold ticks until it lands: the
    // flow's same-commit stand-down READS bootSha, and an early tick with a still-null sha would
    // read as "unknown running commit" and restart anyway — interrupting healthy runs.
    this._bootShaCaptured = !(opts.bootSha === undefined || opts.bootSha === null);
    this._bootShaReady = Promise.resolve();
    if (!this._bootShaCaptured) {
      this._bootShaReady = Promise.resolve(this.git(['rev-parse', 'HEAD'])).then((r) => {
        if (this.bootSha == null) this.bootSha = r.code === 0 ? r.out.trim() || null : null;
        this._bootShaCaptured = true;
        this.emitStatus();
      }).catch(() => { this._bootShaCaptured = true; });
    }
    this.relaunch = opts.relaunch || (() => { const { app } = require('electron'); app.relaunch(); app.exit(0); });
    this.procCount = opts.procCount || (() => 0);
    this.runActive = opts.runActive || (() => false);
    this.setPaused = opts.setPaused || (() => {});
    // Stops whatever is still running when the drain deadline hits (the orchestrator's haltProcs:
    // SIGTERM all agent processes; their tasks re-dispatch after the restart). Tests inject a stub.
    this.haltProcs = opts.haltProcs || (() => Promise.resolve());
    // Test/manual override for the drain grace; normally read from settings per drain (drainMs()).
    this._drainTimeoutMs = opts.drainTimeoutMs ?? null;
    this.now = opts.now || (() => Date.now());
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.phase = 'idle';
    this.reason = null; this.fromSha = null; this.toSha = null;
    this.waitingOn = 0; this.lastError = null; this.lastCheckAt = null; this.drainEndsAt = null;
    this._seenSha = null;
    this._deferred = null;
    this._infraFailSha = null;
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
    this.waitingOn = 0; this.drainEndsAt = null;
    this.setPhase('idle');
  }

  autoRestart() { try { return !!this.store.getSettings().autoRestart; } catch { return false; } }
  // How long draining may wait for running agents before they are stopped and the update proceeds.
  // Setting drainTimeoutMin (default 30; 0 = wait forever, the old no-timeout behavior). The grace is
  // a cap on how long the team is frozen, not a license to kill work: past it, haltProcs stops only
  // tasks never cut before — a task already cut once keeps running and the drain waits for it.
  drainMs() {
    if (this._drainTimeoutMs != null) return this._drainTimeoutMs;
    const min = Number(this.store.getSettings().drainTimeoutMin);
    if (min === 0) return Infinity;
    return min > 0 ? min * 60000 : 30 * 60000;
  }
  async baseBranch() {
    if (this.branch) return this.branch;
    const r = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    this.branch = r.code === 0 && r.out.trim() ? r.out.trim() : 'master';
    return this.branch;
  }
  // Sync read for status(): the cached branch once resolved ('master' until then — same display
  // fallback the async resolver lands on).
  branchName() { return this.branch || 'master'; }
  // Local HEAD plus fetched origin head; `to` is what we would update to (origin when ahead of local).
  async shas() {
    const local = await this.git(['rev-parse', 'HEAD']);
    if (local.code !== 0) return null;
    const sha = local.out.trim();
    await this.git(['fetch', 'origin']); // best effort: offline / no remote is fine (local merges still count)
    const origin = await this.git(['rev-parse', 'origin/' + (await this.baseBranch())]);
    const originSha = origin.code === 0 ? origin.out.trim() : null;
    // Only update *to* origin when it is strictly ahead of local (local is its ancestor); when local has
    // unpushed merges (the usual dogfood case) origin is behind and local HEAD is the target.
    const originAhead = originSha && originSha !== sha && (await this.git(['merge-base', '--is-ancestor', sha, originSha])).code === 0;
    return { local: sha, origin: originSha, to: originAhead ? originSha : sha };
  }
  restartsLastHour() { const t = this.now(); return readHistory(this.store.dir).filter((x) => x.result === 'restarting' && t - Date.parse(x.ts) < 3600 * 1000).length; }
  status() {
    return {
      phase: this.phase, reason: this.reason, fromSha: this.fromSha, toSha: this.toSha,
      waitingOn: this.waitingOn, lastError: this.lastError, lastCheckAt: this.lastCheckAt,
      drainEndsAt: this.drainEndsAt, drainTimeoutMin: this.phase === 'draining' && isFinite(this.drainMs()) ? this.drainMs() / 60000 : null,
      lastSeenSha: this._seenSha, deferredTo: this._deferred ? this._deferred.sha : null,
      branch: this.branchName(), autoRestart: this.autoRestart(), bootSha: this.bootSha, testTimeoutMs: this.testTimeoutMs,
      lastRestartAt: this.lastRestartAt || null, restartsLastHour: this.restartsLastHour(),
      history: readHistory(this.store.dir).slice(-10).reverse(),
    };
  }
  emitStatus() { this.emit('status', this.status()); }
  setPhase(phase) { this.phase = phase; this.setPaused(phase !== 'idle'); this.emitStatus(); }
  // Commits the running build (bootSha) still lacks up to the pending restart's target, computed
  // from git — the same "running..target" count the merge site stores. Null when it cannot be
  // computed (no boot sha, no target, git failure): never guess 0, never clear on a guess.
  async _pendingBehind(rp) {
    if (!rp || !this.bootSha) return null;
    const target = rp.sha || this.toSha;
    if (!target) return null;
    const r = await this.git(['rev-list', '--count', `${this.bootSha}..${target}`]);
    return r.code === 0 ? (Number(String(r.out).trim()) || 0) : null;
  }
  // A stand-down (nothing to restart onto) never relaunches, but it must release what the restart
  // held: the orchestrator keeps its dispatch gate while a schedule is armed, so disarm any
  // armed/fired schedule the way cancelRestart does — and when git confirms the running build
  // already contains the pending target (count 0), the tally itself is stale: clear it, or it
  // holds the bell row up forever and the cap re-arms restarts onto live code (t_7426095a,
  // t_f6d37ca4). Best-effort: test stores without restart state are skipped.
  async _standDown() {
    try {
      const rp = this.store.restartPending && this.store.restartPending();
      if (!rp) return;
      if (rp.scheduledNow || rp.afterTaskId || rp.firedAt) {
        this.store.setRestartPending({ scheduledNow: false, afterTaskId: null, firedAt: null, firedCount: null });
        this._log('system', 'self-update: stood-down restart released the dispatch schedule.');
      }
      if ((await this._pendingBehind(rp)) === 0) {
        this.store.clearRestartPending();
        this._log('system', 'self-update: cleared the pending state — the running build already has the pending target (0 commits behind).');
        this.emit('pending-cleared');
        this.emitStatus();
      }
    } catch {}
  }
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

  // Scheduled restart (orchestrator, plan t_42f310cf item 1): a core/human/cap-armed schedule came
  // due. The schedule itself is the decision, so — like restartNow — this bypasses the restart
  // guards AND the auto-restart setting; the flow still runs its full safety sequence (drain,
  // tests on the target sha, relaunch, boot resume). Returns false when a flow is already running.
  restartScheduled(reason) {
    if (this.phase !== 'idle' || this._busy) return false;
    this._log('system', `self-update: scheduled restart requested (${reason})`);
    this.tick(true, reason).catch((e) => this._abort(e.message));
    return true;
  }

  // Cancel a running restart flow (the pill's "Cancel schedule" while the veil is up): abort back
  // to idle — the setPaused callback unpauses dispatch and re-ticks. Not running: no-op.
  cancel() {
    if (this.phase === 'idle') return;
    this._abort('cancelled by the user');
  }

  // One poll. Consumes a PM request_self_update file (if any) and starts the flow when there is
  // something to update, auto-restart is on, and the restart guards allow it. An update blocked by
  // a restart guard is deferred (keeping the from-sha captured when the commits were first seen)
  // and retried on later polls once the guard clears — skipping must not consume the commit.
  // force (manual/scheduled restart) bypasses the new-commits check, the guards and the
  // auto-restart setting: an explicit restart request is itself the decision to restart.
  async tick(force = false, reasonOverride = null) {
    if (this.phase !== 'idle' || this._busy) return;
    await this._bootShaReady; // the flow's same-commit guard reads bootSha: never decide before it lands
    if (this.phase !== 'idle' || this._busy) return;
    this.lastCheckAt = new Date().toISOString();
    const req = readJson(requestFile(this.store.dir), null);
    if (req) { try { fs.unlinkSync(requestFile(this.store.dir)); } catch {} }
    const s = await this.shas();
    if (!s) { this.emitStatus(); return; }
    const prevSeen = this._seenSha;
    const baseline = prevSeen === null;
    if (baseline) this._seenSha = s.to;
    const isNew = !baseline && s.to !== this._seenSha;
    const keepDefer = !isNew && !!this._deferred && this._deferred.sha === s.to;
    this._seenSha = s.to;
    if (!isNew && !keepDefer && !req && !force) { this.emitStatus(); return; }
    const reason = reasonOverride || (req && req.reason) || (keepDefer && this._deferred.reason) || `new commits on ${await this.baseBranch()}`;
    // Never restart onto the commit this process is already running (t_7426095a): the incident
    // boot scheduled f83c8cd -> f83c8cd ("21 changes" was a stale pending count), paused the
    // team and froze on the test step for code that was already live. Unknown boot sha: fall
    // through and restart the old way.
    if (this.bootSha && s.to === this.bootSha) {
      this._deferred = null;
      this._log('system', `self-update: ${reason} skipped — target ${s.to.slice(0, 7)} is the commit already running; nothing to restart onto.`);
      await this._standDown();
      this.emitStatus();
      return;
    }
    if (!this.bootSha && (req || force)) this._log('system', `self-update: ${reason} — running sha unknown (boot capture failed); the same-commit skip cannot apply, restarting anyway.`);
    if (!this.autoRestart() && !force) {
      if (req) this._log('system', `self-update requested (${reason}) but auto-restart is off; ignoring.`);
      this.emitStatus(); return;
    }
    const defer = (why) => {
      if (!keepDefer) this._log('system', `self-update: ${reason} seen but ${why}; skipping — will retry when the guard clears.`);
      // Coalesce to the NEWEST sha, but keep the from-sha captured when the commits were FIRST seen:
      // that is the sha actually running now, and the one a rollback would return to.
      this._deferred = { sha: s.to, reason, from: (this._deferred && this._deferred.from) || prevSeen };
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
    const from = this.fromSha; let to = this.toSha; const reason = this.reason;
    const abort = (why) => {
      this._log('error', `self-update aborted: ${why}`);
      appendHistory(this.store.dir, { ts: new Date().toISOString(), reason, fromSha: from, toSha: to, result: 'aborted: ' + why });
      this.lastError = why;
      this._busy = false;
      this.waitingOn = 0; this.drainEndsAt = null;
      this.setPhase('idle');
    };
    try {
      this._busy = true;
      // Belt for direct _flow callers / a bootSha learned late: never drain the team to restart
      // onto the commit that is already running (t_7426095a).
      if (this.bootSha && String(to) === String(this.bootSha)) {
        this._log('system', `self-update: target ${String(to).slice(0, 7)} is the commit already running — nothing to restart onto; standing down.`);
        this._busy = false;
        await this._standDown();
        this.setPhase('idle');
        return;
      }
      this.setPhase('pending');
      // Fail fast, before pausing anyone: if the main checkout is dirty (a dev mid-edit) the update
      // is going to abort, and better it costs the team nothing. Re-checked after the drain, since
      // the checkout can dirty while we wait.
      const dirtyPre = await this.git(['status', '--porcelain']);
      if (dirtyPre.code !== 0 || dirtyPre.out.trim()) return abort('main checkout has uncommitted changes; refusing to fast-forward');
      this._log('system', `self-update: ${reason} (${from.slice(0, 7)} -> ${to.slice(0, 7)}); pausing new runs.`);
      this.setPhase('draining');
      // Wait for running agents to finish — within the drain grace. The dispatch pause already
      // freezes every idle agent, so one long run must not extend that freeze indefinitely: past
      // the deadline whatever is still running is stopped (haltProcs) and its task re-dispatches
      // after the restart (reconcileOrphanedTasks resets it to todo; wasRunning stays true so
      // bootResume resumes the Run). Setting drainTimeoutMin = 0 restores wait-forever.
      const drainMs = this.drainMs();
      const deadline = isFinite(drainMs) ? this.now() + drainMs : null;
      this.drainEndsAt = deadline != null ? new Date(deadline).toISOString() : null;
      // One halt per drain: past the grace, tasks never cut before are stopped (their tasks resume
      // after the restart). haltProcs spares already-cut tasks on purpose ({cut, spared}) — only an
      // EXPLICIT spared count keeps the loop waiting (and without a second deadline: a task cut once
      // must never be cut again; the stall watchdog recovers a hung one). A haltProcs that does not
      // report the shape (tests, custom wiring) proceeds, as before.
      let halted = false;
      while (this.procCount() > 0) {
        if (this.phase === 'idle') return; // aborted mid-drain (cancel): stop waiting, relaunch nothing
        if (!halted && deadline != null && this.now() >= deadline) {
          halted = true;
          this._log('system', `self-update: drain grace (${Math.round(drainMs / 60000)}min) over with ${this.procCount()} run(s) still active; stopping the runs not already cut once — their tasks resume after the restart. Tasks already cut once keep running and the drain waits for them.`);
          const res = await this.haltProcs();
          const spared = res && typeof res.spared === 'number' ? res.spared : 0;
          if (spared > 0 && this.procCount() > 0) {
            this._log('system', `self-update: ${spared} run(s) already cut once keep running; the drain waits for them.`);
            continue;
          }
          break;
        }
        this.waitingOn = this.procCount(); this.emitStatus(); await this.sleep(500);
      }
      this.drainEndsAt = null;
      this.waitingOn = 0; this.emitStatus();
      if (this.phase === 'idle') return; // aborted while draining with nothing left to wait for
      // Commits that landed while the drain waited coalesce into THIS restart: the freeze was
      // already paid once, so re-resolve the target instead of restarting onto a stale sha.
      const latest = await this.shas();
      if (latest && latest.to !== to) {
        this._log('system', `self-update: newer commits landed during the drain; coalescing this restart ${String(to).slice(0, 7)} -> ${String(latest.to).slice(0, 7)}.`);
        to = latest.to; this.toSha = to; this._seenSha = to;
      }
      // A coalesce (or a force-push back) can land the target on the running commit after the
      // freeze was already paid: still nothing to restart onto — stand down instead of relaunching
      // the same code.
      if (this.bootSha && String(to) === String(this.bootSha)) {
        this._log('system', `self-update: coalesced target is the running commit ${String(to).slice(0, 7)}; standing down — no restart.`);
        this._busy = false;
        await this._standDown();
        this.setPhase('idle');
        return;
      }
      const dirty = await this.git(['status', '--porcelain']);
      if (dirty.code !== 0 || dirty.out.trim()) return abort('main checkout has uncommitted changes; refusing to fast-forward');
      if (to !== from) {
        const ff = await this.git(['merge', '--ff-only', to]);
        if (ff.code !== 0) return abort('fast-forward failed: ' + ff.out.slice(0, 300));
        this._seenSha = to;
      }
      if (from === to ? (await this.git(['diff', '--name-only', to + '^', to, '--', path.join(this.rel, 'package-lock.json')])).out.trim()
        : (await this.git(['diff', '--name-only', from, to, '--', path.join(this.rel, 'package-lock.json')])).out.trim()) {
        this._log('system', 'self-update: package-lock.json changed; running npm ci.');
        const ci = await this.npm(['ci']);
        if (ci.code !== 0) return abort('npm ci failed: ' + ci.out.slice(0, 300));
      }
      const build = await this.npm(['run', 'build', '--if-present']);
      if (build.code !== 0) return abort('build failed: ' + build.out.slice(0, 300));
      this.setPhase('testing');
      // One attempt: a throwaway worktree at `to`, LOCKED against the worktree sweeps while the
      // suite runs. The worktree is a REGISTERED worktree of this repo (git worktree add), so
      // every sweeper of this repo sees it — the 10-min interval sweep, the orchestrator's, any
      // app instance's — and the 2026-10-01 04:35 ENOENT abort was this suite's cwd vanishing
      // under exactly such a sweep mid-run (spawn node ENOENT with the binary present,
      // t_a91c68ce). A lock is the one protection they all honor: the stray-worktree reaper
      // skips locked entries and git itself refuses to remove one (even with --force).
      const attemptTests = async () => {
        const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-selfupdate-'));
        const wadd = await this.git(['worktree', 'add', '--detach', wt, to]);
        if (wadd.code !== 0) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch {} abort('could not create test worktree: ' + wadd.out.slice(0, 300)); return null; }
        try {
          await this.git(['worktree', 'lock', wt]);
          await require('./worktree').cloneNodeModules(path.join(this.npmDir, 'node_modules'), path.join(wt, this.rel, 'node_modules')); // own clone, never a link (t_09a2c1e0)
          return await this.testRun(path.join(wt, this.rel));
        } finally {
          await this.git(['worktree', 'unlock', wt]); // git refuses to remove a locked tree, even with --force
          await this.git(['worktree', 'remove', '--force', wt]);
          try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
        }
      };
      let t = await attemptTests();
      if (t === null) return; // aborted inside the attempt (worktree add failed)
      // Infra-only retry (t_a91c68ce): one rerun when the harness itself failed to spawn, never
      // on assertion failures or timeouts. Narrow and visible per Cato's plan review: a loud
      // error log with the attempt counter, and a SECOND infra failure on the same target sha is
      // final — a deletion that keeps happening is a bug to surface, not to paper over.
      if (this.phase === 'testing' && !t.timedOut && t.code !== 0 && isInfraSpawnFailure(t)) {
        if (this._infraFailSha === to) {
          return abort('test step infra spawn failure repeated on ' + String(to).slice(0, 7) + ' — not retrying again: ' + String(t.out || '').slice(-300));
        }
        this._infraFailSha = to;
        this._log('error', 'self-update: test step died on an infra spawn failure (harness ENOENT/EAGAIN, not a test assertion) — retrying once (attempt 1/2). Output tail: ' + String(t.out || '').trim().slice(-400));
        t = await attemptTests();
        if (t === null) return;
        if (this.phase === 'testing' && !t.timedOut && t.code !== 0 && isInfraSpawnFailure(t)) {
          return abort('test step infra spawn failure repeated on ' + String(to).slice(0, 7) + ' — the same test never retries twice in a row: ' + String(t.out || '').slice(-300));
        }
      } else if (t.code !== 0) {
        this._infraFailSha = null; // a real assertion failure: the harness itself works
      }
      if (t.timedOut) {
        const tail = String(t.out || '').trim().slice(-300);
        return abort(`test step timed out after ${Math.round(this.testTimeoutMs / 60000)}min; killed its process group${tail ? ` — output tail: ${tail}` : ''}`);
      }
      if (t.code !== 0) return abort('tests failed on new code: ' + String(t.out || '').slice(-500));
      this._infraFailSha = null;
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

// A crash between the test step's `worktree add` and its finally's unlock/remove leaves a LOCKED
// squad-selfupdate-* registration that no worktree sweep may ever reap — that is the point of the
// lock — so the boot that follows the crash reaps our own stale ones: the flow that owned them
// died with the old process. Only this prefix; anything else is not ours to touch.
async function reapStaleTestWorktrees(repoDir) {
  if (!repoDir) return;
  try {
    const git = defaultGit(repoDir);
    const list = await git(['worktree', 'list', '--porcelain']);
    if (list.code !== 0 || !list.out.trim()) return;
    let sawStale = false;
    for (const block of list.out.split('\n\n')) {
      const m = {};
      for (const l of block.split('\n')) { const i = l.indexOf(' '); if (i > 0) m[l.slice(0, i)] = l.slice(i + 1); else if (l === 'locked' || l === 'detached') m[l] = true; }
      const p = m.worktree;
      if (!p || !/(^|[\\/])squad-selfupdate-[^/\\]+$/.test(p)) continue;
      sawStale = true;
      await git(['worktree', 'unlock', p]);
      await git(['worktree', 'remove', '--force', '--force', p]); // double force: still-locked leftovers
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
    if (sawStale) await git(['worktree', 'prune']);
  } catch {}
}

// Boot, called from main.js before the window is useful. If the last session restarted into new
// code, count the boot attempt; if it fails to reach markBootOk twice, roll back to fromSha (never
// through uncommitted changes) and disable auto-restart after repeated boot failures. Returns {resume}: restart the interrupted
// Run. The activity feed gets one line either way. Async since t_5a78aa95 (git steps off the main
// thread) — main.js fires it at boot and applies the resume decision when it resolves.
async function bootResume(store, { repoDir } = {}) {
  await reapStaleTestWorktrees(repoDir);
  const dir = store.dir;
  const st = readRestartState(dir);
  if (!st || st.phase !== 'restarting') return { resume: false };
  st.bootAttempts = (st.bootAttempts || 0) + 1;
  const feed = (kind, text) => { try { store.appendLog({ nodeId: null, kind, text, at: Date.now() }); } catch {} };
  if (st.bootAttempts >= 3) {
    let rollbackNote = '';
    const dirty = repoDir ? await defaultGit(repoDir)(['status', '--porcelain']) : null;
    if (dirty && dirty.code === 0 && !dirty.out.trim()) {
      const r = await defaultGit(repoDir)(['reset', '--hard', st.fromSha]);
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

module.exports = { UpdateWatcher, bootResume, markBootOk, defaultGit, defaultNpm, defaultTestRun, isInfraSpawnFailure, reapStaleTestWorktrees, TEST_TIMEOUT_MS, requestFile, readRestartState, writeRestartState, clearRestartState, readHistory, appendHistory };
