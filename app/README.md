# Colvari (MVP)

A desktop app for running a small team of Claude Code agents. Agents coordinate through a shared board and wiki. This is the minimal version of `../BLUEPRINT.md` (sections 4, 6, 7 and 9).

## Run

```bash
npm install
npm start          # Electron app (data root ~/.agents-squad, override with AGENTS_SQUAD_HOME=<dir>; AGENTS_SQUAD_PROJECT=<dir> is an equivalent alias, used by gui-e2e)
npm test           # unit + integration tests with a fake claude CLI (includes a real stdio MCP round trip)
npm run e2e        # real claude CLI in a temp dir: preflight, PM -> Dev team, then haiku loop + workflow agents (costs about $0.50 API-equivalent)
npm run gui-e2e    # drives the real UI (templates, agent panel, preflight, Run, usage, F6), asserts every check, exits 1 on failure;
                   # screenshots go to e2e-shots/. Uses a fresh temp project dir via AGENTS_SQUAD_PROJECT (set by the script).
                   # Test instances (gui-e2e / smoke) never touch real data: an explicit AGENTS_SQUAD_PROJECT beats an inherited
                   # AGENTS_SQUAD_HOME, with neither set a throwaway temp root is created, and the run is force-exited after 30 min
                   # (AGENTS_SQUAD_TEST_TIMEOUT_MS overrides) so a hung instance cannot linger next to the live app.
npm run smoke      # launches Electron, clicks through the UI, then exits
npm run smoke:real # real-machine check (no fixtures): discovery against real $HOME + this project, one tiny real claude turn for real skills/commands/rate-limits
```

You need the `claude` CLI on your PATH and logged in.

## Projects and teams

The left sidebar manages **projects**. Each project has its own board, wiki, settings and one or more **teams**, and each team is its own graph. You can create, rename, switch and delete projects and teams there. **+ Project** and **+ Team** use the selected template: Blank, Startup (PM -> Dev -> Reviewer), Solo or Research. Teams can also be duplicated and exported or imported as JSON (`format: "agents-squad-team"`).

Data is stored in `~/.agents-squad/projects/<id>/`, which holds `project.json`, one `team-<teamId>.json` per team, and `settings.json`. Board and wiki are files an agent can read directly with its own tools (`cat`, `grep`, `jq`): each task is one pretty-JSON file at `.squad/board/tasks/<taskId>.json`, and each wiki page is one markdown file at `.squad/wiki/<slug>.md`, both inside the project dir. Reads are unrestricted; writes go through the board MCP tools only (atomic tmp+rename under a cross-process lock). A project from an older version migrates on first open: the old single-file `board.json` / `wiki.json` are split into the per-task/per-page files and the originals are renamed to `*.bak`, never deleted. The first time the app starts, an existing `~/.agents-squad/default` is copied into a project named "Default". The original is left in place and marked `.migrated`.

Each project has its own orchestrator, so different projects can run at the same time. The orchestrator and MCP server of a project see the union of all its teams. Node ids are unique, and edges only exist inside a team.

## Using it

1. **Team tab**: add agents with **+ Agent**. Click a node to set its name, role (free text; PM, Planner, Dev, Reviewer and QA are suggested), system prompt, optional model (any alias or full model ID, with suggestions) and working directory. Drag nodes to move them. Use **Connect** and click A, then B, to add a directed edge A → B, meaning A can assign tasks to and message B.
2. **Board tab**: create a goal task and assign it, usually to the PM. Tasks move through todo → in_progress → review → done, and you can comment on them.
3. Press **Run**. The scheduler picks up `todo` tasks, running at most 2 agents at a time and one run per agent at a time. It sets each task to `in_progress` and spawns
   `claude -p <prompt> --output-format stream-json --verbose --mcp-config <board server> --strict-mcp-config --permission-mode <setting> [--model m]`
   in the node's working directory. It keeps going until no `todo` tasks are left, you press **Stop**, or the run cap (`maxRuns`) is hit. If an agent exits without setting a status, its task goes to `done` on exit code 0, or to `review` otherwise.
4. **Wiki tab**: markdown pages. Both you and the agents can edit them.
5. **Observability tab**: status of each agent, its current task, measured token usage (in, out, cache read, cache write), billing source, and the reported cost (`total_cost_usd` of the `result` event) shown only as an API-equivalent, or as "Covered by subscription" for subscription runs. The header shows a $ figure only for runs billed per token (API key / proxy / cloud); a subscription-only session shows a muted "subscription" pill, and a live log you can filter by agent. **Settings tab**: claude path, concurrency, run cap and permission mode.

## Usage & billing

