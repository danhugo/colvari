const test = require('node:test'); const assert = require('node:assert');
const { normalizeNode, buildClaudeArgs, migrateEffortArg, EFFORT_LEVELS } = require('../src/agent-config');
const U = require('../src/usage');
const CAP = require('../src/capabilities');

test('effort defaults to low and is validated', () => {
  assert.equal(normalizeNode({}).effort, 'low');
  assert.equal(normalizeNode({ effort: 'xhigh' }).effort, 'xhigh');
  assert.equal(normalizeNode({ effort: 'bogus' }).effort, 'low');
  for (const e of EFFORT_LEVELS) assert.equal(normalizeNode({ effort: e }).effort, e);
});

test('autoCompact is "auto" or a token window clamped to 100k-1M', () => {
  assert.equal(normalizeNode({}).autoCompact, '');
  assert.equal(normalizeNode({ autoCompact: 'auto' }).autoCompact, 'auto');
  assert.equal(normalizeNode({ autoCompact: 'AUTO' }).autoCompact, 'auto');
  assert.equal(normalizeNode({ autoCompact: 500000 }).autoCompact, '500000');
  assert.equal(normalizeNode({ autoCompact: 50000 }).autoCompact, '100000');
  assert.equal(normalizeNode({ autoCompact: 5000000 }).autoCompact, '1000000');
  assert.equal(normalizeNode({ autoCompact: 0 }).autoCompact, '');
});

test('legacy percentage autoCompact values (<=100) are migrated to CLI default, not clamped', () => {
  assert.equal(normalizeNode({ autoCompact: 80 }).autoCompact, '');
  assert.equal(normalizeNode({ autoCompact: '80' }).autoCompact, '');
  assert.equal(normalizeNode({ autoCompact: 100 }).autoCompact, '');
  assert.equal(normalizeNode({ autoCompact: 1 }).autoCompact, '');
});

test('autoCompactPct is a per-agent 1-100 threshold override; empty = project default', () => {
  assert.equal(normalizeNode({}).autoCompactPct, '');
  assert.equal(normalizeNode({ autoCompactPct: '' }).autoCompactPct, '');
  assert.equal(normalizeNode({ autoCompactPct: 0 }).autoCompactPct, '');
  assert.equal(normalizeNode({ autoCompactPct: 'bogus' }).autoCompactPct, '');
  assert.equal(normalizeNode({ autoCompactPct: 70 }).autoCompactPct, 70);
  assert.equal(normalizeNode({ autoCompactPct: '70' }).autoCompactPct, 70);
  assert.equal(normalizeNode({ autoCompactPct: 1 }).autoCompactPct, 1);
  assert.equal(normalizeNode({ autoCompactPct: 100 }).autoCompactPct, 100);
  assert.equal(normalizeNode({ autoCompactPct: 250 }).autoCompactPct, 100);
});

test('migration: "--effort low" in extraArgs becomes effort=low and is stripped', () => {
  const n = normalizeNode({ extraArgs: '--effort low --verbose' });
  assert.equal(n.effort, 'low');
  assert.equal(n.extraArgs, '--verbose');
  const n2 = normalizeNode({ extraArgs: '--effort high' });
  assert.equal(n2.effort, 'high');
  assert.equal(n2.extraArgs, '');
  // explicit effort field wins over a stray extraArgs value
  const n3 = normalizeNode({ effort: 'medium', extraArgs: '--effort high' });
  assert.equal(n3.effort, 'medium');
});

test('buildClaudeArgs passes --effort and --autocompact', () => {
  const args = buildClaudeArgs({ effort: 'high', autoCompact: 400000 }, 'hi', {}, {});
  assert.ok(args.includes('--effort')); assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.ok(args.includes('--autocompact')); assert.equal(args[args.indexOf('--autocompact') + 1], '400000');
  const argsAuto = buildClaudeArgs({ autoCompact: 'auto' }, 'hi', {}, {});
  assert.equal(argsAuto[argsAuto.indexOf('--autocompact') + 1], 'auto');
  const args2 = buildClaudeArgs({}, 'hi', {}, {});
  assert.equal(args2[args2.indexOf('--effort') + 1], 'low');
  assert.ok(!args2.includes('--autocompact'));
});

test('needsInitialProbe: true only when a node has never been probed', () => {
  assert.equal(CAP.needsInitialProbe({}), true);
  assert.equal(CAP.needsInitialProbe({ runtime: 'claude' }), true);
  assert.equal(CAP.needsInitialProbe({ capabilities: null }), true);
  assert.equal(CAP.needsInitialProbe({ capabilities: { ok: true } }), false);
  // stale-but-already-probed nodes are left to needsReprobe (TTL/signature), not the startup sweep
  assert.equal(CAP.needsInitialProbe({ capabilities: { ok: false, error: 'not installed' } }), false);
});

