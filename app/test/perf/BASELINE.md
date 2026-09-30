# Click-latency baseline while agents stream (t_f02c2572, re-baselined t_2ba2e086)

## Official baseline: master `6710364` (2026-09-30, t_2ba2e086 — gate for tracks 1-3)

4 back-to-back harness runs at the identical commit (raw: `results/baseline-6710364.json`
+ per-run JSONs in `results/baseline-6710364/`). Same protocol as below (4 synthetic agents
× 6 ev/s, ~574-task seeded board, 66 real input clicks per run). Ambient loadavg per run:
9.3 / 7.4 / 18.6 / 31.7.

| Run | p50 | p95 | p99 | max | long tasks >50 ms |
|---|---:|---:|---:|---:|---:|
| r1 | 42.5 | 120.8 | 220.5 | 220.5 | 41 |
| r2 | 59.4 | 484.4 | 791.1 | 791.1 | 45 |
| r3 | 76.5 | 298.2 | 989.2 | 989.2 | 57 |
| r4 | 75.8 | 479.3 | 571.7 | 571.7 | 49 |
| **Pooled (n=264)** | **61.6** | **372.4** | **765.8** | **989.2** | 192 total |

**Verdict vs targets (p95 < 100 ms, p99 < 200 ms): FAIL on both, ~4x over.**
Run-to-run p95 swings 121→484 ms at the identical commit (streaming-phase luck + ambient
load), so **always gate on pooled percentiles of ≥3 runs** — a single run proves nothing.
Worst targets (pooled p95): obs 791 ms, chat 484 ms, usage 479 ms; lightest: team/wiki.
Systemic cost unchanged from the 8b44f14 analysis below: ~8-9 IPC round-trips per
refresh at ~2.3-3.2 refreshes/s, full renderAll on every push (renderLog per pushed line
dominates), 41-57 long tasks >50 ms per ~60-85 s window.

Living scoreboard + per-track verdicts: wiki page **"Perf numbers: click latency"**.

---

## Historical baseline: `8b44f143f` (2026-09-30, t_f02c2572, single run)

Measured 2026-09-30 on commit `8b44f143f` with `node test/perf/click-latency.js`
(4 agents × 6 ev/s synthetic stream, ~574-task board, 200 seeded runs, 1500 seeded log
lines, real input clicks via `webContents.sendInputEvent`). Raw numbers:
`results/baseline.json` / `results/baseline.md`.

## Headline (sampling window 93 s, 66 clicks)

| Metric | Value | Target | Verdict |
|---|---|---|---|
| Click p95 (input → paint) | **518 ms** (p50 73, max 988) | < 100 ms | **FAIL ×5** |
| Long tasks > 50 ms during window | **62** (max 144 ms) | 0 during clicks | **FAIL** |
| renderAll duration | p50 5.6 ms, p95 64.5, max 134.6 | — | fine alone, storm when pushed |
| renderAll rate (refresh) | 2.35/s while streaming | — | — |
| State pushes | 8.5/s (43.9 KB/s) | — | — |
| Log pushes | 17.6/s (4.3 KB/s) | — | — |
| IPC round-trips | 27.5/s, **9.3 per renderAll** | — | — |

Worst tabs (p50/p95 ms): usage 129/518, obs 114/133 (max 988), board 93/334, chat 103/135.
Even the lightest tabs (team 40/64, wiki 13/32) breach p95 50 ms.

## Where the time goes (per-fn Σ over the window)

1. **renderLog: 1643 calls, Σ 11.7 s** (p95 59 ms, max 168). Every 'log' push calls
   `renderLog()` (app.js:2770); when the obs tab is active it re-renders the whole log page
   (~60 ms at 1.6k buffered lines) per pushed line at 17.6/s — the main thread is >100%
   booked whenever obs is open during a run. This is the single dominant cost.
2. **renderGraph: Σ 2.19 s** (p95 36 ms) — re-laid-out on every renderAll (state push or
   2 s poll), even when hidden-tab output isn't needed.
3. **renderChat: Σ 2.14 s** (p95 59 ms) + renderOverview Σ 0.73 s — also on every
   renderAll; both additionally run on 1 s intervals (interval-registered calls bypass the
   wrapper, so their true total is higher than shown).
4. **IPC churn: 9.3 round-trips per refresh** — getStateVersion p50 11 ms (the 2 s poll,
   231 calls), getAll p50 **124 ms** (delta fetch over 574 tasks), nodeStatus p50 41 ms.
   Sum of the heavy three ≈ 176 ms of main-process work per refresh, 2.45 refreshes/s.

## Interpretation for the fix (t_8d586961)

- A click lands on a main thread that is already saturated by push-driven re-renders
  (renderLog per line + renderAll per debounced state burst + 2 s poll); the click's own
  renderAll (5-130 ms) queues behind it → input-to-paint p95 518 ms.
- Biggest wins by the numbers: (a) don't re-render the full log page per pushed line
  (batch/rAF-coalesce, or append-only), (b) skip hidden tabs in renderAll (graph/chat/
  overview while another tab is up), (c) batch the per-refresh IPC burst
  (getStateVersion+getAll+nodeStatus+… = 9 round-trips) and trim getAll's 124 ms.

## Method & caveats

- Real app, real orchestrator, real child CLI processes (`stream-cli.js` speaks just enough
  claude stream-json for spawnRun → onEvent → log/state IPC → renderer). Clicks are real
  input events; latency = pointer-dispatch stamp → first painted frame after the last
  renderAll that started at/after the press.
- Machine: darwin arm64, 8 CPUs, electron 44.4.5; loadavg ~20 during the run (the box also
  runs live agents). Numbers are noisy in absolute terms but the distribution and the
  per-fn breakdown are the baseline Flux compares against — re-run the SAME script for the
  after-number on the same box state.
- Known instrumentation limits: `renderOverview`/`renderChat` calls from their 1 s
  `setInterval`s are unwrapped (registration captured the original refs) — their cost still
  shows up in click latency and longtasks. Refresh duration is wall-clock of the async
  chain, inflated by main-thread saturation; read it as "how long until a refresh lands",
  not CPU time.

## Reproduce

    cd app
    PERF_AGENTS=4 PERF_TASKS=4 PERF_CLICK_REPS=8 PERF_SAMPLE_MS=25000 PERF_WARM_MS=5000 \
      PERF_OUT=/tmp/colvari-perf ./node_modules/.bin/electron test/perf/click-latency.js

(The script is an Electron main entry — run it with the electron binary, not plain node;
it boots an isolated throwaway instance, so the live app is never touched.)

Knobs: `PERF_SEED_TASKS` (default 550), `PERF_SEED_LOGS` (1500), `PERF_SEED_RUNS` (200),
`STREAM_SECONDS` (auto: sampling window + margin), `STREAM_EPS` (6 events/s/agent).
Per-track re-measure protocol (t_2ba2e086): ≥3 runs on the track's merge commit, pool the
click samples, compare pooled p50/p95/p99 against `results/baseline-6710364.json`; a track
counts as done only when pooled p95 AND p99 improve without a p50 regression.
