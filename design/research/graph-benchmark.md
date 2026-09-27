# Graph editor UX benchmark — React Flow, n8n, Figma (FigJam), Miro, Node-RED

Scope: patterns for the Agents Squad team graph (nodes = agents, groups = teams, edges = manage/review/message relations).
Sources: reactflow.dev (docs/examples: Handles, Edge types, MiniMap, Controls, NodeToolbar, Sub-flows, Dagre/ELK layout), docs.n8n.io (Editor UI, node creator, NDV), help.figma.com (FigJam connectors, sections), help.miro.com (connection lines, frames), nodered.org/docs/user-guide/editor (wiring, groups, link nodes).

| Area | Pattern | Source | Recommendation |
|---|---|---|---|
| Connect | Drag from a visible handle; valid targets highlight, invalid dim; drop on empty canvas opens node picker | React Flow (`isValidConnection`, onConnectEnd), n8n (drop → node creator) | Handles appear on hover (right=out, left=in). Validate (no self/duplicate manage edges). Drop on empty → "Add agent here" picker. |
| Edge type pick | Type chosen after connect via small popover or toolbar; FigJam/Miro edit line style on selection | FigJam connector toolbar, Miro line menu | After drop, show 3-choice popover: **manages / reviews / messages**, default = last used. Change later from edge toolbar. |
| Node anatomy | Icon + title + subtitle, status strip, ports; n8n shows run count/error badge on node | n8n, Node-RED (status dot + text under node) | Card 200×64: avatar, name, role; status dot (idle/working/blocked) + task count badge; Node-RED-style one-line status under card. |
| Edge routing | Smoothstep/bezier choice; labels at midpoint; animated edges for live flow | React Flow edge types + `animated`, EdgeLabelRenderer | Smoothstep for hierarchy (manages), dashed bezier for reviews, dotted for messages. Animate only while a message is in flight. Label only on hover/select to cut noise. |
| Parallel edges | Mostly unhandled (overlap); React Flow custom edges offset | React Flow custom edge examples | Merge A↔B relations into one edge with stacked chips ("manages · reviews"); avoids overlap entirely. |
| Zoom/pan | Scroll=pan, ⌘/pinch=zoom (Figma); space-drag pan; fit view (⇧1) | Figma, React Flow Controls | Trackpad-native: two-finger pan, pinch zoom, ⇧1 fit, ⇧2 zoom to selection; zoom-% control bottom-left. |
| Minimap | Corner minimap, click/drag to navigate, nodes coloured by type | React Flow MiniMap, Miro | Show minimap only when graph exceeds viewport; nodes tinted by team colour. |
| Auto-layout | "Tidy up" button (n8n 1.x), dagre/ELK layered | n8n tidy up, React Flow dagre/ELK examples | One "Tidy" action: layered top-down by manages edges, teams packed as blocks. Animate positions 200ms. Never auto-move after manual drag. |
| Grouping | Frames/sections contain & move children (Figma sections, Miro frames); Node-RED groups with label + colour; React Flow sub-flows (`parentId`) | Figma, Miro, Node-RED, React Flow | Team = labelled tinted container; drag agent in/out to reassign (confirm toast with undo). Collapse team to a single chip showing member count. |
| Cross-team edges | Node-RED link nodes (virtual wires) avoid spaghetti | Node-RED link in/out | Cross-team edges render to container border; when collapsed, aggregate into one edge with count. Toggle "show cross-team links". |
| Context menu | Right-click node: rename, duplicate, delete, disable; canvas: add, paste, tidy | n8n, Node-RED, Figma | Node: Open chat, Assign task, Edit role, Move to team ▸, Delete. Canvas: Add agent, Add team, Tidy, Fit. Every item shows its shortcut. |
| Quick actions | Floating toolbar above selection (NodeToolbar, FigJam) ; Tab/`/` opens insert search (n8n Tab, Figma quick actions ⌘/) | React Flow NodeToolbar, n8n, Figma | Selection toolbar: chat, task, connect, delete. `Tab`/`N` opens agent-template search at cursor. |
| Inspector | n8n NDV = modal with input/params/output; Figma = persistent right panel contextual to selection | n8n, Figma | Use Figma-style right panel (non-modal, 320px): Identity, Role/instructions, Relations list (editable), Current task. Empty selection → team summary. |
| Feedback | Undo for everything, multi-select marquee, snap-to-grid | All five | ⌘Z/⇧⌘Z for all graph edits, shift-drag marquee, 8px snap. |

## Top 5 to build first
1. Hover handles + post-drop edge-type popover.
2. Merged parallel edges with relation chips.
3. Team containers with collapse + aggregated cross-team edges.
4. Non-modal right inspector.
5. "Tidy" auto-layout + ⇧1 fit, minimap only when needed.
