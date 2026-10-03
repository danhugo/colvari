# Settings form

The Settings tab (`⌘,`, or the gear in the tab bar) renders into `#settingsform`
(`app/renderer/index.html:95`) via `renderSettings()` in `app/renderer/app.js`.
It is a single page, saved atomically by one **Save settings** button — there is
no per-field autosave.

## Sections

### Project data (read-only)
Shows the store directory for this project with a **Copy** button (clipboard
with an `execCommand` fallback).

### Runtime
| Field | id | Default | Notes |
|---|---|---|---|
| Claude CLI path | `st-claude` | `claude` | Binary used to launch agents; trimmed, falls back to `claude` when empty. |
| Template for new project / team | `tpl-select` | first template | Selection is preserved across re-renders. |
| Default permission mode | `st-perm` | — | One of `bypassPermissions`, `acceptEdits`, `default`, `plan`; agents can override per node. |

### Limits & budgets
| Field | id | Default | Bounds |
|---|---|---|---|
| Max concurrent agents | `st-conc` | 2 | 1–8 |
| Max agents per team | `st-maxagents` | 6 | min 1 |
| Max agent runs per Run | `st-runs` | 30 | min 1 |
| Project budget per Run ($, 0 = off) | `st-budgetusd` | 0 | min 0, step 0.01 |
| Project token budget per Run (0 = off) | `st-budgettok` | 0 | min 0, step 1000 |
| Auto-compact at (%, 0 = off) | `st-autocompactpct` | 40 | 0–95 |

Budget/token limits stop all agents when reached during a Run.

### Recovery
| Field | id | Default | Notes |
|---|---|---|---|
| Stuck warning after | `st-stuck` | 5 min | Flags a run silent this long. |
| Stall timeout | `st-stall` | 10 min | Stop + auto-resume a silent run; max 2 recoveries, then the task is marked recovery failed. |

### Approvals
| Field | id | Default | Notes |
|---|---|---|---|
| Require approval for every agent's "done" | `st-approval` | off | Human confirms before a task counts as done. |
| Core team changes | `st-tcappr` | `ask` | `ask` or `auto` for recruit / retire / update. |
| Desktop notifications | `st-notify` | on | Approval needed, budget reached, run finished. |

### App updates (dev mode only)
Hidden when `upd.devMode === false`. Auto-restart toggle (`st-autorestart`):
on new merged code the app pauses the scheduler, drains running agents, tests
the new code, then relaunches and resumes — failed tests cancel the restart.
Backed by the `getSelfUpdateStatus` / `setAutoRestart` IPC; until the backend
answers, the control keeps a local stub so it still responds.

### Role presets (this project)
Table of presets plus an inline form (`pr-name`, `pr-prompt`, `pr-allowed`,
`pr-disallowed`, `pr-perm`). A new agent whose role matches a preset inherits
its prompt, allowed/disallowed tools and permission mode. Empty name is
ignored on save; rows have Edit (loads the row into the form) and Delete.

Below the presets, the runtimes section (`renderRuntimesSection()` /
`wireRuntimesSection()`) manages runtime profiles.

## Save behavior

`#st-save` collects all fields into one `saveSettings` IPC call, then
refreshes. Numeric inputs go through `numv(id, fallback, lo, hi)`, which:

- treats empty or non-numeric input as the fallback,
- clamps to the declared min/max (HTML attrs only constrain spinner clicks, so
  a hand-typed `-5` or `999` would otherwise save),
- distinguishes a typed `0` from empty (a plain `+v || fallback` misread a
  deliberate 0 as empty and silently saved the default — e.g. 0 max-runs,
  meant as "no cap", stored 30).

`budgetUsd`/`budgetTokens` are clamped to ≥ 0 separately, `autoCompactPct` to
0–95, `maxAgents` to ≥ 1.
