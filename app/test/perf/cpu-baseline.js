#!/usr/bin/env node
'use strict';
/*
 * Renderer/GPU CPU baseline, one scenario per invocation (t_09b11191).
 *
 * Boots an isolated throwaway instance of the REAL app (own temp data root, own userData,
 * synthetic stream-cli runtime — no model calls, never touches the live app), seeds state
 * through the Store, and samples app.getAppMetrics() once per second for a fixed window,
 * while the page counts Chat.feedKey / Chat.roomEvents / refresh / renderChatBody invocations
 * and self-ms. Writes <PERF_OUT>/cpu-baseline.json + cpu-baseline.md.
 *
 * Knobs:
 *   PERF_SCENARIO=idle|feedidle|load|feed   what runs during the window (default idle)
 *     idle     — fresh project, no agents, no seeds (the floor)
 *     feedidle — 2 agents on the graph (not running) + 550 tasks / 1500 logs / 200 runs
 *     load     — 2 agents streaming via the synthetic CLI, fresh project
 *     feed     — load + the 550/1500/200 seed history (grown project while agents stream)
 *   PERF_FREEZE=feed|poll   freeze Chat.feedKey (room never rebuilds) or refresh (2s poll off)
 *   PERF_ANIM=off           inject the same reduced-motion rule the app itself uses
 *   PERF_ANIM_OFF=sweep|spin|dots|edge|all   kill specific infinite animations by selector
 *   PERF_DURATION_MS (60000), PERF_WARM_MS (5000), PERF_OUT, PERF_APP_DIR, PERF_SEED_TASKS/LOGS/RUNS
 *   PERF_AGENTS (2) number of synthetic streaming agents (use 5 for streaming lag runs)
 *
 * Env for the synthetic CLI: STREAM_SECONDS/STREAM_EPS are computed here and inherited by
 * agent children (orchestrator spreads process.env into the child env).
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(process.env.PERF_APP_DIR || path.join(__dirname, '../..'));
const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `agents-squad-cpu-${Date.now()}`);
const SCENARIO = /^(idle|feedidle|load|feed)$/.test(process.env.PERF_SCENARIO || '') ? process.env.PERF_SCENARIO : 'idle';
const FREEZE = process.env.PERF_FREEZE === 'feed' || process.env.PERF_FREEZE === 'poll' ? process.env.PERF_FREEZE : '';
const ANIM = process.env.PERF_ANIM || 'on';
const ANIM_OFF = process.env.PERF_ANIM_OFF || '';
const DURATION_MS = Math.max(10000, Number(process.env.PERF_DURATION_MS || 60000));
const WARM_MS = Number(process.env.PERF_WARM_MS || 5000);
const SEED_TASKS = Number(process.env.PERF_SEED_TASKS || 550);
const SEED_LOGS = Number(process.env.PERF_SEED_LOGS || 1500);
const SEED_RUNS = Number(process.env.PERF_SEED_RUNS || 200);
const AGENTS = SCENARIO === 'idle' ? 0 : Math.max(1, Number(process.env.PERF_AGENTS || 2)); // feedidle: agents exist but never run
const RUN = SCENARIO === 'load' || SCENARIO === 'feed'; // only these start the orchestrator
const STREAM_EPS = Number(process.env.STREAM_EPS || 6);
const STREAM_SECONDS = Math.ceil((WARM_MS + DURATION_MS) / 1000) + 30;
const TAB = ['chat', 'board', 'log', 'obs', 'overview'].includes(process.env.PERF_TAB || '') ? process.env.PERF_TAB : 'chat';
const CLI = path.join(APP, 'test/perf/stream-cli.js');
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// GUI test mode: isolated data root, no single-instance lock, procguard on spawned children.
process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cpu-root-'));
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = String(WARM_MS + DURATION_MS + 120000);
process.env.AGENTS_SQUAD_DEV = '0';
process.env.STREAM_SECONDS = String(STREAM_SECONDS);
process.env.STREAM_EPS = String(STREAM_EPS);
// Isolation guard: a bug here would boot the perf instance on the LIVE app's data root.
if (!process.env.AGENTS_SQUAD_PROJECT.startsWith(os.tmpdir())) throw new Error('[cpu-perf] AGENTS_SQUAD_PROJECT must be an isolated temp root');
process.on('exit', () => { try { fs.rmSync(process.env.AGENTS_SQUAD_PROJECT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });

// Own userData: the default is shared with the live app, whose localStorage ctx would point
// this renderer at a project that does not exist in the throwaway data root.
app.setPath('userData', path.join(process.env.AGENTS_SQUAD_PROJECT, 'userData'));

// Main-thread log I/O probe (t_e7b3e119): time every Store.appendLog exactly where the
// orchestrator makes the call — this process IS the app's main thread — and watch the event
// loop so sync stalls (appendFileSync + stat, and the 3MB read-and-rewrite trim) show up as
// end-to-end delay, not just as CPU.
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const IO = { calls: 0, totalMs: 0, maxMs: 0, over5: 0, over20: 0, slowest: [] };
{
  const { Store } = require(path.join(APP, 'src/store.js'));
  const orig = Store.prototype.appendLog;
  Store.prototype.appendLog = function (...a) {
    const t = performance.now();
    try { return orig.apply(this, a); }
    finally {
      const d = performance.now() - t;
      IO.calls++; IO.totalMs += d;
      if (d > IO.maxMs) IO.maxMs = d;
      if (d > 5) IO.over5++;
      if (d > 20) IO.over20++;
      if (d > 10) { IO.slowest.push(+d.toFixed(1)); if (IO.slowest.length > 40) IO.slowest.shift(); }
    }
  };
}
const EL = monitorEventLoopDelay({ resolution: 10 });

require(path.join(APP, 'src/main.js'));
delete process.env.AGENTS_SQUAD_SMOKE;

let wc = null;
let failed = false;
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'window') return;
  contents.setBackgroundThrottling(false); // keep rAF/animations honest even if occluded
  contents.on('did-finish-load', async () => {
    wc = contents;
    try { await main(); } catch (e) { failed = true; console.error('[cpu-perf] failed:', e && e.stack || e); }
    // Stream cells leave 5 synthetic CLIs mid-run on a failed measurement: stop them or the
    // instance lingers instead of exiting.
    if (failed && RUN) { try { await ex(`await call('stop')`); } catch {} await WAIT(1500); }
    app.exit(failed ? 1 : 0);
  });
});

const ex = (js) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${js} })()`);
const jsq = (v) => JSON.stringify(v);

// Animation name -> selectors with an infinite animation (style.css). "all" is the app's own
// reduced-motion rule; named toggles remove exactly one animation so its CPU share is the delta.
const ANIM_SEL = {
  sweep: '.avatar.working::after',
  spin: '.typing .spin, .pres.busy i, #graph .pres.busy circle',
  dots: '.dot, #chat-typing .dots::after, .substatus.ss-running::before, #graph .node.working .avatar',
  edge: '#graph .edge.active',
};
const INSTRUMENT = `
  if (window.__cpuPerf) return { already: true };
  const p = window.__cpuPerf = { feedCalls: 0, feedMs: 0, rebuilds: 0, rebuildMs: 0, refreshCalls: 0, refreshMs: 0, tickCalls: 0, tickMs: 0, freezeFeed: ${jsq(FREEZE) === jsq('feed')}, freezePoll: ${jsq(FREEZE) === jsq('poll')} };
  const timed = (holder, key, cn, cm, frozen) => { const orig = holder[key]; if (typeof orig !== 'function') return; holder[key] = function (...a) { p[cn]++; if (frozen && p[frozen]) return key === 'feedKey' ? 'prof-frozen' : undefined; const t = performance.now(); try { return orig.apply(this, a); } finally { p[cm] += performance.now() - t; } }; };
  timed(window.Chat, 'feedKey', 'feedCalls', 'feedMs', 'freezeFeed');
  timed(window.Chat, 'roomEvents', 'rebuilds', 'rebuildMs');
  timed(window, 'renderChatBody', 'tickCalls', 'tickMs'); // the scheduler's draw target; renderChat itself is now a cheap epoch guard
  // refresh is async (IPC round-trip + store reads + renderAll): time the full promise, keep
  // every call so the 2s poll's per-call distribution is reportable.
  { const orig = window.refresh; if (typeof orig === 'function') window.refresh = function (...a) { p.refreshCalls++; if (p.freezePoll) return undefined; const t = performance.now(); const r = orig.apply(this, a); const done = () => { const d = performance.now() - t; p.refreshMs += d; (p.refreshCallsMs = p.refreshCallsMs || []).push(+d.toFixed(2)); if (p.refreshCallsMs.length > 500) p.refreshCallsMs.shift(); }; if (r && typeof r.then === 'function') r.then(done, done); else done(); return r; }; }
  // Leaf heavy views (innerHTML rebuilds): timed individually, never renderAll (it would double
  // count via these leaves). TAB_VIEW captures the original fn refs at load, so tab-driven
  // rebuilds bypass window.* wraps — drawActiveView is the reliable intercept and names the tab.
  window.__cpuViews = {};
  const viewRec = (key, d) => { const s = window.__cpuViews[key] = window.__cpuViews[key] || { n: 0, ms: 0, max: 0 }; s.n++; s.ms += d; if (d > s.max) s.max = d; };
  for (const key of ['renderBoard', 'renderLog', 'renderGraph', 'renderOverview']) {
    const orig = window[key]; if (typeof orig !== 'function') continue;
    window[key] = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { viewRec(key, performance.now() - t); } };
  }
  { const orig = window.drawActiveView; if (typeof orig === 'function') window.drawActiveView = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { viewRec('drawActiveView:' + (((document.querySelector('.tab.active') || {}).id || '?').replace(/^tab-/, '')), performance.now() - t); } }; }
  // Long-frame probes: longtask observer (main-thread blocks >50ms) + rAF delta histogram
  // (dropped frames the user actually sees).
  const F = window.__cpuFrames = { frames: 0, fast: 0, sum: 0, max: 0, jank: [], lt: { n: 0, ms: 0, max: 0 } };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { F.lt.n++; F.lt.ms += e.duration; if (e.duration > F.lt.max) F.lt.max = e.duration; } }).observe({ entryTypes: ['longtask'] }); } catch (e) { F.lt.err = String(e); }
  let last = performance.now();
  const raf = (t) => { const d = t - last; last = t; if (d > 0) { if (d < 34) F.fast++; else F.jank.push(+d.toFixed(1)); F.frames++; F.sum += d; if (d > F.max) F.max = d; if (F.jank.length > 20000) F.jank.shift(); } requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  if (${jsq(ANIM)} === 'off') { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.appendChild(s); }
  const sel = ${jsq(ANIM_OFF === 'all' ? Object.values(ANIM_SEL).join(', ') : (ANIM_SEL[ANIM_OFF] || ''))};
  if (sel) { const s = document.createElement('style'); s.textContent = sel + '{animation:none!important}'; document.head.appendChild(s); }
  return { ok: true };
`;
const animCensus = () => ex(`const c = {}; for (const a of document.getAnimations()) { const n = a.animationName || 'other'; c[n] = (c[n] || 0) + 1; } return c;`);
const frameStat = (full) => {
  const F = window.__cpuFrames; if (!F) return null;
  const out = { frames: F.frames, fast: F.fast, max: +F.max.toFixed(1), jankN: F.jank.length, ltN: F.lt.n, ltMs: +F.lt.ms.toFixed(1), ltMax: +F.lt.max.toFixed(1), ltErr: F.lt.err || null };
  if (full) { const j = [...F.jank].sort((a, b) => a - b); out.jank = { p50: j.length ? +j[Math.floor(j.length / 2)].toFixed(1) : 0, p95: j.length ? +j[Math.floor(j.length * 0.95)].toFixed(1) : 0, max: j.length ? +j[j.length - 1].toFixed(1) : 0, worst: [...j].reverse().slice(0, 10) }; out.refreshCallsMs = (window.__cpuPerf.refreshCallsMs || []).slice().sort((a, b) => a - b); }
  return out;
};
const pageStat = (full) => ex(`const fs_ = (${frameStat.toString()})(${jsq(!!full)}); return { ...window.__cpuPerf, refreshCallsMs: undefined, views: window.__cpuViews, frames: fs_, anims: Object.fromEntries(Object.entries((() => { const c = {}; for (const a of document.getAnimations()) { const n = a.animationName || 'other'; c[n] = (c[n] || 0) + 1; } return c; })()).filter(([, v]) => v > 0)), running: !!S.orch.running, working: Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length, logs: (logs || []).length, tasks: (S.tasks || []).length, tab: (document.querySelector('.tab.active') || {}).id || null, probes: { avWorking: document.querySelectorAll('.avatar.working').length, avTotal: document.querySelectorAll('.avatar').length, dots: document.querySelectorAll('.dot').length, spins: document.querySelectorAll('.typing .spin').length, avWhere: [...document.querySelectorAll('.avatar.working')].slice(0, 3).map((a) => (a.parentElement || {}).className || '') } }`);

// Bulk history through the Store API (lock-safe next to the app's own Store instance): the
// renderer only sees it after the next refresh, like data written by agents' board MCPs.
function bulkSeed(dir, nodes) {
  const { Store } = require(path.join(APP, 'src/store.js'));
  const U = require(path.join(APP, 'src/usage.js'));
  const store = new Store(dir);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const verbs = ['Fix', 'Refactor', 'Profile', 'Wire', 'Document', 'Harden', 'Migrate', 'Cache'];
  const objs = ['render path', 'log pane', 'board columns', 'graph layout', 'usage ledger', 'inbox badge'];
  for (let i = 0; i < SEED_TASKS; i++) {
    const t = store.createTask({ title: `${pick(verbs)} the ${pick(objs)} (seed ${i + 1})`, description: 'Seeded history for the CPU baseline board.', assignee: nodes.length ? pick(nodes) : null, createdBy: nodes.length ? pick(nodes) : null });
    store.updateTask(t.id, { status: i < SEED_TASKS * 0.8 ? 'done' : 'review' });
    if (i % 7 === 0) store.commentTask(t.id, pick(nodes) || 'human', 'Synthetic comment: measured the render path, the numbers point at the full renderAll fan-out.');
  }
  for (let i = 0; i < SEED_LOGS; i++) store.appendLog({ nodeId: pick(nodes) || 'system', kind: pick(['text', 'tool', 'tool_result', 'system']), text: `seed line ${i}: walked the ${pick(objs)}; ${'context '.repeat(6).trim()}`, at: Date.now() - (SEED_LOGS - i) * 1200, level: 'info' });
  for (let i = 0; i < SEED_RUNS; i++) {
    const started = Date.now() - (SEED_RUNS - i) * 45000;
    const run = U.newRun({ nodeId: pick(nodes) || 'system', agent: 'CPU', task: 'seed', model: 'perf-1', runtime: 'claude', provider: 'synthetic', inputTokens: 800 + (i % 40) * 97, outputTokens: 120 + (i % 17) * 31, cacheReadTokens: 40000 + i * 13, numTurns: 3, reportedCostUsd: 0.004 });
    run.startedAt = new Date(started).toISOString();
    store.addRun(U.finishRun(run, { code: 0, env: {}, billingMode: 'auto', startedMs: started }));
  }
}

async function seed() {
  return ex(`
    const p = await call('createProject', ${jsq('CPU baseline ' + SCENARIO + (FREEZE ? ' freeze:' + FREEZE : '') + (ANIM !== 'on' ? ' anim:' + (ANIM_OFF || ANIM) : ''))});
    switchTo({ p: p.id }); await w(600); await refresh();
    await call('saveSettings', { claudePath: ${jsq(CLI)}, useWorktrees: false, maxConcurrency: Math.max(2, ${AGENTS}), maxRuns: 64 });
    const nodes = [];
    for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'CPU-' + (i + 1), role: 'Dev', x: 120 + i * 260, y: 130, runtime: 'claude', model: 'perf-1' }));
    if (nodes.length > 1) await call('addEdge', nodes[0].id, nodes[1].id, 'assign');
    for (let i = 0; i < ${AGENTS}; i++) await call('createTask', { title: 'CPU streaming task ' + (i + 1), description: 'Keep the team busy with synthetic streaming work for the CPU baseline.', assignee: nodes[i].id });
    await refresh();
    return { project: ctx.p, dir: S.dir, nodes: nodes.map((n) => n.id) };
  `);
}

async function main() {
  await WAIT(1200);
  const seeded = await seed();
  const doSeed = SCENARIO === 'feedidle' || SCENARIO === 'feed';
  if (doSeed) bulkSeed(seeded.dir, seeded.nodes);
  console.log(`[cpu-perf] scenario=${SCENARIO} seeded=${doSeed} agents=${seeded.nodes.length} streamSeconds=${STREAM_SECONDS}`);
  await ex(`await refresh(); showTab(${jsq(TAB)}); await w(400);`);
  const inst = await ex(INSTRUMENT);
  console.log('[cpu-perf] instrumented', JSON.stringify(inst));

  let working = 0;
  if (RUN) {
    await ex(`await call('run')`);
    for (let t = 0; t < 250 && working < AGENTS; t++) { await WAIT(100); working = await ex(`return Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length`) || 0; }
    if (!working) {
      const diag = await ex(`return { agents: S.orch.agents, tasks: (S.tasks || []).map((t) => t.id + ' ' + t.status + ' -> ' + t.assignee), logs: (logs || []).slice(-10) }`);
      throw new Error('no agent started streaming — diagnostics: ' + JSON.stringify(diag, null, 2));
    }
    console.log(`[cpu-perf] ${working}/${AGENTS} agents working`);
  }
  await WAIT(WARM_MS);

  // Measurement window: main-process event-loop histogram + appendLog probe window start.
  EL.enable();
  const ioStart = { calls: IO.calls, totalMs: IO.totalMs };

  // Sampling: app.getAppMetrics() reports per-process cpu.percentCPUUsage over the interval
  // since the previous call — a 1s cadence averaged over the window is the wall-average CPU%.
  const series = [];
  const t0 = Date.now();
  let firstMetrics = null;
  while (Date.now() - t0 < DURATION_MS) {
    const at = Date.now();
    const metrics = app.getAppMetrics();
    if (!firstMetrics) firstMetrics = metrics;
    let page = null;
    try { page = await pageStat(); } catch (e) { page = { error: String(e && e.message || e) }; }
    series.push({ at, procs: metrics.map((m) => ({ pid: m.pid, type: m.type, name: m.name, cpu: m.cpu ? m.cpu.percentCPUUsage : 0, wake: m.cpu ? m.cpu.idleWakeupsPerSecond : 0, mem: m.memory ? m.memory.workingSetSize : 0 })), page });
    await WAIT(Math.max(0, 1000 - (Date.now() - at)));
  }
  EL.disable();
  const ioWin = { calls: IO.calls - ioStart.calls, totalMs: +(IO.totalMs - ioStart.totalMs).toFixed(1), maxMs: +IO.maxMs.toFixed(2), over5: IO.over5, over20: IO.over20, slowest: [...IO.slowest] };
  const elStat = (() => { const us = (ns) => +((ns || 0) / 1000).toFixed(2); return { p50: us(EL.percentile(50)), p95: us(EL.percentile(95)), p99: us(EL.percentile(99)), max: us(EL.max), mean: us(EL.mean) }; })();
  const end = await pageStat(true).catch(() => ({}));
  const result = summarize(series, { firstMetrics, ioWin, elStat }, end);
  fs.writeFileSync(path.join(OUT, 'cpu-baseline.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, 'cpu-baseline.md'), markdown(result));
  console.log('\n' + markdown(result));
  console.log(`[cpu-perf] wrote ${path.join(OUT, 'cpu-baseline.json')}`);
  // Run scenarios leave the orchestrator streaming: stop first so procguard/watchdog tear-down
  // is orderly — an abrupt app.exit mid-run can orphan helper processes and delay cli.js exit.
  if (RUN) { try { await ex(`await call('stop')`); } catch {} await WAIT(1500); }
  app.exit(failed ? 1 : 0);
  setTimeout(() => process.exit(failed ? 1 : 0), 2000).unref();
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function summarize(series, extra, end) {
  const buckets = { renderer: [], gpu: [], main: [], utility: [] };
  const pickBucket = (m) => /gpu/i.test(m.type) ? 'gpu' : /renderer|web view|^tab$/i.test(m.type) ? 'renderer' : /^browser$/i.test(m.type) ? 'main' : /utility/i.test(m.type) ? 'utility' : null;
  for (const s of series) {
    const sums = { renderer: 0, gpu: 0, main: 0, utility: 0 };
    for (const p of s.procs) { const b = pickBucket(p); if (b) sums[b] += p.cpu; }
    for (const k of Object.keys(sums)) buckets[k].push(sums[k]);
  }
  const stat = (a) => ({ n: a.length, avg: +avg(a).toFixed(2), p95: +pct(a, 0.95).toFixed(2), max: +Math.max(...a, 0).toFixed(2) });
  const pages = series.map((s) => s.page).filter((p) => p && !p.error);
  const first = pages[0] || {}, last = pages[pages.length - 1] || end || {};
  const counter = (k) => +((Number(last[k] || 0) - Number(first[k] || 0))).toFixed(1);
  const secs = DURATION_MS / 1000;
  const io = extra.ioWin || {};
  const el = extra.elStat || {};
  // Full-sample stats (jank percentiles, per-refresh-call list) only ride on the final
  // pageStat(true) — prefer it, fall back to the last window sample.
  const fr = (end && end.frames && end.frames.jank ? end.frames : last.frames) || {};
  const pf = (a, q) => (a.length ? +a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(2) : 0);
  const views = (end && end.views) || last.views || {};
  const refreshCalls = (fr && fr.refreshCallsMs) || [];
  return {
    env: {
      scenario: SCENARIO, freeze: FREEZE, anim: ANIM === 'off' ? 'off' : ANIM_OFF ? 'off:' + ANIM_OFF : 'on', tab: TAB,
      durationSecs: secs, warmMs: WARM_MS, seeds: SCENARIO === 'feedidle' || SCENARIO === 'feed' ? { tasks: SEED_TASKS, logs: SEED_LOGS, runs: SEED_RUNS } : null,
      streamEps: STREAM_EPS, loadavg1m: os.loadavg()[0], platform: `${os.platform()} ${os.arch()} cpus=${os.cpus().length}`,
      electron: process.versions.electron, commit: (() => { try { return require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
    },
    cpu: { renderer: stat(buckets.renderer), gpu: stat(buckets.gpu), main: stat(buckets.main), utility: stat(buckets.utility) },
    io: { // (a) main-thread appendLog block time inside the live window
      callsPerSec: +((io.calls || 0) / secs).toFixed(1),
      blockedMsPerSec: +(((io.totalMs || 0)) / secs).toFixed(2),
      avgMsPerCall: io.calls ? +(io.totalMs / io.calls).toFixed(3) : 0,
      maxMsPerCall: io.maxMs || 0, callsOver5ms: io.over5 || 0, callsOver20ms: io.over20 || 0,
      slowestCallsMs: io.slowest || [], eventLoopMs: el,
    },
    frames: fr.jank ? { // (b) renderer long frames while streaming
      fps: +((fr.frames || 0) / secs).toFixed(1),
      jankPerSec: +((fr.jankN || 0) / secs).toFixed(2), jankOver34ms: fr.jankN || 0,
      jankP50ms: fr.jank.p50, jankP95ms: fr.jank.p95, jankMaxMs: fr.jank.max, worstFramesMs: fr.jank.worst,
      longTasks: { perSec: +((fr.ltN || 0) / secs).toFixed(2), blockedMsPerSec: +((fr.ltMs || 0) / secs).toFixed(2), totalMs: +(fr.ltMs || 0).toFixed(0), maxMs: fr.ltMax || 0, err: fr.ltErr },
    } : { note: 'no frame probe sample' },
    views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { n: v.n, perSec: +(v.n / secs).toFixed(2), msTotal: +v.ms.toFixed(1), msPerSec: +(v.ms / secs).toFixed(2), avgMs: v.n ? +(v.ms / v.n).toFixed(2) : 0, maxMs: +v.max.toFixed(2) }])),
    counts: {
      feedKeyPerSec: +(counter('feedCalls') / secs).toFixed(2), feedKeyMsTotal: counter('feedMs'),
      rebuildsPerSec: +(counter('rebuilds') / secs).toFixed(2), rebuildMsTotal: counter('rebuildMs'),
      refreshPerSec: +(counter('refreshCalls') / secs).toFixed(2), refreshMsTotal: counter('refreshMs'),
      tickPerSec: +(counter('tickCalls') / secs).toFixed(2), tickMsTotal: counter('tickMs'),
    },
    refresh: { callsMs: refreshCalls.length ? { n: refreshCalls.length, p50: pf(refreshCalls, 0.5), p95: pf(refreshCalls, 0.95), max: refreshCalls[refreshCalls.length - 1] } : null }, // (c)
    page: { working: last.working, running: last.running, logs: last.logs, tasks: last.tasks, tab: last.tab, anims: last.anims || {}, probes: last.probes || {} },
    sample0Types: (extra.firstMetrics || []).map((m) => `${m.type}(${m.pid})`),
    series: series.map((s) => ({ at: s.at, ...Object.fromEntries(Object.entries({ renderer: 0, gpu: 0, main: 0, utility: 0 }).map(([k]) => [k, +s.procs.filter((p) => pickBucket(p) === k).reduce((acc, p) => acc + p.cpu, 0).toFixed(2)])) })),
  };
}

function markdown(r) {
  const c = r.counts;
  return `# CPU baseline — ${r.env.scenario}${r.env.freeze ? ' · freeze:' + r.env.freeze : ''}${r.env.anim !== 'on' ? ' · anim:' + r.env.anim : ''}

${r.env.durationSecs}s window · ${r.env.platform} · electron ${r.env.electron} · commit ${String(r.env.commit).slice(0, 9)} · load1m ${r.env.loadavg1m}
Seeds: ${r.env.seeds ? `${r.env.seeds.tasks} tasks / ${r.env.seeds.logs} logs / ${r.env.seeds.runs} runs` : 'none'} · stream ${r.env.streamEps} ev/s · agents working at end: ${r.page.working} · logs: ${r.page.logs} · anims: ${JSON.stringify(r.page.anims)}

| process | avg % | p95 % | max % |
|---|---:|---:|---:|
| renderer | ${r.cpu.renderer.avg} | ${r.cpu.renderer.p95} | ${r.cpu.renderer.max} |
| gpu | ${r.cpu.gpu.avg} | ${r.cpu.gpu.p95} | ${r.cpu.gpu.max} |
| main | ${r.cpu.main.avg} | ${r.cpu.main.p95} | ${r.cpu.main.max} |

| attribution | /s | Σ ms |
|---|---:|---:|
| Chat.feedKey (every renderChat entry) | ${c.feedKeyPerSec} | ${c.feedKeyMsTotal} |
| Chat.roomEvents (full feed rebuilds) | ${c.rebuildsPerSec} | ${c.rebuildMsTotal} |
| refresh (2s poll, async incl. IPC) | ${c.refreshPerSec} | ${c.refreshMsTotal} |
| renderChatBody (event-driven room draws) | ${c.tickPerSec} | ${c.tickMsTotal} |

## Main-thread log I/O (appendLog, live window)

- ${r.io.callsPerSec} appendLog calls/s · avg ${r.io.avgMsPerCall} ms/call · **${r.io.blockedMsPerSec} ms/s main thread blocked in appendLog**
- worst single call ${r.io.maxMsPerCall} ms · calls >5ms: ${r.io.callsOver5ms} · >20ms: ${r.io.callsOver20ms} · slowest: [${r.io.slowestCallsMs.join(', ')}]
- main event-loop delay (Electron main: Node-timer based, p50/p95 unreliable — Chromium pumps the loop): max ${r.io.eventLoopMs.max} ms

## Renderer frames while streaming

${r.frames.fps !== undefined ? `- fps ${r.frames.fps} · jank frames (>34ms) ${r.frames.jankOver34ms} (${r.frames.jankPerSec}/s) · jank p50 ${r.frames.jankP50ms} ms · p95 ${r.frames.jankP95ms} ms · max ${r.frames.jankMaxMs} ms
- long tasks (>50ms): ${r.frames.longTasks.perSec}/s · ${r.frames.longTasks.blockedMsPerSec} ms/s main-thread blocked · worst ${r.frames.longTasks.maxMs} ms` : '- ' + (r.frames.note || 'no frame data')}
- 2s poll per call: ${r.refresh.callsMs ? 'p50 ' + r.refresh.callsMs.p50 + ' ms · p95 ' + r.refresh.callsMs.p95 + ' ms · max ' + r.refresh.callsMs.max + ' ms (n=' + r.refresh.callsMs.n + ')' : 'n/a'}

${Object.keys(r.views).length ? `| view rebuild | n | /s | Σ ms | ms/s | avg ms | max ms |
|---|---:|---:|---:|---:|---:|---:|
${Object.entries(r.views).map(([k, v]) => `| ${k} | ${v.n} | ${v.perSec} | ${v.msTotal} | ${v.msPerSec} | ${v.avgMs} | ${v.maxMs} |`).join('\n')}
` : '(leaf view rebuilds: none fired — heavy views sig-guard on hidden tabs; visible rebuild cost is Chat.roomEvents above)\n'}`;
}
