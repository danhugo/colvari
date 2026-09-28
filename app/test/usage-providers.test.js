const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/usage');

// Clock anchored to real time: liveRateLimits filters readings against the real Date.now(), so reset times
// must be future-dated from it; window boundaries only ever compare relative offsets from NOW.
const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const inH = (h) => new Date(NOW + h * 3600000).toISOString();

const agentRun = (over = {}) => ({ id: 'r' + Math.random().toString(36).slice(2), kind: 'agent', runtime: 'claude', billingSource: 'subscription', startedAt: ago(60 * 1000), inputTokens: 10, outputTokens: 5, ...over });
const node = (over = {}) => ({ id: 'n' + Math.random().toString(36).slice(2), name: 'A', role: 'Dev', runtime: 'claude', ...over });

const prov = (providers, name) => providers.find((p) => p.provider === name);

test('providers: one entry per provider the team actually runs; claude windows carry the CLI-reported 5h/weekly over the local count', () => {
  const a = node({ name: 'ClaPM' });
  const providers = U.usageProviders({
    runs: [1, 2, 3, 4, 5, 6].map(() => agentRun({ runtime: 'claude' })),
    limits: { fiveHourLimit: 10, weeklyLimit: 0, warnPct: 80 },
    nodes: [a, node({ name: 'ClaDev' }), node({ name: 'CodDev', runtime: 'codex' })],
    rateLimitsByNode: { [a.id]: { fiveHour: { pct: 0.42, resetsAt: inH(1) }, weekly: { pct: 0.13, resetsAt: inH(72) } } },
    now: NOW,
  });
  assert.equal(providers.length, 2); // grouped by provider: two claude agents share one entry
  const claude = prov(providers, 'claude');
  assert.equal(claude.status, 'ok');
  assert.equal(claude.plan, 'subscription');
  assert.equal(claude.windows.length, 2);
  const five = claude.windows.find((w) => w.label === '5h');
  assert.equal(five.used, 6); // local run count is kept alongside the CLI's own number
  assert.equal(five.limit, 10);
  assert.equal(five.pct, 0.42); // the CLI's self-reported utilization wins over the local 6/10
  assert.equal(five.warn, false);
  assert.equal(five.pause, false);
  assert.equal(five.resetAt, inH(1));
  const weekly = claude.windows.find((w) => w.label === 'weekly');
  assert.equal(weekly.pct, 0.13);
  assert.equal(weekly.limit, 0);
  assert.equal(weekly.resetAt, inH(72));
});

test('providers: a silent provider is status unknown with an explicit reason, never a fabricated 0%', () => {
  const providers = U.usageProviders({ runs: [], limits: {}, nodes: [node({ runtime: 'codex' }), node({ runtime: 'codex' })], now: NOW });
  const codex = prov(providers, 'codex');
  assert.equal(codex.status, 'unknown');
  assert.match(codex.reason, /no usage reported yet/);
  assert.deepEqual(codex.windows, []);
  assert.ok(!JSON.stringify(codex).includes('pct'), JSON.stringify(codex));
});

test('providers: mixed team — claude numbers never bleed onto the codex entry', () => {
  const c = node({ name: 'MixClaude' });
  const providers = U.usageProviders({
    runs: [agentRun({ runtime: 'claude' })],
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [c, node({ name: 'MixCodex', runtime: 'codex' })],
    rateLimitsByNode: { [c.id]: { fiveHour: { pct: 0.42, resetsAt: inH(1) }, weekly: { pct: 0.13, resetsAt: inH(72) } } },
    now: NOW,
  });
  const codex = prov(providers, 'codex');
  assert.equal(codex.status, 'unknown');
  assert.ok(!/0\.42|"pct"/.test(JSON.stringify(codex)), JSON.stringify(codex));
  assert.equal(prov(providers, 'claude').windows.find((w) => w.label === '5h').pct, 0.42);
});

test('providers: a configured budget alone does not make a silent provider known', () => {
  // fiveHourLimit is set, but the codex agents have neither CLI readings nor subscription runs.
  const providers = U.usageProviders({
    runs: [agentRun({ runtime: 'claude', billingSource: 'api' })],
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [node({ runtime: 'codex' })],
    now: NOW,
  });
  const codex = prov(providers, 'codex');
  assert.equal(codex.status, 'unknown');
  assert.deepEqual(codex.windows, []);
});

test('providers: local budget with no CLI reading yields the honest run-derived pct, warn then pause', () => {
  const mk = (n) => U.usageProviders({
    runs: Array.from({ length: n }, () => agentRun({ runtime: 'claude' })),
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [node()],
    now: NOW,
  });
  const at30 = prov(mk(3), 'claude').windows.find((w) => w.label === '5h');
  assert.equal(at30.pct, 0.3); assert.equal(at30.warn, false); assert.equal(at30.pause, false);
  assert.ok(at30.resetAt); // rolling window: resets when the oldest run drops out
  const at90 = prov(mk(9), 'claude').windows.find((w) => w.label === '5h');
  assert.equal(at90.pct, 0.9); assert.equal(at90.warn, true); assert.equal(at90.pause, false);
  const at100 = prov(mk(10), 'claude').windows.find((w) => w.label === '5h');
  assert.equal(at100.pct, 1); assert.equal(at100.pause, true);
});

