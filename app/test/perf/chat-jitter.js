#!/usr/bin/env node
'use strict';
/*
 * Chat visual-stability probe. Run from app/ with Electron:
 *   PERF_AGENTS=2 PERF_OUT=/tmp/colvari-jitter ./node_modules/.bin/electron test/perf/chat-jitter.js
 *
 * Instruments #chat-room while real agents stream. It separates visible-message arrivals from
 * incidental DOM mutations, scroll movement, and LayoutShift entries so a jitter regression has a
 * reproducible evidence log rather than relying on frame-time averages.
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(process.env.PERF_APP_DIR || path.join(__dirname, '../..'));
const MAIN = path.join(APP, 'src/main.js');
const HCPATH = process.env.PERF_HCPATH || '/Users/d/.local/bin/helpycode';
const MODEL = process.env.PERF_HC_MODEL || 'elice/z-ai/glm-5.3-flash';
const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `colvari-chat-jitter-${Date.now()}`);
const AGENTS = Math.max(1, Number(process.env.PERF_AGENTS || 2));
const STREAM_MS = Math.max(5000, Number(process.env.PERF_STREAM_MS || 30000));
const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsq = (v) => JSON.stringify(v);
fs.mkdirSync(OUT, { recursive: true });
process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-jitter-root-'));
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = String(STREAM_MS + 480000);
process.env.AGENTS_SQUAD_DEV = '0';
process.on('exit', () => { try { fs.rmSync(process.env.AGENTS_SQUAD_PROJECT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });

app.setPath('userData', path.join(process.env.AGENTS_SQUAD_PROJECT, 'userData'));
// Forensics (who deletes the probe project?): the app shares this process and module cache, so
// patching fs here sees the app's own destructive calls with full stacks.
const origRm = fs.rmSync.bind(fs);
fs.rmSync = (p, opts) => {
  const s = String(p);
  if (s.includes(process.env.AGENTS_SQUAD_PROJECT) && !s.endsWith('/.lock')) console.error('[chat-jitter][RM]', s, '\n', new Error('rm-stack').stack.split('\n').slice(1, 6).join('\n'));
  return origRm(p, opts);
};
require(MAIN);
let wc = null;
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'window') return;
  contents.setBackgroundThrottling(false);
  contents.on('did-finish-load', async () => {
    wc = contents;
    try { await main(); } catch (error) { console.error('[chat-jitter] failed:', error && error.stack || error); app.exit(1); }
  });
});

const ex = (script) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${script} })()`);
const exT = (script, ms = 30000) => Promise.race([ex(script), WAIT(ms).then(() => { throw new Error('renderer-timeout'); })]);

function seedStore(dir, nodes) {
  const { Store } = require(path.join(APP, 'src/store.js'));
  const store = new Store(dir);
  const now = Date.now();
  for (let i = 0; i < 240; i++) store.appendLog({ nodeId: nodes[i % nodes.length], kind: 'text', text: `history line ${i}`, at: now - (240 - i) * 1000, level: 'info' });
}

const INSTRUMENT = `
  if (window.__chatJitter) return { already: true };
  const room = document.querySelector('#chat-room');
  if (!room) return { error: 'no-chat-room' };
  const P = window.__chatJitter = {
    startedAt: performance.now(),
    baseline: { top: room.scrollTop, height: room.scrollHeight, groups: room.querySelectorAll('.cgroup').length },
    mutations: [], scrolls: [], shifts: [], messages: [], chrome: [], roomSizes: [], lastGroups: room.querySelectorAll('.cgroup').length,
  };
  const chromeRoots = { header: document.querySelector('header'), sidebar: document.querySelector('#sidebar'), 'chat-head': document.querySelector('.chat-head'), yourturn: document.querySelector('#chat-yourturn') };
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
  // Visibility check is a forced layout per node — bound it: only the first nodes of each record,
  // and never during the huge run-finish bursts (the unbounded version stalled the page for >10 s
  // during the 100-group final burst and cost the whole run).
  let visBudget = 0; // tags only — a forced layout per node stalled the page under load
  const visible = (node) => {
    if (!(node instanceof Element) || visBudget <= 0) return false;
    visBudget--;
    const r = node.getBoundingClientRect();
    const rr = room.getBoundingClientRect();
    return r.bottom > rr.top && r.top < rr.bottom && r.right > rr.left && r.left < rr.right;
  };
  new MutationObserver((records) => {
    const at = performance.now() - P.startedAt;
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      const added = [...r.addedNodes].filter((n) => n.nodeType === 1).map((n) => ({ tag: n.tagName, cls: n.className || '', text: String(n.textContent || '').slice(0, 120), visible: visible(n) }));
      const removed = [...r.removedNodes].filter((n) => n.nodeType === 1).map((n) => ({ tag: n.tagName, cls: n.className || '', text: String(n.textContent || '').slice(0, 120), visible: visible(n) }));
      P.mutations.push({ at: +at.toFixed(1), type: r.type, target: target && (target.id || target.className || target.tagName), attr: r.attributeName || null, added, removed, visibleTarget: visible(target) });
    }
    if (P.mutations.length > 10000) P.mutations.splice(0, 2000);
  }).observe(room, { subtree: true, childList: true, attributes: true, characterData: true });
  room.addEventListener('scroll', () => P.scrolls.push({ at: +(performance.now() - P.startedAt).toFixed(1), top: room.scrollTop, height: room.scrollHeight, groups: room.querySelectorAll('.cgroup').length }), { passive: true });
  if (window.PerformanceObserver) {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) P.shifts.push({ at: +e.startTime.toFixed(1), value: e.value, sources: (e.sources || []).map((s) => { const p = s.previousRect, c = s.currentRect; return { node: s.node && (s.node.id || s.node.className || s.node.tagName), prev: p ? { x: p.x, y: p.y, w: p.width, h: p.height } : null, cur: c ? { x: c.x, y: c.y, w: c.width, h: c.height } : null }; }) }); }).observe({ type: 'layout-shift', buffered: true });
    } catch (error) { P.shiftError = String(error); }
  }
  const sample = () => {
    // 10 Hz geometry trace, not per-rAF: per-frame scrollHeight/scrollTop reads force layout every
    // frame and starve the page under load (the dump exT timed out on a loaded box).
    const groups = room.querySelectorAll('.cgroup').length;
    if (groups !== P.lastGroups) { P.messages.push({ at: +(performance.now() - P.startedAt).toFixed(1), groups, delta: groups - P.lastGroups }); P.lastGroups = groups; }
    const yt = document.querySelector('#chat-yourturn');
    const rec = { at: +(performance.now() - P.startedAt).toFixed(1), top: Math.round(room.scrollTop), sh: room.scrollHeight, ch: room.clientHeight, g: groups, yt: yt && !yt.classList.contains('hidden') ? Math.round(yt.getBoundingClientRect().height) : 0 };
    if (!P.lastFrame || Math.abs(rec.top - P.lastFrame.top) > 0.5 || rec.sh !== P.lastFrame.sh || rec.ch !== P.lastFrame.ch || rec.g !== P.lastFrame.g || rec.yt !== P.lastFrame.yt) { P.frames.push(rec); if (P.frames.length > 6000) P.frames.shift(); }
    P.lastFrame = rec;
    setTimeout(sample, 100);
  };
  P.frames = [];
  setTimeout(sample, 100);
  if (window.ResizeObserver) {
    new ResizeObserver((entries) => { for (const e of entries) P.roomSizes.push({ at: +(performance.now() - P.startedAt).toFixed(1), h: e.contentRect.height, w: e.contentRect.width }); }).observe(room);
    const composer = document.querySelector('.composer'); if (composer) new ResizeObserver((entries) => { for (const e of entries) P.roomSizes.push({ at: +(performance.now() - P.startedAt).toFixed(1), composerH: e.contentRect.height }); }).observe(composer);
  }
  return { ok: true, baseline: P.baseline };
`;

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
  const t0 = Date.now();
  const seed = await ex(`const p = await call('createProject', 'Chat jitter probe'); switchTo({ p: p.id }); await w(300); await refresh(); await call('saveSettings', { helpycodePath: ${jsq(HCPATH)}, useWorktrees: false, maxConcurrency: ${AGENTS}, maxRuns: ${AGENTS + 2}, requireApproval: false, stallTimeoutMin: 5 }); const nodes = []; for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'Jitter-' + (i + 1), role: 'Dev', x: 100 + i * 220, y: 120, runtime: 'helpycode', model: ${jsq(MODEL)} })); await refresh(); return { dir: S.dir, nodes: nodes.map((n) => n.id) };`);
  seedStore(seed.dir, seed.nodes);
  const listProjects = () => { try { return fs.readdirSync(path.join(process.env.AGENTS_SQUAD_PROJECT, 'projects')).join(','); } catch (e) { return 'ERR ' + e.message; } };
  console.log('[chat-jitter] after-seed projects:', listProjects());
  // loadLogs is once-per-project and already ran for this pid; drop the marker so the seeded
  // history is pulled, then clear the team scope so nothing filters the feed.
  await ex(`logsLoaded.delete(ctx.p); lastV = null; await refresh(); sel.chatTeam = ''; chatSched.force(); showTab('chat'); await w(500); return { logs: logs.length, inProject: logs.filter((l) => l.projectId === ctx.p).length, groups: document.querySelectorAll('#chat-room .cgroup').length };`).then((r) => console.log('[chat-jitter] seeded feed:', JSON.stringify(r)));
  console.log('[chat-jitter] after-refresh projects:', listProjects());
  const armed = await exT(INSTRUMENT, 10000);
  if (!armed || armed.error) throw new Error('instrumentation failed: ' + JSON.stringify(armed));
  // PERF_SYNTHETIC=1: no agents at all — drive only the app's own 2s backstop refresh against the
  // static pinned feed. Isolates renderer-internal movers (content-visibility placeholder dance,
  // anchoring) from streaming: any layout shift here has no message and no data change behind it.
  if (process.env.PERF_SYNTHETIC === '1') {
    await ex(`window.__synth = setInterval(() => { refresh(); }, 2000); await w(${STREAM_MS}); clearInterval(window.__synth); return true;`).catch((e) => console.error('[chat-jitter] synthetic driver ended:', e.message));
  } else {
    const toolTask = (n) => `await call('createTask', { title: 'UI stability probe ' + ${n}, description: 'Help stress-test the chat UI. Do exactly 12 tool calls, one at a time, each of the exact form: node -e "console.log(process.version, process.uptime())" (only this command, nothing else). After every tool result, write one short sentence as a plain text reply line. Do not run any other command. Never modify, create, or delete anything.', assignee: ${jsq(seed.nodes[n - 1])} });`;
    await ex(`await call('run'); ${toolTask(1)} ${toolTask(2)} await refresh();`);
    // The agents run OUTSIDE this process (their rmSync is invisible to the fs patch) — watch the
    // project dir from the driver so a mid-run disappearance is timestamped.
    const dirWatch = setInterval(() => { const s = listProjects(); console.log('[chat-jitter] projects@' + Math.round((Date.now() - t0) / 1000) + 's:', s); }, 5000);
    dirWatch.unref?.();
    try { await waitForWorking(); } catch (e) {
      const diag = await ex(`return { agents: S.orch.agents, todo: S.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').map((t) => t.id + ' ' + t.assignee + ' ' + t.status), logTail: logs.slice(-8).map((l) => l.kind + ': ' + String(l.text).slice(0, 160)) }`).catch(() => ({}));
      let rootDump = '';
      try { rootDump = fs.readdirSync(path.join(process.env.AGENTS_SQUAD_PROJECT, 'projects')).map((d) => { try { return d + ':' + fs.readdirSync(path.join(process.env.AGENTS_SQUAD_PROJECT, 'projects', d)).slice(0, 8).join(','); } catch (er) { return d + ':ERR ' + er.message; } }).join(' | '); } catch (er) { rootDump = 'root gone: ' + er.message; }
      throw new Error(e.message + ' — diagnostics: ' + JSON.stringify(diag, null, 2) + '\nprojects dir: ' + rootDump);
    }
  }
  await WAIT(STREAM_MS);
  // Piecewise pull: one hung field must not lose the whole run's evidence.
  const grab = (key, ms) => exT(`return (window.__chatJitter || {})[${jsq(key)}] || []`, ms).catch(() => []);
  const meta = await exT(`const P = window.__chatJitter || {}; return { startedAt: P.startedAt, baseline: P.baseline, lastFrame: P.lastFrame, frames: P.frames || [], messages: P.messages || [], roomSizes: P.roomSizes || [], shiftError: P.shiftError }`, 20000).catch(() => ({}));
  const mutations = await grab('mutations', 20000);
  const shifts = await grab('shifts', 20000);
  const scrolls = await grab('scrolls', 15000);
  const chrome = await grab('chrome', 20000);
  const result = { ...meta, mutations, shifts, scrolls, chrome };
  fs.writeFileSync(path.join(OUT, 'chat-jitter.json'), JSON.stringify(result, null, 2));
  const chromeByTarget = {};
  for (const c of result.chrome) { const k = c.where + ':' + c.target + ':' + c.type; chromeByTarget[k] = (chromeByTarget[k] || 0) + 1; }
  const summary = { out: OUT, mutations: result.mutations.length, scrolls: result.scrolls.length, shifts: result.shifts.length, messageArrivals: result.messages.length, visibleMutations: result.mutations.filter((m) => m.visibleTarget || m.added.some((n) => n.visible) || m.removed.some((n) => n.visible)).length, chromeWrites: result.chrome.length, chromeByTarget, roomSizes: result.roomSizes.length, maxScrollDelta: result.scrolls.reduce((m, x, i, a) => Math.max(m, i ? Math.abs(x.top - a[i - 1].top) : 0), 0), shiftValue: +result.shifts.reduce((s, x) => s + x.value, 0).toFixed(6), shiftSources: result.shifts.flatMap((s) => s.sources.map((x) => x.node)) };
  fs.writeFileSync(path.join(OUT, 'chat-jitter-summary.json'), JSON.stringify(summary, null, 2));
  console.log('[chat-jitter] ' + JSON.stringify(summary));
  try { await exT(`await call('stop')`, 15000); } catch {}
  await WAIT(1000);
  app.exit(0);
}