Every `claude` run (agent runs and goal-check runs) is saved in `runs.json` of the project (`src/usage.js`): exact input, output, cache-read and cache-creation tokens (from the `result` event's `modelUsage`, falling back to `usage`), the model actually used (init `model` / `modelUsage` keys), turns, duration, exit code, session and the **billing source**. The source is detected from the init event's `apiKeySource` (`none` = claude.ai Pro/Max login) and the run env (`ANTHROPIC_BASE_URL` = proxy/provider, `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_API_KEY`).

Resumed runs (`--resume`: goal iterations, loop passes, `continueSession`, human-message resumes): the CLI reports `modelUsage` and `total_cost_usd` cumulatively for the whole session, so the app stores each run's cumulative snapshot and records only the difference from the previous snapshot of that session (kept across restarts via `runs.json`). If no snapshot is known, the per-call `usage` is used and cost is recorded as 0 (`usageBasis: usage-no-baseline`). The live log shows "this run only; session total $X" for resumed runs.

Each agent has a **Billing** mode: auto (detect only), subscription (API key, base URL and Bedrock/Vertex vars are removed from the run env), api (uses `ANTHROPIC_API_KEY`) or proxy (sets `ANTHROPIC_BASE_URL`). If a run did not use the chosen mode, the Usage tab flags it.

The UI shows measured tokens first, **per model**: opus tokens are not sonnet tokens are not glm-5.3-flash tokens, so every per-model breakdown (the ranked share bars and the detailed tables) carries that model's own in/out/cache-read/cache-write counts — tokens are never summed into one cross-model figure; only **cost** gets a grand total. `total_cost_usd` is only shown as "API-equivalent (reported by Claude CLI)"; for subscription runs it says "Covered by subscription — not billed per token". The **Usage** tab has totals by agent, model, billing source and task, a per-run history table, and CSV export (this project or all projects).

### Usage limits, dispatch guard, node badges and capability auto-discovery

The Usage tab's **Usage limits** panel (`src/usage.js`'s `usageStatus`, configured per project in `settings.usageLimits`, 0 = disabled) tracks four independent caps: subscription runs in the rolling 5h and weekly windows (request-count based — there is no cost to a Pro/Max login), and API-key/proxy runs by reported cost and total tokens. Each shows a meter bar and "N% used", turning `warn` at the configured `warnPct` (default 80%) and `pause` at 100%; runs older than the window are excluded automatically, so the meter naturally resets as old runs age out rather than accumulating forever. `Orchestrator.checkUsageLimits()` (called after every agent run) mirrors the same status into `usagePaused`, and the dispatch loop (`tick()`) skips every `todo` task while that flag is set — already-running agents are left alone, only new dispatch is paused — with a once-per-crossing log line and OS notification.

Every graph node shows small vendor/model chips (e.g. `Claude` / `opus`) next to its avatar, driven by the node's `runtime`/`model` fields (or the live run's, once one starts). Capabilities (slash commands, skills, permission modes — probed straight from the runtime's own `--help` output or a live init event, never a hard-coded per-runtime list, see `src/capabilities.js`) used to require clicking "Refresh" in the node form; `addNode` (`src/main.js`) now probes a brand-new agent immediately, so its "Discovered capabilities" panel is already populated instead of reading "Not probed yet".

`npm run gui-e2e:limits` (also run as part of the full `npm run gui-e2e`) stubs 5h-window runs directly into `runs.json` (no real model calls) and checks: the meter reads 60% used with a stale run outside the window correctly excluded, then crosses warn (86%) and pause (100%) as the configured limit tightens; a real `Orchestrator` refuses to start a ready `todo` task while paused; graph badges render both agents' runtime/model; and a freshly added agent's capabilities panel is populated right away. Shots: `limits-meter-{light,dark}`, `limits-pause-banner`, `limits-graph-badges-{light,dark}`.

`npm run gui-e2e:limits-providers` (also run as part of the full `npm run gui-e2e`) checks the top-bar limit meter per provider with stubbed limit data (no real model calls), one dedicated project each: a **Claude-only** team shows the CLI's own reported utilization (42%/13%) even when the local run count is higher (60%) — the CLI reading wins outright — and stays below warn with a live reset countdown; a **Codex-only** team whose CLI reports nothing (a stub `codex --version` answers, but no rate-limit event ever arrives) shows an honest per-node "no limit data" reason and never a fabricated percentage or warn/pause state; a **mixed** team surfaces the Claude-reported 42% without letting it bleed onto the silent Codex node. The per-provider chip contract (one chip per provider the team actually uses, "limits unknown" instead of a guess, no Claude wording anywhere on a Codex-only team) is asserted as soon as `usageStatus` carries provider-keyed data or the meter renders `[data-provider]` chips; before that, the case logs how many contract checks it skipped instead of failing them (feature-gated — the tests define the target behavior, they don't enshrine the old single-provider "5h/weekly" wording). Shots: `limits-providers-claude-only`, `limits-providers-codex-only`, `limits-providers-mixed`.

`npm run gui-e2e:discovery` (also run as part of the full `npm run gui-e2e`) feeds the recorded real init event (`test/fixtures/real-init-event.json`, 58 skills / 123 slash commands including `goal`/`loop`) through `discoverCapabilities` exactly as a real Refresh would, and checks the Usage tab's Discovery panel (`#us-discovery`) shows those exact counts (Skills `58`, Commands `123`, Modes including `goal`/`loop`); it also checks the panel never renders a `↻` reset chip when no reset time is reported, and never renders a stale `↻0m`/`↻NaN` chip once a limit is configured but the reported window has already elapsed. Shot: `discovery-panel`.