test('providers: plan follows actual run billing first, then a node billingMode, else unknown', () => {
  const base = { limits: {}, nodes: [node({ billingMode: 'subscription' })], now: NOW };
  assert.equal(U.usageProviders({ ...base, runs: [agentRun({ billingSource: 'subscription' })] })[0].plan, 'subscription');
  assert.equal(U.usageProviders({ ...base, runs: [agentRun({ billingSource: 'subscription' }), agentRun({ billingSource: 'api' })] })[0].plan, 'subscription');
  assert.equal(U.usageProviders({ ...base, runs: [agentRun({ billingSource: 'api' })] })[0].plan, 'api');
  assert.equal(U.usageProviders({ ...base, runs: [] })[0].plan, 'subscription'); // configured mode as fallback
  assert.equal(U.usageProviders({ ...base, runs: [], nodes: [node()] })[0].plan, 'unknown');
});

test('providers: stale CLI readings are ignored — the window falls back to the local count, or goes unknown', () => {
  const a = node();
  const rl = { fiveHour: { pct: 0.97, resetsAt: ago(60 * 1000) } }; // window already reset: reading describes the old one
  const quiet = U.usageProviders({ runs: [], limits: {}, nodes: [a], rateLimitsByNode: { [a.id]: rl }, now: NOW });
  assert.equal(quiet[0].status, 'unknown'); // nothing live left and no local usage: unknown, not 97%
  const busy = U.usageProviders({
    runs: [1, 2, 3].map(() => agentRun()),
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [a],
    rateLimitsByNode: { [a.id]: rl },
    now: NOW,
  });
  const five = busy[0].windows.find((w) => w.label === '5h');
  assert.equal(five.pct, 0.3); // the stale 97% must not leak into the live window
  assert.equal(five.used, 3);
});

test('providers: 5h and weekly are separate windows — an old run counts for the week but not the 5h', () => {
  const providers = U.usageProviders({
    runs: [agentRun({ startedAt: ago(6 * 24 * 3600 * 1000) }), agentRun()],
    limits: { fiveHourLimit: 10, weeklyLimit: 20, warnPct: 80 },
    nodes: [node()],
    now: NOW,
  });
  const claude = prov(providers, 'claude');
  assert.equal(claude.windows.find((w) => w.label === '5h').used, 1);
  assert.equal(claude.windows.find((w) => w.label === 'weekly').used, 2);
});

test('providers: non-agent runs and api-billed runs never inflate subscription windows', () => {
  const providers = U.usageProviders({
    runs: [agentRun(), agentRun({ kind: 'probe' }), agentRun({ billingSource: 'api' }), agentRun({ kind: 'agent', runtime: 'claude', billingSource: 'api' })],
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [node(), node({ runtime: 'codex' })],
    now: NOW,
  });
  assert.equal(prov(providers, 'claude').windows.find((w) => w.label === '5h').used, 1);
  assert.equal(prov(providers, 'codex').status, 'unknown');
});

test('providers: a custom runtime (helpycode) is its own provider; its OWN stamped CLI windows make it known', () => {
  const h = node({ runtime: 'helpycode' });
  const quiet = U.usageProviders({ runs: [], limits: {}, nodes: [h], now: NOW });
  assert.equal(quiet[0].provider, 'helpycode');
  assert.equal(quiet[0].status, 'unknown');
  const reporting = U.usageProviders({
    runs: [],
    limits: {},
    nodes: [h],
    rateLimitsByNode: { [h.id]: { fiveHour: { pct: 0.5, resetsAt: inH(1) }, weekly: null, runtime: 'helpycode' } },
    now: NOW,
  });
  const p = reporting[0];
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.windows.map((w) => w.label), ['5h']); // only the window the CLI actually reported
  assert.equal(p.windows[0].pct, 0.5);
  assert.equal(p.windows[0].resetAt, inH(1));
});

test('providers: unstamped claude-dialect readings never pass as another provider quota (helpycode wk% regression)', () => {
  // Live bug: helpycode nodes carried a stale, unstamped CLAUDE subscription reading (same weekly
  // reset as the claude nodes), so the top bar showed "Helpycode Api wk 28%" — claude.ai data, not
  // helpycode's. Unstamped readings predate the runtime stamp; only claude nodes may claim them.
  const h = node({ runtime: 'helpycode' });
  const staleClaudeReading = { fiveHour: { pct: 0.91, resetsAt: ago(36 * 3600 * 1000) }, weekly: { pct: 0.28, resetsAt: inH(96) } };
  assert.equal(U.nodeLiveRateLimits(h, { [h.id]: staleClaudeReading }), null);
  const providers = U.usageProviders({ runs: [], limits: {}, nodes: [h], rateLimitsByNode: { [h.id]: staleClaudeReading }, now: NOW });
  assert.equal(providers[0].status, 'unknown');
  assert.deepEqual(providers[0].windows, []);
  // ...but the same unstamped reading on a claude node is the normal pre-stamp case: accepted
  // (its stale 5h window is still dropped by freshness — only the live weekly survives).
  const c = node({ runtime: 'claude' });
  const got = U.nodeLiveRateLimits(c, { [c.id]: staleClaudeReading });
  assert.equal(got.fiveHour, null);
  assert.equal(got.weekly.pct, 0.28);
});

