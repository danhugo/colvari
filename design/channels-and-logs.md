# Chat channels & log scope (t_8d3d6989)

## Problem
One global chat and one global log mix every team and project. The human has to scroll through everything to find what matters.

## Chat: channels
- **Sidebar channel list**: `# all` (cross-team: human broadcasts, manager↔manager, escalations), then `# <team>` per team, grouped under a project header when there is more than one project.
- A message is routed to a team channel if both sender and recipient belong to that team. Otherwise it goes to `# all`. Messages to or from the human are also mirrored to `# all`.
- **DMs**: an agent↔agent thread shows up in the team channel as a collapsed thread, not as a separate channel.
- Each channel has an unread badge and a highlight for @human / ask_human messages. The human can filter by `mentions me`.
- **History**: render the latest 50 messages, lazy-load 50 more when scrolled to the top (keep the scroll position), and show a "Jump to latest" pill.

## Logs: scoped
- The filter bar is a breadcrumb: Project › Team › Agent › Session (task run). The default scope follows the current selection (the team or agent selected on the board).
- Sessions are one entry per agent run (task id, start/end, status, cost). Clicking one shows only that run's log.
- Level chips: errors/warnings/tool calls/all. The default is "important" (errors, status changes, ask_human).
- "Cross-team" view = the current global stream, kept but not the default.

## Acceptance criteria (for Uma)
1. Chat sidebar lists `all` plus one channel per team. Selecting a channel shows only the messages routed to it.
2. Opening a chat renders ≤50 messages. Scrolling to the top loads older messages without jumping.
3. The log view defaults to the selected team/agent. The breadcrumb can widen the scope to all.
4. The log session list per agent can be clicked and filters to one run.
5. Unread and @human badges appear per channel.
