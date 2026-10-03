#!/usr/bin/env node
'use strict';
/*
 * Main-thread appendLog block-time bench (t_e7b3e119).
 *
 * Drives Store.appendLog (store.js:1048) exactly as the orchestrator does — one sync
 * appendFileSync + statSync per line, and a full read-and-rewrite trim once logs.jsonl passes
 * 3MB — in plain node. The Electron main process runs the same synchronous JS on the same
 * filesystem, so these numbers ARE the main-thread stalls IPC replies queue behind.
 *
 * Design: a FRESH store per target size so the ladder is clean; steady-state per-line stats
 * exclude >5ms calls (trims), which are hunted separately with pre/post sizes; a raw
 * appendFileSync micro-row decomposes syscall cost vs JSON.stringify+stat cost.
 *
 * Knobs: BENCH_BATCH (1000), BENCH_REPS (5), BENCH_TARGETS (comma bytes), BENCH_TEXT_BYTES (260).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');

const APP = path.resolve(__dirname, '../..');
const { Store } = require(path.join(APP, 'src/store.js'));
const BATCH = Math.max(100, Number(process.env.BENCH_BATCH || 1000));
const REPS = Math.max(1, Number(process.env.BENCH_REPS || 5));
const TEXT_BYTES = Number(process.env.BENCH_TEXT_BYTES || 260);
const TARGETS = (process.env.BENCH_TARGETS || '0,5e5,1e6,2e6,3e6').split(',').map((s) => Math.round(Number(s)));

const fillText = 'Step 3812: tracing the refresh path, the state delta looks right and the render cost dominates. '.repeat(Math.ceil(TEXT_BYTES / 105)).slice(0, TEXT_BYTES);
let seq = 0;
const line = () => ({ at: Date.now(), nodeId: 'n_perf' + (seq % 5), kind: seq % 3 === 0 ? 'tool' : 'text', taskId: 't_' + (seq % 50), task: 'streaming perf task', text: `${fillText} (#${seq})` });
const mb = (b) => (b / 1e6).toFixed(2) + 'MB';

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-appendlog-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  return { store: new Store(dir), file: path.join(dir, 'logs.jsonl') };
}
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

// Steady-state measurement: per-line stats over n calls; >5ms outliers (trims/flushes) are
// counted and reported separately, never folded into the per-line cost.
function appendMeasured(store, file, n) {
  const perCall = [];
  let outliers = 0, outlierMs = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    store.appendLog(line());
    const d = performance.now() - t;
    if (d > 5) { outliers++; outlierMs += d; continue; }
    perCall.push(d);
  }
  const total = performance.now() - t0;
  const sorted = [...perCall].sort((a, b) => a - b);
  return {
    n,
    per1kMs: +(total / (n / 1000)).toFixed(1),
    perLineUs: +((total / n) * 1000).toFixed(1),
    p95LineUs: +(sorted[Math.floor(sorted.length * 0.95)] * 1000).toFixed(1),
    maxLineMs: +(sorted[sorted.length - 1] || 0).toFixed(2),
    outliers, outlierMs: +outlierMs.toFixed(1),
  };
}

const rows = [];
for (const target of TARGETS) {
  const { store, file } = newStore();
  seq = 0;
  // Line-count guard: past the 3MB threshold appendLog trims the file back under 3MB inside
  // the same call, so a pure size condition never terminates for target >= 3MB.
  const maxFill = Math.ceil(Math.max(target, 3e6) / 280) + 3 * BATCH;
  let filled = 0;
  while (sizeOf(file) < target && filled++ < maxFill) store.appendLog(line()); // unmeasured fill
  console.error(`[bench] target=${target} filled to ${sizeOf(file)} bytes (${filled} lines)`);
  const reps = [];
  for (let r = 0; r < REPS; r++) reps.push(appendMeasured(store, file, BATCH));
  const sum = (k) => reps.reduce((s, x) => s + x[k], 0);
  rows.push({
    targetBytes: target, atBytes: sizeOf(file),
    per1kMs: +(sum('per1kMs') / REPS).toFixed(1),
    perLineUs: +(sum('perLineUs') / REPS).toFixed(1),
    p95LineUs: +(sum('p95LineUs') / REPS).toFixed(1),
    maxLineMs: +Math.max(...reps.map((r) => r.maxLineMs)).toFixed(2),
    outliers: sum('outliers'),
  });
}

// Trim hunt on a fresh ~3MB store: append until 2 trims observed; each = full read+rewrite.
const { store: ts, file: tf } = newStore();
seq = 0;
{ let g = 0; while (sizeOf(tf) < 3e6 && g++ < 30000) ts.appendLog(line()); }
const trims = [];
for (let guard = 0; guard < 120 && trims.length < 2; guard++) {
  for (let i = 0; i < BATCH; i++) {
    const pre = sizeOf(tf);
    const t = performance.now();
    ts.appendLog(line());
    const d = performance.now() - t;
    if (d > 5) trims.push({ ms: +d.toFixed(2), preBytes: pre, postBytes: sizeOf(tf) });
  }
}

// Raw syscall decomposition: prebuilt string, appendFileSync only (no Store, no stringify/stat).
const rawFile = path.join(os.tmpdir(), `squad-appendlog-raw-${Date.now()}.jsonl`);
const rawStr = JSON.stringify(line()) + '\n';
{ const t0 = performance.now(); for (let i = 0; i < 5000; i++) fs.appendFileSync(rawFile, rawStr); var rawUs = +((performance.now() - t0) / 5000 * 1000).toFixed(1); }
try { fs.unlinkSync(rawFile); } catch {}

// Tail-read cost the log view pays per page.
const reads = [];
for (let i = 0; i < 3; i++) { const t = performance.now(); const out = ts.readLogs(2000); reads.push({ ms: +(performance.now() - t).toFixed(1), lines: out.length }); }

const avgBytes = trims.length && trims[0].postBytes ? Math.round(trims[0].postBytes / 5000) : 390;
console.log(`# appendLog main-thread block time — node ${process.version} · ${BATCH} lines × ${REPS} reps · ~${avgBytes}B/line persisted

| log file size | per 1k lines (ms) | per line (µs) | line p95 (µs) | worst line (ms) | >5ms calls |
|---|---:|---:|---:|---:|---:|
${rows.map((r) => `| ${mb(r.atBytes)} | ${r.per1kMs} | ${r.perLineUs} | ${r.p95LineUs} | ${r.maxLineMs} | ${r.outliers} |`).join('\n')}

Trim (read-and-rewrite past 3MB) — observed stalls:
${trims.map((t) => `- ${t.ms} ms (${mb(t.preBytes)} → ${mb(t.postBytes)}, keeps last 5000 lines)`).join('\n') || '- none in ' + (120 * BATCH) + ' lines'}

Raw fs.appendFileSync alone (prebuilt string): ${rawUs} µs/line — the rest of appendLog is JSON.stringify + statSync + date/level work.
readLogs(2000) at ${mb(sizeOf(tf))}: ${reads.map((r) => r.ms + 'ms/' + r.lines + 'L').join(', ')}
`);
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', `appendlog-${Date.now()}.json`), JSON.stringify({ rows, trims, reads, rawUsPerLine: rawUs, batch: BATCH, reps: REPS }, null, 2));
