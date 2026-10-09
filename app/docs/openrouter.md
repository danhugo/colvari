# Running Colvari agents on OpenRouter models

Configure an OpenRouter provider in Settings > Providers (id: `openrouter`,
`https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`, kind `openrouter`). The API key
lives in the env var named by `keyEnv` — never in settings JSON, argv, logs or run
records (`agent-config.js:127-129`, `main.js:1207`).

---

## Codex (runtime `codex`)

| Property | Detail |
|---|---|
| **API key source** | `OPENROUTER_API_KEY` (the profile's `keyEnv`) — copied into the child env by `applyProviderEnv` (`usage.js:37-44`); codex receives the env var name via `-c model_providers.<id>.env_key=<keyEnv>` (`runtimes.js:182`) |
| **Model id format** | Raw model slug, e.g. `openai/gpt-4o` — passed as `-m <model>` (`runtimes.js:122`). The provider profile routes it to OpenRouter. |
| **Provider profile flags** | `-c model_provider=<id>` + `-c model_providers.<id>.name=...` + wire_api set to `"responses"` for OpenRouter (`runtimes.js:177-184`). No `env_key` means no key env var — kind `openrouter` requires it (`agent-config.js:147`). |
| **Cost in Usage** | Codex capabilities say `cost: false` (`runtimes.js:117`) — it does not emit a per-run `total_cost_usd`. Cost is therefore *estimated* via `PriceBook.estimate` (`usage.js:114-130`, `litellm.js:235-246`) from LiteLLM's published price list, or `unknown` when the model has no price entry. |
| **Known limits** | No per-model usage split from the CLI; a single flat ledger entry is synthesized from the total token count. Wire API responses mode is proven on codex 0.144.6 (`runtimes.js:126`). |

---

## OpenCode (runtime `opencode`)

| Property | Detail |
|---|---|
| **API key source** | The profile's `keyEnv` env var, interpolated as `{env:<keyEnv>}` in the per-run config file's `provider` section (`runtimes.js:215`). The env var itself must reach the child — `applyProviderEnv` copies it from the parent env (`usage.js:37-44`). |
| **Model id format** | `openrouter/<vendor>/<model>`, e.g. `openrouter/openai/gpt-4o`. `providerModelArg` (line 202-205) prepends the provider id: `-m openrouter/openai/gpt-4o`. The provider prefix is part of the canonical model identity and is kept in the ledger key (`usage.js:303-304`). |
| **Provider profile** | Per-run config file `provider` section with npm package `@ai-sdk/openrouter-compatible` (`runtimes.js:213`) and `baseURL` from the profile's `baseUrl`. When the provider uses the standard OpenRouter base URL, no section is written (the CLI already knows it) (`runtimes.js:209-211`). |
| **Cost in Usage** | OpenCode reports cost live via the `step_finish:part.cost` event path (`runtimes.js:16` `OPENCODE_EVENTS.costPath`). Parsed by `parseProfileEvent` (line 351-358): cost is read from the profile-mapped event, and the run tracks it as the reported cost. A `$0` cost behind a proxy is flagged `proxyUnpriced` (`usage.js:103-111`). When absent/unparseable, cost is `unknown` — never `$0`. |
| **Known limits** | Probe runs need a real model call (no provider key → only an error event). OpenCode's own profile is derived generically like any other CLI via `profileRuntime` (`runtimes.js:139`). |

---

## Pi (runtime `pi`)

| Property | Detail |
|---|---|
| **API key source** | `--provider <id>` selects the profile; the key env var (named by `keyEnv`) reaches the child via `applyProviderEnv` (`runtimes.js:150-152`, `usage.js:37-44`). |
| **Model id format** | Raw model slug, e.g. `deepseek/deepseek-r1` — passed as `--model <model>` (`runtimes.js:149`). |
| **Cost in Usage** | Pi reports cost on `message_end` events via `message.usage.cost.total` (`runtimes.js:244`). Proven against the live 0.73.1 stream through OpenRouter (`runtimes.js:145` `test/fixtures/probe-pi-live.jsonl`). |
| **Known limits** | No MCP support (`capabilities.mcp: false`, `runtimes.js:145`). No per-model usage split (a single flat entry from totals). Models whose provider id matches the OpenRouter provider id on the node see the provider profile applied (line 152). |

---

## General notes

- **API keys never appear in settings** — only the *name* of the env var (`keyEnv`).
  The key flows env → child env → provider, never through files or logs
  (`agent-config.js:127-129`, `usage.js:33-36`).
- **Cost provenance** is shown in the Usage UI: `reported` when the CLI returned a
  real number, `estimated` when derived from the PriceBook, `proxy` when the proxy's
  own per-request spend logs supplied it, and `unknown` when nothing is available
  (`usage.js:119-130`).
- **OpenRouter's standard base URL** (`https://openrouter.ai/api/v1`) is recognised
  in `runtimes.js` (line 194) and skips the provider config section for CLIs that
  already know it (openCode: `runtimes.js:209-211`; codex uses its own provider
  profile flags regardless).