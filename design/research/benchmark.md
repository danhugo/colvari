# UI Research: Benchmark — chat/agent product UIs

Author: Leo (UX Research) · 2026-09-27 · Task t_f952ece9
The notes below come from public product docs and design posts (sources at the end) and from auditing our shots 17–20 (`app/e2e-shots/`).

## 1. Product patterns

| Product | Layout | Density | Agent activity / status | What makes it feel alive |
|---|---|---|---|---|
| **Slack** | Workspace rail → channel sidebar → message pane → thread flyout on the right | Compact mode puts one line per message. Consecutive messages from the same author collapse under one avatar. | Presence dots on avatars, "X is typing…", unread bolding with mention badges, Huddle pill | Typing indicators, emoji reactions appearing live, the unread divider line ("New") |
| **Discord** | Server rail → channels → chat → member list grouped by role/status | High density; messages from the same author within 7 min collapse into a group | Status ring on avatar (online/idle/DND/streaming), "Playing…" activity line, voice speaking ring | Speaking-ring pulse, animated avatars, live member list |
| **Linear** | One sidebar (Inbox, My issues, Teams) and a list or board, with a detail pane | Very dense rows, 13px type, monochrome palette with a single accent colour | Status icons as small shapes (circle → half → check), cycle progress rings, agent "delegate" shows as an assignee | ~150ms transitions, Cmd-K for everything, optimistic updates, subtle LCH colour themes |
| **ChatGPT / Claude.ai** | Collapsible history sidebar, a single centred column (max about 720px), and a composer pinned to the bottom | Low density with a lot of whitespace | Streaming tokens. "Thinking…" and tool steps sit in a collapsible block with elapsed time. Claude shows artifacts in a right-side panel. | Token streaming, a shimmer on the "Thinking" label, the Claude "spark" animation while working |
| **Cursor / Claude Code desktop** | Editor or diff in the centre and an agent panel on the side; background agents appear in a list | Medium density. Tool calls show as one-line rows: icon + verb + target + result count. | Each tool row moves from a spinner to a check. Diffs show as +/- counts. A "Generating…" footer has a Stop button. A to-do checklist ticks off as the agent works. | Rows animate in, and the checklist makes progress readable at a glance |
| **Devin / Conductor / Vibe Kanban** | A board or list of agent sessions (one per task or worktree), each with a chat, a live shell/browser and a diff | Cards show status, branch and diff stats | Per-session status chips (running / waiting for you / done). "Needs input" is shown loudly. There is a timeline of steps. | Per-agent live previews and a clear "your turn" state |
| **Raycast / Arc** | Command palette as the primary UI; Arc has a vertical tab sidebar with spaces coloured by gradient | Keyboard-first, large hit rows | The selected row is highlighted, and there is inline progress in the palette footer | Spring motion, colourful gradient spaces, an empty state with a personality |

### Cross-cutting patterns worth stealing
1. **Group by author:** show one avatar and name, then stack messages under it until the author changes or a time gap passes (Slack/Discord).
2. **Tool calls as quiet one-line rows** (icon, verb, target, status), collapsed by default and expandable on click. They should not look like buttons (Cursor/Claude).
3. **A live status ring on each agent's avatar** (working = animated ring in the accent colour, waiting for human = amber, idle = grey, error = red), used everywhere the avatar appears (Discord).
4. **"Working" indicator:** a shimmer label such as "Devon is editing app.js… 12s" at the bottom of the stream (Claude/Slack typing).
5. **"Your turn" priority:** show pending questions in a sticky banner above the composer, not only inline (Devin/Conductor).
6. **One accent colour on a neutral palette**, with status colours reserved for status (Linear).
7. **Cmd-K palette** for navigation and actions, which replaces rows of buttons (Linear/Raycast).
8. **Motion budget:** 120–200ms ease-out, with message fade/slide-in at 4px (Linear).
9. **Empty states that teach:** an illustration or emoji, one sentence and one primary action (Arc/Linear).
10. **Unread divider plus jump-to-latest pill** (Slack).

## 2. Audit — top 10 pain points in our current screens (shots 17–20)
1. **The light chrome and the dark chat clash.** The top bar and sidebar are white, the chat is near-black, and the result feels like two apps. Pick one theme.
2. **The top nav is overloaded.** It has 9 tabs, 3 stat pills, a goal input, Run/Stop and "?" on one row with no hierarchy. Move the stats into a footer or status bar and the goal into the composer.
3. **The sidebar is a wall of admin buttons.** Rename, Delete, Duplicate, Export and Import sit where the channels and agents list should be. Move them into ⋯ menus.
4. **There is no list of agents or presence.** You can't see who is working, waiting or idle without reading the log. Add a member list with status rings.
5. **The "↳ Chat demo" task link repeats on every line.** It is noisy. Show it once per group, or as a thread header.
6. **Tool calls are too loud.** The raw JSON block (`Read {"file_path":…} → 587 lines`) looks like a debug dump. Collapse it to a single row that expands on click.
7. **Avatars are all the same mustard colour with just an initial.** Give each agent a distinct hue and a role icon.
8. **The question card is duplicated** inline, in the thread and in a toast, and its magenta border fights with the blue buttons. Show one sticky "needs you" banner and use amber for "waiting" consistently.
9. **The Answer and Send buttons are inconsistent.** One is white-outlined and one is blue, and they differ in size and radius. There is no shared button scale.
10. **Nothing moves.** There is no streaming, typing or working animation, and no empty state for a quiet #company room or an empty right pane (the dead black column in shot 17). The app feels static even while agents run.

## 3. Recommendations for Nova/Mira (priority order)
P0: a single dark theme with tokens · status rings on avatars and an agent list · collapsible tool rows · a sticky "needs you" banner.
P1: grouping by author · a cleaner top bar (tabs + ⌘K) · consistent buttons · a working shimmer.
P2: empty states · unread divider · motion polish.

## Sources
- Slack design: https://slack.design/ · Compact mode and threads: https://slack.com/help/articles/115000759403
- Discord message grouping and status: https://support.discord.com/hc/en-us/articles/227779547
- Linear UI redesign: https://linear.app/now/how-we-redesigned-the-linear-ui · Method: https://linear.app/method
- Claude artifacts: https://www.anthropic.com/news/artifacts · ChatGPT UI: https://chatgpt.com
- Cursor agent: https://docs.cursor.com/agent · Background agents: https://docs.cursor.com/background-agent
- Devin: https://docs.devin.ai · Conductor: https://conductor.build · Vibe Kanban: https://github.com/BloopAI/vibe-kanban
- Raycast: https://www.raycast.com · Arc: https://arc.net
