# UX research notes

## Nav + filter chips (t_f56080f3)

**Problem.** Sidebar nav's "active" state and the log-level filter chips
both signalled selection with colour/shadow alone, on backgrounds that are
already near-white in light mode — before/after evidence in
`design/screenshots/before-nav-chips-*.png` vs `after-nav-chips-*.png`.
Grayscale-testing the before shots (NN/g's own diagnostic, see below) makes
the "Overview" tab and the INFO/WARN/ERROR chips visually indistinguishable
from their idle neighbours.

**Pattern applied.**
- **Selected nav state = filled chip, not underline/colour-only.** Browser
  default underlines and colour-only actives read as "generic" and fail at
  a glance; a filled background + border (`--accent-soft` fill, `--accent`
  border, `--accent-text` label) reads as selected even in grayscale. Same
  approach Linear, Raycast and Arc use for their sidebar/tab rails — filled
  pill or side-accent, never an underline, and never colour as the only cue.
- **Mono-weight icon set.** Swapped the one stray emoji (⚙ Settings) and
  added a consistent 14px stroke-icon (1.6px stroke, `currentColor`) per
  nav item instead of mixing emoji with text-only tabs — emoji render
  inconsistently across OS/font stacks and clash with a token-driven design
  system; a single icon family reads as one product.
- **On/off chips need a second channel besides colour.** NN/g: "don't rely
  on color alone" — provide a redundant cue (shape, icon, pattern) for
  anyone with low colour vision, and as a forcing function for reading
  clarity at a glance. Applied: `.lvchip.on` now gets a solid fill *and* a
  `✓` mark (`.ck` span, hidden until `.on`); off state is an outline pill
  with muted text. Verified pre-existing CSS already scaffolded this
  (`app/renderer/style.css:386-392`) but the checkmark markup was never
  wired into the renderer (`app.js`) — a case of two chip implementations
  layered on top of each other (`app/renderer/style.css` had a dead first
  `.lvchip` block using colour-only fill, removed).

**Why this generalizes.** Redundant coding (fill + icon, not colour alone)
and non-underline "selected" chips are the two most common must-fix items
across the critique passes so far (`design/critique-views.md` #10-11,
`design/critique-logs-session.md`) — worth checking for the same
colour-only pattern anywhere else chips/toggles appear (task board columns,
presence pills).

Sources:
- [5 Visual Treatments that Improve Accessibility – NN/g](https://www.nngroup.com/articles/visual-treatments-accessibility/)
- [Error-Message Guidelines – NN/g](https://www.nngroup.com/articles/error-message-guidelines/) (redundant icon + colour pattern for status cues)