test('usage: authType splits subscription vs everything else', () => {
  assert.equal(U.authType('subscription'), 'subscription');
  assert.equal(U.authType('api'), 'api'); assert.equal(U.authType('proxy'), 'api'); assert.equal(U.authType('unknown'), 'api');
});

test('usageStatus warns then pauses on configured limits', () => {
  const now = Date.now();
  const runs = Array.from({ length: 5 }, (_, i) => ({ kind: 'agent', billingSource: 'subscription', startedAt: new Date(now - i * 1000).toISOString(), inputTokens: 0, outputTokens: 0 }));
  const s1 = U.usageStatus(runs, { fiveHourLimit: 10, warnPct: 80 }, now);
  assert.equal(s1.fiveHour.used, 5); assert.equal(s1.fiveHour.pct, 0.5); assert.equal(s1.warn, false); assert.equal(s1.pause, false);
  const s2 = U.usageStatus(runs, { fiveHourLimit: 6, warnPct: 80 }, now);
  assert.equal(s2.warn, true); assert.equal(s2.pause, false);
  const s3 = U.usageStatus(runs, { fiveHourLimit: 5, warnPct: 80 }, now);
  assert.equal(s3.pause, true);
  // out of the 5h window is not counted
  const old = [{ kind: 'agent', billingSource: 'subscription', startedAt: new Date(now - 6 * 60 * 60 * 1000).toISOString() }];
  assert.equal(U.usageStatus(old, { fiveHourLimit: 1 }, now).fiveHour.used, 0);
  // disabled limit (0) never warns/pauses
  assert.deepEqual(U.usageStatus(runs, {}, now).fiveHour, { used: 5, limit: 0, pct: 0, warn: false, pause: false, resetsAt: null });
});

test('usageStatus: API auth tracks tokens/cost, not request windows', () => {
  const runs = [{ kind: 'agent', billingSource: 'api', inputTokens: 600, outputTokens: 500, reportedCostUsd: 2, startedAt: new Date().toISOString() }];
  const s = U.usageStatus(runs, { tokenLimit: 1000, costLimit: 1, warnPct: 80 });
  assert.equal(s.tokens.used, 1100); assert.equal(s.tokens.pause, true);
  assert.equal(s.cost.used, 2); assert.equal(s.cost.pause, true);
  assert.equal(s.authTypes.includes('api'), true);
});

test('capabilities: parses --help text into slash commands / bare commands, never throws', () => {
  const help = 'Usage: claude [options]\n\nAvailable commands:\n  chat        start a chat\n  init        create CLAUDE.md\n\nSlash commands: /compact /review\n';
  const r = CAP.probeHelp('claude', ['--help'], () => help);
  assert.ok(r.ok); assert.deepEqual(r.slashCommands.sort(), ['/compact', '/review']);
  assert.ok(r.commands.includes('chat') && r.commands.includes('init'));
  const missing = CAP.probeHelp('nope', ['--help'], () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; });
  assert.equal(missing.ok, false); assert.equal(missing.error, 'not installed');
});

test('capabilities: needsReprobe triggers on missing/expired cache and signature changes', () => {
  const now = Date.now();
  assert.equal(CAP.needsReprobe({}, 'claude|1.0|opus|auto', { now }), true);
  const fresh = { capabilities: { ok: true }, capabilitiesProbedAt: new Date(now - 1000).toISOString(), capabilitiesSignature: 'claude|1.0|opus|auto' };
  assert.equal(CAP.needsReprobe(fresh, 'claude|1.0|opus|auto', { now }), false);
  assert.equal(CAP.needsReprobe(fresh, 'claude|1.1|opus|auto', { now }), true); // version changed
  const stale = { ...fresh, capabilitiesProbedAt: new Date(now - CAP.TTL_MS - 1000).toISOString() };
  assert.equal(CAP.needsReprobe(stale, 'claude|1.0|opus|auto', { now }), true); // TTL lapsed
});

test('capabilities: init event data replaces the --help probe as-is, no union with hard-coded/local lists', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-home-'));
  const rt = { id: 'claude', bin: () => 'claude' };
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => '/compact', initEvent: { slash_commands: ['review'], skills: ['pdf'], permission_modes: ['default', 'plan'] }, cwd: fakeHome, home: fakeHome });
  assert.deepEqual(c.slashCommands, ['/review']);
  assert.deepEqual(c.skills, ['pdf']); assert.deepEqual(c.modes, ['default', 'plan']);
  assert.equal(c.runtime, 'claude');
});

