// Pre-merge test gate (t_897cca56): no red code reaches the base branch. Contract per
// t_12a92368 (epic t_ee2721f7 16:08Z + 16:15Z amendment), made ASYNC by t_5a78aa95 — the old
// synchronous gate froze the Electron main process for the whole suite run (minutes):
//   gateMerge(t, opts)  t = {id, worktreePath, worktreeBranch}. Per-root cross-process lock
//                       (a live holder is waited for ASYNC — never stolen by age, see
//                       lockStealable; in-process callers are also serialized by store's merge
//                       queue so a second done-flip queues behind a live gate instead of racing
//                       it) -> merge the base into the task branch in its worktree -> run the
//                       tests -> land on the base with --no-ff only if green (CAS: if the base
//                       moved meanwhile, re-absorb and re-test; the tested tree IS the merged
//                       tree; t_9b8f6195: the worktree must be porcelain-clean — exact-path junk
//                       like .DS_Store is denied from the refusal — and its HEAD sha+tree are
//                       re-checked after the tests, before landing; a branch that moved mid-gate
//                       takes the same re-absorb/re-test path, rounds counted by MAX_CAS_ROUNDS).
//                       opts.runTests({worktreePath, root, base, branch}) callback ->
//                       {ok, output} (sync or async); or opts.testCmd (shell command, cwd = the
//                       worktree); absent -> the real unit suite (`npm test`, node --test) with
//                       dependency sharing and a flaky rerun-once policy.
//   returns {merged:true, base, branch, sha, gate:{state, tests, flaky, tree}}
//         | {merged:false, reason:'tests-failed', output, names}
//         | {merged:false, reason:'master-red', output, names, baseSha}
//         | {merged:false, reason:'infra', output}
//         | {merged:false, refused:true, dirty}   (main checkout has uncommitted changes)
//         | {merged:false, refused:true, reason:'worktree-dirty', dirty}             (t_9b8f6195: uncommitted files in the task worktree)
//         | {merged:false, refused:true, reason:'worktree-dirty-after-tests', dirty} (the test run itself left uncommitted files)
//   git conflicts throw /failed, aborted/ — same contract as worktreeMerge.
const { spawn } = require('child_process');
const CP = require('./cp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WT = require('./worktree');
const SB = require('./sandbox');

// The suite child sits in the machine-wide heavy slot (test/harness/heavy-slot.js) before its
// tests start: up to MAX_WAIT (default 20 min) waiting for the slot/load. The watchdog timeout
// must cover that wait PLUS the suite run itself, or a healthy gate is killed mid-wait (Pia
// relay of t_h0a1c2fe). Keep in sync with heavy-slot's AGENTS_SQUAD_HEAVY_MAX_WAIT_MS.
const HEAVY_SLOT_WAIT_MS = Number(process.env.AGENTS_SQUAD_HEAVY_MAX_WAIT_MS) || 20 * 60_000;
const GATE = { TEST_TIMEOUT_MS: Number(process.env.AGENTS_SQUAD_GATE_TEST_TIMEOUT_MS) || HEAVY_SLOT_WAIT_MS + 8 * 60_000, INSTALL_TIMEOUT_MS: 5 * 60_000, RERUN_ONCE: true, LOCK_STALE_MS: 25 * 60_000, LOCK_STEAL_MS: 60_000, MAX_CAS_ROUNDS: 3, TAIL_CAP: 1200, MAX_NAMES: 12, MAX_BLOCKS: 5, PIDFILE: 'merge-gate.pids', TERM_GRACE_MS: 300, WD_SLACK_MS: 15_000, GIT_TIMEOUT_MS: 60_000 };
const gitRun = async (cwd, args) => CP.runThrow('git', args, { cwd, timeoutMs: GATE.GIT_TIMEOUT_MS });
const revParse = async (root, ref) => gitRun(root, ['rev-parse', ref]);
const errText = (e) => String(e.stderr || e.message || e).trim();
const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const capTail = (out) => String(out || '').slice(-GATE.TAIL_CAP).trim();
const repoRootOf = (t) => path.resolve(t.worktreePath, '..', '..', '..');
// t_9b8f6195: the gate tests the worktree's WORKING files but lands its committed branch, so
// uncommitted files mean the tested tree is not the landed tree — refuse them (reason
// worktree-dirty) unless they are exact-path junk (no globs; real ignores belong in .gitignore,
// which porcelain already honors). Porcelain paths start at column 3; renames report "old -> new".
const WT_DIRTY_JUNK = new Set(['.DS_Store']);
const worktreeDirtyPaths = async (wt) => (await gitRun(wt, ['status', '--porcelain'])).split('\n').filter(Boolean)
  .map((l) => { let p = l.slice(3); const i = p.indexOf(' -> '); if (i >= 0) p = p.slice(i + 4); if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); return p; })
  .filter((p) => !WT_DIRTY_JUNK.has(p));
