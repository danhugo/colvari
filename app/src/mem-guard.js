// Memory-pressure dispatch guard (t_a9864978). Defers NEW dispatch while the machine is under
// memory pressure; held work stays queued (the 1 s sweep retries) and is never dropped.
//
// Why not os.freemem() on macOS (Argo's critique of the original "freemem < 1.5 GB" spec, confirmed
// live 2026-10-08 on this 8 GB box): os.freemem() excludes the reclaimable file cache, so it sits
// under 1.5 GB nearly all the time (~70 MB measured) while the system is actually fine — a freemem
// gate would effectively never dispatch. macOS signal is the kernel's own pressure level
// (kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 3 critical). Non-mac platforms keep
// the literal freemem < 1.5 GB rule from the task spec.
//
// Cost discipline: the probe forks a process (sysctl) — cached for PROBE_CACHE_MS and refreshed
// asynchronously from the tick sweep, never forked per dispatch decision. A failed probe fails
// OPEN (dispatch proceeds); wedging dispatch behind a broken probe would be worse than measuring.
const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');

// Settings.memGuardDeferAt values -> the pressure level at/above which dispatch defers.
// 'off' disables the guard entirely.
const DEFER_AT = { off: Infinity, critical: 3, warning: 2 };
const LEVEL_NAME = { 1: 'normal', 2: 'warning', 3: 'critical' };
// Literal fallback threshold from the task spec, kept for non-mac platforms only.
const FALLBACK_FREE_BYTES = Math.round(1.5 * 1024 * 1024 * 1024);
const PROBE_CACHE_MS = 5000;
// t_515dbce3: level 2 defers only when available memory (vm_stat free+inactive+purgeable) is also low;
// a hold lasts at least HOLD_MIN_MS; an override proceeds for OVERRIDE_MS unless the level rises.
const LOW_AVAIL_PCT = 15;
const HOLD_MIN_MS = 30000;
const OVERRIDE_MS = 30 * 60000;
const SYSCTL_KEY = 'kern.memorystatus_vm_pressure_level';

