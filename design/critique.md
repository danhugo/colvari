# Design Critique: chat redesign (Vex, t_46c370c7)

Evidence: `design/shots/after-dark.png`, `after-light.png`, `tokens.css`, `research/benchmark.md`. I calculated the contrast ratios below with the WCAG formula.

## Verdict
The new version is clean and consistent, and it fixes the light-chrome/dark-chat clash. It still reads as **Slack + Linear with the logo swapped out**: the indigo accent, Inter, the purple gradient logo, rounded bubbles. There is nothing yet that says "a team of AI agents is working for you". Density is low: at 2560px only about 4 messages fit on screen.

## Contrast (WCAG AA, body text needs 4.5:1)
| Pair | Ratio | Result |
|---|---|---|
| light `--fg-muted` #7d8394 on app bg | 3.47 | FAIL (timestamps, status text, composer hint) |
| light `--fg-muted` on sidebar | 3.26 | FAIL ("working / idle") |
| light agent names: pink #f25f8f / green #10a37f / orange #f08c1a on bg | 2.83 / 2.93 / 2.27 | FAIL |
| light `--warning` #d98a00 on white | 2.77 | FAIL (inbox badge "1") |
| light `--success` #12a150 on white | 3.37 | FAIL for text |
| `--accent` on `--accent-soft` (@mention chip) | 4.13 | FAIL |
| white on `--bg-bubble-self` | 4.91 | pass |
| dark `--fg-muted` on dark bg | 4.86 | pass |

## Top 5 must-fix
1. **Light-theme contrast.** Darken `--fg-muted` to about #5f6576, and add text-safe variants of the agent colours (`--agent-N-text`, L* ≤ 45) for names. Keep the bright colours for avatars only. Same fix for warning, success and the mention chip.
2. **Status only uses colour and tiny dots.** The presence dot is about 6px, and a green/amber dot is invisible to colour-blind users. Add a shape or motion per state: a spinning ring for working, a "!" badge for needs you, hollow for idle. "needs you" (Leo) should be the loudest thing in the sidebar, not grey text.
3. **Too much padding.** Per-message bubbles, 20px gaps and a 72px header add up to about 4 messages per screen. Drop the bubbles for agent messages (Slack/Linear style: plain text under the name), group consecutive messages, and set a max line length of about 72ch. Target 10+ messages on a 1440p screen.
4. **The ask_human card scrolls away.** Pin pending questions in a sticky "Your turn" bar above the composer (benchmark pattern #5). The inline amber card also looks like just another bubble.
5. **Generic identity and self-message quirks.** The "You" avatar is a text pill, "You" appears twice, and the right-aligned blue bubble makes it look like a messenger app. Use left-aligned human messages with a distinct human marker. Replace the stock purple-gradient ✦ logo and the default Inter-plus-indigo look (see bold ideas).

## 3 bold ideas
1. **"Mission control" strip:** a slim live lane at the top with each agent's current tool call streaming as a ticker (`Nova › screenshot ×4 … 12s`). This is the one thing Slack can't do, so it should be the signature.
2. **Agent personalities in the system:** each agent gets a colour plus a glyph/monogram shape (hexagon, circle, diamond) used in avatars, thread rails and task progress, so the room reads like a squad. It also fixes colour-blind access.
3. **Task cards as first-class chat objects:** the "Chat redesign" card becomes a live mini-board (subtask chips flip between states as agents move), and threads open inline as a split pane rather than navigating away.

## Implementability (vanilla JS)
Everything above is CSS tokens plus DOM templates. The spinning status ring is a CSS `conic-gradient` with `@keyframes`, the sticky bar is `position: sticky`, and the ticker is one element updated from existing tool events. No framework is needed. Respect `prefers-reduced-motion`.

### Validation (Leo, UX Research)
Benchmark check: Slack, Discord and Linear have no live view of work in progress. Cursor, Claude desktop, Conductor and Vibe Kanban each show per-agent run state, but only inside one agent's pane. A cross-agent, always-visible live lane is new ground, and it answers the main question users have about an agent squad: "who is doing what right now, and is anything stuck?"
- **#1 Mission-control strip: RECOMMEND TO PROTOTYPE.** It sets us apart from Slack the most, it's cheap (one sticky element fed by existing tool events), and it also covers the "stuck" state (it can show an idle-timer badge). Risk: noise. Mitigate by collapsing to one line per agent, throttling to about 1 update per second, and following prefers-reduced-motion.
- **#2 Agent glyphs:** a real accessibility win (colour plus shape). It's table stakes, not a differentiator, since Discord, Linear and Slack all have strong identity. Ship it as tokens alongside #1.
- **#3 Live task cards:** Linear and Vibe Kanban already have strong boards. It's high value but costs the most (inline split-pane threads). Build it after #1.