// Process-group containment (t_85041490): the gate's suite spawns deep trees (node --test workers,
// gui-e2e Electron runs, agent CLIs) and must never outlive the gate. Live groups are recorded in
// a pidfile mid-run (so even a SIGKILLed gate process leaves a trail) and reaped by recorded pid —
// identity-verified via the process start time, never by name.
const gatePidFile = (root) => path.join(root, '.squad', GATE.PIDFILE);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A starved `ps` (EAGAIN/timeout under a fork-storming suite or machine) returns empty — that is
// a FAILED observation, not a recycled pid: treating '' as a mismatch makes reapGatePidFile skip
// a live orphan forever (its "1 orphan agent run stopped" reap silently becomes a skip). Retry
// briefly before giving up, mirroring harness-sweep's psField (t_8f7605c4).
const pidLstart = async (pid) => {
  for (let i = 0; i < 3; i++) {
    let out = '';
    try { const r = await CP.run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5000 }); out = String(r.stdout || '').trim(); } catch { /* transient spawn failure: retry */ }
    if (out) return out;
    if (i < 2) await CP.sleep(50 * (i + 1));
  }
  return '';
};
async function killGroup(pgid) { try { process.kill(-pgid, 'SIGTERM'); } catch {} await CP.sleep(GATE.TERM_GRACE_MS); try { process.kill(-pgid, 'SIGKILL'); } catch {} }
async function reapGatePidFile(file) {
  const out = { killed: [], skipped: [] };
  const text = readIf(file); if (text == null) return out;
  const keep = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [pidS, lstart = '', cmd = ''] = line.split('\t');
    const pid = Number(pidS);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (pidAlive(pid) && (await pidLstart(pid)) !== lstart) { out.skipped.push({ pid, cmd }); keep.push(line); continue; } // recycled pid: never ours to kill — kept for a later retry
    if (!pidAlive(pid) && !groupAlive(pid)) continue; // leader and its group both gone
    try { await killGroup(pid); } catch {}
    out.killed.push({ pid, cmd });
  }
  try { if (keep.length) fs.writeFileSync(file, keep.join('\n') + '\n'); else fs.rmSync(file, { force: true }); } catch {}
  return out;
}
const reapGatePids = async (root) => reapGatePidFile(gatePidFile(root));
// Startup reap entry (orchestrator boot, before a gate run): take the merge lock without waiting —
// a held lock means a gate is live right now and its group is NOT ours to reap.
async function reapStaleGatePids(root) {
  const lock = path.join(root, '.squad', 'merge.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') return { skipped: true }; throw e; }
  try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); } catch {}
  try { return await reapGatePids(root); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}
