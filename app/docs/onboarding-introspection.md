# Onboarding a new agent CLI: introspection flow

How the app supports an agent CLI nobody wrote code for. The promise being tested: a `RuntimeProfile`
is **derived** from the CLI itself, with **zero new code** per CLI (`test/unknown-cli.test.js`
proves it end-to-end against a deliberately non-standard fake CLI; `test/introspector.test.js`
against recorded real `helpycode` output).

## The flow, end to end

```
Settings > Runtimes > add by path > Detect
  -> IPC api.introspectRuntime (src/main.js)
     -> introspectRuntime(bin) (src/introspector.js)   [steps below]
     -> toDraftProfile(profile)                         [backend -> renderer draft schema]
  -> editable draft form (renderer/app.js) -> saved as a custom runtime on the node
  -> runs go through runProfile(profile, ...) (src/profile-runner.js) — pure profile data, no per-CLI code
```

### 1. `introspectRuntime(bin)` — what actually runs

Every step merges stdout+stderr and never throws (some CLIs, e.g. real helpycode, print help to
stderr and exit non-zero):

1. `<bin> --help` — the only required input.
2. `parseCommands`: finds a `Commands:` / `Sub-commands:` section and reads its indented rows. CLIs
   that prefix every row with the binary name (`  helpycode run [message..]`) are handled by
   detecting the repeated first token and stripping it; positional-only rows (`helpycode [project]`)
   are dropped.
3. `pickRunCommand`: prefers a command literally named `run`/`exec`, else one whose description
   mentions JSON / non-interactive output, else the first command.
4. `<run> --help` — extra text for flag discovery.
5. Heuristics over the merged help text:
   - effort: `--effort` / `--variant` / `--reasoning-effort` plus the value list in parentheses
     (`(low, medium, high)` or `(e.g., high, max, minimal)`); unknown names degrade to unsupported.
   - resume: `--resume`, a `resume` subcommand, or `-x, --session` / `--session`.
   - model flag: `--model` (also matches short `-m` forms).
   - format: `--format json` or `--json`.
   - MCP: `--mcp-config` -> `json-flag`; `mcp_servers.` style -> `toml-override`; else `none`.
6. `argsTemplate` is assembled: `[run, --format, json, --model, {model}, --variant, {variant}, {prompt}]`
   (only the pieces that were found).
7. **Probe run** (unless disabled): the template is filled with a tiny prompt, flags whose placeholder
   is unset are dropped, and the NDJSON output is scanned by `deriveEventMapping` — known key
   synonyms (`session_id`/`threadId`, `text`/`content`, `input_tokens`/`prompt_tokens`, …) anywhere
   in nested events become the profile's `eventMapping` dotted paths.
8. `normalizeRuntimeProfile` (src/runtime-profile.js): fills defaults, coerces types, drops unknown
   fields, **requires a binary**, and degrades invalid `mcp.method` to `none`.

### 2. Fallback ladder when help parsing yields too little

- **Probe run** — already part of step 7; gives an `eventMapping` even when flags are opaque.
- **Ask the agent** (last resort): run the CLI once with a prompt asking the agent to emit its own
  RuntimeProfile as a single JSON line. The composition is already generic code, proven stubbed in
  `test/unknown-cli.test.js`: `parseJsonLines` (tolerates prose around the JSON line) ->
  `normalizeRuntimeProfile` (schema validation: a hallucinated or prompt-injected answer without a
  `binary` is **rejected**; unknown mcp methods degrade to `none`; types are coerced) ->
  `buildProfileArgs`/`runProfile` run it like any other profile.
  When this lands in the real UI it must be opt-in and visible (it costs a real-model call), per the
  critic review of the introspective-onboarding plan (t_94eef7a1).

### 3. Draft UI contract

`toDraftProfile` (src/main.js) converts the backend profile to the renderer's draft schema
(`label/bin/models/effort/resume/eventMapping{kind:label}`), agreed with the UI owner in t_833956fa.
The user can edit every field before saving; the saved custom runtime is then just data for
`runProfile`.

## Fixtures and tests

| File | What it is |
| --- | --- |
| `test/fixtures/help-helpycode.txt` | fictional "standard" helpycode help (original heuristic target) |
| `test/fixtures/help-helpycode-real-top.txt`, `-real-run.txt` | recorded from real `helpycode --help` / `helpycode run --help` (0.3.5; yargs-style binary-prefixed rows, `--variant`, `-s, --session`, help on stderr) |
| `test/fixtures/models-helpycode.txt` | recorded from real `helpycode models` (plain model-id lines, no JSON) |
| `test/fixtures/fake-agent-cli.js` | standard-shaped fake CLI, spawned as a **real process** |
| `test/fixtures/fake-odd-cli.js` | non-standard **unknown** CLI: help on stderr + exit 1, `Sub-commands:` with binary-prefixed rows, run command named `ask`, boolean `-j/--json`, short `-m/--model`, unknown effort/resume flag names (`--focus`, `-c/--continue`), no `models` command, `{kind, content, threadId, usage.*, cost_usd}` event envelope |

| Test | Proves |
| --- | --- |
| `test/introspector.test.js` | parsers/heuristics + full profile derivation from the fictional and the real helpycode help; `modelsCommand: ['models']` derived while the recorded `models` listing shape is pinned |
| `test/fake-cli-fixture.test.js` | real-process introspection + end-to-end run (tokens, variant, resume) |
| `test/unknown-cli.test.js` | unknown non-standard CLI: usable profile with zero new code, real end-to-end run, and the stubbed ask-agent fallback (validation + rejection) |
| `test/runtime-profile.test.js`, `test/profile-runner.test.js` | profile normalization/args-building and the generic runner |

## Known gaps and warts (by design, documented here)

- **Boolean `--json` gets a literal `json` value token** in the derived `argsTemplate`
  (`['ask','--json','json',...]`): the template always emits a value after `--format`-style flags.
  CLIs that treat the last positional as the prompt tolerate it (the fake-odd fixture models this);
  a real CLI that chokes on it would need a boolean-flag refinement in the introspector.
- **`models` output is not parsed into model names.** The profile carries `modelsCommand`, but the
  draft's model list is free text (see the helpycode scenario in `src/main.js` gui-e2e: the reviewer
  types model ids from `helpycode models` by hand). Parsing the listing is an introspector
  improvement, not a per-CLI code path.
- **Built-in helpycode still uses the hand-built profile** (`HELPYCODE_PROFILE` in
  `src/runtimes.js`), kept because it's verified by a live smoke run (`docs/helpycode-smoke.md`).
  The derived profile from the recorded real help output matches its shape (`run --format json
  --model … --variant …`, `-s` resume, `models`); deleting the hand-built profile in favour of the
  derived one is tracked from t_94eef7a1 and needs a byte-parity test before landing.
- **The probe run executes the unknown binary** (spawnSync, 10 s timeout, current cwd, inherited
  env). Fine for onboarding on a dev machine, but it runs unsandboxed — keep secrets out of env and
  never add auto-approve flags when this grows a UI affordance (critic review, t_94eef7a1).