`npm run gui-e2e:usage` (also run as part of the full `npm run gui-e2e`) seeds usage for three models across two runtimes (`claude-opus-4-5`, `claude-sonnet-5`, `glm-5.3-flash` on `claude`/`helpycode`; fixtures only, no model calls) and asserts per-model accounting end to end: the By-model breakdown and the detailed By-model table show a separate ranked row per model whose runs/in/out/cache/total cells are exactly that model's own seeded tokens — never a cross-model sum and no merged or grand-total token row — `modelStats()` (`src/usage.js`) exposes exactly one bucket per model holding only its own tokens and cost, the run history shows one row per run with its model and cost, and the only grand total, cost ($0.0658 = 0.0123 + 0.0456 + 0.0079), matches in both the cost card and the hero KPI. Shots: `usage-permodel-{light,dark}`.

### Stalled runs: automatic stop + resume

A hung model call (no events, no live process) used to strand an agent forever. The stall watchdog (`Orchestrator.sweepStalls()`, every 5s) checks each working run that has emitted nothing — no stdout/stderr byte, no parsed event — for `stallTimeoutMin` minutes (project setting, default 10, `0` disables the watchdog). Liveness is judged broadly before declaring a stall: any output refreshes the timer, a live non-zombie descendant process (a long silent tool call: build, network, sleep) or an advancing CPU time keeps the run alive, and an unreadable process table never stalls ("no hunches"). A genuinely silent run with no live process is stopped (SIGTERM, SIGKILL after an 8s grace), and its task resumes **the same session** (`--resume <session_id>`) with a short "continue" prompt. Recovery ownership is a one-way claim on the run object, so a watchdog tick racing a manual stop or a queued human message can never double-fire; manual interrupts always win and are never recovered over.

The recovery budget is persisted on the task (`stallRecoveries`, so it survives app restarts) and allows **2** automatic recoveries; only a run exiting 0 (real progress) resets it. On the third stall — or when the stalled run has no session id to resume — the task is parked in `waiting_for_human` with an orchestrator comment instead of silently retrying fresh. Each step is logged and surfaced as `run.stalled` / `run.recovering` / `run.recovery_failed` events (renderer channels `run-stalled` / `run-recovering` / `run-recovery-failed`, shown as badges on the agent card and task). Tests: `test/stall-recovery.test.js` (fake clock + fake hung runner, no real model).

### Subagents (Task/Agent tool)

Agents acting as team leads spawn subagents — Claude Code's `Agent`/`Task` tool (child events carry `parent_tool_use_id`) and the helpycode/opencode `task` tool (the whole spawn surfaces as one `task` tool part, with the child session id in its `<task id="ses_…">` answer). The orchestrator keeps one record per subagent (`src/subagents.js` `SubagentTracker`, mirrored into the agent snapshot as `subagents` / `subagentCount` / `subagentTokens`): description, start/end, status (`running` → `completed`, `failed` on an `is_error` tool result, `aborted` when the run ends first), depth (a subagent spawning its own subagents nests, `parentAgentId` points at the parent record), and the child session id. Children are matched by the CLI's own tool-use id, never arrival order, so parallel subagents with interleaved events group correctly.

Token usage on a subagent record is a **breakdown** of the parent run's totals (claude's result already includes sub-agent usage), never an addition: child assistant turns report their own message usage, deduped by message id, and the parent's context meter ignores child turns. A runtime that reports no per-subagent usage (opencode-derived ones) shows `n/a`, not 0. Log lines emitted inside a subagent carry `subagentId`; the renderer (`renderer/app.js` + `src/subagent-view.js` helpers) nests them under a collapsible block per subagent (description, status, duration, own tokens) in Logs, Overview and Chat, with a per-agent count badge on the Team and Overview graphs — helpycode-style spawns have no child events on the stream, so they surface through the counts/badges rather than nested rows. Records are persisted on the run (`usage.subagents` in `runs.json`), so nesting and counts rebuild after a restart. Fixtures are real captured streams (`test/fixtures/subagents-claude.jsonl`, claude 2.1.283, two parallel Agent spawns; `test/fixtures/subagents-helpycode.jsonl`, helpycode 0.3.5, two parallel task parts): `test/subagents.test.js` replays them through the parsers, and `npm run gui-e2e:subagents` replays them through the live app (no model calls) and checks the nested Logs blocks, the per-agent badges and the Chat chips (shots `31-subagents-logs` … `34-subagents-chat`).

## Agent run modes and sessions

Each agent has a **Run mode**, set in the agent panel (`src/agent-modes.js`):

