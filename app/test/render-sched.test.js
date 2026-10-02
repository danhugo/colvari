// RenderSched (t_e116438b): the event-driven draw scheduler that replaced the renderer's fixed
// render timers. Covers the coalescing, the burst rate limit with its trailing edge, the epoch
// guard, and the hidden/gate deferrals — the silent-staleness cases a visual regression hides in.
const test = require('node:test');
const assert = require('node:assert');
const RenderSched = require('../src/render-sched');

// Manual clock + timer queue so draws fire deterministically.
function rig() {
  let t = 0, seq = 0;
  const timers = new Map();
  const now = () => t;
  const setT = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + Math.max(0, ms) }); return id; };
  const clearT = (id) => timers.delete(id);
  const fire = () => {
    for (const [id, x] of [...timers.entries()].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)) {
      if (!timers.has(id)) continue; // a handler may have cleared later timers
      timers.delete(id); x.fn();
    }
  };
  const tick = (ms) => { t += ms; fire(); };
  return { now, setT, clearT, tick, pending: () => timers.size };
}

const make = (r, draws, over = {}) => RenderSched.create({
  minMs: 400, now: r.now, setTimeout: r.setT, clearTimeout: r.clearT, draw: () => draws.push(r.now()), ...over,
});

test('bump draws once and coalesces any number of bumps into a single draw', () => {
  const r = rig(); const draws = []; const s = make(r, draws);
  s.bump(); s.bump(); s.bump();
  assert.equal(r.pending(), 1); // one timer, not three
  r.tick(1);
  assert.deepEqual(draws, [1]);
  r.tick(5000);
  assert.deepEqual(draws, [1]); // no event -> no further work
  assert.equal(r.pending(), 0); // and no timer left behind
});

test('burst rate limit: draws at most once per minMs, and the trailing event always lands', () => {
  const r = rig(); const draws = []; const s = make(r, draws);
  for (let i = 0; i < 10; i++) { s.bump(); r.tick(50); } // 10 events over 500ms
  assert.ok(draws.length >= 2, 'a burst of events drew more than once: ' + draws);
  assert.ok(draws.every((x, i) => i === 0 || x - draws[i - 1] >= 400), 'gap respected: ' + draws);
  s.bump(); r.tick(400);
  assert.equal(draws.length, 3);
  assert.ok(draws[2] >= 500, 'the last event of the burst was drawn: ' + draws);
  assert.equal(r.pending(), 0, 'timer drains after the trailing draw');
});

test('drawIfCurrent draws on first sight (boot), then only when the epoch moved', () => {
  const r = rig(); const draws = []; const s = make(r, draws);
  s.drawIfCurrent();
  assert.deepEqual(draws, [0]); // first call: the view has never been drawn
  s.drawIfCurrent();
  assert.deepEqual(draws, [0]); // epoch unchanged -> free
  s.bump(); r.tick(400); // the bump landed at last+minMs — the throttle deferring a fresh draw
  assert.deepEqual(draws, [0, 400]);
});

test('force draws immediately even mid-burst and consumes the pending trailing draw', () => {
  const r = rig(); const draws = []; const s = make(r, draws);
  s.bump(); r.tick(1); // draw at 1
  s.bump(); // arms the 400ms trailing draw
  s.force(); // user action (thread switch): must redraw NOW
  assert.deepEqual(draws, [1, 1]);
  r.tick(400);
  assert.deepEqual(draws, [1, 1], 'the trailing draw is redundant after the force — the newer epoch is on screen');
  assert.equal(r.pending(), 0);
});

test('hidden: nothing arms, nothing draws; becoming visible catches up via drawIfCurrent', () => {
  const r = rig(); const draws = []; let hid = true;
  const s = make(r, draws, { hidden: () => hid });
  s.bump();
  assert.equal(r.pending(), 0, 'no timer while hidden');
  r.tick(1000);
  assert.deepEqual(draws, []);
  s.force();
  assert.deepEqual(draws, [], 'force defers while hidden instead of building DOM nobody sees');
  hid = false;
  s.drawIfCurrent();
  assert.deepEqual(draws, [1000], 'the bump was never lost — first draw on visible catches up');
});

test('hide() cancels a pending draw; the epoch is kept so the next draw is current', () => {
  const r = rig(); const draws = []; const s = make(r, draws);
  s.bump();
  assert.equal(r.pending(), 1);
  s.hide();
  assert.equal(r.pending(), 0);
  r.tick(1000);
  assert.deepEqual(draws, []);
  s.drawIfCurrent();
  assert.deepEqual(draws, [1000], 'deferred draw still carries the bumped epoch');
});

test('gate (tab visibility) defers like hidden; opening the gate draws the pending epoch', () => {
  const r = rig(); const draws = []; let open = false;
  const s = make(r, draws, { gate: () => open });
  s.bump();
  assert.equal(r.pending(), 0, 'no timer for an off-screen view');
  r.tick(1000);
  assert.deepEqual(draws, []);
  open = true;
  s.drawIfCurrent();
  assert.deepEqual(draws, [1000]);
});

test('force with a closed gate defers, then activation draws exactly once', () => {
  const r = rig(); const draws = []; let open = false;
  const s = make(r, draws, { gate: () => open });
  s.force();
  assert.deepEqual(draws, []);
  open = true;
  s.drawIfCurrent();
  s.drawIfCurrent();
  assert.deepEqual(draws, [0], 'one draw, however many activations');
});

test('events at burst rate keep exactly one timer armed at a time', () => {
  const r = rig(); const draws = []; const s = make(r, draws);
  s.bump(); s.bump(); s.bump();
  assert.equal(r.pending(), 1);
  r.tick(10); s.bump();
  assert.equal(r.pending(), 1);
  r.tick(1000);
  assert.equal(r.pending(), 0);
  assert.ok(draws.length >= 2, 'both bursts landed: ' + draws);
});
