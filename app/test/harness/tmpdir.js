'use strict';
// Per-run private TMPDIR (t_4f2ff7cc): `npm test` gives the whole run one throwaway temp root
// (squad-test-<pid> under the system tmpdir) so every mkdtemp the suite and the src code make
// lands inside it and vanishes with the run — pass, fail or SIGINT. The dir is created here once
// by the run root (the `node --test` process, before any test file is spawned) and passed down
// through the environment: descendants of the run see AGENTS_SQUAD_TEST_TMPDIR and neither create
// nor clean up. Only the root removes the dir, in an `exit` hook plus SIGINT/SIGTERM handlers
// (--test-force-exit skips later teardowns but still fires `exit`). A run killed hard leaves its
// dir to the next run's startup sweep, which deletes squad-test-* dirs whose pid is dead — never
// a live concurrent run's, whatever its age — plus legacy debris (squad-*, su-*, am-*, wt-*,
// bc-*, mgate-*) older than an hour. The sweep only ever looks inside the system tmpdir; the
// live store and worktrees under ~/.agents-squad are out of its reach by construction. See
// docs/testing.md.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_PREFIX = 'squad-test-';
const RUN_DIR_RE = /^squad-test-\d+$/;
const LEGACY_PREFIXES = ['squad-', 'su-', 'am-', 'wt-', 'bc-', 'mgate-'];
const STALE_AFTER_MS = 60 * 60 * 1000;
const RUN_DIR_ENV = 'AGENTS_SQUAD_TEST_TMPDIR';
const REAL_TMP_ENV = 'AGENTS_SQUAD_REAL_TMP';

// The un-spoofed system tmpdir. Must be read at module load: by the time any other code runs,
// the run root has already pointed TMPDIR (and this module's exports) at the private dir, and
// descendants inherit AGENTS_SQUAD_REAL_TMP because their TMPDIR was private before they started.
const REAL_TMP = process.env[REAL_TMP_ENV] || os.tmpdir();

// Strictly inside the system tmpdir, with the exact run-dir shape — the rm guard: nothing else
// is ever removed, whatever calls cleanup() with.
function isRunDirPath(p, base = REAL_TMP) {
  const resolved = path.resolve(String(p));
  return resolved.startsWith(path.resolve(base) + path.sep) && RUN_DIR_RE.test(path.basename(resolved));
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // alive but unkillable beats dead
  }
}

function isStale(p, now) {
  try {
    return now - fs.statSync(p).mtimeMs > STALE_AFTER_MS;
  } catch {
    return false;
  }
}

// The sweep decision for one tmpdir entry: run dirs die with their owner's pid (live concurrent
// runs are never touched, however old), legacy debris only after STALE_AFTER_MS. The stale probe
// takes the entry NAME; both predicates are injectable so tests can sandbox without touching the
// system tmpdir.
function shouldSweep(name, alive = pidIsAlive, staleName = (n) => isStale(path.join(REAL_TMP, n))) {
  if (RUN_DIR_RE.test(name)) return !alive(Number(name.slice(RUN_PREFIX.length)));
  return LEGACY_PREFIXES.some((p) => name.startsWith(p)) && staleName(name);
}

// Walks one directory and removes what shouldSweep rejects. The startup sweep passes the system
// tmpdir (the default); tests pass a sandbox. Only direct entries are ever considered.
function sweepRuns(dir = REAL_TMP) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  const staleName = (n) => {
    try { return now - fs.statSync(path.join(dir, n)).mtimeMs > STALE_AFTER_MS; } catch { return false; }
  };
  for (const name of entries) {
    if (!shouldSweep(name, pidIsAlive, staleName)) continue;
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* raced with its owner */ }
  }
}

// Chooses this process's relationship to the run: the root (no run dir in env yet) creates the
// private dir under the system tmpdir, points TMPDIR/TEMP/TMP at it, moves AGENTS_SQUAD_PROJECT
// inside (the old package.json `$(mktemp -d)` leaked one dir per run) and records both env vars
// for descendants; a descendant adopts the inherited dir and does nothing else. The dir name is
// literally squad-test-<pid> — the name encodes the owning pid on purpose (the sweep judges run
// dirs by pid liveness and the rm guard matches the exact shape), so mkdtemp's random suffix is
// out; a dir of the same name can only be debris from a dead previous owner of this pid.
function createRun(env = process.env) {
  if (env[RUN_DIR_ENV]) return { dir: env[RUN_DIR_ENV], owner: false, project: env.AGENTS_SQUAD_PROJECT || null };
  sweepRuns();
  const dir = path.join(REAL_TMP, RUN_PREFIX + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  env[REAL_TMP_ENV] = REAL_TMP;
  env[RUN_DIR_ENV] = dir;
  env.TMPDIR = dir;
  env.TMP = dir;
  env.TEMP = dir;
  env.AGENTS_SQUAD_PROJECT = project;
  return { dir, owner: true, project };
}

// Root-only: teardown on exit and on SIGINT/SIGTERM. Descendants return untouched.
function install() {
  const run = createRun();
  if (!run.owner) return run;
  const finish = () => {
    if (isRunDirPath(run.dir)) {
      try { fs.rmSync(run.dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
    }
  };
  process.once('exit', finish);
  process.once('SIGINT', () => { finish(); process.exit(130); });
  process.once('SIGTERM', () => { finish(); process.exit(143); });
  return run;
}

module.exports = {
  install,
  createRun,
  sweepRuns,
  shouldSweep,
  isRunDirPath,
  pidIsAlive,
  realTmp: REAL_TMP,
  runPrefix: RUN_PREFIX,
  legacyPrefixes: LEGACY_PREFIXES,
  staleAfterMs: STALE_AFTER_MS,
  runDirEnv: RUN_DIR_ENV,
  realTmpEnv: REAL_TMP_ENV,
};
