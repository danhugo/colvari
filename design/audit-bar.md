# Design audit bar

**Design sign-off requires real-app, real-data screenshots of Chat first, in both light and dark.**

Prototype and seeded-fixture shots (e.g. `screenshots/identity/round3/*/chat*.png`) use short, clean
messages and hid real Chat failures (t_h0a1c2e3): raw markdown (`**`, backticks, `- ` lists) in agent
messages, an accent-coloured task link cut at 40 chars mid-word and wrapped into every line, and an
invisible system avatar glyph in dark mode.

Before any theme/token/layout change is called done:

1. `node design/scripts/shot-real-chat.mjs` launches the real Electron app on a temp copy of
   `~/.agents-squad` (the original is never touched; `AGENTS_SQUAD_DEV=0` means no agents start). It writes
   Chat/Overview/Board/Logs x light/dark at 1440x900 to `design/screenshots/real/`.
2. Look at `chat-light.png` and `chat-dark.png` yourself first: long messages, code, tool chips, questions,
   errors, and thread links must all be readable.
3. Only then compare against prototype shots. Fixture shots support the review but can't replace this step.