- **single** (default): one `claude -p` run per task.
- **goal**: after each run, a short separate check run (`claude -p --output-format json --json-schema {met,reason} --no-session-persistence`, with read-only tools, model `checkModel` which defaults to haiku) decides whether your **completion condition** is met. If the checker's answer cannot be parsed, the check is retried once; if it is still unreadable the result is **inconclusive**: the raw checker output is written to the log, the agent is not told "not met", the loop stops and the task goes to `review`. If it is not met, the agent runs again with `--resume <session_id>` and a "continue, the condition is not met yet: ..." prompt, which includes the checker's reason. This stops when the condition is met, after `maxIterations` (1-50), on a non-zero exit, or on Stop. If the check still says "not met" at the end, the task goes to `review`, even if the agent marked it done. Each check run costs money too, and that cost is added to the agent's total.
- **loop**: runs the task prompt exactly `loopCount` times in the same resumed session (it stops earlier only on Stop, a non-zero exit, a budget or `maxRuns`). Every pass except the last tells the agent not to mark the task done; the last pass asks for done as usual. A done set by the agent in an earlier pass is ignored and the task is reopened for the next pass.
- **workflow**: the prompt is the slash command or skill string you choose (for example `/review`, `/security-review` or `/my-plugin:skill args`) followed by only the task text (title/description), so `$ARGUMENTS` in a custom command receives just the task. The team context (role, teammates, board instructions) goes in `--append-system-prompt`, before the agent's own append prompt. A bare name such as `review` gets a leading `/`.

Sessions: each run's `session_id` (from the stream-json `init` and `result` events) is saved on the task as `sessionId`, with its `iterations` count, and shown in the task detail. If a task that already has a session runs again, it resumes that session. **Continue conversation** (`continueSession`) makes the agent's next task resume the session of its most recently updated task. Every extra iteration counts toward `maxRuns`.

Limits (checked against the installed `claude` CLI): slash commands and skills are only expanded when they are the first thing in a `-p` prompt. Whether they work depends on the CLI, the working directory's `.claude/commands` and skills, and installed plugins. Interactive-only commands do nothing useful in print mode, and an unknown command is sent as plain text. `--resume` needs the same working directory as the original session, which holds while a node keeps its workdir. The goal checker is an LLM judgement and can be wrong, so write conditions it can check, such as file contents or command output. It runs in the agent's working directory with only Read, Glob, Grep, `ls` and `cat`.

## How agents talk: MCP board server

`src/mcp-server.js` is a stdio MCP server, started once for each agent run with `--project <dir> --node <id>`. It provides these tools:
`list_team`, `list_tasks`, `create_task`, `update_task_status`, `comment_task`, `send_message`, `read_messages`, `read_wiki`, `write_wiki`. Each agent can switch off any of these tools (Permissions & CLI -> Board MCP tools). Disabled tools are not registered and are refused if called.

Scope is enforced on the server side (`src/board-tools.js`, `src/scope.js`):
- `create_task`: the assignee must be the agent itself or a target of one of its outgoing edges. Anything else is refused with `scope violation`.
- Status changes: only for tasks assigned to the agent, created by it, or assigned to one of its outgoing neighbours.
- Comments and `list_tasks`: only for tasks of the agent and its direct neighbours.

Other agent CLIs are wired up generically via a `RuntimeProfile` (`src/runtime-profile.js`), derived by `src/introspector.js` and driven by `src/profile-runner.js` — no CLI-specific code in the runner. New runtimes are onboarded from the CLI itself: Settings > Runtimes > Detect runs the introspector (`--help` + subcommand help + one probe run) and yields an editable draft profile; if help parsing is not enough, the ladder falls back to a probe run and finally to asking the agent for its own profile JSON (schema-validated). See `docs/onboarding-introspection.md` for the full flow, fixtures and known gaps, and `docs/helpycode-smoke.md` for a real (non-Claude) CLI end-to-end smoke test against the board MCP server.

Live activity streams for every runtime: profile-driven CLIs (helpycode etc.) get their JSON event stream parsed generically (`parseProfileEvent` in `src/runtimes.js`) into the same live text/tool/token logs Claude's stream-json produces — text, tool calls/results and per-step token usage all show in the Logs tab while the agent runs, instead of the run looking hung between start and finish. The parser also understands opencode-family event shapes (`tool_use` parts with pending/completed states, `step_finish` where only `reason: stop` ends the turn). It relies on the CLI's stdout stream only; helpycode's own log files rotate quickly and are not a usable activity source.

## Roles, presets and per-agent permissions

- Roles are free text. The role field suggests PM, Planner, Dev, Reviewer and QA, plus this project's role presets and roles already in use. Presets are managed in Settings or with "Save as role preset" and are stored in the project's `settings.json` as `rolePresets`. Each preset has a name, a default system prompt, default allowed and disallowed tools, and a permission mode. A new agent whose role matches a preset gets those defaults, and so does an existing agent whose role is changed to a preset's name (only its empty prompt, tool and permission fields are filled; **Apply preset** overwrites them).
- Each agent has these settings (see `src/agent-config.js`): permission mode (overrides the project default), `--allowedTools` (`mcp__board` is added automatically), `--disallowedTools`, `--max-turns`, `--append-system-prompt`, `--add-dir`, env vars, extra CLI args (shell-style quoting) and working directory.
- Edge types (A -> B): **assign** lets A create tasks for B and message B (edges without a type count as assign). **message** allows only `send_message`. **review** means B reviews A: B can see A's tasks and move them to review or done. Set the type in the toolbar select before connecting, or by clicking an edge. Messages are stored in `messages.json` and shown in Observability.

