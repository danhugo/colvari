#!/usr/bin/env node
'use strict';
/*
 * Composer typing-interrupt + IME echo probe (t_h0a1c2fa). Run from app/ with Electron:
 *   PERF_AGENTS=2 PERF_OUT=/tmp/colvari-typing PERF_APP_DIR=/path/to/app-under-test \
 *     ./node_modules/.bin/electron test/perf/chat-typing.js
 *
 * While real agents stream into #company, a scripted typist writes into the composer and a
 * sampler logs focus/value/caret continuity, per-keystroke main-thread stalls, composer DOM
 * churn, and room render batches (full rebuild vs append). A scripted IME composition then
 * sends Enter mid-composition — the stray-echo repro — and the store is read back for ground
 * truth. PERF_APP_DIR selects the build under test so the same probe produces before/after logs.
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(process.env.PERF_APP_DIR || path.join(__dirname, '../..'));
const MAIN = path.join(APP, 'src/main.js');
const HCPATH = process.env.PERF_HCPATH || '/Users/d/.local/bin/helpycode';
const MODEL = process.env.PERF_HC_MODEL || 'elice/z-ai/glm-5.3-flash';
const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), `colvari-chat-typing-${Date.now()}`);
const AGENTS = Math.max(1, Number(process.env.PERF_AGENTS || 2));
const STREAM_MS = Math.max(5000, Number(process.env.PERF_STREAM_MS || 30000));
const TYPE_MS = Math.max(60, Number(process.env.PERF_TYPE_MS || 120));
const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsq = (v) => JSON.stringify(v);
fs.mkdirSync(OUT, { recursive: true });
process.env.AGENTS_SQUAD_SMOKE = '1';
process.env.AGENTS_SQUAD_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-typing-root-'));
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = String(STREAM_MS + 240000);
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
    try { await main(); } catch (error) { console.error('[chat-typing] failed:', error && error.stack || error); app.exit(1); }
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
  if (window.__chatTyping) return { already: true };
  const input = document.querySelector('#chat-input');
  const composer = document.querySelector('.composer');
  const room = document.querySelector('#chat-room');
  if (!input || !composer || !room) return { error: 'no-chat-dom' };
  const P = window.__chatTyping = {
    startedAt: performance.now(),
    inserts: [],       // per scripted keystroke: gap since the previous one (main-thread blocking shows here) + execCommand duration
    samples: [],       // 30ms focus/value/caret sampler
    composerMutations: [], // anything mutating inside .composer (preview/mentions writes tagged by target)
    roomBatches: [],   // room childList mutation batches: {added, removedFromTail} — full rebuilds vs appends
    longTasks: [],
    focusChanges: [],
    last: { value: input.value, caret: input.selectionStart, gapAt: performance.now() },
  };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longTasks.push({ at: +(e.startTime - P.startedAt).toFixed(1), dur: +e.duration.toFixed(1) }); }).observe({ type: 'longtask', buffered: true });
  new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target instanceof Element ? r.target : r.target.parentElement;
      const where = t && (t.id === 'chat-preview' || t.id === 'chat-mentions') ? t.id : (t && (t.id || String(t.className || '').split(' ')[0] || t.tagName));
      P.composerMutations.push({ at: +(performance.now() - P.startedAt).toFixed(1), where, type: r.type, text: String(t && t.textContent || '').slice(0, 40) });
    }
  }).observe(composer, { subtree: true, childList: true, attributes: true, characterData: true });
  let pendingRoom = null;
  new MutationObserver((records) => {
    for (const r of records) {
      if (!pendingRoom) { pendingRoom = { at: +(performance.now() - P.startedAt).toFixed(1), added: 0, removed: 0, removedNearTail: 0 }; P.roomBatches.push(pendingRoom); }
      pendingRoom.added += r.addedNodes.length;
      const kids = room.children.length;
      for (const n of r.removedNodes) {
        pendingRoom.removed++;
        const idx = [...room.children].indexOf(n);
        if (idx >= 0 && idx >= kids - 8) pendingRoom.removedNearTail++;
      }
    }
  }).observe(room, { childList: true });
  const sample = () => {
    const now = performance.now();
    const focused = document.activeElement;
    const s = { at: +now.toFixed(1), focused: focused && focused.id || null, value: input.value.length, caret: input.selectionStart };
    if ((focused && focused.id) !== (P.samples.length ? P.samples[P.samples.length - 1].focused : null)) P.focusChanges.push({ at: +now.toFixed(1), to: s.focused });
    P.samples.push(s);
    if (now - P.startedAt < ${STREAM_MS + 12000}) setTimeout(sample, 30);
  };
  sample();
  window.__chatTypeChar = (ch) => {
    const t0 = performance.now();
    const gap = t0 - P.last.gapAt;
    input.focus();
    // Textareas take no Selection ranges — set the value natively (fires the app's input path via
    // the event below) and place the caret at the end like a real typist.
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(input, input.value + ch);
    input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const dur = performance.now() - t0;
    P.inserts.push({ at: +(t0 - P.startedAt).toFixed(1), gap: +gap.toFixed(1), dur: +dur.toFixed(1), ok: true, value: input.value.length, caret: input.selectionStart });
    P.last.gapAt = performance.now();
    return true;
  };
  return { ok: true, tabActive: !!document.querySelector('#tab-chat.active'), visible: input.offsetParent !== null };
`;

const TYPE_SCRIPT = `
  const input = document.querySelector('#chat-input');
  const chars = 'Van dang test camera moi, lam on nhan tin lai sau'.split('');
  let cancelled = false;
  const step = () => {
    if (cancelled || !chars.length) { window.__typingDone = true; return; }
    window.__chatTypeChar(chars.shift());
    setTimeout(step, ${TYPE_MS});
  };
  step();
  return 'typing';
`;

async function waitForWorking(need) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const working = await ex(`return Object.values(S.orch.agents || {}).filter((a) => a.status === 'working').length`).catch(() => 0);
    if (working >= need) return working;
    await WAIT(1000);
  }
  throw new Error('agents did not start');
}

async function main() {
  await WAIT(1000);
  const seed = await ex(`const p = await call('createProject', 'Chat typing probe'); switchTo({ p: p.id }); await w(300); await refresh(); await call('saveSettings', { helpycodePath: ${jsq(HCPATH)}, useWorktrees: false, maxConcurrency: ${AGENTS}, maxRuns: ${AGENTS + 2}, requireApproval: false, stallTimeoutMin: 5 }); const nodes = []; for (let i = 0; i < ${AGENTS}; i++) nodes.push(await call('addNode', { name: 'Typer-' + (i + 1), role: 'Dev', x: 100 + i * 220, y: 120, runtime: 'helpycode', model: ${jsq(MODEL)} })); await refresh(); return { dir: S.dir, nodes: nodes.map((n) => n.id) };`);
  seedStore(seed.dir, seed.nodes);
  await ex(`logsLoaded.delete(ctx.p); await refresh(); sel.chatTeam = ''; chatSched.force(); showTab('chat'); await w(500); return { groups: document.querySelectorAll('#chat-room .cgroup').length };`).then((r) => console.log('[chat-typing] seeded feed:', JSON.stringify(r)));
  const armed = await exT(INSTRUMENT, 10000);
  if (!armed || armed.error) throw new Error('instrumentation failed: ' + JSON.stringify(armed));
  const toolTask = (n) => `await call('createTask', { title: 'Composer stress probe ' + ${n}, description: 'Help stress-test the chat composer. Do at least 12 separate tool calls, one at a time: list files, git status, read package.json, read different source files, node -e version checks. After EVERY tool result, write one short sentence (as a plain text reply line) describing what you saw. Never modify or create files.', assignee: ${jsq(seed.nodes[n - 1])} });`;
  await ex(`await call('run'); ${toolTask(1)} ${toolTask(2)} await refresh();`);
  await waitForWorking(AGENTS);
  const state = await ex(`showTab('chat'); await w(200); return { tabActive: !!document.querySelector('#tab-chat.active'), visible: document.querySelector('#chat-input').offsetParent !== null, logs: logs.length, inProject: logs.filter((l) => l.projectId === ctx.p).length, groups: document.querySelectorAll('#chat-room .cgroup').length };`);
  console.log('[chat-typing] pre-typing state:', JSON.stringify(state));
  if (!state.tabActive || !state.visible) throw new Error('composer not usable: ' + JSON.stringify(state));
  const logFlow = await ex(`const n0 = logs.filter((l) => l.projectId === ctx.p).length; await w(2000); return { before: n0, after: logs.filter((l) => l.projectId === ctx.p).length };`);
  console.log('[chat-typing] log flow over 2s:', JSON.stringify(logFlow));
  console.log('[chat-typing] agents streaming; typing starts');
  await exT(TYPE_SCRIPT, 15000);
  // Wait the typing window out (typing loop also runs while agents stream — that is the point).
  const t0 = Date.now();
  while (!(await ex(`return !!window.__typingDone`).catch(() => false)) && Date.now() - t0 < 120000) await WAIT(500);
  // Give the sampler a beat while streaming continues, then run the IME echo repro live.
  await WAIT(3000);
  const store = new (require(path.join(APP, 'src/store.js')).Store)(seed.dir);
  const core = store.getTeam().nodes[0];
  const humanMsgs = () => store.listMessages({ to: core.id }).filter((m) => m.from === 'human').map((m) => m.text);
  const before = { human: humanMsgs(), value: await ex(`return document.querySelector('#chat-input').value`) };
  await exT(`const i = document.querySelector('#chat-input'); i.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(i, 'dang lam gi v?'); i.selectionStart = i.selectionEnd = i.value.length; i.dispatchEvent(new Event('input', { bubbles: true })); await w(200); i.dispatchEvent(new CompositionEvent('compositionstart')); await w(120); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); await w(500); return { value: i.value };`, 10000);
  const mid = { human: humanMsgs(), value: await ex(`return document.querySelector('#chat-input').value`) };
  await exT(`const i = document.querySelector('#chat-input'); i.dispatchEvent(new CompositionEvent('compositionend')); await w(120); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await w(700); return { value: i.value };`, 10000);
  const after = { human: humanMsgs(), value: await ex(`return document.querySelector('#chat-input').value`) };
  console.log('[chat-typing] IME probe before=' + JSON.stringify(before) + ' midCompositionEnter=' + JSON.stringify(mid) + ' afterCommitEnter=' + JSON.stringify(after));
  await WAIT(STREAM_MS > 30000 ? 0 : 2000);
  const result = await exT(`return window.__chatTyping`, 10000);
  fs.writeFileSync(path.join(OUT, 'chat-typing.json'), JSON.stringify({ ...result, ime: { before, mid, after } }, null, 2));
  const gaps = result.inserts.map((x) => x.gap).sort((a, b) => b - a);
  const failed = result.inserts.filter((x) => !x.ok);
  const caretJumps = result.samples.reduce((n, s, i) => (i && s.focused === 'chat-input' && result.samples[i - 1].focused === 'chat-input' && s.caret < result.samples[i - 1].caret ? n + 1 : n), 0);
  const foreign = result.composerMutations.filter((m) => m.where !== 'chat-preview' && m.where !== 'chat-mentions');
  const fullRebuilds = result.roomBatches.filter((b) => b.removed - b.removedNearTail > 4).length; // removals NOT at the tail = window shifted = full render
  const summary = {
    out: OUT, app: APP,
    keystrokes: result.inserts.length, failedKeystrokes: failed.length,
    typingGapsOver250: gaps.filter((g) => g > 250).length, medianGap: gaps[Math.floor(gaps.length / 2)] || null, maxGap: gaps[0] || null,
    focusLosses: result.focusChanges.filter((f) => f.to !== 'chat-input').length, focusChanges: result.focusChanges, caretJumps,
    composerMutations: result.composerMutations.length, composerForeignMutations: foreign.length, foreignTargets: [...new Set(foreign.map((m) => m.where))],
    previewWrites: result.composerMutations.filter((m) => m.where === 'chat-preview').length,
    mentionWrites: result.composerMutations.filter((m) => m.where === 'chat-mentions').length,
    roomBatches: result.roomBatches.length, fullRebuilds, appendBatches: result.roomBatches.length - fullRebuilds,
    longTasks: result.longTasks.length, longTaskMax: result.longTasks.reduce((m, x) => Math.max(m, x.dur), 0),
    ime: { text: 'dang lam gi v?', beforeSend: before.human.length, sentMidComposition: mid.human.length > before.human.length, midValue: mid.value, finalMessages: after.human, finalValue: after.value },
  };
  fs.writeFileSync(path.join(OUT, 'chat-typing-summary.json'), JSON.stringify(summary, null, 2));
  console.log('[chat-typing] ' + JSON.stringify(summary));
  try { await exT(`await call('stop')`, 15000); } catch {}
  await WAIT(1000);
  app.exit(0);
}
