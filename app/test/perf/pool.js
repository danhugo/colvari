#!/usr/bin/env node
'use strict';
/*
 * Pool click samples from one or more per-run result dirs (each containing baseline.json
 * from click-latency.js) and print pooled percentiles + the per-target table.
 *
 *   node test/perf/pool.js test/perf/results/track1-115ddd5
 *   node test/perf/pool.js test/perf/results/baseline-6710364 --json
 *
 * Percentiles follow the harness convention: nearest-rank on the sorted sample array.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter((a) => a !== '--json');
const wantJson = process.argv.includes('--json');
if (!args.length) {
  console.error('usage: node test/perf/pool.js <results-dir> [more-dirs...] [--json]');
  process.exit(1);
}

const runs = [];
for (const dir of args) {
  const entries = fs.statSync(dir).isDirectory()
    ? fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((p) => fs.statSync(p).isDirectory())
    : [dir];
  for (const rdir of entries) {
    const f = path.join(rdir, 'baseline.json');
    if (!fs.existsSync(f)) continue;
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    runs.push({ dir: rdir, summary: s });
  }
}
if (!runs.length) { console.error('no baseline.json found under given dirs'); process.exit(1); }

const q = (a, p) => { const x = a.filter(Number.isFinite).slice().sort((m, n) => m - n); return x.length ? +x[Math.min(x.length - 1, Math.floor((x.length - 1) * p))].toFixed(2) : 0; };
const stat = (a) => ({ n: a.length, p50: q(a, .5), p95: q(a, .95), p99: q(a, .99), max: a.length ? +Math.max(...a).toFixed(2) : 0 });

const pooled = [];
const byLabel = {};
for (const { summary: s } of runs) for (const c of s.clicks.samples) { pooled.push(c.ms); (byLabel[c.label] ||= []).push(c.ms); }

const out = {
  runs: runs.map(({ dir, summary: s }) => ({
    dir: path.basename(path.dirname(dir)) === 'results' ? path.basename(dir) : dir,
    commit: (s.env.commit || '').slice(0, 9),
    clicks: s.clicks.stat.n,
    p50: s.clicks.stat.p50, p95: s.clicks.stat.p95, max: s.clicks.stat.max,
    loadavg1m: (s.env.platform.match(/loadavg1m=([\d.]+)/) || [])[1] || '?',
    longTasks: s.longTasks.total,
    statePushPerSec: s.rates.statePushesPerSecMain, logPushPerSec: s.rates.logPushesPerSecMain,
  })),
  pooled: { all: stat(pooled), byLabel: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, stat(v)])) },
};

if (wantJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log('Per-run:');
for (const r of out.runs) console.log(`  ${r.dir}  commit ${r.commit}  n=${r.clicks}  p50 ${r.p50}  p95 ${r.p95}  max ${r.max}  load=${r.loadavg}  longs>50ms=${r.longTasks}  pushes state/log per sec ${r.statePushPerSec}/${r.logPushPerSec}`);
console.log(`\nPooled all clicks (n=${out.pooled.all.n}): p50 ${out.pooled.all.p50}  p95 ${out.pooled.all.p95}  p99 ${out.pooled.all.p99}  max ${out.pooled.all.max}`);
console.log('\nPooled by label:');
for (const [k, v] of Object.entries(out.pooled.byLabel)) console.log(`  ${k.padEnd(12)} n=${String(v.n).padEnd(4)} p50 ${String(v.p50).padEnd(8)} p95 ${String(v.p95).padEnd(8)} p99 ${String(v.p99).padEnd(8)} max ${v.max}`);
