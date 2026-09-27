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
  assert.deepEqual(U.usageStatus(runs, {}, now).fiveHour, { used: 5, limit: 0, pct: 0, warn: false, pause: false });
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

test('capabilities: init event data merges over --help probe, no hard-coded lists', () => {
  const rt = { id: 'claude', bin: () => 'claude' };
  const c = CAP.discoverCapabilities(rt, {}, { exec: () => '/compact', initEvent: { slash_commands: ['review'], skills: ['pdf'], permission_modes: ['default', 'plan'] } });
  assert.deepEqual(c.slashCommands.sort(), ['/compact', '/review']);
  assert.deepEqual(c.skills, ['pdf']); assert.deepEqual(c.modes, ['default', 'plan']);
  assert.equal(c.runtime, 'claude');
});