## Layout

```
src/projects.js     project/team manager, templates, migration, export/import
src/store.js        JSON store (team files, settings; board as .squad/board/tasks/<id>.json, wiki as .squad/wiki/<slug>.md), atomic writes + cross-process mkdir lock, migrates old board.json/wiki.json
src/scope.js        edge-based permission rules
src/board-tools.js  tool logic (shared by MCP server and tests)
src/mcp-server.js   stdio MCP server (@modelcontextprotocol/sdk)
src/agent-modes.js  run modes (goal/loop/workflow), checker args/parsing
src/controls.js     dependencies, budgets, approval gate, log persistence (pure)
src/orchestrator.js scheduler, claude spawning, stream-json parsing, cost/token accounting
src/main.js, preload.js   Electron main + IPC bridge
renderer/           vanilla JS UI (SVG graph editor, board, wiki, observability, settings)
cli/e2e.js          headless end-to-end run
```

## Graph editor

Team tab: drag nodes to move them (positions persist), **Connect** then click source and target to add an edge of the chosen type. Edges may point into another team of the same project (cross-team edge; the target team sees it as incoming). Node positions are saved in bulk (auto-layout) and each team keeps its own viewport (pan/zoom).

`npm run gui-e2e:graph` checks a 12-node team, connect by mouse, drag, cross-team edge and position/viewport persistence, and takes `21-graph-team`, `22-graph-connected`, `graph-light`, `graph-dark` shots. Zoom/fit, the node context menu and auto-layout are feature-detected (logged as "pending" until the UI ships them, then asserted, with `23-graph-layout` / `24-graph-menu` shots).

## Preflight test

Each agent node has a **Test agent** button, and the Team toolbar has **Test team**. A test spawns `claude` with the agent's exact run config (model, permission mode, allowed/disallowed tools, env, billing mode, extra args, board MCP config) and `--max-turns 3`, using a prompt that must call the board `list_team` tool (with no model set, it tests the claude CLI default model, currently opus, so a test costs a few cents API-equivalent) and reply `OK`. It checks that the claude binary is found (and reports its version), that the model is valid, that auth works (reporting `apiKeySource`), that the board MCP server connected, that the tool call succeeded and that the agent replied OK. It also records latency, tokens and cost. The result is saved on the node (`preflight`) and shown as a PASS/FAIL/RETEST badge on the node, with the list of checks in the agent panel. The badge shows RETEST when a run-relevant setting has changed since the last test. Preflight runs are recorded in usage with `kind=preflight`. If any agent is untested, failed or stale, **Run** asks for confirmation first. The logic is in `src/preflight.js`.

## Run controls (F6)

Logic lives in `src/controls.js`, wired into the store, board tools, orchestrator and UI. Tests are in `test/controls.test.js`.

- **Task dependencies (`blockedBy`)**: a task holds a list of task ids. The scheduler only starts a `todo` task once every dependency is `done`. Unknown or deleted ids do not block, and deleting a task removes it from other tasks' lists. Self references and cycles are refused. Agents can pass `blockedBy` to `create_task`, and `list_tasks` reports `blockedByOpen`. On the Board, tick dependencies in the task detail; cards show a **blocked (n)** tag. If only blocked tasks are left, the Run stops and says why.
- **Budget caps**: each agent has a per-Run budget in $ (reported cost) and in tokens (input + output). The project has the same two caps in Settings. The check runs after every recorded run, including goal checks. When an agent goes over, that agent is stopped and gets no more tasks in this Run. When the project goes over, the whole Run stops. Counters reset on each Run. The reason appears in Observability, in the agent panel and as a notification.
- **Human approval gate**: set **Require human approval** on an agent or for the whole project. When the agent's task would become `done` (via `update_task_status`, or on a clean exit without a status), it goes to `review` with `awaitingApproval` set. Agents cannot move it to done. The Board shows a **needs approval** tag plus **Approve → done** and **Request changes → todo** (the note is saved as a comment, so the agent reworks it on the next Run).
- **Live view, stop one agent, message an agent**: while a task runs, its detail shows the agent's live log, a **Stop agent** button (kills only that agent's run, and the task goes to review) and a message box. Observability also has Stop and Message buttons for each agent. A message to a running agent interrupts the run and resumes the same session with your message as the next prompt. A message to an idle agent goes to its inbox, and `read_messages` now includes messages from `human`.
- **Persisted logs**: every orchestrator log line is appended to `<project>/logs.jsonl` (trimmed to the last 5000 lines above about 3 MB) and loaded back when you open the project. **Clear** also deletes the file.
- **Notifications**: approval needed, budget reached and run finished show an in-app toast (click to open the task). A desktop notification is shown only when the window is not focused, and can be switched off in Settings.
- **Keyboard shortcuts**: Ctrl/Cmd+1…6 switch tabs, Ctrl/Cmd+Enter runs, Ctrl/Cmd+. stops, `/` focuses the goal box, `n` starts a new task on the Board, Esc clears the selection, and `?` (or the header **?** button) shows help.

