'use strict';
// Unit coverage for the harness-run lifecycle (t_98eed830, plan t_b8a2f6c4): the boot sweep
// reaps a pidfile-recorded orphan whose owner is dead — and, the live-app safety proof (critic
// amendment 7), never signals a process it cannot positively identify: a live owner keeps the
// record, a mismatched start time or marker means skip + delete the pidfile. Stand-ins are plain
// node processes in their own group with the marker nonce in argv; the parent-SIGKILL watchdog
// itself is exercised by the real-app integration suite (app-kill-relaunch / gui-e2e paths).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const HS = require('../src/harness-sweep');

const until = async (fn, ms, every = 60) => {
  const end = Date.now() + ms;
  for (;;) { let v; try { v = fn(); } catch {} if (v) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, every)); }
};

// A live stand-in for a harness Electron: own process group (detached), long-lived, marker
// nonce in its argv exactly the way spawnHarness passes it (`--` keeps plain node from parsing
// the marker as a node option; Electron tolerates trailing app args natively).
function spawnMarkedStandIn() {
  const runId = HS.harnessRunId('unit');
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);', '--', HS.markerArgFor(runId)], { detached: true, stdio: 'ignore' });
  child.unref();
  assert.ok(HS.pidAlive(child.pid), 'stand-in not alive');
  assert.equal(HS.pidPgid(child.pid), child.pid, 'stand-in should lead its own process group');
  return { runId, pid: child.pid, markerArg: HS.markerArgFor(runId) };
}

// Plant a pidfile exactly the way recordRun writes one for a run.
function plantRun(runId, pid, { markerArg, ownerPid, ownerLstart, lstart } = {}) {
  HS.atomicWriteJson(HS.pidFileOf(runId), {
    runId, pid,
    pgid: HS.pidPgid(pid) || pid,
    lstart: lstart ?? HS.pidLstart(pid),
    markerArg: markerArg ?? null,
    envMarker: HS.ENV_MARKER_PREFIX + runId,
    ownerPid: ownerPid ?? null,
    ownerLstart: ownerLstart ?? '',
    recordedAt: Date.now(),
  });
}
const pidfileExists = (runId) => fs.existsSync(HS.pidFileOf(runId));

function killSoon(pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }

// A doomed owner: live long enough to plant the record, then killed so the run is orphaned.
function spawnDoomedOwner() {
  const owner = cp.spawn('/bin/sleep', ['120']);
  assert.ok(HS.pidAlive(owner.pid), 'owner not alive');
  return owner;
}

test('sweep: live owner keeps the record; a dead owner gets its orphan reaped and the pidfile dropped', async () => {
  const standIn = spawnMarkedStandIn();
  const owner = spawnDoomedOwner();
  plantRun(standIn.runId, standIn.pid, { markerArg: standIn.markerArg, ownerPid: owner.pid, ownerLstart: HS.pidLstart(owner.pid) });
  try {
    // Live run: owner alive — nothing signalled, record kept.
    let out = HS.sweep();
    assert.ok(HS.pidAlive(standIn.pid), 'sweep killed a run whose owner is alive');
    assert.ok(pidfileExists(standIn.runId), 'live run lost its pidfile');
    assert.ok(!out.reaped.some((r) => r.runId === standIn.runId), 'live run reported as reaped');

    // Owner dies hard: the recorded run is now an orphan and must be reaped by pid + group.
    owner.kill('SIGKILL');
    assert.ok(await until(() => !HS.pidAlive(owner.pid), 5000), 'owner did not die');
    out = HS.sweep();
    assert.ok(out.reaped.some((r) => r.runId === standIn.runId), `orphan not reaped: ${JSON.stringify(out)}`);
    assert.ok(await until(() => !HS.pidAlive(standIn.pid), 5000), 'orphaned stand-in survived the sweep');
    assert.ok(!pidfileExists(standIn.runId), 'reaped run left its pidfile behind');
  } finally { killSoon(standIn.pid); killSoon(owner.pid); }
}, { timeout: 30000 });

test('sweep: recorded start time mismatch means a recycled pid — never signalled, pidfile dropped', async () => {
  const standIn = spawnMarkedStandIn();
  const owner = spawnDoomedOwner();
  owner.kill('SIGKILL');
  assert.ok(await until(() => !HS.pidAlive(owner.pid), 5000), 'owner did not die');
  plantRun(standIn.runId, standIn.pid, { markerArg: standIn.markerArg, ownerPid: owner.pid, lstart: 'Wed Dec 31  1969 16:00:00' });
  try {
    const out = HS.sweep();
    assert.ok(HS.pidAlive(standIn.pid), 'sweep signalled a pid whose start time does not match the record');
    assert.ok(out.skipped.some((s) => s.runId === standIn.runId && s.verdict === 'recycled-pid'), `mismatch not reported as skipped: ${JSON.stringify(out)}`);
    assert.ok(!pidfileExists(standIn.runId), 'unconfirmed record was kept');
  } finally { killSoon(standIn.pid); killSoon(owner.pid); }
}, { timeout: 30000 });

test('sweep: marker mismatch — a live pid without the recorded run nonce is never signalled', async () => {
  const standIn = spawnMarkedStandIn();
  const owner = spawnDoomedOwner();
  owner.kill('SIGKILL');
  assert.ok(await until(() => !HS.pidAlive(owner.pid), 5000), 'owner did not die');
  const forgedMarker = HS.markerArgFor(HS.harnessRunId('other'));
  plantRun(standIn.runId, standIn.pid, { markerArg: forgedMarker, ownerPid: owner.pid });
  try {
    const out = HS.sweep();
    assert.ok(HS.pidAlive(standIn.pid), 'sweep signalled a live process without the recorded marker');
    assert.ok(out.skipped.some((s) => s.runId === standIn.runId && s.verdict === 'marker-mismatch'), `mismatch not reported: ${JSON.stringify(out)}`);
    assert.ok(!pidfileExists(standIn.runId), 'unconfirmed record was kept');
  } finally { killSoon(standIn.pid); killSoon(owner.pid); }
}, { timeout: 30000 });

test('recordRun/removeRun: the run records itself, sees itself as a live run, and cleans up', () => {
  const runId = HS.harnessRunId('unit-self');
  const rec = HS.recordRun({ runId, log: () => {} });
  try {
    assert.equal(rec.pid, process.pid);
    assert.ok(pidfileExists(runId), 'recordRun wrote no pidfile');
    const verdict = HS.judgeRun(JSON.parse(fs.readFileSync(HS.pidFileOf(runId), 'utf8')), { selfPid: process.pid, ancestors: HS.ownAncestors() });
    assert.equal(verdict, 'live-run', `self-record judged ${verdict}`);
    HS.removeRun(runId);
    assert.ok(!pidfileExists(runId), 'removeRun left the pidfile');
  } finally { HS.removeRun(runId); }
});
