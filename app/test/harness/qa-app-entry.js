'use strict';
/*
 * QA app entry (t_490eeee8): boots the REAL app (src/main.js) in TEST_MODE for the kill -9 /
 * relaunch integration test, then reports through a state file so the test process needs no
 * CDP or socket. QA_STAGE drives it:
 *   seed   — provisions a throwaway project, one agent whose runtime is the synthetic
 *            stream-cli stub, one ready task, and starts the orchestrator; the stub run is
 *            what gets orphaned when the test SIGKILLs this app.
 *   verify — second instance on the SAME data root AND userData (so the renderer lands back
 *            on the seeded project, exactly like a real relaunch): waits for the unclean-exit
 *            recovery banner (t_6911ba60) to settle and reports its DOM state, then quits
 *            cleanly so the next boot finds a clean-exit stamp.
 * Isolation mirrors test/perf/click-latency.js: own AGENTS_SQUAD_PROJECT root, own userData,
 * no single-instance lock, no self-update watcher, force-exit backstop, procguard on children.
 */
const fs = require('fs');
const path = require('path');

const stage = process.env.QA_STAGE || 'seed';
const stateFile = process.env.QA_STATE_FILE;
if (!stateFile || !process.env.QA_DATA_ROOT) { console.error(`qa-entry: QA_STAGE/QA_STATE_FILE/QA_DATA_ROOT required (stage=${stage})`); process.exit(2); }
const root = process.env.QA_DATA_ROOT;

process.env.AGENTS_SQUAD_PROJECT = root; // isolated store root, beats any inherited value
process.env.AGENTS_SQUAD_DEV = '0'; // no UpdateWatcher polling the shared repo inside the test app
process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS = String(Number(process.env.QA_TEST_TIMEOUT_MS) || 120000);
process.env.AGENTS_SQUAD_SMOKE = '1'; // TEST_MODE: isolated root, lock skipped, child procguard
if (stage === 'seed') { // the stub must outlive the app until the watchdog reaps it
  process.env.STREAM_SECONDS = process.env.STREAM_SECONDS || '300';
  process.env.STREAM_EPS = process.env.STREAM_EPS || '0.5';
}

const { app } = require('electron');
require(path.join(__dirname, '..', '..', 'src', 'main.js')); // TEST_MODE isolates userData too
delete process.env.AGENTS_SQUAD_SMOKE; // built-in smoke/guiE2E scenarios must not run

const fail = (e) => {
  try { fs.writeFileSync(stateFile + '.err', String((e && e.stack) || e)); } catch {}
  app.exit(1);
};
const writeState = (obj) => fs.writeFileSync(stateFile, JSON.stringify(obj));

let handled = false;
app.on('web-contents-created', (_e, wc) => {
  wc.setBackgroundThrottling(false);
  wc.on('did-finish-load', async () => {
    if (handled) return; // the main window only
    handled = true;
    const ex = (js) => wc.executeJavaScript(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); ${js} })()`);
    try {
      for (let t = 0; t < 80 && !(await ex(`return typeof call === 'function' && typeof S !== 'undefined' && typeof ctx !== 'undefined'`).catch(() => false)); t++) {
        await new Promise((r) => setTimeout(r, 100)); // renderer globals ready
      }
      if (stage === 'seed') {
        const res = await ex(`
          const p = await call('createProject', 'QA kill -9 relaunch');
          switchTo({ p: p.id }); await w(400); await refresh();
          await call('saveSettings', { claudePath: ${JSON.stringify(process.env.QA_STUB)}, useWorktrees: false, maxConcurrency: 2, maxRuns: 4 });
          const node = await call('addNode', { name: 'Qa-1', role: 'Dev', x: 120, y: 120, runtime: 'claude', model: 'perf-1' });
          await call('createTask', { title: 'QA kill target', description: 'Streaming when the app is killed', assignee: node.id });
          await call('run');
          return { project: ctx.p, dir: S.dir };
        `);
        writeState({ pid: process.pid, ...res });
        // stay alive: the test SIGKILLs this pid while the stub run is streaming
      } else if (stage === 'verify') {
        // The killed instance's localStorage may not have flushed, so the renderer can boot onto
        // a fresh default project — switch to the seeded one explicitly (a project switch re-runs
        // syncRecovery, t_6911ba60) and poll the banner DOM: calling the API directly would
        // bypass the ctx.p the real banner flow uses.
        let swErr = null;
        if (process.env.QA_PROJECT) {
          swErr = await ex(`try { await switchTo({ p: ${JSON.stringify(process.env.QA_PROJECT)} }); await w(700); await refresh(); return null; } catch (e) { return String(e && e.message || e); }`).catch((e) => String(e));
        }
        let banner = null;
        for (let i = 0; i < 100; i++) {
          banner = await ex(`const b = document.querySelector('#recoverybar'); let d = null, derr = null; try { d = await call('getLastExit'); } catch (e) { derr = String(e && e.message || e); }
            return { ctxp: (typeof ctx !== 'undefined' && ctx.p) || null, b: b ? { hidden: b.classList.contains('hidden'), html: b.innerHTML } : null, d, derr,
              dismissed: (typeof recDismissed !== 'undefined') ? [...recDismissed] : null };`).catch((e) => ({ derr: String(e) }));
          const b = banner && banner.b;
          // The boot-time banner may still show the throwaway default project (its heartbeat is
          // unclean too) — only the seeded project's banner names the planted task.
          if (b && !b.hidden && (!process.env.QA_TASK_TITLE || (b.html || '').includes(process.env.QA_TASK_TITLE))) { banner = b; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        writeState({ pid: process.pid, ctxp: banner && banner.ctxp, switchError: swErr, banner: (banner && banner.b) || banner, api: banner && { d: banner.d, derr: banner.derr, dismissed: banner.dismissed } });
        app.quit(); // clean exit: will-quit stamps cleanExitAt for the no-banner assertion
      }
    } catch (e) { fail(e); }
  });
});
