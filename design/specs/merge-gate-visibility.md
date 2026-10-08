# Spec: visible merge gate + "Only you can unblock" queue (t_ee1dc6c4)

Nova, 2026-10-09. Design-only prototype — **no app code changes in this task**. Implements items 1–2 of
Mira's list in wiki "Colvari vs Paperclip: conclusions" §5. Prototype: `design/prototype.html`
(open in any browser; `?theme=dark`, `?queue=1`, `?view=cards`, `?thread=1` for states). Vex critiques
before any build task starts.

## Part A — the merge gate, visible

The gate already has every state on disk (`app/src/merge-gate.js`); the UI just never shows them:

| State | Source of truth | Chip |
|---|---|---|
| running | `.squad/merge-gate.live.json` → `redMasterSnapshot().gateLive` | `⧗ gate · npm test 4m12s` (accent-soft/accent-text, animated ring, static under reduced-motion) |
| green | gate system comment "npm test green · N tests" | `✓ green · 761 tests` (success-soft/success-text) |
| red | health file via `redMasterSnapshot()` (failing test names) | `✕ 2 failing` (danger-soft/`--danger-text`, expands in chat/board to the named failures) |
| landed | "auto-merged squad/<branch> into master as <sha>" comment + merge sha | `⇥ 4f2a1c9` (mono sha chip) + **trust record** |
| queued | second done-flip waiting on the per-root gate lock | `⋯ queued behind gate` |
| conflict/dirty | `merge_conflict` status / "merge refused: main checkout has uncommitted changes" | `⚠ merge refused: dirty checkout` |

**Never colour alone:** every chip carries an icon (⧗ ✓ ✕ ⇥ ⚑ ⚠) *and* words. Contrast: existing
`--success-text`/`--warning-text`/`--accent-text` pass AA in both themes; danger has no `-text` token, so
the prototype derives `--danger-mix: color-mix(in srgb, var(--danger) 72%, var(--fg-primary))`
(5.9:1 on danger-soft, light; bright variant in dark). **Proposed token addition to tokens.css:
`--danger-text` with exactly that formula.**

### Where it shows

1. **Board card** (`cardHtml`, app.js:2038): gate chip is one more `.ctags` tag — `gate-run`, `gate-red`
   (plus a `P0 fix task` tag when a red master task exists), `gate-landed` (sha). The landed card's meta
   row carries the trust record line: `✓ 761 tests · tree = landed tree · 1 flaky rerun · landed 14:06`.
2. **Chat**: gate system comments render as mono system rows (existing comment stream, styled); a landed
   merge additionally renders a **landed card**: title, `landed` status, sha chip, trust record, and
   actions **Revert** (two-step: Revert → "Confirm revert?" 2.6 s window → toast "Revert queued — git
   revert <sha> · the gate re-verifies master"), Open diff, Gate log. A red gate renders a **red card**:
   failing test names in mono rows (cap 12 = `GATE.MAX_NAMES`), the note "Merge refused — master never
   went red", buttons Failures in Logs / P0 fix task →.
3. **Task thread**: each sub-task row gets a mini gate chip; a **gate trail** block shows the timeline
   (started → green N tests → landed sha) with the same trust record + Revert.

Trust record wording is fixed: *"tests passed: N · tree = landed tree"* (+ flaky rerun count when the
gate's one rerun fired). It is the sentence the README GIF will sell.

## Part B — "Only you can unblock"

One queue, two item kinds, three entrances, zero overlap with the Inbox:

- **Holds:** `ask_human` inbox items (questions, approvals — `S.inbox`) **and** tasks with status
  `waiting_for_human` (incl. `awaitingApproval`). Nothing else. Ever.
- **Entrances:** (1) top-bar `⚑ Unblock N` button beside the avatar stack — warning-soft pill, distinct
  from the alerts bell; (2) sidebar `⚑ Needs you` item *above* Inbox; (3) Chat's "Your turn" bar gains
  `Open the queue (N) →`. It is a drawer (right, over a scrim, Esc closes) — not a new tab.
- **Separation rule:** Inbox keeps messages and FYIs (the Paperclip #923 noise complaint). Badge counts
  are computed independently and will legitimately differ.
- **Row anatomy:** avatar · name · kind chip (`question` accent / `approval` warning / `paused task`
  muted) · age — question text — context line (task, scope, what it blocks) — inline quick actions
  (choices / Approve+Deny / Resume+Open task) · `Open in Chat →` deep link to the ask bubble or task.
- **Answering anywhere answers everywhere:** the queue, the Your-turn bar and all badges share one
  pending count; answering collapses the row to "✓ answered" and decrements every surface.
- **Empty state:** "Nobody is waiting — the squad is unblocked."
- **Future-proofing:** the drawer is the single surface a remote unblock (phone push) would feed; the
  footer says so now so the mental model lands before the feature does.

## Acceptance criteria (for the eventual build task)

1. Board card shows the live gate chip for running/green/red/landed/queued/conflict, sourced from
   `redMasterSnapshot()` + gate comments — no polling of files from the renderer beyond what exists.
2. Red card lists failing test names; landed card shows sha + trust record; Revert is two-step with a
   toast and is wired to a real revert op (backend op may be added by Core).
3. Gate chips pass AA in both themes, work under `prefers-reduced-motion`, and never rely on colour
   alone.
4. Unblock queue opens from top bar, sidebar and Chat; holds only ask_human + waiting_for_human items;
   Inbox badge unchanged; counts stay in sync; Esc/scrim closes; keyboard-reachable, `role="dialog"`.
5. gui-e2e: chat asserts chip text ("gate · npm test", "✕ N failing", "⇥ <sha>"), queue badge counts,
   and that the Inbox badge excludes queue items.

Shots (design/screenshots/gate-queue/, untracked): chat / queue / task-cards × light/dark.
Script: `node design/scripts/shot-gate-queue.mjs`.
