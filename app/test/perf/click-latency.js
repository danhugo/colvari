#!/usr/bin/env node
'use strict';
/*
 * Repeatable renderer perf baseline (t_f02c2572): click latency while agents stream.
 *
 * Run from app/:
 *   node test/perf/click-latency.js            # defaults: 4 agents, 4 tasks, ~20s sampling
 *   PERF_OUT=/tmp/colvari-perf node test/perf/click-latency.js
 *
 * What it does:
 *  1. Boots the real Electron main process in GUI test mode (isolated data root, no
 *     single-instance lock, procguard on children).
 *  2. Provisions a throwaway project: PERF_AGENTS nodes, PERF_TASKS ready tasks, the claude
 *     runtime pointed at test/perf/stream-cli.js.
 *  3. Starts the orchestrator so every agent streams synthetic events through the REAL
 *     pipeline (spawnRun -> onEvent -> log/state IPC -> renderer refresh/renderAll).
 *  4. While streaming: fires real input clicks (webContents.sendInputEvent) at every tab
 *     button and times input -> paint. Instruments the renderer by wrapping the live render*
 *     functions and squad.call (plus PerformanceObserver longtasks).
 *  5. Writes baseline.json + baseline.md to PERF_OUT (default: a fresh temp dir) and stops.
 *
 * No app source is modified; all instrumentation is injected at runtime.
 *
 * Metric endpoint (v2, t_fd3a15c4): "first quiet paint" — the first frame painted after the
 * click's dispatch finished in which (a) no render/refresh work started during that frame's
 * interval and (b) every such call started since the click has ended. It keys on the wrapped
 * render* surface as a whole, NOT on renderAll — so it stays meaningful once track 1 stops
 * calling renderAll on clicks. The legacy renderAll-endpoint is still computed per click
 * (clicks.statLegacy) so numbers before/after the endpoint change stay comparable.
 *
 * Extra knobs (t_fd3a15c4):
 *   PERF_APP_DIR=<dir>  boot the app from this dir instead of ../.. (A/B: same harness,
 *                       different commit — set by ab-gate.js)
 *   PERF_TRACE_MS=<ms>  capture a CPU profile of renderer AND main process for this long
 *                       during the sampling window (one-off function-level trace; perturbs
 *                       the run, never use inside an A/B comparison)
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(process.env.PERF_APP_DIR || path.join(__dirname, '../..'));
const MAIN = path.join(APP, 'src/main.js');
const CLI = path.join(__dirname, 'stream-cli.js');
const LOAD_START = os.loadavg();
const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `agents-squad-perf-${Date.now()}`);
const AGENTS = Math.max(2, Number(process.env.PERF_AGENTS || 4));
const TASKS = Math.max(AGENTS, Number(process.env.PERF_TASKS || AGENTS));
const WARM_MS = Number(process.env.PERF_WARM_MS || 4000);   // streaming settle before sampling
const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS || 20000); // minimum sampling window
const CLICK_REPS = Math.max(1, Number(process.env.PERF_CLICK_REPS || 8));
const SEED_TASKS = Number(process.env.PERF_SEED_TASKS || 550);   // board bulk: matches the real 550+ task project
const SEED_LOGS = Number(process.env.PERF_SEED_LOGS || 1500);    // logs.jsonl history the obs tab loads
const SEED_RUNS = Number(process.env.PERF_SEED_RUNS || 200);     // runs.json history for the usage tab
const SEED_INBOX = Number(process.env.PERF_SEED_INBOX || 0);     // open inbox items for the inbox badge/tab (0 = none)
const CARD_CLICKS = Number(process.env.PERF_CARD_CLICKS || 10);  // board card-selection samples
const STREAM_SECONDS = Number(process.env.STREAM_SECONDS || 0) ||
  Math.ceil((WARM_MS + SAMPLE_MS) / 1000) + 25;             // keep agents alive past the window
const STREAM_EPS = Number(process.env.STREAM_EPS || 6);
const TRACE_MS = Number(process.env.PERF_TRACE_MS || 0);     // one-off CPU profile window
const IDLE = !!process.env.PERF_IDLE; // t_6fb709f6: idle phase — seed and click with NO run started
const TRACE_FNS = ['renderLog', 'renderGraph', 'renderBoard', 'renderChat', 'renderOverview', 'renderAll', 'renderInbox', 'renderInboxBadge', 'JSON.parse', '(garbage collector)'];
const TABS = ['chat', 'team', 'board', 'wiki', 'obs', 'usage', 'settings', 'inbox']; // 'overview' is a legacy id (showTab maps it to team) — a no-target drop since it left the tab bar
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const CLICK_BUDGET_MS = (CLICK_REPS * TABS.length + CARD_CLICKS) * 2600; // worst-case poll budget per click

// GUI test mode must be set before main.js loads (isolated root, no single-instance lock,
// child procguard). The marker is removed again before did-finish-load so the built-in
// smoke/guiE2E scenarios never run; TEST_MODE itself stays active.
process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-perf-root-'));
// No $TMPDIR debris (t_8170a988): the throwaway data root dies with the run (the perf app's own
// exit hooks run first). PERF_OUT above is a declared artifact dir and stays.
process.on('exit', () => { try { fs.rmSync(process.env.AGENTS_SQUAD_PROJECT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
// Isolation self-check (t_490eeee8 audit): a regression above would boot the perf instance on
// the live app's data root — refuse instead of clobbering it.
if (!process.env.AGENTS_SQUAD_PROJECT.startsWith(os.tmpdir())) throw new Error('[perf] AGENTS_SQUAD_PROJECT must be an isolated temp root — refusing to run against shared data');
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = String(Math.max(180000,
  STREAM_SECONDS * 1000 + 90000 + TRACE_MS + CLICK_BUDGET_MS));
process.env.AGENTS_SQUAD_DEV = '0'; // no UpdateWatcher in a perf instance

// IPC + push counting must wrap BEFORE main.js registers its handlers: the renderer's
// contextBridge object is frozen (property writes and window.squad reassignment both
// silently no-op), so the main process is the only observable choke point.
const { ipcMain } = require('electron');
const PERF_IPC = []; // every api invoke: { name, ms, at }
const PERF_PUSH = []; // every renderer push: { channel, bytes, at }
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => {
  if (ch !== 'api') return origHandle(ch, fn);
  return origHandle(ch, async (e, name, ...rest) => {
    const t = performance.now();
    try { return await fn(e, name, ...rest); }
    finally { if (PERF_IPC.length < 30000) PERF_IPC.push({ name, ms: performance.now() - t, at: t }); }
  });
};
// Push counting: patch webContents.send as contents are created (state/log only, with sizes).
app.on('web-contents-created', (_e, contents) => {
  const orig = contents.send.bind(contents);
  contents.send = (ch, data) => { if (ch === 'state' || ch === 'log') PERF_PUSH.push({ channel: ch, bytes: data ? JSON.stringify(data).length : 0, at: performance.now() }); return orig(ch, data); };
});

// Own userData: the default is shared with the live app, whose localStorage ctx would point
// the renderer at a project that does not exist in this throwaway data root.
app.setPath('userData', process.env.AGENTS_SQUAD_PROJECT + '/userData');
require(MAIN);
delete process.env.AGENTS_SQUAD_SMOKE;

let wc = null;
let failed = false;
let inst_at = 0; // performance.now() clock of the main process at instrumentation time
let inst_dateAt = 0;
app.on('web-contents-created', (_e, contents) => {
  contents.setBackgroundThrottling(false); // rAF must keep ticking for input->paint timing
  contents.on('did-finish-load', async () => {
    wc = contents;
    try { await main(); } catch (e) { failed = true; console.error('[perf] failed:', e && e.stack || e); }
    app.exit(failed ? 1 : 0);
  });
});

const ex = (js) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${js} })()`);
const jsq = (v) => JSON.stringify(v);

// ---- in-page instrumentation: wrap live render*/refresh + squad.call, count pushes, time clicks.
const INSTRUMENT = `
  if (window.__perf) return { already: true };
  const P = window.__perf = {
    t0: performance.now(), statePushes: 0, logPushes: 0, renders: {}, renderCalls: [], refreshMs: [],
    clicks: [], longs: [], frames: [], lastRenderAllEnd: 0, clickDown: 0, clickRenderAllMs: 0,
  };
  // Ring that evicts the OLDEST entry once full: frames/renders must always cover "now",
  // otherwise a long window fills the buffer with early samples and every peek starves.
  const ring = (a, x, cap = 6000) => { if (a.length >= cap) a.shift(); a.push(x); };
  for (const name of ['renderSidebar','renderGraph','renderPreflightBar','renderNodeForm','renderBoard','renderWiki','renderObs','renderSettings','renderHeader','renderSelfUpdate','renderAlerts','renderUsage','renderOverview','renderInbox','renderInboxBadge','renderGuide','renderChat','renderLog','renderLive']) {
    const f = window[name];
    if (typeof f !== 'function') continue;
    P.renders[name] = [];
    window[name] = function (...a) {
      const t = performance.now(); const rec = { fn: name, s: t, e: null };
      ring(P.renderCalls, rec, 20000);
      try { return f.apply(this, a); } finally { rec.e = performance.now(); ring(P.renders[name], rec.e - t); }
    };
  }
  const ra = window.renderAll;
  window.renderAll = function (...a) {
    const t = performance.now(); const rec = { fn: 'renderAll', s: t, e: null };
    ring(P.renderCalls, rec, 20000);
    try { return ra.apply(this, a); } finally {
      rec.e = performance.now(); const d = rec.e - t;
      ring(P.renders.renderAll = P.renders.renderAll || [], d);
      P.lastRenderAllEnd = rec.e;
      if (P.clickDown && t >= P.clickDown - 1) P.clickRenderAllMs += d;
    }
  };
  const rf = window.refresh;
  window.refresh = async function (...a) {
    const t = performance.now(); const rec = { fn: 'refresh', s: t, e: null };
    ring(P.renderCalls, rec, 20000);
    try { return await rf.apply(this, a); } finally { rec.e = performance.now(); ring(P.refreshMs, rec.e - t); }
  };
  // Push counters: squad is a frozen contextBridge object (reads work, writes don't), but
  // adding listeners is fine. Per-call IPC counts come from the main-process handle wrapper.
  try { window.squad.on('state', () => P.statePushes++); window.squad.on('log', () => P.logPushes++); } catch (e) {}
    if (window.PerformanceObserver) { try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 50) ring(P.longs, { start: Math.round(e.startTime), duration: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {} }
  (function loop() { ring(P.frames, performance.now()); requestAnimationFrame(loop); })();
  // One click sample: arm right before the driver dispatches real mouse input; the capture
  // listener stamps input dispatch (rec.down) and a setTimeout(0) queued from that listener
  // stamps the END of the click's synchronous handler chain (rec.dispatch). The endpoint is
  // then the first frame painted at/after rec.dispatch whose frame interval started no new
  // render/refresh work and by which all work started since the click has ended — the first
  // paint where what the user sees has settled ("first quiet paint", t_fd3a15c4). The legacy
  // renderAll-keyed endpoint is computed in parallel for comparability with pre-v2 numbers.
  P.arm = (label) => {
    const rec = { label, renderAllMs: 0, fnDeltas: null };
    P._rec = rec;
    const dn = () => {
      rec.down = performance.now(); P.clickDown = rec.down; P.clickRenderAllMs = 0;
      setTimeout(() => { rec.dispatch = performance.now(); }, 0);
    };
    window.addEventListener('pointerdown', dn, { capture: true, once: true });
    P._dn = dn;
    return true;
  };
  P.peek = () => {
    const rec = P._rec;
    if (!rec) return { done: true, stale: true };
    if (!rec.down) return { done: false, waiting: 'input' };
    if (!rec.dispatch) return { done: false, waiting: 'dispatch' };
    // Only the tail since the click matters; backward scans keep every peek O(renders since
    // click) instead of O(window), so polling never distorts what we measure.
    const calls = P.renderCalls; const frames = P.frames;
    let lo = calls.length;
    while (lo > 0 && calls[lo - 1].s >= rec.down - 5) lo--;
    let fi = frames.length;
    while (fi > 0 && frames[fi - 1] > rec.dispatch) fi--;
    // First quiet paint: scan frames after the dispatch finished.
    let paint = 0;
    for (let i = fi; i < frames.length; i++) {
      const F = frames[i];
      const prev = frames[i - 1] || 0;
      let quiet = true;
      for (let k = lo; k < calls.length; k++) {
        const r = calls[k];
        if (r.s > F) break;
        const e = r.e == null ? Infinity : r.e;
        if (e > F || (r.s > prev && r.s <= F)) { quiet = false; break; }
      }
      if (quiet) { paint = F; break; }
    }
    // Legacy endpoint: first frame after the last renderAll that started at/after the press.
    const endMarkL = Math.max(rec.down, P.lastRenderAllEnd >= rec.down ? P.lastRenderAllEnd : 0);
    let li = frames.length;
    while (li > 0 && frames[li - 1] > endMarkL) li--;
    const paintL = li < frames.length ? frames[li] : 0;
    if (!paint && !paintL) return { done: false, waiting: 'paint' };
    if (paint) { rec.paint = paint; rec.ms = paint - rec.down; }
    if (paintL) { rec.paintLegacy = paintL; rec.msLegacy = paintL - rec.down; }
    rec.renderAllMs = Math.round(P.clickRenderAllMs * 100) / 100;
    rec.long = P.longs.filter((l) => l.start >= rec.down - 5 && l.start <= Math.max(paint || 0, paintL || 0));
    P.clicks.push(rec);
    window.removeEventListener('pointerdown', P._dn, true);
    P._rec = null; P.clickDown = 0;
    return { done: true, rec };
  };
  return { tabs: [...document.querySelectorAll('button[data-tab]')].map((b) => b.dataset.tab) };
`;

