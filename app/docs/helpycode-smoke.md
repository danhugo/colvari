# Real helpycode end-to-end smoke (board MCP)

Verifies a real `helpycode` (elice/z-ai/glm-5.3-flash) run can: take a trivial board task, call the
board MCP tools, report token usage, honour `--variant`, and resume with `-s`. Run this once after
touching the RuntimeProfile core (`src/introspector.js`, `src/profile-runner.js`,
`src/runtime-profile.js`) or the board MCP server (`src/mcp-server.js`) — it's a real-model run, so
don't re-run it for unrelated changes.

## Prerequisites

- `helpycode` on `PATH` (it's an `opencode`-derived CLI; global config lives at
  `~/.config/helpycode/helpycode.jsonc`, not `~/.config/opencode`).
- `npm install` run in `app/` (a fresh checkout is missing `node_modules/@modelcontextprotocol/sdk`,
  which makes `src/mcp-server.js` exit silently with `MODULE_NOT_FOUND` — check that first if the
  agent reports "board MCP tools not available").

## Known gap: generic introspector doesn't parse helpycode's real `--help`

`introspectRuntime('helpycode', ...)` (src/introspector.js) currently derives an empty profile
(`argsTemplate: ['--model', '{model}', '{prompt}']`, no `run` subcommand, no MCP method) against the
*real* `helpycode --help` output, because `parseCommands` expects `  <name>  <desc>` lines but
helpycode prefixes every command with the binary name (`  helpycode run [message..]     run ...`).
The introspector's own tests only exercise a hand-written fixture (`help-helpycode.txt`) that already
matches the expected shape, so this gap wasn't caught there. Filed as a finding for the core
RuntimeProfile owner; until fixed, build the profile for real helpycode by hand (see below) rather
than trusting the introspector's output.

## Wiring the board MCP server into a project directory

helpycode reads MCP servers from a project-local `helpycode.json` (or `.jsonc`) next to where you
run it — **not** `opencode.json`, even though the binary is an opencode fork:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "board": {
      "type": "local",
      "command": ["node", "/absolute/path/to/app/src/mcp-server.js", "--project", "/absolute/path/to/board-project-dir", "--node", "<nodeId>"],
      "enabled": true
    }
  }
}
```

Sanity-check the config was picked up with `helpycode debug config` (prints resolved config,
including `.mcp`) before running anything — a silently-ignored file (wrong name) or a broken
`mcp-server.js` (missing deps) both look identical from the run output ("board MCP tools ... are
not available").

## Steps

1. Create a scratch board project and a trivial task assigned to a node:
   ```js
   const { Store } = require('./src/store');
   const store = new Store('/tmp/hc-smoke-project');
   const node = store.addNode({ id: 'n_smoke', name: 'Smoke', role: 'Dev', workdir: '/tmp/hc-smoke' });
   store.createTask({ title: 'Say hello', description: 'Call comment_task ... then update_task_status ... done.', assignee: node.id });
   ```
2. Write `helpycode.json` (above) in the node's workdir, pointing `--node` at that node id.
3. Run the task:
   ```sh
   cd /tmp/hc-smoke
   helpycode run --format json --model elice/z-ai/glm-5.3-flash --variant low "<prompt telling it to call comment_task then update_task_status>"
   ```
   Check the JSON stream for `tool_use` events naming `board_comment_task` /
   `board_update_task_status`, and a `step_finish` event with a `tokens` object
   (`total`/`input`/`output`/`reasoning`/`cache`). Confirm the task's `comments` and `status` changed
   via `store.listTasks()` (or `getTasks()`).
4. Resume: grab `sessionID` from any event in the run's JSON stream, then
   `helpycode run --format json --model elice/z-ai/glm-5.3-flash --variant high -s <sessionID> "..."`
   and confirm it recalls context from the first run (proves both `-s` resume and `--variant` are
   honoured — a wrong/rejected variant value errors out immediately instead of running).

## Last verified

2026-09-27, helpycode 0.3.5, model `elice/z-ai/glm-5.3-flash`: board task completed via MCP
(comment posted, status set to `done`), `step_finish` events carried real token counts, `--variant
low` then `--variant high` on resume both ran, and resuming with `-s <sessionID>` correctly recalled
the prior turn's content.
