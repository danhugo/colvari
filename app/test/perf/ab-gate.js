#!/usr/bin/env node
'use strict';
/*
 * A/B interleave gate (t_fd3a15c4, wiki "Changes after Argo's review" point 1).
 *
 * Alternates runs of the baseline commit and the track commit back-to-back in ONE gate
 * session (base, track, base, track, ...), records the load average per run, and applies
 * the acceptance rule: the track only wins if it beats the baseline in EVERY pair AND
 * pooled, by at least 20% at pooled p95, with p50 not worse. Tab switches are the gated
 * population; card clicks are reported separately and never gate (point: "only clicks
 * count", tab-switch cost tracked on its own).
 *
 * Both sides run the SAME harness copy (this directory's click-latency.js) against the
 * app checked out at each commit, so only the app code differs — never the metric.
 *
 *   node test/perf/ab-gate.js
 *   PERF_BASE_COMMIT=6710364 PERF_TRACK_COMMIT=988cb63 PERF_PAIRS=3 PERF_OUT=/tmp/ab node test/perf/ab-gate.js
 *   PERF_TRACE=1 PERF_TRACE_COMMIT=<sha> PERF_TRACE_MS=12000 node test/perf/ab-gate.js   # one traced run, no gate
 *
 * Exit code: 0 PASS, 1 FAIL, 2 INVALID (dropped + quiet-unsettled over 20% / too-few samples — rerun).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HE = require('../harness/harness-electron');

const APP = path.resolve(__dirname, '../..');
const HARNESS = path.join(__dirname, 'click-latency.js');
const ELECTRON = process.env.PERF_ELECTRON || undefined; // default: the real Electron binary via electronBin()
const REPS = Math.max(1, Number(process.env.PERF_CLICK_REPS || 8));
const PAIRS = Math.max(0, Number(process.env.PERF_PAIRS || 3));
const WARM_MS = Number(process.env.PERF_WARM_MS || 4000);
const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS || 20000);
// Kill backstop, not the happy path: budget the trace window and the worst-case click
// poll (~2.6 s/click) on top of warm+sample, then generous slack for seed + boot.
const TRACE_MS = Number(process.env.PERF_TRACE_MS || 0);
const TIMEOUT_MS = (Math.ceil((WARM_MS + SAMPLE_MS) / 1000) + 25) * 1000 + 240000 + TRACE_MS + (REPS * 9 + 10) * 2600;

// ---- pure stats + gate rule (unit-tested in test/ab-gate.test.js) ----
function pct(arr, p) {
  const x = arr.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return x.length ? x[Math.min(x.length - 1, Math.floor((x.length - 1) * p))] : 0;
}
const r2 = (x) => Math.round(x * 100) / 100;

// runs: [{ pair, tabMs: number[], p50?, p95?, dropped, unsettledQuiet, attempted, load: {...} }]
// Validity counts BOTH unresolved populations (t_5ab07112): driver-dropped clicks (never any
// endpoint) and quiet-unsettled ones (legacy endpoint settled, quiet-paint never did — 22-38%
// mid-storm, invisible to the old dropped-only check). Percentiles stay settled-only; the
// unresolved budget bounds how far they can flatter a loaded run.
function gateDecision({ baseRuns, trackRuns, minImprove = 0.2, maxDropRate = 0.2 }) {
  const unresolved = (run) => (run.dropped || 0) + (run.unsettledQuiet || 0);
  const ok = (run) => run && run.attempted > 0 && unresolved(run) / run.attempted <= maxDropRate && Array.isArray(run.tabMs) && run.tabMs.some(Number.isFinite);
  const base = baseRuns.filter(ok);
  const track = trackRuns.filter(ok);
  const dropped = { base: baseRuns.length - base.length, track: trackRuns.length - track.length };
  const pairs = [...new Set([...base, ...track].map((r) => r.pair))].sort((a, b) => a - b)
    .map((pair) => {
      const b = base.find((r) => r.pair === pair);
      const t = track.find((r) => r.pair === pair);
      return { pair, base: b, track: t, baseP95: b ? r2(pct(b.tabMs, 0.95)) : null, trackP95: t ? r2(pct(t.tabMs, 0.95)) : null, trackWinsPair: !!(b && t && pct(t.tabMs, 0.95) < pct(b.tabMs, 0.95)) };
    });
  const complete = pairs.filter((p) => p.base && p.track);
  const reasons = [];
  if (!complete.length) reasons.push('no complete pair (both sides valid) — rerun');
  if (dropped.base || dropped.track) reasons.push(`invalid runs dropped: base ${dropped.base}, track ${dropped.track} (>20% unresolved clicks = driver-dropped + quiet-unsettled)`);
  const everyPair = complete.length > 0 && complete.every((p) => p.trackWinsPair);
  if (complete.length && !everyPair) reasons.push('track loses at least one pair');
  const allBase = base.flatMap((r) => r.tabMs);
  const allTrack = track.flatMap((r) => r.tabMs);
  const pooled = {
    base: { n: allBase.length, p50: r2(pct(allBase, 0.5)), p95: r2(pct(allBase, 0.95)) },
    track: { n: allTrack.length, p50: r2(pct(allTrack, 0.5)), p95: r2(pct(allTrack, 0.95)) },
  };
  const need95 = r2(pooled.base.p95 * (1 - minImprove));
  const p95Win = complete.length > 0 && pooled.track.p95 <= need95;
  if (complete.length && !p95Win) reasons.push(`pooled p95 ${pooled.track.p95} not <= ${need95} (baseline ${pooled.base.p95} -20%)`);
  const p50NotWorse = complete.length > 0 && pooled.track.p50 <= pooled.base.p50;
  if (complete.length && !p50NotWorse) reasons.push(`pooled p50 regressed: ${pooled.track.p50} > ${pooled.base.p50}`);
  const verdict = !complete.length ? 'INVALID' : everyPair && p95Win && p50NotWorse ? 'PASS' : 'FAIL';
  return { verdict, minImprove, perPair: pairs, pooled, need95, everyPair, p95Win, p50NotWorse, reasons };
}

// ---- per-commit checkout: detached temp worktree + own node_modules clone (same electron) ----
function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: APP, encoding: 'utf8' }).trim();
}
async function ensureWorktree(sha, root) {
  const dir = path.join(os.tmpdir(), `ab-wt-${String(sha).slice(0, 10)}`);
  if (!fs.existsSync(path.join(dir, 'app', 'src', 'main.js'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', dir, sha], { cwd: root, stdio: 'pipe' });
  }
  const nm = path.join(dir, 'app', 'node_modules');
  if (!await require('../../src/worktree').cloneNodeModules(path.join(APP, 'node_modules'), nm)) throw new Error('node_modules clone failed: ' + nm); // never a link (t_09a2c1e0)
  return dir;
}

async function runOne(label, { wtDir, outDir, traceMs, env }) {
  fs.mkdirSync(outDir, { recursive: true });
  const pre = os.loadavg();
  const t0 = Date.now();
  // Harness spawn (t_98eed830): own process group + run marker, so the run dies with this
  // driver (group kill on exit/signal/error here, parent watchdog in the app) and any leftover
  // is reappable by pidfile at the next boot — never by name.
  const child = HE.spawnHarness(ELECTRON || HE.electronBin(), [HARNESS], {
    label: `ab-${label}`,
    env: { ...process.env, PERF_APP_DIR: path.join(wtDir, 'app'), PERF_OUT: outDir, PERF_CLICK_REPS: String(REPS), ...(traceMs ? { PERF_TRACE_MS: String(traceMs) } : {}), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await exitWithTimeout(child, TIMEOUT_MS, label);
  const post = os.loadavg();
  const file = path.join(outDir, 'baseline.json');
  if (!fs.existsSync(file)) throw new Error(`${label}: no baseline.json (exit ${code})\n--- stdout tail ---\n${out.slice(-2000)}\n--- stderr tail ---\n${err.slice(-2000)}`);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tabMs = s.clicks.samples.filter((c) => c.label.startsWith('tab:')).map((c) => c.ms);
  const cardMs = s.clicks.samples.filter((c) => c.label.startsWith('card')).map((c) => c.ms);
  return {
    label, pair: -1, commit: s.env.commit, appDir: s.env.ab.appDir,
    attempted: s.env.clicksAttempted, dropped: s.env.clicksDropped, unsettledQuiet: s.clicks.unsettledQuiet || 0,
    droppedByReason: s.env.clicksDroppedByReason || {},
    tabMs, cardMs, tabP50: r2(pct(tabMs, 0.5)), tabP95: r2(pct(tabMs, 0.95)), tabMax: tabMs.length ? Math.max(...tabMs) : 0,
    cardP95: r2(pct(cardMs, 0.95)),
    load: { pre1m: +pre[0].toFixed(2), mid1m: s.env.load.mid1m, post1m: +post[0].toFixed(2), start1m: s.env.load.start1m, end1m: s.env.load.end1m },
    exit: code, wallMs: Date.now() - t0,
  };
}
function exitWithTimeout(child, ms, label) {
  return new Promise((resolve) => {
    const killer = setTimeout(() => { console.error(`[ab] ${label}: timeout, killing process group of pid ${child.pid}`); void HE.killGroup(child.pid, { log: (m) => console.error(`[ab] ${label}: ${m}`) }); }, ms);
    child.once('close', (code, sig) => { clearTimeout(killer); resolve(code == null ? (sig ? -1 : 1) : code); });
  });
}

async function main() {
  const root = repoRoot();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const BASE = process.env.PERF_BASE_COMMIT || '6710364';
  const TRACK = process.env.PERF_TRACK_COMMIT || head;
  const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `ab-gate-${Date.now()}`);
  fs.mkdirSync(OUT, { recursive: true });
  const full = (s) => execFileSync('git', ['rev-parse', s], { cwd: root, encoding: 'utf8' }).trim();
  const baseSha = full(BASE);
  const trackSha = full(TRACK);

  if (process.env.PERF_TRACE) {
    // One traced run (function split), never part of a gate comparison.
    const sha = process.env.PERF_TRACE_COMMIT ? full(process.env.PERF_TRACE_COMMIT) : trackSha;
    const wt = await ensureWorktree(sha, root);
    const r = await runOne('trace', { wtDir: wt, outDir: path.join(OUT, 'trace'), traceMs: Number(process.env.PERF_TRACE_MS || 12000) });
    const s = JSON.parse(fs.readFileSync(path.join(OUT, 'trace', 'baseline.json'), 'utf8'));
    if (s.trace) {
      console.log('[ab] trace renderer top:', s.trace.renderer.top.slice(0, 12).map((x) => `${x.name}=${x.selfMs}ms`).join(' '));
      console.log('[ab] trace renderer watched:', s.trace.renderer.watch.map((x) => `${x.name}=${x.selfMs}ms`).join(' ') || '—');
      console.log('[ab] trace main top:', s.trace.main.top.slice(0, 12).map((x) => `${x.name}=${x.selfMs}ms`).join(' '));
      console.log('[ab] trace main watched:', s.trace.main.watch.map((x) => `${x.name}=${x.selfMs}ms`).join(' ') || '—');
      console.log('[ab] cpuprofile files:', s.trace.files.join(', '), 'in', path.join(OUT, 'trace'));
    } else {
      console.log('[ab] no trace in summary:', JSON.stringify(s.trace || {}).slice(0, 400));
    }
    return 0;
  }

  console.log(`[ab] base ${baseSha} vs track ${trackSha}, ${PAIRS} pairs, ${REPS} reps/run, out ${OUT}`);
  const wts = { [baseSha]: await ensureWorktree(baseSha, root), [trackSha]: await ensureWorktree(trackSha, root) };
  const baseRuns = [], trackRuns = [];
  for (let pair = 1; pair <= PAIRS; pair++) {
    for (const [side, sha, bucket] of [['base', baseSha, baseRuns], ['track', trackSha, trackRuns]]) {
      const label = `pair${pair}-${side}`;
      console.log(`\n[ab] === ${label} (${sha.slice(0, 9)}) ===`);
      const r = await runOne(label, { wtDir: wts[sha], outDir: path.join(OUT, label) });
      r.pair = pair;
      bucket.push(r);
      console.log(`[ab] ${label}: tab n=${r.tabMs.filter(Number.isFinite).length}/${r.tabMs.length} p50=${r.tabP50} p95=${r.tabP95} max=${r.tabMax} dropped=${r.dropped}/${r.attempted} qunset=${r.unsettledQuiet} dropWhy=${JSON.stringify(r.droppedByReason)} load1m ${r.load.start1m}→${r.load.mid1m}→${r.load.end1m} (${(r.wallMs / 1000).toFixed(0)}s)`);
    }
  }
  const decision = gateDecision({ baseRuns, trackRuns });
  const report = { generatedAt: new Date().toISOString(), base: baseSha, track: trackSha, pairs: PAIRS, repsPerRun: REPS, rule: 'track wins only if it beats baseline in EVERY pair AND pooled, >=20% lower pooled p95, p50 not worse; population = tab switches; card clicks reported only', baseRuns, trackRuns, decision };
  fs.writeFileSync(path.join(OUT, 'gate-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'gate-report.md'), renderReport(report));
  console.log('\n' + renderReport(report));
  console.log(`[ab] wrote ${path.join(OUT, 'gate-report.json')} and gate-report.md`);
  return decision.verdict === 'PASS' ? 0 : decision.verdict === 'FAIL' ? 1 : 2;
}

function renderReport(rep) {
  const rows = [...rep.baseRuns.map((r) => ({ ...r, side: 'base' })), ...rep.trackRuns.map((r) => ({ ...r, side: 'track' }))]
    .sort((a, b) => a.pair - b.pair || (a.side === 'base' ? -1 : 1))
    .map((r) => `| ${r.pair} | ${r.side} | ${r.commit.slice(0, 9)} | ${r.tabMs.filter(Number.isFinite).length}/${r.tabMs.length} | ${r.tabP50} | ${r.tabP95} | ${r.tabMax} | ${r.dropped}/${r.unsettledQuiet}/${r.attempted} | ${r.load.start1m}→${r.load.mid1m}→${r.load.end1m} |`).join('\n');
  const pairRows = rep.decision.perPair.map((p) => `| ${p.pair} | ${p.baseP95} | ${p.trackP95} | ${p.trackWinsPair ? 'win' : 'LOSS'} |`).join('\n');
  const d = rep.decision;
  return `# A/B gate report — ${rep.base.slice(0, 9)} (base) vs ${rep.track.slice(0, 9)} (track)

${rep.generatedAt} · ${rep.pairs} interleaved pairs · ${rep.repsPerRun} click rounds per run (tab switches are the gated population) · loadavg 1m start→mid→end per run

| pair | side | commit | tab settled/attempts | tab p50 | tab p95 | max | dropped/qunset/attempts | load 1m |
|---|---|---|---:|---:|---:|---:|---|---|
${rows}

Per-pair p95 (gate: track wins EVERY pair):

| pair | base p95 | track p95 | verdict |
|---|---:|---:|---|
${pairRows}

Pooled: base p50 ${d.pooled.base.p50} / p95 ${d.pooled.base.p95} (n=${d.pooled.base.n}) · track p50 ${d.pooled.track.p50} / p95 ${d.pooled.track.p95} (n=${d.pooled.track.n}) · need p95 <= ${d.need95}

**Gate rule:** ${rep.rule}
**Verdict: ${d.verdict}**${d.reasons && d.reasons.length ? ' — ' + d.reasons.join('; ') : ''}

Reproduce: cd app && PERF_BASE_COMMIT=${rep.base.slice(0, 9)} PERF_TRACK_COMMIT=${rep.track.slice(0, 9)} PERF_OUT=/tmp/ab node test/perf/ab-gate.js
`;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error('[ab] failed:', e && e.message || e); process.exit(3); });
}

module.exports = { pct, gateDecision };
