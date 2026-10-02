'use strict';
// Unit coverage for test/harness/tmpdir.js (t_4f2ff7cc): the sweep decision, the rm guard, the
// root/descendant split, and the signal teardown of a run root — all in sandboxes under this
// process's own tmpdir (the private run dir when run via `npm test`), never the real system
// tmpdir beyond reading it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const tmpdir = require('./harness/tmpdir');

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tmpdir-harness-sandbox-'));
const DEAD_PID = 999999998; // above every plausible pid_max; process.kill says ESRCH

test('shouldSweep: run dirs follow pid liveness, legacy dirs only staleness', () => {
  assert.equal(tmpdir.shouldSweep(`squad-test-1`, (pid) => pid === 1, () => false), false, 'live run dir is kept however stale');
  assert.equal(tmpdir.shouldSweep(`squad-test-2`, (pid) => pid === 1, () => true), true, 'dead run dir sweeps regardless of staleness');
  assert.equal(tmpdir.shouldSweep(`squad-test-${process.pid}`, () => true, () => true), false, 'this process is alive');
  assert.equal(tmpdir.shouldSweep('su-junk', () => true, () => true), true, 'stale legacy debris sweeps');
  assert.equal(tmpdir.shouldSweep('su-junk', () => true, () => false), false, 'fresh legacy debris is kept');
  assert.equal(tmpdir.shouldSweep('mgate-x', () => true, () => true), true, 'every legacy prefix is covered');
  assert.equal(tmpdir.shouldSweep('unrelated', () => true, () => true), false, 'unrelated names are never swept');
  for (const p of tmpdir.legacyPrefixes) {
    assert.equal(tmpdir.shouldSweep(`${p}x`, () => true, () => true), true, `prefix ${p}`);
  }
});

