'use strict';
// App-level kill -9 / relaunch integration (t_490eeee8). test/boot-watchdog.test.js covers the
// watchdog, bootstate and reap modules with stand-ins; this file runs the REAL app end to end
// (via test/harness/qa-app-entry.js) against its own throwaway data root and userData, with a
// synthetic stream-cli stub as the agent runtime:
//   1. SIGKILL the launched app's main pid ONLY while the stub run streams detached — the
//      spawnRun-armed run-watchdog must reap the stub's whole process group within 10s.
//   2. Plant a fake orphan pidfile (pid + lstart + task tag, exactly spawnRun's format), relaunch
//      on the same store: the boot reap must kill the planted group by recorded pid (never by
//      name), mark the task interrupted, and getLastExit — the recovery banner's data — must
//      report the unclean death of the killed instance.
//   3. The relaunched instance then quits cleanly: no clean-exit stamp would mean every future
//      boot banners a silent death that never happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const MG = require('../src/merge-gate');
const BS = require('../src/bootstate');
const { Store } = require('../src/store');
const { runPidsDir } = require('../src/orchestrator');
const { mktemp } = require('./harness/tmp');

const ENTRY = path.join(__dirname, 'harness', 'qa-app-entry.js');
const STUB = path.join(__dirname, 'perf', 'stream-cli.js'); // --help/--version/models + long stream
const until = async (fn, ms, every = 80) => {
  const end = Date.now() + ms;
  for (;;) { let v; try { v = fn(); } catch {} if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, every)); }
};

// Launch env for the app under test: strip the suite's own markers — the entry re-isolates the
// data root, and NODE_TEST_CONTEXT / ELECTRON_RUN_AS_NODE must not leak into Electron.
function appEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING',
    'AGENTS_SQUAD_PROJECT', 'AGENTS_SQUAD_HOME', 'AGENTS_SQUAD_SMOKE', 'AGENTS_SQUAD_GUI_E2E',
    'AGENTS_SQUAD_TEST_ISOLATION', 'STREAM_SECONDS', 'STREAM_EPS']) delete env[k];
  return env;
}
// Belt and braces alongside procguard's end-of-suite reap: a failed assert between the kill and
// the relaunch must never leave a test app instance on the user's screen or store.
const booted = [];
test.after(() => { for (const c of booted) { try { if (c.exitCode == null && c.signalCode == null) c.kill('SIGKILL'); } catch {} } });
function bootApp(root, stage, extra = {}) {
  const stateFile = path.join(root, `state-${stage}.json`);
  const log = path.join(root, `app-${stage}.log`);
  const child = spawn(require('electron'), [ENTRY], {
    env: appEnv({ QA_STAGE: stage, QA_STATE_FILE: stateFile, QA_DATA_ROOT: root, QA_STUB: STUB, ...extra }),
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
  });
  booted.push(child);
  return { child, stateFile, log };
}
const readState = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const root = mktemp('squad-qa-kill-');
let app1 = null, seed = null, stubPid = null, task1 = null;

test('kill -9 the app pid only: the detached stub agent group dies within 10s', async () => {
  const b1 = bootApp(root, 'seed');
  app1 = b1.child;
  seed = await until(() => readState(b1.stateFile), 60000);
  assert.ok(seed, `seed instance never reported readiness (${tail(b1.log)})`);
  assert.equal(seed.pid, app1.pid, 'state file pid is not the spawned app pid');

  // The run is live: spawnRun's pidfile records the detached stub leader with the task tag.
  const pf = await until(() => fs.readdirSync(runPidsDir(seed.dir))
    .map((f) => path.join(runPidsDir(seed.dir), f))
    .find((f) => /task:/.test(fs.readFileSync(f, 'utf8'))), 45000);
  assert.ok(pf, `no task-tagged run pidfile appeared (${tail(b1.log)})`);
  stubPid = Number(path.basename(pf));
  const pfText = fs.readFileSync(pf, 'utf8');
  assert.match(pfText, /agent-run Qa-1 task:(t_\S+)/, `pidfile lacks the agent-run/task record: ${pfText}`);
  task1 = (/task:(\S+)/.exec(pfText) || [])[1];
  assert.ok(await until(() => MG.groupAlive(stubPid), 5000), `stub group ${stubPid} not alive before the kill`);
  // A real session is always ≥ a few seconds old; wait for its first heartbeat so the relaunch
  // has last-seen-alive evidence (the heartbeat interval stamps existing projects every 5s).
  assert.ok(await until(() => fs.existsSync(BS.alivePath(seed.dir)), 8000), 'seed instance never wrote a heartbeat');

  // The silent death: SIGKILL the app's main pid only — no signal reaches the detached group.
  process.kill(app1.pid, 'SIGKILL');
  const exit = await until(() => app1.exitCode !== null || app1.signalCode === 'SIGKILL', 10000);
  assert.ok(exit, 'app did not die from the SIGKILL');

  const t0 = Date.now();
  const gone = await until(() => !MG.groupAlive(stubPid), 10000);
  assert.ok(gone, `stub group outlived the app by more than 10s (${Date.now() - t0}ms) — orphan run`);
  console.log('[qa] heartbeat right after the kill:', fs.readFileSync(BS.alivePath(seed.dir), 'utf8'));
}, { timeout: 120000 });