// The suite runner (t_85041490): `node -e` watchdog that spawns the suite DETACHED in its own
// process group, records pid + start time + cmd in the pidfile before anything else (even a
// SIGKILLed gate process leaves a reapable trail), enforces the HARD timeout on a live event
// loop — TERM then KILL the whole group; spawnSync's own timeout is not hard, a TERM-immune
// child blocks it until natural exit — and reports {status, signal, stdout, stderr} via a file.
const WATCHDOG = `
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const cfg = JSON.parse(process.env.GATE_RUN_JSON);
const lstart = (pid) => { try { return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim(); } catch { return ''; } };
const tail = (a) => a.join('').slice(-4194304);
const out = { status: null, signal: null, error: null, stdout: '', stderr: '' };
let fin = false;
const finish = (status, signal) => { if (fin) return; fin = true; out.status = status; out.signal = signal; try { fs.writeFileSync(cfg.outFile, JSON.stringify(out)); } catch {} process.exit(0); };
let child;
try { child = spawn(cfg.cmd, cfg.args, { cwd: cfg.cwd, env: cfg.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { out.error = String((e && e.message) || e); finish(null, null); }
if (child && child.pid) { try { fs.writeFileSync(cfg.pidFile, [child.pid, lstart(child.pid), cfg.cmdLine].join('\\t') + '\\n'); } catch {} }
const bufs = { o: [], e: [] };
let timer = null;
let fired = false; // the hard deadline has passed: from here on, any close is a timeout death
const SIG_BY_CODE = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 14: 'SIGALRM', 15: 'SIGTERM' };
child.on('error', (e) => { if (timer) clearTimeout(timer); out.stdout = tail(bufs.o); out.stderr = tail(bufs.e); out.error = String((e && e.message) || e); finish(null, null); });
child.stdout.on('data', (d) => bufs.o.push(d));
child.stderr.on('data', (d) => bufs.e.push(d));
// After the deadline the tree may die INDIRECTLY: an external reaper (observed on macOS 26 with
// on-access AV: the suite's children get SIGKILLed ~TERM_GRACE after the group TERM) can leave
// the direct child exiting normally with 128+N. That is still a timeout death — report the
// encoded signal, never a bogus normal exit code.
if (cfg.timeoutMs > 0) timer = setTimeout(() => { fired = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, cfg.graceMs || 300); }, cfg.timeoutMs);
child.on('close', (code, signal) => { if (timer) clearTimeout(timer); out.stdout = tail(bufs.o); out.stderr = tail(bufs.e); if (fired && code != null && code >= 128 + 1 && SIG_BY_CODE[code - 128]) { finish(null, SIG_BY_CODE[code - 128]); return; } finish(code, signal); });
`;
// The gate's spawns must never outlive the gate: the suite runs in its own group under the
// watchdog, and on return — clean OR timed out — the recorded group is swept, so node --test's
// per-file workers (and any Electron they spawned) cannot survive npm's death. Async (t_5a78aa95):
// the watchdog child is spawned and awaited on the event loop, so a minutes-long suite never
// blocks the main process. The outer wait only guards a watchdog that dies without reporting —
// the hard deadline itself is enforced inside the watchdog (whole group TERM -> KILL).
async function runTracked(cmd, args, opts = {}) {
  const { cwd, env, timeoutMs = GATE.TEST_TIMEOUT_MS, pidFile } = opts;
  if (process.platform === 'win32' || !pidFile) {
    const r = await CP.run(cmd, args, { cwd, env, timeoutMs });
    return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout, stderr: r.stderr };
  }
  const outFile = `${pidFile}.${process.pid}.out`;
  const cfg = JSON.stringify({ cmd, args, cwd, env: env || process.env, timeoutMs, graceMs: GATE.TERM_GRACE_MS, pidFile, outFile, cmdLine: [cmd].concat(args).join(' ') });
  await new Promise((resolve) => {
    let child;
    try { child = spawn(process.execPath, ['-e', WATCHDOG], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', GATE_RUN_JSON: cfg }, stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch { return resolve(); }
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { killGroup(child.pid); } catch {} finish(); }, timeoutMs + GATE.WD_SLACK_MS);
    child.on('error', finish);
    child.on('close', finish);
  });
  let out = null; try { out = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
  try { fs.rmSync(outFile, { force: true }); } catch {}
  try { await reapGatePidFile(pidFile); } catch {}
  if (!out) return { status: null, signal: 'SIGTERM', error: new Error('merge-gate: suite runner died before reporting (group swept)'), stdout: '', stderr: '' };
  return { status: out.status, signal: out.signal, error: out.error ? new Error(out.error) : null, stdout: out.stdout || '', stderr: out.stderr || '' };
}
const baseBranchOf = (root) => gitRun(root, ['symbolic-ref', '--short', 'HEAD']);
const suiteDirOf = (checkout) => { const p = path.join(checkout, 'app'); return readIf(path.join(p, 'package.json')) != null ? p : (readIf(path.join(checkout, 'package.json')) != null ? checkout : null); };
const healthFile = (root) => path.join(root, '.squad', 'merge-gate.json');
// Live gate state for the UI (Pia relay of t_h0a1c2fe): written for the whole gate run and
// removed at the end. phase is advisory: 'waiting' means the machine-wide heavy slot was held
// by ANOTHER suite at spawn time, so this run will sit in the slot queue (up to
// heavy-slot's 20 min) before its tests start; 'running' means the slot looked free. The
// board surfaces it via redMasterSnapshot().gateLive.
const liveFile = (root) => path.join(root, '.squad', 'merge-gate.live.json');
function writeLiveGate(root, rec) { try { const f = liveFile(root); fs.mkdirSync(path.dirname(f), { recursive: true }); if (rec) fs.writeFileSync(f, JSON.stringify(rec)); else fs.rmSync(f, { force: true }); } catch {} }
function readLiveGate(root) { try { return JSON.parse(fs.readFileSync(liveFile(root), 'utf8')); } catch { return null; } }
function slotBusyElsewhere() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(os.tmpdir(), 'agents-squad-heavy.lock', 'pid'), 'utf8')) || 0; } catch { return false; }
  return !!(pid && pid !== process.pid && pidAlive(pid));
}
function readHealth(root) { try { return JSON.parse(fs.readFileSync(healthFile(root), 'utf8')); } catch { return { state: 'unknown' }; } }
function writeHealth(root, h) { const f = healthFile(root); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(h, null, 2) + '\n'); fs.renameSync(tmp, f); }
const openTask = (store, id) => { const t = id && store.getTask(id); return t && !['done', 'merge_conflict'].includes(t.status) ? t : null; };
const redMasterTask = (store) => store.listTasks().find((x) => x.redMaster && !['done', 'merge_conflict'].includes(x.status));
const ownerSentence = (h, info) => info.lastMergedTask ? (info.source === 'merge gate' ? `last merged task ${info.lastMergedTask} (${info.lastMergedBranch || '?'})` : `no merge involved — likely a direct commit; last merged task was ${info.lastMergedTask} (owner is a guess)`) : h.lastMergedTask ? `no merge involved — likely a direct commit; last merged task was ${h.lastMergedTask} (owner is a guess)` : 'no merge involved — owner unknown';