test('isRunDirPath: only squad-test-<digits> strictly inside the base passes', () => {
  const base = sandbox();
  try {
    assert.equal(tmpdir.isRunDirPath(path.join(base, 'squad-test-123'), base), true);
    assert.equal(tmpdir.isRunDirPath(path.join(base, 'squad-test-123'), sandbox()), false, 'wrong base');
    assert.equal(tmpdir.isRunDirPath(base, base), false, 'the base itself is not a run dir');
    assert.equal(tmpdir.isRunDirPath(path.join(base, 'squad-test-12a'), base), false, 'name shape is exact');
    assert.equal(tmpdir.isRunDirPath(path.join(base, 'other', 'squad-test-123'), base), true, 'deep paths under the base are still inside it');
    assert.equal(tmpdir.isRunDirPath('squad-test-123', base), false, 'relative paths do not pass');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('sweepRuns: removes only dead-pid run dirs and stale legacy debris in its dir', () => {
  const base = sandbox();
  try {
    const mk = (name, ageHours = 0) => {
      const p = path.join(base, name);
      fs.mkdirSync(p);
      if (ageHours) fs.utimesSync(p, new Date(Date.now() - ageHours * 3600e3), new Date(Date.now() - ageHours * 3600e3));
      return p;
    };
    mk(`squad-test-${DEAD_PID}`);            // dead run dir -> swept
    const live = mk(`squad-test-${process.pid}`); // live concurrent run -> kept
    const freshLegacy = mk('am-fresh');      // legacy but fresh -> kept
    mk('wt-old', 2);                         // legacy and >1h old -> swept
    const unrelated = mk('keeper');          // no known prefix -> kept
    tmpdir.sweepRuns(base);
    const left = new Set(fs.readdirSync(base));
    assert.equal(left.has(`squad-test-${DEAD_PID}`), false, 'dead run dir removed');
    assert.equal(left.has(`squad-test-${process.pid}`), true, 'live run dir survives');
    assert.ok(fs.existsSync(live), 'live run dir content intact');
    assert.equal(left.has('am-fresh'), true, 'fresh legacy survives');
    assert.equal(left.has('wt-old'), false, 'stale legacy removed');
    assert.equal(left.has('keeper'), true, 'unrelated survives');
    assert.ok(fs.existsSync(freshLegacy), 'fresh legacy content intact');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('createRun: a descendant adopts the inherited dir and mutates nothing', () => {
  const inherited = path.join(os.tmpdir(), 'squad-test-notreal');
  const env = { [tmpdir.runDirEnv]: inherited, TMPDIR: '/untouched' };
  const run = tmpdir.createRun(env);
  assert.deepEqual(run, { dir: inherited, owner: false, project: null });
  assert.equal(env.TMPDIR, '/untouched', 'descendant must not repoint tmp vars');
  assert.equal(env.AGENTS_SQUAD_PROJECT, undefined);
});

test('createRun: the owner claims a run dir and records it for descendants', () => {
  const env = { [tmpdir.realTmpEnv]: os.tmpdir() };
  const run = tmpdir.createRun(env);
  try {
    assert.equal(run.owner, true);
    assert.equal(tmpdir.isRunDirPath(run.dir, tmpdir.realTmp), true, 'run dir sits under the real system tmpdir');
    assert.equal(env[tmpdir.runDirEnv], run.dir);
    assert.equal(env.TMPDIR, run.dir, 'TMPDIR repointed at the run dir');
    assert.equal(env.TEMP, run.dir);
    assert.equal(env.AGENTS_SQUAD_PROJECT, run.project, 'store root moved inside the run dir');
    assert.equal(run.project, path.join(run.dir, 'project'));
    assert.ok(fs.existsSync(run.project), 'store root pre-created');
  } finally { fs.rmSync(run.dir, { recursive: true, force: true }); }
});

// Spawns a run root around tmpdir.install() in its own process, signals it, and checks the
// sandbox — the end-to-end proof that the owner cleans up on `exit`, SIGINT and SIGTERM, and
// that a descendant does neither.
for (const [label, signal, code] of [['SIGINT', 'SIGINT', 130], ['SIGTERM', 'SIGTERM', 143]]) {
  test(`install: run root torn down by ${label} leaves nothing behind`, async () => {
    const base = sandbox();
    const childCode = `
      const run = require(${JSON.stringify(require.resolve('./harness/tmpdir'))}).install();
      require('fs').writeFileSync(${JSON.stringify(path.join(base, 'env.json'))},
        JSON.stringify({ dir: run.dir, tmpdir: process.env.TMPDIR }));
      console.log('ready');
      setInterval(() => {}, 1000);
    `;
    const child = cp.spawn(process.execPath, ['-e', childCode], {
      env: { ...process.env, [tmpdir.realTmpEnv]: base, [tmpdir.runDirEnv]: '', AGENTS_SQUAD_PROJECT: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => { out += d; if (out.includes('ready')) resolve(); });
        child.once('exit', () => reject(new Error('run root exited before ready')));
      });
      const envSeen = JSON.parse(fs.readFileSync(path.join(base, 'env.json'), 'utf8'));
      assert.equal(tmpdir.isRunDirPath(envSeen.dir, base), true, 'run root created its dir in the sandbox');
      assert.equal(envSeen.tmpdir, envSeen.dir, 'TMPDIR repointed at the private dir');
      const before = fs.readdirSync(base).filter((n) => n.startsWith('squad-test-'));
      assert.equal(before.length, 1, 'exactly one run dir in the sandbox');
      child.kill(signal);
      const [exitCode, exitSignal] = await new Promise((resolve) => child.once('exit', (c, s) => resolve([c, s])));
      assert.equal(exitSignal, null, `handled ${label} itself`);
      assert.equal(exitCode, code, 'exits with the conventional code');
      const left = fs.readdirSync(base).filter((n) => n.startsWith('squad-test-'));
      assert.equal(left.length, 0, `${label} removed the run dir`);
      assert.ok(fs.existsSync(path.join(base, 'env.json')), 'the sweep-grade rm took only the run dir');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

test('install: a descendant neither creates a run dir nor removes the inherited one', async () => {
  const base = sandbox();
  const inherited = path.join(base, 'squad-test-424242');
  fs.mkdirSync(inherited);
  const childCode = `
    require(${JSON.stringify(require.resolve('./harness/tmpdir'))}).install();
    console.log('ready');
  `;
  const child = cp.spawn(process.execPath, ['-e', childCode], {
    env: { ...process.env, [tmpdir.realTmpEnv]: base, [tmpdir.runDirEnv]: inherited },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; if (out.includes('ready')) resolve(); });
      child.once('exit', (c) => reject(new Error(`descendant exited early (${c})`)));
    });
    assert.deepEqual(fs.readdirSync(base), ['squad-test-424242'], 'descendant created nothing');
    child.kill(); // plain terminate, no dir-removal expected
    await new Promise((resolve) => child.once('exit', resolve));
    assert.deepEqual(fs.readdirSync(base), ['squad-test-424242'], 'descendant removed nothing');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
