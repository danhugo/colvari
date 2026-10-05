#!/usr/bin/env node
'use strict';
/*
 * Log-pane visual-stability + render-path probe (t_536d312c). Run from app/ with Electron:
 *   PERF_AGENTS=2 PERF_OUT=/tmp/colvari-logjitter ./node_modules/.bin/electron test/perf/log-jitter.js
 *
 * Instruments #log (obs tab) while real agents stream. BASELINE.md names obs the worst tab in two
 * independent sessions, with the log pane's full-render-vs-fast-append split as the next renderer
 * track — so the probe's core evidence is: renderLog / appendLogTail call counts and durations,
 * WHY the fast-append path bails to a full render (bailout reasons re-derived in the same order
 * as appendLogTail checks them), long tasks >50 ms, layout shifts, and scroll/pin behaviour of
 * the live tail.
 *
 * PERF_SYNTHETIC=1: no agents at all — only the app's own 2s backstop refresh against the static
 * seeded feed, isolating renderer-internal movers from streaming.
 *
 * Knobs (env): PERF_AGENTS (2), PERF_STREAM_MS (30000), PERF_SEED_LOGS (1500), PERF_OUT.
 * Caveat: renderLog refs captured at event-registration time (bindSubToggles, scroll handler)
 * keep the original — their cost still shows up in longtasks, just not in P.renders.
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(process.env.PERF_APP_DIR || path.join(__dirname, '../..'));
const MAIN = path.join(APP, 'src/main.js');
const HCPATH = process.env.PERF_HCPATH || '/Users/d/.local/bin/helpycode';
const MODEL = process.env.PERF_HC_MODEL || 'elice/z-ai/glm-5.3-flash';
const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `colvari-log-jitter-${Date.now()}`);
const AGENTS = Math.max(1, Number(process.env.PERF_AGENTS || 2));
const STREAM_MS = Math.max(5000, Number(process.env.PERF_STREAM_MS || 30000));
const SEED_LOGS = Math.max(0, Number(process.env.PERF_SEED_LOGS || 1500));
const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsq = (v) => JSON.stringify(v);
fs.mkdirSync(OUT, { recursive: true });
process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-logjitter-root-'));
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
    try { await main(); } catch (error) { console.error('[log-jitter] failed:', error && error.stack || error); app.exit(1); }
  });
});

const ex = (script) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${script} })()`);
const exT = (script, ms = 30000) => Promise.race([ex(script), WAIT(ms).then(() => { throw new Error('renderer-timeout'); })]);

function seedStore(dir, nodes) {
  const { Store } = require(path.join(APP, 'src/store.js'));
  const store = new Store(dir);
  const now = Date.now();
  const words = 'step trace refresh render append delta stream tail pin filter window severity subagent block scroll anchor dispatch line'.split(' ');
  let s = 469;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sentence = () => Array.from({ length: 8 + Math.floor(rnd() * 8) }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  for (let i = 0; i < SEED_LOGS; i++) store.appendLog({ nodeId: nodes[i % nodes.length], kind: i % 3 === 0 ? 'tool' : 'text', text: `${sentence()} (#${i})`, at: now - (SEED_LOGS - i) * 1000, level: 'info' });
}

// Renders/appends: duration + return value per call. For appendLogTail, the bailout reasons are
// snapshotted BEFORE the call, re-derived in the exact order appendLogTail checks them, so a
// false return says which disqualifier fired (first match wins, same as the source).
const INSTRUMENT = `
  if (window.__logPane) return { already: true };
  const box = document.querySelector('#log');
  if (!box) return { error: 'no-log-pane' };
  const P = window.__logPane = {
    startedAt: performance.now(),
    baseline: { rows: box.querySelectorAll('.logrow').length, top: box.scrollTop, height: box.scrollHeight },
    renders: [], appends: [], flushes: [], mutations: [], scrolls: [], shifts: [], longTasks: [], pushes: [], states: [],
    lastRows: box.querySelectorAll('.logrow').length,
  };
  const bailCheck = () => {
    const b = document.querySelector('#log');
    const missing = ['info', 'warn', 'error'].filter((l) => !logLevels.has(l));
    if (b.querySelector('.logempty, .subblock, #log-showall')) return 'blocks-present';
    if ($('#logsearch').value) return 'search';
    if (missing.length) return 'levels-off:' + missing.join(',');
    if (b.scrollTop + b.clientHeight < b.scrollHeight - 20 || !$('#logauto').checked) return 'not-pinned';
    if ($('#logfilter').value) return 'agent-filter';
    if (sel.logTeam) return 'team-scope';
    return null;
  };
  const wrapTimed = (name, rec) => {
    const orig = window[name];
    if (typeof orig !== 'function') return false;
    window[name] = function (...a) {
      const t0 = performance.now();
      try { return orig.apply(this, a); }
      finally { rec(performance.now() - t0); }
    };
    return true;
  };
  if (!wrapTimed('renderLog', (ms) => P.renders.push({ at: +(performance.now() - P.startedAt).toFixed(1), ms: +ms.toFixed(2) }))) P.renderLogMissing = true;
  { // appendLogTail needs its return value, so it gets a dedicated wrapper, not wrapTimed
    const orig = window.appendLogTail;
    if (typeof orig === 'function') window.appendLogTail = function (...a) {
      const reason = bailCheck();
      const t0 = performance.now();
      let ret;
      try { ret = orig.apply(this, a); }
      finally { P.appends.push({ at: +(performance.now() - P.startedAt).toFixed(1), ms: +(performance.now() - t0).toFixed(2), ret: !!ret, reason: ret ? null : (reason || 'window-slide-or-straggler') }); }
      return ret;
    };
    else P.appendLogTailMissing = true;
  }
  {
    const orig = window.flushLogTail;
    if (typeof orig === 'function') window.flushLogTail = function (...a) {
      const before = logs.length;
      const t0 = performance.now();
      try { return orig.apply(this, a); }
      finally { P.flushes.push({ at: +(performance.now() - P.startedAt).toFixed(1), ms: +(performance.now() - t0).toFixed(2), fresh: logs.length - before }); }
    };
  }
  {
    const orig = window.scheduleLogRender;
    if (typeof orig === 'function') window.scheduleLogRender = function (...a) {
      const ret = orig.apply(this, a);
      P.pushes.push({ at: +(performance.now() - P.startedAt).toFixed(1), len: logs.length });
      if (P.pushes.length > 20000) P.pushes.splice(0, 4000);
      return ret;
    };
  }
  const chromeRoots = { header: document.querySelector('header'), sidebar: document.querySelector('#sidebar'), loghead: document.querySelector('.obshead') || document.querySelector('#tab-obs .subhead') };
  P.chrome = [];
  for (const [name, root] of Object.entries(chromeRoots)) {
    if (!root) continue;
    new MutationObserver((records) => {
      const at = +(performance.now() - P.startedAt).toFixed(1);
      for (const r of records) {
        const target = r.target instanceof Element ? r.target : r.target.parentElement;
        P.chrome.push({ at, where: name, type: r.type, target: target && (target.id || String(target.className || '').split(' ')[0] || target.tagName), text: String(target && target.textContent || '').slice(0, 60) });
      }
      if (P.chrome.length > 10000) P.chrome.splice(0, 2000);
    }).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  // Per-row mutations inside the pane: what the streaming actually does to the DOM (appends,
  // rebuilds, the older-bar churn). No getBoundingClientRect here — visibility tagging stalled
  // chat-jitter's page under load; row-count deltas carry the signal.
  new MutationObserver((records) => {
    const at = +(performance.now() - P.startedAt).toFixed(1);
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      const added = r.addedNodes.length, removed = r.removedNodes.length;
      P.mutations.push({ at, type: r.type, target: target && (target.id || String(target.className || '').split(' ')[0] || target.tagName), attr: r.attributeName || null, added, removed });
    }
    if (P.mutations.length > 20000) P.mutations.splice(0, 4000);
  }).observe(box, { subtree: true, childList: true, attributes: true, characterData: true });
  box.addEventListener('scroll', () => P.scrolls.push({ at: +(performance.now() - P.startedAt).toFixed(1), top: Math.round(box.scrollTop), height: box.scrollHeight, rows: box.querySelectorAll('.logrow').length }), { passive: true });
  if (window.PerformanceObserver) {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) P.shifts.push({ at: +e.startTime.toFixed(1), value: e.value }); }).observe({ type: 'layout-shift', buffered: true });
    } catch (error) { P.shiftError = String(error); }
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longTasks.push({ at: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1) }); }).observe({ type: 'longtask', buffered: true });
    } catch (error) { P.longTaskError = String(error); }
  }
  // 10 Hz geometry trace (not per-rAF — per-frame layout reads starve a loaded page).
  P.frames = [];
  let lastState = '';
  const sample = () => {
    const b = document.querySelector('#log');
    if (b) {
      const rows = b.querySelectorAll('.logrow').length;
      const rec = { at: +(performance.now() - P.startedAt).toFixed(1), rows, logs: logs.length, win: logWin, top: Math.round(b.scrollTop), sh: b.scrollHeight, ch: b.clientHeight, older: !!document.getElementById('log-older'), subs: b.querySelectorAll('.subblock').length, auto: $('#logauto').checked };
      const key = [rec.rows, rec.logs, rec.win, rec.top, rec.sh, rec.ch, rec.older, rec.subs, rec.auto].join('|');
      if (key !== lastState) { P.states.push(rec); lastState = key; if (P.states.length > 6000) P.states.shift(); }
      if (rows !== P.lastRows) { P.rowDeltas.push({ at: rec.at, delta: rows - P.lastRows, rows }); P.lastRows = rows; }
    }
    setTimeout(sample, 100);
  };
  P.rowDeltas = [];
  setTimeout(sample, 100);
  return { ok: true, baseline: P.baseline };
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
  const seed = await ex(`const p = await call('createProject', 'Log pane probe'); switchTo({ p: p.id }); await w(300); await refresh(); await call('saveSettings', { helpycodePath: ${jsq(HCPATH)}, useWorktrees: false, maxConcurrency: ${AGENTS}, maxRuns: ${AGENTS + 2}, requireApproval: false, stallTimeoutMin: 5 }); const nodes = []; for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'LogPane-' + (i + 1), role: 'Dev', x: 100 + i * 220, y: 120, runtime: 'helpycode', model: ${jsq(MODEL)} })); await refresh(); return { dir: S.dir, nodes: nodes.map((n) => n.id) };`);
  seedStore(seed.dir, seed.nodes);
  // loadLogs is once-per-project and already ran for this pid; drop the marker so the seeded
  // history is pulled, then clear the team scope so nothing filters the feed.
  const feed = await ex(`logsLoaded.delete(ctx.p); lastV = null; await refresh(); sel.logTeam = ''; showTab('obs'); await w(500); return { logs: logs.length, inProject: logs.filter((l) => l.projectId === ctx.p).length, rows: document.querySelectorAll('#log .logrow').length };`);
  console.log('[log-jitter] seeded feed:', JSON.stringify(feed));
  const armed = await exT(INSTRUMENT, 10000);
  if (!armed || armed.error) throw new Error('instrumentation failed: ' + JSON.stringify(armed));
  if (process.env.PERF_SYNTHETIC === '1') {
    await ex(`window.__synth = setInterval(() => { refresh(); }, 2000); await w(${STREAM_MS}); clearInterval(window.__synth); return true;`).catch((e) => console.error('[log-jitter] synthetic driver ended:', e.message));
  } else {
    const toolTask = (n, id) => `await call('createTask', { title: 'Log feed probe ' + ${n}, description: 'Help stress-test the log pane. Do exactly 12 tool calls, one at a time, each of the exact form: node -e "console.log(process.version, process.uptime())" (only this command, nothing else). After every tool result, write one short sentence as a plain text reply line. Do not run any other command. Never modify, create, or delete anything.', assignee: ${jsq(seed.nodes[n - 1])} });`;
    await ex(`await call('run'); ${toolTask(1)} ${toolTask(2)} await refresh();`);
    try { await waitForWorking(); } catch (e) {
      const diag = await ex(`return { agents: S.orch.agents, todo: S.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').map((t) => t.id + ' ' + t.assignee + ' ' + t.status), logTail: logs.slice(-8).map((l) => l.kind + ': ' + String(l.text).slice(0, 160)) }`).catch(() => ({}));
      throw new Error(e.message + ' — diagnostics: ' + JSON.stringify(diag, null, 2));
    }
  }
  await WAIT(STREAM_MS);
  // Piecewise pull: one hung field must not lose the whole run's evidence.
  const grab = (key, ms) => exT(`return (window.__logPane || {})[${jsq(key)}] || []`, ms).catch(() => []);
  const meta = await exT(`const P = window.__logPane || {}; return { startedAt: P.startedAt, baseline: P.baseline, renderLogMissing: P.renderLogMissing, appendLogTailMissing: P.appendLogTailMissing, frames: P.frames || [], states: P.states || [], rowDeltas: P.rowDeltas || [], shiftError: P.shiftError, longTaskError: P.longTaskError }`, 20000).catch(() => ({}));
  const [renders, appends, flushes, mutations, scrolls, shifts, longTasks, pushes, chrome] = await Promise.all([
    grab('renders', 20000), grab('appends', 20000), grab('flushes', 20000), grab('mutations', 20000),
    grab('scrolls', 15000), grab('shifts', 20000), grab('longTasks', 20000), grab('pushes', 20000), grab('chrome', 20000),
  ]);
  const result = { ...meta, renders, appends, flushes, mutations, scrolls, shifts, longTasks, pushes, chrome };
  fs.writeFileSync(path.join(OUT, 'log-jitter.json'), JSON.stringify(result, null, 2));

  const rMs = renders.map((r) => r.ms), aMs = appends.map((a) => a.ms);
  const bailouts = {};
  for (const a of appends) if (!a.ret) bailouts[a.reason] = (bailouts[a.reason] || 0) + 1;
  const fMs = flushes.map((f) => f.ms);
  const ltDur = longTasks.map((t) => t.dur);
  const spanMs = meta.startedAt ? ((pushes[pushes.length - 1]?.at || 0) - (pushes[0]?.at || 0)) / 1000 : 0;
  const summary = {
    out: OUT, seeded: feed, synthetic: process.env.PERF_SYNTHETIC === '1', spanSec: +spanMs.toFixed(1),
    renderLog: { calls: renders.length, p50: pct(rMs, 0.5), p95: pct(rMs, 0.95), max: rMs.length ? Math.max(...rMs) : 0 },
    appendTail: { calls: appends.length, fast: appends.filter((a) => a.ret).length, bailouts: appends.length - appends.filter((a) => a.ret).length, bailoutReasons: bailouts, p50: pct(aMs, 0.5), p95: pct(aMs, 0.95), max: aMs.length ? Math.max(...aMs) : 0 },
    flushes: { calls: flushes.length, withFreshLines: flushes.filter((f) => f.fresh > 0).length, p50: pct(fMs, 0.5), p95: pct(fMs, 0.95) },
    pushes: { count: pushes.length, ratePerSec: spanMs ? +(pushes.length / spanMs).toFixed(2) : 0 },
    longTasks: { count: longTasks.length, p50: pct(ltDur, 0.5), max: ltDur.length ? Math.max(...ltDur) : 0 },
    shifts: { count: shifts.length, sum: +shifts.reduce((s, x) => s + x.value, 0).toFixed(6) },
    scrolls: { count: scrolls.length, maxDelta: scrolls.reduce((m, x, i, a) => Math.max(m, i ? Math.abs(x.top - a[i - 1].top) : 0), 0) },
    rows: { final: (meta.states || []).length ? meta.states[meta.states.length - 1].rows : null, rowDeltas: (meta.rowDeltas || []).length },
    chromeWrites: chrome.length,
    errors: { shiftError: meta.shiftError, longTaskError: meta.longTaskError, renderLogMissing: meta.renderLogMissing, appendLogTailMissing: meta.appendLogTailMissing },
  };
  fs.writeFileSync(path.join(OUT, 'log-jitter-summary.json'), JSON.stringify(summary, null, 2));
  console.log('[log-jitter] ' + JSON.stringify(summary));
  try { await exT(`await call('stop')`, 15000); } catch {}
  await WAIT(1000);
  app.exit(0);
}
