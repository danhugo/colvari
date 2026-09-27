# Agents Squad (MVP)

A desktop app for running a small team of Claude Code agents. Agents coordinate through a shared board and wiki. This is the minimal version of `../BLUEPRINT.md` (sections 4, 6, 7 and 9).

## Run

```bash
npm install
npm start          # Electron app (data root ~/.agents-squad, override with AGENTS_SQUAD_HOME=<dir>; AGENTS_SQUAD_PROJECT=<dir> is an equivalent alias, used by gui-e2e)
npm test           # unit + integration tests with a fake claude CLI (includes a real stdio MCP round trip)
npm run e2e        # real claude CLI in a temp dir: preflight, PM -> Dev team, then haiku loop + workflow agents (costs about $0.50 API-equivalent)
npm run gui-e2e    # drives the real UI (templates, agent panel, preflight, Run, usage, F6), asserts every check, exits 1 on failure;
                   # screenshots go to e2e-shots/. Uses a fresh temp project dir via AGENTS_SQUAD_PROJECT (set by the script).
npm run smoke      # launches Electron, clicks through the UI, then exits
```

You need the `claude` CLI on your PATH and logged in.

## Projects and teams

The left sidebar manages **projects**. Each project has its own board, wiki, settings and one or more **teams**, and each team is its own graph. You can create, rename, switch and delete projects and teams there. **+ Project** and **+ Team** use the selected template: Blank, Startup (PM -> Dev -> Reviewer), Solo or Research. Teams can also be duplicated and exported or imported as JSON (`format: "agents-squad-team"`).

Data is stored in `~/.agents-squad/projects/<id>/`, which holds `project.json`, one `team-<teamId>.json` per team, and `board.json`, `wiki.json` and `settings.json`. The first time the app starts, an existing `~/.agents-squad/default` is copied into a project named "Default". The original is left in place and marked `.migrated`.

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

The UI shows measured tokens first. `total_cost_usd` is only shown as "API-equivalent (reported by Claude CLI)"; for subscription runs it says "Covered by subscription — not billed per token". The **Usage** tab has totals by agent, model, billing source and task, a per-run history table, and CSV export (this project or all projects).

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

## Roles, presets and per-agent permissions

- Roles are free text. The role field suggests PM, Planner, Dev, Reviewer and QA, plus this project's role presets and roles already in use. Presets are managed in Settings or with "Save as role preset" and are stored in the project's `settings.json` as `rolePresets`. Each preset has a name, a default system prompt, default allowed and disallowed tools, and a permission mode. A new agent whose role matches a preset gets those defaults, and so does an existing agent whose role is changed to a preset's name (only its empty prompt, tool and permission fields are filled; **Apply preset** overwrites them).
- Each agent has these settings (see `src/agent-config.js`): permission mode (overrides the project default), `--allowedTools` (`mcp__board` is added automatically), `--disallowedTools`, `--max-turns`, `--append-system-prompt`, `--add-dir`, env vars, extra CLI args (shell-style quoting) and working directory.
- Edge types (A -> B): **assign** lets A create tasks for B and message B (edges without a type count as assign). **message** allows only `send_message`. **review** means B reviews A: B can see A's tasks and move them to review or done. Set the type in the toolbar select before connecting, or by clicking an edge. Messages are stored in `messages.json` and shown in Observability.

## Layout

