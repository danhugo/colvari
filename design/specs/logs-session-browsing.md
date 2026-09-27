# Logs & session browsing — spec (t_13b1b001)

## Problem (seen at 1280x800 with 8+ agents)
- `#tab-obs` renders `#budgetbar` + `#agenttable` (a copy of Usage) ABOVE the log; with many agents the table fills the screen and the log shows 1 line.
- The tab is fixed height and the page doesn't scroll; `.loglist {flex:1}` has no flex parent with `min-height:0`, so it never gets any space.
- `#msglist` is stuck under the log with max-height 200px, so it also takes space away.
- There is no way to read ONE agent's session (a conversation: prompt → thinking/text → tool call → result).
- Our own mock (design/shots/after-fix-logs-light.png) was only checked with 8 rows, so it hid the problem.

## Layout (Logs tab = two panes, full height)
```
┌ toolbar: [Agent ▾] [Session ▾] level chips  search  auto-scroll  Copy Export Clear ┐
├───────────────┬────────────────────────────────────────────────────────────────────┤
│ SESSIONS 240px│ Session header: avatar Name · task title · started 10:02 · 4m · $0.03 · status │
│ ● Nova  run#7 │ ─────────────────────────────────────────────────────────────────  │
│   Prototype.. │ ▸ Prompt (collapsed, 2 lines + "show all")                          │
│   2m · live   │ Assistant text (full-width, readable body font)                     │
│ ○ Leo  run#3  │ ▸ tool: write_file(design/...)  → ok     (collapsed, 1 line)        │
│ ...scrolls    │ ✕ tool_error (red, expanded by default)                             │
│               │ ...scrolls independently; "Jump to latest ↓" pill when not at bottom│
└───────────────┴────────────────────────────────────────────────────────────────────┘
```
- The page never scrolls; each pane scrolls on its own. The log area takes ≥ 70% of the window height at 1280x800.
- "All agents / All sessions" = the current combined stream (one row per line, same as today) in the right pane.
- Picking an agent in the sidebar or Overview opens Logs with that agent's latest session selected (deep link).
- Remove the agent table from Logs (Usage already has it). Budget bar → a single line chip in the toolbar. Agent messages → the Chat view, or a collapsible "Messages" section at the bottom of the session list, closed by default.
- Session list: grouped by agent, newest first, shows live/done/error dot, task title, duration, and the number of lines. Can be filtered by the Agent dropdown.
- Long lines wrap (no horizontal scroll); tool payloads over 3 lines are collapsed.
- Empty states: no sessions → "No activity yet — run the team"; filter has no match → "No lines match" + clear button.

## Realistic data rule (for all screens)
Screenshots must be taken at 1280x800 AND 1440x900 using seed data: 12 agents, 3000+ log lines, 30 sessions, 25 wiki pages. Wiki also needs a page list, search, and an empty state (see human comment).
