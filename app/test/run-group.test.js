'use strict';
// Run-group containment (t_3f830e64): each agent run spawns detached as its own process-group
// leader, every kill path signals the whole group (never by name), a backgrounded CLI child can
// no longer outlive the run or hold the stdio pipes (exit-time group reap), and a crashed app's
// per-run pidfiles are reaped on the next boot — lstart-verified, so a recycled pid is never killed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const { Orchestrator, reapRunPids, runPidsDir } = require('../src/orchestrator');
const MG = require('../src/merge-gate');

const SRESULT = `echo '{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":1,"usage":{},"session_id":"s-grp"}'`;

function setup(script) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rungrp-'));
  const fake = path.join(d, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\n' + script);
  fs.chmodSync(fake, 0o755);
  const s = new Store(path.join(d, 'p'));
  s.saveSettings({ claudePath: fake });
  return { d, s, o: new Orchestrator(s), node: { id: 'n_grp', name: 'GrpDev' } };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { if (fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 25)); }
};

const run = (o, node, d, s) => o.spawnRun(node, ['-p', 'hi'], d, { ...process.env }, s.getSettings(), { runtime: 'claude' });

test('a backgrounded CLI child cannot outlive the run or hang it: group killed on exit, close still fires', async () => {
  const { d, s, o, node } = setup(`sleep 60 & echo $! > "$PWD/gc"; echo $$ > "$PWD/leader"\n${SRESULT}\n`);
  const gc = path.join(d, 'gc'); const leaderF = path.join(d, 'leader');
  // A broken fix would leave the sleep holding the stdout pipe: the promise would hang ~60s.
  const r = await Promise.race([run(o, node, d, s), new Promise((_, rej) => setTimeout(() => rej(new Error('run hung: close never fired')), 15000)).finally(() => o.stopAgent(node.id))]);
  assert.equal(r.code, 0);
  assert.ok(await until(() => fs.existsSync(gc) && fs.existsSync(leaderF)), 'fixture never wrote its pids');
  const leader = Number(fs.readFileSync(leaderF, 'utf8').trim());
  const gcPid = Number(fs.readFileSync(gc, 'utf8').trim());
  assert.ok(await until(() => !MG.groupAlive(leader)), 'sleep loop outlived the run');
  assert.ok(!MG.pidAlive(gcPid), 'grandchild survived the run');
  assert.ok(await until(() => !fs.existsSync(path.join(runPidsDir(s.dir), String(leader))), 4000), 'pidfile not removed after the group died');
});

test('stopAgent kills the whole run group, not just the CLI leader', async () => {
  const { d, s, o, node } = setup(`sleep 60 & echo $! > "$PWD/gc"; echo $$ > "$PWD/leader"\nwait\n`);
  const gc = path.join(d, 'gc'); const leaderF = path.join(d, 'leader');
  const p = run(o, node, d, s);
  assert.ok(await until(() => fs.existsSync(gc) && fs.existsSync(leaderF)), 'fixture never wrote its pids');
  o.agent(node.id).status = 'working'; // spawnRun alone does not flip the agent state; stopAgent needs it
  assert.ok(o.stopAgent(node.id), 'stopAgent reported no live run');
  const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('run hung after stop')), 15000))]);
  assert.ok(r, 'run did not resolve after stop'); // a TERM'd sh may still exit 0 (bash wait quirk); the group check below is the contract
  const leader = Number(fs.readFileSync(leaderF, 'utf8').trim());
  assert.ok(await until(() => !MG.groupAlive(leader)), 'group survived stopAgent');
  assert.ok(!MG.pidAlive(Number(fs.readFileSync(gc, 'utf8').trim())), 'grandchild survived stopAgent');
});

test('reapRunPids: wrong-lstart pidfile is skipped (recycled pid protected), a matching one is reaped', async () => {
  const { s } = setup('exit 0');
  const dir = runPidsDir(s.dir); fs.mkdirSync(dir, { recursive: true });
  const canary = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' }); canary.unref();
  const victim = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' }); victim.unref();
  try {
    fs.writeFileSync(path.join(dir, String(canary.pid)), `${canary.pid}\tWRONG LSTART\tsurvivor\n`);
    fs.writeFileSync(path.join(dir, String(victim.pid)), `${victim.pid}\t${MG.pidLstart(victim.pid)}\tvictim\n`);
    const out = reapRunPids(s.dir);
    assert.ok(out.skipped.some((x) => x.pid === canary.pid), 'mismatched lstart was not reported skipped');
    assert.ok(out.killed.some((x) => x.pid === victim.pid), 'matching pid was not reported killed');
    assert.ok(MG.pidAlive(canary.pid), 'recycled-pid protection failed: canary was killed');
    assert.ok(await until(() => !MG.pidAlive(victim.pid)), 'matching pid survived the reap');
    assert.ok(fs.existsSync(path.join(dir, String(canary.pid))), 'skipped pidfile must be kept for a later retry');
    assert.ok(!fs.existsSync(path.join(dir, String(victim.pid))), 'reaped pidfile must be deleted');
  } finally {
    try { process.kill(-canary.pid, 'SIGKILL'); } catch {}
    try { process.kill(-victim.pid, 'SIGKILL'); } catch {}
  }
});
