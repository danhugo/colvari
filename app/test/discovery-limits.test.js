// Discovery of goal/loop/workflow-style modes and slash commands via --help probing (capabilities.js),
// using fixtures shaped like this repo's own agent-modes (single/goal/loop/workflow, agent-modes.js) —
// plus limits-parsing tests for the "unavailable" cases the CLI can report.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const CAP = require('../src/capabilities');
const U = require('../src/usage');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
// Isolate discoverCapabilities' filesystem scan (user ~/.claude, plugins cache, project .claude) from
// whatever is actually installed on the machine running the tests, so results stay deterministic.
const FAKE_HOME = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cap-home-'));
const FS_OPTS = { cwd: FAKE_HOME, home: FAKE_HOME };

test('discovery: claude --help fixture surfaces this repo\'s goal/loop/workflow-relevant commands', () => {
  const rt = { id: 'claude', bin: () => 'claude' };
  const help = fixture('help-claude.txt');
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => help, ...FS_OPTS });
  assert.equal(c.ok, true);
  assert.equal(c.runtime, 'claude');
  assert.ok(c.slashCommands.includes('/loop'), 'finds /loop (goal/loop-style automation)');
  assert.ok(c.slashCommands.includes('/workflow'), 'finds /workflow');
  assert.ok(c.slashCommands.includes('/review') && c.slashCommands.includes('/security-review'));
  assert.ok(c.commands.includes('chat') && c.commands.includes('init') && c.commands.includes('mcp'));
});

test('discovery: codex --help fixture surfaces its goal-mode subcommand', () => {
  const rt = { id: 'codex', bin: () => 'codex' };
  const help = fixture('help-codex.txt');
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => help, ...FS_OPTS });
  assert.equal(c.ok, true);
  assert.ok(c.commands.includes('goal'), 'finds the goal subcommand');
  assert.ok(c.commands.includes('exec') && c.commands.includes('apply'));
  assert.deepEqual(c.slashCommands.sort(), ['/diff', '/explain']);
});

test('discovery: a live init event is used as-is, not unioned with --help/local scan', () => {
  const rt = { id: 'claude', bin: () => 'claude' };
  const help = fixture('help-claude.txt');
  const c = CAP.discoverCapabilities(rt, {}, {
    exec: () => help,
    initEvent: { slash_commands: ['loop', 'workflow'], skills: ['superpowers:test-driven-development'], permission_modes: ['default', 'plan', 'acceptEdits'] },
    ...FS_OPTS,
  });
  // init event replaces --help's slash commands entirely (no union) — /review only exists in --help and must not leak in
  assert.ok(!c.slashCommands.includes('/review'));
  assert.deepEqual(c.slashCommands.sort(), ['/loop', '/workflow']);
  assert.deepEqual(c.modes, ['default', 'plan', 'acceptEdits']);
  assert.deepEqual(c.skills, ['superpowers:test-driven-development']);
  assert.equal(c.source, 'init-event');
});

test('discovery: an uninstalled runtime binary reports ok:false with no crash', () => {
  const rt = { id: 'ghost', bin: () => 'ghost-cli' };
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; }, ...FS_OPTS });
  assert.equal(c.ok, false);
  assert.equal(c.error, 'not installed');
  assert.deepEqual(c.slashCommands, []);
  assert.deepEqual(c.commands, []);
});

// --- Limits parsing: the "unavailable" cases (no data yet / unrecognized shape), not just the happy path ---

test('limits: parseRateLimitWindow returns null for an unrecognized/empty shape (unavailable)', () => {
  assert.equal(CAP && true, true); // sanity: capabilities module loaded fine alongside usage
  assert.equal(U.parseRateLimitWindow(null), null);
  assert.equal(U.parseRateLimitWindow({}), null);
  assert.equal(U.parseRateLimitWindow({ someOtherField: 1 }), null);
  assert.equal(U.parseRateLimitWindow({ used: 5 }), null); // used without limit can't compute a %
});

test('limits: parseRateLimits returns null when the CLI reports no rate_limits at all (unavailable)', () => {
  assert.equal(U.parseRateLimits({}), null);
  assert.equal(U.parseRateLimits({ type: 'system', subtype: 'init' }), null);
  // partial: only one window present is still parsed, the other is null (not a crash)
  const rl = U.parseRateLimits({ rate_limits: { five_hour: { utilization: 0.5 } } });
  assert.equal(rl.fiveHour.pct, 0.5);
  assert.equal(rl.weekly, null);
});