const SUMMARY = `
  const P = window.__perf;
  const q = (a, p) => { const x = a.filter(Number.isFinite).slice().sort((m, n) => m - n); return x.length ? x[Math.min(x.length - 1, Math.floor((x.length - 1) * p))] : 0; };
  const secs = (performance.now() - P.t0) / 1000;
  const stat = (a) => ({ n: a.length, p50: +q(a, .5).toFixed(2), p95: +q(a, .95).toFixed(2), max: a.length ? +Math.max(...a).toFixed(2) : 0, sum: +a.reduce((s, x) => s + x, 0).toFixed(1) });
  const renders = {}; for (const [k, v] of Object.entries(P.renders)) renders[k] = stat(v);
  const bySel = {}; for (const c of P.clicks) if (Number.isFinite(c.ms)) (bySel[c.label] ||= []).push(c.ms);
  // Quiet-paint may not settle inside the poll budget (UI never quiet for 2.5s mid-storm):
  // those samples stay null for the quiet metric and are counted, never crash the summary.
  const fin = (a) => a.filter(Number.isFinite);
  const tabMs = fin(P.clicks.filter((c) => c.label.startsWith('tab:')).map((c) => c.ms));
  const cardMs = fin(P.clicks.filter((c) => c.label.startsWith('card')).map((c) => c.ms));
  const tabMsLegacy = fin(P.clicks.filter((c) => c.label.startsWith('tab:')).map((c) => c.msLegacy));
  const unsettled = P.clicks.filter((c) => !Number.isFinite(c.ms)).length;
  // Per-label settle visibility (t_f468b3a9): a p95 over 4 settled of 24 attempts is an
  // anecdote — every label reports settled vs quiet-unsettled next to its stat.
  const unByLabel = {}; for (const c of P.clicks) if (!Number.isFinite(c.ms)) (unByLabel[c.label] = (unByLabel[c.label] || 0) + 1);
  const settledByLabel = {}; for (const c of P.clicks) if (Number.isFinite(c.ms)) (settledByLabel[c.label] = (settledByLabel[c.label] || 0) + 1);
  return {
    windowSecs: +secs.toFixed(1),
    clock: { perfNow: performance.now(), dateNow: Date.now() }, // converts clicks[].down (page perf clock) to wall time for main-stall correlation
    metric: 'quiet-paint v2 (t_fd3a15c4): first frame after the click dispatch whose interval starts no render/refresh work and by which all work started since the click has ended; legacy renderAll endpoint kept as statLegacy',
    rates: { statePushesPerSec: +(P.statePushes / secs).toFixed(2), logPushesPerSec: +(P.logPushes / secs).toFixed(2), renderAllPerSec: +((P.renders.renderAll || []).length / secs).toFixed(2), refreshPerSec: +(P.refreshMs.length / secs).toFixed(2) },
    renderAll: renders.renderAll || { n: 0 }, renders,
    refresh: stat(P.refreshMs),
    clicks: {
      stat: stat(fin(P.clicks.map((c) => c.ms))),
      unsettledQuiet: unsettled,
      settledQuietByLabel: settledByLabel, unsettledQuietByLabel: unByLabel,
      tabSwitches: stat(tabMs), cardClicks: stat(cardMs),
      statLegacy: stat(fin(P.clicks.map((c) => c.msLegacy))),
      tabSwitchesLegacy: stat(tabMsLegacy),
      byLabel: Object.fromEntries(Object.entries(bySel).map(([k, v]) => [k, stat(v)])),
      samples: P.clicks.map((c) => ({ label: c.label, ms: Number.isFinite(c.ms) ? +c.ms.toFixed(2) : null, msLegacy: Number.isFinite(c.msLegacy) ? +c.msLegacy.toFixed(2) : null, down: Math.round(c.down), renderAllMs: c.renderAllMs, longDuring: (c.long || []).length })),
    },
    longTasks: { total: P.longs.length, maxMs: P.longs.length ? Math.max(...P.longs.map((l) => l.duration)) : 0, samples: P.longs.slice(-200) },
    logLines: logs.filter((l) => l.projectId === ctx.p).length,
    agentsWorking: Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length,
    running: !!S.orch.running,
    activeTab: (document.querySelector('.tab.active') || {}).id || null,
  };
`;

