const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Orchestrator } = require('../src/orchestrator');

// spawnRun stdin seam (t_01d6ad04, review of 8c1cc40): args.stdin must actually be piped into the
// child AND the pipe closed — a CLI that reads its message to EOF would otherwise hang forever.
// The fake bin cats stdin to a file: the file only completes at EOF, and the run only resolves
// after the child exits, so both halves of the contract are observable.
test('spawnRun pipes args.stdin into the child and closes it (>300KB payload)', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stdin-'));
  const out = path.join(root, 'echo.txt');
  const fake = path.join(root, 'stdin-cat.sh');
  fs.writeFileSync(fake, '#!/bin/sh\ncat > "$STDIN_ECHO_OUT"\n');
  fs.chmodSync(fake, 0o755);
  const store = new Store(path.join(root, 'data'));
  store.saveSettings({ claudePath: fake, useWorktrees: false });
  const node = store.addNode({ name: 'Std', role: 'Dev' });
  const orch = new Orchestrator(store);
  clearInterval(orch._stallTimer); clearInterval(orch._wakeTimer); // no background sweeps

  const payload = 'You are "Devon". ' + 'x'.repeat(300 * 1024); // > ARG_MAX/E2BIG: unspawnable as an argv element
  const args = ['--stdin-test']; args.stdin = payload;
  const r = await orch.spawnRun(node, args, root, { ...process.env, STDIN_ECHO_OUT: out }, store.getSettings(), { runtime: 'claude' });
  assert.equal(r.code, 0, 'the child read stdin to EOF (pipe closed) and exited cleanly');
  assert.equal(fs.readFileSync(out, 'utf8'), payload, 'the full payload reached the child over the pipe');
});
