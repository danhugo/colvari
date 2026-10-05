#!/usr/bin/env node
'use strict';
/*
 * Usage-ledger render-path probe (t_a7e17456). Run from app/ with Electron:
 *   PERF_SEED_RUNS=476 PERF_AGENTS=2 PERF_OUT=/tmp/colvari-usagejitter ./node_modules/.bin/electron test/perf/usage-jitter.js
 *
 * Instruments #tab-usage while real agents stream. The idle-phase CPU profile (t_0bd4680f,
 * results/usage-470-19842f8) says the ledger is cheap at rest — this probe adds the streaming
 * evidence the profile could not give: renderUsage call counts and durations live, how many
 * calls the ukey fast-path absorbs, the client-side aggregation cost (ledgerFromRuns over the
 * full run history on every filtered draw), the per-run cost cells, async IPC sidebars
 * (renderUsageLimits / renderDiscovery fire per draw), DOM churn, long tasks and layout shifts.
 *
 * The probe re-points TAB_VIEW.usage and the filter selects' onchange at the wrapped renderUsage,
 * so state pushes AND filter changes are both captured (the original wiring binds renderUsage by
 * reference at load time — wrapping the window global alone would see only the re-pointed paths).
 *
 * PERF_SYNTHETIC=1: no agents at all — only the app's own refresh backstop against the static
 * seeded feed plus the same filter-driver loop, isolating ledger-internal movers from streaming.
 *
 * Knobs (env): PERF_AGENTS (2), PERF_STREAM_MS (30000), PERF_SEED_RUNS (476), PERF_OUT.
 * Caveat: renderUsage's cost shows up whole in the wrapper; the inner wrappers (aggregation,
 * hero, cost cells) split it, and their references are captured identically by the original.
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(process.env.PERF_APP_DIR || path.join(__dirname, '../..'));
const MAIN = path.join(APP, 'src/main.js');
const HCPATH = process.env.PERF_HCPATH || '/Users/d/.local/bin/helpycode';
const MODEL = process.env.PERF_HC_MODEL || 'elice/z-ai/glm-5.3-flash';
const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `colvari-usage-jitter-${Date.now()}`);
const AGENTS = Math.max(1, Number(process.env.PERF_AGENTS || 2));
const STREAM_MS = Math.max(5000, Number(process.env.PERF_STREAM_MS || 30000));
const SEED_RUNS = Math.max(0, Number(process.env.PERF_SEED_RUNS || 476));
const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsq = (v) => JSON.stringify(v);
fs.mkdirSync(OUT, { recursive: true });
process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-usagejitter-root-'));
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = String(STREAM_MS + 480000);
process.env.AGENTS_SQUAD_DEV = '0';
process.on('exit', () => { try { fs.rmSync(process.env.AGENTS_SQUAD_PROJECT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });

app.setPath('userData', path.join(process.env.AGENTS_SQUAD_PROJECT, 'userData'));
require(MAIN);
let wc = null;
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'window') return;
  contents.setBackgroundThrottling(false);
  contents.on('did-finish-load', async () => {
    wc = contents;
    try { await main(); } catch (error) { console.error('[usage-jitter] failed:', error && error.stack || error); app.exit(1); }
  });
});

const ex = (script) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${script} })()`);
const exT = (script, ms = 30000) => Promise.race([ex(script), WAIT(ms).then(() => { throw new Error('renderer-timeout'); })]);

// Run history for the ledger: three {runtime, provider, model} keys and a subscription/api billing
// split (driven through apiKeySource so detectBilling classifies without env), spread ~35 min apart
// so the 14-day hero bars have signal across the whole window.
function seedStore(dir, nodes) {
  const { Store } = require(path.join(APP, 'src/store.js'));
  const U = require(path.join(APP, 'src/usage.js'));
  const store = new Store(dir);
  const KEY = [
    { runtime: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    { runtime: 'helpycode', provider: 'elice', model: 'elice/z-ai/glm-5.3-flash' },
    { runtime: 'codex', provider: 'openai', model: 'gpt-5.2' },
  ];
  for (let i = 0; i < SEED_RUNS; i++) {
    const started = Date.now() - (SEED_RUNS - i) * 2100000;
    const sub = i % 3 === 0;
    const run = U.newRun({ nodeId: nodes[i % nodes.length], agent: 'Perf', taskId: null, task: 'seed', models: [KEY[i % 3].model],
      inputTokens: 800 + (i % 40) * 97, outputTokens: 120 + (i % 17) * 31, cacheReadTokens: 40000 + i * 13, numTurns: 3 + (i % 5),
      reportedCostUsd: 0.004 + (i % 9) * 0.0011, apiKeySource: sub ? 'none' : 'ANTHROPIC_API_KEY', ...KEY[i % 3] });
    run.startedAt = new Date(started).toISOString();
    store.addRun(U.finishRun(run, { code: 0, env: {}, billingMode: sub ? 'subscription' : 'api', startedMs: started }));
  }
}

// Calls/limits: duration per renderUsage call, whether it was sig-skipped (ukey unchanged before
// the call — the exact same expression renderUsage checks), whether the tab was active, whether a
// filter change forced it within 100 ms, and the run volume it drew. The inner wrappers split the
// cost: aggregation (ledgerFromRuns), hero bars (usageHero), per-run cost cells (runCostCell).
const INSTRUMENT = `
  if (window.__usageLedger) return { already: true };
  if (!$('#tab-usage')) return { error: 'no-usage-tab' };
  const P = window.__usageLedger = {
    startedAt: performance.now(),
    calls: [], agg: [], hero: [], costs: { n: 0, ms: 0 }, sums: { n: 0, ms: 0 },
    limits: [], discovery: [], mutations: [], shifts: [], longTasks: [], states: [], runDeltas: [],
    lastDrawnKey: null, forcedStamp: -1e9,
  };
  const ukey = () => [S.v && S.v.runs, S.v && S.v.board, RUNS.length, $('#us-agent').value, $('#us-billing').value, S.allNodes.length].join('|');
  const wrapTimed = (name, rec) => {
    const orig = window[name];
    if (typeof orig !== 'function') { P[name + 'Missing'] = true; return; }
    window[name] = function (...a) {
      const t0 = performance.now();
      try { return orig.apply(this, a); }
      finally { rec(performance.now() - t0, a); }
    };
  };
  wrapTimed('ledgerFromRuns', (ms, a) => P.agg.push({ at: +(performance.now() - P.startedAt).toFixed(1), ms: +ms.toFixed(2), rs: a[0] ? a[0].length : 0 }));
  wrapTimed('usageHero', (ms) => P.hero.push({ at: +(performance.now() - P.startedAt).toFixed(1), ms: +ms.toFixed(2) }));
  wrapTimed('runCostCell', (ms) => { P.costs.n++; P.costs.ms += ms; });
  wrapTimed('sumRuns', (ms) => { P.sums.n++; P.sums.ms += ms; });
  const origRenderUsage = window.renderUsage;
  if (typeof origRenderUsage !== 'function') { P.renderUsageMissing = true; }
  else {
    const wrapped = function (...a) {
      const active = $('#tab-usage').classList.contains('active');
      const key = ukey();
      const sigSkip = key === usageSig;
      const forced = performance.now() - P.forcedStamp < 100;
      const t0 = performance.now();
      try { return origRenderUsage.apply(this, a); }
      finally {
        P.lastDrawnKey = usageSig;
        P.calls.push({ at: +(performance.now() - P.startedAt).toFixed(1), ms: +(performance.now() - t0).toFixed(2), active, sigSkip, forced, runs: RUNS.length });
        if (P.calls.length > 20000) P.calls.splice(0, 4000);
      }
    };
    window.renderUsage = wrapped;
    TAB_VIEW.usage = wrapped; // the view map captured the original by reference at load time
    for (const id of ['#us-agent', '#us-billing']) { const el = $(id); if (el && el.onchange) el.onchange = wrapped; }
  }
  const wrapAsync = (name) => {
    const orig = window[name];
    if (typeof orig !== 'function') { P[name + 'Missing'] = true; return; }
    window[name] = function (...a) {
      const t0 = performance.now();
      return Promise.resolve(orig.apply(this, a)).finally(() => P[name === 'renderUsageLimits' ? 'limits' : 'discovery'].push({ at: +(performance.now() - P.startedAt).toFixed(1), ms: +(performance.now() - t0).toFixed(2) }));
    };
  };
  wrapAsync('renderUsageLimits');
  wrapAsync('renderDiscovery');
  for (const [name, root] of [['summary', $('#us-summary')], ['runs', $('#us-runs')]]) {
    if (!root) continue;
    new MutationObserver((records) => {
      const at = +(performance.now() - P.startedAt).toFixed(1);
      let added = 0, removed = 0;
      for (const r of records) { added += r.addedNodes.length; removed += r.removedNodes.length; }
      P.mutations.push({ at, where: name, records: records.length, added, removed });
      if (P.mutations.length > 20000) P.mutations.splice(0, 4000);
    }).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  if (window.PerformanceObserver) {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) P.shifts.push({ at: +e.startTime.toFixed(1), value: e.value }); }).observe({ type: 'layout-shift', buffered: true });
    } catch (error) { P.shiftError = String(error); }
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longTasks.push({ at: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1) }); }).observe({ type: 'longtask', buffered: true });
    } catch (error) { P.longTaskError = String(error); }
  }
  let lastRuns = RUNS.length, lastState = '';
  const sample = () => {
    const rows = document.querySelectorAll('#us-runs tr').length;
    const accts = document.querySelectorAll('#us-summary .us-acct').length;
    const rec = { at: +(performance.now() - P.startedAt).toFixed(1), runs: RUNS.length, rows, accts, hidden: document.hidden };
    if (RUNS.length !== lastRuns) { P.runDeltas.push({ at: rec.at, delta: RUNS.length - lastRuns, runs: RUNS.length }); lastRuns = RUNS.length; }
    const key = [rec.runs, rec.rows, rec.accts, rec.hidden].join('|');
    if (key !== lastState) { P.states.push(rec); lastState = key; if (P.states.length > 6000) P.states.shift(); }
    setTimeout(sample, 100);
  };
  setTimeout(sample, 100);
  return { ok: true, runs: RUNS.length, rows: document.querySelectorAll('#us-runs tr').length };
`;

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };

async function waitForWorking() {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const working = await ex(`return Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length`).catch(() => 0);
    if (working >= AGENTS) return working;
    await WAIT(1000);
  }
  throw new Error('agents did not start');
}

async function main() {
  await WAIT(1000);
  const seed = await ex(`const p = await call('createProject', 'Usage ledger probe'); switchTo({ p: p.id }); await w(300); await refresh(); await call('saveSettings', { helpycodePath: ${jsq(HCPATH)}, useWorktrees: false, maxConcurrency: ${AGENTS}, maxRuns: ${AGENTS + 2}, requireApproval: false, stallTimeoutMin: 5 }); const nodes = []; for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'UsageLedger-' + (i + 1), role: 'Dev', x: 100 + i * 220, y: 120, runtime: 'helpycode', model: ${jsq(MODEL)} })); await refresh(); return { dir: S.dir, nodes: nodes.map((n) => n.id) };`);
  seedStore(seed.dir, seed.nodes);
  const feed = await ex(`lastV = null; await refresh(); showTab('usage'); await w(500); return { runs: RUNS.length, rows: document.querySelectorAll('#us-runs tr').length };`);
  console.log('[usage-jitter] seeded runs:', JSON.stringify(feed));
  const armed = await exT(INSTRUMENT, 10000);
  if (!armed || armed.error) throw new Error('instrumentation failed: ' + JSON.stringify(armed));

  // Filter driver: cycles the agent/billing selects (change -> force-style redraw through the
  // client-side ledgerFromRuns path) and flips a Detailed-tables group now and then. Stamp the
  // forced window so the wrapper can tell user-driven draws from state-push ones.
  const FILTERS = `['', 'billing:subscription', '', 'agent:0', '', 'billing:api', '', 'agent:1', '']`;
  const driver = ex(`window.__drive = (async () => { for (const f of ${FILTERS}) { window.__usageLedger.forcedStamp = performance.now(); if (f.startsWith('billing:')) { $('#us-billing').value = f.slice(8); $('#us-agent').value = ''; } else if (f.startsWith('agent:')) { $('#us-agent').value = ${jsq(seed.nodes[0])}; $('#us-billing').value = ''; } else { $('#us-agent').value = ''; $('#us-billing').value = ''; } $('#us-agent').dispatchEvent(new Event('change')); await w(1500); const b = document.querySelector('#us-seg button[data-g="' + (Math.floor(performance.now() / 4500) % 4) + '"]'); if (b) b.click(); } return true; })(); return 'driver-started';`);
  await driver.catch(() => {});

  if (process.env.PERF_SYNTHETIC === '1') {
    await ex(`window.__synth = setInterval(() => { refresh(); }, 2000); await w(${STREAM_MS}); clearInterval(window.__synth); return true;`).catch((e) => console.error('[usage-jitter] synthetic driver ended:', e.message));
  } else {
    const toolTask = (n, id) => `await call('createTask', { title: 'Usage ledger probe ' + ${n}, description: 'Help stress-test the usage ledger. Do exactly 12 tool calls, one at a time, each of the exact form: node -e "console.log(process.version, process.uptime())" (only this command, nothing else). After every tool result, write one short sentence as a plain text reply line. Do not run any other command. Never modify, create, or delete anything.', assignee: ${jsq(id)} });`;
    await ex(`await call('run'); ${toolTask(1, seed.nodes[0])} ${toolTask(2, seed.nodes[1] || seed.nodes[0])} await refresh();`);
    try { await waitForWorking(); } catch (e) {
      const diag = await ex(`return { agents: S.orch.agents, todo: S.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').map((t) => t.id + ' ' + t.assignee + ' ' + t.status) }`).catch(() => ({}));
      throw new Error(e.message + ' — diagnostics: ' + JSON.stringify(diag, null, 2));
    }
  }
  await WAIT(STREAM_MS);
  // Piecewise pull: one hung field must not lose the whole run's evidence.
  const grab = (key, ms) => exT(`return (window.__usageLedger || {})[${jsq(key)}] || []`, ms).catch(() => []);
  const meta = await exT(`const P = window.__usageLedger || {}; return { startedAt: P.startedAt, costs: P.costs, sums: P.sums, lastDrawnKey: P.lastDrawnKey, renderUsageMissing: P.renderUsageMissing, ledgerFromRunsMissing: P.ledgerFromRunsMissing, usageHeroMissing: P.usageHeroMissing, runCostCellMissing: P.runCostCellMissing, sumRunsMissing: P.sumRunsMissing, renderUsageLimitsMissing: P.renderUsageLimitsMissing, renderDiscoveryMissing: P.renderDiscoveryMissing, shiftError: P.shiftError, longTaskError: P.longTaskError, states: P.states || [], runDeltas: P.runDeltas || [] }`, 20000).catch(() => ({}));
  const [calls, agg, hero, limits, discovery, mutations, shifts, longTasks] = await Promise.all([
    grab('calls', 20000), grab('agg', 20000), grab('hero', 15000), grab('limits', 15000),
    grab('discovery', 15000), grab('mutations', 20000), grab('shifts', 20000), grab('longTasks', 20000),
  ]);
  const result = { ...meta, calls, agg, hero, limits, discovery, mutations, shifts, longTasks, seeded: feed, synthetic: process.env.PERF_SYNTHETIC === '1' };
  fs.writeFileSync(path.join(OUT, 'usage-jitter.json'), JSON.stringify(result, null, 2));

  const drew = calls.filter((c) => c.active && !c.sigSkip);
  const dMs = drew.map((c) => c.ms), aMs = agg.map((a) => a.ms), hMs = hero.map((h) => h.ms);
  const lMs = limits.map((l) => l.ms), d2Ms = discovery.map((d) => d.ms);
  const ltDur = longTasks.map((t) => t.dur);
  const gapMin = drew.slice(1).reduce((m, c, i) => Math.min(m, c.at - drew[i].at), Infinity);
  const summary = {
    out: OUT, seeded: feed, synthetic: process.env.PERF_SYNTHETIC === '1',
    renderUsage: {
      calls: calls.length, drew: drew.length, sigSkips: calls.filter((c) => c.sigSkip).length,
      inactive: calls.filter((c) => !c.active).length, forced: drew.filter((c) => c.forced).length,
      p50: pct(dMs, 0.5), p95: pct(dMs, 0.95), max: dMs.length ? Math.max(...dMs) : 0,
      minGapMs: drew.length > 1 ? +gapMin.toFixed(1) : null,
    },
    ledgerFromRuns: { calls: agg.length, p50: pct(aMs, 0.5), p95: pct(aMs, 0.95), max: aMs.length ? Math.max(...aMs) : 0 },
    usageHero: { calls: hero.length, p50: pct(hMs, 0.5), max: hMs.length ? Math.max(...hMs) : 0 },
    runCostCells: { calls: meta.costs ? meta.costs.n : 0, totalMs: meta.costs ? +Number(meta.costs.ms).toFixed(2) : 0 },
    sumRuns: { calls: meta.sums ? meta.sums.n : 0, totalMs: meta.sums ? +Number(meta.sums.ms).toFixed(2) : 0 },
    renderUsageLimits: { calls: limits.length, p50: pct(lMs, 0.5), max: lMs.length ? Math.max(...lMs) : 0 },
    renderDiscovery: { calls: discovery.length, p50: pct(d2Ms, 0.5), max: d2Ms.length ? Math.max(...d2Ms) : 0 },
    longTasks: { count: longTasks.length, p50: pct(ltDur, 0.5), max: ltDur.length ? Math.max(...ltDur) : 0 },
    shifts: { count: shifts.length, sum: +shifts.reduce((s, x) => s + x.value, 0).toFixed(6) },
    mutations: { records: mutations.length, addedNodes: mutations.reduce((s, m) => s + m.added, 0), removedNodes: mutations.reduce((s, m) => s + m.removed, 0) },
    runs: { seeded: feed.runs, final: (meta.states || []).length ? meta.states[meta.states.length - 1].runs : feed.runs, liveDeltas: (meta.runDeltas || []).length },
    errors: { shiftError: meta.shiftError, longTaskError: meta.longTaskError, renderUsageMissing: meta.renderUsageMissing, ledgerFromRunsMissing: meta.ledgerFromRunsMissing, usageHeroMissing: meta.usageHeroMissing, runCostCellMissing: meta.runCostCellMissing, sumRunsMissing: meta.sumRunsMissing, renderUsageLimitsMissing: meta.renderUsageLimitsMissing, renderDiscoveryMissing: meta.renderDiscoveryMissing },
  };
  fs.writeFileSync(path.join(OUT, 'usage-jitter-summary.json'), JSON.stringify(summary, null, 2));
  console.log('[usage-jitter] ' + JSON.stringify(summary));
  try { await exT(`await call('stop')`, 15000); } catch {}
  await WAIT(1000);
  app.exit(0);
}