async function seed() {
  const res = await ex(`
    const p = await call('createProject', 'Click latency baseline');
    switchTo({ p: p.id }); await w(600); await refresh();
    await call('saveSettings', { claudePath: ${jsq(CLI)}, useWorktrees: false, maxConcurrency: ${AGENTS}, maxRuns: ${TASKS + 2} });
    const nodes = [];
    for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'Perf-' + (i + 1), role: 'Dev', x: 90 + (i % 3) * 240, y: 110 + Math.floor(i / 3) * 190, runtime: 'claude', model: 'perf-1' }));
    for (const n of nodes.slice(1)) await call('addEdge', nodes[0].id, n.id, 'assign');
    const tasks = [];
    for (let i = 0; i < ${TASKS}; i++) tasks.push((await call('createTask', { title: 'Streaming perf task ' + (i + 1), description: 'Keep the team busy with synthetic streaming work for the perf baseline.', assignee: nodes[i % nodes.length].id })).id);
    await refresh();
    return { project: ctx.p, team: S.teamId, dir: S.dir, nodes: nodes.map((n) => n.id), tasks };
  `);
  return res;
}

// Bulk board/log/run history through the Store API (same process, lock-safe): the renderer only
// sees it after the next refresh, exactly like data written by agents' board MCP servers.
function bulkSeed(dir, nodes) {
  const { Store } = require(path.join(APP, 'src/store.js'));
  const U = require(path.join(APP, 'src/usage.js'));
  const store = new Store(dir);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const verbs = ['Fix', 'Refactor', 'Profile', 'Wire', 'Document', 'Harden', 'Migrate', 'Cache', 'Debounce', 'Instrument'];
  const objs = ['render path', 'log pane', 'board columns', 'graph layout', 'usage ledger', 'inbox badge', 'wake sweep', 'stall watchdog', 'settings form', 'wiki editor'];
  const dist = [['done', Math.floor(SEED_TASKS * 0.8)], ['review', Math.floor(SEED_TASKS * 0.05)], ['in_progress', Math.floor(SEED_TASKS * 0.05)], ['waiting_for_human', Math.floor(SEED_TASKS * 0.03)], ['merge_conflict', Math.floor(SEED_TASKS * 0.01)]];
  const tids = [];
  let seeded = 0;
  for (const [status, count] of dist) {
    for (let i = 0; i < count; i++) {
      const t = store.createTask({ title: `${pick(verbs)} the ${pick(objs)} (seed ${++seeded})`, description: 'Seeded history for the perf baseline board. Includes a realistic description so card snippets render.', assignee: Math.random() < 0.15 ? null : pick(nodes), createdBy: pick(nodes) });
      tids.push(t.id);
      store.updateTask(t.id, { status });
      if (seeded % 7 === 0) store.commentTask(t.id, pick(nodes), 'Synthetic comment: measured the render path, the numbers point at the full renderAll fan-out on every push.');
    }
  }
  // The live queue: todo tasks each agent chews through so the stream never runs dry mid-window.
  for (let i = 0; i < TASKS * 6; i++) store.createTask({ title: `Streaming perf task (queue ${i + 1})`, description: 'Keep the team busy with synthetic streaming work for the perf baseline.', assignee: nodes[i % nodes.length], createdBy: nodes[0] });
  for (let i = 0; i < SEED_LOGS; i++) store.appendLog({ nodeId: pick(nodes), kind: pick(['text', 'tool', 'tool_result', 'system']), text: `seed line ${i}: walked the ${pick(objs)}; ${'context '.repeat(6).trim()}`, at: Date.now() - (SEED_LOGS - i) * 1200, level: 'info' });
  for (let i = 0; i < SEED_RUNS; i++) {
    const started = Date.now() - (SEED_RUNS - i) * 45000;
    const run = U.newRun({ nodeId: pick(nodes), agent: 'Perf', taskId: null, task: 'seed', model: 'claude-sonnet-4-5', runtime: 'claude', provider: 'anthropic', inputTokens: 800 + (i % 40) * 97, outputTokens: 120 + (i % 17) * 31, cacheReadTokens: 40000 + i * 13, numTurns: 3 + (i % 5), reportedCostUsd: 0.004 + (i % 9) * 0.0011 });
    run.startedAt = new Date(started).toISOString();
    store.addRun(U.finishRun(run, { code: 0, env: {}, billingMode: 'auto', startedMs: started }));
  }
  // Open inbox items (t_4b420de0): questions and approvals against seeded tasks. addInbox
  // (not askHuman) so none of the bulk tasks flips to waiting_for_human — the board
  // distribution above must stay intact for the card/column numbers.
  const qs = ['Should I also update the README for this change?', 'The schema migration would drop the legacy table — proceed?', 'Two implementations pass the tests: cache-first or invalidate-on-write?', 'This touches the permissions surface — want a security pass before merge?'];
  for (let i = 0; i < SEED_INBOX; i++) {
    const approval = i % 3 !== 2; // 2/3 approvals, 1/3 questions — the renderInbox kinds mix
    store.addInbox({
      kind: approval ? 'approval' : 'question',
      taskId: i % 4 === 0 ? pick(tids) : null,
      nodeId: i % 5 === 0 ? null : pick(nodes),
      question: approval ? `Approve merge of ${pick(verbs).toLowerCase()} ${pick(objs)} (inbox seed ${i + 1})?` : `${pick(qs)} (inbox seed ${i + 1})`,
      choices: approval ? [] : ['Yes', 'No', 'Discuss first'],
    });
  }
  const lt = store.createTask({ title: 'perf load target (writer churn)', description: 'Target task for external board-writer churn during the load phase.', assignee: nodes[0], createdBy: nodes[0] });
  return { seededTasks: seeded + TASKS * 6, seededLogs: SEED_LOGS, seededRuns: SEED_RUNS, seededInbox: SEED_INBOX, loadTarget: lt.id };
}

