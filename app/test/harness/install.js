'use strict';
// Preloaded by `npm test` (node --require ./test/harness/install.js --test test/*.test.js).
// tmpdir first: the run root claims a private squad-test-<pid> TMPDIR and passes it down through
// the environment (children inherit AGENTS_SQUAD_TEST_TMPDIR and create nothing). Then procguard,
// whose pidfile dir must stay in the real system tmpdir (AGENTS_SQUAD_REAL_TMP, set by tmpdir) so
// crashed runs still leave their pids reappable across runs. See docs/testing.md.
// Heavy slot first: one heavy suite machine-wide, low priority, not while load is far above cores.
require('./heavy-slot').install();
require('./tmpdir').install();
require('./procguard').install();
// Every mkdtemp in a test-file process is tracked and removed at exit (t_8170a988). Loaded after
// procguard so its exit hook (which kills spawned children) runs before the removal.
require('./tmp').installGlobal();
// Unit tests must not depend on the real machine's memory pressure (t_f56f1b22): a MemGuard with
// no injected probe/execFile/freeMem reads "normal". Tests that inject their own keep their readings.
{
  const { MemGuard } = require('../../src/mem-guard');
  const cp = require('child_process');
  const run = MemGuard.prototype._runProbe;
  MemGuard.prototype._runProbe = function () {
    if (this.platform === 'darwin' && this.execFile === cp.execFile) this._sysctlLevel = async () => ({ level: 1 });
    if (this.platform !== 'darwin' && this.freeMem.toString().includes('os.freemem()')) this.freeMem = () => 64 * 2 ** 30;
    return run.call(this);
  };
}