function ensureRedMasterTask(store, info = {}) {
  const root = info.root || (() => { const t = store.listTasks().find((x) => x.worktreePath); return t && repoRootOf(t); })();
  if (!root) throw new Error('ensureRedMasterTask: no repo root');
  const prev = readHealth(root); const names = (info.tests || []).slice(0, GATE.MAX_NAMES); const h = { ...prev, state: 'red', failing: names, testOutput: capTail(info.output), base: info.base || prev.base, updatedAt: new Date().toISOString() };
  const wasRed = prev.state === 'red'; if (!wasRed) h.sinceMs = Date.now();
  if (info.lastMergedTask) { h.lastMergedTask = info.lastMergedTask; h.lastMergedBranch = info.lastMergedBranch || null; }
  let p0 = redMasterTask(store) || openTask(store, prev.p0TaskId);
  if (!p0) { p0 = store.createTask({ title: `Fix red master: ${h.base || 'base branch'} unit tests failing`, description: `Auto-created by the merge gate: the base branch fails the unit suite.\nFailing: ${names.join(', ') || 'unknown failures'}\n${ownerSentence(prev, info)}${info.detail ? `\nSource: ${info.detail}` : ''}`, priority: 'P0', createdBy: 'merge-gate' }); store.updateTask(p0.id, { redMaster: true }); }
  h.p0TaskId = p0.id; writeHealth(root, h);
  if (!wasRed) store.appendLog({ at: Date.now(), nodeId: null, kind: 'master.red', text: `master is red: ${names.join(', ') || 'unknown failures'}. ${ownerSentence(prev, info)}.` });
  return p0;
}
function markMasterGreen(store, info = {}) {
  const root = info.root; if (!root) throw new Error('markMasterGreen: root required');
  const prev = readHealth(root); const wasRed = prev.state === 'red'; const h = { ...prev, state: 'green', failing: [], testOutput: null, lastGreenTree: info.tree || prev.lastGreenTree, base: info.base || prev.base, updatedAt: new Date().toISOString() }; if (info.lastMergedTask) { h.lastMergedTask = info.lastMergedTask; h.lastMergedBranch = info.lastMergedBranch || null; }
  writeHealth(root, h);
  if (wasRed) { store.appendLog({ at: Date.now(), nodeId: null, kind: 'master.green', text: `master is green again (verified by the merge gate${info.source ? ' — ' + info.source : ''}).` }); let p0 = redMasterTask(store) || openTask(store, prev.p0TaskId); if (p0) { if (p0.status === 'todo' && !p0.assignee) { store.commentTask(p0.id, 'system', 'master verified green by the merge gate — auto-closing this fix task.'); store.updateTask(p0.id, { status: 'done' }); } else store.commentTask(p0.id, 'system', 'master verified green by the merge gate — if your fix is already in, close this task.'); } h.p0TaskId = null; writeHealth(root, h); }
  return h;
}
function recordGateBlock(store, info = {}) { if (!info.root) return; const h = readHealth(info.root); const blocks = [{ taskId: info.taskId, tests: (info.tests || []).slice(0, GATE.MAX_NAMES), at: Date.now() }, ...(h.gateBlocks || [])].slice(0, GATE.MAX_BLOCKS); writeHealth(info.root, { ...h, gateBlocks: blocks, updatedAt: new Date().toISOString() }); }
function redMasterSnapshot(store) { if (!store || typeof store.listTasks !== "function") return null; const xs = store.listTasks().filter((x) => x.worktreePath); if (!xs.length) return null; let root; try { root = repoRootOf(xs[xs.length - 1]); } catch { return null; } const h = readHealth(root); return { red: h.state === 'red', since: h.sinceMs || null, failingTests: h.state === 'red' ? (h.failing || []) : [], testOutput: h.state === 'red' ? (h.testOutput || null) : null, fixTaskId: h.state === 'red' ? (h.p0TaskId || null) : null, lastMergedTaskId: h.lastMergedTask || null, gateBlocks: h.gateBlocks || [], gateLive: root ? readLiveGate(root) : null }; }

