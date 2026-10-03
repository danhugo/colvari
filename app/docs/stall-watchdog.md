# The stall watchdog

How the app detects a run that stopped making progress and recovers it. The machinery lives in
`src/stall-watchdog.js` (extracted from the orchestrator); the orchestrator keeps owning run
lifecycle while this module owns the stall policy and the liveness heuristics. Tests:
`test/stall-recovery.test.js` (task-run recovery, process-tree liveness) and
`test/stall-any-run.test.js` (every run kind is watched, hard cap).

## What counts as a stall

A run is stalled when it has emitted nothing for `stallTimeoutMin` minutes (Settings → Stall
timeout, default 10) **and** `runAlive()` finds no sign of life in its process tree. Both
conditions matter: a long silent tool call (build, sleep, network) keeps a descendant process
running and is legitimate progress, not a stall.

Liveness (`runAlive`) is checked against the real `ps` table:

- The CLI's own cumulative CPU time (`ps -o time=`) advancing between sweeps counts as alive.
- Any live (non-zombie) descendant of the run's CLI process counts as alive.
- The board MCP helper subtree (`src/mcp-server.js --project … --node …`) is excluded: it is a
  long-lived stdio helper that idles between calls for the whole session, so its being alive says
  nothing about run progress. Without the exclusion a hung CLI that owns one is never recovered.
- Unknowable counts as alive — `ps` unavailable, no pid, a stopped CLI's defunct (`Z`-state)
  descendants ignored but the picture unclear — the watchdog never stalls on a hunch.

## The sweep

`sweepStalls` runs every `STALL.SWEEP_MS` (5s; tests shorten the constants in place). For each
working agent's current run, in order:

1. Skip if the run is already done/stalled, a manual stop was requested, or a human message is
   queued (manual interrupts always win).
2. Skip until the idle time reaches the timeout.
3. Call `runAlive()`. Live descendants protect the run — **up to the hard cap**: silence for
   `STALL.HARD_CAP_MULT` (3) × the timeout kills the run even with live children. The cap exists
   because runtimes whose own long-lived helpers pin `runAlive()` forever would otherwise never
   recover (the bug that motivated it: a wake run hung 3h11m).
4. Claim the run with a one-way `run.stalled = true` compare-and-set, so a sweep racing a manual
   stop or a queued message can never double-fire.
5. `SIGTERM` the CLI; if it is still the current run after `STALL.SIGKILL_GRACE_MS` (8s),
   `SIGKILL` it and log that it ignored SIGTERM.

Every run kind is watched: task runs and every no-task run (wake, loop, watchdog) of every
runtime — a hung run must never hold the agent's single-run slot. When the orchestrator is
between runs (`running === false`), only no-task runs are swept; they are only stopped (the wake
sweep re-delivers what still matters), while task runs are recovered through `runTask`.

## Recovery

- **Task runs**: stopped and resumed in the same session via `runTask`'s `r.stalled` branch, with
  `stallPrompt(task)` — a short continue prompt (the session already holds the full task context;
  it just tells the agent the previous attempt was stopped and why). Max `STALL.MAX_RECOVERIES`
  (2) automatic recoveries per task (persisted as `stallRecoveries`); past that the task is
  marked recovery-failed.
- **No-task runs**: stopped only; whatever triggered them (e.g. pending messages) re-wakes the
  agent on its own.

## Surfaces

The supervisor logs `run.stalled` / `run.recovering` / `run.recovery_failed` and keeps
`a.stall = {state, attempt, max, taskId}` (or `run.stall` on the current run). The renderer reads
that contract in `stallState()` (`renderer/app.js`): an amber "Stalled — recovering (n/2)" strip
under the agent card and a tag on the affected task, turning red once recovery failed. The
Settings row "Stall timeout" (`#st-stall`) is the user-facing knob; setting it to ≤ 0 disables
the sweep.
