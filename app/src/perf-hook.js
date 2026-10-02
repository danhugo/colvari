// Perf measurement hook (t_b6a28b60). Inert unless AGENTS_SQUAD_PERF_HOOK=<outdir> is set; required
// at the very top of main.js. Samples land in <outdir>/perf.jsonl every 5s. Main-process side wraps
// only passive things (webContents.send bytes, store/cache/pump internals, event-loop delay) — per-API
// latencies and payload sizes are measured in the PAGE around squad.call (executeJavaScript), the same
// method as the previous perf round. AGENTS_SQUAD_PERF_HOOK_NOBYTES=1 skips serialization (counts only).
// AGENTS_SQUAD_PERF_AUTORUN=<sec> flips phase to "load" and calls squad.call('run') after <sec> — the
// copy instance's orchestrator then dispatches the sandbox's dummy tasks (5+ streaming agents).
const SAMPLE_MS = 5000;

if (process.env.AGENTS_SQUAD_PERF_HOOK) {
  const fs = require('fs');
  const path = require('path');
  const { monitorEventLoopDelay } = require('perf_hooks');
  const { app } = require('electron');

  const outdir = process.env.AGENTS_SQUAD_PERF_HOOK;
  fs.mkdirSync(outdir, { recursive: true });
  const outFile = path.join(outdir, 'perf.jsonl');
  const NOBYTES = !!process.env.AGENTS_SQUAD_PERF_HOOK_NOBYTES;
  const AUTORUN = Number(process.env.AGENTS_SQUAD_PERF_AUTORUN || 0);
  let phase = process.env.AGENTS_SQUAD_PERF_PHASE || 'idle';
  const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

  const mk = () => ({ n: 0, ms: 0, bytes: 0 });
  const C = { send: {}, store: {}, cache: {}, pump: {} };
  const bump = (map, key, ms, bytes) => { const b = (map[key] ||= { n: 0, ms: 0, bytes: 0 }); b.n++; b.ms += ms || 0; b.bytes += bytes || 0; };
  const eld = monitorEventLoopDelay({ resolution: 1 });
  eld.enable();
  let lastCpu = process.cpuUsage();

  // Who starts runs in an "idle" boot? (debug aid — cheap, printed once per start)
  try {
    const O = require('./orchestrator').Orchestrator;
    const ostart = O.prototype.start;
    O.prototype.start = function (...a) {
      console.error('[perf-hook] start() from:', new Error().stack.split('\n').slice(2, 6).join(' | '));
      return ostart.apply(this, a);
    };
  } catch (e) { console.error('[perf-hook] start wrap failed', e.message); }

  const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

  // ---- outgoing IPC: wrap every window webContents.send (passive) ----
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'window') return;
    const orig = wc.send.bind(wc);
    wc.send = (ch, data, ...rest) => {
      let bytes = 0;
      if (!NOBYTES) { try { bytes = JSON.stringify(data)?.length || 0; } catch { bytes = -1; } }
      bump(C.send, ch, 0, bytes);
      return orig(ch, data, ...rest);
    };
    // ---- in-page API sampler: wraps squad.call, records [name, ms, inB, outB] ----
    const install = `(() => {
      if (window.__perfApiInstalled) return 'already';
      window.__perfApiInstalled = true; window.__perfLog = [];
      const orig = window.squad.call.bind(window.squad);
      window.__perfApi = (noBytes) => { const l = window.__perfLog; window.__perfLog = []; return { l, noBytes }; };
      window.squad.call = async (name, ...rest) => {
        const t0 = performance.now();
        try {
          const r = await orig(name, ...rest);
          if (!${NOBYTES}) window.__perfLog.push([name, +(performance.now() - t0).toFixed(2), JSON.stringify(rest).length, JSON.stringify(r == null ? null : r).length]);
          else window.__perfLog.push([name, +(performance.now() - t0).toFixed(2), 0, 0]);
          return r;
        } catch (e) { window.__perfLog.push([name, +(performance.now() - t0).toFixed(2), -1, -1]); throw e; }
      };
      return 'ok';
    })()`;
    wc.on('did-finish-load', () => { wc.executeJavaScript(install, true).catch((e) => console.error('[perf-hook] in-page install failed', e.message)); });
  });

  // ---- store internals (prototype wraps; same set that ran clean in the shakedown boot) ----
  try {
    const Store = require('./store');
    const SP = (Store.Store || Store.default || Store).prototype;
    const wrapStore = (name, sizeOf) => {
      if (typeof SP[name] !== 'function') return;
      const orig = SP[name];
      SP[name] = function (...a) {
        const t0 = now();
        const r = orig.apply(this, a);
        if (r && typeof r.then === 'function') return r.finally(() => bump(C.store, name, now() - t0, sizeOf ? sizeOf(this) : 0));
        bump(C.store, name, now() - t0, sizeOf ? sizeOf(this) : 0);
        return r;
      };
    };
    const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    wrapStore('update');
    wrapStore('withLock');
    wrapStore('_withTasks');
    wrapStore('appendLog');
    wrapStore('listRuns', (s) => fileSize(path.join(s.dir, 'runs.json')));
    wrapStore('listMessages', (s) => fileSize(path.join(s.dir, 'messages.json')));
    wrapStore('listTasks');
    wrapStore('getSettings');
    wrapStore('getTeam');
    wrapStore('sigFile');
    wrapStore('versions');
  } catch (e) { console.error('[perf-hook] store wrap failed', e.message); }

  // ---- board cache fan-out ----
  try {
    const { BoardCache } = require('./board-cache');
    const BP = BoardCache.prototype;
    const wrapP = (name, post) => {
      if (typeof BP[name] !== 'function') return;
      const orig = BP[name];
      BP[name] = function (...a) {
        const t0 = now();
        const r = orig.apply(this, a);
        bump(C.cache, name, now() - t0, 0);
        if (post) post(this, a);
        return r;
      };
    };
    wrapP('_onWatch', (self, a) => { if (!a[1]) bump(C.cache, 'watchNullFilename', 0, 0); });
    wrapP('_drainPending');
    wrapP('_revalidateTask');
    wrapP('reconcile');
    wrapP('loadAll');
    const origEmit = BP.emit;
    BP.emit = function (ev, ...rest) { if (ev === 'change' && rest[0]) bump(C.cache, 'change.' + rest[0].section, 0, 0); return origEmit.call(this, ev, ...rest); };
  } catch (e) { console.error('[perf-hook] cache wrap failed', e.message); }

  // ---- delta pump: replace the exported class before main.js requires it ----
  try {
    const dp = require('./delta-pump');
    const Real = dp.DeltaPump;
    const pumpLast = { nd: 0, byType: {}, bytes: 0 };
    class PumpHook extends Real {
      constructor(opts) {
        super(opts);
        const orig = this.send;
        this.send = (payload) => {
          let bytes = 0;
          if (!NOBYTES) { try { bytes = JSON.stringify(payload)?.length || 0; } catch { bytes = -1; } }
          const byType = {};
          for (const d of payload?.deltas || []) byType[d.type] = (byType[d.type] || 0) + 1;
          bump(C.pump, 'send', 0, bytes);
          bump(C.pump, 'nd', 0, 0);
          pumpLast.nd = Array.isArray(payload?.deltas) ? payload.deltas.length : 0;
          pumpLast.byType = byType; pumpLast.bytes = bytes;
          return orig(payload);
        };
      }
      flush() { const t0 = now(); const r = super.flush(); bump(C.pump, 'flush', now() - t0, 0); return r; }
    }
    require.cache[require.resolve('./delta-pump')].exports = { DeltaPump: PumpHook };
    setInterval(() => { C.pump.lastBatch = { ...pumpLast }; }, SAMPLE_MS).unref();
  } catch (e) { console.error('[perf-hook] pump wrap failed', e.message); }

  // ---- autorun: flip to load phase and start the Run (dispatches the sandbox dummy tasks) ----
  if (AUTORUN > 0) {
    setTimeout(async () => {
      phase = 'load';
      console.log('[perf-hook] AUTORUN: starting the Run now');
      try {
        for (const wc of require('electron').webContents.getAllWebContents()) {
          if (wc.getType() !== 'window') continue;
          await wc.executeJavaScript(`window.squad.call('run', typeof ctx !== 'undefined' ? ctx : { p: S.project.id })`, true);
        }
      } catch (e) { console.error('[perf-hook] autorun failed', e.message); }
    }, AUTORUN * 1000);
  }

  // ---- sampling ----
  const snap = (map) => { const o = {}; for (const [k, v] of Object.entries(map)) o[k] = v.n ? [+v.n.toFixed(0), +v.ms.toFixed(1), v.bytes] : undefined; return o; };
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  async function sample() {
    try {
      const cur = process.cpuUsage();
      const cpuD = process.cpuUsage(lastCpu); lastCpu = cur;
      const h = eld;
      const eldOut = { p50: h.percentile(50) / 1e6, p95: h.percentile(95) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6, mean: h.mean / 1e6, count: h.count };
      h.reset();
      let page = null;
      if (!NOBYTES) {
        for (const wc of require('electron').webContents.getAllWebContents()) {
          if (wc.getType() !== 'window' || wc.isLoading()) continue;
          try { page = await wc.executeJavaScript(`window.__perfApi && window.__perfApi() || null`, true); } catch { page = null; }
          if (page) break;
        }
      }
      const line = { t: new Date().toISOString(), phase, rss: process.memoryUsage().rss, cpuMs: { user: +(cpuD.user / 1000).toFixed(1), sys: +(cpuD.system / 1000).toFixed(1) }, eldMs: eldOut, send: clean(snap(C.send)), store: clean(snap(C.store)), cache: clean(snap(C.cache)), pump: { ...clean(snap(C.pump)), lastBatch: C.pump.lastBatch }, page };
      for (const m of [C.send, C.store, C.cache]) for (const b of Object.values(m)) { b.n = 0; b.ms = 0; b.bytes = 0; }
      C.pump = { flush: mk(), send: mk(), nd: mk() };
      try { fs.appendFileSync(outFile, JSON.stringify(line) + '\n'); } catch (e) { console.error('[perf-hook] append failed', e.message); }
    } catch (e) { console.error('[perf-hook] sample failed', e.message); }
  }
  setInterval(sample, SAMPLE_MS);

  const summary = () => {
    try {
      const h = eld;
      fs.writeFileSync(path.join(outdir, 'summary.json'), JSON.stringify({ endedAt: new Date().toISOString(), eldTotal: { p50: h.percentile(50) / 1e6, p95: h.percentile(95) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6, count: h.count, mean: h.mean / 1e6 } }, null, 2));
    } catch {}
  };
  app.on('will-quit', summary);
  for (const sig of ['SIGINT', 'SIGTERM']) try { process.on(sig, () => { summary(); app.exit(0); }); } catch {}
  console.log('[perf-hook] active, outdir', outdir, NOBYTES ? '(no payload bytes)' : '', AUTORUN ? `autorun@${AUTORUN}s` : '');
}
