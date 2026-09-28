// Self-update integration tests (t_baea090e): new commit -> drain -> tests pass ->
// restart-state written -> resume on boot; test fail -> no restart; in-progress
// agents are never interrupted and block the restart while busy; dirty tree refused.
// No real-model runs: git, tests, build and relaunch are injected fakes; only real
// git + the real filesystem (temp repo + temp state file) are used.
//
// Contract under test — src/self-update.js (self-update core, t_5e1b4a4b) must export
// `SelfUpdate` (named or as module.exports):
//
//   new SelfUpdate({
//     repoDir,                    // git repo whose base branch is watched
//     branch = 'main',            // base branch to watch
//     stateFile,                  // restart-state.json path
//     isDirty: async () => bool,  // is the main checkout dirty (refuse restart)
//     busy: () => int,            // number of running agents (drain gate)
//     runTests: async () => ({ ok, output }),
//     build: async () => ({ ok, output }),
//     relaunch: async (state) => {},  // replaces app.relaunch()+exit
//     log: (line) => {},
//     minIntervalMs = 0,          // min time between restarts (debounce)
//     now: () => ms,
//   })
//   await su.poll() -> phase string: 'up-to-date' | 'dirty' | 'waiting-agents'
//     | 'testing' | 'restarting' | 'test-failed' | 'build-failed' | 'cooldown'
//   su.readBootState()     -> parsed restart-state or null (file kept)
//   su.consumeBootState()  -> parsed state and the file is deleted (resume once)
//
// While src/self-update.js has not landed, every test skips so `npm test` stays
// green; the file starts asserting the moment the core merges.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const IMPL = path.join(__dirname, '..', 'src', 'self-update.js');
const hasImpl = fs.existsSync(IMPL);
let SelfUpdate = null;
if (hasImpl) { const m = require(IMPL); SelfUpdate = m.SelfUpdate || m; }

const SKIP = hasImpl ? false : 'src/self-update.js not landed yet (t_5e1b4a4b)';

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
}
function commit(dir, file, content) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'wip ' + content);
  return git(dir, 'rev-parse', 'HEAD').trim();
}
function setup() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-selfupdate-'));
  const repo = path.join(r, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const fromSha = commit(repo, 'a.txt', 'one');
  const stateFile = path.join(r, 'restart-state.json');
  const calls = { relaunch: [], log: [] };
  const mk = (over = {}) => new SelfUpdate({
    repoDir: repo, branch: 'main', stateFile,
    isDirty: async () => false,
    busy: () => 0,
    runTests: async () => ({ ok: true, output: 'tests ok' }),
    build: async () => ({ ok: true, output: 'build ok' }),
    relaunch: async (state) => { calls.relaunch.push(state); },
    log: (line) => calls.log.push(line),
    now: () => Date.now(),
    ...over,
  });
  return { r, repo, stateFile, calls, mk, fromSha };
}
const readState = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

test('self-update: no new commit is a no-op', { skip: SKIP }, async () => {
  const { mk, stateFile, calls } = setup();
  const su = mk();
  assert.equal(await su.poll(), 'up-to-date');
  assert.equal(await su.poll(), 'up-to-date');
  assert.equal(calls.relaunch.length, 0);
  assert.equal(readState(stateFile), null);
});

test('self-update: new commit -> drain -> tests pass -> restart-state written + relaunch', { skip: SKIP }, async () => {
  const { mk, repo, stateFile, calls, fromSha } = setup();
  const su = mk();
  await su.poll(); // baseline
  const toSha = commit(repo, 'b.txt', 'two');
  assert.equal(await su.poll(), 'restarting');
  assert.equal(calls.relaunch.length, 1);
  const st = readState(stateFile);
  assert.ok(st, 'restart-state file written');
  assert.equal(st.fromSha, fromSha);
  assert.equal(st.toSha, toSha);
  assert.equal(st.wasRunning, true);
  assert.ok(st.ts, 'timestamp present');
  assert.equal(calls.relaunch[0].toSha, toSha);
  // a second poll must not restart again for the same sha
  assert.notEqual(await su.poll(), 'restarting');
  assert.equal(calls.relaunch.length, 1);
});

test('self-update: resume on boot consumes restart-state exactly once', { skip: SKIP }, async () => {
  const { mk, repo, stateFile } = setup();
  const su = mk();
  await su.poll();
  commit(repo, 'c.txt', 'three');
  await su.poll();
  const su2 = mk(); // fresh instance = app reboot
  const boot = su2.consumeBootState();
  assert.ok(boot, 'boot state read');
  assert.equal(boot.wasRunning, true, 'Run resumes because it was running');
  assert.equal(fs.existsSync(stateFile), false, 'state deleted after consume');
  assert.equal(su2.consumeBootState(), null, 'no crash-loop re-resume');
});

test('self-update: test failure -> no restart, no restart-state, watcher resumes', { skip: SKIP }, async () => {
  const { mk, repo, stateFile, calls } = setup();
  let testsOk = false;
  const su = mk({ runTests: async () => ({ ok: testsOk, output: testsOk ? 'tests ok' : '1 test failed' }) });
  await su.poll();
  commit(repo, 'd.txt', 'bad');
  const phase = await su.poll();
  assert.equal(calls.relaunch.length, 0, 'no relaunch');
  assert.equal(readState(stateFile), null, 'no restart-state written');
  assert.match(phase, /fail/);
  // the watcher keeps working: a later good commit still goes through
  testsOk = true;
  commit(repo, 'e.txt', 'fixed');
  assert.equal(await su.poll(), 'restarting');
});

test('self-update: busy agents block the restart without interrupting them', { skip: SKIP }, async () => {
  const { mk, repo, stateFile, calls } = setup();
  let running = 2;
  const su = mk({ busy: () => running });
  await su.poll();
  commit(repo, 'f.txt', 'four');
  assert.equal(await su.poll(), 'waiting-agents');
  assert.equal(calls.relaunch.length, 0, 'no relaunch while agents run');
  assert.equal(readState(stateFile), null, 'nothing written: in-progress task/worktree untouched');
  assert.equal(await su.poll(), 'waiting-agents', 'keeps waiting, never interrupts');
  running = 0; // agents finished
  assert.equal(await su.poll(), 'restarting');
  assert.equal(calls.relaunch.length, 1);
});

test('self-update: dirty main checkout refuses the restart', { skip: SKIP }, async () => {
  const { mk, repo, stateFile, calls } = setup();
  const su = mk({ isDirty: async () => true });
  await su.poll();
  commit(repo, 'g.txt', 'five');
  assert.equal(await su.poll(), 'dirty');
  assert.equal(calls.relaunch.length, 0);
  assert.equal(readState(stateFile), null);
});
