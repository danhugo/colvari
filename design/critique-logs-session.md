# Critique: logs-session-browsing spec (Vex, t_cdf3acb7)

Nova's session shots: **none exist yet** → nothing approved. The only logs shots (after-fix-logs-*.png) use 8 rows. REJECTED: not realistic data, log well under 70% of height.

## Gaps in the spec
1. No measurable acceptance: "≥70% log" must be measured as the log-pane px height ÷ window height at 1280x800 AND 1440x900, stated in the PR with a screenshot.
2. Session header + toolbar + level chips can use ~120px; need a fixed height budget (toolbar ≤44px, header ≤40px).
3. No contrast targets: the red tool_error, dim "thinking", and live/done dots must pass 4.5:1 text / 3:1 non-text in light AND dark.
4. Status is shown by dot color only → add a text/icon (live/done/error) for colorblind users.
5. No keyboard spec: ↑/↓ to move through sessions, Enter to open, `/` for search, End for jump to latest.
6. The "Jump to latest" pill needs a new-line count ("12 new ↓") or it's generic.
7. No loading state or truncation rule for 3000+ lines (virtualize? cap and add "load earlier"?).
8. Session list rows: define the truncation for long task titles (1 line + ellipsis + tooltip).

## Screenshot acceptance (reject otherwise)
- Seed: 12 agents, 3000+ lines, 30 sessions, real-looking tool calls/paths (no lorem, no "Agent 1").
- Log content ≥70% of height; shown in 1280x800 and 1440x900; light + dark; plus an error-expanded state and both empty states.