// Steal rule for the merge lock (t_b9ed7fa3): the lock's mtime is written once at acquire and a
// real suite runs minutes under spawnSync, so age alone proves nothing — the old age-only check
// let a waiter steal from a LIVE holder mid-suite and start a second npm test in the same
// worktree. A stale lock is stealable only when its holder pid is provably gone (ESRCH; EPERM
// counts as alive — another user owns it), or when it has no readable pid (crash between mkdir
// and the pid write). A fresh lock keeps a grace window even with a dead pid. kill(pid,0) sees
// zombies as alive, so an unreaped crashed holder is waited out — bounded by the LOCK_STALE_MS
// deadline below, which stays as the escape hatch for any holder that will not release.
function lockStealable(lock) {
  let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { return false; } // vanished: let the next mkdir attempt decide
  if (age <= GATE.LOCK_STEAL_MS) return false;
  const pid = Number((readIf(path.join(lock, 'pid')) || '').trim());
  if (Number.isInteger(pid) && pid > 1) return !pidAlive(pid);
  return true;
}
async function withMergeLock(root, fn) {
  const lock = path.join(root, '.squad', 'merge.lock'); fs.mkdirSync(path.dirname(lock), { recursive: true }); const acquire = () => { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); }; const deadline = Date.now() + GATE.LOCK_STALE_MS;
  for (;;) { try { acquire(); break; } catch (e) { if (e.code !== 'EEXIST') throw e; if (lockStealable(lock) || Date.now() > deadline) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} continue; } await CP.sleep(50); } }
  try { return await fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}
