// Pre-merge test gate (t_897cca56): no red code reaches the base branch. On a task's merge:
// take a cross-process merge lock, merge the BASE into the task branch inside its worktree, run
// the unit suite against exactly that tree, then — only if green — fast-forward the base branch
// to the tested tip (CAS: if the base moved meanwhile, loop and re-test). The tested tree IS the
// merged tree by construction, so a post-merge failure can only mean someone bypassed the gate.
//
// The suite is `npm test` (= node --test test/*.test.js) run in the worktree's package dir
// (<wt>/app, or <wt> when the package sits at the repo root); a repo with no package.json is not
// testable and merges untested. Failure handling follows the t_485c97c5 critic review:
// - test failure -> no merge, task reopened to its assignee with the failing names + capped tail;
//   the suite reruns once first and a pass on the rerun merges as green with a flaky note.
// - infra failure (timeout, runner crash, missing dependency) is retried once and never counted
//   as the branch's fault; the task is reopened with an infra note instead.
// - if the merged tree AND the base alone both fail, master itself is red: a red-master state is
//   recorded (.squad/merge-gate.json), a master.red/green log entry is emitted and a single P0
//   fix task is created (deduped); it auto-closes when a later gate run proves master green.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WT = require('./worktree');

const GATE = {
  TEST_TIMEOUT_MS: Number(process.env.AGENTS_SQUAD_GATE_TEST_TIMEOUT_MS) || 8 * 60_000,
  INSTALL_TIMEOUT_MS: 5 * 60_000,
  RERUN_ONCE: true, // one flake must not bounce a good branch (t_485c97c5 #4)
  LOCK_STALE_MS: 25 * 60_000, // > worst case (2 suite runs + install); never steal a live merge
  MAX_CAS_ROUNDS: 3,
  TAIL_CAP: 4000, // bounce payload: tail + names only, never the whole log (#8)
  MAX_NAMES: 12,
};

const gitRun = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const revParse = (root, ref) => gitRun(root, ['rev-parse', ref]);
const errText = (e) => String(e.stderr || e.message || e).trim();
const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// The repo root owning a task worktree, and the branch the root currently has checked out.
const repoRootOf = (t) => path.resolve(t.worktreePath, '..', '..', '..');
const baseBranchOf = (root) => gitRun(root, ['symbolic-ref', '--short', 'HEAD']);
// Suite dir inside a checkout: <checkout>/app (this repo's layout), else the checkout itself.
const suiteDirOf = (checkout) => { const p = path.join(checkout, 'app'); return readIf(path.join(p, 'package.json')) != null ? p : (readIf(path.join(checkout, 'package.json')) != null ? checkout : null); };