`npm run gui-e2e` also covers these: it sets a dependency and sends a message through the UI, approves a task, saves budget and approval settings, and uses the shortcuts, and asserts each result (screenshots `5-deps`, `6-approval`, `7-settings`, `8-shortcuts`).

## Self-update and restart

The app can keep itself current: when a new commit lands on the project repo's base branch (`main`), an update watcher in the main process (`src/self-update.js`, polling every 60 s on both local HEAD and origin) restarts the app on the new code and resumes the team — no more hand-killing the app after every merge. The flow is: **pause the scheduler** (no new dispatch) → **drain** (wait for running agents to finish, at most `drainTimeoutMin` minutes — default 5, `0` waits forever; past the grace whatever is still running is stopped and its task re-dispatches after the restart with its session resumed, so one long run cannot freeze the whole team behind an update; a "waiting on N agents" state is visible meanwhile) → **fast-forward** the checkout with `git merge --ff-only` (refused if the main checkout is dirty — checked *before* the drain, so a doomed update never even starts pausing the team for long) → **run `npm test` and build in a temp worktree** at the new sha so a bad checkout never touches the live tree → only on pass, write the **restart state** (`{wasRunning, reason, fromSha, toSha, ts}` plus a boot-attempt counter) and `app.relaunch()` + exit.

Guards keep this from restart-looping: at least 10 minutes since the last restart and a cap per hour (excess merges just wait for the next poll); a failed test **or** build means **no restart** (the reason is logged and the scheduler resumes on the old code); on boot the restart state is consumed exactly once and the Run auto-resumes if it was running, with an activity-feed entry saying why. If the new code fails to reach "ready" twice, the app rolls back to `fromSha` and disables auto-restart with a visible banner. The user controls it with the Settings toggle **Auto-restart on new merged code** (off by default), and sees when/why it last restarted plus the restart history in Settings.

The PM can also trigger the same guarded flow after a merge with the board MCP tool **`request_self_update`** (registered in `src/mcp-server.js` for PM-role nodes only). It honors the Settings toggle and all the guards above, and the outcome is logged to the activity feed.

Tests: `node --test test/self-update.test.js` drives the real flow against a temp git repo with injected test/build/relaunch fakes (no real-model runs): new commit → drain → pass → restart-state written → resume on boot; test failure → no restart; busy agents are drained within the grace deadline (past it they are halted and their tasks resume after the restart; `drainTimeoutMin 0` restores wait-forever); a dirty checkout is refused before anyone is paused.

**Scheduled restarts**: a landed merge never restarts the app on its own — each auto-merge only bumps a pending counter (`restartPending` in the project state; the header pill and the `getRestartState` IPC show how many changes are waiting and since when). An actual restart is armed solely by the PM-only board tool **`schedule_restart`** — `{afterTaskId}` restarts once that task is done and in-flight work drains (anchors that may never finish — `waiting_for_human` or a blocked `todo` — are refused at schedule time), `{now:true}` restarts once agents drain — or by the human **Restart now / Cancel schedule** pill, or automatically once `restartCap` (Settings, default 20) changes pile up with nothing armed (the PM is notified once per crossing). While a schedule is armed the scheduler pauses all *new* dispatch (reviews included) except the anchor task itself, which must run for the restart to come due; the gate deliberately survives the fire until the relaunch, so no run can slip into the second before the watcher pauses dispatch. Firing reuses the update flow above — the drain is bounded by `drainTimeoutMin` (stragglers are stopped at the deadline and their tasks resume after the restart), then tests on the target sha, then relaunch. The fired schedule is persisted so a crash mid-relaunch cannot lose it, and it is consumed only when the new process boots, which also lifts the dispatch gate; cancelling disarms without losing the pending count. Tests: `test/restart.test.js` and `test/restart-qa.test.js`.

### Live-proof recipe (dogfood)

Proven live in the dogfood app (task t_e69a73f0): with several agent runs active (QA, core dev, UI dev), a trivial docs commit on task branch `squad/t_e69a73f0` was merged into the base branch in the main checkout. Within one poll the activity feed logged `self-update: new commits on master (…); pausing new runs`, the watcher drained the live runs (they finished uninterrupted), fast-forwarded, tested in a temp worktree and relaunched onto the merge commit. Because the agent that triggers the merge is itself one of the drained runs, capture the evidence with a detached monitor instead of in-session: every few seconds log the repo HEAD, the main-process PID list (`Electron -r … .`), `restart-state.json` and `self-update-history.json`, and on a main-PID change bring the app frontmost and screenshot it. Afterwards check: history `fromSha`/`toSha` straddle the merge and post-boot `git rev-parse HEAD` equals `toSha` (restarts onto the new commit); the pre-restart main PID is gone and exactly one main process/window remains; `restart-state.json` was written with `wasRunning: true` and after boot `runs.json` shows the in-progress tasks re-dispatched (`iteration` bumped, `resumedFrom` set) — the team resumes. An update attempt that hits a dirty main checkout (a parallel dev mid-edit) aborts with a logged reason and is retried on the next poll.