function childEnv() { const e = { ...process.env, CI: '1' }; for (const k of Object.keys(e)) if ((k.startsWith('AGENTS_SQUAD_') && k !== 'AGENTS_SQUAD_GATE_TEST_TIMEOUT_MS') || k === 'NODE_TEST_CONTEXT') delete e[k]; return e; }
function parseSummary(out) { const tests = Number((out.match(/^[^\S\n]*ℹ tests (\d+)/m) || [])[1]); const fail = Number((out.match(/^[^\S\n]*ℹ fail (\d+)/m) || [])[1]); const names = [...new Set((out.match(/^✖ (?!failing tests:)(.+)$/gm) || []).map((l) => l.replace(/^✖ /, '').replace(/\s+\([\d.]+ms\)$/, '').trim().slice(0, 140)))].filter((n) => !/^\d+\.\s/.test(n)); return { summarySeen: Number.isFinite(tests), tests: tests || 0, fail: Number.isFinite(fail) ? fail : 0, names: names.slice(0, GATE.MAX_NAMES) }; }
function isInfra(out, timedOut) { if (timedOut) return true; const s = parseSummary(out); if (!s.summarySeen) return true; const bare = /Cannot find module '([^']+)'/g; let m; while ((m = bare.exec(out))) if (!m[1].startsWith('.') && !m[1].startsWith('/')) return true; return false; }
async function ensureDeps(wtPkg, rootPkg, root) { let wtNmSt = null; try { wtNmSt = fs.lstatSync(path.join(wtPkg, 'node_modules')); } catch {} const same = readIf(path.join(wtPkg, 'package.json')) === readIf(path.join(rootPkg, 'package.json')) && readIf(path.join(wtPkg, 'package-lock.json')) === readIf(path.join(rootPkg, 'package-lock.json')); // A shared symlink is never kept (t_09a2c1e0: npm ci wiped main through one) — drop it (rmSync on a symlink never touches the target); matching package files get a copy-on-write clone, otherwise install into a real local dir below.
if (wtNmSt && wtNmSt.isSymbolicLink()) { try { fs.rmSync(path.join(wtPkg, 'node_modules')); } catch {} wtNmSt = null; }
if (wtNmSt) return null; if (same && await WT.cloneNodeModules(path.join(rootPkg, 'node_modules'), path.join(wtPkg, 'node_modules'))) return null; const r = await runTracked('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: wtPkg, env: childEnv(), timeoutMs: GATE.INSTALL_TIMEOUT_MS, pidFile: root ? gatePidFile(root) : null }); const out = `${r.stdout || ''}${r.stderr || ''}`; return r.error || r.status !== 0 ? `npm install failed in the worktree (${capTail(out) || (r.error && r.error.message) || 'no output'})` : null; }
async function runDefaultSuite(wtPkg, rootPkg, root) { const depErr = await ensureDeps(wtPkg, rootPkg, root); if (depErr) return { state: 'infra', names: [], output: depErr, tests: 0, flaky: [] }; let first = null; for (let attempt = 0; attempt < (GATE.RERUN_ONCE ? 2 : 1); attempt++) { const r = await runTracked('npm', ['test'], { cwd: wtPkg, env: childEnv(), timeoutMs: GATE.TEST_TIMEOUT_MS, pidFile: root ? gatePidFile(root) : null }); const out = `${r.stdout || ''}${r.stderr || ''}`; if (isInfra(out, !!r.error || r.signal === 'SIGTERM' || r.signal === 'SIGKILL')) { const timed = !r.error && (r.signal === 'SIGTERM' || r.signal === 'SIGKILL'); if (attempt === 0 && !timed) continue; return { state: 'infra', names: [], output: timed ? `unit suite timed out after ${Math.round(GATE.TEST_TIMEOUT_MS / 1000)}s (process group killed)` : capTail(out), tests: 0, flaky: [] }; } const s = parseSummary(out); if (s.fail === 0 && r.status === 0) return { state: 'green', names: [], output: '', tests: s.tests, flaky: first ? first.names : [] }; first = { ...s, output: capTail(out) }; } return { state: 'red', names: first.names, output: first.output, tests: first.tests, flaky: [] }; }
async function runSuiteOnBase(root, baseSha) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gate-base-')); let locked = false; try { await gitRun(root, ['worktree', 'add', '--detach', dir, baseSha]); try { await gitRun(root, ['worktree', 'lock', dir]); locked = true; } catch {} // locked against the worktree sweeps while the suite runs inside it (t_a91c68ce)
 const pkg = suiteDirOf(dir); return pkg ? await runDefaultSuite(pkg, suiteDirOf(root) || pkg, root) : { state: 'skipped', names: [], output: '' }; } catch (e) { return { state: 'infra', names: [], output: 'base sanity check failed: ' + errText(e) }; } finally { if (locked) { try { await gitRun(root, ['worktree', 'unlock', dir]); } catch {} } try { await gitRun(root, ['worktree', 'remove', '--force', dir]); } catch { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } } }
