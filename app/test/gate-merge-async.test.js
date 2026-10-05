// Async gateMerge contract (t_6ffed1bd, epic t_h0a1c2fd): the Electron main process must
// never block on the merge gate, so gateMerge(t, opts) must return a promise and keep the
// event loop responsive while it runs. This test lands AHEAD of the conversion (t_5a78aa95,
// in progress) and self-detects which world it runs in — the house pattern from
// merge-gate.test.js (t_897cca56): a test may land ahead of its fix only as a skip pointing
// at the fix task. While gateMerge is still sync the test skips with that reason; it starts
// enforcing the moment the async gateMerge lands, including on Devon's own gate runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MG = require('../src/merge-gate');
const { ensureWorktree } = require('../src/worktree');

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function repoWithTask(id) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gasync-')));
  fs.writeFileSync(path.join(d, '.gitignore'), '.squad/\n');
  g(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'base\n');
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  const w = await ensureWorktree(d, id);
  fs.writeFileSync(path.join(w.worktreePath, 'b.txt'), 'work\n');
  g(w.worktreePath, 'add', '.'); g(w.worktreePath, 'commit', '-q', '-m', 'work');
  return { d, t: { id, worktreePath: w.worktreePath, worktreeBranch: w.worktreeBranch } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('gateMerge returns a promise and the event loop stays responsive while it runs', async (t) => {
  // Cheap probe first: an `async function gateMerge` is detectable without side effects;
  // only when it still looks sync do we probe by calling (which in the sync world runs a
  // real-but-stubbed gate on this throwaway fixture — harmless, and it is what proves a
  // sync-signature gateMerge does not secretly return a promise).
  if (MG.gateMerge.constructor.name !== 'AsyncFunction') {
    const { t: task } = await repoWithTask('t_gma0');
    const r = MG.gateMerge(task, { runTests: () => ({ ok: true, output: '' }) });
    if (!r || typeof r.then !== 'function') {
      return t.skip('gateMerge is still sync (t_5a78aa95 in progress): these assertions enforce the async contract the moment it lands');
    }
  }

  const { d, t: task } = await repoWithTask('t_gma1');
  let ran = 0;
  let inGate = null; // wall-clock window during which the (async) suite callback was inside the gate
  const ticks = [];
  const iv = setInterval(() => ticks.push(Date.now()), 10);
  try {
    const p = MG.gateMerge(task, {
      runTests: async () => { inGate = { start: Date.now() }; await sleep(120); inGate.end = Date.now(); ran++; return { ok: true, output: 'ok 1' }; },
    });
    assert.ok(p && typeof p.then === 'function', `gateMerge must return a promise, got ${p && p.constructor && p.constructor.name}`);
    const r = await p;
    assert.strictEqual(r.merged, true, `fixture gate should merge green: ${JSON.stringify(r)}`);
    assert.strictEqual(ran, 1, 'suite ran exactly once');
    // While the gate had the loop (the 120ms suite callback), a live loop keeps ticking the
    // 10ms interval; a blocked loop produces zero ticks inside that window.
    const during = inGate ? ticks.filter((ts) => ts >= inGate.start && ts <= inGate.end).length : 0;
    assert.ok(during >= 2, `event loop starved while gateMerge ran: ${during} timer tick(s) during the ${inGate ? inGate.end - inGate.start : 0}ms suite callback`);
  } finally {
    clearInterval(iv);
  }
});
