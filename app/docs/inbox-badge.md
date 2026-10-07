# Inbox badge

The red count chip on the sidebar **Inbox** button (`#inbox-tab-badge`,
`app/renderer/index.html:35`) shows how many items are waiting for the human:
questions and approvals from agents (`ask_human` replies, task approvals, team
change approvals). It is always-visible chrome — it tracks the live inbox count
even while another tab is active.

## How it renders

`renderInboxBadge()` in `app/renderer/app.js` (~line 146) sets the badge text
from `S.inbox` (the open items loaded by every `refresh()`):

```js
$('#inbox-tab-badge').textContent = (S.inbox || []).length ? String(S.inbox.length) : '';
```

Key properties:

- **Drawn on every render**, not only when the Inbox tab is shown. It is called
  from `renderChrome()`, which `renderAll()` runs on every state push. (Earlier
  the update was inlined in `renderInbox()`, which left the badge stale whenever
  an item landed while another tab was active — the bug the `renderChrome`
  extraction fixed, t_8d586961.)
- **Hides itself when empty**: writing `''` (not `'0'`) lets the CSS rule
  `.badge:empty { display:none; }` (`app/renderer/style.css:177`, restyled for
  the sidebar at `style.css:941`) collapse the chip. There is never a visible
  "0" badge.
- **Never renders "undefined"**: a missing `S.inbox` state falls through to `''`.

## Where the count comes from

- Renderer: `S.inbox` is refreshed via the `listInbox` IPC (`src/main.js:2968`),
  which returns open items only (`store.listInbox({ status: 'open' })`).
- Main process: inbox items live in `<project dir>/inbox.json` (`src/store.js`).
  MCP servers (agents) write it from their own processes, so the app polls for
  new open items (`src/main.js:3013`) and pushes `inbox` deltas to the renderer
  (`src/delta-pump.js:61`).

## Perf instrumentation

The badge write is timed and recorded in `window.__perf.inboxBadge`
(`{ samples: [last 120 durations in ms], slow: <count>, SLOW_MS: 2 }`,
t_f6b343a5). Nothing is logged unless a single call exceeds `SLOW_MS` (2 ms) —
then it emits one `console.debug('inbox badge render slow', ...)`. It is a
single `textContent` assignment, so the write itself is flat O(1); the cost that
grows with inbox size lives in `refresh()` (the `getAll`/`listInbox` IPC +
JSON), never in the badge chrome.

## Tests

- `app/test/inbox-badge-wiring.test.js` — runs the real `renderInboxBadge`
  block against a minimal DOM stub (count, empty→`''`, missing state→`''`) and
  asserts `renderChrome()` still calls it (the stale-badge regression guard).
- `app/test/perf/inbox-badge.js` — Electron GUI perf profile: boots the real
  app in GUI test mode on a throwaway temp project, seeds open items in one
  batched write per scale through a second disk-backed `Store` instance (same
  `withLock` path the board MCP uses), and times badge / `renderAll` /
  `refresh` at 50/500/5000 items. Writes `RESULTS.md` + `raw.json` to
  `test/perf/results/inbox-badge-479/`.
- `app/src/main.js` gui-e2e suites assert badge text end to end: ask_human
  (`badge 1`, then `''` after answering, lines ~446–463) and the dynamic-team
  recruit ask/approve/decline flows (lines ~2321–2358).