async function runGateTests(t, root, base, opts) { const ctx = { worktreePath: t.worktreePath, root, base, branch: t.worktreeBranch }; if (opts.runTests) { let r; try { r = (await opts.runTests(ctx)) || {}; } catch (e) { r = { ok: false, output: 'runTests threw: ' + errText(e) }; } const s = parseSummary(String(r.output || '')); return { state: r.ok ? 'green' : 'red', names: s.names, output: capTail(r.output), tests: 0, flaky: [], defaultRunner: false }; } if (opts.testCmd) { const r = await runTracked('/bin/sh', ['-c', String(opts.testCmd)], { cwd: t.worktreePath, env: childEnv(), timeoutMs: GATE.TEST_TIMEOUT_MS, pidFile: gatePidFile(root) }); const out = `${r.stdout || ''}${r.stderr || ''}`; const s = parseSummary(out); return { state: !r.error && r.status === 0 ? 'green' : 'red', names: s.names, output: capTail(out), tests: 0, flaky: [], defaultRunner: false }; } const pkg = suiteDirOf(t.worktreePath); return pkg ? { ...(await runDefaultSuite(pkg, suiteDirOf(root) || pkg, root)), defaultRunner: true } : { state: 'skipped', names: [], output: '', tests: 0, flaky: [], defaultRunner: true }; }
async function gateMerge(t, opts = {}) { const root = repoRootOf(t); SB.guardRepo(root, 'auto-merge into'); // sandbox: refuse before any git side effect (t_8f7605c4)
  const base = await baseBranchOf(root); writeLiveGate(root, { phase: slotBusyElsewhere() ? 'waiting' : 'running', task: t.id, branch: t.worktreeBranch, since: Date.now() });
  try { return await withMergeLock(root, async () => { try { await reapGatePids(root); } catch {} // under the lock, so any recorded group is from a crashed gate, not a live sibling
  for (let round = 0; round < GATE.MAX_CAS_ROUNDS; round++) { let ahead; try { ahead = Number(await gitRun(root, ['rev-list', '--count', `${base}..${t.worktreeBranch}`])); } catch { ahead = 1; } if (ahead === 0) return { base, branch: t.worktreeBranch, root, merged: false, gate: { state: 'skipped', note: 'no commits ahead' } }; const dirty = await WT.dirtyMainFiles(root); if (dirty.length) return { base, branch: t.worktreeBranch, root, merged: false, refused: true, dirty }; const testedBase = await revParse(root, base); try { await gitRun(t.worktreePath, ['merge', '--no-edit', base]); } catch (e) { try { await gitRun(t.worktreePath, ['merge', '--abort']); } catch {} throw new Error(`merge of ${t.worktreeBranch} into ${base} failed, aborted: ${errText(e)}`); } const wtDirty = await worktreeDirtyPaths(t.worktreePath); if (wtDirty.length) return { base, branch: t.worktreeBranch, root, merged: false, refused: true, reason: 'worktree-dirty', dirty: wtDirty }; const testedSha = await revParse(t.worktreePath, 'HEAD'); const testedTree = await revParse(t.worktreePath, 'HEAD^{tree}'); const g = await runGateTests(t, root, base, opts); if (g.state === 'green' || g.state === 'skipped') { if ((await revParse(root, base)) !== testedBase) continue; if ((await revParse(t.worktreePath, 'HEAD')) !== testedSha || (await revParse(t.worktreePath, 'HEAD^{tree}')) !== testedTree) continue; const wtDirtyAfter = await worktreeDirtyPaths(t.worktreePath); if (wtDirtyAfter.length) return { base, branch: t.worktreeBranch, root, merged: false, refused: true, reason: 'worktree-dirty-after-tests', dirty: wtDirtyAfter }; try { await gitRun(root, ['merge', '--no-ff', '--no-edit', t.worktreeBranch]); } catch (e) { try { await gitRun(root, ['merge', '--abort']); } catch {} throw new Error(`landing ${t.worktreeBranch} into ${base} failed, aborted: ${errText(e)}`); } const mergedTree = await revParse(root, `${base}^{tree}`); if (mergedTree !== testedTree) { console.error(`[merge-gate] POST-MERGE TREE MISMATCH on ${t.id}/${t.worktreeBranch}: tested ${testedTree}, landed ${mergedTree} — base changed outside the gate (lock bypass?); flagging, not silently green`); return { base, branch: t.worktreeBranch, root, merged: true, reason: 'tree-mismatch', gate: { state: 'tree-mismatch' } }; } return { base, branch: t.worktreeBranch, root, merged: true, sha: await revParse(root, base), gate: { state: g.state, tests: g.tests || 0, flaky: g.flaky || [], tree: mergedTree } }; } if (g.state === 'red') { if (g.defaultRunner) { const baseCheck = await runSuiteOnBase(root, testedBase); if (baseCheck.state === 'red') return { base, branch: t.worktreeBranch, root, merged: false, reason: 'master-red', names: baseCheck.names, output: baseCheck.output, baseSha: testedBase, gate: { state: 'master-red' } }; } return { base, branch: t.worktreeBranch, root, merged: false, reason: 'tests-failed', names: g.names, output: g.output, baseSha: testedBase, gate: { state: 'red' } }; } return { base, branch: t.worktreeBranch, root, merged: false, reason: 'infra', output: g.output, names: [], gate: { state: 'infra' } }; } throw new Error(`merge gate: base branch ${base} kept moving under concurrent merges; no merge performed after ${GATE.MAX_CAS_ROUNDS} rounds`); }); } finally { writeLiveGate(root, null); } }
