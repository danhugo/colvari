# The settings form

The Settings tab (`#tab-settings`) is a single panel, `#settingsform`, rendered by
`renderSettings()` in `app/renderer/app.js`. Open with the gear button or `Cmd/Ctrl + ,`.
Everything is written at once by **Save settings** (`#st-save`) → `saveSettings` IPC; the
role-preset and runtime controls below the main form save independently.

## Sections

**Project data** — read-only display of the project store directory (`S.dir`) with a Copy
button (clipboard, with a `document.execCommand('copy')` fallback).

**Runtime**
- *Claude CLI path* (`#st-claude`) — binary used to launch agents; saved back as `claude`
  when left blank.
- *Template for new project / team* (`#tpl-select`) — from `P.templates`. The re-render
  preserves the current selection: `renderSettings()` snapshots `#tpl-select`'s value before
  replacing the HTML and restores it after.
- *Default permission mode* (`#st-perm`) — `bypassPermissions | acceptEdits | default |
  plan`; agents can override per node.

**Limits & budgets** — all number inputs, coerced with `+…|| 0` on save:
- *Max concurrent agents* (`#st-conc`, 1–8) — scheduler concurrency cap.
- *Max agents per team* (`#st-maxagents`) — recruit limit (default 6, min 1).
- *Max agent runs per Run* (`#st-runs`) — safety cap (default 30).
- *Project budget per Run* (`#st-budgetusd`, $) and *token budget* (`#st-budgettok`) —
  0 means no limit; reaching it stops all agents.
- *Auto-compact at* (`#st-autocompactpct`, %) — context usage that triggers `/compact`;
  clamped to 0–95 on save (0 = off).

**Recovery**
- *Stuck warning after* (`#st-stuck`, min) — flags a silent run.
- *Stall timeout* (`#st-stall`, min) — stop + auto-resume a silent run; at most 2
  recoveries, then the task is marked recovery failed. Clamped to ≥ 1 on save.

**Approvals**
- *Require approval for every agent's "done"* (`#st-approval`) — human confirms before a
  task counts as done.
- *Core team changes* (`#st-tcappr`) — `ask | auto` for recruit/retire/update.
- *Desktop notifications* (`#st-notify`) — approval needed, budget reached, run finished.

**App updates** (hidden when `upd.devMode === false`) — auto-restart toggle
(`#st-autorestart`) → `setAutoRestart` IPC; on newer code with no backend yet the toggle
keeps a local stub so the control still responds. Status/history rendering lives in the
self-update block (`normUpd` / `renderSelfUpdate`).

**Role presets (this project)** — table plus a create/edit form (`#presetform`): name,
default system prompt, allowed/disallowed tools, permission mode. Saved per-preset via
`savePreset` / `deletePreset` IPC, not by the main Save button.

**Runtimes** — appended by `renderRuntimesSection()` (custom-runtime onboarding draft form,
see `onboarding-introspection.md`); wired by `wireRuntimesSection()`.

## Save path

`#st-save` collects every field in one `saveSettings` call: blank CLI path → `'claude'`,
number fields fall back to their defaults on unparsable input, `autoCompactPct` is clamped,
`teamChangeApproval` is normalized to `ask`/`auto`. After saving, `refresh()` re-renders.