test('relaunch on the same store: planted orphan reaped, task marked interrupted, banner unclean — then a clean quit leaves no banner evidence', async () => {
  assert.ok(seed && stubPid, 'kill phase did not run');

  // Fake orphan, planted exactly the way spawnRun records a run: pid + lstart + task tag.
  const s = new Store(seed.dir);
  const task2 = s.createTask({ title: 'QA planted orphan', description: 'orphan group to reap at relaunch' });
  const orphan = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  const orphanPf = path.join(runPidsDir(seed.dir), String(orphan.pid));
  fs.mkdirSync(path.dirname(orphanPf), { recursive: true });
  fs.writeFileSync(orphanPf, `${orphan.pid}\t${MG.pidLstart(orphan.pid)}\tagent-run Qa-1 task:${task2.id}\n`);
  assert.ok(MG.groupAlive(orphan.pid), 'planted orphan not alive');

  // Relaunch: bootRecovery must detect the unclean death, reap by recorded pid and mark the
  // task. The verify instance shares the seed's userData, so the renderer lands back on the
  // seeded project and the recovery banner (t_6911ba60) reports what bootRecovery found.
  const b2 = bootApp(root, 'verify', { QA_PROJECT: seed.project, QA_TASK_TITLE: task2.title });
  const st = await until(() => readState(b2.stateFile), 60000);
  assert.ok(st, `verify instance never reported (${tail(b2.log)})`);
  const banner = st.banner || {};
  assert.equal(banner.hidden, false, `recovery banner not visible after the unclean relaunch: ${JSON.stringify(banner)} ${tail(b2.log)}`);
  assert.match(banner.html || '', /Last session ended unexpectedly/, 'banner does not read as an unexpected end');
  assert.match(banner.html || '', new RegExp(`pid ${app1.pid}`), `banner must date the death to the killed instance (pid ${app1.pid})`);
  assert.match(banner.html || '', /1 orphan agent run stopped/, 'banner must report the reaped orphan');
  assert.match(banner.html || '', /1 task interrupted/, 'banner must report the interruption');
  assert.ok((banner.html || '').includes(task2.title), 'banner must link the interrupted task');
  assert.ok(!pidAlive(orphan.pid), 'planted orphan survived the relaunch');
  const t2 = s.getTask(task2.id);
  const c = (t2.comments || []).find((x) => x.author === 'system' && /died while this task's agent run was live/.test(x.text));
  assert.ok(c, 'interrupted task has no system comment');
  const logs = fs.readFileSync(path.join(seed.dir, 'logs.jsonl'), 'utf8');
  assert.match(logs, new RegExp(`previous app instance \\(pid ${app1.pid}\\) died without a clean exit[^]*reaped 1 orphan`), 'boot summary log line missing or wrong');

  // The verify instance quits cleanly (entry app.quit -> will-quit stamps cleanExitAt):
  // the next boot must find no banner evidence at all.
  const closed = await until(() => b2.child.exitCode !== null, 30000);
  if (!closed) { try { b2.child.kill('SIGKILL'); } catch {} }
  const hb = JSON.parse(fs.readFileSync(BS.alivePath(seed.dir), 'utf8'));
  assert.ok(hb.cleanExitAt > 0, `clean quit did not stamp the heartbeat: ${JSON.stringify(hb)}`);
  assert.equal(BS.detectUnclean(seed.dir), null, 'a clean exit must not banner on the next boot');
}, { timeout: 120000 });

function tail(f) {
  try { return fs.readFileSync(f, 'utf8').slice(-1500); } catch { return '(no log)'; }
}
