'use strict';
// Harness Electron lifecycle tests (t_b3148d79, plan item 3 of t_b8a2f6c4): the perf harnesses
// (test/perf/*) spawn detached Electron children that must die with their run. Covers the two
// safety nets of src/harness-sweep.js with plain node stubs (no Electron boot, no model calls,
// a couple of seconds total):
//   (a) the in-child parent watchdog: SIGKILL the harness driver and the marked stub child ends
//       itself within a bounded time — SIGKILL fires no exit hook, only the watchdog can;
//   (b) the boot sweep: reaps a pidfile-recorded child whose owner is dead, leaves a LIVE run
//       alone, and — the live-app safety proof — never signals a process the record cannot
//       identify: a live pid with no marker on it and a marker-shaped but lstart-recycled pid
//       are skipped (record deleted, nothing signalled), and the sweep's own tree is untouchable.
// Fixtures spawn through the real marker + recordRun + armParentWatchdog path; the pidfiles land
// in this file's private harness-pids dir (see the AGENTS_SQUAD_REAL_TMP redirect below), so no
// peer sweeper can judge or reap them.
// The file skips loudly until src/harness-sweep.js lands so the suite stays green in the interim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pg = require('./harness/procguard');

pg.install();

// Private harness-pids dir for THIS file only: pidsDir() reads AGENTS_SQUAD_REAL_TMP at call
// time, so pointing it at a throwaway dir inside the run's private tmp isolates our records from
// every other sweeper that shares the real system tmpdir — peer test files, and any app instance
// that boots mid-suite (app-kill-relaunch boots two, and the live app reboots too). A peer sweep
// reaping our orphan between "owner dead" and "my sweep" used to fail the report asserts (the
// t_ea6c2c33 gate flakes); with a private dir my sweeps are the only sweeps that can judge them.
// The run dir is removed with the whole suite run, records and all (fixtures want no survival).
process.env.AGENTS_SQUAD_REAL_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hpids-'));

const SWEEP = path.join(__dirname, '..', 'src', 'harness-sweep.js');
const HAS_SWEEP = fs.existsSync(SWEEP);
const t = HAS_SWEEP ? test : test.skip;
let hsCache = null;
const hs = () => { assert.ok(HAS_SWEEP, `missing harness sweep module: ${SWEEP}`); return (hsCache ||= require(SWEEP)); };

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `squad-harness-${name}-`));
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { if (fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 40)); }
};
const killQuiet = (pid) => { // leaf kill first, then the whole group (detached stubs lead one)
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* no group */ }
};
const esrch = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };

// Stub harness child: records itself exactly the way a marked harness main does (marker argv
// nonce in, pidfile out), arms the parent watchdog unless told not to, reports readiness, naps.
const STUB = (dir) => {
  const p = path.join(dir, 'stub-child.js');
  fs.writeFileSync(p, `'use strict';
const fs = require('node:fs');
const HS = require(process.env.SQUAD_SWEEP);
const arg = process.argv.find((a) => a.startsWith(HS.MARKER_ARG_PREFIX));
const runId = arg ? arg.slice(HS.MARKER_ARG_PREFIX.length) : process.env.AGENTS_SQUAD_HARNESS_RUN;
const rec = HS.recordRun({ runId });
if (!process.env.SQUAD_NO_WATCH) HS.armParentWatchdog({ runId, intervalMs: 150, quit: () => process.exit(0) });
fs.writeFileSync(process.env.SQUAD_READY, JSON.stringify({ pid: rec.pid, runId: rec.runId }));
setInterval(() => {}, 1e6);
`);
  return p;
};
// Driver fixture: spawns the stub the way the marked perf drivers do — detached in its own
// group, marker in argv and env — records what it got, then idles until the test SIGKILLs it.
const DRIVER = (dir) => {
  const p = path.join(dir, 'harness-driver.js');
  fs.writeFileSync(p, `'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const HS = require(process.env.SQUAD_SWEEP);
const child = cp.spawn(process.execPath, [process.env.SQUAD_STUB, HS.markerArgFor(process.env.SQUAD_RUN)], {
  detached: true, stdio: 'ignore',
  env: { ...process.env, AGENTS_SQUAD_HARNESS_RUN: process.env.SQUAD_RUN },
});
child.unref();
fs.writeFileSync(process.env.SQUAD_INFO, JSON.stringify({ driverPid: process.pid, child: child.pid }));
setInterval(() => {}, 1e6);
`);
  return p;
};

