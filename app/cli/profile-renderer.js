#!/usr/bin/env node
'use strict';
/*
 * Renderer/GPU CPU baseline matrix driver (t_09b11191) — repeatable after-numbers entry point.
 *
 *   npm run profile:renderer                       # full matrix (~16 cells × ~75s)
 *   PROF_CELLS=load,feed npm run profile:renderer  # subset
 *   PROF_RESUME=1 ...                              # skip cells whose JSON already exists
 *   PROF_OUT=/tmp/colvari-cpu ...                  # artifact dir (default: fresh temp dir)
 *
 * Each cell boots its OWN throwaway instance (never the live app) via test/perf/cpu-baseline.js
 * and samples app.getAppMetrics() for PERF_DURATION_MS (default 60s). Merged report:
 * <PROF_OUT>/renderer-cpu.md + renderer-cpu.json.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const HE = require('../test/harness/harness-electron');

const APP = path.resolve(__dirname, '..');
const ENTRY = path.join(APP, 'test/perf/cpu-baseline.js');
const ELECTRON = process.env.PROF_ELECTRON || undefined; // default: the real Electron binary via electronBin()

const OUT = process.env.PROF_OUT || path.join(os.tmpdir(), `agents-squad-cpu-${Date.now()}`);
const DURATION_MS = Number(process.env.PERF_DURATION_MS || 60000);
const WARM_MS = Number(process.env.PERF_WARM_MS || 5000);
const FILTER = (process.env.PROF_CELLS || '').split(',').map((s) => s.trim()).filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

// cell name -> scenario / freeze / anim knobs passed to cpu-baseline.js
const CELLS = [
  { name: 'idle', env: { PERF_SCENARIO: 'idle' } },
  { name: 'idle-animoff', env: { PERF_SCENARIO: 'idle', PERF_ANIM: 'off' } },
  { name: 'feedidle', env: { PERF_SCENARIO: 'feedidle' } },
  { name: 'feedidle-animoff', env: { PERF_SCENARIO: 'feedidle', PERF_ANIM: 'off' } },
  { name: 'feedidle-freezefeed', env: { PERF_SCENARIO: 'feedidle', PERF_FREEZE: 'feed' } },
  { name: 'load', env: { PERF_SCENARIO: 'load' } },
  { name: 'load-freezefeed', env: { PERF_SCENARIO: 'load', PERF_FREEZE: 'feed' } },
  { name: 'load-freezepoll', env: { PERF_SCENARIO: 'load', PERF_FREEZE: 'poll' } },
  { name: 'load-animoff', env: { PERF_SCENARIO: 'load', PERF_ANIM: 'off' } },
  { name: 'feed', env: { PERF_SCENARIO: 'feed' } },
  { name: 'feed-freezefeed', env: { PERF_SCENARIO: 'feed', PERF_FREEZE: 'feed' } },
  { name: 'feed-freezepoll', env: { PERF_SCENARIO: 'feed', PERF_FREEZE: 'poll' } },
  { name: 'feed-animoff', env: { PERF_SCENARIO: 'feed', PERF_ANIM: 'off' } },
  { name: 'feed-animoff-sweep', env: { PERF_SCENARIO: 'feed', PERF_ANIM_OFF: 'sweep' } },
  { name: 'feed-animoff-spin', env: { PERF_SCENARIO: 'feed', PERF_ANIM_OFF: 'spin' } },
  { name: 'feed-animoff-dots', env: { PERF_SCENARIO: 'feed', PERF_ANIM_OFF: 'dots' } },
];

async function runCell(cell) {
  const dir = path.join(OUT, cell.name);
  const jsonPath = path.join(dir, 'cpu-baseline.json');
  if (process.env.PROF_RESUME === '1' && fs.existsSync(jsonPath)) { console.log(`[driver] ${cell.name}: cached (${jsonPath})`); return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  fs.mkdirSync(dir, { recursive: true });
  const loadBefore = os.loadavg()[0];
  const child = HE.spawnHarness(ELECTRON || HE.electronBin(), [ENTRY], {
    cwd: APP,
    label: `profile-${cell.name}`,
    // Own process group + harness marker: the cell dies with this run — group kill on driver
    // exit/signal/error here, parent-death watchdog inside the app itself, pidfile-recorded
    // orphan reap as the last resort. Never matched by name.
    env: { ...process.env, ...cell.env, PERF_OUT: dir, PERF_DURATION_MS: String(DURATION_MS), PERF_WARM_MS: String(WARM_MS) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const budgetMs = (WARM_MS + DURATION_MS) + 240000;
  const code = await new Promise((resolve) => {
    const guard = setTimeout(() => { console.error(`[driver] ${cell.name}: TIMEOUT after ${Math.round(budgetMs / 1000)}s — killing process group of pid ${child.pid}`); void HE.killGroup(child.pid, { log: (m) => console.error(`[driver] ${cell.name}: ${m}`) }); resolve(-1); }, budgetMs);
    child.on('exit', (c) => { clearTimeout(guard); resolve(c == null ? -1 : c); });
    child.on('error', (e) => { clearTimeout(guard); console.error(`[driver] ${cell.name}: spawn failed:`, e.message); resolve(-2); });
  });
  if (!fs.existsSync(jsonPath)) throw new Error(`${cell.name}: no cpu-baseline.json (electron exit ${code})`);
  const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  result.env.loadavg1mBeforeCell = +loadBefore.toFixed(2);
  result.env.exitCode = code;
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  return result;
}

const pctDelta = (base, v) => (base ? `(${v >= base ? '+' : ''}${Math.round((v - base) / base * 100)}%)` : '');

function merge(results) {
  const byName = Object.fromEntries(results.map((r) => [r.name, r.r]));
  const row = (name) => {
    const r = byName[name]; if (!r) return null;
    const c = r.counts, cpu = r.cpu, page = r.page;
    return { cell: name, renderer: cpu.renderer.avg, gpu: cpu.gpu.avg, main: cpu.main.avg, feedKeyS: c.feedKeyPerSec, rebuildS: c.rebuildsPerSec, refreshS: c.refreshPerSec, working: page.working || 0, anims: JSON.stringify(page.anims) };
  };
  const rows = results.map((r) => row(r.name)).filter(Boolean);
  const md = [`# Renderer/GPU CPU baseline (t_09b11191)`, '',
    `${DURATION_MS / 1000}s windows · electron ${byName[results[0].name].env.electron} · commit ${String(byName[results[0].name].env.commit).slice(0, 9)} · ${byName[results[0].name].env.platform}`,
    `Scenarios: idle = 0 agents · feedidle = 550 tasks/1500 logs seeded, nothing running · load = 2 synthetic agents streaming · feed = load + seeds (grown project)`,
    '', '| cell | renderer % | gpu % | main % | feedKey/s | rebuilds/s | refresh/s | working | running anims |', '|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((r) => `| ${r.cell} | ${r.renderer} | ${r.gpu} | ${r.main} | ${r.feedKeyS} | ${r.rebuildS} | ${r.refreshS} | ${r.working} | ${r.anims} |`), '',
    '## Attribution deltas vs same-scenario baseline', ''];
  for (const base of ['idle', 'feedidle', 'load', 'feed']) {
    const b = byName[base]; if (!b) continue;
    md.push(`### ${base} (renderer ${b.cpu.renderer.avg}% · gpu ${b.cpu.gpu.avg}%)`);
    for (const [name, label] of [[base + '-animoff', 'animations off'], [base + '-freezefeed', 'Chat.feedKey frozen (no rebuilds)'], [base + '-freezepoll', 'refresh poll frozen'], [base + '-animoff-sweep', 'avatar sweep ring off'], [base + '-animoff-spin', 'spinners off'], [base + '-animoff-dots', 'pulse dots off']]) {
      const c = byName[name]; if (!c) continue;
      md.push(`- ${label}: renderer ${c.cpu.renderer.avg}% ${pctDelta(b.cpu.renderer.avg, c.cpu.renderer.avg)}, gpu ${c.cpu.gpu.avg}% ${pctDelta(b.cpu.gpu.avg, c.cpu.gpu.avg)}, rebuilds ${c.counts.rebuildsPerSec}/s (was ${b.counts.rebuildsPerSec}/s)`);
    }
    md.push('');
  }
  fs.writeFileSync(path.join(OUT, 'renderer-cpu.md'), md.join('\n'));
  fs.writeFileSync(path.join(OUT, 'renderer-cpu.json'), JSON.stringify({ generatedAt: new Date().toISOString(), outDir: OUT, durationMs: DURATION_MS, rows, cells: results.map((r) => r.name) }, null, 2));
  return md.join('\n');
}

(async () => {
  const cells = CELLS.filter((c) => !FILTER.length || FILTER.includes(c.name));
  console.log(`[driver] ${cells.length} cell(s) → ${OUT}`);
  const results = [];
  for (const cell of cells) {
    console.log(`\n[driver] === ${cell.name} (${JSON.stringify(cell.env)}) ===`);
    try { const r = await runCell(cell); results.push({ name: cell.name, r }); console.log(`[driver] ${cell.name}: renderer ${r.cpu.renderer.avg}% · gpu ${r.cpu.gpu.avg}%`); }
    catch (e) { console.error(`[driver] ${cell.name} FAILED:`, e.message); }
  }
  if (results.length) console.log('\n' + merge(results));
  console.log(`[driver] report: ${path.join(OUT, 'renderer-cpu.md')}`);
})().catch((e) => { console.error(e); process.exit(1); });
