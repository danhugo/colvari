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
 *
 * Real-load arm (t_5fb1b9cf, Quinn): PERF_GATE=1 adds the second load source the task demands —
 * the app's REAL merge gate. A throwaway git clone of the app is built inside the harness data
 * root (base branch + a 1-commit branch + a linked worktree), a task pointing at that worktree
 * is flipped to done right after the agents are up, and the app runs its genuine gateMerge
 * (merge -> node_modules clone -> `npm test` in the worktree) while the agents keep streaming.
 * The scratch repo is fully sandboxed inside the data root (SB.guardRepo passes; agents-squad's
 * real repo is never touched) and is deleted with the data root on exit. While the gate runs,
 * a 1/s ps sampler records per-agent CPU/RAM (real CLI pids from the store's run-pids files),
 * the whole gate process tree (gate pidfile + descendant walk), and ambient load/free memory.
 * PERF_GATE_ARM labels the arm (branch + gate-lab dir), PERF_GATE_SUITE_MS replaces the
 * scratch suite with a fake one for smoke runs only (unset in real arms — the suite is the
 * app's genuine `npm test`), PERF_GATE_WAIT_MS bounds the post-campaign wait for the gate
 * verdict (default 30 min).
 */
Error.stackTraceLimit = 50; // lock-wait stacks must reach past the wrapper frames to the real caller
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
// Load validity (Critic t_155e7859): track the 1 m peak across the whole run — start/end samples
// alone can miss a burst in the middle. Peak >= 5 marks the run NOT valid in the summary.
const LOAD_PEAK = { max: LOAD_START[0] };
{ const t = setInterval(() => { const l = os.loadavg()[0]; if (l > LOAD_PEAK.max) LOAD_PEAK.max = l; }, 10000); t.unref(); }
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
// Real-load arm (t_5fb1b9cf): gate knobs. GATE_ENABLED builds + triggers the real merge gate.
const GATE_ENABLED = !!process.env.PERF_GATE;
const GATE_ARM = String(process.env.PERF_GATE_ARM || 'arm');
const GATE_SUITE_MS = Number(process.env.PERF_GATE_SUITE_MS || 0); // smoke only: fake suite duration
const GATE_WAIT_MS = Number(process.env.PERF_GATE_WAIT_MS || 30 * 60_000);
const CP = require('child_process');
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
const SB = require(path.join(APP, 'src', 'sandbox')); // moved here by t_8f7605c4 (was test/harness/sandbox)
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
// withLock wait/hold split (t_155e7859): wrap before main.js loads. hold = time inside fn; the
// gap to the total is the spin — sleepSync(10) iterations while some other holder (agent MCP
// writes, harness seeding) owns the lock dir. wait>=20ms keeps a stack so RESULTS can say WHICH
// call sat behind the lock, not just that the spin happened.
const LOCK = {
  calls: 0, waitMs: 0, holdMs: 0, waitMax: 0, holdMax: 0, over10: 0, over50: 0, stacks: [], win: null,
  // One record per lock call, tagged by path (withLock / withLockAsync / withLockTry). Long waits
  // capture their stack: the caller waiting behind the spin is the visible half of the block.
  // atP (performance.now at release) lets the block-cause pass bridge each stack to wall time.
  done({ name, waitMs, holdMs }) {
    const w = +waitMs, h = +holdMs, atP = performance.now();
    LOCK.calls++; LOCK.waitMs += w; LOCK.holdMs += h;
    if (w > LOCK.waitMax) LOCK.waitMax = w;
    if (h > LOCK.holdMax) LOCK.holdMax = h;
    if (w > 10) LOCK.over10++;
    if (w > 50) LOCK.over50++;
    if (w >= 20 && LOCK.stacks.length < 400) {
      let stack = '';
      try { stack = new Error().stack.split('\n').slice(2, 7).join(' | '); } catch {}
      LOCK.stacks.push({ lock: name, waitMs: w, holdMs: h, atP, stack });
    }
    if (LOCK.win) {
      LOCK.win.calls++; LOCK.win.waitMs += w; LOCK.win.holdMs += h;
      if (w > LOCK.win.waitMax) LOCK.win.waitMax = w;
      if (w > 50) LOCK.win.over50++;
      if (w >= 20 && LOCK.win.stacks.length < 400) LOCK.win.stacks.push({ lock: name, waitMs: w, holdMs: h, atP, stack });
    }
  },
};
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
  // LOCK instrumentation (t_155e7859): wait/hold split for all three lock paths around the
  // sleepSync(10) spin (store.js withLock) — WAIT is measured DIRECTLY as fn-start − call-start
  // (Critic: total−hold goes wrong when fn throws), hold as time inside fn. A nested withLock
  // (fn calls withLock again) wraps its own fn and reports its own wait/hold separately; the
  // outer's wait math still holds. wait>=20ms keeps a stack so RESULTS can name WHICH call sat
  // behind the lock, not just that the spin happened.
  const wrapLock = (name) => {
    const orig = Store.prototype[name];
    if (typeof orig !== 'function') return;
    Store.prototype[name] = function (fn, ...rest) {
      let hold = 0, enteredAt = 0;
      const tCall = performance.now();
      const wrapped = (...fa) => { enteredAt = performance.now(); const th = enteredAt; try { return fn.apply(this, fa); } finally { hold += performance.now() - th; } };
      const report = (extra) => {
        const waitMs = +(Math.max(0, (enteredAt || performance.now()) - tCall)).toFixed(2);
        LOCK.done({ name, waitMs, holdMs: +hold.toFixed(2), ...extra });
      };
      try {
        const r = orig.call(this, wrapped, ...rest);
        if (r && typeof r.then === 'function') return r.finally(() => report());
        report();
        return r;
      } catch (e) { report({ threw: true }); throw e; }
    };
  };
  ['withLock', 'withLockAsync', 'withLockTry'].forEach(wrapLock);
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
  const F = (k) => P.frames[k] = P.frames[k] || { frames: 0, fast: 0, sum: 0, max: 0, jank: [], over50: 0 };
  const LT = (k) => P.lt[k] = P.lt[k] || { n: 0, ms: 0, max: 0, samples: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { const b = LT(phaseOf()); b.n++; b.ms += e.duration; if (e.duration > b.max) b.max = e.duration; if (b.samples.length < 5000) b.samples.push({ start: Math.round(e.startTime + P.wallAt), dur: Math.round(e.duration) }); } }).observe({ type: 'longtask', buffered: true });
  let last = performance.now();
  const raf = (t) => { const d = t - last; last = t; if (d > 0) { const f = F(phaseOf()); f.frames++; f.sum += d; if (d > f.max) f.max = d; if (d < 34) f.fast++; else { if (f.jank.length < 5000) f.jank.push(+d.toFixed(1)); if (d > 50) f.over50++; } } requestAnimationFrame(raf); };
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
    return { frames: f ? f.frames : 0, fast: f ? f.fast : 0, jankN: j.length, jankP50: j.length ? j[Math.floor(j.length / 2)] : 0, jankP95: j.length ? j[Math.floor(j.length * 0.95)] : 0, jankMax: f ? +f.max.toFixed(1) : 0, over50: f ? f.over50 : 0, worst: j.length ? [...j].reverse().slice(0, 5) : [], ltN: b ? b.n : 0, ltMs: b ? +b.ms.toFixed(1) : 0, ltMax: b ? +b.max.toFixed(1) : 0, roomDraws: sb ? sb.draws : 0, roomDrawMs: sb ? +sb.ms.toFixed(1) : 0 };
  };
  return { ok: true };