// One real input click at [x,y] (webContents coordinates), timed input-dispatch -> paint.
// Returns {ok, rec?|detail?}: dropped samples carry a reason (t_f468b3a9) — last peek waiting
// state, whether input ever dispatched, polls spent, wall ms — so a deterministic drop subset
// (was 16/82 in every run with zero diagnostics) is explainable from the summary alone.
async function clickAt(label, xy) {
  if (!xy) return { ok: false, detail: { label, waiting: 'no-target' } };
  await ex(`return window.__perf.arm(${jsq(label)})`);
  for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: xy[0], y: xy[1], button: 'left', clickCount: 1 });
  const t0 = Date.now(); let waiting = 'unpolled';
  for (let t = 0; t < 100; t++) {
    const s = await ex(`return window.__perf.peek()`);
    if (s && s.done) return s.stale ? { ok: false, detail: { label, waiting: 'stale' } } : { ok: true, rec: s.rec };
    if (s && s.waiting) waiting = s.waiting;
    await WAIT(25);
  }
  return { ok: false, detail: { label, waiting, sawInput: waiting !== 'input', polls: 100, ms: Date.now() - t0 } }; // paint never observed — counted as dropped
}

async function clickOnce(label, sel) {
  const r = await ex(`const b = $('${sel}'); if (!b) return null; const rc = b.getBoundingClientRect(); return [Math.round(rc.x + rc.width / 2), Math.round(rc.y + rc.height / 2)];`);
  return clickAt(label, r);
}