## Parallel work and idle detection

Agents run in parallel: each agent with an `in_progress` task (or a live run) is **busy**, everyone else is **idle**. The Team and Board tabs show a banner such as **"2 agents idle: Bo, Cy"** with an *Assign work* button that jumps to the new-task form with the first idle agent preselected. Presence is shape-based: a spinning arc = busy, a hollow ring = idle.

The orchestrator also nudges PMs: any node with assign edges to others that still has open goals (tasks it owns or created) gets a board message listing its idle reports. The nudge repeats only when the idle set changes.

PM guidance: split goals into independent tasks so every report has one in flight; give each dev a disjoint file area to avoid conflicts; when nudged, create or reassign tasks rather than waiting on a single agent.

## Mixing vendors

Each agent picks its runtime (Claude Code, Codex) and model on its own node, so one team can mix vendors: e.g. a Claude/Opus PM, a Codex Dev and a Claude/Haiku Reviewer. The graph and the Overview show a runtime + model badge on every node. Codex agents get the board MCP server too (passed as `codex exec -c mcp_servers.board.*` overrides), so they call `comment_task`, `update_task_status` etc. themselves. If a Codex run exits 0 without setting a status, the orchestrator still moves the task to done (non-zero goes to review). `blockedBy` chains order it between Claude agents. The Usage tab has a **By vendor** table: Codex tokens are counted, its cost shows `—` (Codex reports no cost), Claude shows $.

- `node --test test/mixed-vendor.test.js`: fake `claude` + `codex` bins; PM → Dev → Reviewer chain finishes in dependency order, with the right binary and `--model`/`-m` for each, and Codex tokens/thread id stored on the run.
- `npm run gui-e2e:mixed`: the same team in the app; checks the graph chips, the Overview `vendor · model` lines and the Usage By-vendor split (Codex 107 tok / `—`, Claude $). Shots `e2e-shots/28-mixed-graph-{light,dark}.png`, `29-mixed-overview-{light,dark}.png`, `30-mixed-usage-{light,dark}.png`.

Live run (2026-09-27, codex-cli 0.144.6, ChatGPT login, orchestrator from this repo, scratch git repo): one Codex Dev (`gpt-5.6-terra`, bypassPermissions) was told to create `MIXED_VENDOR.txt`, then call `comment_task` and `update_task_status` itself. Orchestrator log:

```
▶ Cody starts "Add MIXED_VENDOR.txt" in /tmp/squad-live2/work [mode=single]
codex thread 01a0e17a-4673-7152-ab78-a385ec3b748c
file_change add /private/tmp/squad-live2/work/MIXED_VENDOR.txt
mcp__board__comment_task {"taskId":"t_72c314bf","text":"Added MIXED_VENDOR.txt with the requested line."}
mcp__board__update_task_status {"taskId":"t_72c314bf","status":"done"}
Created `MIXED_VENDOR.txt` with the requested line, commented on the task board, and marked task `t_72c314bf` done.
codex turn completed: 84237 in / 409 out
■ Cody finished (exit 0, 1 iteration(s), single run)
```

The task comment's author is `Cody`, so the done status came from Codex and not from the exit-0 fallback. Cost: 84,237 input / 409 output tokens, no dollar figure. On a ChatGPT login the usage counts against that plan. Gotchas: the MCP server needs `npm install` in `app/`. Without it the server crashes on start, and Codex just says "board MCP tools aren't available" (it does not fail). Also, the account default `gpt-5.6-sol` is rejected on ChatGPT logins, so set a supported model on Codex nodes.

## Limitations

- Agents run with `bypassPermissions` by default, with no sandbox. Point working directories only at folders you trust agents to change.
- **Parallel runs and `blockedBy` semantics**: on each tick the scheduler starts every `todo` task that is ready, up to `maxConcurrency` runs in total. Each agent runs at most one task at a time, and teams in a project are scheduled together. A task is ready when every id in its `blockedBy` list is `done`. A blocker in `in_progress`, `review` or `waiting_for_human` still blocks it. Tasks without dependencies never wait for each other. A failed blocker never releases its dependents, so if only blocked tasks remain the Run stops and says why. `test/parallel.test.js` and `npm run gui-e2e:parallel` check this: 3 Dev tasks across 2 teams run at once (each pair of run windows overlaps, `A.start < B.end && B.start < A.end`, every run lasting at least 1s), and a dependent task starts only after its blocker's run has ended (screenshots `26-parallel-board`, `27-parallel-overview`).
- **Polish shots** (`npm run gui-e2e:polish`): for both teams, captures the graph at zoom 0.4 and 1.0 (`28-polish-team{1,2}-zoom{40,100}-{light,dark}`) and the sidebar (`29-polish-sidebar-team{1,2}-{light,dark}`). It checks that the smallest visible node name is at least 11px on screen at zoom 0.4 (CSS font-size × SVG screen scale) and that the sidebar lists both teams.
- Dependencies are only enforced when someone sets `blockedBy`. A PM can still close its own goal early if it does not make it wait.
- A human message to a running agent kills the current `claude -p` process and resumes the session (`--resume`). Work in progress in that turn can be lost. The CLI has no way to take input mid-turn in print mode.
- Data is stored as plain JSON files, one project per directory.