async function checkMasterHealth(store) { const xs = store.listTasks().filter((x) => x.worktreePath); if (!xs.length) return; let root, base; try { root = repoRootOf(xs[xs.length - 1]); base = await baseBranchOf(root); } catch { return; } try { await reapStaleGatePids(root); } catch {} // startup: leftover groups from a crashed gate die here (the orchestrator runs this detached at boot)
  const h = readHealth(root); let tree, commit; try { commit = await revParse(root, base); tree = await revParse(root, `${base}^{tree}`); } catch { return; } if (h.state === 'green' && h.lastGreenTree === tree) return; await withMergeLock(root, async () => { const r = await runSuiteOnBase(root, commit); if (r.state === 'red') ensureRedMasterTask(store, { root, tests: r.names, output: r.output, base, source: 'startup check' }); else if (r.state === 'green') markMasterGreen(store, { root, tree, base, source: 'startup check' }); }); }
module.exports = { GATE, gateMerge, writeLiveGate, readLiveGate, checkMasterHealth, ensureRedMasterTask, markMasterGreen, recordGateBlock, redMasterSnapshot, parseSummary, isInfra, runDefaultSuite, withMergeLock, lockStealable, readHealth, suiteDirOf, ensureDeps, runSuiteOnBase, runTracked, gatePidFile, reapGatePids, reapGatePidFile, reapStaleGatePids, killGroup, pidAlive, groupAlive, pidLstart };