test('limits: subscriptionGuard treats missing/unavailable rate limits as 0% (no pause), never throws', () => {
  assert.deepEqual(U.subscriptionGuard(null), {
    fiveHour: { pct: 0, resetsAt: null, pause: false },
    weekly: { pct: 0, resetsAt: null, pause: false },
    pause: false, thresholdPct: U.GUARD_DEFAULT_PCT,
  });
  assert.equal(U.subscriptionGuard(undefined).pause, false);
  assert.equal(U.subscriptionGuard({ fiveHour: null, weekly: null }).pause, false);
});

test('limits: usageStatus with no limits configured at all reports every window as disabled (unavailable), no warn/pause', () => {
  const runs = [{ kind: 'agent', billingSource: 'subscription', startedAt: new Date().toISOString() }];
  const s = U.usageStatus(runs, undefined);
  for (const w of [s.fiveHour, s.weekly, s.tokens, s.cost]) assert.deepEqual(w, { used: w.used, limit: 0, pct: 0, warn: false, pause: false });
  assert.equal(s.warn, false); assert.equal(s.pause, false);
});

test('limits: usageStatus with zero runs and configured limits is 0% used, not unavailable/NaN', () => {
  const s = U.usageStatus([], { fiveHourLimit: 10, tokenLimit: 1000, costLimit: 5, warnPct: 80 });
  assert.equal(s.fiveHour.used, 0); assert.equal(s.fiveHour.pct, 0);
  assert.equal(s.tokens.used, 0); assert.equal(s.cost.used, 0);
  assert.equal(s.warn, false); assert.equal(s.pause, false);
  assert.deepEqual(s.authTypes, []);
});

// --- Recorded real events: an actual `claude -p ... --output-format stream-json` system/init and
// rate_limit_event line, captured once on a real machine (test/fixtures/real-init-event.json,
// real-rate-limit-event.json) and frozen here so the parser is exercised against real CLI output shape,
// not just hand-built fixtures.

test('real event: recorded system/init event has the shape discoverCapabilities expects', () => {
  const initEvent = JSON.parse(fixture('real-init-event.json'));
  assert.equal(initEvent.type, 'system');
  assert.equal(initEvent.subtype, 'init');
  assert.ok(Array.isArray(initEvent.slash_commands) && initEvent.slash_commands.length > 0);
  assert.ok(Array.isArray(initEvent.skills) && initEvent.skills.length > 0);

  const rt = { id: 'claude', bin: () => 'claude' };
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => '', initEvent, ...FS_OPTS });
  assert.equal(c.ok, true);
  assert.equal(c.source, 'init-event');
  assert.deepEqual(c.skills, initEvent.skills);
  assert.equal(c.slashCommands.length, initEvent.slash_commands.length);
});

test('real event: init event alone (no --help/local union) yields exactly 123 slash commands / 58 skills', () => {
  const initEvent = JSON.parse(fixture('real-init-event.json'));
  const rt = { id: 'claude', bin: () => 'claude' };
  // A non-empty --help fixture and local .claude scan are both present here to prove they're ignored once a
  // live init event exists — the bug this guards against unioned them in, inflating counts past what the CLI
  // session actually reported.
  const help = fixture('help-claude.txt');
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => help, initEvent, ...FS_OPTS });
  assert.equal(c.slashCommands.length, 123);
  assert.equal(c.skills.length, 58);
});

test('real event: usageStatus prefers the CLI-reported rate-limit snapshot even with an empty in-memory map (persisted node.rateLimits fallback)', () => {
  const rateLimitEvent = JSON.parse(fixture('real-rate-limit-event.json'));
  const rl = U.parseRateLimits(rateLimitEvent);
  const runs = []; // no local runs at all — an empty in-memory subscriptionRateLimits map, only a persisted snapshot
  const status = U.usageStatus(runs, { fiveHourLimit: 0, weeklyLimit: 0, warnPct: 80 });
  const merged = U.applyCliRateLimits(status, [rl], 80);
  assert.equal(Math.round(merged.fiveHour.pct * 100), 38);
  assert.equal(Math.round(merged.weekly.pct * 100), 22);
});

test('real event: recorded rate_limit_event parses to numeric 5h/weekly percentages', () => {
  const rateLimitEvent = JSON.parse(fixture('real-rate-limit-event.json'));
  assert.equal(rateLimitEvent.type, 'rate_limit_event');

  const rl = U.parseRateLimits(rateLimitEvent);
  assert.ok(rl, 'parses to a non-null result');
  assert.equal(typeof rl.fiveHour.pct, 'number');
  assert.ok(Number.isFinite(rl.fiveHour.pct));
  assert.equal(typeof rl.weekly.pct, 'number');
  assert.ok(Number.isFinite(rl.weekly.pct));
  assert.equal(rl.fiveHour.pct, 0.38);
  assert.equal(rl.weekly.pct, 0.22);
  assert.ok(rl.fiveHour.resetsAt);
  assert.ok(rl.weekly.resetsAt);
});