test('providers: nodes without a runtime are claude, not a second unknown provider (Unknown-chip duplication)', () => {
  // Live bug: Pia/Rhea's node JSON had no runtime field but carried the claude CLI's windows, so
  // usageProviders keyed them as "unknown" and the top bar rendered the same subscription data twice.
  const rl = { fiveHour: { pct: 0.05, resetsAt: inH(1) }, weekly: { pct: 0.36, resetsAt: inH(72) } };
  const runtimeless = node({ name: 'Pia', runtime: undefined });
  const both = U.usageProviders({
    runs: [], limits: {},
    nodes: [node({ name: 'Cato' }), runtimeless],
    rateLimitsByNode: { [runtimeless.id]: rl },
    now: NOW,
  });
  assert.equal(both.length, 1); // one claude provider, no "unknown" duplicate
  assert.equal(both[0].provider, 'claude');
  assert.equal(both[0].status, 'ok');
  assert.equal(both[0].windows.find((w) => w.label === 'weekly').pct, 0.36);
  // A runtime-less node alone is still claude (the app-wide default), never an "unknown" provider.
  const soloNode = node({ runtime: undefined });
  const solo = U.usageProviders({ runs: [], limits: {}, nodes: [soloNode], rateLimitsByNode: { [soloNode.id]: rl }, now: NOW });
  assert.equal(solo.length, 1);
  assert.equal(solo[0].provider, 'claude');
  assert.equal(solo[0].status, 'ok');
});

test('nodeLiveRateLimits: stamp must match the node runtime; stale windows stay dead', () => {
  const inWindow = { fiveHour: { pct: 0.4, resetsAt: inH(1) }, weekly: { pct: 0.1, resetsAt: inH(72) } };
  const c = node({ runtime: 'claude' }); const h = node({ runtime: 'helpycode' });
  assert.deepEqual(U.nodeLiveRateLimits(c, { [c.id]: { ...inWindow, runtime: 'claude' } }).fiveHour.pct, 0.4);
  assert.equal(U.nodeLiveRateLimits(h, { [h.id]: { ...inWindow, runtime: 'claude' } }), null); // claude reading on a helpycode node
  assert.equal(U.nodeLiveRateLimits(c, { [c.id]: { ...inWindow, runtime: 'helpycode' } }), null); // and the reverse
  const stale = { fiveHour: { pct: 0.97, resetsAt: ago(60 * 1000) }, weekly: null, runtime: 'claude' };
  assert.equal(U.nodeLiveRateLimits(c, { [c.id]: stale }), null); // freshness still applies
  // persisted node.rateLimits fallback works with and without a stamp
  assert.deepEqual(U.nodeLiveRateLimits({ id: c.id, rateLimits: { ...inWindow, runtime: 'claude' } }).weekly.pct, 0.1);
  assert.equal(U.nodeLiveRateLimits({ id: h.id, runtime: 'helpycode', rateLimits: { ...inWindow } }), null); // unstamped on non-claude
});

test('providers: empty team yields no entries', () => {
  assert.deepEqual(U.usageProviders({ runs: [agentRun()], limits: {}, nodes: [], now: NOW }), []);
});

test('providers: legacy runs without a runtime stamp count for the team\'s single provider', () => {
  const providers = U.usageProviders({
    runs: [agentRun({ runtime: undefined, startedAt: ago(30 * 1000) })], // pre-runtime persisted data
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [node()],
    now: NOW,
  });
  const claude = providers[0];
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.status, 'ok'); // the legacy run is real usage — not 'unknown'
  assert.equal(claude.windows.find((w) => w.label === '5h').used, 1);
  assert.equal(claude.plan, 'subscription');
});

test('providers: multi-provider teams never guess a legacy run\'s provider', () => {
  const providers = U.usageProviders({
    runs: [agentRun({ runtime: undefined })],
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [node(), node({ runtime: 'codex' })],
    now: NOW,
  });
  assert.deepEqual(prov(providers, 'claude').windows, []);
  assert.deepEqual(prov(providers, 'codex').windows, []);
  assert.equal(prov(providers, 'claude').status, 'unknown');
});

test('providers: runtime-less runs stay uncounted when their runtime matches no agent but the team has one provider anyway', () => {
  // a probe run (kind != 'agent') must never inflate windows, even on a single-provider team
  const providers = U.usageProviders({
    runs: [agentRun({ kind: 'probe', runtime: undefined })],
    limits: { fiveHourLimit: 10, warnPct: 80 },
    nodes: [node()],
    now: NOW,
  });
  assert.equal(providers[0].status, 'unknown');
});
