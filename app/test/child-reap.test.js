'use strict';
// Child-process leak harness (t_92c31037): proves the procguard harness tracks every spawned
// fake-claude/Electron-style child, reaps whole detached process groups, persists tracked pids to
// a pidfile so a crashed/force-killed run is swept by the next one, and that the end-of-suite
// leak check FAILS when a leak is injected. Killing is by tracked pid/pgid only — never by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pg = require('./harness/procguard');

// A no-op under `npm test` (the preload already installed it); keeps the file standalone-runnable.
pg.install();

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `procguard-${name}-`));
const dead = (pid) => !pg.isAlive(pid);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) { if (fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 40)); }
};

test('detached children are tracked, pidfiled and reaped by process group', async () => {
  const dir = tmp('group');
  const gc = path.join(dir, 'gc.txt');
  const sh = path.join(dir, 'tree.sh');
  fs.writeFileSync(sh, `#!/bin/sh\nsleep 30 & echo $! > '${gc}'\nexec sleep 30\n`);
  fs.chmodSync(sh, 0o755);
  const child = spawn(sh, [], { detached: true, stdio: 'ignore' });
  assert.ok(await until(() => fs.existsSync(gc)), 'grandchild never started');
  const gcPid = Number(fs.readFileSync(gc, 'utf8').trim());
  assert.ok(pg.children().some((c) => c.pid === child.pid), 'child is tracked');
  const pidfile = JSON.parse(fs.readFileSync(pg.pidfile, 'utf8'));
  assert.ok(pidfile.children.some((c) => c.pid === child.pid), 'child is persisted in the pidfile');
  pg.reapAll();
  assert.ok(await until(() => dead(child.pid) && dead(gcPid)), 'detached tree survived reapAll');
  assert.equal(pg.children().length, 0, 'registry empty after reap');
});

test('non-detached children are reaped by pid and untracked on natural exit', async () => {
  const sleeper = spawn('/bin/sleep', ['30']);
  assert.ok(pg.children().some((c) => c.pid === sleeper.pid));
  const quitter = spawn('/bin/echo', ['done']);
  await new Promise((r) => quitter.on('exit', r));
  await until(() => !pg.children().some((c) => c.pid === quitter.pid));
  assert.ok(!pg.children().some((c) => c.pid === quitter.pid), 'exited child must be untracked');
  pg.reapAll();
  assert.ok(await until(() => dead(sleeper.pid)), 'sleeper survived reapAll');
});

test('the pidfile of a crashed run is swept and its children reaped', async () => {
  const dir = tmp('crash');
  const crasher = path.join(dir, 'crash.js');
  fs.writeFileSync(crasher, `
    const pg = require(${JSON.stringify(require.resolve('./harness/procguard'))});
    const { spawn } = require('child_process');
    const c = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
    pg.track(c, 'leak-from-crashed-run');
    process.kill(process.pid, 'SIGKILL'); // crash: exit hooks never run, the pidfile stays
  `);
  const crashed = spawn(process.execPath, ['-e', fs.readFileSync(crasher, 'utf8')], { stdio: 'ignore' });
  assert.ok(await until(() => dead(crashed.pid)), 'crasher never exited');
  const stale = (await until(() => fs.readdirSync(pg.dir).some((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(pg.dir, f), 'utf8')).ownerPid === crashed.pid; } catch { return false; }
  }))) && fs.readdirSync(pg.dir).map((f) => path.join(pg.dir, f)).find((f) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).ownerPid === crashed.pid; } catch { return false; }
  });
  assert.ok(stale, 'pidfile should have survived the SIGKILL');
  const staleEntry = JSON.parse(fs.readFileSync(stale, 'utf8'));
  pg.sweepStale();
  assert.ok(!fs.existsSync(stale), 'stale pidfile was not swept');
  const orphan = staleEntry.children[0].pid;
  assert.ok(await until(() => dead(orphan)), 'crashed run\'s child survived the sweep');
});

test('leak check fails when a leak is injected', async () => {
  const leak = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  // no reapAll: exactly what a leaking test would leave behind
  const leaks = await pg.assertNoLeaks(300);
  assert.ok(leaks.some((l) => l.pid === leak.pid), `injected leak must be reported, got ${JSON.stringify(leaks)}`);
  const failed = pg.reapAll();
  assert.equal(failed.length, 0, 'reap must be able to kill the leak');
  assert.ok(await until(() => dead(leak.pid)), 'injected leak survived cleanup');
});