// ---- health record (<root>/.squad/merge-gate.json): master green/red + owning task ----
const healthFile = (root) => path.join(root, '.squad', 'merge-gate.json');
function readHealth(root) { try { return JSON.parse(fs.readFileSync(healthFile(root), 'utf8')); } catch { return { state: 'unknown' }; } }
function writeHealth(root, h) {
  const f = healthFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
const redMasterTask = (store) => store.listTasks().find((x) => x.redMaster && !['done', 'merge_conflict'].includes(x.status));

function setHealth(store, root, next) {
  const prev = readHealth(root);
  const h = { ...prev, ...next, updatedAt: new Date().toISOString() };
  if (next.state === 'red' && prev.state !== 'red') {
    const names = (next.failing || []).slice(0, GATE.MAX_NAMES).join(', ') || 'unknown failures';
    const owner = next.lastMergedTask
      ? (next.source === 'merge gate'
        ? `last merged task ${next.lastMergedTask} (${next.lastMergedBranch || '?'})`
        : `no merge involved — likely a direct commit; last merged task was ${next.lastMergedTask} (owner is a guess)`)
      : 'no merge involved — owner unknown';
    store.appendLog({ at: Date.now(), nodeId: null, kind: 'master.red', text: `master is red: ${names}. ${owner}.` });
    let p0 = redMasterTask(store);
    if (!p0 && prev.p0TaskId) { const pt = store.getTask(prev.p0TaskId); if (pt && pt.status !== 'done') p0 = pt; }
    if (!p0) {
      p0 = store.createTask({
        title: `Fix red master: ${(next.base || 'base branch')} unit tests failing`,
        description: `Auto-created by the merge gate: the base branch fails the unit suite.\nFailing: ${names}\n${owner}\nSource: ${next.detail || next.source || 'merge gate'}`,
        priority: 'P0', createdBy: 'merge-gate',
      });
      store.updateTask(p0.id, { redMaster: true });
    }
    h.p0TaskId = p0.id;
  }
  if (next.state === 'green' && prev.state === 'red') {
    store.appendLog({ at: Date.now(), nodeId: null, kind: 'master.green', text: `master is green again (verified by the merge gate${next.source ? ' — ' + next.source : ''}).` });
    let p0 = redMasterTask(store);
    if (!p0 && prev.p0TaskId) p0 = store.getTask(prev.p0TaskId);
    if (p0 && !['done', 'merge_conflict'].includes(p0.status)) {
      if (p0.status === 'todo' && !p0.assignee) {
        store.commentTask(p0.id, 'system', 'master verified green by the merge gate — auto-closing this fix task.');
        store.updateTask(p0.id, { status: 'done' });
      } else {
        store.commentTask(p0.id, 'system', 'master verified green by the merge gate — if your fix is already in, close this task.');
      }
    }
    h.p0TaskId = null;
  }
  writeHealth(root, h);
  return h;
}

// ---- cross-process merge lock: one merge at a time per repo (#1: two branches can otherwise
// each pass against the same master and then both land an untested combination). The holder
// heartbeats the lock dir every 10s; a holder that died mid-merge stops heartbeating, so its
// lock is stolen as stale after 60s instead of wedging every later merge.
async function withMergeLock(root, fn) {
  const lock = path.join(root, '.squad', 'merge.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const acquire = () => { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); };
  const deadline = Date.now() + GATE.LOCK_STALE_MS;
  for (;;) {
    try { acquire(); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      if (age > 60_000 || Date.now() > deadline) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} continue; }
      // async sleep: a sync busy-wait would starve the event loop — starving the CURRENT holder's
      // spawn IO when both merges run in one process (two tasks flipped done back-to-back).
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const beat = setInterval(() => { try { const now = new Date(); fs.utimesSync(lock, now, now); } catch {} }, 10_000);
  beat.unref?.();
  try { return await fn(); } finally { clearInterval(beat); try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

async function tryMergeLock(root, fn) {
  const lock = path.join(root, '.squad', 'merge.lock');
  try { fs.mkdirSync(lock); } catch { return null; }
  try { return await fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

// ---- suite runner ----
function childEnv() {
  const e = { ...process.env, CI: '1' };
  // AGENTS_SQUAD_* isolation vars must not leak into the suite; NODE_TEST_CONTEXT would make the
  // spawned node --test believe it is nested in a test file and skip every suite file.
  for (const k of Object.keys(e)) if ((k.startsWith('AGENTS_SQUAD_') && k !== 'AGENTS_SQUAD_GATE_TEST_TIMEOUT_MS') || k === 'NODE_TEST_CONTEXT') delete e[k];
  return e;
}

function runCmd(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', timedOut = false, spawnErr = null, done = false;
    let p;
    try { p = spawn(cmd, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true }); } catch (e) { return resolve({ code: -1, out: '', timedOut: false, spawnErr: e }); }
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-p.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 3000).unref?.();
    }, timeoutMs);
    const collect = (d) => { out += d; if (out.length > 1e6) out = out.slice(-5e5); }; // hard cap
    p.stdout.on('data', collect); p.stderr.on('data', collect);
    p.on('error', (e) => { spawnErr = e; finish({ code: -1, out, timedOut, spawnErr }); });
    p.on('close', (code) => finish({ code, out, timedOut, spawnErr }));
  });
}

function parseSummary(out) {
  const tests = Number((out.match(/^[^\S\n]*ℹ tests (\d+)/m) || [])[1]);
  const fail = Number((out.match(/^[^\S\n]*ℹ fail (\d+)/m) || [])[1]);
  const names = [...new Set((out.match(/^✖ (?!failing tests:)(.+)$/gm) || [])
    .map((l) => l.replace(/^✖ /, '').replace(/\s+\([\d.]+ms\)$/, '').trim().slice(0, 140)))]
    .filter((n) => !/^\d+\.\s/.test(n));
  return { summarySeen: Number.isFinite(tests), tests: tests || 0, fail: Number.isFinite(fail) ? fail : 0, names: names.slice(0, GATE.MAX_NAMES) };
}

// Infra, not code (t_485c97c5 #3): runner killed by the timeout, npm/spawn itself failed, the
// summary never appeared (crash before/at report time), or a bare (dependency) module is missing.
function isInfra(r) {
  if (r.timedOut || r.spawnErr) return true;
  const s = parseSummary(r.out);
  if (!s.summarySeen) return true;
  const bare = /Cannot find module '([^']+)'/g; let m;
  while ((m = bare.exec(r.out))) if (!m[1].startsWith('.') && !m[1].startsWith('/')) return true;
  return false;
}

const tail = (out) => out.slice(-GATE.TAIL_CAP);

