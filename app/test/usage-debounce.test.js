// Usage-ledger debounce (t_c69c2170 leftover): a run landing bumps S.v.runs, so while the usage
// tab is open under stream churn every delta-pump frame rebuilt the ledger (~4.2 ms at 471 runs,
// t_0bd4680f). renderUsage is leading+trailing debounced at 300ms; renderUsageNow is the raw
// rebuild. Renderer-level per the wiki-debounce pattern: the block is extracted from app.js and
// run against a DOM stub with an injected clock, locking the discipline (leading draw at once,
// a burst coalesces into one trailing draw, a leading draw cancels the pending trailing one, an
// inactive tab draws nothing) plus the signature guard and probe wiring it leans on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('// t_6cbe12ed');
const end = src.indexOf('function renderUsageNow() {', start);
assert.ok(start > 0 && end > start, 'renderUsage debounce block found in renderer/app.js');
const block = src.slice(start, end);

function makeRunner() {
  let active = true;
  let clock = 1000;
  const timers = new Map(); let nextId = 1;
  const setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const Date = { now: () => clock };
  let draws = 0;
  const renderUsageNow = () => { draws++; };
  const tab = { classList: { contains: (c) => c === 'active' && active } };
  const fn = new Function('$', 'Date', 'setTimeout', 'clearTimeout', 'renderUsageNow',
    block + '\nreturn { renderUsage, state: () => ({ usageLastDraw, usageTimer }) };');
  const api = fn(() => tab, Date, setTimeout, clearTimeout, renderUsageNow);
  return {
    api,
    get draws() { return draws; },
    get pendingTimers() { return timers.size; },
    setActive(v) { active = v; },
    setNow(t) { clock = t; },
    advance(ms) { // move the clock, firing due timers in order
      const target = clock + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      clock = target;
    },
  };
}

test('leading edge draws at once; a burst coalesces into one trailing draw', () => {
  const r = makeRunner();
  r.api.renderUsage();
  assert.equal(r.draws, 1, 'quiet view draws immediately');
  assert.equal(r.pendingTimers, 0);
  r.advance(100); r.api.renderUsage(); // t=1100, 100ms after the draw
  assert.equal(r.draws, 1, 'inside the window nothing redraws');
  assert.equal(r.pendingTimers, 1, 'one trailing render is scheduled');
  r.advance(50); r.api.renderUsage(); // t=1150, still the same window
  assert.equal(r.draws, 1);
  assert.equal(r.pendingTimers, 1, 'the pending trailing render is not duplicated');
  r.advance(150); // t=1300 = last draw + 300ms, timer fires
  assert.equal(r.draws, 2, 'trailing call lands the last state');
  assert.equal(r.pendingTimers, 0);
  assert.equal(r.api.state().usageLastDraw, 1300);
  assert.equal(r.api.state().usageTimer, 0);
});

test('a leading draw cancels the pending trailing render', () => {
  const r = makeRunner();
  r.api.renderUsage(); // t=1000, leading
  r.advance(100); r.api.renderUsage(); // t=1100, trailing due at 1200
  r.setNow(1350); r.api.renderUsage(); // 350ms after the last draw: leading again
  assert.equal(r.draws, 2);
  assert.equal(r.pendingTimers, 0, 'the stale trailing timer was cleared');
  r.advance(100);
  assert.equal(r.draws, 2, 'and it never fires late');
});

test('an inactive tab draws nothing and mutes the trailing callback', () => {
  const r = makeRunner();
  r.setActive(false);
  r.api.renderUsage();
  assert.equal(r.draws, 0, 'inactive tab never draws');
  assert.equal(r.pendingTimers, 0, 'and never schedules');
  r.setActive(true);
  r.api.renderUsage(); // t=1000 leading
  r.advance(100); r.api.renderUsage(); // trailing due at 1200
  r.setActive(false); r.advance(200);
  assert.equal(r.draws, 1, 'a tab left mid-window does not draw the trailing render');
  assert.equal(r.api.state().usageTimer, 0, 'the timer slot is released');
});

test('renderUsageNow keeps the signature guard and the activation reset it leans on', () => {
  const body = src.slice(end, src.indexOf('\nfunction ', end + 10));
  assert.match(body, /if \(ukey === usageSig\) return;/, 'unchanged state must not rebuild the ledger');
  assert.match(src, /usage: \(\) => \{ usageSig = null; \}/, 'tab activation must reset the signature');
  const probe = fs.readFileSync(path.join(__dirname, 'perf', 'click-latency.js'), 'utf8');
  assert.match(probe, /'renderUsageNow'/, 'the split-out rebuild stays in the click-latency probe list');
});
