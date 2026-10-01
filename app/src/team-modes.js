// Team view modes (wiki decision-one-team-view): Team is the single graph screen with two modes —
// Watch (read-only, the default whenever any agent is running) and Edit (an explicit toggle).
// Pure: shared by the renderer's graph/inspector gating and the unit tests.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.TeamModes = factory(); })(this, function () {
  // Watch is the default whenever any agent is running; an explicit user choice always wins —
  // no auto-return to Watch (surprising, per the decision page).
  function resolveMode(pref, running) { return pref || (running ? 'watch' : 'edit'); }

  // What the current mode allows on the graph. Watch disables every mutation: drag, connect,
  // delete, rename — and add/layout, which also write structure/positions. `menu` gates the
  // editing context menus (Watch keeps a read-only one with just "Open in Chat").
  function can(mode) {
    const ed = mode === 'edit';
    return { drag: ed, connect: ed, del: ed, rename: ed, add: ed, layout: ed, menu: ed };
  }

  return { resolveMode, can };
});