// Worktree package dir may share node_modules with the main checkout when dependencies are
// identical; otherwise it installs its own (missing deps in the worktree is infra, not a red test).
async function ensureDeps(wtPkg, rootPkg) {
  try { fs.lstatSync(path.join(wtPkg, 'node_modules')); return null; } catch {}
  const same = readIf(path.join(wtPkg, 'package.json')) === readIf(path.join(rootPkg, 'package.json'))
    && readIf(path.join(wtPkg, 'package-lock.json')) === readIf(path.join(rootPkg, 'package-lock.json'));
  if (same && fs.existsSync(path.join(rootPkg, 'node_modules'))) {
    try { fs.symlinkSync(path.join(rootPkg, 'node_modules'), path.join(wtPkg, 'node_modules'), 'dir'); return null; } catch {}
  }
  const r = await runCmd('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], wtPkg, GATE.INSTALL_TIMEOUT_MS);
  if (r.code !== 0) return `npm install failed in the worktree (${tail(r.out).trim() || 'no output'})`;
  return null;
}

// Runs the suite once; red triggers at most one full rerun (flaky policy). Returns
// {state: 'green'|'red'|'infra', tests, names, tailOut, flaky}.
async function runSuite(wtPkg, rootPkg) {
  const depErr = await ensureDeps(wtPkg, rootPkg);
  if (depErr) return { state: 'infra', names: [], tailOut: depErr, flaky: [] };
  let first = null;
  for (let attempt = 0; attempt < (GATE.RERUN_ONCE ? 2 : 1); attempt++) {
    const r = await runCmd('npm', ['test'], wtPkg, GATE.TEST_TIMEOUT_MS);
    if (isInfra(r)) {
      if (attempt === 0 && !r.timedOut) continue; // infra (not a hang): retry once (#3)
      return { state: 'infra', names: [], tailOut: r.timedOut ? `unit suite timed out after ${Math.round(GATE.TEST_TIMEOUT_MS / 1000)}s` : tail(r.out), flaky: [] };
    }
    const s = parseSummary(r.out);
    if (s.fail === 0 && r.code === 0) return { state: 'green', tests: s.tests, names: [], tailOut: '', flaky: first ? first.names : [] };
    first = s;
  }
  return { state: 'red', tests: first.tests, names: first.names, tailOut: '', flaky: [] };
}

// Runs the suite against a specific base tree in a throwaway detached worktree (attribution:
// is master itself red, or is this branch's fault?). Caller is inside the merge lock.
async function runSuiteOnBase(root, baseSha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gate-base-'));
  try {
    gitRun(root, ['worktree', 'add', '--detach', dir, baseSha]);
    const pkg = suiteDirOf(dir);
    if (!pkg) return { state: 'skipped', names: [], flaky: [] };
    return await runSuite(pkg, suiteDirOf(root) || pkg);
  } catch (e) {
    return { state: 'infra', names: [], tailOut: 'base sanity check failed: ' + errText(e), flaky: [] };
  } finally {
    try { gitRun(root, ['worktree', 'remove', '--force', dir]); } catch { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

const capComment = (g) => {
  const names = g.names.length ? g.names.map((n) => '- ' + n).join('\n') : '- (test names unavailable)';
  return `${names}\n\ntail of npm test output:\n\`\`\`\n${g.tailOut || '(none)'}\n\`\`\``;
};

function reopenWith(store, t, text) {
  store.commentTask(t.id, 'system', text);
  store._updateTask(t.id, { status: 'todo', reopenCount: (t.reopenCount || 0) + 1 });
  return store.getTask(t.id);
}

// The gated merge. Same result shape as WT.worktreeMerge plus `gate`:
// {state: 'green'|'flaky-green'|'skipped'|'red'|'infra'|'master-red'|'tree-mismatch', ...}.
// A red/infra gate does not merge: the task is reopened (todo) with the failing output.
async function gateMerge(t, store) {
  const root = repoRootOf(t);
  const base = baseBranchOf(root);
  return withMergeLock(root, async () => {
    for (let round = 0; round < GATE.MAX_CAS_ROUNDS; round++) {
      let ahead;
      try { ahead = Number(gitRun(root, ['rev-list', '--count', `${base}..${t.worktreeBranch}`])); } catch { ahead = 1; }
      if (ahead === 0) return { base, branch: t.worktreeBranch, merged: false, gate: { state: 'skipped', note: 'no commits ahead' } };
      const dirty = WT.dirtyMainFiles(root);
      if (dirty.length) return { base, branch: t.worktreeBranch, merged: false, refused: true, dirty };
      const testedBase = revParse(root, base);
      try { gitRun(t.worktreePath, ['merge', '--no-edit', base]); }
      catch (e) { try { gitRun(t.worktreePath, ['merge', '--abort']); } catch {} throw new Error(`merge of ${t.worktreeBranch} into ${base} failed, aborted: ${errText(e)}`); }

      const wtPkg = suiteDirOf(t.worktreePath);
      const bypass = !!process.env.AGENTS_SQUAD_GATE_DISABLED; // break-glass: gate infra broken
      const g = !bypass && wtPkg ? await runSuite(wtPkg, suiteDirOf(root) || wtPkg) : { state: 'skipped', names: [], flaky: [] };

      if (g.state === 'green' || g.state === 'skipped') {
        if (revParse(root, base) !== testedBase) continue; // CAS: base moved, re-merge and re-test (#1)
        gitRun(root, ['merge', '--ff-only', t.worktreeBranch]);
        const mergedTree = revParse(root, `${base}^{tree}`);
        const testedTree = revParse(t.worktreePath, 'HEAD^{tree}');
        if (mergedTree !== testedTree) { // only possible if someone bypassed the lock mid-merge
          setHealth(store, root, { state: 'red', failing: ['(post-merge tree mismatch — base changed outside the gate)'], base, source: 'post-merge verification', lastMergedTask: t.id, lastMergedBranch: t.worktreeBranch });
          return { base, branch: t.worktreeBranch, merged: true, gate: { state: 'tree-mismatch' } };
        }
        const wasRed = readHealth(root).state === 'red';
        setHealth(store, root, { state: 'green', failing: [], base, lastGreenTree: mergedTree, lastMergedTask: t.id, lastMergedBranch: t.worktreeBranch, source: wasRed ? 'merge gate' : undefined });
        return { base, branch: t.worktreeBranch, merged: true, gate: { state: g.state, tests: g.tests || 0, flaky: g.flaky || [] } };
      }
      if (g.state === 'red') {
        const baseCheck = await runSuiteOnBase(root, testedBase);
        if (baseCheck.state === 'red') {
          const prev = readHealth(root);
          setHealth(store, root, { state: 'red', failing: baseCheck.names, base, source: 'merge gate', lastMergedTask: prev.lastMergedTask, lastMergedBranch: prev.lastMergedBranch, detail: `detected while merging ${t.worktreeBranch}` });
          reopenWith(store, t, `merge gate: NOT merged — the base branch (${base}@${testedBase.slice(0, 8)}) itself fails the unit suite, so this may not be your branch's fault. A P0 fix task has been created.\nFailing on base:\n${capComment(baseCheck)}`);
          return { base, branch: t.worktreeBranch, merged: false, gate: { state: 'master-red', names: baseCheck.names } };
        }
        reopenWith(store, t, `merge gate: NOT merged — npm test fails on ${t.worktreeBranch} (base is green, rerun confirmed). Fix and mark done to retry.\nFailing tests:\n${capComment(g)}`);
        return { base, branch: t.worktreeBranch, merged: false, gate: { state: 'red', names: g.names } };
      }
      reopenWith(store, t, `merge gate: NOT merged — the unit suite could not run (infrastructure error, retried once; not counted as a test failure). Fix the environment or retry.\n${capComment(g)}`);
      return { base, branch: t.worktreeBranch, merged: false, gate: { state: 'infra' } };
    }
    throw new Error(`merge gate: base branch ${base} kept moving under concurrent merges; no merge performed after ${GATE.MAX_CAS_ROUNDS} rounds`);
  });
}

// Startup sweep: detect a red master that never went through the gate (direct commits, old
// merges). Cheap: skipped unless the base tree differs from the last tree proven green, and
// skipped entirely when a gated merge is already in flight (it updates health itself).
function checkMasterHealth(store) {
  const t = store.listTasks().filter((x) => x.worktreePath).pop();
  if (!t) return;
  let root, base; try { root = repoRootOf(t); base = baseBranchOf(root); } catch { return; }
  const health = readHealth(root);
  let tree; try { tree = revParse(root, `${base}^{tree}`); } catch { return; }
  if (health.state === 'green' && health.lastGreenTree === tree) return;
  tryMergeLock(root, async () => {
    const r = await runSuiteOnBase(root, tree);
    if (r.state === 'red') setHealth(store, root, { state: 'red', failing: r.names, base, source: 'startup check', detail: 'base fails the unit suite (no merge involved)' });
    else if (r.state === 'green') setHealth(store, root, { state: 'green', failing: [], base, lastGreenTree: tree, source: 'startup check' });
  });
}

module.exports = { GATE, gateMerge, checkMasterHealth, parseSummary, isInfra, runSuite, runCmd, withMergeLock, tryMergeLock, setHealth, readHealth, suiteDirOf, ensureDeps, runSuiteOnBase };
