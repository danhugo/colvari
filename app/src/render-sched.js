// Event-driven draw scheduler (t_e116438b): decides WHEN a heavy view may redraw so the
// renderer keeps no fixed render timers. A draw happens only when an event bumps an epoch
// counter — an O(1) staleness check that replaced per-call signatures over the whole data
// (Chat.feedKey was a JSON.stringify over every log/task/message/agent, rebuilt every second).
// Draws are coalesced to at most one per minMs while events burst (the trailing edge always
// lands the last epoch), and nothing is armed while the window is hidden or the view's gate
// says it is not on screen. No events -> no timer, no work at all.
// Dependency-free and pure so the renderer (script tag) and the node tests share one code path,
// like delta-client.js. now/hidden/gate/timers are injectable for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.RenderSched = api;
})(typeof self !== 'undefined' ? self : this, () => {
  function create({
    minMs = 400,
    now = () => Date.now(),
    hidden = () => false,
    gate = () => true,
    draw = () => {},
    setTimeout: setT = (fn, ms) => setTimeout(fn, ms),
    clearTimeout: clearT = (t) => clearTimeout(t),
  } = {}) {
    let epoch = 0, seen = -1, last = -Infinity, timer = null;
    const arm = () => {
      if (timer || hidden() || !gate()) return; // nothing on screen to draw into: no timer at all
      timer = setT(() => { timer = null; tryDraw(); }, Math.max(0, last + minMs - now()));
    };
    const tryDraw = () => {
      if (timer || hidden() || !gate() || seen === epoch) return;
      if (now() - last < minMs) return arm(); // mid-burst: defer, the trailing edge lands it
      seen = epoch; last = now(); draw();
    };
    return {
      bump() { epoch++; arm(); }, // an event arrived: arm a coalesced draw (no-op while hidden)
      force() { // a view-state change the user made: draw now, bypassing the rate limit
        epoch++; seen = -1;
        if (hidden() || !gate()) return; // defer — the next event/activation still sees the bump
        seen = epoch; last = now(); draw();
      },
      drawIfCurrent: tryDraw, // free when current; the guarded entry point for renders
      hide() { if (timer) { clearT(timer); timer = null; } }, // window hidden: drop the pending draw
      isPending: () => !!timer,
    };
  }
  return { create };
});
