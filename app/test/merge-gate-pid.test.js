// Gate process containment (t_85041490): the gate's suite spawns deep trees (node --test runs
// every test file as its own child; gui-e2e spawns Electron under it) and a bare spawnSync
// timeout kills only the direct child — npm dies, the tree under it outlives the gate (and
// spawnSync's timeout is not even hard: a TERM-immune child blocks it until natural exit).
// These tests pin: the suite runs detached in its own group under a watchdog that enforces the
// hard timeout, the live pid is recorded mid-run (a SIGKILLed gate still leaves a trail), the
// group is swept on clean exit AND on timeout, and startup reaping kills recorded groups ONLY
// on recorded pid + lstart identity — a recycled pid is dropped untouched, never a kill by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const MG = require('../src/merge-gate');
const { mktempReal } = require('./harness/tmp');

const tmpRoot = (label) => { const root = mktempReal('squad-pid-' + label + '-'); fs.mkdirSync(path.join(root, '.squad'), { recursive: true }); return root; };
// Poll asynchronously: a blocked event loop never reaps this process' own children, so a sync
// kill(pid, 0) loop would see zombies as alive forever.
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { if (fn()) return true; if (Date.now() > end) return fn(); await new Promise((r) => setTimeout(r, 50)); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const groupGone = (pid) => { try { process.kill(-pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; } };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

test('reapGatePids: a recorded live group is killed and the pidfile cleared', async () => {
  const root = tmpRoot('live');
  const c = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  const f = MG.gatePidFile(root);
  fs.writeFileSync(f, `${c.pid}\t${await MG.pidLstart(c.pid)}\t/bin/sleep 30\n`);
  const r = await MG.reapGatePids(root);
  assert.deepEqual(r.killed.map((x) => x.pid), [c.pid], 'the recorded group was reaped');
  assert.ok(await until(() => !alive(c.pid)), 'group leader is dead');
  assert.equal(fs.existsSync(f), false, 'pidfile cleared after the reap');
});

test('reapGatePids: a recycled pid (lstart mismatch) is skipped untouched — no kill by name', async () => {
  const root = tmpRoot('recycled');
  const c = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  const f = MG.gatePidFile(root);
  fs.writeFileSync(f, `${c.pid}\tMon Jan  1 00:00:00 2001\t/bin/sleep 30\n`);
  const r = await MG.reapGatePids(root);
  assert.deepEqual(r.killed, [], 'nothing killed on identity mismatch');
  assert.deepEqual(r.skipped.map((x) => x.pid), [c.pid]);
  assert.ok(alive(c.pid), 'the live unrelated process survived the reap');
  assert.equal(fs.readFileSync(f, 'utf8'), `${c.pid}\tMon Jan  1 00:00:00 2001\t/bin/sleep 30\n`, 'mismatched entry kept for a later retry');
  try { process.kill(-c.pid, 'SIGKILL'); } catch {} // teardown
  assert.ok(await until(() => !alive(c.pid)), 'teardown killed the sleeper');
});

test('reapGatePids: dead, garbage and unparseable entries are dropped without touching anything', async () => {
  const root = tmpRoot('dead');
  const f = MG.gatePidFile(root);
  fs.writeFileSync(f, '999999999\tMon Jan  1 00:00:00 2001\tlong gone\nnot-a-pid\tx\ty\n\n');
  const r = await MG.reapGatePids(root);
  assert.deepEqual(r.killed, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(fs.existsSync(f), false);
});

test('reapGatePids: leader already exited but the group lingers (orphaned electron tree) → reaped', async () => {
  const root = tmpRoot('orphan');
  const f = MG.gatePidFile(root);
  const sh = spawn('/bin/sh', ['-c', 'sleep 0.3; sleep 30 </dev/null >/dev/null 2>&1 &'], { detached: true, stdio: 'ignore' });
  const lstart = await MG.pidLstart(sh.pid); // captured while the leader is still alive
  assert.ok(lstart, 'leader lstart captured before it exits');
  assert.ok(await until(() => !alive(sh.pid), 5000), 'leader exited, orphaning the sleeper inside its group');
  fs.writeFileSync(f, `${sh.pid}\t${lstart}\torphan-tree\n`);
  const r = await MG.reapGatePids(root);
  assert.equal(r.killed.length, 1, 'the orphaned group was reaped by its recorded leader pid');
  assert.ok(await until(() => groupGone(sh.pid)), 'no member of the group survived');
  assert.equal(fs.existsSync(f), false);
});

test('runTracked: on clean exit the whole process group is swept — no orphaned grandchildren', async () => {
  const root = tmpRoot('sweep');
  const gcFile = path.join(root, 'gc-pid');
  const f = MG.gatePidFile(root);
  const r = await MG.runTracked('/bin/sh', ['-c', `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > ${shq(gcFile)}`], { cwd: root, env: {}, timeoutMs: 15000, pidFile: f });
  assert.equal(r.status, 0, 'the command itself succeeded');
  assert.equal(r.error, null);
  const gc = Number(fs.readFileSync(gcFile, 'utf8').trim());
  assert.ok(Number.isInteger(gc) && gc > 1, 'grandchild pid recorded');
  assert.ok(await until(() => !alive(gc)), 'grandchild reaped with the group after the clean exit');
  assert.equal(fs.existsSync(f), false, 'pidfile removed after the run');
});

test('runTracked: the hard timeout kills the direct child AND the whole group', async () => {
  const root = tmpRoot('timeout');
  const gcFile = path.join(root, 'gc-pid');
  const f = MG.gatePidFile(root);
  const t0 = Date.now();
  const r = await MG.runTracked('/bin/sh', ['-c', `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > ${shq(gcFile)}; exec sleep 60`], { cwd: root, env: {}, timeoutMs: 700, pidFile: f });
  assert.ok(Date.now() - t0 < 10000, 'the timeout was hard, not a hang');
  assert.equal(r.status, null, 'the child did not exit on its own');
  assert.equal(r.signal, 'SIGTERM', 'the direct child was TERMed at the deadline');
  const gc = Number(fs.readFileSync(gcFile, 'utf8').trim());
  assert.ok(Number.isInteger(gc) && gc > 1);
  assert.ok(await until(() => !alive(gc)), 'the backgrounded sibling was reaped with the group');
  assert.equal(fs.existsSync(f), false, 'pidfile removed after the timeout');
});

test('runTracked: a TERM-immune suite still dies at the hard timeout (group SIGKILL)', async () => {
  const root = tmpRoot('immune');
  const pidFile2 = path.join(root, 'suite-pid');
  const f = MG.gatePidFile(root);
  const t0 = Date.now();
  const r = await MG.runTracked('/bin/sh', ['-c', `echo $$ > ${shq(pidFile2)}; trap "" TERM; sleep 30`], { cwd: root, env: {}, timeoutMs: 600, pidFile: f });
  assert.ok(Date.now() - t0 < 10000, `hard timeout enforced (${Date.now() - t0}ms)`);
  assert.equal(r.status, null);
  assert.equal(r.signal, 'SIGKILL', 'TERM-immune child escalated to a group SIGKILL');
  const suite = Number(fs.readFileSync(pidFile2, 'utf8').trim());
  assert.ok(await until(() => !alive(suite)), 'the TERM-immune suite is dead');
  assert.equal(fs.existsSync(f), false, 'pidfile removed after the timeout');
});