test('capabilities: Refresh (--help-only probe) unions in the runtime\'s previously observed real slash commands so modes already known (goal/loop) survive a weaker --help probe', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-home-'));
  const rt = { id: 'claude', bin: () => 'claude' };
  // This --help probe alone (no /goal or /loop mentioned, nothing scanned locally) would report zero modes.
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => 'usage: claude', cwd: fakeHome, home: fakeHome, prevSlashCommands: ['/goal', '/loop'] });
  const modeNames = c.categorized.filter((x) => x.category === 'mode').map((x) => x.name).sort();
  assert.deepEqual(modeNames, ['goal', 'loop']);
  assert.ok(c.slashCommands.includes('/goal') && c.slashCommands.includes('/loop'));
  // An initEvent, when present, is still the CLI's own authoritative report and is not unioned with anything.
  const withInit = CAP.discoverCapabilities(rt, {}, { exec: () => 'usage: claude', cwd: fakeHome, home: fakeHome, prevSlashCommands: ['/goal', '/loop'], initEvent: { slash_commands: ['review'] } });
  assert.deepEqual(withInit.slashCommands, ['/review']);
});

test('usage: subscription rate limits parsed as % of window + reset time, not $', () => {
  const future = new Date(Date.now() + 3600e3).toISOString();
  const rl = U.parseRateLimits({ rate_limits: { five_hour: { utilization: 0.95, resets_at: future }, week: { used: 50, limit: 100 } } });
  assert.equal(rl.fiveHour.pct, 0.95); assert.equal(rl.fiveHour.resetsAt, future);
  assert.equal(rl.weekly.pct, 0.5);
  assert.equal(U.parseRateLimits({}), null);
  // 0-100 scale is normalized to 0-1
  const rl2 = U.parseRateLimits({ rateLimits: { fiveHour: { pct: 92 } } });
  assert.equal(rl2.fiveHour.pct, 0.92);
  // Already-past reset times mean the window reset: the whole reading is stale and must not count.
  const rlPast = U.parseRateLimits({ rate_limits: { five_hour: { utilization: 0.5, resets_at: '2020-01-01T00:00:00Z' } } });
  assert.equal(rlPast, null);
});

test('usage: parseRateLimits reads the CLI\'s real "rate_limit_event" stream event (rate_limit_info.unifiedWindows), not just system/init', (t) => {
  // Freeze just before the recorded reset so the parser keeps resetsAt (it drops already-past times, and this
  // hardcoded event ages past its reset as wall-clock time moves — tests must not depend on today's date).
  t.mock.timers.enable({ apis: ['Date'], now: 1790520600 * 1000 - 60_000 });
  const ev = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.36, resetsAt: 1790520600 }, seven_day: { utilization: 0.22, resetsAt: 1790989200 } } } };
  const rl = U.parseRateLimits(ev);
  assert.equal(rl.fiveHour.pct, 0.36); assert.equal(rl.fiveHour.resetsAt, new Date(1790520600 * 1000).toISOString());
  assert.equal(rl.weekly.pct, 0.22); assert.equal(rl.weekly.resetsAt, new Date(1790989200 * 1000).toISOString());
});

test('usage: subscriptionGuard pauses at the configured threshold (default 90%)', () => {
  const rl = { fiveHour: { pct: 0.85, resetsAt: 't' }, weekly: { pct: 0.5, resetsAt: null } };
  assert.equal(U.subscriptionGuard(rl).pause, false);
  assert.equal(U.subscriptionGuard({ fiveHour: { pct: 0.9 } }).pause, true);
  assert.equal(U.subscriptionGuard(rl, 80).pause, true);
  assert.equal(U.subscriptionGuard(null).pause, false);
});

test('usage: a reading whose resetsAt already passed must not count (stale window after reset)', () => {
  const past = new Date(Date.now() - 60e3).toISOString();
  const future = new Date(Date.now() + 3600e3).toISOString();
  // The parser drops the whole stale reading (its pct described a window that no longer exists)...
  assert.equal(U.parseRateLimitWindow({ utilization: 0.97, resetsAt: past }), null);
  assert.equal(U.parseRateLimitWindow({ utilization: 0.97, resetsAt: future }).pct, 0.97);
  // ...and stored snapshots are filtered the same way at use time (resetsAt can pass after parsing).
  assert.deepEqual(U.liveRateLimits({ fiveHour: { pct: 0.97, resetsAt: past }, weekly: { pct: 0.5, resetsAt: future } }),
    { fiveHour: null, weekly: { pct: 0.5, resetsAt: future } });
  assert.equal(U.liveRateLimits({ fiveHour: { pct: 0.97, resetsAt: past }, weekly: { pct: 0.5, resetsAt: past } }), null);
  assert.equal(U.liveRateLimits(null), null);
  // A stale >=90% reading must never pause the guard; only a still-live one may.
  assert.equal(U.subscriptionGuard({ fiveHour: { pct: 0.97, resetsAt: past } }).pause, false);
  assert.equal(U.subscriptionGuard({ fiveHour: { pct: 0.97, resetsAt: future } }).pause, true);
});

