# Dev-only vs packaged: the gating rule

Colvari ships two kinds of builds, and the split is one flag:

- **Dev mode** (`DEV_MODE = true`): running from source (`electron .`) or with
  `AGENTS_SQUAD_DEV=1`. The app can watch its own repo, merge landed work, and restart
  itself (self-update watcher). Everything restart-related belongs here.
- **Packaged** (`DEV_MODE = false`, i.e. `app.isPackaged` without the env override): a
  shipped Colvari.app can never restart or update itself — there is no UpdateWatcher and no
  repo to pull. Any machinery that assumes a restart **must be inert here**: not just hidden,
  but unable to hold tasks, arm schedules, notify agents, or offer tools.

The rule in one sentence: **a packaged build must never surface (or accept) a restart or
self-update action that nothing can ever perform.**

## Where DEV_MODE comes from

`src/main.js`:

```js
const DEV_MODE = process.env.AGENTS_SQUAD_DEV ? process.env.AGENTS_SQUAD_DEV !== '0' : !app.isPackaged;
```

Electron's `app` object is not visible to the orchestrator/store (tests, CLI, MCP server
processes), so the flag is **threaded in** as `{ devMode }` options — `AGENTS_SQUAD_DEV`
still overrides, because `main.js` exports it to child processes only when dev mode is on.

## The gates (Cato's audit, t_c13f2e6a)

| Audit item | Surface | Gate | Test |
| --- | --- | --- | --- |
| Merges counting toward an impossible restart | `store.js` `_mergeOnDone` | `store.devMode === false` skips `bumpRestartPending` entirely | `restart.test.js` |
| Stored restart state inherited from a dev run | `orchestrator.js` constructor | boot wipe when `devMode === false` | `restart.test.js`, `packaged-gating.test.js` |
| Restart state reaching the UI (`getRestartState` IPC / `restart-state` push) | `orchestrator.js` `restartState()` | short-circuits to a zeroed state when `devMode === false` | `restart.test.js`, `packaged-gating.test.js` |
| Restart chip + "Restart now" in the header/bell | `alerts.js` `collect`, renderer | no row when `devMode === false`; renderer double-gates the action | `alerts.test.js`, gui-e2e `packaged` scenario |
| `schedule_restart` / `request_self_update` offered to agents | `board-tools.js` `enabledTools` | left out of the tool list when `devMode === false` | `restart.test.js`, `mcp-scope.test.js` |
| …the same tools called anyway | `board-tools.js` handlers | throw `unavailable in packaged build…` | `restart.test.js`, `packaged-gating.test.js` (live stdio server) |
| Cap valve arming a restart that cannot fire, holding todo tasks | `orchestrator.js` `sweepRestart` | whole sweep no-ops (and clears any gate) when `devMode === false` | `restart.test.js`, `packaged-gating.test.js` |
| Digest telling agents "restarts pending / use schedule_restart" | `orchestrator.js` `watchDigest` | restart line omitted when `devMode === false` | `restart.test.js`, `packaged-gating.test.js` |
| Self-update pill / veil / App-updates settings section | renderer | shown only when `upd.devMode !== false` (from `getSelfUpdateStatus`) | `alerts.test.js`, gui-e2e `packaged` scenario |

## How to test packaged mode (cheap, no packaged build needed)

- **Store/orchestrator**: `new Store(dir, null, { devMode: false })` and
  `new Orchestrator(store, { devMode: false })` (the orchestrator also forces
  `store.devMode = false`, mirroring main.js). See `packagedSetup` in
  `test/restart.test.js` / `test/packaged-gating.test.js`.
- **Board tools / prompts**: `enabledTools(node, false)`,
  `buildPrompt(..., { devMode: false })`.
- **Bell alerts**: `Alerts.collect({ devMode: false, rst: <stale armed state> })`.
- **The agent-facing MCP server**: spawn `src/mcp-server.js` **without**
  `AGENTS_SQUAD_DEV` (that absence is the whole gate) and assert `listTools()`/`callTool()`.
- **The actual DOM**: the gui-e2e scenario `AGENTS_SQUAD_GUI_E2E_ONLY=packaged` injects
  identical stale dev-only state in both modes and screenshots the header.

The checklist that walks the whole audit in one file is `test/packaged-gating.test.js` —
run it (`node --test test/packaged-gating.test.js`) when touching any gate above.

## Adding new dev-only machinery

1. Wire the flag in — pass `devMode` (or read `store.devMode`) instead of reaching for
   Electron; `AGENTS_SQUAD_DEV` must stay the override.
2. Advertise nothing in packaged: tools out of `enabledTools`, facts out of prompts and
   digests, rows out of alerts. An advertised action with no runtime behind it is a leak.
3. Refuse on call even when unadvertised (defense in depth — `enabledTools` is checked at
   registration, the handlers re-check `store.devMode`).
4. Never let packaged state accumulate toward a restart (counts, schedules, gates). Stored
   state is wiped at boot and read paths short-circuit.
5. Add the packaged-mode assertion to `test/packaged-gating.test.js`.