// Run the driver fixture and wait until its stub child has recorded itself and armed.
async function launchFixture(name, { watch = true } = {}) {
  const runId = `ivo-${name}-${process.pid}-${Date.now().toString(36)}`;
  const d = tmp(name);
  const info = path.join(d, 'info.json');
  const driver = spawn(process.execPath, [DRIVER(d)], {
    env: {
      ...process.env,
      SQUAD_SWEEP: SWEEP,
      SQUAD_RUN: runId,
      SQUAD_STUB: STUB(d),
      SQUAD_INFO: info,
      SQUAD_READY: path.join(d, 'ready'),
      SQUAD_NO_WATCH: watch ? '' : '1',
    },
    stdio: 'ignore',
  });
  // With an exit listener attached node reaps the driver after a SIGKILL — without it the
  // zombie keeps answering signal 0 with its old lstart, and the sweep would legitimately
  // read that as "owner still alive" (in production the driver is long reaped).
  const driverExited = new Promise((resolve) => driver.once('exit', resolve));
  try {
    // Wait for PARSEABLE info, not mere existence: writeFileSync's open(truncate)->write gap is
    // real under a loaded machine, and an empty read here threw before the caller's try/finally,
    // leaking the driver and its detached stub (t_ea6c2c33 suite flake).
    const readInfo = () => { try { return JSON.parse(fs.readFileSync(info, 'utf8')); } catch { return null; } };
    assert.ok(await until(() => readInfo(info), 6000), `driver fixture (${name}) never spawned a child`);
    const { child } = readInfo(info);
    assert.ok(await until(() => fs.existsSync(path.join(d, 'ready')), 6000), `stub child (${name}) never reported ready`);
    const pidfile = hs().pidFileOf(runId);
    assert.ok(fs.existsSync(pidfile), `recordRun (${name}) wrote no pidfile at ${pidfile}`);
    return { d, driver, driverExited, child, runId, pidfile };
  } catch (e) {
    // Nothing returned -> the caller's finally cannot clean up: kill the driver here, and let
    // the sweep reap the stub through its own pidfile record (it records before reporting ready).
    killQuiet(driver.pid);
    try { await Promise.race([driverExited, until(() => false, 1000)]); } catch { /* best effort */ }
    try { hs().sweep({ log: () => {} }); } catch { /* best effort */ }
    throw e;
  }
}

// SIGKILL the fixture driver and wait until it is fully reaped (kill(0) = ESRCH, not zombie).
async function killDriverFully(fx) {
  process.kill(fx.driver.pid, 'SIGKILL'); // exit hooks never run — that is the point
  await Promise.race([fx.driverExited, until(() => false, 3000)]);
  assert.ok(await until(() => esrch(fx.driver.pid), 3000), 'fixture driver pid neither exited nor became unreapable');
}

function cleanupFixture(fx) {
  killQuiet(fx.child);
  killQuiet(fx.driver.pid);
  hs().removeRun(fx.runId);
}

t('harness child ends itself within 5s of its driver being SIGKILLed (parent watchdog)', async () => {
  const fx = await launchFixture('watch', { watch: true });
  try {
    assert.ok(pg.isAlive(fx.child), 'stub child not alive before the kill');
    await killDriverFully(fx);
    const t0 = Date.now();
    const gone = await until(() => !pg.isAlive(fx.child), 5000);
    assert.ok(gone, `stub child outlived its SIGKILLed driver by more than 5s (${Date.now() - t0}ms)`);
    assert.ok(!fs.existsSync(fx.pidfile), 'watchdog quit without removing the run record');
  } finally { cleanupFixture(fx); }
});

t('boot sweep reaps a recorded harness child whose owner died and removes the record', async () => {
  const fx = await launchFixture('sweep-reap', { watch: false }); // an old harness child with no watchdog
  try {
    assert.ok(pg.isAlive(fx.child), 'stub child not alive before the sweep');
    await killDriverFully(fx); // harness driver dies hard: the record goes stale
    assert.ok(pg.isAlive(fx.child), 'child must still be alive when the sweep runs');
    // Test files run in parallel and sweep the same shared pid dir: a peer sweep may reap this
    // fixture in the window below, so the report/log asserts only apply when my record was
    // still present at MY sweep call — the child-dead and record-gone asserts are unconditional.
    const recordPresent = fs.existsSync(fx.pidfile);
    const logs = [];
    const report = hs().sweep({ log: (m) => logs.push(String(m)) });
    const gone = await until(() => !pg.isAlive(fx.child), 5000);
    assert.ok(gone, 'sweep left the stale harness child alive');
    assert.ok(await until(() => !fs.existsSync(fx.pidfile), 3000), 'sweep left the stale record behind');
    if (recordPresent) {
      assert.ok((report.reaped || []).some((e) => e.runId === fx.runId), `sweep report does not list my run as reaped: ${JSON.stringify(report)}`);
      assert.ok(logs.some((l) => l.includes(fx.runId) && /reap/i.test(l)), `sweep did not log the reap: ${JSON.stringify(logs)}`);
    }
  } finally { cleanupFixture(fx); }
});

t('sweep leaves a recorded run alone while its owner is alive', async () => {
  const fx = await launchFixture('sweep-live', { watch: false });
  try {
    const report = hs().sweep({ log: () => {} }); // the recorded owner (the driver fixture) is alive
    assert.ok(pg.isAlive(fx.child), 'sweep killed a run whose owner is alive');
    assert.ok(fs.existsSync(fx.pidfile), 'sweep deleted a live run\'s record');
    assert.ok(!(report.reaped || []).some((e) => e.runId === fx.runId), `sweep reported reaping a live run: ${JSON.stringify(report)}`);
  } finally { cleanupFixture(fx); }
});