`;

const summaryJs = `
  const P = window.__jank;
  const q = (a, p) => { const x = a.filter(Number.isFinite).slice().sort((m, n) => m - n); return x.length ? +x[Math.min(x.length - 1, Math.floor((x.length - 1) * p))].toFixed(2) : 0; };
  const stat = (a) => ({ n: a.length, p50: q(a, .5), p95: q(a, .95), max: a.length ? +Math.max(...a).toFixed(2) : 0, sum: +a.reduce((s, x) => s + x, 0).toFixed(1) });
  const secs = (performance.now() - P.t0) / 1000;
  const frames = {};
  for (const [k, f] of Object.entries(P.frames)) { const j = [...f.jank].sort((a, b) => a - b); frames[k] = { frames: f.frames, fps: +(f.frames / (f.sum / 1000 || 1)).toFixed(1), fast: f.fast, jankN: f.jank.length, jankP50: j.length ? j[Math.floor(j.length / 2)] : 0, jankP95: j.length ? j[Math.floor(j.length * 0.95)] : 0, jankMax: +f.max.toFixed(1), over50: f.over50 || 0, worst: [...f.jank].sort((a, b) => b - a).slice(0, 10) }; }
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
      const t = store.createTask({ title: `${pick(verbs)} the ${pick(objs)} (seed ${++seeded})`, description: 'Seeded history for the real-agent jank baseline board. Realistic description so card snippets render.', assignee: status === 'done' ? (Math.random() < 0.15 ? null : pick(nodes)) : null, createdBy: pick(nodes) });
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