### Screenshots (light + dark)
`npm run gui-e2e` writes `e2e-shots/main-{chat,team,board,inbox,overview,firstrun}-{light,dark}.png` for the main screens, forcing the theme via Electron `nativeTheme`.

### Logs and Wiki at scale
`npm run gui-e2e:mainlogswiki` (also run as part of the full `npm run gui-e2e`) seeds a realistic fixture — 20 agents, 30+ wiki pages, and 540 log lines split into 3 sessions per agent — and checks both tabs hold up at that size, at 1280x800:
- **Logs**: the left `#logagents` list shows every agent plus "All agents" with a running line count; the log pane (`#log`) renders 20+ rows and scrolls internally. Clicking one agent filters `#log` down to just that agent's lines across its sessions — its own conversation, in order, including the `▶ … starts session N` markers. Shots: `main-logs-{light,dark}.png` (all agents), `main-logs-session-{light,dark}.png` (one agent's session).
- **Wiki**: the page list (`#wikipages`) holds 30+ pages; the `#wk-search` box filters by title/content live and shows a "No pages match" empty state for a query with no hits. Shots: `main-wiki-{light,dark}.png` (full list), and, on a freshly created project with no pages or log lines yet, `main-wiki-empty-{light,dark}.png`.

### Team filter for Logs
`npm run gui-e2e:teamfilter` (also run as part of the full `npm run gui-e2e`) is the e2e for the "logs chat should filter by team" request (plan review `t_db23070d`): a 2-team fixture (Alpha: PM + Dev, Beta: Dev + Reviewer) plus a message-type cross-team edge from Alpha's PM into Beta's Dev, so a message logged under Beta's agent has an Alpha sender. The scenario is feature-detected — it looks for a team select (`#logteam`, `#log-team`, or `[data-log=team]`) next to the Logs tab's existing `#logfilter`, and logs "pending" without failing until the UI ships (Uma's `t_86da3a0b`). Once it's there, it checks the shipped per-team log scope (`t_8d3d6989`): switching to a team scopes the log to that team by default (Alpha's lines only, no Beta lines); the explicit `All teams` option lifts the scope back to every line; selecting a team hides other teams' lines, keeps the team's own, and narrows `#logfilter`'s options to that team's agents; the selected agent resets to All on a team change; a cross-team message is logged under the recipient, so it renders only on the recipient's (Beta) side and is not mirrored to the sender's team; a team with no activity shows a dedicated "no messages for this team" empty state (not the generic filter-empty message). Shots: `teamfilter-{default,all,alpha,beta,empty}.png`, `teamfilter-{light,dark}.png`.

### UI critique evidence (24 agents, 4 teams)
`npm run gui-e2e:critique` (also run as part of the full `npm run gui-e2e`) is the evidence run for `design/critique-views.md`'s must-fix #2: a fixture with 24 agents in one team plus 3 small peer teams (24 agents / 4 teams total), at a 1440x900 window. It screenshots Overview, the Timeline widget (cropped), Logs, Wiki and the Graph editor, light + dark (`critique-{graph,overview,timeline,logs,wiki}-{light,dark}.png`), and checks:
- **Names ≥11px or LOD**: at fit-to-view with 24 nodes the smallest node name must render at ≥11px on screen, or a LOD collapsed-frame fallback must stand in for it. Today this passes at 11.0px (the existing zoom-compensated font size in `renderer/app.js`'s `applyVP()` just clears the bar); there is no collapsed-frame fallback yet for teams too large for that to hold.
- **Edge contrast ≥3:1**: computes the WCAG 1.4.11 contrast ratio of a rendered `#graph .edge` stroke against the canvas background in both themes. Passes today (light 3.41:1, dark 5.08:1).
- **Minimap hidden when the graph already fits**: after `fitView()` exactly fits the 24-node graph, `#minimap` should hide. **Currently fails** — the minimap is always shown; this is part of Uma's in-progress `t_961b3b38`.
- **No stacked popovers**: opening a second edge-type popover (drag-connect) must replace the first, not stack a duplicate `#ctxmenu` on top of it. Passes.
- **Logs "new lines" pill**: feature-detected (critique-views.md #8); not shipped yet, so this check is skipped and logged as pending rather than failed.