t('sweep never signals a live process the record cannot identify (pid-reuse safety)', async () => {
  const hsM = hs();
  const runId = `ivo-innocent-${process.pid}-${Date.now().toString(36)}`;
  // A dead owner whose lstart the record can cite, plus a live plain process with NO harness
  // marker on it — what a recycled pid looks like after a reboot.
  const decoy = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const decoyLstart = hsM.pidLstart(decoy.pid);
  decoy.kill('SIGKILL');
  assert.ok(await until(() => !pg.isAlive(decoy.pid), 3000), 'decoy owner never died');
  const innocent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { detached: true, stdio: 'ignore' });
  try {
    assert.ok(await until(() => pg.isAlive(innocent.pid), 3000), 'innocent process never started');
    hsM.atomicWriteJson(hsM.pidFileOf(runId), {
      runId, pid: innocent.pid, pgid: innocent.pid, lstart: hsM.pidLstart(innocent.pid),
      markerArg: hsM.markerArgFor(runId), envMarker: hsM.ENV_MARKER_PREFIX + runId,
      ownerPid: decoy.pid, ownerLstart: decoyLstart, recordedAt: Date.now(),
    });
    const present = fs.existsSync(hsM.pidFileOf(runId)); // a peer sweep may have judged it first
    const report = hsM.sweep({ log: () => {} });
    assert.ok(pg.isAlive(innocent.pid), 'sweep killed a live process with no harness marker on it');
    assert.ok(!fs.existsSync(hsM.pidFileOf(runId)), 'sweep kept an unidentifiable record');
    if (present) assert.ok((report.skipped || []).some((e) => e.runId === runId && e.verdict === 'marker-mismatch'), `sweep did not report the marker mismatch: ${JSON.stringify(report)}`);
  } finally { killQuiet(innocent.pid); hsM.removeRun(runId); }
});

t('sweep refuses a marker-shaped record whose pid was recycled (lstart mismatch)', async () => {
  const hsM = hs();
  const fx = await launchFixture('sweep-recycled', { watch: false }); // live stub with the real nonce in argv
  const bogusId = `${fx.runId}-recycled`;
  try {
    const decoy = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const decoyLstart = hsM.pidLstart(decoy.pid);
    decoy.kill('SIGKILL');
    assert.ok(await until(() => !pg.isAlive(decoy.pid), 3000), 'decoy owner never died');
    hsM.atomicWriteJson(hsM.pidFileOf(bogusId), {
      runId: bogusId, pid: fx.child, pgid: fx.child, lstart: 'bogus start time',
      markerArg: hsM.markerArgFor(bogusId), envMarker: hsM.ENV_MARKER_PREFIX + bogusId,
      ownerPid: decoy.pid, ownerLstart: decoyLstart, recordedAt: Date.now(),
    });
    const present = fs.existsSync(hsM.pidFileOf(bogusId)); // a peer sweep may have judged it first
    const report = hsM.sweep({ log: () => {} });
    assert.ok(pg.isAlive(fx.child), 'sweep killed a pid whose lstart does not match the record (recycled-pid kill)');
    assert.ok(!fs.existsSync(hsM.pidFileOf(bogusId)), 'sweep kept an unidentifiable record');
    if (present) assert.ok((report.skipped || []).some((e) => e.runId === bogusId && e.verdict === 'recycled-pid'), `sweep did not report the recycled pid: ${JSON.stringify(report)}`);
    assert.ok(fs.existsSync(fx.pidfile), 'sweep touched the live run\'s own record while judging the bogus one');
  } finally { hsM.removeRun(bogusId); cleanupFixture(fx); }
});

t('sweep skips its own pid and ancestors even when records name them', async () => {
  const hsM = hs();
  const selfId = `ivo-self-${process.pid}-${Date.now().toString(36)}`;
  const ancestorId = `ivo-ancestor-${process.pid}-${Date.now().toString(36)}`;
  try {
    for (const [id, pid] of [[selfId, process.pid], [ancestorId, process.ppid]]) {
      hsM.atomicWriteJson(hsM.pidFileOf(id), {
        runId: id, pid, pgid: pid, lstart: hsM.pidLstart(pid),
        markerArg: hsM.markerArgFor(id), envMarker: hsM.ENV_MARKER_PREFIX + id,
        ownerPid: process.pid, ownerLstart: hsM.pidLstart(process.pid), recordedAt: Date.now(),
      });
    }
    const report = hsM.sweep({ log: () => {} });
    for (const id of [selfId, ancestorId]) {
      assert.ok(!(report.reaped || []).some((e) => e.runId === id), `sweep reported reaping its own tree (${id})`);
      assert.ok(fs.existsSync(hsM.pidFileOf(id)), `sweep deleted the live-run record it must keep (${id})`);
    }
  // Reaching these asserts at all is the survival proof — a sweep that signals its own tree
  // kills this test process instead of failing it.
  } finally { hsM.removeRun(selfId); hsM.removeRun(ancestorId); }
});

if (!HAS_SWEEP) {
  test('harness sweep module not present yet — lifecycle tests pending t_98eed830', () => {
    assert.ok(true, `src/harness-sweep.js does not exist; lifecycle tests are skipped until it lands (${SWEEP})`);
  });
}