// ---- real merge-gate load (t_5fb1b9cf) -----------------------------------------------------
// A throwaway clone of the app inside the data root: base branch + 1-commit branch + linked
// worktree. The gate's repoRootOf(worktreePath) resolves 3 levels up, so the worktree sits at
// <repo>/wt/perf. Flipping a task that points there to done runs the app's genuine gateMerge
// (merge -> clone node_modules from the clone's app/node_modules -> `npm test` in the worktree).
// SB.guardRepo passes because everything is inside the harness data root; agents-squad's real
// repo is never touched, and the lab dies with the data root on exit.
function buildGateLab(projectRoot) {
  const lab = path.join(projectRoot, `gate-lab-${GATE_ARM}`);
  const root = path.join(lab, 'repo');
  const appDir = path.join(root, 'app');
  try { fs.rmSync(lab, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(APP, appDir, { recursive: true, filter: (s) => !/(^|\/)(node_modules|e2e-shots|results)(\/|$)/.test(s) });
  fs.cpSync(path.join(APP, 'node_modules'), path.join(appDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\ne2e-shots\n*.log\n');
  if (GATE_SUITE_MS > 0) { // smoke runs only: fake suite that emits the gate's own summary shape
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    pkg.scripts.test = `node -e "setTimeout(()=>console.log('\\u2139 tests 1\\n\\u2139 pass 1\\n\\u2139 fail 0'),${GATE_SUITE_MS})"`;
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg, null, 2));
  }
  const g = (args, opts = {}) => CP.execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
  g(['init', '-b', 'main']); g(['config', 'user.email', 'perf@colvari.local']); g(['config', 'user.name', 'perf-gate']);
  g(['add', '-A']); g(['commit', '-qm', `base for the gate-load arm ${GATE_ARM}`]);
  // Commit the 1-ahead change on the branch, then put the main worktree back on main — a linked
  // worktree cannot check out a branch the main worktree itself is on (smoke run 1: worktree add fatal).
  g(['checkout', '-qb', `squad/perf-gate-${GATE_ARM}`]);
  fs.appendFileSync(path.join(appDir, 'README.md'), `\n<!-- gate-load arm ${GATE_ARM} @ ${new Date().toISOString()} -->\n`);
  g(['commit', '-qam', `gate load commit ${GATE_ARM}`]);
  g(['checkout', '-q', 'main']);
  const wt = path.join(root, '.squad', 'worktrees', 'perf'); // 3 levels below root, mirroring the app's .squad/worktrees/<id> layout (repoRootOf walks 3 up)
  g(['worktree', 'add', wt, `squad/perf-gate-${GATE_ARM}`]);
  return { root, wt, branch: `squad/perf-gate-${GATE_ARM}` };
}

const GATE = { info: null, phases: [] }; // info: {root, wt, branch, tid, startedAt, endedAt, ...}
const GATE_END_RE = /^(auto-merged|nothing merged|merge gate: NOT merged|merge refused|worktree removed|merge gate error|merge gate: base branch|auto-merge blocked)/;
function gateTaskFile(seeded) { return path.join(seeded.dir, '.squad', 'board', 'tasks', GATE.info.tid + '.json'); }
function readGateTask(seeded) {
  try { return JSON.parse(fs.readFileSync(gateTaskFile(seeded), 'utf8')); } catch { return null; }
}
async function startGate(seeded, lab) {
  GATE.info = { ...lab };
  const t = await ex(`return call('createTask', { title: 'Gate load probe (${GATE_ARM})', description: 'Perf harness load source: flipping this task runs the real merge gate (npm test in a throwaway worktree clone) while agents stream. Do not work this task.', assignee: null })`);
  GATE.info.tid = t && t.id;
  if (!GATE.info.tid) throw new Error('gate probe task not created: ' + JSON.stringify(t));
  await ex(`await call('updateTask', ${jsq(GATE.info.tid)}, { worktreePath: ${jsq(GATE.info.wt)}, worktreeBranch: ${jsq(GATE.info.branch)} })`);
  GATE.info.startedAt = Date.now();
  await ex(`await call('updateTask', ${jsq(GATE.info.tid)}, { status: 'done' })`);
  console.log('[realperf] gate triggered: ' + JSON.stringify({ tid: GATE.info.tid, root: GATE.info.root, branch: GATE.info.branch }));
  return GATE.info;
}
// Poll the gate task's file until an end-comment lands; records the live-gate phase timeline.
async function gateResult(seeded, timeoutMs) {
  const t1 = Date.now() + timeoutMs;
  while (Date.now() < t1) {
    const t = readGateTask(seeded);
    const comments = (t && t.comments || []).map((c) => String(c.text || ''));
    const live = (() => { try { return JSON.parse(fs.readFileSync(path.join(GATE.info.root, '.squad', 'merge-gate.live.json'), 'utf8')); } catch { return null; } })();
    if (live && live.phase && (GATE.phases.length === 0 || GATE.phases[GATE.phases.length - 1].phase !== live.phase)) GATE.phases.push({ phase: live.phase, at: Date.now() });
    const end = comments.find((c) => GATE_END_RE.test(c));
    if (end) {
      GATE.info.endedAt = Date.now();
      GATE.info.suiteDoneAt = (comments.find((c) => /npm test/.test(c) && /auto-merged|NOT merged/.test(c)) ? GATE.info.endedAt : null) || GATE.info.suiteDoneAt;
      return { ...GATE.info, status: t && t.status, comments, finalComment: end };
    }
    await WAIT(3000);
  }
  return { ...GATE.info, timedOut: true, status: (readGateTask(seeded) || {}).status };
}

// ---- external process sampler (per-agent + gate-tree CPU/RAM, ambient load) ----------------
// Agents: the store's run-pids files name each live CLI pid (`agent-run <node> task:<id>`).
// Gate: the gate's own pidfile (<root>/.squad/merge-gate.pids) + descendant walk over one
// whole-system `ps` per second. Cumulative CPU per pid comes from ps `time` (monotonic);
// pcpu/RSS are point-in-time. One ps call per tick keeps the sampler's own footprint honest.
const PS = { samples: [], perAgent: {}, gate: null, errors: 0 };
let PS_RUN = false;
const psTimeMs = (s) => { if (!s) return 0; const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/); if (!m) return 0; return ((((+m[1] || 0) * 24 + (+m[2] || 0)) * 60 + (+m[3] || 0)) * 60 + (+m[4] || 0)) * 1000; };
let curPhase = 'warm';
function parsePsTable(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pcpu: +m[3], rss: +m[4], tms: psTimeMs(m[5]), args: m[6] || '' });
  }
  return rows;
}
function psTick(rows, seeded) {
  const names = {};
  try { for (const f of fs.readdirSync(path.join(seeded.dir, '.squad', 'run-pids'))) { const pid = Number(f); if (!pid) continue; const nm = (fs.readFileSync(path.join(seeded.dir, '.squad', 'run-pids', f), 'utf8').split('\t')[2] || '').trim(); names[pid] = nm; } } catch {}
  const agents = {}; let aPcpu = 0, aRss = 0;
  for (const r of rows) {
    if (names[r.pid] === undefined || !/helpycode/.test(r.args)) continue;
    const nm = ((names[r.pid].match(/agent-run ([^ ]+)/) || [])[1]) || ('pid' + r.pid);
    agents[nm] = { pid: r.pid, pcpu: r.pcpu, rssKb: r.rss, cpuMs: r.tms };
    aPcpu += r.pcpu; aRss += r.rss;
  }
  let g = null;
  if (GATE.info && GATE.info.startedAt) {
    const kids = {}; for (const r of rows) (kids[r.ppid] = kids[r.ppid] || []).push(r.pid);
    let roots = [];
    try { roots = fs.readFileSync(path.join(GATE.info.root, '.squad', 'merge-gate.pids'), 'utf8').split('\n').filter(Boolean).map((l) => Number(l.split('\t')[0])); } catch {}
    const stack = roots.filter((p) => p > 1), seen = new Set(stack), gpids = new Set(stack);
    while (stack.length) { const p = stack.pop(); for (const c of kids[p] || []) if (!seen.has(c)) { seen.add(c); gpids.add(c); stack.push(c); } }
    if (gpids.size) {
      let gPcpu = 0, gRss = 0, gCpu = 0; const top = [];
      for (const r of rows) if (gpids.has(r.pid)) { gPcpu += r.pcpu; gRss += r.rss; gCpu += r.tms; top.push({ pid: r.pid, pcpu: r.pcpu, rssKb: r.rss, cmd: String(r.args).replace(/.*\/(node|npm|sh)\s*/, '$1 ').slice(0, 60) }); }
      g = { n: gpids.size, pcpu: +gPcpu.toFixed(1), rssKb: gRss, cpuMs: gCpu, top: top.sort((x, y) => y.pcpu - x.pcpu).slice(0, 6) };
    }
  }
  return { agents, aPcpu, aRss, gate: g };
}
function psAggregate(tick) {
  PS.samples.push({ at: Date.now(), phase: curPhase, load1m: +os.loadavg()[0].toFixed(2), freeMb: Math.round(os.freemem() / 1048576), agentPcpu: +tick.aPcpu.toFixed(1), agentRssKb: tick.aRss, gate: tick.gate ? { n: tick.gate.n, pcpu: tick.gate.pcpu, rssKb: tick.gate.rssKb } : null });
  for (const [nm, a] of Object.entries(tick.agents)) {
    const rec = PS.perAgent[nm] = PS.perAgent[nm] || { name: nm, pid: a.pid, samples: 0, pcpuSum: 0, pcpuMax: 0, rssSum: 0, rssMax: 0, cpuMs: 0 };
    rec.samples++; rec.pcpuSum += a.pcpu; if (a.pcpu > rec.pcpuMax) rec.pcpuMax = a.pcpu; rec.rssSum += a.rssKb; if (a.rssKb > rec.rssMax) rec.rssMax = a.rssKb; if (a.cpuMs > rec.cpuMs) rec.cpuMs = a.cpuMs;
  }
  if (tick.gate) {
    const rec = PS.gate = PS.gate || { samples: 0, pcpuSum: 0, pcpuMax: 0, rssSum: 0, rssMax: 0, cpuMs: 0, pidsMax: 0 };
    rec.samples++; rec.pcpuSum += tick.gate.pcpu; if (tick.gate.pcpu > rec.pcpuMax) rec.pcpuMax = tick.gate.pcpu; rec.rssSum += tick.gate.rssKb; if (tick.gate.rssKb > rec.rssMax) rec.rssMax = tick.gate.rssKb; if (tick.gate.cpuMs > rec.cpuMs) rec.cpuMs = tick.gate.cpuMs; if (tick.gate.n > rec.pidsMax) rec.pidsMax = tick.gate.n;
  }
}
async function extSampler(seeded) {
  while (PS_RUN) {
    const at = Date.now();
    try {
      const out = await new Promise((res, rej) => CP.execFile('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,time=,args='], { maxBuffer: 16 << 20 }, (e, o) => (e ? rej(e) : res(o))));
      psAggregate(psTick(parsePsTable(out), seeded));
    } catch { PS.errors++; }
    await WAIT(Math.max(0, 1000 - (Date.now() - at)));
  }
}

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
  // AGENT_WS is baked to a page-side array string — the page-side for loop owns `i`, and a
  // harness-side ${jsq(AGENT_WS[i])} would throw ReferenceError (i is not defined) before the
  // string is ever handed to the page (5-agent run died at seed() on the first attempt).
  const wsJs = JSON.stringify(AGENT_WS);
  const res = await ex(`
    const p = await call('createProject', 'Real-agent jank baseline');
    switchTo({ p: p.id }); await w(600); await refresh();
    await call('saveSettings', { helpycodePath: ${jsq(HCPATH)}, useWorktrees: false, maxConcurrency: ${AGENTS}, maxRuns: ${AGENTS * TASKS_PER_AGENT + 2}, requireApproval: false, stallTimeoutMin: ${STALL_MIN} });
    const nodes = [];
    const agentWs = ${wsJs};
    for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'Real-' + (i + 1), role: 'Dev', x: 90 + (i % 3) * 240, y: 110 + Math.floor(i / 3) * 190, runtime: 'helpycode', model: ${jsq(MODEL)}, workdir: agentWs[i] }));
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
  let gateLab = null;
  if (GATE_ENABLED) { // build the throwaway clone BEFORE any measurement window (fs+git heavy)
    console.log('[realperf] building gate lab (throwaway clone for the real merge gate)...');
    gateLab = buildGateLab(process.env.AGENTS_SQUAD_PROJECT);
    console.log('[realperf] gate lab ready', JSON.stringify(gateLab));
  }
  await ex(`await refresh(); showTab('chat'); await w(400);`);
  const inst = await ex(INSTRUMENT);
  if (!inst || !inst.ok) throw new Error('instrumentation failed: ' + JSON.stringify(inst));
  await phase('warm');

  const working = await waitForAgents(seeded);
  const WARM_PERF = performance.now(); // steady-window boundary: excludes boot/seed cold reads
  LOCK.win = { calls: 0, waitMs: 0, holdMs: 0, waitMax: 0, over50: 0, stacks: [] }; // steady lock window (t_155e7859)
  console.log(`[realperf] ${working}/${AGENTS} real helpycode agents working`);
  await WAIT(WARM_MS);

  // Real-load arm: trigger the app's REAL merge gate now — its npm test runs concurrently with
  // every campaign below (that concurrency IS the measured condition, per t_5fb1b9cf).
  let gateRec = null;
  if (GATE_ENABLED) gateRec = await startGate(seeded, gateLab);

  // CPU sampling across all phases, 1/s, tagged with the renderer's current phase.
  const series = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const at = Date.now();
      let ph = 'warm';
      try { ph = (await ex(`return window.__jank.phase`)) || 'warm'; curPhase = ph; } catch {}
      const metrics = app.getAppMetrics();
      series.push({ at, phase: ph, procs: metrics.map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu ? +m.cpu.percentCPUUsage.toFixed(2) : 0, wake: m.cpu ? +m.cpu.idleWakeupsPerSecond.toFixed(2) : 0, mem: m.memory ? m.memory.workingSetSize : 0 })) });
      await WAIT(Math.max(0, 1000 - (Date.now() - at)));
    }
  })();
  PS_RUN = true;
  const psamp = extSampler(seeded);

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
  let elOver50 = 0, elOver200 = 0, elWatchMax = 0, elWatchNext = Date.now();
  const elBlocks = []; // t_155e7859: every >50 ms late firing, correlated with IPC/lock causes below
  const elWatcher = setInterval(() => { // 20 ms drift watch: fires late by ~the longest block
    const now = Date.now();
    const late = now - elWatchNext;
    if (late > elWatchMax) elWatchMax = late;
    if (late > 50) { elOver50++; if (late > 200) elOver200++; if (elBlocks.length < 500) elBlocks.push({ at: now, lateMs: +late.toFixed(0) }); }
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
  // Real-load arm: campaigns are done but the gate's npm test may still be running — keep the
  // stall/frame instrumentation and the PS sampler armed until the gate verdict lands (phase
  // 'gatetail': idle UI under gate + agent load; the main thread pays the gate's store bursts).
  if (GATE_ENABLED) {
    await phase('gatetail');
    console.log('[realperf] waiting for gate verdict (campaigns done; suite may still be running)...');
    gateRec = await gateResult(seeded, GATE_WAIT_MS);
    console.log('[realperf] gate settled: ' + JSON.stringify({ finalComment: gateRec.finalComment, timedOut: !!gateRec.timedOut, wallSecs: gateRec.endedAt ? Math.round((gateRec.endedAt - gateRec.startedAt) / 1000) : null }));
  }
  EL.disable();
  clearInterval(elWatcher);
  const elWindowSecs = +(Math.max(1, Date.now() - EL_T0) / 1000).toFixed(1);
  const elMs = (ns) => +((ns || 0) / 1000).toFixed(2);

  sampling = false;
  await sampler;
  PS_RUN = false;
  await psamp;
  const trace = await stopTrace();
  const summary = await ex(summaryJs);
  summary.trace = trace;
  summary.chatOpenSamples = probeRecs;
  summary.scroll = scrollRecs;

  // ---- real-load additions (t_5fb1b9cf): per-agent CPU/RAM, gate run, bars, ambient ----
  summary.perAgent = Object.values(PS.perAgent).map((r) => ({ name: r.name, pid: r.pid, samples: r.samples, pcpuAvg: +(r.pcpuSum / (r.samples || 1)).toFixed(2), pcpuMax: +r.pcpuMax.toFixed(2), rssAvgMb: +(r.rssSum / (r.samples || 1) / 1024).toFixed(1), rssMaxMb: +(r.rssMax / 1024).toFixed(1), cpuTotalS: +(r.cpuMs / 1000).toFixed(1) })).sort((a, b) => b.cpuTotalS - a.cpuTotalS);
  summary.gate = GATE_ENABLED ? {
    arm: GATE_ARM, root: GATE.info && GATE.info.root, branch: GATE.info && GATE.info.branch, tid: GATE.info && GATE.info.tid,
    startedAt: GATE.info && GATE.info.startedAt, endedAt: GATE.info && GATE.info.endedAt,
    wallSecs: GATE.info && GATE.info.startedAt && GATE.info.endedAt ? Math.round((GATE.info.endedAt - GATE.info.startedAt) / 1000) : null,
    phases: GATE.phases, timedOut: !!(gateRec && gateRec.timedOut), finalComment: gateRec && gateRec.finalComment, status: gateRec && gateRec.status,
    comments: gateRec ? gateRec.comments : [],
    proc: PS.gate ? { samples: PS.gate.samples, pidsMax: PS.gate.pidsMax, pcpuAvg: +(PS.gate.pcpuSum / (PS.gate.samples || 1)).toFixed(2), pcpuMax: +PS.gate.pcpuMax.toFixed(2), rssAvgMb: +(PS.gate.rssSum / (PS.gate.samples || 1) / 1024).toFixed(1), rssMaxMb: +(PS.gate.rssMax / 1024).toFixed(1), cpuTotalS: +(PS.gate.cpuMs / 1000).toFixed(1) } : null,
  } : { enabled: false };
  {
    const loads = PS.samples.map((s) => s.load1m).sort((a, b) => a - b);
    summary.ambient = { samples: PS.samples.length, loadMedian: loads.length ? +loads[Math.floor(loads.length / 2)].toFixed(2) : 0, loadMax1m: +LOAD_PEAK.max.toFixed(2), freeMbMin: PS.samples.length ? Math.min(...PS.samples.map((s) => s.freeMb)) : 0, psErrors: PS.errors };
  }
  {
    const fr = Object.values(summary.frames || {});
    const maxFrame = fr.length ? Math.max(...fr.map((f) => f.jankMax || 0)) : 0;
    const over50 = fr.reduce((s, f) => s + (f.over50 || 0), 0);
    const clickMs = (summary.chatOpenSamples || []).filter((r) => r && r.ok).map((r) => r.ms).sort((a, b) => a - b);
    const cq = (p) => (clickMs.length ? +clickMs[Math.min(clickMs.length - 1, Math.floor(p * clickMs.length))].toFixed(2) : 0);
    summary.bars = {
      mainStall: { barMs: 200, maxLateMs: +elWatchMax.toFixed(1), over200: elOver200, over50: elOver50, pass: elWatchMax <= 200 },
      rendererFrame: { barMs: 50, maxFrameMs: +maxFrame.toFixed(1), over50, pass: maxFrame <= 50 },
      clickLatency: { n: clickMs.length, p50: cq(0.5), p95: cq(0.95), max: clickMs.length ? Math.max(...clickMs) : 0 },
    };
  }

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
  // Boot getAll (t_155e7859): the cold first getAll(s) before any agent works — pays every
  // list*() on a just-written store (~1.5 s class, one call per process in prior runs).
  const bootGA = PERF_IPC.filter((c) => c.name === 'getAll' && c.at < WARM_PERF);
  summary.ipc.bootGetAll = { n: bootGA.length, maxMs: bootGA.length ? +Math.max(...bootGA.map((c) => +c.ms.toFixed(2))).toFixed(2) : 0, allMs: bootGA.map((c) => +c.ms.toFixed(2)) };
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
    // t_5fb1b9cf: WARN, never discard the run — the gate + per-agent CPU/RAM data survive an
    // agent-free window; dead-run emptiness is visible in summary.streamPushes.liveSubs.
    const diag = await ex(`return { working: Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length, running: !!S.orch.running, todo: S.tasks.filter((t) => t.status === 'todo').length, logTail: logs.slice(-6).map((l) => l.kind + ': ' + String(l.text).slice(0, 120)) }`).catch(() => ({}));
    console.error('[realperf] WARNING: only ' + liveSubs.length + '/' + streamSubs.length + ' 10s subwindows had feed updates — summary kept, see streamPushes. Diagnostics: ' + JSON.stringify(diag, null, 2));
    summary.streamPushes.diag = diag;
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
  // t_155e7859 — named causes for main-thread blocks > 50 ms: every drift-watch late firing is
  // intersected with the PERF_IPC table (which api call was running) and the LOCK table (which
  // caller sat behind the sleepSync spin). PERF_IPC/LOCK `at` are performance.now()-based; the
  // drift watch is Date.now()-based — bridged via the delta of the two clocks at read time.
  {
    const perfNowAtRead = performance.now();
    const wallNowAtRead = Date.now();
    const bridge = (perfAt) => wallNowAtRead - (perfNowAtRead - perfAt); // performance.now → wall clock
    for (const l of LOCK.stacks) { l._we = bridge(l.atP); l._ws = l._we - l.waitMs - l.holdMs; }
    const causes = elBlocks.map((b) => {
      const s0 = b.at - b.lateMs, s1 = b.at;
      const ipc = PERF_IPC.map((c) => ({ c, ws: bridge(c.at), we: bridge(c.at) + c.ms }))
        .filter((x) => x.ws < s1 && x.we > s0)
        .sort((x, y) => Math.min(y.c.ms, y.we - y.ws) - Math.min(x.c.ms, x.we - x.ws))
        .slice(0, 2).map((x) => `${x.c.name} ${+x.c.ms.toFixed(0)}ms`);
      const locks = LOCK.stacks.filter((l) => l._ws < s1 && l._we > s0)
        .sort((x, y) => y.waitMs - x.waitMs)
        .slice(0, 2).map((l) => `${l.lock} wait ${l.waitMs}ms: ${String(l.stack).split(' | ')[0]}`);
      return { at: b.at, lateMs: b.lateMs, ipc: ipc.length ? ipc : null, locks: locks.length ? locks : null };
    }).sort((a, b) => b.lateMs - a.lateMs).slice(0, 24);
    for (const c of causes) if (!c.ipc && !c.locks) c.cause = 'unknown';
    summary.mainBlocks = { over50: elOver50, windowSecs: elWindowSecs, top: causes };
  }
  // withLock wait/hold split (t_155e7859): the sleepSync(10) spin at store.js:310-323. LOCK.win
  // is the steady window (armed when the agents are confirmed working).
  summary.locks = {
    session: { calls: LOCK.calls, waitMs: +LOCK.waitMs.toFixed(1), waitMax: +LOCK.waitMax.toFixed(1), holdMs: +LOCK.holdMs.toFixed(1), holdMax: +LOCK.holdMax.toFixed(1), over10: LOCK.over10, over50: LOCK.over50 },
    byLock: (() => { const m = {}; for (const s of LOCK.stacks) { const k = s.lock; (m[k] = m[k] || { longWaits: 0, worst: 0 }); m[k].longWaits++; if (s.waitMs > m[k].worst) m[k].worst = s.waitMs; } return m; })(),
    steady: LOCK.win ? { calls: LOCK.win.calls, waitMs: +LOCK.win.waitMs.toFixed(1), waitMax: +LOCK.win.waitMax.toFixed(1), holdMs: +LOCK.win.holdMs.toFixed(1), over50: LOCK.win.over50 } : null,
    slowWaits: [...LOCK.stacks].sort((a, b) => b.waitMs - a.waitMs).slice(0, 20),
  };
  summary.env = {
    agents: AGENTS, tasksPerAgent: TASKS_PER_AGENT, reps: REPS, scrollReps: SCROLL_REPS, traceMs: trace.windowMs || TRACE_MS,
    staggerMs: STAGGER_MS, stallMin: STALL_MIN,
    seeds: { tasks: SEED_TASKS, logs: SEED_LOGS, runs: SEED_RUNS }, cli: HCPATH, model: MODEL,
    gate: GATE_ENABLED ? { arm: GATE_ARM, fakeSuite: GATE_SUITE_MS > 0, waitMs: GATE_WAIT_MS } : false,
    platform: `${os.platform()} ${os.arch()} cpus=${os.cpus().length}`,
    load: { start1m: +LOAD_START[0].toFixed(2), end1m: +os.loadavg()[0].toFixed(2), end5m: +os.loadavg()[1].toFixed(2), max1m: +LOAD_PEAK.max.toFixed(2) },
    electron: process.versions.electron,
    commit: (() => { try { return require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
  };
  // Critic (t_155e7859): a 5-agent run is only valid on a quiet machine — load1m must stay < 5.
  summary.env.loadValid = summary.env.load.max1m < 5;
  if (!summary.env.loadValid) console.error(`[realperf] WARNING: load1m peaked at ${summary.env.load.max1m} (>=5) — run marked NOT valid, re-run on a quiet machine`);
  fs.writeFileSync(path.join(OUT, 'ipc-raw.json'), JSON.stringify(PERF_IPC));
  fs.writeFileSync(path.join(OUT, 'ps-raw.json'), JSON.stringify({ perAgent: PS.perAgent, gate: PS.gate, samples: PS.samples }));
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
  const gate = s.gate || {};
  const perAgentRows = (s.perAgent || []).map((a) => `| ${a.name} (${a.pid}) | ${a.pcpuAvg} | ${a.pcpuMax} | ${a.rssAvgMb} | ${a.rssMaxMb} | ${a.cpuTotalS} |`).join('\n');
  const loaded = s.env.gate ? `**loaded-by-design arm**: ${s.env.agents} agents streaming + the app's REAL merge gate (npm test${s.env.gate.fakeSuite ? ' [FAKE SMOKE SUITE]' : ''}) + ambient box load` : `ambient load recorded (quiet-machine protocol of t_155e7859 NOT applied)`;
  return `# Real-agent chat jank — ${s.env.agents} helpycode agents${s.env.gate ? ' + real merge gate' : ''}

${s.env.platform} · electron ${s.env.electron} · commit ${String(s.env.commit).slice(0, 9)} · load1m ${s.env.load.start1m}→${s.env.load.end1m} (peak ${s.env.load.max1m}, median ${s.ambient ? s.ambient.loadMedian : '—'})
${s.env.agents} real helpycode agents (${s.env.model}) · grown board ${s.env.seeds.tasks} tasks / ${s.env.seeds.logs} logs / ${s.env.seeds.runs} runs · room draws ${s.chatDraws.n} (${s.chatDraws.perSec}/s, Σ ${s.chatDraws.msPerSec} ms/s)
${loaded}

## (0) Bars — t_5fb1b9cf (evaluated UNDER this load)

| bar | limit | measured | pass |
|---|---:|---:|---|
| main-process stall (drift-watch max lateness) | ≤ 200 ms | ${s.bars.mainStall.maxLateMs} ms (${s.bars.mainStall.over200} firings >200 ms, ${s.bars.mainStall.over50} >50 ms) | ${s.bars.mainStall.pass ? 'PASS' : 'FAIL'} |
| renderer frame (max, any phase) | ≤ 50 ms | ${s.bars.rendererFrame.maxFrameMs} ms (${s.bars.rendererFrame.over50} frames >50 ms) | ${s.bars.rendererFrame.pass ? 'PASS' : 'FAIL'} |
| click latency (all click probes pooled) | recorded | n=${s.bars.clickLatency.n}, p50 ${s.bars.clickLatency.p50} / p95 ${s.bars.clickLatency.p95} / max ${s.bars.clickLatency.max} ms | recorded |

## (g) Real merge-gate run${s.env.gate ? '' : ' (not enabled this run)'}

${s.env.gate ? `- branch ${gate.branch || '—'} → verdict: **${gate.finalComment ? String(gate.finalComment).slice(0, 180) : (gate.timedOut ? 'STILL RUNNING at summary time' : '—')}** (wall ${gate.wallSecs != null ? gate.wallSecs + ' s' : '—'}${(gate.phases || []).length ? `, phases: ${gate.phases.map((p) => p.phase + '@' + Math.round((p.at - (gate.startedAt || p.at)) / 1000) + 's').join(' → ')}` : ''})
- gate process tree: ${gate.proc ? `max ${gate.proc.pidsMax} pids · pcpu avg ${gate.proc.pcpuAvg}% / max ${gate.proc.pcpuMax}% · RSS avg ${gate.proc.rssAvgMb} / max ${gate.proc.rssMaxMb} MB · Σ CPU time ${gate.proc.cpuTotalS} s over ${gate.proc.samples} samples` : '—'}
- task status at end: ${gate.status || '—'}` : 'not enabled'}

## (p) Per-agent CPU/RAM (ps over the real CLI pids, 1/s)

| agent (pid) | %cpu avg | %cpu max | RSS avg MB | RSS max MB | Σ CPU s |
|---|---:|---:|---:|---:|---:|
${perAgentRows || '| — | — | — | — | — | — |'}

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

## (c2) Main-thread blocks > 50 ms — named causes (t_155e7859)

${s.env.load && s.env.load.max1m >= 5 ? (s.env.gate ? `ℹ load1m peaked ${s.env.load.max1m} — expected: loaded-by-design arm (bars evaluated under load)\n\n` : `⚠ load1m peaked ${s.env.load.max1m} (>= 5) — run NOT valid, re-run on a quiet machine\n\n`) : ''}
${(s.mainBlocks && s.mainBlocks.top || []).length ? s.mainBlocks.top.map((b) => `- ${b.lateMs} ms @ ${new Date(b.at).toISOString().slice(11, 19)} — ${b.locks ? b.locks.join(' | ') : ''}${b.ipc ? (b.locks ? ' · IPC during: ' : 'IPC during: ') + b.ipc.join(', ') : ''}${(!b.ipc && !b.locks) ? 'unknown (no IPC/lock overlap; see trace-main.cpuprofile)' : ''}`).join('\n') : `none (${s.mainBlocks.over50} late firings over ${s.mainBlocks.windowSecs} s)`}

## (c3) Store lock waits (withLock / withLockAsync / withLockTry — sleepSync spin, store.js:310)

Session: ${s.locks.session.calls} calls · wait Σ ${s.locks.session.waitMs} ms (max ${s.locks.session.waitMax}) · hold Σ ${s.locks.session.holdMs} ms (max ${s.locks.session.holdMax}) · waits >10 ms: ${s.locks.session.over10} · >50 ms: ${s.locks.session.over50}
Steady window (post agent-start): ${s.locks.steady ? `${s.locks.steady.calls} calls · wait Σ ${s.locks.steady.waitMs} ms (max ${s.locks.steady.waitMax}) · hold Σ ${s.locks.steady.holdMs} ms · waits >50 ms: ${s.locks.steady.over50}` : '—'}
${Object.keys(s.locks.byLock || {}).length ? `Long waits by lock path: ${Object.entries(s.locks.byLock).map(([k, v]) => `${k} ×${v.longWaits} (worst ${v.worst} ms)`).join(' · ')}` : ''}
${(s.locks.slowWaits || []).length ? `Top waits:\n${s.locks.slowWaits.slice(0, 8).map((l) => `- ${l.waitMs} ms ${l.lock} (held ${l.holdMs} ms): ${l.stack.split(' | ').slice(0, 3).join(' | ')}`).join('\n')}` : ''}

## Trace — self time by function (${s.env.traceMs} ms window)

Renderer: ${(tr.renderer ? tr.renderer.top.slice(0, 12) : []).map((x) => `${x.name} ${x.selfMs}`).join(' · ') || '—'}

Main: ${(tr.main ? tr.main.top.slice(0, 12) : []).map((x) => `${x.name} ${x.selfMs}`).join(' · ') || '—'}

Long tasks → functions (renderer, worst first):
${(tr.longTaskAttribution || []).map((a) => `- ${a.durMs} ms: ${a.during.join(' | ')}`).join('\n') || '—'}

## IPC round-trips (${s.ipc.perSec}/s)

Steady window (post agent-start, n=${s.ipc.steady.n}): **getAll p50 ${s.ipc.steady.getAll.msP50} / p95 ${s.ipc.steady.getAll.msP95} / max ${s.ipc.steady.getAll.msMax} ms** (n=${s.ipc.steady.getAll.n})
Boot getAll (pre agent-start, n=${s.ipc.bootGetAll.n}): max ${s.ipc.bootGetAll.maxMs} ms${s.ipc.bootGetAll.allMs.length > 1 ? ` (all: ${s.ipc.bootGetAll.allMs.join(', ')})` : ''}

| call | n | /s | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|---:|
${Object.entries(s.ipc.byName || {}).map(irow).join('\n')}
`;
}

// entry is the did-finish-load handler — never call main() at script load
