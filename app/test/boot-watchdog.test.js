'use strict';
// Die-with-the-app + boot recovery (t_2ca99830): the 2026-10-01 01:47 silent death orphaned four
// agent runs for minutes and the next boot could not even tell the app had died. Covers the three
// fixes: (1) the per-run watchdog kills the run's process group seconds after the app pid
// vanishes (SIGKILL never reaches a detached group — ppid/lstart/signal-0 checks, never by name);
// (2) the heartbeat breadcrumb distinguishes a clean exit from a silent death at boot; (3) a boot
// reap of orphaned run pidfiles marks their tasks interrupted and feeds the renderer's lastExit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('child_process');
const MG = require('../src/merge-gate');
const BS = require('../src/bootstate');
const { reapRunPids, interruptedFromReap, runPidsDir } = require('../src/orchestrator');
const { Store } = require('../src/store');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `squad-diewith-${name}-`));
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) { if (fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 40)); }
};
const WD = path.join(__dirname, '..', 'src', 'run-watchdog.js');
// leader + backgrounded grandchild, both long-running; pids land in files for assertions
const TREE = (dir) => `#!/bin/sh\nsleep 60 & echo $! > '${dir}/gc'\necho $$ > '${dir}/leader'\nexec sleep 60\n`;

test('run-watchdog: kill -9 the app -> the whole run group is gone within 10s', async () => {
  const d = tmp('app-kill');
  for (const f of ['gc', 'leader']) fs.writeFileSync(path.join(d, f), '');
  const sh = path.join(d, 'tree.sh');
  fs.writeFileSync(sh, TREE(d));
  fs.chmodSync(sh, 0o755);
  const app = spawn('/bin/sleep', ['60']); // stand-in for the app process
  const leader = spawn(sh, [], { detached: true, stdio: 'ignore' });
  assert.ok(await until(() => Number(fs.readFileSync(path.join(d, 'gc'), 'utf8') || 0) > 0), 'fixture never started');
  const gcPid = Number(fs.readFileSync(path.join(d, 'gc'), 'utf8').trim());
  const appLstart = await MG.pidLstart(app.pid);
  const wd = spawn(process.execPath, [WD, '--app-pid', String(app.pid), '--app-lstart', appLstart, '--group-pid', String(leader.pid), '--interval-ms', '250'],
    { detached: true, stdio: 'ignore' });
  let wdGone = false; wd.on('exit', () => { wdGone = true; });
  await new Promise((r) => setTimeout(r, 700)); // alive app: the group must be left alone
  assert.ok(MG.groupAlive(leader.pid), 'watchdog killed a live app\'s run group');
  app.kill('SIGKILL'); // the silent death: no signal reaches the group through the app
  const t0 = Date.now();
  const gone = await until(() => !MG.groupAlive(leader.pid) && !MG.pidAlive(gcPid), 10000);
  assert.ok(gone, `run group outlived the app by more than 10s (${Date.now() - t0}ms)`);
  assert.ok(await until(() => wdGone, 5000), 'watchdog did not exit after reaping');
});

test('run-watchdog: a recycled app pid (lstart mismatch) counts as gone; a finished run releases it', async () => {
  const d = tmp('recycled');
  for (const f of ['gc', 'leader']) fs.writeFileSync(path.join(d, f), '');
  const sh = path.join(d, 'tree.sh');
  fs.writeFileSync(sh, TREE(d));
  fs.chmodSync(sh, 0o755);
  const leader = spawn(sh, [], { detached: true, stdio: 'ignore' });
  assert.ok(await until(() => Number(fs.readFileSync(path.join(d, 'gc'), 'utf8') || 0) > 0), 'fixture never started');
  // An app pid that exists but is NOT the recorded process: lstart differs -> treated as gone.
  const stranger = spawn('/bin/sleep', ['60']);
  const wd = spawn(process.execPath, [WD, '--app-pid', String(stranger.pid), '--app-lstart', 'bogus start time', '--group-pid', String(leader.pid), '--interval-ms', '250'],
    { detached: true, stdio: 'ignore' });
  let wdExit = null; wd.on('exit', (c) => { wdExit = c; });
  const t0 = Date.now();
  const gone = await until(() => !MG.groupAlive(leader.pid), 10000);
  assert.ok(gone, `lstart-mismatched pid not treated as app death (${Date.now() - t0}ms)`);
  assert.ok(await until(() => wdExit === 0, 5000), 'watchdog did not exit after reaping');
  stranger.kill('SIGKILL');
});

