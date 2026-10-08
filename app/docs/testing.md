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
   The sweep **fails closed** (t_1ee3f3f6): a start-time read that comes back empty (a `ps`
   starved under load) proves nothing, so an alive-but-unidentifiable owner keeps its pidfile
   for the next install to retry, and a child whose age cannot be read is never signalled —
   under parallel gates the starved read used to authorize killing another live file process's
   mid-test fixture tree. Only a dead owner pid (cheap, exact `kill(0)`) or a readable,
   mismatched owner age reaps.
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

## Harness Electron lifecycle (t_98eed830)

Every Electron a harness starts — `test/perf/*` mains, the ab-gate and profile drivers,
gui-e2e/smoke instances — belongs to its run, not to the desktop:

- **Marker**: the run is marked with `AGENTS_SQUAD_HARNESS_RUN=<id>` (env) plus an exact
  `--squad-harness-run=<id>` argv nonce. `npm test`/gui-e2e/smoke instances that were started
  without a driver self-mark in TEST_MODE. Production launches carry no marker.
- **Record**: the app writes its own pidfile to `<real tmpdir>/agents-squad-harness-pids/<id>.json`
  (`src/harness-sweep.js`): pid, live pgid, exact start time, marker, owner pid + owner start
  time. Atomic tmp+rename, one file per run, removed on any clean quit.
- **Parent watchdog**: a marked app quits itself when its owner disappears — the recorded owner
  pid vanishes, or the live ppid has reparented to launchd. This covers driver SIGKILL, crashes
  and drain cuts, where no driver exit handler can fire (a hard timeout cannot cover SIGKILL
  either).
- **Driver kills**: drivers spawn through `test/harness/harness-electron.js`
  (`spawnHarness`): detached (own process group, real Electron binary), group kill on driver
  exit/SIGINT/SIGTERM/uncaught error and on the driver's own hard timeout — SIGTERM, 2 s grace,
  SIGKILL, always against the live pgid.
- **Boot sweep**: at every app boot `sweep()` reaps ONLY pidfile-recorded runs whose recorded
  owner is dead — and only after the live process proves its identity (recorded start time
  matches, recorded marker present in argv or env). Recycled pids, marker mismatches, malformed
  records: pidfile deleted, nothing signalled. Processes are never matched by name; the sweep
  skips its own pid and ancestors and logs every decision.
- **Test isolation (t_1ee3f3f6)**: `test/harness-reap.test.js` and `test/harness-sweep.test.js`
  point `AGENTS_SQUAD_REAL_TMP` at a fresh per-run `mkdtemp` dir (never a shared `os.tmpdir()`
  path) before importing the sweep module, so their planted records are judged only by their own
  sweeps — peer test files, mid-suite app boots and concurrent gate suites can never reap or
  delete them in flight. Each file rm's its dir in an `after` hook.

Unit coverage (including the negative cases) is in `test/harness-sweep.test.js`.

## The machine-wide heavy slot covers every heavy harness (t_dc59a89e)

`test/harness/heavy-slot.js` serializes heavy work machine-wide (one suite at a time, low
priority, not while load is far above the core count). It was `npm test`-only; now every heavy
Electron harness takes it too, so a screenshot sweep or perf driver never competes with a
merge-gate suite or the live app:

- gui-e2e installs it in `src/main.js` beside procguard, at the very top of the TEST_MODE branch
  (`AGENTS_SQUAD_GUI_E2E` only — smoke stays light). The instance waits for the slot before its
  window opens, exactly like the gate's suite child.
- Standalone Electron-harness drivers (`test/perf/ab-gate.js`, `cli/profile-renderer.js`) get it
  from a module-load `install()` in `test/harness/harness-electron.js`.
- Under `npm test` nothing changes: the run root holds the slot and descendants inherit
  `AGENTS_SQUAD_HEAVY_SLOT`, so nested installs skip. `AGENTS_SQUAD_HEAVY_SLOT=off` still bypasses.

The gate's live-state read (`merge-gate.live.json` phase `waiting`) already watches the same lock
dir, so a gate queued behind a gui-e2e run now reports that honestly.

## Gate-suite trend stats (t_dc59a89e)

Every finished merge-gate suite run (each CAS round that runs tests) appends one entry to
`.squad/merge-gate-stats.json` at the repo root: timestamp, task, branch, state
(`green`/`red`/`infra`), attempts, wall-time (`durationMs`), test count and `flaky` — flaky means
the run ended green only after an infra-classified rerun (a completed red stays terminal, so it
is never counted flaky). The window is capped at 200 runs; writes are atomic tmp+rename and a
stats failure can never fail a green gate. `redMasterSnapshot` exposes the summary
(`runs`, `p95Ms`, `medianMs`, `greenP95Ms`, `flakeRate`, …) so the board can show trends, and
`src/gate-stats.js` `summarize(root)` reads it directly. Unit + wire coverage (including a real
infra-then-green flake through the default runner) is in `test/gate-stats.test.js`.
