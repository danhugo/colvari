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
const SIGINT_AFTER_MS = 3000;

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

function run(files, sigint) {
  // The spawned run must look like a run from a clean shell: no inherited private-TMPDIR state.
  const env = { ...process.env };
  for (const k of [runDirEnv, realTmpEnv, 'AGENTS_SQUAD_PROJECT', 'AGENTS_SQUAD_TEST_ISOLATION', 'TMPDIR', 'TMP', 'TEMP']) delete env[k];
  const child = cp.spawn('npm', ['run', 'test:subset', '--silent', '--', ...files], {
    cwd: APP_ROOT, env, stdio: 'inherit',
    detached: sigint, // own process group so the SIGINT reaches npm, sh, node and test children
  });
  if (sigint) {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGINT'); } catch { try { child.kill('SIGINT'); } catch { /* gone */ } }
    }, SIGINT_AFTER_MS);
    child.once('exit', () => clearTimeout(timer));
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function main() {
  const sigint = process.argv.includes('--sigint');
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const before = listTmp();
  const beforeSet = new Set(before);
  const beforeMonitored = before.filter(isMonitored);
  const wtBefore = worktreeCount();
  console.log(`[tmpdir-hygiene] tmpdir ${realTmp}: ${before.length} entries, ${beforeMonitored.length} monitored (squad-test-*/legacy) before the run`);
  console.log(`[tmpdir-hygiene] spawning ${sigint ? 'with SIGINT after ' + SIGINT_AFTER_MS + 'ms' : 'to completion'}: npm run test:subset -- ${files.join(' ')}`);

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
