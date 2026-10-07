#!/usr/bin/env node
'use strict';
/*
 * Render-path profile (t_b5908c4d): what does the board render cost on a grown board? Boots the
 * real Electron app in GUI test mode (isolated temp data root, no runs, no CLIs — nothing
 * streams), seeds tasks cumulatively through a second disk-backed Store instance on the same
 * project dir (the out-of-band pattern; the main process re-reads the board dir on its sig).
 * Times the board render path four ways per scale, 100 samples each:
 *   cold  — cardHtmlCache cleared: full cardHtml over every visible task (the memo-bust cost a
 *           board-wide change pays, e.g. an agent rename or a status-mix shift)
 *   warm  — memo-hit loop: key build + map get per card, no html rebuild (steady-state renders)
 *   patch — patchBoardColumns over the warm cache: DOM diff with nothing to move (the per-render
 *           board cost that rides every state push)
 *   bust  — patchBoardColumns right after a cache clear: worst case, every card string rebuilt
 *           AND its DOM node replaced (replaces innerHTML, re-creates nodes)
 * plus one forced full renderBoard() per scale (boardSig reset) as the end-to-end upper bound.
 * Seeded content comes from an LCG keyed on seed 470, so runs are reproducible.
 *
 * Run from app/: npx electron test/perf/render-path-profile.js [60] [300] [600]  (cumulative scales)
 * Writes RESULTS.md + raw.json to test/perf/results/real-agents/t_b5908c4d/.
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(path.join(__dirname, '../..'));
const MAIN = path.join(APP, 'src/main.js');
const SEED = +(process.env.RENDER_PATH_SEED || 470);
const OUT = path.join(APP, 'test/perf/results/real-agents/t_b5908c4d');
const SCALES = (process.argv.slice(2).length ? process.argv.slice(2) : ['60', '300', '600']).map(Number);
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));
const ex = (js) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${js} })()`);
const stat = (t) => { t.sort((a, b) => a - b); const sum = t.reduce((s, x) => s + x, 0); const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))]; return { n: t.length, mean: +(sum / t.length).toFixed(4), p50: +q(0.5).toFixed(4), p95: +q(0.95).toFixed(4), max: +t[t.length - 1].toFixed(4) }; };

process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-render-path-'));
if (!process.env.AGENTS_SQUAD_PROJECT.startsWith(os.tmpdir())) throw new Error('[render-path] AGENTS_SQUAD_PROJECT must be an isolated temp root — refusing to run against shared data');
process.on('exit', () => { try { fs.rmSync(process.env.AGENTS_SQUAD_PROJECT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = '300000';
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
    try { await main(); } catch (e) { failed = true; console.error('[render-path] failed:', e && e.stack || e); }
    app.exit(failed ? 1 : 0);
  });
});

// LCG seed 470, same construction as the wake-sweep / inbox-badge families so profiles stay comparable.
let st = SEED;
const rnd = () => (st = (st * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const words = 'flaky test merge gate baseline card snippet render board profile benchmark seed room rebuild columns patch memo signature jank frame worktree orchestrator dispatch'.split(' ');
const sentence = () => Array.from({ length: 8 + Math.floor(rnd() * 10) }, () => pick(words)).join(' ') + '.';
const title = () => Array.from({ length: 3 + Math.floor(rnd() * 4) }, () => pick(words)).join(' ');

// Realistic column mix: most landed work sits in done (folded to 20), the open work is spread
// across todo/in_progress/review; waiting_for_human and merge_conflict are minority states.
const STATUS_MIX = ['todo', 'todo', 'todo', 'in_progress', 'in_progress', 'in_progress', 'review', 'review', 'waiting_for_human', 'merge_conflict', 'done', 'done', 'done', 'done'];

async function main() {
  await WAIT(1200);
  // Throwaway project with six agents — enough assignees for a realistic worker-state fan-out.
  const seedInfo = await ex(`const p = await call('createProject', 'Render path probe'); switchTo({ p: p.id }); await w(300); await refresh(); const ids = []; for (let i = 0; i < 6; i++) ids.push((await call('addNode', { name: 'Agent-' + i, role: 'Dev', x: 120 + i * 40, y: 120 + i * 30 })).id); await refresh(); return { dir: S.dir, nodes: ids };`);
  console.log('[render-path] provisioned', JSON.stringify(seedInfo));

  const { Store } = require(path.join(APP, 'src/store.js'));
  const st2 = new Store(seedInfo.dir);

  const rows = [];
  let total = 0;
  const ids = [];
  const statuses = [];
  for (const scale of SCALES) {
    const n = scale - total;
    for (let i = 0; i < n; i++) {
      const s = total === 0 ? 'todo' : (i === 0 ? 'in_progress' : pick(STATUS_MIX));
      const t = st2.createTask({
        title: title(), description: sentence(), assignee: rnd() < 0.9 ? pick(seedInfo.nodes) : null,
        createdBy: rnd() < 0.7 ? 'human' : pick(seedInfo.nodes), priority: pick(['P0', 'P1', 'P2', 'P2', 'P3']),
      });
      ids[total] = t.id; statuses[total] = s;
      st2.updateTask(t.id, { status: s });
      // ~10% blocked: chain onto an earlier task (its state decides whether the blocker is open).
      if (total > 0 && rnd() < 0.1) st2.updateTask(t.id, { blockedBy: [ids[Math.floor(rnd() * total)]] });
      const nCmts = Math.floor(rnd() * 5);
      for (let c = 0; c < nCmts; c++) st2.commentTask(t.id, rnd() < 0.5 ? 'human' : pick(seedInfo.nodes), sentence());
      total++;
    }
    await ex(`await refresh(); showTab('board'); await w(150);`);
    // Out-of-band writes reach the main store's board cache via its dir watcher (FSEvents
    // latency), so poll until the renderer actually sees the batch before timing.
    let seen = 0;
    for (let i = 0; i < 60 && seen !== total; i++) {
      seen = await ex(`await refresh(); return S.tasks.length;`);
      if (seen !== total) await WAIT(100);
    }
    if (seen !== total) throw new Error(`renderer never saw the batch: S.tasks=${seen} expected ${total}`);
    // envKey must match what patchBoardColumns builds, or the warm loop below measures nothing:
    // rebuild it the same way so the memo hits are real hits.
    const loops = await ex(`
      const envKey = [agentStamp(), JSON.stringify(S.orch.running || null), rst.scheduledAfter || '', rst.gating.join(), upd.devMode !== false, sel.boardTeam || '', S.tasks.length, S.tasks.map((x) => colStOf(x)[0]).join(''), S.allNodes.map((n) => n.name).join()].join('|');
      const tasks = S.tasks.filter((t) => teamScoped(sel.boardTeam, t.assignee));
      const cold = [], warm = [], patch = [], bust = [];
      for (let i = 0; i < 100; i++) {
        cardHtmlCache.clear();
        let a = performance.now(); for (const t of tasks) cardHtmlCached(t, envKey); cold.push(performance.now() - a);
        a = performance.now(); for (const t of tasks) cardHtmlCached(t, envKey); warm.push(performance.now() - a);
        a = performance.now(); patchBoardColumns(tasks); patch.push(performance.now() - a);
        cardHtmlCache.clear();
        a = performance.now(); patchBoardColumns(tasks); bust.push(performance.now() - a);
        cardHtmlCache.clear(); patchBoardColumns(tasks);
      }
      let full = 0;
      for (let i = 0; i < 100; i++) { boardSig = ''; const a = performance.now(); renderBoard(); full += performance.now() - a; }
      return { cold: cold, warm: warm, patch: patch, bust: bust, full: full / 100, n: S.tasks.length, cards: document.querySelectorAll('#columns .card').length };`);
    const row = {
      scale: total, verified: loops.n === total && loops.cards > 0,
      cold: stat(loops.cold), warm: stat(loops.warm), patch: stat(loops.patch), bust: stat(loops.bust), fullRender: loops.full,
    };
    rows.push(row);
    console.log(`[render-path] tasks=${total} cards=${loops.cards} cold=${JSON.stringify(row.cold)} warm=${JSON.stringify(row.warm)} patch=${JSON.stringify(row.patch)} bust=${JSON.stringify(row.bust)} full=${row.fullRender.toFixed(2)}ms verified=${row.verified}`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'raw.json'), JSON.stringify({ seed: SEED, app: APP, scales: SCALES, rows }, null, 2));
  const fmt = (r, k) => `${r[k].mean.toFixed(2)} / ${r[k].p50.toFixed(2)} / ${r[k].p95.toFixed(2)} / ${r[k].max.toFixed(2)}`;
  const md = `# Render-path profile at ${rows[rows.length - 1].scale} seeded tasks (t_b5908c4d)

Seeded board tasks via a second Store instance on the app's project dir (LCG seed ${SEED},
realistic column mix, ~10% blocked, 0–4 comments each), real Electron app in GUI test mode,
no runs streaming. Numbers are mean / p50 / p95 / max in ms (100 samples each).

| tasks | cold cardHtml (all cards) | warm memo-hit loop | patchBoardColumns (warm) | patchBoardColumns (bust) | full renderBoard |
|---|---|---|---|---|---|
${rows.map((r) => `| ${r.scale} | ${fmt(r, 'cold')} | ${fmt(r, 'warm')} | ${fmt(r, 'patch')} | ${fmt(r, 'bust')} | ${r.fullRender.toFixed(2)} |`).join('\n')}

- cold: cardHtmlCache cleared, cardHtmlCached over every visible task — the html-string cost of a
  board-wide memo bust, no DOM.
- warm: the same loop with the memo holding — key build + map get per card.
- patch (warm): patchBoardColumns over the live cache — the per-render board cost that rides
  every state push (DOM diff finds nothing to move).
- bust: patchBoardColumns right after a cache clear — every card string rebuilt AND its DOM node
  replaced; the worst case a single board-wide input (agent rename, status-mix shift) can trigger.
- full: one forced renderBoard() per sample (boardSig reset) — end-to-end upper bound including
  the detail panel and chrome.

## Findings
`;
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), md);
  console.log('[render-path] wrote ' + OUT);
}
