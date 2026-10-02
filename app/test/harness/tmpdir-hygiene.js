'use strict';
// Regression runner for the per-run private TMPDIR harness (t_4f2ff7cc). It must stand OUTSIDE
// the suite — it spawns a test run, so it cannot be part of the thing it measures. `npm run
// test:tmpdir [-- test/some.test.js ...]` boots a small subset through the real harness
// (npm run test:subset) and then asserts the system tmpdir gained no squad-test-*/legacy-prefix
// entries: the run's private dir must be gone after a clean exit — and, with --sigint, after a
// SIGINT mid-run too — stale pre-existing run dirs must have been swept, and `git worktree list`
// for this repo must be unchanged. Total tmpdir entry counts are printed for evidence but never
// asserted: unrelated processes write to the system tmpdir concurrently. See docs/testing.md.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { realTmp, runPrefix, legacyPrefixes, runDirEnv, realTmpEnv, pidIsAlive } = require('./tmpdir');

const APP_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_FILES = ['test/store-leak-guard.test.js', 'test/avatar.test.js'];

const isRunDir = (name) => name.startsWith(runPrefix) && /^\d+$/.test(name.slice(runPrefix.length));
const isMonitored = (name) => isRunDir(name) || legacyPrefixes.some((p) => name.startsWith(p));
const listTmp = () => { try { return fs.readdirSync(realTmp); } catch { return []; } };

function worktreeCount() {
  try {
    return cp.execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: APP_ROOT, timeout: 10000 })
      .toString().split('\n').filter((l) => l.startsWith('worktree ')).length;
  } catch {
    return null; // not a repo / no git — nothing to compare, skip the check
  }
}

// True when pid sits somewhere below ancestor in the process tree — the ownership check that
// keeps a concurrent run's squad-test-<pid> dir from being mistaken for our child's.
function isDescendantOf(pid, ancestor) {
  let p = pid;
  for (let i = 0; i < 32; i++) {
    let out;
    try { out = cp.execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { timeout: 2000 }).toString().trim(); } catch { return false; }
    const ppid = Number(out);
    if (!ppid) return false;
    if (ppid === ancestor) return true;
    p = ppid;
  }
  return false;
}

// Resolves with the name of OUR child's private run dir as soon as it exists — the only
// deterministic moment to SIGINT: a fixed delay either fires before the dir is created (the run
// completes untouched, proving nothing) or long after (same). Concurrent same-shape runs are
// filtered by pid ancestry.
function waitForRunDir(beforeSet, child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = listTmp().find((n) => isRunDir(n) && !beforeSet.has(n) && isDescendantOf(Number(n.slice(runPrefix.length)), child.pid));
      if (found) return resolve(found);
      if (child.exitCode !== null || child.signalCode) return reject(new Error('child exited before its run dir appeared'));
      if (Date.now() > deadline) return reject(new Error('no private run dir appeared within 60s'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function run(files, sigint) {
  // The spawned run must look like a run from a clean shell: no inherited private-TMPDIR state.
  // TMPDIR/TMP/TEMP stay AS INHERITED — a clean macOS shell has TMPDIR set (launchd) and node
  // would otherwise fall back to /tmp, putting the child's run dir and sweep in the wrong
  // tmpdir; only the harness's own variables are stripped.
  const env = { ...process.env };
  for (const k of [runDirEnv, realTmpEnv, 'AGENTS_SQUAD_PROJECT', 'AGENTS_SQUAD_TEST_ISOLATION']) delete env[k];
  const child = cp.spawn('npm', ['run', 'test:subset', '--silent', '--', ...files], {
    cwd: APP_ROOT, env, stdio: 'inherit',
    detached: sigint, // own process group so the SIGINT reaches npm, sh, node and test children
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (sigint) {
    waitForRunDir(new Set(listTmp()), child)
      .then((dir) => {
        console.log(`[tmpdir-hygiene] run dir ${dir} up — sending SIGINT to the process group`);
        try { process.kill(-child.pid, 'SIGINT'); } catch { try { child.kill('SIGINT'); } catch { /* gone */ } }
      })
      .catch((e) => console.error(`[tmpdir-hygiene] WARN ${e.message}`));
  }
  return exited;
}

async function main() {
  const sigint = process.argv.includes('--sigint');
  // With no explicit files the DEFAULT_FILES subset runs — bare `test:subset` would make node's
  // default glob pick up the WHOLE suite (goal/loop mode runs included), not a small subset.
  const argvFiles = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const files = argvFiles.length ? argvFiles : DEFAULT_FILES;
  const before = listTmp();
  const beforeSet = new Set(before);
  const beforeMonitored = before.filter(isMonitored);
  const wtBefore = worktreeCount();
  console.log(`[tmpdir-hygiene] tmpdir ${realTmp}: ${before.length} entries, ${beforeMonitored.length} monitored (squad-test-*/legacy) before the run`);
  console.log(`[tmpdir-hygiene] spawning ${sigint ? 'with SIGINT the moment its run dir appears' : 'to completion'}: npm run test:subset -- ${files.join(' ')}`);

  const { code, signal } = await run(files, sigint);

  const after = listTmp();
  const afterMonitored = after.filter(isMonitored);
  console.log(`[tmpdir-hygiene] run exited code=${code}${signal ? ` signal=${signal}` : ''}; tmpdir now ${after.length} entries, ${afterMonitored.length} monitored`);
  if (wtBefore !== null) console.log(`[tmpdir-hygiene] git worktree list: ${wtBefore} -> ${worktreeCount()}`);

  let failed = false;
  const fail = (msg) => { failed = true; console.error(`[tmpdir-hygiene] FAIL ${msg}`); };
  if (sigint && code === 0 && !signal) {
    fail('the spawned run completed instead of dying on the mid-run SIGINT — hygiene result is meaningless until it does');
  } else if (!sigint && code !== 0) {
    fail(`the spawned run failed (code=${code}) — hygiene result is meaningless until it passes`);
  }
  for (const name of after) {
    if (!isMonitored(name)) continue;
    const isNew = !beforeSet.has(name);
    const live = isRunDir(name) && pidIsAlive(Number(name.slice(runPrefix.length)));
    if (isNew && live) {
      console.log(`[tmpdir-hygiene] note: ${name} appeared during the run but its pid is alive — a concurrent run, not our leak`);
    } else if (isNew) {
      fail(`new monitored entry left behind: ${name}`);
    } else if (isRunDir(name) && !live) {
      fail(`stale run dir ${name} existed before the run and the startup sweep did not remove it`);
    }
  }
  if (afterMonitored.length > beforeMonitored.length) fail(`monitored entry count grew: ${beforeMonitored.length} -> ${afterMonitored.length}`);
  if (wtBefore !== null && worktreeCount() !== wtBefore) fail(`git worktree list changed: ${wtBefore} -> ${worktreeCount()}`);

  console.log(failed ? '[tmpdir-hygiene] FAILED' : '[tmpdir-hygiene] OK: no new temp debris, private dir torn down');
  process.exitCode = failed ? 1 : 0;
}

main();
