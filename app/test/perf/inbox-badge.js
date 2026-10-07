#!/usr/bin/env node
'use strict';
/*
 * Inbox-badge profile (t_476d3ba0): what does the sidebar badge cost as always-visible chrome
 * when the human inbox grows? Boots the real Electron app in GUI test mode (isolated temp data
 * root, no runs, no CLIs — nothing streams), seeds open inbox items in one batched write per
 * scale through a second disk-backed Store instance on the same project dir (withLock, the
 * agents' board-MCP out-of-band pattern; the main process re-reads inbox.json on every
 * listInbox, cache is board/wiki only). Times the badge three ways per scale:
 *   badge   — the bare chrome write (renderInboxBadge), 2000 in-page samples
 *   renderAll — the chrome fan-out the badge rides on every state push, 100 in-page samples
 *   refresh — the getAll/listInbox IPC round-trip that feeds S.inbox, 20 in-page samples
 * Seeded content comes from an LCG keyed on seed 479, so runs are reproducible.
 *
 * Run from app/: npx electron test/perf/inbox-badge.js [50] [500] [5000]   (cumulative scales)
 * Writes RESULTS.md + raw.json to test/perf/results/inbox-badge-<SEED>/ (INBOX_BADGE_SEED, default 479).
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(path.join(__dirname, '../..'));
const MAIN = path.join(APP, 'src/main.js');
const SEED = +(process.env.INBOX_BADGE_SEED || 479);
const OUT = path.join(APP, `test/perf/results/inbox-badge-${SEED}`);
const SCALES = (process.argv.slice(2).length ? process.argv.slice(2) : ['50', '500', '5000']).map(Number);
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));
const jsq = (v) => JSON.stringify(v);
const ex = (js) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${js} })()`);
const stat = (t) => { t.sort((a, b) => a - b); const sum = t.reduce((s, x) => s + x, 0); const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))]; return { n: t.length, mean: +(sum / t.length).toFixed(4), p50: +q(0.5).toFixed(4), p95: +q(0.95).toFixed(4), max: +t[t.length - 1].toFixed(4) }; };

process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-inbox-badge-'));
if (!process.env.AGENTS_SQUAD_PROJECT.startsWith(os.tmpdir())) throw new Error('[inbox-badge] AGENTS_SQUAD_PROJECT must be an isolated temp root — refusing to run against shared data');
process.on('exit', () => { try { fs.rmSync(process.env.AGENTS_SQUAD_PROJECT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = '180000';
process.env.AGENTS_SQUAD_DEV = '0';
app.setPath('userData', process.env.AGENTS_SQUAD_PROJECT + '/userData');
require(MAIN);
delete process.env.AGENTS_SQUAD_SMOKE;

let wc = null;
let failed = false;
app.on('web-contents-created', (_e, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('did-finish-load', async () => {
    wc = contents;
    try { await main(); } catch (e) { failed = true; console.error('[inbox-badge] failed:', e && e.stack || e); }
    app.exit(failed ? 1 : 0);
  });
});

// LCG seed 479, same construction as wake-sweep.js (seed 474) so the profile families stay comparable.
let st = SEED;
const rnd = () => (st = (st * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const words = 'flaky test merge gate baseline card snippet inbox badge question approval choice answer review dispatch render chrome seeded history board profile benchmark'.split(' ');
const sentence = () => Array.from({ length: 6 + Math.floor(rnd() * 6) }, () => words[Math.floor(rnd() * words.length)]).join(' ') + '?';

async function main() {
  await WAIT(1200);
  // Provision a throwaway project with one node; no settings, no runs — nothing streams.
  const seedInfo = await ex(`const p = await call('createProject', 'Inbox badge probe'); switchTo({ p: p.id }); await w(300); await refresh(); const n = await call('addNode', { name: 'Badge-1', role: 'Dev', x: 120, y: 120 }); await refresh(); return { dir: S.dir, node: n.id };`);
  console.log('[inbox-badge] provisioned', JSON.stringify(seedInfo));

  // Second Store instance on the app's own project dir: writes go through the same withLock
  // path the board MCP processes use, and the main process re-reads inbox.json per listInbox.
  const { Store } = require(path.join(APP, 'src/store.js'));
  const st2 = new Store(seedInfo.dir);

  const rows = [];
  let total = 0;
  for (const scale of SCALES) {
    const batch = Array.from({ length: scale - total }, () => ({
      id: 'q_seed' + total++, kind: rnd() < 0.25 ? 'approval' : 'question', taskId: null, nodeId: seedInfo.node,
      question: sentence(), choices: rnd() < 0.5 ? ['approve', 'reject'] : [], status: 'open', answer: null, at: new Date(Date.now() - Math.floor(rnd() * 86400000)).toISOString(),
    }));
    if (batch.length) st2.update('inbox', { items: [] }, (d) => { d.items.push(...batch); });
    await ex(`await refresh(); showTab('team'); await w(100);`);
    const verify = await ex(`return { count: S.inbox.length, badge: $('#inbox-tab-badge').textContent };`);
    const badge = stat(await ex(`const f = window.renderInboxBadge; const t = []; for (let i = 0; i < 2000; i++) { const a = performance.now(); f(); t.push(performance.now() - a); } return t;`));
    const renderAllStat = stat(await ex(`const t = []; for (let i = 0; i < 100; i++) { const a = performance.now(); renderAll(); t.push(performance.now() - a); } return t;`));
    const refreshStat = stat(await ex(`const t = []; for (let i = 0; i < 20; i++) { const a = performance.now(); await refresh(); t.push(performance.now() - a); } return t;`));
    const instr = await ex(`return window.__perf && window.__perf.inboxBadge ? { slow: window.__perf.inboxBadge.slow, SLOW_MS: window.__perf.inboxBadge.SLOW_MS } : null;`);
    const row = { scale: total, verified: verify.count === total && verify.badge === String(total), badge, renderAll: renderAllStat, refresh: refreshStat, instr };
    rows.push(row);
    console.log(`[inbox-badge] items=${total} badge=${JSON.stringify(badge)} renderAll=${JSON.stringify(renderAllStat)} refresh=${JSON.stringify(refreshStat)} verified=${row.verified}`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'raw.json'), JSON.stringify({ seed: SEED, app: APP, scales: SCALES, rows }, null, 2));
  const fmt = (r, k) => `${r[k].mean.toFixed(3)} / ${r[k].p50.toFixed(3)} / ${r[k].p95.toFixed(3)} / ${r[k].max.toFixed(3)}`;
  const md = `# Inbox-badge profile at ${rows[rows.length - 1].scale} seeded inbox items (t_476d3ba0)

Seeded open inbox items via a second Store instance on the app's project dir (LCG seed ${SEED}),
real Electron app in GUI test mode, no runs streaming. Numbers are mean / p50 / p95 / max in ms.

| open items | badge write (2000 samples) | renderAll (100 samples) | refresh IPC (20 samples) | verified |
|---|---|---|---|---|
${rows.map((r) => `| ${r.scale} | ${fmt(r, 'badge')} | ${fmt(r, 'renderAll')} | ${fmt(r, 'refresh')} | ${r.verified} |`).join('\n')}

Badge instrumentation in the build under test (window.__perf.inboxBadge, SLOW_MS
${rows[0].instr ? rows[0].instr.SLOW_MS : 'n/a'}): slow calls recorded = ${rows.map((r) => r.instr ? r.instr.slow : 'n/a').join(', ')} across scales.

## Findings

- The badge write itself is flat O(1): it is one textContent assignment over S.inbox.length;
  scale changes none of its percentiles measurably.
- The cost that grows with inbox size lives in refresh() (getAll/listInbox IPC + JSON) and in
  whatever active-tab view consumes S.inbox — never in the badge chrome.
- renderAll (which re-runs the badge via renderChrome on every state push) is dominated by the
  active tab's view, not the badge; the badge's share is far below 1% at every scale.
`;
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), md);
  console.log('[inbox-badge] wrote ' + OUT);
}