// ---- function-level trace: self-time split for renderer AND main process (t_fd3a15c4 point 4).
// Renderer via the DevTools debugger (wc.debugger, Profiler domain); main via an inspector
// Session on this process — getAll's JSON.parse and the store live in main, render* in the
// renderer, so a one-sided profile would answer the wrong question.
function aggregateProfile(profile, intervalUs) {
  const byFn = new Map();
  for (const node of (profile && profile.nodes) || []) {
    const name = (node.callFrame && node.callFrame.functionName) || '(anonymous)';
    byFn.set(name, (byFn.get(name) || 0) + (node.hitCount || 0));
  }
  const msPerHit = intervalUs / 1000;
  const list = [...byFn.entries()].map(([name, hits]) => ({ name, selfMs: +(hits * msPerHit).toFixed(1) }))
    .sort((a, b) => b.selfMs - a.selfMs);
  const total = list.reduce((s, x) => s + x.selfMs, 0);
  return {
    totalSelfMs: +total.toFixed(0),
    top: list.slice(0, 18),
    watch: TRACE_FNS.map((n) => list.find((x) => x.name === n)).filter(Boolean),
  };
}

async function startTrace(minMs) {
  const out = { minMs, intervalUs: 200, startedAt: 0 };
  const inspector = require('inspector');
  const session = new inspector.Session();
  session.connect();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  // Electron ≥ v12: sendCommand returns a Promise (the old 3rd-arg callback is gone — a
  // string there is read as a debugger sessionId and the promise is dropped, hanging us).
  const cmd = (m, p) => wc.debugger.sendCommand(m, p);
  try {
    wc.debugger.attach('1.3');
    await cmd('Profiler.enable');
    await cmd('Profiler.setSamplingInterval', { interval: out.intervalUs });
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: out.intervalUs });
    await cmd('Profiler.start');
    await post('Profiler.start');
    out.startedAt = Date.now();
  } catch (e) {
    out.error = String((e && e.message) || e);
    try { session.disconnect(); } catch {}
    try { wc.debugger.detach(); } catch {}
    return async () => out;
  }
  console.log(`[perf] tracing renderer + main (min ${minMs} ms, covers the click campaign)`);
  // Non-blocking: profilers run across the click campaign; the closer enforces the
  // minimum window and then stops + splits self time by function.
  return async () => {
    const elapsed = Date.now() - out.startedAt;
    if (elapsed < minMs) await WAIT(minMs - elapsed);
    let rProf = null, mProf = null;
    try {
      rProf = (await cmd('Profiler.stop')).profile;
      mProf = (await post('Profiler.stop')).profile;
    } catch (e) {
      out.error = String((e && e.message) || e);
      try { session.disconnect(); } catch {}
      try { wc.debugger.detach(); } catch {}
      return out;
    }
    out.windowMs = Date.now() - out.startedAt;
    fs.writeFileSync(path.join(OUT, 'trace-renderer.cpuprofile'), JSON.stringify(rProf));
    fs.writeFileSync(path.join(OUT, 'trace-main.cpuprofile'), JSON.stringify(mProf));
    out.renderer = aggregateProfile(rProf, out.intervalUs);
    out.main = aggregateProfile(mProf, out.intervalUs);
    out.files = ['trace-renderer.cpuprofile', 'trace-main.cpuprofile'];
    try { session.disconnect(); } catch {}
    try { wc.debugger.detach(); } catch {}
    return out;
  };
}

