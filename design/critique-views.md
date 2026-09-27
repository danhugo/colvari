# Critique: Overview / Logs / Wiki direction + prototypes (Vex)
Evidence: Nova's `design/shots/after-{overview,logs,wiki}-{dark,light}.png` (t_f83719af). Leo's audit is at `design/research/views-audit.md` (t_524ded0f). Tokens are in `design/tokens.css`.

## Verdict
Logs is a big improvement. The Overview graph still reads as a generic dotted-canvas node editor: 5 agents fill about 30% of the canvas, and nothing in the shots proves the design scales. There is **no timeline shot at all**, so its usefulness is unproven.

## Must-fix
1. **Edge contrast fails.** `--border-strong` dark is `#333a48` on the canvas, about 1.4:1. That is far below the WCAG 1.4.11 minimum of 3:1 for non-text graphics. In the dark shot, edges are barely visible and **no arrowheads can be seen**. Fix: add an `--edge` token of at least 3:1 (dark ≈ `#6b7285`, light ≈ `#8a90a0`) and an 8px arrowhead.
2. **No 20+ agent evidence.** Demand a shot with 24 agents across 4 teams at 1440×900. Rules: fit-to-view must keep names ≥11px on screen, or fall back to LOD (collapsing teams into a single frame with a count and a status summary). Orthogonal edge routing is required; the diagonal crossings already visible at 5 nodes (Mira↔Vex, Leo↔Nova) will turn into spaghetti.
3. **The minimap is shown when the graph fits.** This breaks the doc's own ">150% viewport" rule. Hide it.
4. **Fit-to-view isn't applied.** The graph sits top-left with about 65% of the canvas empty. Centre it and scale it up.
5. **Timeline has no prototype or shot.** It must answer one question: "who is blocked or waiting on me right now?" Requirements: the waiting-for-human hatch plus a lane-label badge, and default sorting of lanes by "needs attention". If it can't beat the sidebar status list at that job, cut it to a sparkline in the node chip.
6. **Logs vs Chat duplication.** The prototype's rows are tool calls (`read_wiki`, `write_file`) and these already appear as tool rows in Chat and in the task thread. Logs must be positioned as the *raw/debug* stream: default filter = warn+error only, with info behind a toggle. Chat and the thread keep the human-readable story. Any row that has a task must deep-link into the thread and must not repeat the thread's content.
7. **Logs task column shows raw ids** (`t_f83719af`), which are meaningless to users. Show the truncated task title, with the id in the tooltip.
8. **The "↓ 3 new" pill appears while already at the tail**, floating over empty space. Show it only when the user has scrolled up.
9. **The `×3` group badge sits in the Agent column.** It belongs at the end of the message.
10. **Sidebar nav uses browser-default underlines + emoji icons** (all views). This looks generic and inconsistent with the token system. Use a mono-weight icon set and remove the underline.
11. **Level filter selected state is ambiguous.** It's unclear whether info/warn/error are on or off. Use filled chips with a check, not just colour.

## Nice-to-have
- Node chips: "Blocked by Leo, Nova" deserves an amber state, not the same grey chip as "Idle".
- Wiki: add backlinks ("linked from tasks"), per Leo's benchmark.
