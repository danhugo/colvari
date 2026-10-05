#!/usr/bin/env node
'use strict';
/*
 * Real-agent chat jank baseline (t_f4f6d15e): REAL helpycode agents, not the synthetic CLI.
 *
 * Run from app/ (Electron main entry — never plain node):
 *   PERF_AGENTS=2 PERF_OUT=/tmp/colvari-perf-real/agents2 \
 *     ./node_modules/.bin/electron test/perf/real-agents-jank.js
 *
 * Boots an isolated throwaway instance of the REAL app (own temp data root, own userData,
 * never touches the live app), seeds a grown board (550 tasks / 1500 logs / 200 runs),
 * queues real tasks for PERF_AGENTS nodes on the REAL helpycode runtime, starts the
 * orchestrator, and while the real agents stream measures:
 *   (a) chat room open/switch -> first full paint (tab switch, task-thread open/close,
 *       team-scope switch) + the long tasks inside each open;
 *   (b) frame times + dropped frames while scrolling the chat feed (real mouseWheel input,
 *       exercising the prepend path) and while messages stream in untouched;
 *   (c) renderer / GPU / main-process CPU (app.getAppMetrics() 1/s, phase-tagged).
 * A CPU profile (wc.debugger Profiler + inspector Session) covers the probe window; every
 * long task inside it is attributed to functions by intersecting its interval with the
 * sample timeline.
 *
 * Knobs: PERF_AGENTS (2), PERF_TASKS_PER_AGENT (3), PERF_REPS (6), PERF_SCROLL_REPS (3),
 *   PERF_TRACE_MS (30000), PERF_STREAM_MS (30000), PERF_SEED_TASKS/LOGS/RUNS (550/1500/200),
 *   PERF_WARM_MS (5000), PERF_STAGGER_MS (8000 when AGENTS>2, else 0), PERF_STALL_MIN
 *   (5 when AGENTS>=5, else 2), PERF_MAX_LOAD (unset; aborts at boot when load1m is above it —
 *   run 5-agent passes with load1m under ~6), PERF_HCPATH, PERF_HC_MODEL, PERF_APP_DIR, PERF_OUT.
 * Screenshots land in PERF_OUT: chat-open / thread-open (first campaign rep), scroll-up (top of
 * the first scroll pass), streaming (mid stream window).
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The harness lives at <repo>/test/perf; the Electron app is the sibling app/ directory.
// (PERF_APP_DIR overrides — e.g. pointing at a worktree's app/.)
const APP = path.resolve(process.env.PERF_APP_DIR || path.join(__dirname, '../..', 'app'));
const MAIN = path.join(APP, 'src/main.js');
const HCPATH = process.env.PERF_HCPATH || '/Users/d/.local/bin/helpycode';
const MODEL = process.env.PERF_HC_MODEL || 'elice/z-ai/glm-5.3-flash';
const LOAD_START = os.loadavg();
const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `agents-squad-realperf-${Date.now()}`);
const AGENTS = Math.max(1, Number(process.env.PERF_AGENTS || 2));
const TASKS_PER_AGENT = Math.max(1, Number(process.env.PERF_TASKS_PER_AGENT || 3));
const REPS = Math.max(2, Number(process.env.PERF_REPS || 6));
const SCROLL_REPS = Math.max(1, Number(process.env.PERF_SCROLL_REPS || 3));
const TRACE_MS = Number(process.env.PERF_TRACE_MS || 60000);
const STREAM_MS = Math.max(10000, Number(process.env.PERF_STREAM_MS || 30000));
const WARM_MS = Number(process.env.PERF_WARM_MS || 5000);
const SEED_TASKS = Number(process.env.PERF_SEED_TASKS || 550);
const SEED_LOGS = Number(process.env.PERF_SEED_LOGS || 1500);
const SEED_RUNS = Number(process.env.PERF_SEED_RUNS || 200);
const AGENT_START_TIMEOUT_MS = Number(process.env.PERF_AGENT_START_TIMEOUT_MS || 180000);
// 5-agent viability (t_c69c2170): queueing every task upfront started AGENTS helpycode CLIs in
// the same second — boot + introspection pinned load ~16, agents starved and the run died in its
// own watchdogs. Tasks are queued one at a time instead (the orchestrator's 1 s dispatch sweep
// starts each as its node frees); the stall watchdog gets proportional headroom so a long model
// thinking pause under 5-way CPU contention is not mistaken for a stall and churn-recovered.
const STAGGER_MS = Math.max(0, Number(process.env.PERF_STAGGER_MS ?? (AGENTS > 2 ? 8000 : 0)));
const STALL_MIN = Number(process.env.PERF_STALL_MIN || (AGENTS >= 5 ? 5 : 2));
const QUEUE_MS = AGENTS * TASKS_PER_AGENT * STAGGER_MS;
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// GUI test mode: isolated data root, no single-instance lock, procguard on spawned children.
process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-realperf-root-'));
// The app's test-instance guard force-exits at this budget; the formula is optimistic when the
// 5-agent campaigns eat their 30 s miss-timeouts under real load (t_a2566d54: a full 5-agent arm
// died at 29 min with phases still running). PERF_BUDGET_MS overrides for those arms.
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = String(Number(process.env.PERF_BUDGET_MS || 0) || AGENT_START_TIMEOUT_MS + QUEUE_MS + TRACE_MS + STREAM_MS + REPS * 30000 + SCROLL_REPS * 40000 + 420000);
process.env.AGENTS_SQUAD_DEV = '0';
process.on('exit', () => { try { fs.rmSync(process.env.AGENTS_SQUAD_PROJECT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
if (!process.env.AGENTS_SQUAD_PROJECT.startsWith(os.tmpdir())) throw new Error('[realperf] AGENTS_SQUAD_PROJECT must be an isolated temp root');

// Sandbox (t_8f7605c4): every agent works in a private clone of a throwaway git repo inside the
// data root — never in a shared non-repo cwd (which once let real helpycode agents wander into
// the developer's real repo and land seed commits on its master). The startup gate below
// hard-fails the run unless every node's workdir and git root resolve inside the data root.
const SB = require(path.join(APP, 'test', 'harness', 'sandbox'));
const AGENT_WS = Array.from({ length: AGENTS }, (_, i) => SB.agentWorkspace(process.env.AGENTS_SQUAD_PROJECT, i));
function assertAgentSandbox(seeded) {
  const { Store } = require(path.join(APP, 'src/store.js'));
  const store = new Store(seeded.dir);
  const nodes = store.read(store.teamFile(), { nodes: [] }).nodes || [];
  if (nodes.length < AGENTS) throw new Error(`[sandbox] only ${nodes.length}/${AGENTS} nodes found after seed`);
  for (const n of nodes) {
    const wd = path.resolve(n.workdir || seeded.dir);
    SB.assertSandboxed(process.env.AGENTS_SQUAD_PROJECT, [{ label: `node ${n.name} workdir`, path: wd }]);
    if (n.workdir) SB.assertGitInside(process.env.AGENTS_SQUAD_PROJECT, wd, `node ${n.name}`);
  }
}

// Teardown note: call('stop') can hang forever when real helpycode children ignore its kill
// (observed twice) — stopOrchestrator below time-boxes it; Electron's exit reaps the child
// tree (verified: killing a wedged instance left zero orphan helpycode processes), and a
// hard process.exit fallback covers anything else. Never wrap child_process.spawn here —
// that wedged Electron's own boot in a sync wait.

// Per-IPC-call durations + push sizes, wrapped before main.js registers handlers.
const { ipcMain } = require('electron');
const PERF_IPC = [];
const PERF_PUSH = [];
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => {
  if (ch !== 'api') return origHandle(ch, fn);
  return origHandle(ch, async (e, name, ...rest) => {
    const t = performance.now();
    try { return await fn(e, name, ...rest); }
    finally { if (PERF_IPC.length < 40000) PERF_IPC.push({ name, ms: performance.now() - t, at: t }); }
  });
};
app.on('web-contents-created', (_e, contents) => {
  const orig = contents.send.bind(contents);
  contents.send = (ch, data) => { if (ch === 'state' || ch === 'log') PERF_PUSH.push({ channel: ch, bytes: data ? JSON.stringify(data).length : 0, at: performance.now() }); return orig(ch, data); };
});

// Main-thread log I/O probe (same as cpu-baseline.js): this process IS the app's main thread.
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const IO = { calls: 0, totalMs: 0, maxMs: 0, over5: 0, over20: 0, slowest: [], winCalls: 0, winTotalMs: 0 };
{
  const { Store } = require(path.join(APP, 'src/store.js'));
  const orig = Store.prototype.appendLog;
  Store.prototype.appendLog = function (...a) {
    const t = performance.now();
    try { return orig.apply(this, a); }
    finally {
      const d = performance.now() - t;
      IO.calls++; IO.totalMs += d; IO.winCalls++; IO.winTotalMs += d;
      if (d > IO.maxMs) IO.maxMs = d;
      if (d > 5) IO.over5++;
      if (d > 20) IO.over20++;
      if (d > 10) { IO.slowest.push(+d.toFixed(1)); if (IO.slowest.length > 60) IO.slowest.shift(); }
    }
  };
}
const EL = monitorEventLoopDelay({ resolution: 10 });

app.setPath('userData', path.join(process.env.AGENTS_SQUAD_PROJECT, 'userData'));
require(MAIN);
delete process.env.AGENTS_SQUAD_SMOKE;

let wc = null;
let failed = false;
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'window') return;
  contents.setBackgroundThrottling(false); // honest rAF even if occluded
  contents.on('did-finish-load', async () => {
    wc = contents;
    try { await main(); } catch (e) { failed = true; console.error('[realperf] failed:', e && e.stack || e); }
    if (failed) { try { await stopOrchestrator(); } catch {} await WAIT(1000); }
    app.exit(failed ? 1 : 0);
    setTimeout(() => { try { app.exit(failed ? 1 : 0); } catch {} process.exit(failed ? 1 : 0); }, 3000).unref();
  });
});

const ex = (js) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${js} })()`);
// exT: like ex but rejects after ms — a wedged/crashed renderer must never hang the run tail.
const exT = (js, ms) => Promise.race([ex(js), WAIT(ms || 30000).then(() => { throw new Error('ex-timeout'); })]);
const jsq = (v) => JSON.stringify(v);

// Orchestrator stop: call('stop') can hang forever when real helpycode children ignore its
// kill (observed twice) — time-box it; Electron's exit reaps the rest.
async function stopOrchestrator() {
  try { await Promise.race([exT(`await call('stop')`, 15000), WAIT(16000).then(() => { throw new Error('stop-timeout'); })]); }
  catch (e) { console.error('[realperf] stop did not settle:', e.message); }
  await WAIT(800);
}
// Last-resort watchdog: a promise-hang anywhere must not leave an instance lingering. Scales
// with AGENTS — the 5-agent run legitimately runs longer under load (t_c69c2170).
setTimeout(() => { console.error('[realperf] WATCHDOG: force exit'); try { app.exit(3); } catch {} }, Number(process.env.PERF_MAX_MS || (20 + 4 * Math.max(0, AGENTS - 2)) * 60000)).unref();

// ---- in-page instrumentation -------------------------------------------------------------
const INSTRUMENT = `
  if (window.__jank) return { already: true };
  const P = window.__jank = {
    t0: performance.now(), wallAt: Date.now() - performance.now(), phaseName: 'setup',
    probes: [], frames: {}, lt: {}, splitCounts: {}, statePushes: 0, logPushes: 0,
    roomDraws: [], roomDrawMs: 0, rebuildMs: 0, refreshN: 0, refreshMs: 0,
  };
  Object.defineProperty(P, 'phase', { get: () => P.phaseName, set: (k) => { P.phaseName = k; } });
  const phaseOf = () => P.phaseName;
  const F = (k) => P.frames[k] = P.frames[k] || { frames: 0, fast: 0, sum: 0, max: 0, jank: [] };
  const LT = (k) => P.lt[k] = P.lt[k] || { n: 0, ms: 0, max: 0, samples: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { const b = LT(phaseOf()); b.n++; b.ms += e.duration; if (e.duration > b.max) b.max = e.duration; if (b.samples.length < 5000) b.samples.push({ start: Math.round(e.startTime + P.wallAt), dur: Math.round(e.duration) }); } }).observe({ type: 'longtask', buffered: true });
  let last = performance.now();
  const raf = (t) => { const d = t - last; last = t; if (d > 0) { const f = F(phaseOf()); f.frames++; f.sum += d; if (d > f.max) f.max = d; if (d < 34) f.fast++; else if (f.jank.length < 5000) f.jank.push(+d.toFixed(1)); } requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const timedChat = () => { const o = window.renderChatBody; if (typeof o !== 'function' || o.__wrapped) return; window.renderChatBody = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { const d = performance.now() - t; P.roomDraws.push(+d.toFixed(2)); P.roomDrawMs += d; if (P.roomDraws.length > 6000) P.roomDraws.shift(); const sb = P.splitCounts[P.phaseName] = P.splitCounts[P.phaseName] || { draws: 0, ms: 0 }; sb.draws++; sb.ms += d; } }; o.__wrapped = true; };
  timedChat();
  const timedRebuild = () => { const c = window.Chat; if (!c || typeof c.roomEvents !== 'function' || c.roomEvents.__wrapped) return; const o = c.roomEvents; c.roomEvents = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { P.rebuildMs += performance.now() - t; } }; o.__wrapped = true; };
  timedRebuild();
  const timedRefresh = () => { const o = window.refresh; if (typeof o !== 'function' || o.__wrapped) return; window.refresh = async function (...a) { const t = performance.now(); try { return await o.apply(this, a); } finally { P.refreshN++; P.refreshMs += performance.now() - t; } }; o.__wrapped = true; };
  timedRefresh();
  try { window.squad.on('state', () => P.statePushes++); window.squad.on('log', () => P.logPushes++); } catch (e) {}
  // Room-open probes: arm stamps t0 (real input events are dispatched from the main process
  // between arm and settle); settle polls the DOM predicate, waits two rAF (paint landed),
  // stamps t1 and attaches the long tasks inside [t0,t1]. probeAct runs a page-side action
  // (dropdown change) inside the timed window. Predicates/actions are a named registry —
  // the app's CSP (default-src 'self') forbids eval/new Function in the page.
  const PREDS = {
    tabChatWithGroups: () => !!document.querySelector('#tab-chat.active') && document.querySelectorAll('#chat-room .cgroup').length > 0,
    // Thread probes check the VISIBLE panel, not bare element existence: closing hides
    // #chat-thread but syncThreadPanel keeps #chat-threadroom in the DOM (t_c69c2170 — the
    // old existence predicates could never see a close, and saw stale opens across reps).
    threadOpen: () => { const p = document.querySelector('#chat-thread:not(.hidden)'); return !!(p && p.querySelector('#chat-threadroom')); },
    threadClosed: () => !document.querySelector('#chat-thread:not(.hidden)'),
    roomNonEmpty: () => document.querySelectorAll('#chat-room .cgroup').length > 0 || !!document.querySelector('#chat-room p'),
  };
  const ACTS = {
    teamSwitch: async () => { const s = document.querySelector('#chatteam'); const opts = [...s.options].map((o) => o.value); if (opts.length < 2) throw new Error('no second team'); s.value = opts[1]; s.dispatchEvent(new Event('change')); },
    teamBack: async () => { const s = document.querySelector('#chatteam'); const opts = [...s.options].map((o) => o.value); if (opts.length < 2) throw new Error('no second team'); s.value = opts[0]; s.dispatchEvent(new Event('change')); },
  };
  const finishProbe = async (pr, push) => {
    const deadline = pr.t0 + (pr.timeout || 8000);
    let ok = false;
    while (performance.now() < deadline) { let g = false; try { g = !!pr.expect(); } catch (e) {} if (g) { ok = true; break; } await w(8); }
    if (!ok) { const rec = { name: pr.name, ok: false, err: 'expect-timeout', ms: +(performance.now() - pr.t0).toFixed(1) }; if (push !== false) P.probes.push(rec); return rec; }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t1 = performance.now();
    const lo = pr.t0 + P.wallAt - 3, hi = t1 + P.wallAt + 3;
    const longs = [];
    for (const k of Object.keys(P.lt)) for (const s of P.lt[k].samples) if (s.start >= lo && s.start <= hi) longs.push(s);
    const rec = { name: pr.name, ok: true, ms: +(t1 - pr.t0).toFixed(1), longTasks: longs };
    if (push !== false) P.probes.push(rec);
    return rec;
  };
  P.arm = (name, predName, timeoutMs) => { const expect = PREDS[predName]; if (!expect) return { err: 'no-pred:' + predName }; P._pr = { name, t0: performance.now(), expect, timeout: timeoutMs }; return true; };
  P.settle = (push) => { const pr = P._pr; if (!pr) return Promise.resolve({ name: '?', ok: false, err: 'not-armed' }); P._pr = null; return finishProbe(pr, push); };
  // Locate + arm in ONE page round trip: pick a target a real input click can actually reach at
  // the exact returned coordinates (elementFromPoint must resolve inside the candidate) and stamp
  // t0 at the same moment. The old arm→click pair spanned two round trips during which streaming
  // re-renders shifted the live-tail feed under the saved point — 0 of 4 thread opens landed
  // (t_94b8df1f). Retry-on-miss lives driver-side (clickProbe).
  P.armAt = (kind, name, predName, timeoutMs) => {
    const expect = PREDS[predName]; if (!expect) return { err: 'no-pred:' + predName };
    if (kind === 'roomlink' && !PREDS.threadClosed()) return { err: 'panel-open' };
    const cands = [];
    if (kind === 'roomlink') {
      for (const b of document.querySelectorAll('#chat-room [data-thread]')) {
        if (typeof b.onclick !== 'function') continue; // a dead link can never open — not an open attempt
        const r = b.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const cx = Math.round(r.x + Math.min(60, r.width / 2)), cy = Math.round(r.y + r.height / 2);
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
        const at = document.elementFromPoint(cx, cy);
        if (!at || !(at === b || b.contains(at))) continue;
        cands.push({ xy: [cx, cy], buried: !!b.closest('details:not([open])') }); // folded evrun content hit-tests but is invisible: last resort
        if (cands.length >= 6) break;
      }
    } else if (kind === 'closebtn') {
      const p = document.querySelector('#chat-thread:not(.hidden)');
      const b = p && p.querySelector('#ch-close');
      if (!b) return { err: 'no-panel' };
      const r = b.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      const at = document.elementFromPoint(cx, cy);
      if (!at || !(at === b || b.contains(at))) return { err: 'occluded' };
      cands.push({ xy: [cx, cy], buried: false });
    } else return { err: 'no-kind:' + kind };
    const c = cands.find((x) => !x.buried) || cands[0];
    if (!c) return { err: 'no-target' };
    P._pr = { name, t0: performance.now(), expect, timeout: timeoutMs || 2500 };
    return c.xy;
  };
  P.probeAct = async (name, actName, predName, timeoutMs) => {
    const act = ACTS[actName];
    if (!act) return { name, ok: false, err: 'no-act:' + actName };
    P.arm(name, predName, timeoutMs);
    const pr = P._pr; P._pr = null;
    try { await act(); } catch (e) { return { name, ok: false, err: 'action: ' + e.message }; }
    return finishProbe(pr);
  };
  P.scrollRect = () => { const r = $('#chat-room').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + Math.min(160, r.height / 2))]; };
  P.scrollInfo = () => { const r = $('#chat-room'); return { top: Math.round(r.scrollTop), h: r.scrollHeight, ch: r.clientHeight, groups: r.querySelectorAll('.cgroup').length }; };
  // Per-subwindow buckets: rotate the phase so frames/longtasks land in fresh per-subwindow
  // stores, and snapshot+clear one on demand (real-model streaming has minute-long lulls —
  // per-subwindow stats let the report keep only the subwindows where lines actually flowed).
  P.split = (name) => { P.phase = name; return true; };
  P.phaseStats = (name) => {
    const f = P.frames[name], b = P.lt[name], sb = P.splitCounts[name];
    delete P.frames[name]; delete P.lt[name]; delete P.splitCounts[name];
    const j = f ? [...f.jank].sort((a, z) => a - z) : [];
    return { frames: f ? f.frames : 0, fast: f ? f.fast : 0, jankN: j.length, jankP50: j.length ? j[Math.floor(j.length / 2)] : 0, jankP95: j.length ? j[Math.floor(j.length * 0.95)] : 0, jankMax: f ? +f.max.toFixed(1) : 0, worst: j.length ? [...j].reverse().slice(0, 5) : [], ltN: b ? b.n : 0, ltMs: b ? +b.ms.toFixed(1) : 0, ltMax: b ? +b.max.toFixed(1) : 0, roomDraws: sb ? sb.draws : 0, roomDrawMs: sb ? +sb.ms.toFixed(1) : 0 };
  };
  return { ok: true };
`;

const summaryJs = `
  const P = window.__jank;
  const q = (a, p) => { const x = a.filter(Number.isFinite).slice().sort((m, n) => m - n); return x.length ? +x[Math.min(x.length - 1, Math.floor((x.length - 1) * p))].toFixed(2) : 0; };
  const stat = (a) => ({ n: a.length, p50: q(a, .5), p95: q(a, .95), max: a.length ? +Math.max(...a).toFixed(2) : 0, sum: +a.reduce((s, x) => s + x, 0).toFixed(1) });
  const secs = (performance.now() - P.t0) / 1000;
  const frames = {};
  for (const [k, f] of Object.entries(P.frames)) { const j = [...f.jank].sort((a, b) => a - b); frames[k] = { frames: f.frames, fps: +(f.frames / (f.sum / 1000 || 1)).toFixed(1), fast: f.fast, jankN: f.jank.length, jankP50: j.length ? j[Math.floor(j.length / 2)] : 0, jankP95: j.length ? j[Math.floor(j.length * 0.95)] : 0, jankMax: +f.max.toFixed(1), worst: [...f.jank].sort((a, b) => b - a).slice(0, 10) }; }
  const lt = {};
  for (const [k, b] of Object.entries(P.lt)) lt[k] = { n: b.n, totalMs: +b.ms.toFixed(0), maxMs: +b.max.toFixed(1), worst: b.samples.slice().sort((a, z) => z.dur - a.dur).slice(0, 12) };
  const byName = {};
  for (const p of P.probes) (byName[p.name] = byName[p.name] || []).push(p);
  const probes = Object.fromEntries(Object.entries(byName).map(([k, v]) => {
    const good = v.filter((x) => x.ok);
    return [k, { n: v.length, ok: good.length, ms: stat(good.map((x) => x.ms)), longTasksTotal: good.reduce((s, x) => s + (x.longTasks || []).length, 0), longTaskMaxMs: good.reduce((m, x) => Math.max(m, ...(x.longTasks || []).map((l) => l.dur)), 0), drops: v.filter((x) => !x.ok).map((x) => ({ err: x.err, ms: x.ms })).slice(0, 4) }];
  }));
  const drawMs = stat(P.roomDraws);
  return { windowSecs: +secs.toFixed(1), probes, frames, longTasks: lt, chatDraws: { n: drawMs.n, perSec: +(drawMs.n / secs).toFixed(2), msTotal: drawMs.sum, msPerSec: +(drawMs.sum / secs).toFixed(1), p50: drawMs.p50, p95: drawMs.p95, max: drawMs.max }, rebuildMs: +P.rebuildMs.toFixed(1), refresh: { n: P.refreshN, msTotal: +P.refreshMs.toFixed(1) }, rates: { statePushesPerSec: +(P.statePushes / secs).toFixed(2), logPushesPerSec: +(P.logPushes / secs).toFixed(2) }, logLines: logs.filter((l) => l.projectId === ctx.p).length, working: Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length };
`;

// ---- input helpers -----------------------------------------------------------------------
async function xyOf(sel) {
  return ex(`const b = $('${sel}'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + Math.min(14, r.height / 2))];`);
}
async function clickAt(xy) {
  for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: xy[0], y: xy[1], button: 'left', clickCount: 1 });
}
async function wheelAt(xy, deltaY) {
  wc.sendInputEvent({ type: 'mouseWheel', x: xy[0], y: xy[1], deltaX: 0, deltaY });
}

// bulk board/log/run history through the Store API (lock-safe next to the app's own Store).
function bulkSeed(dir, nodes) {
  const { Store } = require(path.join(APP, 'src/store.js'));
  const U = require(path.join(APP, 'src/usage.js'));
  const store = new Store(dir);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const verbs = ['Fix', 'Refactor', 'Profile', 'Wire', 'Document', 'Harden', 'Migrate', 'Cache', 'Debounce', 'Instrument'];
  const objs = ['render path', 'log pane', 'board columns', 'graph layout', 'usage ledger', 'inbox badge', 'wake sweep', 'stall watchdog', 'settings form', 'wiki editor'];
  const dist = [['done', Math.floor(SEED_TASKS * 0.8)], ['review', Math.floor(SEED_TASKS * 0.05)], ['in_progress', Math.floor(SEED_TASKS * 0.05)], ['waiting_for_human', Math.floor(SEED_TASKS * 0.03)], ['merge_conflict', Math.floor(SEED_TASKS * 0.01)]];
  let seeded = 0;
  for (const [status, count] of dist) {
    for (let i = 0; i < count; i++) {
      const t = store.createTask({ title: `${pick(verbs)} the ${pick(objs)} (seed ${++seeded})`, description: 'Seeded history for the real-agent jank baseline board. Realistic description so card snippets render.', assignee: Math.random() < 0.15 ? null : pick(nodes), createdBy: pick(nodes) });
      store.updateTask(t.id, { status });
      if (seeded % 5 === 0) store.commentTask(t.id, pick(nodes), 'Synthetic comment: measured the render path on the grown board, numbers point at the room rebuild.\n\n- bullet one\n- bullet two\n\n`inline code` and **bold** for markdown realism.');
    }
  }
  for (let i = 0; i < SEED_LOGS; i++) store.appendLog({ nodeId: pick(nodes), kind: pick(['text', 'tool', 'tool_result', 'system']), text: `seed line ${i}: walked the ${pick(objs)}; ${'context '.repeat(6).trim()}`, at: Date.now() - (SEED_LOGS - i) * 1200, level: 'info' });
  for (let i = 0; i < SEED_RUNS; i++) {
    const started = Date.now() - (SEED_RUNS - i) * 45000;
    const run = U.newRun({ nodeId: pick(nodes), agent: 'Perf', task: 'seed', model: MODEL, runtime: 'helpycode', provider: 'synthetic', inputTokens: 800 + (i % 40) * 97, outputTokens: 120 + (i % 17) * 31, cacheReadTokens: 40000 + i * 13, numTurns: 3, reportedCostUsd: 0.004 });
    run.startedAt = new Date(started).toISOString();
    store.addRun(U.finishRun(run, { code: 0, env: {}, billingMode: 'auto', startedMs: started }));
  }
}

// Real tasks for real agents: meaty text work that streams a while without file writes.
const TOPICS = ['event-driven UI rendering', 'database indexing strategies', 'consensus in distributed systems', 'browser compositing and layers', 'garbage collection algorithms', 'cache coherence protocols', 'stream processing architectures', 'cellular automata', 'approximate nearest-neighbor search', 'quantum error correction', 'tropical geometry', 'regulatory RNA biology'];
const taskPrompt = (i) => {
  const t = TOPICS[i % TOPICS.length];
  const kind = i % 3;
  if (kind === 0) return `Write a detailed technical essay about ${t}: 25 markdown sections, 3-5 substantial sentences each, plus an intro and a conclusion. Do not modify any files; write the essay directly in your reply.`;
  if (kind === 1) return `List exactly 50 numbered, specific ideas about ${t}, one to three sentences each, then a two-paragraph closing reflection. No file edits; answer directly.`;
  return `Explain ${t} in 14 sections with headings, each section 5-7 sentences, then a 12-bullet summary. Answer directly without touching files.`;
};

// ---- function-level trace + long-task attribution ----------------------------------------
const fnName = (n) => { const cf = n.callFrame || {}; const fn = cf.functionName || '(anonymous)'; const f = (cf.url || '').split('/').pop(); return fn + (f ? ` ${f}:${(cf.lineNumber == null ? '?' : cf.lineNumber + 1)}` : ''); };

function aggregateProfile(profile) {
  const nodes = new Map((profile.nodes || []).map((n) => [n.id, n]));
  const hits = new Map();
  let total = 0;
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const n = nodes.get(profile.samples[i]);
    if (!n) continue;
    const d = profile.timeDeltas[i] || 0;
    hits.set(fnName(n), (hits.get(fnName(n)) || 0) + d / 1000);
    total += d;
  }
  const list = [...hits.entries()].map(([name, ms]) => ({ name, selfMs: +ms.toFixed(1) })).sort((a, b) => b.selfMs - a.selfMs);
  return { windowMs: +(total / 1000).toFixed(0), top: list.slice(0, 24) };
}

function attributeLongTasks(profile, traceStartWall, longTasks) {
  const nodes = new Map((profile.nodes || []).map((n) => [n.id, n]));
  let t = profile.startTime;
  const samps = [];
  for (let i = 0; i < (profile.samples || []).length; i++) {
    t += profile.timeDeltas[i] || 0;
    const n = nodes.get(profile.samples[i]);
    if (n) samps.push({ name: fnName(n), wall: traceStartWall + (t - profile.startTime) / 1000 });
  }
  return longTasks.map((lt) => {
    const tally = new Map();
    for (const s of samps) if (s.wall >= lt.start && s.wall <= lt.start + lt.dur) tally.set(s.name, (tally.get(s.name) || 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
    return { startWall: Math.round(lt.start), durMs: lt.dur, during: top };
  }).sort((a, b) => b.durMs - a.durMs).slice(0, 24);
}

async function startTrace(minMs) {
  const out = { minMs, intervalUs: 200, startedAt: 0 };
  const inspector = require('inspector');
  const session = new inspector.Session();
  session.connect();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
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
  console.log(`[realperf] tracing renderer + main for >= ${minMs} ms`);
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
    out.renderer = aggregateProfile(rProf);
    out.main = aggregateProfile(mProf);
    const inst = await ex(`return { lt: Object.values(window.__jank.lt).flatMap((b) => b.samples) }`).catch(() => null);
    if (inst && inst.lt) {
      const inWin = inst.lt.filter((s) => s.start >= out.startedAt && s.start <= out.startedAt + out.windowMs);
      out.longTaskAttribution = attributeLongTasks(rProf, out.startedAt, inWin);
    }
    out.files = ['trace-renderer.cpuprofile', 'trace-main.cpuprofile'];
    try { session.disconnect(); } catch {}
    try { wc.debugger.detach(); } catch {}
    return out;
  };
}

// ---- scenarios ---------------------------------------------------------------------------
async function seed() {
  const res = await ex(`
    const p = await call('createProject', 'Real-agent jank baseline');
    switchTo({ p: p.id }); await w(600); await refresh();
    await call('saveSettings', { helpycodePath: ${jsq(HCPATH)}, useWorktrees: false, maxConcurrency: ${AGENTS}, maxRuns: ${AGENTS * TASKS_PER_AGENT + 2}, requireApproval: false, stallTimeoutMin: ${STALL_MIN} });
    const nodes = [];
    for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'Real-' + (i + 1), role: 'Dev', x: 90 + (i % 3) * 240, y: 110 + Math.floor(i / 3) * 190, runtime: 'helpycode', model: ${jsq(MODEL)}, workdir: ${jsq(AGENT_WS[i])} }));
    for (const n of nodes.slice(1)) await call('addEdge', nodes[0].id, n.id, 'assign');
    await refresh();
    return { project: ctx.p, dir: S.dir, nodes: nodes.map((n) => n.id) };
  `);
  return res;
}

async function waitForAgents(seeded) {
  const t0 = Date.now();
  await ex(`await call('run')`);
  // Staggered queueing: one task per WAIT(STAGGER_MS); the orchestrator's 1 s dispatch sweep
  // starts each run as its node's slot frees, ramping the CLI boot storm instead of spawning
  // AGENTS helpycode processes in the same second. STAGGER_MS=0 (2-agent default) queues all
  // upfront, reproducing the old boot pattern.
  const total = AGENTS * TASKS_PER_AGENT;
  for (let k = 0; k < total; k++) {
    await ex(`await call('createTask', { title: 'Real streaming task ' + (${k + 1}), description: ${jsq(taskPrompt(k))}, assignee: ${jsq(seeded.nodes[k % seeded.nodes.length])} })`);
    if (k < total - 1 && STAGGER_MS) await WAIT(STAGGER_MS);
  }
  await ex(`await refresh()`).catch(() => {});
  let working = 0;
  while (Date.now() - t0 < AGENT_START_TIMEOUT_MS + QUEUE_MS) {
    working = (await ex(`return Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length`)) || 0;
    if (working >= AGENTS) return working;
    await WAIT(1000);
  }
  const diag = await ex(`return { agents: S.orch.agents, logs: logs.slice(-20).map((l) => l.kind + ': ' + String(l.text).slice(0, 200)), todo: S.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').map((t) => t.id + ' ' + t.status) }`).catch(() => ({}));
  throw new Error(`only ${working}/${AGENTS} real agents started within ${AGENT_START_TIMEOUT_MS + QUEUE_MS} ms — diagnostics: ` + JSON.stringify(diag, null, 2));
}

const phase = (k) => ex(`window.__jank.phase = ${jsq(k)}`);

// PNGs for the report: chat open, open thread, scroll-up top, mid-streaming frame.
const SHOTS = [];
async function shot(name) {
  if (SHOTS.includes(name)) return;
  try {
    const img = await wc.capturePage();
    if (!img || img.isEmpty()) return;
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    SHOTS.push(name);
    console.log('[realperf] shot ' + name + '.png');
  } catch (e) { console.error('[realperf] shot ' + name + ' failed:', e && e.message || e); }
}

// Locate+arm in one page call, real input click, settle with a short window. A missed click
// (the feed shifted between locate and dispatch) retries on a fresh locate instead of burning
// an 8 s timeout, so every rep's open is attempted until it actually happens — and the open,
// when it happens, is measured from its own t0. Only the rep's final record lands in the report.
async function clickProbe(kind, name, predName, tries = 3) {
  let last = null;
  for (let a = 0; a < tries; a++) {
    const armed = await ex(`return window.__jank.armAt(${jsq(kind)}, ${jsq(name)}, ${jsq(predName)}, 2500)`);
    if (!armed || armed.err) {
      const rec = { name, ok: false, err: (armed && armed.err) || 'locate-failed', ms: 0 };
      await exT(`window.__jank.probes.push(${jsq(rec)})`, 5000).catch(() => {}); // the summary table reads page-side probes only
      return rec;
    }
    await clickAt(armed);
    last = await exT(`return window.__jank.settle(${a === tries - 1})`, 9000);
    if (last && last.ok) return last;
    if (a < tries - 1) {
      // An open may have landed after its settle window (slow frame): close it via the panel's
      // own button so the next attempt starts from a closed panel (armAt refuses otherwise).
      await ex(`const b = document.querySelector('#chat-thread:not(.hidden) #ch-close'); if (b) b.click();`).catch(() => {});
      await WAIT(200);
    }
  }
  return last || { name, ok: false, err: 'no-settle' };
}

async function chatOpenCampaign(reps) {
  const recs = [];
  for (let i = 0; i < reps; i++) {
    await ex(`showTab('board'); await w(250);`); // always enter chat from another tab
    const tabXY = await xyOf('button[data-tab="chat"]');
    const tabRec = tabXY ? await (async () => {
      await ex(`return window.__jank.arm('tab:chat', 'tabChatWithGroups', 8000)`);
      await clickAt(tabXY);
      return ex(`return window.__jank.settle()`);
    })() : null;
    if (tabRec) { recs.push(tabRec); if (tabRec.ok) await shot('chat-open'); }
    const openRec = await clickProbe('roomlink', 'thread:open', 'threadOpen');
    recs.push(openRec);
    if (openRec.ok) {
      await shot('thread-open');
      await WAIT(250);
      recs.push(await clickProbe('closebtn', 'thread:close', 'threadClosed'));
    }
    recs.push(await ex(`return window.__jank.probeAct('team:switch', 'teamSwitch', 'roomNonEmpty', 8000)`));
    recs.push(await ex(`return window.__jank.probeAct('team:back', 'teamBack', 'roomNonEmpty', 8000)`));
    await WAIT(150);
  }
  return recs.filter(Boolean);
}

async function scrollCampaign(reps) {
  const recs = [];
  const xy = await ex(`return window.__jank.scrollRect()`);
  for (let i = 0; i < reps; i++) {
    const before = await ex(`return window.__jank.scrollInfo()`);
    await phase('scroll');
    const t0 = Date.now();
    for (let s = 0; s < 40; s++) { // scroll up: may trigger the chatGrow prepend path
      await wheelAt(xy, -240);
      await WAIT(16);
      if (s % 8 === 7) { const inf = await ex(`return window.__jank.scrollInfo()`); if (inf.top <= 90) break; }
    }
    await WAIT(300);
    const mid = await ex(`return window.__jank.scrollInfo()`); // captured at the top: prepend grew the DOM
    if (i === 0) await shot('scroll-up');
    for (let s = 0; s < 40; s++) { // back to the bottom (window shrink redraw)
      await wheelAt(xy, 240);
      await WAIT(16);
      const inf = await ex(`return window.__jank.scrollInfo()`);
      if (inf.h - inf.top - inf.ch < 100) break;
    }
    const after = await ex(`return window.__jank.scrollInfo()`);
    recs.push({ rep: i, wallMs: Date.now() - t0, groupsBefore: before.groups, groupsAfter: after.groups, grew: mid.groups > before.groups });
    await phase('stream');
    await WAIT(400);
  }
  return recs;
}

// ---- main --------------------------------------------------------------------------------
async function main() {
  const maxLoad = Number(process.env.PERF_MAX_LOAD || 0);
  if (maxLoad > 0 && LOAD_START[0] > maxLoad) throw new Error(`load1m ${LOAD_START[0].toFixed(1)} > PERF_MAX_LOAD ${maxLoad} — rerun on a quiet machine (5-agent passes want load1m under ~6)`);
  await WAIT(1200);
  const seeded = await seed();
  assertAgentSandbox(seeded); // hard gate: agents only start in a sandboxed git workdir (t_8f7605c4)
  const bulk = bulkSeed(seeded.dir, seeded.nodes);
  console.log('[realperf] seeded', JSON.stringify({ nodes: seeded.nodes.length, tasks: AGENTS * TASKS_PER_AGENT, staggerMs: STAGGER_MS, stallMin: STALL_MIN, ...bulk }));
  await ex(`await refresh(); showTab('chat'); await w(400);`);
  const inst = await ex(INSTRUMENT);
  if (!inst || !inst.ok) throw new Error('instrumentation failed: ' + JSON.stringify(inst));
  await phase('warm');

  const working = await waitForAgents(seeded);
  const WARM_PERF = performance.now(); // steady-window boundary: excludes boot/seed cold reads
  console.log(`[realperf] ${working}/${AGENTS} real helpycode agents working`);
  await WAIT(WARM_MS);

  // CPU sampling across all phases, 1/s, tagged with the renderer's current phase.
  const series = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const at = Date.now();
      let ph = 'warm';
      try { ph = (await ex(`return window.__jank.phase`)) || 'warm'; } catch {}
      const metrics = app.getAppMetrics();
      series.push({ at, phase: ph, procs: metrics.map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu ? +m.cpu.percentCPUUsage.toFixed(2) : 0, wake: m.cpu ? +m.cpu.idleWakeupsPerSecond.toFixed(2) : 0, mem: m.memory ? m.memory.workingSetSize : 0 })) });
      await WAIT(Math.max(0, 1000 - (Date.now() - at)));
    }
  })();

  const WINDOW_T0 = Date.now();
  await phase('chatopen');
  const stopTrace = await startTrace(TRACE_MS);
  // Main-process event-loop delay is armed HERE — after the profiler starts, so the histogram
  // covers exactly the agent-driven phases (chat-open campaign, scroll, streaming) and excludes
  // the harness-owned Profiler.stop, which serializes the whole profile on this thread and would
  // otherwise dominate max (a 200 s profile stopped inside the window reads as a multi-second
  // "block" that is not app work). Percentile floor caveat: monitorEventLoopDelay on an idle loop
  // quantizes at ~10 ms on macOS (calibrated against a plain node process), well under the 50 ms
  // bar — the histogram's job is the tail, not the floor.
  EL.enable();
  const EL_T0 = Date.now();
  let elOver50 = 0, elWatchMax = 0, elWatchNext = Date.now();
  const elWatcher = setInterval(() => { // 20 ms drift watch: fires late by ~the longest block
    const now = Date.now();
    const late = now - elWatchNext;
    if (late > elWatchMax) elWatchMax = late;
    if (late > 50) elOver50++;
    elWatchNext = now + 20;
  }, 20);
  const probeRecs = await chatOpenCampaign(REPS);
  console.log(`[realperf] chat-open campaign done: ${probeRecs.length} samples`);

  const scrollRecs = await scrollCampaign(SCROLL_REPS);
  console.log(`[realperf] scroll campaign done: ${JSON.stringify(scrollRecs)}`);

  await phase('stream');
  const pushesAtStreamStart = PERF_PUSH.length;
  // Untouched streaming window, measured in 10 s subwindows: real model runs have minute-long
  // quiet lulls (thinking/API latency), so a single fixed window is a lottery — subwindows
  // with actual log pushes give the "while messages stream in" numbers, the rest show idle.
  const streamSubs = [];
  {
    const SUBS = Math.max(2, Number(process.env.PERF_STREAM_SUBS || 12));
    for (let i = 0; i < SUBS; i++) {
      await ex(`return window.__jank.split('stream${i}')`);
      const t0 = Date.now();
      const pushes0 = PERF_PUSH.length;
      const io0 = { c: IO.winCalls, ms: IO.winTotalMs };
      IO.winCalls = 0; IO.winTotalMs = 0;
      await WAIT(10000);
      const st = (await ex(`return window.__jank.phaseStats('stream${i}')`)) || {};
      streamSubs.push({ i, wallMs: Date.now() - t0, pushes: PERF_PUSH.length - pushes0, logPushes: PERF_PUSH.slice(pushes0).filter((p) => p.channel === 'log').length, statePushes: PERF_PUSH.slice(pushes0).filter((p) => p.channel === 'state').length, ioCalls: IO.winCalls, ioMs: +(IO.winTotalMs).toFixed(1), ...st });
      IO.winCalls = 0; IO.winTotalMs = 0;
      if (i === 1) await shot('streaming'); // two subwindows in: comfortably mid-stream
    }
  }
  const streamPushes = PERF_PUSH.slice(pushesAtStreamStart);
  const streamWindowSecs = streamSubs.reduce((s, w) => s + w.wallMs, 0) / 1000;
  const ioWin = { calls: IO.winCalls, totalMs: +IO.winTotalMs.toFixed(1) };
  IO.winCalls = 0; IO.winTotalMs = 0;
  EL.disable();
  clearInterval(elWatcher);
  const elWindowSecs = +(Math.max(1, Date.now() - EL_T0) / 1000).toFixed(1);
  const elMs = (ns) => +((ns || 0) / 1000).toFixed(2);

  sampling = false;
  await sampler;
  const trace = await stopTrace();
  const summary = await ex(summaryJs);
  summary.trace = trace;
  summary.chatOpenSamples = probeRecs;
  summary.scroll = scrollRecs;

  const bucketsFor = (procs) => {
    const b = { renderer: 0, gpu: 0, main: 0, utility: 0 };
    for (const p of procs) {
      if (/gpu/i.test(p.type)) b.gpu += p.cpu;
      else if (/renderer|web view|^tab$/i.test(p.type)) b.renderer += p.cpu;
      else if (/^browser$/i.test(p.type)) b.main += p.cpu;
      else if (/utility/i.test(p.type)) b.utility += p.cpu;
    }
    return b;
  };
  const byPhase = {};
  for (const s of series) {
    const b = bucketsFor(s.procs);
    (byPhase[s.phase] = byPhase[s.phase] || { renderer: [], gpu: [], main: [], utility: [] });
    for (const k of Object.keys(b)) byPhase[s.phase][k].push(+b[k].toFixed(2));
  }
  const stat = (a) => ({ n: a.length, avg: +(a.reduce((s, x) => s + x, 0) / (a.length || 1)).toFixed(2), p95: (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0), max: a.length ? +Math.max(...a).toFixed(2) : 0 });
  summary.cpuByPhase = Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([p, a]) => [p, stat(a)]))]));
  summary.series = series.map((s) => ({ at: s.at, phase: s.phase, ...Object.fromEntries(Object.entries(bucketsFor(s.procs)).map(([k, v]) => [k, +v.toFixed(2)])) }));

  const winSecs = Math.max(0.001, (Date.now() - WINDOW_T0) / 1000);
  const q = (a, p) => (a.length ? +[...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : 0);
  const byName = {};
  for (const c of PERF_IPC) { (byName[c.name] = byName[c.name] || { n: 0, ms: [] }); byName[c.name].n++; byName[c.name].ms.push(+c.ms.toFixed(2)); }
  summary.ipc = {
    total: PERF_IPC.length,
    perSec: +(PERF_IPC.length / winSecs).toFixed(2),
    byName: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, { n: v.n, perSec: +(v.n / winSecs).toFixed(2), msP50: q(v.ms, 0.5), msP95: q(v.ms, 0.95), msMax: v.ms.length ? Math.max(...v.ms) : 0 }]).sort((a, b) => b[1].n - a[1].n).slice(0, 14)),
  };
  // Steady window (from the moment the agents are confirmed working): the cold first getAll after
  // seeding pays every list*() on a just-written store and lands in the 1.5 s class once per
  // process — real, but a boot cost, not the dispatch-tail bar (t_a2566d54), which this isolates.
  const steady = PERF_IPC.filter((c) => c.at >= WARM_PERF);
  const sby = {};
  for (const c of steady) { (sby[c.name] = sby[c.name] || { n: 0, ms: [] }); sby[c.name].n++; sby[c.name].ms.push(+c.ms.toFixed(2)); }
  const sga = sby.getAll || { n: 0, ms: [] };
  summary.ipc.steady = { n: steady.length, getAll: { n: sga.n, msP50: q(sga.ms, 0.5), msP95: q(sga.ms, 0.95), msMax: sga.ms.length ? Math.max(...sga.ms) : 0 } };
  summary.streamSubs = streamSubs;
  summary.screenshots = fs.readdirSync(OUT).filter((f) => f.endsWith('.png'));
  // Real helpycode runs update the feed via state-push deltas + refresh pulls, not per-line
  // log pushes (log channel stayed 0 while runs completed with essays) — so "live" subwindows
  // are the ones where the chat room actually REDREW.
  const liveSubs = streamSubs.filter((w) => w.roomDraws >= 2 || w.logPushes >= 1);
  summary.streamPushes = {
    n: streamPushes.length, perSec: +(streamPushes.length / streamWindowSecs).toFixed(2),
    state: streamPushes.filter((p) => p.channel === 'state').length, log: streamPushes.filter((p) => p.channel === 'log').length,
    kbPerSec: +(streamPushes.reduce((s, p) => s + p.bytes, 0) / 1024 / streamWindowSecs).toFixed(1),
    liveSubs: liveSubs.length, subs: streamSubs.length,
  };
  if (liveSubs.length < Math.min(2, streamSubs.length)) { // effectively no streaming traffic at all
    const diag = await ex(`return { working: Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length, running: !!S.orch.running, todo: S.tasks.filter((t) => t.status === 'todo').length, logTail: logs.slice(-6).map((l) => l.kind + ': ' + String(l.text).slice(0, 120)) }`).catch(() => ({}));
    throw new Error('only ' + liveSubs.length + '/' + streamSubs.length + ' 10s subwindows had feed updates — agents never streamed visibly. Diagnostics: ' + JSON.stringify(diag, null, 2));
  }
  const liveFrames = liveSubs.reduce((acc, w) => { acc.frames += w.frames; acc.jankN += w.jankN; acc.ltN += w.ltN; acc.ltMs += w.ltMs; acc.draws += w.roomDraws || 0; acc.drawMs += w.roomDrawMs || 0; if (w.jankMax > acc.jankMax) acc.jankMax = w.jankMax; if (w.ltMax > acc.ltMax) acc.ltMax = w.ltMax; return acc; }, { frames: 0, jankN: 0, ltN: 0, ltMs: 0, jankMax: 0, ltMax: 0, draws: 0, drawMs: 0 });
  const liveSecs = liveSubs.reduce((s, w) => s + w.wallMs, 0) / 1000;
  const allJank = liveSubs.flatMap((w) => w.worst).sort((a, b) => b - a);
  summary.streaming = {
    wallSecs: +liveSecs.toFixed(1), fps: +(liveFrames.frames / liveSecs).toFixed(1), jankN: liveFrames.jankN,
    jankPerSec: +(liveFrames.jankN / liveSecs).toFixed(2), jankP95: allJank.length ? allJank[Math.floor(allJank.length * 0.95)] || allJank[allJank.length - 1] : 0, jankMax: liveFrames.jankMax,
    longTasks: liveFrames.ltN, blockedMsPerSec: +(liveFrames.ltMs / liveSecs).toFixed(1), longMaxMs: liveFrames.ltMax,
    ioBlockedMsPerSec: +(liveSubs.reduce((s, w) => s + w.ioMs, 0) / liveSecs).toFixed(1),
    roomDrawsPerSec: +(liveFrames.draws / liveSecs).toFixed(2), roomDrawMsPerSec: +(liveFrames.drawMs / liveSecs).toFixed(1),
  };
  summary.io = { streamWindow: ioWin, eventLoopMs: { p50: elMs(EL.percentile(50)), p95: elMs(EL.percentile(95)), p99: elMs(EL.percentile(99)), max: elMs(EL.max), watchMaxMs: +elWatchMax.toFixed(1), over50: elOver50, windowSecs: elWindowSecs }, slowestCallsMs: [...IO.slowest], maxMsPerCall: +IO.maxMs.toFixed(2) };
  summary.env = {
    agents: AGENTS, tasksPerAgent: TASKS_PER_AGENT, reps: REPS, scrollReps: SCROLL_REPS, traceMs: trace.windowMs || TRACE_MS,
    staggerMs: STAGGER_MS, stallMin: STALL_MIN,
    seeds: { tasks: SEED_TASKS, logs: SEED_LOGS, runs: SEED_RUNS }, cli: HCPATH, model: MODEL,
    platform: `${os.platform()} ${os.arch()} cpus=${os.cpus().length}`,
    load: { start1m: +LOAD_START[0].toFixed(2), end1m: +os.loadavg()[0].toFixed(2), end5m: +os.loadavg()[1].toFixed(2) },
    electron: process.versions.electron,
    commit: (() => { try { return require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
  };
  fs.writeFileSync(path.join(OUT, 'ipc-raw.json'), JSON.stringify(PERF_IPC));
  fs.writeFileSync(path.join(OUT, 'real-agents-jank.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'real-agents-jank.md'), markdown(summary));
  console.log('\n' + markdown(summary));
  console.log(`[realperf] wrote ${path.join(OUT, 'real-agents-jank.json')}`);
  await stopOrchestrator();
  await WAIT(1500);
}

function markdown(s) {
  const prow = ([k, v]) => `| ${k} | ${v.ok}/${v.n} | ${v.ms.p50} | ${v.ms.p95} | ${v.ms.max} | ${v.longTasksTotal} | ${v.longTaskMaxMs || '—'} |`;
  const frow = ([k, f]) => `| ${k} | ${f.fps} | ${f.jankN} | ${f.jankP50} | ${f.jankP95} | ${f.jankMax} | ${(f.worst || []).slice(0, 3).join(', ')} |`;
  const lrow = ([k, b]) => `| ${k} | ${b.n} | ${b.totalMs} | ${b.maxMs} |`;
  const irow = ([k, v]) => `| ${k} | ${v.n} | ${v.perSec} | ${v.msP50} | ${v.msP95} | ${v.msMax} |`;
  const cpu = s.cpuByPhase || {};
  const cpuRow = (ph) => { const c = cpu[ph]; if (!c) return `| ${ph} | — | — | — | — | — |`; return `| ${ph} | ${c.renderer.avg} | ${c.renderer.p95} | ${c.gpu.avg} | ${c.main.avg} | ${c.main.p95} |`; };
  const tr = s.trace || {};
  return `# Real-agent chat jank — ${s.env.agents} helpycode agents

${s.env.platform} · electron ${s.env.electron} · commit ${String(s.env.commit).slice(0, 9)} · load1m ${s.env.load.start1m}→${s.env.load.end1m}
${s.env.agents} real helpycode agents (${s.env.model}) · grown board ${s.env.seeds.tasks} tasks / ${s.env.seeds.logs} logs / ${s.env.seeds.runs} runs · room draws ${s.chatDraws.n} (${s.chatDraws.perSec}/s, Σ ${s.chatDraws.msPerSec} ms/s)

## (a) Chat room open/switch → first full paint (ms)

| probe | ok | p50 | p95 | max | long tasks | worst long |
|---|---|---:|---:|---:|---:|---:|
${Object.entries(s.probes).map(prow).join('\n')}

## (b) Frames — scroll vs streaming

| phase | fps | jank >34ms | jank p50 | jank p95 | max | worst 3 |
|---|---:|---:|---:|---:|---:|---|
${Object.entries(s.frames).map(frow).join('\n')}

| phase | long tasks | Σ blocked ms | max ms |
|---|---:|---:|---:|
${Object.entries(s.longTasks).map(lrow).join('\n')}

Scroll passes: ${JSON.stringify((s.scroll || []).map((r) => ({ groups: r.groupsBefore + '→' + r.groupsAfter, grew: r.grew })))}
Screenshots: ${(s.screenshots || []).join(', ') || '—'}
Stream (untouched, ${s.streamPushes.liveSubs}/${s.streamPushes.subs} live 10s subwindows): pushes ${s.streamPushes.perSec}/s (state ${s.streamPushes.state}, log ${s.streamPushes.log}, ${s.streamPushes.kbPerSec} KB/s) · room redraws ${s.streaming.roomDrawsPerSec}/s (Σ ${s.streaming.roomDrawMsPerSec} ms/s) · **while-updating fps ${s.streaming.fps}, jank ${s.streaming.jankN} (${s.streaming.jankPerSec}/s, p95 ${s.streaming.jankP95} ms, max ${s.streaming.jankMax} ms)**, long tasks ${s.streaming.longTasks} (${s.streaming.blockedMsPerSec} ms/s blocked, max ${s.streaming.longMaxMs} ms) · main appendLog ${s.streaming.ioBlockedMsPerSec} ms/s · roomEvents rebuild Σ ${s.rebuildMs} ms · refresh n=${s.refresh.n} Σ ${s.refresh.msTotal} ms

## (c) CPU % by phase

| phase | renderer avg | renderer p95 | gpu avg | main avg | main p95 |
|---|---:|---:|---:|---:|---:|
${['warm', 'chatopen', 'scroll', 'stream'].map(cpuRow).join('\n')}

Main-thread appendLog (stream window): ${s.io.streamWindow.calls} calls Σ ${s.io.streamWindow.totalMs} ms · max single ${s.io.maxMsPerCall} ms · main event loop over the ${s.io.eventLoopMs.windowSecs} s measured window (post-profiler-start): p95 ${s.io.eventLoopMs.p95} / p99 ${s.io.eventLoopMs.p99} / max ${s.io.eventLoopMs.max} ms (histogram, ~10 ms idle floor on macOS) · 20 ms drift-watch: max ${s.io.eventLoopMs.watchMaxMs} ms late, firings >50 ms late: ${s.io.eventLoopMs.over50}

## Trace — self time by function (${s.env.traceMs} ms window)

Renderer: ${(tr.renderer ? tr.renderer.top.slice(0, 12) : []).map((x) => `${x.name} ${x.selfMs}`).join(' · ') || '—'}

Main: ${(tr.main ? tr.main.top.slice(0, 12) : []).map((x) => `${x.name} ${x.selfMs}`).join(' · ') || '—'}

Long tasks → functions (renderer, worst first):
${(tr.longTaskAttribution || []).map((a) => `- ${a.durMs} ms: ${a.during.join(' | ')}`).join('\n') || '—'}

## IPC round-trips (${s.ipc.perSec}/s)

Steady window (post agent-start, n=${s.ipc.steady.n}): **getAll p50 ${s.ipc.steady.getAll.msP50} / p95 ${s.ipc.steady.getAll.msP95} / max ${s.ipc.steady.getAll.msMax} ms** (n=${s.ipc.steady.getAll.n})

| call | n | /s | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|---:|
${Object.entries(s.ipc.byName || {}).map(irow).join('\n')}
`;
}

// entry is the did-finish-load handler — never call main() at script load