test('run-watchdog: exits on its own when the run group ends while the app lives', async () => {
  const app = spawn('/bin/sleep', ['60']);
  const short = spawn('/bin/sleep', ['1'], { detached: true, stdio: 'ignore' });
  const appLstart = await MG.pidLstart(app.pid);
  const wd = spawn(process.execPath, [WD, '--app-pid', String(app.pid), '--app-lstart', appLstart, '--group-pid', String(short.pid), '--interval-ms', '250'],
    { detached: true, stdio: 'ignore' });
  let wdExit = null; wd.on('exit', (c) => { wdExit = c; });
  assert.ok(await until(() => wdExit === 0, 8000), 'watchdog outlived its finished run group');
  app.kill('SIGKILL');
});

// ---- heartbeat breadcrumb ----

test('bootstate: unclean exit detected at boot; clean exit and first boot are not', async () => {
  const d = tmp('hb');
  assert.equal(BS.detectUnclean(d), null, 'no breadcrumb must read as clean');
  await BS.writeAlive(d, { pid: 424242, at: 1790000000000 }); // previous instance's heartbeat
  const u = BS.detectUnclean(d);
  assert.ok(u && u.pid === 424242 && u.at === 1790000000000, 'heartbeat without clean stamp must read unclean');
  assert.equal(BS.detectUnclean(d, 424242), null, 'a process must never read its own heartbeat as evidence');
  await BS.writeAlive(d, { cleanExitAt: 1790000001000 });
  assert.equal(BS.detectUnclean(d), null, 'a clean-exit stamp must read as clean');
});

test('bootstate: the heartbeat file lands in the store dir and rewrites atomically', async () => {
  const d = tmp('hbfile');
  const rec = await BS.writeAlive(d);
  assert.ok(fs.existsSync(BS.alivePath(d)));
  const onDisk = JSON.parse(fs.readFileSync(BS.alivePath(d), 'utf8'));
  assert.equal(onDisk.pid, rec.pid);
  assert.ok(onDisk.lstart.length > 0, 'heartbeat must carry lstart for pid-reuse safety');
});

// ---- boot reap marks interrupted tasks ----

test('boot reap: orphaned run pidfiles are reaped and their tasks marked interrupted', async () => {
  const d = tmp('mark');
  const s = new Store(path.join(d, 'p'));
  const t = s.createTask({ title: 'Interrupted work', description: 'was running at death' });
  // A real live group behind the pidfile, exactly as spawnRun records it (with task: tag).
  const sh = path.join(d, 'tree.sh');
  fs.writeFileSync(sh, TREE(d));
  fs.chmodSync(sh, 0o755);
  const leader = spawn(sh, [], { detached: true, stdio: 'ignore' });
  fs.mkdirSync(runPidsDir(s.dir), { recursive: true });
  const leaderLstart = await MG.pidLstart(leader.pid);
  fs.writeFileSync(path.join(runPidsDir(s.dir), String(leader.pid)), `${leader.pid}\t${leaderLstart}\tagent-run Flux task:${t.id}\n`);
  const out = await reapRunPids(s.dir);
  assert.equal(out.killed.length, 1, 'orphan group not reaped');
  assert.match(out.killed[0].cmd, /task:/, 'pidfile must carry the task id');
  assert.ok(await until(() => !MG.groupAlive(leader.pid)), 'reaped group still alive');
  const marked = interruptedFromReap(s, out.killed);
  assert.deepEqual(marked.map((m) => m.taskId), [t.id]);
  const after = s.getTask(t.id);
  const c = (after.comments || []).find((x) => x.author === 'system' && /died while this task's agent run was live/.test(x.text));
  assert.ok(c, 'interrupted task has no system comment');
  assert.match(c.text, new RegExp(String(out.killed[0].pid)));
});

test('boot reap: unknown task ids and plain pidfiles are skipped by the marker', async () => {
  const d = tmp('markskip');
  const s = new Store(path.join(d, 'p'));
  const killed = [
    { pid: 111, cmd: 'agent-run Flux task:t_gone' }, // task does not exist in this store
    { pid: 222, cmd: 'agent-run Uma' }, // pre-t_2ca99830 pidfile without a task tag
  ];
  assert.deepEqual(interruptedFromReap(s, killed), [], 'nonexistent tasks must be skipped');
});