class MemGuard {
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform;
    this.execFile = opts.execFile || execFile; // injectable for tests
    this.freeMem = opts.freeMem || (() => os.freemem());
    this.now = opts.now || (() => Date.now());
    this.cacheMs = opts.cacheMs ?? PROBE_CACHE_MS;
    this.deferAt = DEFER_AT.warning; // guard on at warning by default; configure() follows settings
    // Test isolation: host pressure must not gate unit tests that don't inject a probe/platform.
    this._probe = opts.probe || (process.env.AGENTS_SQUAD_TEST_ISOLATION && !opts.platform && !opts.execFile ? async () => ({ level: 1, freeBytes: Infinity }) : null); // injectable override: () => Promise<{level}|{freeBytes}|{error}>
    this._snapshot = opts.snapshot || (() => this._psSnapshot()); // t_b2b497f3: what eats RAM, for the alert
    this.diskPath = opts.diskPath || null;
    this.statfs = opts.statfs || ((p) => fs.promises.statfs(p));
    this._override = null; // { until, level }
    this._busy = false;
    this._state = { defer: false, level: null, freeBytes: null, source: this.platform === 'darwin' ? 'pressure' : 'freemem', why: 'no reading yet', at: null, deferAt: 'warning' };
  }
  configure(deferAt) {
    const v = DEFER_AT[deferAt] !== undefined ? deferAt : 'warning';
    if (this._state.deferAt !== v) { this._state.deferAt = v; this.deferAt = DEFER_AT[v]; this._recompute(); }
    return v;
  }
  // One async probe, coalesced: concurrent callers share the in-flight refresh. Cheap to call
  // every tick; the actual fork happens at most once per cacheMs.
  refresh() {
    if (this._busy) return this._inflight || Promise.resolve();
    this._busy = true;
    this._inflight = this._runProbe().catch(() => {}).finally(() => { this._busy = false; this._inflight = null; });
    return this._inflight;
  }
  async _runProbe() {
    let reading;
    try {
      reading = this._probe ? await this._probe()
        : this.platform === 'darwin'
          ? await this._sysctlLevel()
          : { freeBytes: Number(this.freeMem()) };
    } catch (e) {
      // Fail open: a broken probe must never wedge dispatch. Keep the last reading for display.
      this._state = { ...this._state, defer: false, why: `memory probe failed (${e.message}); dispatch not gated`, at: this.now() };
      return;
    }
    if (reading && reading.error) throw new Error(reading.error);
    const at = this.now();
    if (this.platform === 'darwin') {
      const level = Number(reading && reading.level);
      if (!(level >= 1 && level <= 3)) throw new Error(`unexpected ${SYSCTL_KEY} value: ${reading && reading.level}`);
      const ap = reading.availPct ?? reading.availablePct;
      const availPct = ap != null && Number.isFinite(+ap) ? +ap : null;
      this._state = { ...this._state, level, availPct, freeBytes: null, source: 'pressure', at };
    } else {
      const freeBytes = Number(reading && reading.freeBytes);
      if (!Number.isFinite(freeBytes)) throw new Error('os.freemem() returned a non-number');
      this._state = { ...this._state, level: freeBytes < FALLBACK_FREE_BYTES ? 2 : 1, freeBytes, source: 'freemem', at };
    }
    if (this.diskPath) { try { const st = await this.statfs(this.diskPath); this._state = { ...this._state, diskFreeBytes: Number(st.bavail) * Number(st.bsize), diskTotalBytes: Number(st.blocks) * Number(st.bsize) }; } catch {} }
    this._recompute();
  }
  _recompute() {
    const was = this._state.defer;
    this._recomputeDefer();
    // t_b2b497f3: hold start = one process/vm_stat snapshot (never per sweep); clear = clearSince so
    // the alert can wait ~60 s before saying "resumed" (flapping must not spam).
    const s = this._state;
    if (s.defer && !was) {
      this._state = { ...s, heldSince: this.now(), clearSince: null, snapshot: null };
      Promise.resolve().then(this._snapshot).then((snap) => { if (this._state.defer) this._state = { ...this._state, snapshot: snap }; }, () => {});
    } else if (!s.defer && was) this._state = { ...s, heldSince: null, clearSince: this.now() };
  }
  _recomputeDefer() {
    const s = this._state;
    const ov = this._override;
    if (ov && (this.now() >= ov.until || (s.level != null && s.level > ov.level))) this._override = null;
    if (this.deferAt === DEFER_AT.off) { this._state = { ...s, defer: false, why: 'memory guard off' }; return; }
    if (s.source === 'freemem') {
      const low = s.freeBytes != null && s.freeBytes < FALLBACK_FREE_BYTES;
      this._state = { ...s, defer: low, why: low ? `free memory ${(s.freeBytes / 2 ** 30).toFixed(2)} GB < 1.5 GB` : 'memory OK' };
      return;
    }
    // Level 2 needs low available memory too (unknown availability stays conservative); level 3 always defers.
    const lowAvail = s.availPct == null || s.availPct < LOW_AVAIL_PCT;
    let defer = s.level != null && s.level >= this.deferAt && (s.level >= 3 || lowAvail);
    let why = defer ? `memory pressure ${LEVEL_NAME[s.level] || s.level} (level ${s.level}${s.availPct != null ? `, ${Math.round(s.availPct)}% available` : ''})` : null;
    if (!defer && s.defer && s.heldSince && this.now() - s.heldSince < HOLD_MIN_MS) { defer = true; why = s.why; } // hysteresis
    if (defer && this._override) { defer = false; why = `memory guard overridden (${LEVEL_NAME[s.level]})`; }
    this._state = { ...s, defer, overridden: !!this._override, override: this._override ? this._override.until : null, why: why || `memory ${LEVEL_NAME[s.level] || 'unknown'} (level ${s.level ?? '?'}${s.availPct != null ? `, ${Math.round(s.availPct)}% available` : ''})` };
  }
  async _sysctlLevel() {
    const out = await new Promise((resolve, reject) => {
      this.execFile('sysctl', ['-n', SYSCTL_KEY], { timeout: 3000 }, (e, stdout) => (e ? reject(e) : resolve(String(stdout).trim())));
    });
    const level = parseInt(out, 10);
    if (!(level >= 1)) throw new Error(`unparsable ${SYSCTL_KEY}: "${out}"`);
    let availPct = null; // vm_stat fork only when the level could defer
    if (level >= 2) try { availPct = MemGuard.parseAvailPct(await new Promise((r) => this.execFile('vm_stat', [], { timeout: 3000 }, (e, o) => r(e ? '' : String(o))))); } catch {}
    return { level, availPct };
  }
  async _psSnapshot() {
    const run = (cmd, args) => new Promise((resolve) => this.execFile(cmd, args, { timeout: 3000, maxBuffer: 4 << 20 }, (e, out) => resolve(e ? '' : String(out))));
    return MemGuard.parseSnapshot(await run('ps', ['-axo', 'rss=,comm=']), this.platform === 'darwin' ? await run('vm_stat', []) : '');
  }
  // ps rss is KB; vm_stat counts pages. Top 5 by RAM, any process (Docker etc. included).
  static parseSnapshot(ps, vm) {
    const procs = String(ps).split('\n').map((l) => l.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean)
      .map((m) => ({ name: m[2].split('/').pop(), mb: Math.round(+m[1] / 1024) })).sort((a, b) => b.mb - a.mb).slice(0, 5);
    const page = +((/page size of (\d+)/.exec(vm) || [])[1]) || 4096;
    const pages = (re) => { const m = re.exec(vm); return m ? Math.round(+m[1] * page / 2 ** 20) : null; };
    return { procs, freeMB: pages(/Pages free:\s+(\d+)/), compressedMB: pages(/Pages occupied by compressor:\s+(\d+)/) };
  }
  // (free + inactive + purgeable) / total pages from vm_stat; null when unparsable.
  static parseAvailPct(vm) {
    const n = (re) => { const m = re.exec(vm); return m ? +m[1] : 0; };
    const avail = n(/Pages free:\s+(\d+)/) + n(/Pages inactive:\s+(\d+)/) + n(/Pages purgeable:\s+(\d+)/);
    const total = ['free', 'active', 'inactive', 'speculative', 'wired down', 'occupied by compressor'].reduce((t, k) => t + n(new RegExp(`Pages ${k}:\\s+(\\d+)`)), 0);
    return total > 0 ? (avail / total) * 100 : null;
  }
  // "Proceed anyway": defer is off for 30 min, ending early if the level rises above the current one.
  override() { this._override = { until: this.now() + OVERRIDE_MS, level: this._state.level ?? 3 }; this._recompute(); return { until: this._override.until }; }
  // Synchronous read of the last probe: what every dispatch guard consults. Fail-open by shape —
  // before the first successful reading defer is false.
  grantOverride() { return this.override(); }
  status() { if (this._override || this._state.defer) this._recompute(); return this._state; }
}

module.exports = { MemGuard, LOW_AVAIL_PCT, HOLD_MIN_MS, OVERRIDE_MS, DEFER_AT, LEVEL_NAME, FALLBACK_FREE_BYTES, PROBE_CACHE_MS, SYSCTL_KEY };