```
src/projects.js     project/team manager, templates, migration, export/import
src/store.js        JSON store (team/board/wiki/settings.json), atomic writes + cross-process mkdir lock
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

## Parallel work and idle detection

Agents run in parallel: each agent with an `in_progress` task (or a live run) is **busy**, everyone else is **idle**. The Team and Board tabs show a banner such as **"2 agents idle: Bo, Cy"** with an *Assign work* button that jumps to the new-task form with the first idle agent preselected. Presence is shape-based: a spinning arc = busy, a hollow ring = idle.

The orchestrator also nudges PMs: any node with assign edges to others that still has open goals (tasks it owns or created) gets a board message listing its idle reports. The nudge repeats only when the idle set changes.

PM guidance: split goals into independent tasks so every report has one in flight; give each dev a disjoint file area to avoid conflicts; when nudged, create or reassign tasks rather than waiting on a single agent.

## Mixing vendors

Each agent picks its runtime (Claude Code, Codex) and model on its own node, so one team can mix vendors: e.g. a Claude/Opus PM, a Codex Dev and a Claude/Haiku Reviewer. The graph shows a runtime + model chip on every node. Codex has no MCP here, so a Codex agent cannot use the board tools; when its run exits 0 the orchestrator moves its task to done (non-zero goes to review), and `blockedBy` chains still order it between Claude agents.

- `node --test test/mixed-vendor.test.js`: fake `claude` + `codex` bins; PM → Dev → Reviewer chain finishes in dependency order, with the right binary and `--model`/`-m` for each, and Codex tokens/thread id stored on the run.
- `npm run gui-e2e:mixed`: the same team in the app; shots `e2e-shots/28-mixed-graph-{light,dark}.png` (runtime/model chips) and `29-mixed-overview-{light,dark}.png`.

Live run (2026-09-27, codex-cli 0.144.6, ChatGPT login, on a throwaway worktree of this repo): one Codex Dev (`gpt-5.6-terra`, bypassPermissions) was given "create app/MIXED_VENDOR.txt with one line". Transcript as logged by the orchestrator:

```
▶ Cody starts "Add app/MIXED_VENDOR.txt" in /tmp/squad-live-codex [mode=single]
codex thread 01a0e172-c3fe-7990-8936-6be0e4a06d3a
I'll add the requested single-line file, then mark the assigned task done on the team board.
file_change add /private/tmp/squad-live-codex/app/MIXED_VENDOR.txt
shell test "$(cat app/MIXED_VENDOR.txt)" = "written by codex via agents-squad" && ...
Created `app/MIXED_VENDOR.txt` with the exact requested line.
codex turn completed: 92591 in / 756 out
■ Cody finished (exit 0, 1 iteration(s), single run)   → task done in 23.8s
```

Cost: 92,591 input / 756 output tokens. Codex reports no dollar cost (capability `cost: false`), so Usage shows tokens only; on a ChatGPT login it counts against that plan, not an API bill. Note: the account default `gpt-5.6-sol` was rejected ("not supported when using Codex with a ChatGPT account"), so the task went to review with exit 1. Set a supported model on Codex nodes.

## Limitations

- Agents run with `bypassPermissions` by default, with no sandbox. Point working directories only at folders you trust agents to change.
- **Parallel runs and `blockedBy` semantics**: on each tick the scheduler starts every `todo` task that is ready, up to `maxConcurrency` runs in total. Each agent runs at most one task at a time, and teams in a project are scheduled together. A task is ready when every id in its `blockedBy` list is `done`. A blocker in `in_progress`, `review` or `waiting_for_human` still blocks it. Tasks without dependencies never wait for each other. A failed blocker never releases its dependents, so if only blocked tasks remain the Run stops and says why. `test/parallel.test.js` and `npm run gui-e2e:parallel` check this: 3 Dev tasks across 2 teams run at once (each pair of run windows overlaps, `A.start < B.end && B.start < A.end`, every run lasting at least 1s), and a dependent task starts only after its blocker's run has ended (screenshots `26-parallel-board`, `27-parallel-overview`).
- Dependencies are only enforced when someone sets `blockedBy`. A PM can still close its own goal early if it does not make it wait.
- A human message to a running agent kills the current `claude -p` process and resumes the session (`--resume`). Work in progress in that turn can be lost. The CLI has no way to take input mid-turn in print mode.
- Data is stored as plain JSON files, one project per directory.

### Screenshots (light + dark)
`npm run gui-e2e` writes `e2e-shots/main-{chat,team,board,inbox,overview,firstrun}-{light,dark}.png` for the main screens, forcing the theme via Electron `nativeTheme`.
