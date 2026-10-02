# Test process hygiene: procguard (child-process tracking and leak checks), private TMPDIR

Fake CLIs, helper scripts and Electron-driven e2e runs all spawn child processes. Since
t_92c31037 every spawned child in a test process is tracked and reaped, and a check fails the
suite if a tracked child survives. This page describes how it works, what is guaranteed and how
to see the check fail.

## What is installed where

The harness lives in `test/harness/procguard.js` (the module) and `test/harness/install.js` (a
preload entry). It patches `child_process.spawn` / `execFile` / `exec` in the process that loads
it, so children are tracked no matter who spawns them — a test file directly, the in-process
orchestrator spawning a fake `claudePath`, or the gui-e2e driver. It must install **before** the
orchestrator module is first required (the orchestrator captures `spawn` at load time):

- `npm test` preloads it into every test-file process:
  `node --require ./test/harness/install.js --test test/*.test.js`.
- gui-e2e and smoke install it in `src/main.js` at the very top of the TEST_MODE branch, ahead of
  the orchestrator require. Production (`electron .` without the test env vars) never loads it.
- `npm run e2e` installs it at the top of `cli/e2e.js`.

`install()` is idempotent; test files that also run standalone call it themselves (see
`test/child-reap.test.js`).

## What gets tracked

Every child returned by the patched spawn calls is registered under its pid with its spawn-time
options (a `ChildProcess` does not expose `detached` after spawn, so the option is captured when
spawn is called). Sync spawns (`spawnSync` / `execFileSync`) cannot outlive the caller and are not
tracked. Children that exit are untracked immediately, so the live set only ever holds actual
survivors.

## Reap points

Killing is always by tracked pid — for `detached: true` spawns by process group
(`kill(-pgid, SIGKILL)`), so fake CLIs that spawn helper children of their own die as a whole
tree. Never by process name.

1. **End of each test file** (the node:test `after` hook registered by `install()`): first a leak
   check, then a final reap — see below.
2. **Process exit**: an `exit` hook reaps whatever is left, and `SIGINT`/`SIGTERM` are handled the
   same way before exiting.
3. **Crashed or force-killed runs**: every mutation of the live set is persisted to a pidfile at
   `<system tmpdir>/agents-squad-procguard/p<pid>-<startedAt>.json` — deliberately the **real**
   system tmpdir (via `AGENTS_SQUAD_REAL_TMP`), not the run's private one, so pidfiles outlive
   the private TMPDIR's teardown and the next run can still reap (see below). A run that dies
   without cleanup
   (SIGKILL, watchdog force exit) leaves its pidfile behind, and the **next run that loads the
   module sweeps it**: pidfiles whose owner is gone (or whose owner pid was recycled — detected by
   comparing process ages via `ps etime`, so a recycled pid is never signalled) have their listed
   children reaped and their file removed. Live sibling runs are never touched.
4. **Electron**: `app.exit()` bypasses node's exit hooks, so the gui-e2e/smoke force-exit
   watchdog and both normal exit points call `reapAll()` explicitly; the pidfile covers anything
   SIGKILLed in between.

## The leak check

At the end of every test file the teardown hook checks the still-tracked children **before**
reaping: any child alive at suite end (after a short grace window that only covers children
already being stopped) fails the file with

```
Error: leak check: child processes survived the suite: pid 1358 (/bin/sleep 300)
```

so a test that forgets to stop its orchestrator is a loud failure, not silent cleanup. The hook
then reaps and re-checks: a child that survives even the SIGKILL reap fails the file too. The
check works purely on tracked pids/pgids — never by name — and is exercised by
`test/child-reap.test.js`, including the failing case.

To see it fail end to end, drop this into a scratch test file and run it with the preload:

```js
const { spawn } = require('child_process');
test('leaks on purpose', () => { spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' }); });
```

```
node --require ./test/harness/install.js --test /tmp/leak-demo.test.js
# ✖ ... Error: leak check: child processes survived the suite: pid <n> (/bin/sleep 300)
```

## Limitations

- Grandchildren of **non-detached** spawns are not group-killed (their process group is the test
  process's own — signalling it would kill the suite). Fake CLIs that need helper children should
  be spawned `detached: true` (see `test/stall-recovery.test.js` for the pattern) — the group kill
  then reaches the whole tree.
- Children spawned by the fake CLIs themselves via unpatched code paths inside *their* process are
  covered only while their direct parent is tracked (group kill), or by the stale-pidfile sweep
  after a crash.

## The per-run private TMPDIR (t_4f2ff7cc)

Temp debris used to survive every `npm test` run: the script itself did
`AGENTS_SQUAD_PROJECT=$(mktemp -d)` before node started, and every `mkdtemp` the suite and the
src code make landed straight in the system tmpdir. `test/harness/tmpdir.js` (preloaded first by
`test/harness/install.js`, ahead of procguard) gives each run one throwaway temp root instead:

- The **run root** — the `node --test` parent, before any test file is spawned — creates
  `<system tmpdir>/squad-test-<pid>`, points `TMPDIR`/`TMP`/`TEMP` at it, creates the store root
  inside it (`AGENTS_SQUAD_PROJECT=<run>/project`, replacing the leaking `$(mktemp -d)`), and
  records both `AGENTS_SQUAD_TEST_TMPDIR` and `AGENTS_SQUAD_REAL_TMP` in the environment.
- Every **descendant** (each test-file process, spawned CLIs, Electron instances) inherits those
  variables: its `os.tmpdir()` *is* the private dir, so every `mkdtemp` in the suite, in src, and
  the Electron `userData`/data roots from `isolateTestRoot()` land inside it automatically.
  Descendants never create run dirs and never clean up — only the root removes the dir, in an
  `exit` hook plus `SIGINT`/`SIGTERM` handlers (`--test-force-exit` skips later teardown hooks
  but still fires `exit`; a hard SIGKILL leaves the dir to the next run's sweep).
- The **startup sweep** (run by each new run root, before creating its own dir) removes run dirs
  `squad-test-<pid>` whose pid is dead — a liveness check, so a live concurrent run's dir is
  never touched however old — and legacy debris with the old prefixes (`squad-*`, `su-*`, `am-*`,
  `wt-*`, `bc-*`, `mgate-*`) older than an hour. The sweep only ever looks inside the system
  tmpdir; the live store and worktrees under `~/.agents-squad` are unreachable by construction.
- A run nested inside another run (merge-gate-style) inherits `AGENTS_SQUAD_TEST_TMPDIR` and
  shares the outermost run's dir — the outermost root is the sole owner and cleaner.

Regression coverage lives outside the suite it measures: `npm run test:tmpdir
[-- test/some.test.js ...] [--sigint]` spawns a subset run through the real harness and then
asserts the system tmpdir gained no `squad-test-*`/legacy-prefix entries, the private dir is
gone after a clean exit (and after a mid-run SIGINT with `--sigint`), stale pre-existing run
dirs were swept, and `git worktree list` for the repo is unchanged. Total tmpdir entry counts
are printed as evidence but never asserted — unrelated processes write to the system tmpdir
concurrently. Unit coverage for the sweep decision, the rm guard and the root/descendant split
is in `test/tmpdir-harness.test.js` (sandbox-only; it never sweeps the real tmpdir).