async function main() {
  await WAIT(1200);
  const seeded = await seed();
  const bulk = bulkSeed(seeded.dir, seeded.nodes);
  console.log('[perf] seeded', JSON.stringify({ ...seeded, ...bulk }));
  await ex(`await refresh(); showTab('chat'); await w(300);`);
  const inst = await ex(INSTRUMENT);
  inst_at = performance.now(); inst_dateAt = Date.now();
  const LOAD_MID = os.loadavg();
  console.log('[perf] instrumented', JSON.stringify(inst));

  let working = 0;
  if (IDLE) {
    console.log('[perf] IDLE phase: board seeded, NO run started (PERF_IDLE=1)');
  } else {
    await ex(`await call('run')`);
    for (let t = 0; t < 250 && working < Math.min(2, AGENTS); t++) { await WAIT(100); working = await ex(`return Object.values(S.orch.agents || {}).filter(a => a.status === 'working').length`) || 0; }
    console.log(`[perf] ${working}/${AGENTS} agents working, streaming ${STREAM_EPS} ev/s for ~${STREAM_SECONDS}s`);
    if (!working) {
      const diag = await ex(`return { agents: S.orch.agents, logs: logs.slice(-40).map(l => l.kind + ': ' + String(l.text).slice(0, 160)), tasks: S.tasks.filter(t => ['todo','in_progress'].includes(t.status)).map(t => t.id + ' ' + t.status + ' -> ' + t.assignee) }`);
      throw new Error('no agent started streaming — diagnostics: ' + JSON.stringify(diag, null, 2));
    }
  }

  await WAIT(WARM_MS);
  const sampleStart = Date.now();
  // One-off function-level trace (PERF_TRACE_MS): profile renderer + main process while the
  // click campaign runs, then split self-time by function. Perturbs the run — never use it
  // inside an A/B comparison.
  const stopTrace = TRACE_MS > 0 ? await startTrace(TRACE_MS) : null;  // Click campaign: every tab, CLICK_REPS rounds, real input events, interleaved so each tab
  // sees a different streaming phase. Then board card-selection clicks (a heavy non-tab button).
  let attempted = 0, dropped = 0, tabsSkipped = 0; const droppedDetails = [];
  const land = (label, r) => { attempted++; if (!r || !r.ok) { dropped++; droppedDetails.push((r && r.detail) || { label, waiting: 'unknown' }); } };
  for (let rep = 0; rep < CLICK_REPS; rep++) {
    // No #tabs scope: settings lives in the topbar and inbox in the sidebar — the old scoped
    // selector never matched them, so 2 tabs × CLICK_REPS clicks were deterministic no-target
    // drops (the constant 16/82, t_5ab07112). data-tab is document-unique.
    // Only tabs present in THIS app's nav (t_759c7498): a removed tab (overview on the
    // One-Team-view branch) would otherwise burn deterministic no-target drops per run
    // from the same 20% validity budget the quiet-paint storm already taxes.
    for (const tab of TABS) {
      if (inst.tabs && inst.tabs.length && !inst.tabs.includes(tab)) { tabsSkipped++; continue; }
      land(`tab:${tab}`, await clickOnce(`tab:${tab}`, `button[data-tab="${tab}"]`));
    }
  }
  await ex(`showTab('board'); await w(400);`);
  const cards = await ex(`return [...document.querySelectorAll('.card')].slice(0, ${CARD_CLICKS}).map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + Math.min(14, r.height / 2))]; })`);
  for (const [i, xy] of (cards || []).entries()) land(`card#${i + 1}`, await clickAt(`card#${i + 1}`, xy));
  const clickWall = Date.now() - sampleStart;
  await WAIT(Math.max(500, SAMPLE_MS - clickWall)); // keep sampling pushes after the clicks
  const summary = await ex(SUMMARY);
  if (stopTrace) summary.trace = await stopTrace();

  // Main-process view: exact per-call IPC round-trips (name, duration) and push traffic.
  const ipcWin = PERF_IPC.filter((c) => c.at >= inst_at);
  const pushWin = PERF_PUSH.filter((p) => p.at >= inst_at);
  const secs = Math.max(0.001, (Date.now() - inst_dateAt) / 1000);
  const byName = {}; for (const c of ipcWin) { (byName[c.name] ||= { n: 0, ms: [] }); byName[c.name].n++; byName[c.name].ms.push(c.ms); }
  const q = (a, p) => { const x = a.filter(Number.isFinite).slice().sort((m, n) => m - n); return x.length ? +x[Math.min(x.length - 1, Math.floor((x.length - 1) * p))].toFixed(2) : 0; };
  const allDurs = ipcWin.map((c) => c.ms);
  summary.ipc = {
    total: ipcWin.length, perSec: +(ipcWin.length / secs).toFixed(2),
    perRenderAll: +(ipcWin.length / Math.max(1, summary.renderAll.n)).toFixed(2),
    msP50: q(allDurs, .5), msP95: q(allDurs, .95), msMax: allDurs.length ? Math.max(...allDurs) : 0,
    byName: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, { n: v.n, perSec: +(v.n / secs).toFixed(2), msP50: q(v.ms, .5), msP95: q(v.ms, .95), msMax: v.ms.length ? +Math.max(...v.ms).toFixed(2) : 0 }])),
  };
  const pushes = Object.fromEntries(['state', 'log'].map((ch) => {
    const ps = pushWin.filter((p) => p.channel === ch); const bytes = ps.reduce((s, p) => s + p.bytes, 0);
    return [ch, { n: ps.length, perSec: +(ps.length / secs).toFixed(2), kbPerSec: +(bytes / secs / 1024).toFixed(1), bytesAvg: ps.length ? Math.round(bytes / ps.length) : 0 }];
  }));
  summary.pushesMain = pushes;
  summary.rates.statePushesPerSecMain = pushes.state.perSec;
  summary.rates.logPushesPerSecMain = pushes.log.perSec;

  summary.env = {
    phase: IDLE ? 'idle (board seeded, no run)' : 'load (streaming run + external board writers)',
    platform: `${os.platform()} ${os.arch()} cpus=${os.cpus().length} loadavg1m=${os.loadavg()[0].toFixed(2)}`,
    load: {
      start1m: +LOAD_START[0].toFixed(2), mid1m: +LOAD_MID[0].toFixed(2), end1m: +os.loadavg()[0].toFixed(2),
      start5m: +LOAD_START[1].toFixed(2), end5m: +os.loadavg()[1].toFixed(2),
    },
    ab: { appDir: APP, harnessDir: __dirname },
    electron: process.versions.electron, node: process.versions.node,
    agents: AGENTS, tasks: TASKS, streamSeconds: STREAM_SECONDS, streamEps: STREAM_EPS,
    clickReps: CLICK_REPS, warmMs: WARM_MS, sampleMs: SAMPLE_MS, clickWallMs: clickWall,
    clicksAttempted: attempted, clicksDropped: dropped, tabsSkipped,
    // Drop forensics (t_f468b3a9): why each dropped click never resolved. The once-deterministic
    // 16/82 subset should be attributable from these fields alone.
    clicksDroppedByReason: droppedDetails.reduce((m, d) => { const k = `${d.waiting}`; m[k] = (m[k] || 0) + 1; return m; }, {}),
    clicksDroppedDetails: droppedDetails.slice(-60),
    seedTasks: SEED_TASKS + TASKS * 6, seedLogs: SEED_LOGS, seedRuns: SEED_RUNS, cardClicks: (cards || []).length,
    commit: (() => { try { return require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
    cli: CLI,
  };
  summary.target = {
    clickP95Below100ms: summary.clicks.tabSwitches.p95 < 100,
    longTasksOver50ms: summary.longTasks.total,
    // Gate population: tab switches only (t_fd3a15c4). Card clicks are reported, not gated.
    pass: summary.clicks.tabSwitches.p95 < 100 && summary.longTasks.total === 0,
  };
  fs.writeFileSync(path.join(OUT, 'baseline.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'baseline.md'), renderMd(summary));
  console.log('\n' + renderMd(summary));
  console.log(`[perf] wrote ${path.join(OUT, 'baseline.json')} and baseline.md`);

  if (!IDLE) await ex(`await call('stop')`);
  await WAIT(1200);
}

function renderMd(s) {
  const fmt = (x) => (x == null ? '—' : x);
  const renderRows = Object.entries(s.renders).filter(([k]) => k !== 'renderAll')
    .sort((a, b) => b[1].sum - a[1].sum).slice(0, 14)
    .map(([k, v]) => `| ${k} | ${v.n} | ${fmt(v.p50)} | ${fmt(v.p95)} | ${fmt(v.max)} | ${fmt(v.sum)} |`).join('\n');
  const clickRows = Object.entries(s.clicks.byLabel).map(([k, v]) => `| ${k} | ${v.n} | ${fmt(v.p50)} | ${fmt(v.p95)} | ${fmt(v.max)} |`).join('\n');
  const ipcRows = Object.entries(s.ipc.byName).sort((a, b) => b[1].n - a[1].n).slice(0, 12)
    .map(([k, v]) => `| ${k} | ${v.n} | ${v.perSec} | ${fmt(v.msP50)} | ${fmt(v.msP95)} | ${fmt(v.msMax)} |`).join('\n');
  return `# Click-latency baseline (agents streaming)

Env: ${s.env.platform} · electron ${s.env.electron} · commit ${s.env.commit.slice(0, 9)} · appDir ${s.env.ab.appDir}
Load 1m/5m start→mid→end: ${s.env.load.start1m}/${s.env.load.start5m} → ${s.env.load.mid1m} → ${s.env.load.end1m}/${s.env.load.end5m}
Load: ${s.env.agents} agents × ${s.env.streamEps} ev/s synthetic stream for ~${s.env.streamSeconds}s · board seeded to ~${s.env.seedTasks} tasks (+${s.env.seedRuns} runs, ${s.env.seedLogs} log lines) · sampling window ${s.windowSecs}s

## Headline (metric: first quiet paint — see summary.metric; renderAll only for reference)

- **Tab switches (gated population): p50 ${s.clicks.tabSwitches.p50} ms · p95 ${s.clicks.tabSwitches.p95} ms · max ${s.clicks.tabSwitches.max}** over ${s.clicks.tabSwitches.n} clicks
- Card clicks (reported separately, not gated): p50 ${s.clicks.cardClicks.p50} · p95 ${s.clicks.cardClicks.p95} · max ${s.clicks.cardClicks.max} over ${s.clicks.cardClicks.n}
- All clicks pooled: p50 ${s.clicks.stat.p50}, p95 ${s.clicks.stat.p95}, max ${s.clicks.stat.max} over ${s.clicks.stat.n} — legacy renderAll endpoint on the same clicks: p50 ${s.clicks.statLegacy.p50}, p95 ${s.clicks.statLegacy.p95}
- **Long tasks > 50 ms during window: ${s.longTasks.total}** (max ${s.longTasks.maxMs} ms)
- Clicks attempted ${s.env.clicksAttempted}, dropped ${s.env.clicksDropped}
- renderAll: n=${s.renderAll.n}, p50 ${fmt(s.renderAll.p50)} ms, p95 ${fmt(s.renderAll.p95)} ms, max ${fmt(s.renderAll.max)} ms
- While streaming (renderer-observed): ${s.rates.statePushesPerSec} state pushes/s, ${s.rates.logPushesPerSec} log pushes/s, refresh ${s.rates.refreshPerSec}/s (p50 ${s.refresh.p50} ms)
- Main-process view: ${s.ipc.total} IPC round-trips (${s.ipc.perSec}/s, ${s.ipc.perRenderAll}/renderAll, p50 ${s.ipc.msP50} ms, p95 ${s.ipc.msP95} ms); pushes: state ${s.pushesMain.state.perSec}/s (${s.pushesMain.state.kbPerSec} KB/s), log ${s.pushesMain.log.perSec}/s (${s.pushesMain.log.kbPerSec} KB/s)
- Log lines buffered in the renderer: ${s.logLines}; agents working at end: ${s.agentsWorking}
${s.trace ? `
## Trace — self time by function (${s.trace.windowMs} ms window, ${s.trace.intervalUs} µs sampling)

Renderer (total self ${s.trace.renderer.totalSelfMs} ms): ${s.trace.renderer.top.slice(0, 10).map((x) => `${x.name} ${x.selfMs}`).join(' · ')}
Watched: ${s.trace.renderer.watch.map((x) => `${x.name} ${x.selfMs} ms`).join(' · ') || '—'}

Main process (total self ${s.trace.main.totalSelfMs} ms): ${s.trace.main.top.slice(0, 10).map((x) => `${x.name} ${x.selfMs}`).join(' · ')}
Watched: ${s.trace.main.watch.map((x) => `${x.name} ${x.selfMs} ms`).join(' · ') || '—'}
` : ''}
## render* fn durations (ms)

| fn | n | p50 | p95 | max | Σ ms |
|---|---:|---:|---:|---:|---:|
${renderRows}

## Click latency by target (ms)

| click | n | p50 | p95 | max |
|---|---:|---:|---:|---:|
${clickRows}

## IPC round-trips by name (main-process view)

| call | n | /s | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|---:|
${ipcRows}

## Reproduce

    cd app && PERF_AGENTS=${s.env.agents} PERF_TASKS=${s.env.tasks} PERF_OUT=/tmp/colvari-perf node test/perf/click-latency.js
`;
}

// entry is the did-finish-load handler above — never call main() at script load (wc not ready)
