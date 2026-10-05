# The usage ledger: per-account-key cost and token tracking

Every agent run's usage is recorded per **account key `{runtime, provider, model}`**
(t_3318ff63). The invariant that shapes everything: tokens are **never summed across
keys** — opus tokens are not glm tokens — so every breakdown carries the four token
types (input, output, cache read, cache creation) separately, and only **cost** gets a
grand total. A grand total is flagged `costPartial` when any contributing row has
unknown cost.

This page describes the ledger's data model and flow; `README.md` ("Usage & billing")
covers the user-facing behavior.

## Where the data lives

Run records live in `runs.json` of each project store. Each run carries `ledger: [...]`
— the **persisted per-model split**, built once at run end by `finishRun` → `buildLedger`
(`src/usage.js`). The internal accumulators (`perModel`, `flatSeen`) are deleted at that
point; the ledger array is the split from then on.

One ledger entry:

```
{ runtime, provider, model,
  inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
  costUsd, costSource, billed }
```

**Unknown ≠ 0.** A token field the CLI never reported stays `null` in the entry (the
`seen` list records which fields the CLI actually reported); a cache column with no
contributing run stays `null` in the aggregate. Unknown cost is `null` with
`costSource: 'unknown'` — never `$0`, never a guessed number.

Claude reports real per-model usage (`result.modelUsage`, one entry per model,
including sub-agents); runtimes without per-model reporting (codex, profile CLIs)
produce a single entry from the flat totals.

## Key normalization

Three helpers decide what "the same key" means, applied both when an entry is built
and again at aggregate time (so entries persisted before a normalization fix still
collapse into one row):

- `canonModel` — dated build suffixes (`claude-haiku-4-5-20251001`) and
  context-window variants (`…[1m]`) collapse into the base id; an org prefix
  (`zai/glm-5.2`) moves into a `providerHint`. The CLI's own `canonicalModel` wins
  when present.
- `providerOf` — the **paying account**, not the CLI's label vocabulary.
  Subscription-billed runs collapse to `subscription` (modelUsage says "firstParty",
  the channel fallback says "subscription" — same claude.ai login, one row). An API
  key's "firstParty" label is kept distinct on purpose. Otherwise: the modelUsage
  label, else the proxy host, else the model's org prefix, else the billing channel.
  Two API keys on the same channel share a row by design — CLIs don't distinguish
  them.
- `accountRuntime` — entries from before runs were runtime-stamped attribute to
  `claude` when their model id is `claude-*`; anything else stays an explicit
  `unknown` row instead of being folded into a wrong account.

## Cost resolution

`resolveEntryCost` defines one entry's cost through a strict source priority
(t_6ee6a70b):

1. **reported** — the CLI reported it (nonzero, or a direct-channel $0, which is a
   real reported zero);
2. **proxy** — the proxy's own measured per-request cost, joined from its spend logs
   (`applyProxySpend`; LiteLLM writes spend logs after the run, so the real number
   lands on the persisted record late and replaces estimates / fills unknowns —
   never provider-reported costs, never double-counted, `rec.proxySpend` marks the
   join as applied);
3. **estimated** — the runtime price list (the LiteLLM price JSON cached on disk,
   with user overrides — `litellm.js` PriceBook); `costPartial` when a flowed token
   class has no price;
4. **unknown** — `null`. Honest missing data.

`reportedCostOf` classifies the result event's `total_cost_usd` without collapsing
"absent" into $0; a reported $0 **behind a proxy** means "the proxy had no price for
this model" (`proxyUnpriced`), not a free run.

Per row, cost is defined once (t_f514cc2e): `apiEq` is the API-equivalent $
(reported or list-price estimated, `null` when unknown), `billed` is the part
actually billed per token — **$0 for subscription rows** (covered by the plan; the
zero is known, not missing), else the same value as `apiEq`.

## Aggregation

`usageLedger(runs, { priceBook })` folds persisted runs into
`{ rows, byAgent, byTask, costUsd, apiEq, billed, costPartial }` — one row per
`{runtime, provider, model}` key (sorted), plus the same rows grouped per agent
(`run.agent`) and per task (`run.taskId`). Each row's `costSource` is
`reported | estimated | mixed | unknown`; totals are raw sums of the per-row fields.

`ledgerEntriesOf` feeds it: persisted entries pass through untouched (rows the old
hard-coded price table once marked estimated stay estimated — no recompute), while
pre-ledger stragglers that escaped the migration get a synthesized single entry from
their flat totals, resolved afresh.

The orchestrator exposes the aggregate, memoized on the runs signature, as
`orch.ledger()` in the snapshot (`src/orchestrator.js`), alongside `modelStats` and
`usageSince`. The renderer renders the backend ledger directly for unfiltered views
and re-aggregates client-side with `ledgerFromRuns` (`renderer/app.js`, a mirror of
`usageLedger`) when an agent/task filter is active — both must stay shape-compatible.

## Migration: pre-ledger runs

Runs recorded before the ledger existed carry flat totals that mix models and cannot
be split retroactively. `Store.migrateUsageLedger` (`src/store.js`) drops them once
(migrate-by-reset), guarded by a `.usage-ledger` marker file (the store is
constructed per call, so the scan must run only once) and records
`project.usageTrackingSince` — surfaced as "tracking since" in the UI. Never throws
on old or corrupt files.

## Tests

- `test/usage-ledger.test.js` — key separation, per-agent/per-task grouping,
  subscription `$0` billed semantics, pre-ledger synthesis, the store migration and
  the snapshot shape (no cross-model token totals).
- `test/usage-invariants.test.js` — cross-cutting invariants (no summed cross-model
  tokens, account-row collapse).
- `test/litellm.test.js` — proxy spend join (replace-once semantics).
- `test/runtimes.test.js` — CLI token-field mapping into ledger names
  (`cache_read_input_tokens` → `cacheReadTokens`).