test('usage: orchestrator ignores a stale persisted rateLimits snapshot (resetsAt past) — no pause after restart', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { Store } = require('../src/store');
  const { Orchestrator } = require('../src/orchestrator');
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stale-rl-'));
  const s = new Store(path.join(r, 'data'));
  // The incident: a >=90% snapshot whose resetsAt passed while the app was down; real usage was ~3%.
  const stale = new Date(Date.now() - 60e3).toISOString();
  const n = s.addNode({ name: 'D', role: 'Dev', runtime: 'claude' });
  s.updateNode(n.id, { rateLimits: { fiveHour: { pct: 0.97, resetsAt: stale }, weekly: null } });
  const o = new Orchestrator(s);
  assert.deepEqual(o.subscriptionRateLimits[n.id], undefined, 'stale snapshot must not be restored at startup');
  const st = o.checkUsageLimits(n.id);
  assert.equal(o.usagePaused, false, 'stale reading must not pause dispatch');
  assert.equal(st.subscriptionGuard.fiveHour.pct, 0);
  // A still-live high reading does pause, as before.
  const future = new Date(Date.now() + 3600e3).toISOString();
  o.subscriptionRateLimits[n.id] = { fiveHour: { pct: 0.97, resetsAt: future }, weekly: null };
  assert.equal(o.checkUsageLimits(n.id).subscriptionGuard.pause, true);
  assert.equal(o.usagePaused, true);
});

test('usage: providerUsageStatus reports real usage or an explicit reason', () => {
  const rl = { fiveHour: { pct: 0.5, resetsAt: 't1' }, weekly: { pct: 0.2, resetsAt: 't2' } };
  const ok = U.providerUsageStatus(rl, { installed: true, billingMode: 'subscription' });
  assert.equal(ok.available, true); assert.equal(ok.reason, null);
  assert.equal(ok.fiveHour.pct, 0.5); assert.equal(ok.weekly.pct, 0.2);
  const notInstalled = U.providerUsageStatus(null, { installed: false });
  assert.equal(notInstalled.available, false); assert.equal(notInstalled.reason, 'runtime not installed');
  const apiBilled = U.providerUsageStatus(rl, { installed: true, billingMode: 'api' });
  assert.equal(apiBilled.available, false); assert.match(apiBilled.reason, /not subscription-based/);
  const neverReported = U.providerUsageStatus(null, { installed: true, billingMode: 'auto' });
  assert.equal(neverReported.available, false); assert.match(neverReported.reason, /no usage reported yet/);
});

test('capabilities: modes are only the goal/loop slash commands the CLI actually reports (+ permission_modes), plus configured mcp servers', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-home-'));
  const rt = { id: 'claude', bin: () => 'claude' };
  const c = CAP.discoverCapabilities(rt, { mcpServers: { board: {} } }, { exec: () => 'usage: claude', cwd: fakeHome, home: fakeHome });
  const modeNames = c.categorized.filter((x) => x.category === 'mode').map((x) => x.name).sort();
  assert.deepEqual(modeNames, []); // "usage: claude" --help mentions no /goal or /loop slash commands
  const mcpNames = c.categorized.filter((x) => x.category === 'mcp').map((x) => x.name);
  assert.deepEqual(mcpNames, ['board']);
});

test('capabilities: scanLocalPlugins finds project .claude/skills and .claude/commands, never throws on missing dirs', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-home-'));
  assert.deepEqual(CAP.scanLocalPlugins('/no/such/dir', { home: fakeHome }), { skills: [], commands: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'my-skill'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'commands', 'review.md'), '# review');
  const r = CAP.scanLocalPlugins(dir, { home: fakeHome });
  assert.deepEqual(r.skills, ['my-skill']); assert.deepEqual(r.commands, ['/review']);
});

test('capabilities: scanLocalPlugins also picks up user ~/.claude and installed-plugin skills/commands', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', 'user-skill'), { recursive: true });
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-plugin-'));
  fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'commands', 'plugcmd.md'), '# plugcmd');
  fs.mkdirSync(path.join(fakeHome, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: pluginDir }] } }));
  const r = CAP.scanLocalPlugins('/no/such/dir', { home: fakeHome });
  assert.deepEqual(r.skills, ['user-skill']); assert.deepEqual(r.commands, ['/plugcmd']);
});

test('agent-config: enabledCapabilities persist on the node and are passed to the run via the system prompt', () => {
  const n = normalizeNode({ enabledCapabilities: 'loop, /review' });
  assert.deepEqual(n.enabledCapabilities, ['loop', '/review']);
  const args = buildClaudeArgs({ enabledCapabilities: ['loop', '/review'] }, 'hi', {}, {});
  const idx = args.indexOf('--append-system-prompt');
  assert.ok(idx !== -1); assert.match(args[idx + 1], /Enabled capabilities.*loop, \/review/);
});
