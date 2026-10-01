const { app, BrowserWindow, ipcMain, Notification, nativeTheme } = require('electron');
const path = require('path');
// Test instances (gui-e2e / smoke) must never leave fake-CLI children behind: install procguard
// before the orchestrator loads so every spawn it makes is tracked and reaped (t_92c31037).
const procguard = (process.env.AGENTS_SQUAD_GUI_E2E || process.env.AGENTS_SQUAD_SMOKE) ? require('../test/harness/procguard').install() : null;
const { Orchestrator, reapRunPids, interruptedFromReap } = require('./orchestrator');
const BS = require('./bootstate');
const { ProjectManager, TEMPLATES, isolateTestRoot } = require('./projects');
const { BoardCache } = require('./board-cache');
const { DeltaPump } = require('./delta-pump');
const { pickChanged } = require('./store');
const AC = require('./agent-config');
const WT = require('./worktree');
const U = require('./usage');
const PF = require('./preflight');
const RT = require('./runtimes');
const CAP = require('./capabilities');
const SU = require('./self-update');
const { allowReload } = require('./renderer-reload');
const { applyAnsweredChange } = require('./team-answers');
const { introspectRuntime: runIntrospectRuntime } = require('./introspector');
// The app repo (main checkout): what the UpdateWatcher polls and fast-forwards.
const APP_ROOT = path.join(__dirname, '..', '..');
// The commit this app process launched on (t_7426095a): the self-update same-commit skip compares
// the restart target against it. Captured once here — before any watcher/orchestrator exists, so
// no auto-merge can have landed yet. Null (git failed) makes the watcher fall back to restarting.
const BOOT_SHA = (() => {
  try {
    const r = require('child_process').spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '').trim() || null : null;
  } catch { return null; }
})();
// Self-update (auto-restart on new merged code) is a developer/dogfood feature: only unpackaged
// runs (electron .) get it. A packaged build — real users — never starts a watcher and shows no
// update UI; AGENTS_SQUAD_DEV=1 opts a packaged build back into dogfood mode, =0 forces it off
// from source (e.g. to check the gated-off UX). Exported so agents' MCP servers inherit the gate.
const DEV_MODE = process.env.AGENTS_SQUAD_DEV ? process.env.AGENTS_SQUAD_DEV !== '0' : !app.isPackaged;
if (DEV_MODE) process.env.AGENTS_SQUAD_DEV = '1';
let runtimesCache = null; // detected once per app start (binary + version)
const runtimes = (settings) => (runtimesCache ||= RT.detectRuntimes(settings, { ...process.env, PATH: [process.env.PATH, require('os').homedir() + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(':') }));

// Test instances (gui-e2e / smoke) must never touch real data and never linger: an inherited
// AGENTS_SQUAD_HOME (the live app's root) loses to an explicit AGENTS_SQUAD_PROJECT, with neither
// set a throwaway temp root is created, and the whole run is bounded by a force-exit watchdog.
const TEST_MODE = !!(process.env.AGENTS_SQUAD_GUI_E2E || process.env.AGENTS_SQUAD_SMOKE);
if (TEST_MODE) {
  const testRoot = isolateTestRoot();
  // Own userData too (t_490eeee8 harness-isolation audit): the default path is shared with the
  // live app, so a test renderer would read the live localStorage ctx AND write its own over it.
  app.setPath('userData', path.join(testRoot, 'userData'));
  console.log(`[agents-squad] test instance pid=${process.pid} data root=${testRoot}`);
  const timeoutMs = Number(process.env.AGENTS_SQUAD_TEST_TIMEOUT_MS) || 30 * 60 * 1000;
  setTimeout(() => { console.error(`[agents-squad] test instance exceeded ${timeoutMs} ms — force exit (pid ${process.pid}, data root ${testRoot})`); procguard.reapAll(); app.exit(1); }, timeoutMs);
}

// Single instance (live profile): a second launch must focus the running window, not fork a second
// orchestrator stack over the same store. Test/gate instances skip the lock: they run with an
// isolated data root and must start alongside the live app and each other.
let appLockHeld = TEST_MODE || app.requestSingleInstanceLock();
if (!appLockHeld) {
  console.log('[agents-squad] another instance is already running — focusing it and exiting');
  app.quit();
} else if (!TEST_MODE) {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    else if (BrowserWindow.getAllWindows().length === 0) createWindow(); // window was closed, app kept running
  });
}
// A safe restart (scheduled restart / self-update) must REPLACE the window: the relaunched instance
// is spawned as this process tears down and could otherwise see the dying lock, take the
// "another instance" exit, and leave no window at all — release the lock up front.
function relaunchApp() {
  try { markCleanExits(); } catch {} // app.exit() skips 'will-quit': stamp the breadcrumbs clean or the relaunch reads as a silent death
  try { if (!TEST_MODE && appLockHeld) app.releaseSingleInstanceLock(); } catch {}
  app.relaunch();
  app.exit(0);
}

const pm = new ProjectManager(undefined, { devMode: DEV_MODE });
const orchs = new Map(); // projectId -> Orchestrator (projects run independently / concurrently)
// Unclean-exit recovery (t_2ca99830): at boot the heartbeat breadcrumb (bootstate.js) tells us
// whether the previous instance died without notice; its orphaned run groups are reaped by
// recorded pid (t_3f830e64 — never by name) and the interrupted tasks get a system comment.
// The result is exposed to the renderer via getLastExit for the recovery banner (Uma, t_6911ba60).
const lastExits = new Map(); // projectId -> { unclean, lastAliveAt, lastAlivePid, reaped, interruptedTasks }
function bootRecovery(projectId) {
  if (lastExits.has(projectId)) return lastExits.get(projectId);
  const store = pm.store(projectId);
  let prev = null; try { prev = BS.detectUnclean(store.dir); } catch {}
  const reapOut = { killed: [], skipped: [] };
  try { if (appLockHeld) Object.assign(reapOut, reapRunPids(store.dir)); } catch {}
  let marked = [];
  try { if (reapOut.killed.length) marked = interruptedFromReap(store, reapOut.killed); } catch {}
  const info = {
    unclean: !!prev,
    lastAliveAt: prev && prev.at,
    lastAlivePid: prev && prev.pid,
    reaped: reapOut.killed,
    interruptedTasks: marked.map((m) => m.taskId),
  };
  lastExits.set(projectId, info);
  if (prev && appLockHeld) {
    try {
      store.appendLog({ at: Date.now(), nodeId: null, kind: 'system', text: `previous app instance (pid ${prev.pid}) died without a clean exit — last heartbeat ${new Date(prev.at).toISOString()}; reaped ${reapOut.killed.length} orphan run group(s)${info.interruptedTasks.length ? `; interrupted: ${info.interruptedTasks.join(', ')}` : ''}` });
    } catch {}
  }
  return info;
}
function orchFor(pid) {
  let o = orchs.get(pid);
  if (!o) {
    o = new Orchestrator(pm.store(pid), { repoDir: APP_ROOT, devMode: DEV_MODE });
    o.on('log', (l) => send('log', { ...l, projectId: pid }));
    o.on('state', (s) => send('state', { ...s, projectId: pid })); // slim: the renderer refreshes from the store on receipt
    o.on('notify', (n) => { send('notify', { ...n, projectId: pid }); notify(n, pid); });
    o.on('woken_by_message', (w) => send('woken_by_message', { ...w, projectId: pid }));
    o.on('run.stalled', (e) => send('run-stalled', { ...e, projectId: pid }));
    o.on('run.recovering', (e) => send('run-recovering', { ...e, projectId: pid }));
    o.on('run.recovery_failed', (e) => send('run-recovery-failed', { ...e, projectId: pid }));
    o.on('watch-status', (w) => send('watch-status', { ...w, projectId: pid }));
    o.on('restart-state', (r) => send('restart-state', { ...r, projectId: pid }));
    // Runtime breaker (t_419062e2): banner push + clear, consumed by Uma's syncRtu (t_d33685f3).
    o.on('runtime.unavailable', (e) => send('runtime-unavailable', { ...e, projectId: pid }));
    o.on('runtime.available', (e) => send('runtime-available', { ...e, projectId: pid }));
    // Scheduled restarts fire through the watcher's drain/test/relaunch flow (watcherFor lazily
    // creates it; in non-dev builds it answers the no-op stub and the schedule just stays armed).
    o.updater = watcherFor(pid);
    bootRecovery(pid); // heartbeat check + orphan reap + interrupted-task comments (once per project)
    orchs.set(pid, o);
    pumpFor(pid).attachOrch(o); // the pump's orch deltas feed the same 'state' payload (t_39bf39ac)
  }
  return o;
}
// IPC deltas (t_39bf39ac, perf track 2): one pump per project pushes {type,id,patch} batches on the
// 'delta' channel — board-cache change events for tasks/wiki, the orchestrator 'state' snapshot, and
// sig-checked messages/inbox/runs — so the renderer stops re-pulling sections on every state event.
const pumps = new Map(); // projectId -> DeltaPump
function pumpFor(pid) {
  let p = pumps.get(pid);
  if (!p) {
    p = new DeltaPump({ projectId: pid, store: pm.store(pid), cache: BoardCache.forStore(pm.store(pid)), orch: () => orchs.get(pid) || null, send: (payload) => send('delta', payload) });
    pumps.set(pid, p);
  }
  return p;
}
// Self-update: one UpdateWatcher per project (polls the repo, safe restart + resume; see self-update.js).
const watchers = new Map(); // projectId -> UpdateWatcher
// Outside dev mode there is no watcher at all: status answers a flat "off" and restart requests no-op.
const updDisabled = () => ({ phase: 'idle', enabled: false, devMode: false, waitingOn: 0, history: [] });
function watcherFor(pid) {
  if (!DEV_MODE) return { status: () => updDisabled(), restartNow() {} };
  let w = watchers.get(pid);
  if (!w) {
    const store = pm.store(pid);
    w = new SU.UpdateWatcher({
      // git runs at the repo root; npm (build/test) in the package dir (app/).
      store, repoDir: APP_ROOT, npmDir: path.join(__dirname, '..'),
      bootSha: BOOT_SHA,
      relaunch: relaunchApp,
      procCount: () => (orchs.get(pid) || { procs: new Map() }).procs.size,
      runActive: () => (orchs.get(pid) || {}).running || false,
      // Drain deadline hit: stop the still-running agents so the restart can proceed; their tasks
      // re-dispatch after the relaunch (reconcileOrphanedTasks), the Run resumes via wasRunning.
      haltProcs: () => (orchs.get(pid) || { haltProcs: () => Promise.resolve() }).haltProcs(),
      // Unpausing after an aborted update must re-tick: the drain held the run session open with
      // nothing dispatched, so only this nudge resumes dispatching. A drain-deadline cut marks the
      // killed runs per node (drainCutNodes); if the update then aborts, those markers must go with
      // the pause or every subsequent run of the affected agents would break instantly at its first
      // iteration.
      setPaused: (v) => { const o = orchs.get(pid); if (o) { o.dispatchPaused = v; if (!v) { o.clearDrainCuts(); setImmediate(() => o.tick()); } } },
    });
    w.on('log', (l) => send('log', { ...l, projectId: pid }));
    w.on('status', (st) => send('self-update-status', { projectId: pid, ...st }));
    watchers.set(pid, w);
  }
  return w;
}
// Startup sweep: any node still showing "not probed yet" (added before capability probing existed, imported
// from another machine, etc.) gets probed lazily — one setImmediate tick per node so a slow/missing CLI binary
// never blocks app start or other nodes' probes. Best-effort: a probe failure just leaves the node unprobed for
// next time (manual Refresh, or the next run's init event via orchestrator.js).
function probeNodeLater(pid, node) {
  if (!CAP.needsInitialProbe(node)) { healStaleModes(pid, node); return; }
  setImmediate(() => {
    try {
      const s = pm.store(pid, node.teamId || null);
      const rt = RT.getRuntime(node.runtime);
      const capabilities = CAP.discoverCapabilities(rt, s.getSettings());
      s.updateNode(node.id, { capabilities, capabilitiesProbedAt: capabilities.probedAt });
    } catch {}
  });
}
// An init-event snapshot captured before modes/categorized were derived from slashCommands (or with a Refresh
// that copied a stale [] snapshot as-is — the bug this heals) can persist with real slash_commands like /goal,
// /loop but modes: [] / an out-of-date categorized list. Recompute both from the snapshot's own slashCommands +
// skills so the panel heals on the next app load without requiring a manual Refresh.
function healStaleModes(pid, node) {
  const cap = node.capabilities;
  if (!cap || cap.source !== 'init-event' || !Array.isArray(cap.slashCommands)) return;
  setImmediate(() => {
    try {
      const s = pm.store(pid, node.teamId || null);
      const settings = s.getSettings();
      const mcpServers = Object.keys((settings.mcpServers && typeof settings.mcpServers === 'object') ? settings.mcpServers : {});
      const modes = [...new Set([...CAP.detectAppModes('', cap.slashCommands), ...(cap.modes || [])])];
      const categorized = CAP.categorize({ modes, skills: cap.skills, slashCommands: cap.slashCommands, mcpServers });
      if (modes.length === (cap.modes || []).length && categorized.length === (cap.categorized || []).length) return;
      s.updateNode(node.id, { capabilities: { ...cap, modes, categorized } });
    } catch {}
  });
}
function probeUnprobedAgents(pid) {
  for (const p of pid ? [{ id: pid }] : pm.list()) {
    let nodes = []; try { nodes = pm.store(p.id).getTeam().nodes; } catch { continue; }
    for (const node of nodes) probeNodeLater(p.id, node);
  }
}
let win;
// Desktop notification (approval needed, budget reached, run finished) when the window is not focused.
function notify(n, pid) {
  if (process.env.AGENTS_SQUAD_GUI_E2E || process.env.AGENTS_SQUAD_SMOKE || (win && !win.isDestroyed() && win.isFocused())) return;
  try { if (!Notification.isSupported() || (ST({ p: pid }).getSettings().notifications === false)) return; const p = pm.get(pid); new Notification({ title: `${n.title}${p ? ' · ' + p.name : ''}`, body: n.body || '' }).show(); } catch {}
}

// Autorun: act like the human in the real UI (select project, type goal, press Run). File: {"project": name, "goal": text}.
async function autorun(file) {
  const { project, goal } = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const p = pm.list().find((x) => x.name === project); if (!p) return console.error('[autorun] no project', project);
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  await w(800);
  await win.webContents.executeJavaScript(`document.querySelector('#projectlist div[data-pid="${p.id}"]').click()`); await w(1200);
  await win.webContents.executeJavaScript(`document.querySelector('#tabs button[data-tab=team]').click(); document.querySelector('#testteam').click()`);
  for (let i = 0; i < 90; i++) { await w(2000); const t = await win.webContents.executeJavaScript(`document.querySelector('#pf-summary').textContent`); if (!/testing|untested/.test(t)) { console.log('[autorun] preflight:', t); break; } }
  await win.webContents.executeJavaScript(`(() => { const g = document.querySelector('#goal'); g.value = ${JSON.stringify(goal)}; document.querySelector('#run').click(); })()`);
  console.log('[autorun] started', p.name);
  orchFor(p.id).once('done', () => console.log('[autorun] done', p.name));
}

// App-wide UI prefs (theme: 'system' | 'light' | 'dark') persisted in <root>/prefs.json.
const fs = require('fs');
const prefsFile = () => path.join(pm.root, 'prefs.json');
function getPrefs() { try { return { theme: 'system', ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { return { theme: 'system' }; } }
function setPrefs(patch) { const next = { ...getPrefs(), ...patch }; fs.mkdirSync(pm.root, { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2)); applyTheme(next.theme); return next; }
// Window background matches design/tokens.css --bg-app so there's no flash before CSS loads.
const BG = { light: '#f4f5f8', dark: '#0f1116' };
function applyTheme(theme) {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
  if (win && !win.isDestroyed()) win.setBackgroundColor(BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']);
}

function createWindow() {
  const theme = getPrefs().theme; nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
  const mac = process.platform === 'darwin';
  if (mac) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  win = new BrowserWindow({ width: 1400, height: 900, title: 'Colvari', icon: path.join(__dirname, '..', 'build', 'icon.png'), backgroundColor: BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'],
    ...(mac ? { titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', visualEffectState: 'followWindow' } : { titleBarStyle: 'hidden', titleBarOverlay: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('[renderer]', message); });
  win.webContents.on('did-finish-load', async () => {
    console.log('[agents-squad] renderer loaded');
    if (process.env.AGENTS_SQUAD_GUI_E2E) return guiE2E();
    if (process.env.AGENTS_SQUAD_AUTORUN) return autorun(process.env.AGENTS_SQUAD_AUTORUN);
    if (!process.env.AGENTS_SQUAD_SMOKE) return;
    // UI smoke test: add two agents, create a task, check the DOM, then quit.
    const js = `(async () => { const w = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#addnode').click(); await w(300); document.querySelector('#addnode').click(); await w(300);
      document.querySelector('#nt-title').value = 'Smoke goal'; document.querySelector('#nt-add').click(); await w(400);
      return { nodes: document.querySelectorAll('#graph .node').length, cards: document.querySelectorAll('.card').length, agentsRows: document.querySelectorAll('#agenttable tr').length }; })()`;
    try { console.log('[smoke]', JSON.stringify(await win.webContents.executeJavaScript(js))); } catch (e) { console.error('[smoke] failed', e); }
    if (procguard) procguard.reapAll();
    app.exit(0);
  });
  // A killed renderer (e.g. a stray pkill hitting helper processes) must not leave a dead window:
  // reload it, rate-limited so a crash loop cannot spin (clean exit means the user closed it).
  const rendererReloads = [];
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[agents-squad] renderer gone', d.reason);
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    if (allowReload(rendererReloads, Date.now())) win.webContents.reload();
    else console.error('[agents-squad] renderer reload rate-limited');
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}
// GUI e2e: drive the real UI with clicks, run a PM -> Dev team, screenshot each tab.
async function guiE2E() {
  const out = process.env.AGENTS_SQUAD_GUI_E2E; const fs = require('fs');
  win.webContents.setBackgroundThrottling(false); // occluded windows composite rarely; shots would be stale
  const ex = (js) => win.webContents.executeJavaScript(`(async () => { const w = (ms) => new Promise(r => setTimeout(r, ms)); const $ = (s) => document.querySelector(s); ${js} })()`);
  const shot = async (name) => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage()).toPNG());
  const click = async (sel) => { const r = await ex(`const b = $('${sel}').getBoundingClientRect(); return [b.x + 20, b.y + 20];`); for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(r[0]), y: Math.round(r[1]), button: 'left', clickCount: 1 }); await new Promise((r) => setTimeout(r, 400)); };
  const pid = () => pm.list()[0].id; const store = pm.store(pid()); const orch = orchFor(pid());
  // Every check is asserted: a failed expectation makes gui-e2e exit 1 (it used to only log).
  const failures = []; const expect = (name, ok, info) => { if (!ok) { failures.push(name); console.error('[gui-e2e] CHECK FAILED:', name, info === undefined ? '' : JSON.stringify(info)); } };
  const waitFor = async (js, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ex(js)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
  // Overview screenshots (idle, active, stuck) from injected renderer state; no claude runs needed.
  const overviewShots = async () => {
    // Seed into whatever project/team the renderer is showing (earlier steps may have switched it).
    await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (nodes.length < 2) { ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ps.getTeam().nodes; }
    const [a, b] = nodes; if (!ps.getTeam().edges.some((e) => e.from === a.id && e.to === b.id)) ps.addEdge(a.id, b.id, 'assign');
    const t = ps.createTask({ title: 'Overview demo', assignee: b.id }); ps.commentTask(t.id, a.id, 'Please build the overview.');
    await ex(`$('#tabs button[data-tab=overview]').click(); await w(800);`);
    await ex(`await refresh(); S.orch.agents = {}; renderOverview(); await w(300);`); await shot('11-overview-idle');
    const L = (ago, nodeId, kind, text) => `logs.push({ projectId: ctx.p, nodeId: '${nodeId}', kind: '${kind}', text: ${JSON.stringify(text)}, at: Date.now() - ${ago} });`;
    await ex(`${L(240000, a.id, 'system', '▶ Pia starts "Goal" in /x')}${L(200000, a.id, 'tool', 'mcp__board__create_task {"title":"Overview demo","assignee":"' + b.id + '"}')}${L(150000, a.id, 'tool', 'mcp__board__update_task_status {"status":"done"}')}${L(120000, a.id, 'result', 'success cost=$0 turns=3')}
      ${L(3000, a.id, 'tool', 'mcp__board__send_message {"to":"' + b.id + '","text":"ping"}')}${L(100000, b.id, 'system', '▶ Devon starts "Overview demo" in /x')}${L(60000, b.id, 'tool', 'Write {"file_path":"src/overview.js"}')}${L(2000, b.id, 'tool', 'Bash {"command":"npm test"}')}
      await w(600); S.orch.agents = { '${b.id}': { status: 'working', taskId: '${t.id}' } }; $('#ov-task').value = '${t.id}'; renderOverview();`);
    // Checks inject orch state right before asserting: a background refresh() replaces S (and S.orch) at any time.
    expect('overview: working node glows', await ex(`S.orch.agents = { '${b.id}': { status: 'working', taskId: '${t.id}' } }; renderOverview(); return !!document.querySelector('#ov-graph .node.working')`));
    await shot('12-overview-active');
    expect('overview: timeline lanes and thread chips', await ex(`return document.querySelectorAll('#ov-timeline .run').length >= 2 && document.querySelectorAll('#ov-thread .chip').length >= 1`));
    await ex(`for (const l of logs) if (l.nodeId === '${b.id}') l.at -= 300000; await w(1500);`);
    expect('overview: stuck badge with Stop and Nudge', await ex(`S.settings.stuckMinutes = 1; S.orch.agents = { '${b.id}': { status: 'working', startedAt: Date.now() - 600000 } }; renderOverview(); return !!document.querySelector('#ov-graph .node.stuck') && !!document.querySelector('[data-ovstop]') && !!document.querySelector('[data-ovnudge]')`));
    await shot('13-overview-stuck');
  };
  // First-run guide (steps 1-3) in a fresh project, then Human Inbox: ask_human with choices, answer, approval item.
  const firstrunInbox = async () => {
    const fp = pm.create('First run'); const fstore = pm.store(fp.id); const forch = orchFor(fp.id);
    const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'squad-fr-'));
    const origPick = api.pickDir; api.pickDir = async () => work;
    await ex(`window.confirm = () => true; $('#tabs button[data-tab=team]').click(); P = await call('listProjects'); renderSidebar(); document.querySelector('#projectlist [data-pid="${fp.id}"]').click(); await w(800); $('#reopenguide').click(); await w(300);`);
    const guideShown = await ex(`return !$('#guide').classList.contains('hidden') && !!$('#g-team')`);
    await ex(`$('#g-dir').click(); await w(600);`); api.pickDir = origPick;
    const dirShown = await ex(`return $('#guide').textContent.includes(${JSON.stringify(work)})`);
    await shot('14-firstrun-1');
    await ex(`$('#g-team').click();`);
    const tested = await waitFor(`return document.querySelectorAll('#guide li').length === 3 && !!$('#g-test') && !$('#g-test').disabled`, 180000);
    await shot('14-firstrun-2');
    const fn = fstore.getTeam(); const dev = fn.nodes.find((n) => n.role === 'Dev') || {};
    await ex(`$('#g-goal').value = ${JSON.stringify('Write the chosen color into color.txt. PM: delegate this to the Dev. Dev: before writing, you MUST call the ask_human tool with question "Which color?" and choices ["red","blue"], then write exactly the answer into color.txt in the working directory.')}; await w(200);`);
    await shot('14-firstrun-3');
    await ex(`$('#g-start').click(); await w(1500);`);
    const fr = { guideShown, dirShown, nodes: fn.nodes.map((n) => n.role), edges: fn.edges.length, workdirs: fn.nodes.every((n) => n.workdir === work), tested, preflight: fstore.getTeam().nodes.map((n) => n.preflight && n.preflight.ok),
      started: forch.running || forch.runs > 0, guideHiddenAfterStart: await ex(`return $('#guide').classList.contains('hidden')`) };
    console.log('[gui-e2e] firstrun', JSON.stringify(fr));
    expect('first-run guide: steps 1-3 through to the first goal', guideShown && dirShown && fr.nodes.length === 3 && fr.edges === 2 && fr.workdirs && tested && fr.started, fr);
    // (b) the Dev asks the human; badge, Inbox item, answer through the UI.
    let q = null; for (let i = 0; i < 150 && !q; i++) { await new Promise((r) => setTimeout(r, 2000)); q = fstore.listInbox({ status: 'open' }).find((x) => x.kind === 'question'); }
    const ib = { asked: !!q, question: q && q.question, choices: q && q.choices, taskStatus: q && q.taskId && fstore.getTask(q.taskId).status };
    ib.badge = await ex(`await refresh(); return $('#inbox-tab-badge').textContent`);
    await ex(`$('#sb-inbox').click(); await w(400);`); await shot('15-inbox-question');
    ib.clicked = await ex(`const b = [...document.querySelectorAll('.ib-choice')].find((x) => x.dataset.v === 'blue'); if (!b) return false; b.click(); await w(800); return true;`);
    ib.statusAfterAnswer = q && q.taskId && fstore.getTask(q.taskId).status; ib.answer = q && fstore.getInboxItem(q.id).answer;
    await shot('15-inbox-answered');
    // The run idles at drain now (t_b2273507) — "not running" is no longer an end marker; wait for
    // the artifact the resumed run was asked to write.
    for (let i = 0; i < 150; i++) { if (fs.existsSync(path.join(work, 'color.txt'))) break; await new Promise((r) => setTimeout(r, 2000)); }
    ib.color = fs.existsSync(path.join(work, 'color.txt')) ? fs.readFileSync(path.join(work, 'color.txt'), 'utf8').trim() : null;
    ib.badgeAfter = await ex(`await refresh(); return $('#inbox-tab-badge').textContent`);
    // (c) an approval request (requireApproval puts finished tasks in review + awaitingApproval) shows in the Inbox.
    const at = fstore.createTask({ title: 'Ship first run', assignee: dev.id }); fstore.updateTask(at.id, { status: 'review', awaitingApproval: true });
    ib.approvalShown = await ex(`await refresh(); await w(300); return [...document.querySelectorAll('.inboxitem')].some((d) => d.textContent.includes('Ship first run') && d.querySelector('.ib-choice[data-v=approve]'))`);
    await shot('16-inbox-approval');
    await ex(`[...document.querySelectorAll('.inboxitem')].find((d) => d.textContent.includes('Ship first run')).querySelector('.ib-choice').click(); await w(800);`);
    ib.approvedStatus = fstore.getTask(at.id).status;
    console.log('[gui-e2e] inbox', JSON.stringify(ib));
    expect('inbox: ask_human item with choices, badge 1, task waiting', ib.asked && (ib.choices || []).includes('blue') && ib.badge === '1' && ib.taskStatus === 'waiting_for_human', ib);
    expect('inbox: answered through the UI, task back to in_progress', ib.clicked && ib.answer === 'blue' && ib.statusAfterAnswer === 'in_progress', ib);
    expect('inbox: agent output uses the answer', ib.color === 'blue', ib);
    expect('inbox: approval item shown and approved', ib.approvalShown && ib.approvedStatus === 'done', ib);
  };
  // Chat view (shots 17-20) from injected state: room with bubbles + chips + inline question, thread pane, working indicator, @mention -> task.
  const chatShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (nodes.length < 2) { ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ps.getTeam().nodes; }
    const [a, b] = nodes; const t = ps.createTask({ title: 'Chat demo', assignee: b.id, createdBy: a.id });
    ps.commentTask(t.id, b.id, 'On it.');
    const q = ps.addInbox({ kind: 'question', taskId: t.id, nodeId: b.id, question: 'Dark or light theme?', choices: ['dark', 'light'] });
    const L = (ago, nodeId, kind, text) => `logs.push({ projectId: ctx.p, nodeId: '${nodeId}', kind: '${kind}', text: ${JSON.stringify(text)}, at: Date.now() - ${ago} });`;
    await ex(`$('#tabs button[data-tab=chat]').click(); ${L(90000, b.id, 'system', '▶ ' + b.name + ' starts "Chat demo" in /x')}${L(80000, b.id, 'text', 'I will add a chat view with bubbles and tool chips.')}
      ${L(70000, b.id, 'tool', 'Read {"file_path":"renderer/app.js"}')}${L(69000, b.id, 'tool_result', '587 lines')}${L(60000, b.id, 'tool', 'Bash {"command":"npm test"}')}${L(59000, b.id, 'tool_result', 'pass 78 fail 0')}
      await refresh(); chatSig = null; renderChat(); await w(300); document.querySelector('#chat-room .cchip').open = true; await w(200);`);
    const room = await ex(`return { groups: document.querySelectorAll('#chat-room .cgroup').length, avatars: document.querySelectorAll('#chat-room .avatar').length, chips: document.querySelectorAll('#chat-room .cchip').length, question: !!document.querySelector('#chat-room .bubble.question .ch-choice'), roles: document.querySelectorAll('#chat-room .role').length, defaultTab: !!$('#tabs button[data-tab=chat]') && TABS[0] === 'chat' }`);
    expect('chat: room with bubbles, avatars, role badges, tool chips, inline question', room.groups >= 2 && room.chips >= 2 && room.question && room.roles >= 2 && room.defaultTab, room);
    await ex(`await refresh(); chatSig = null; renderChat(); document.querySelector('#chat-room .cchip').open = true; await w(200);`); await shot('17-chat-room');
    await ex(`document.documentElement.dataset.theme = 'dark'; await w(200);`); await shot('17b-chat-room-dark'); await ex(`document.documentElement.dataset.theme = 'light'; await w(100);`);
    await ex(`document.querySelector('#chat-room [data-thread="${t.id}"]').click(); await w(300);`);
    const th = await ex(`return { open: !$('#chat-thread').classList.contains('hidden'), title: $('#chat-thread .chat-head').textContent, items: document.querySelectorAll('#chat-threadroom .bubble, #chat-threadroom .cchip').length }`);
    expect('chat: thread pane shows the task', th.open && th.title.includes('Chat demo') && th.items >= 3, th);
    await shot('18-chat-thread');
    // Sent here, not earlier: an unread teammate message schedules a real wake run for b, which
    // would race the synthetic working state below (seen live: the pill flipped to "Stopped (1
    // todo)" mid-check). The thread pane below still needs the message.
    ps.sendMessage({ from: a.id, to: b.id, text: 'Please keep it vanilla JS.', taskId: t.id });
    // runState rides the seed (t_ac25444e pill contract): running and runState.state==='running'
    // always co-occur in real snapshots, so the synthetic state must carry both. Seed and read in
    // ONE evaluation so no tick or wake can interleave between seeding and reading.
    const seedWorking = `S.orch = { ...S.orch, running: true, runState: { state: 'running' }, runs: 1, agents: { '${b.id}': { status: 'working', taskId: '${t.id}' } } }; renderHeader(); chatSig = null; renderChat();`;
    await ex(`window._refresh = refresh; refresh = async () => {}; if (!$('#tab-chat.active')) $('#tabs button[data-tab=chat]').click();`);
    // Re-seed on every read (idempotent): a stray render tick can repaint the room between
    // seeding and reading, so each sample re-asserts the synthetic state before measuring it.
    const seedRead = `${seedWorking} await w(50); return { typing: $('#chat-typing').textContent, header: $('#runstate').textContent, dot: !!document.querySelector('#chat-room .avatar.working') }`;
    let typing = null;
    for (let i = 0; i < 10; i++) { typing = await ex(seedRead); if (typing.typing.includes(b.name + ' is working') && /^Running \(\d+\)$/.test(typing.header) && typing.dot) break; await new Promise((r) => setTimeout(r, 300)); }
    expect('chat: working indicator (text, running header, green dot)', typing.typing.includes(b.name + ' is working') && /^Running \(\d+\)$/.test(typing.header) && typing.dot, typing);
    await shot('19-chat-working'); await ex(`refresh = window._refresh; await refresh();`);
    const origRun = api.run; api.run = () => ({ stubbed: true });
    await ex(`CH.thread = null; const i = $('#chat-input'); i.value = '@${b.name.slice(0, 2)}'; i.dispatchEvent(new Event('input')); await w(200);`);
    const mention = await ex(`return [...document.querySelectorAll('#chat-mentions div')].map((d) => d.dataset.name)`);
    await ex(`$('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); $('#chat-input').value += 'add a dark theme toggle'; $('#chat-input').dispatchEvent(new Event('input')); await w(200);`);
    const pv = await ex(`return $('#chat-preview').textContent`); await shot('20-chat-mention');
    // @Name = message to the agent, never a task (t_7c4538d9); read it back so the idle agent's
    // wake sweep cannot dispatch a real run behind the suite's back.
    await ex(`$('#chat-send').click(); await w(300);`);
    const sentMsg = ps.listMessages({ to: b.id }).find((m) => m.text === 'add a dark theme toggle');
    const noTaskYet = !ps.listTasks().some((x) => x.title === 'add a dark theme toggle');
    if (sentMsg) ps.markMessagesRead([sentMsg.id]);
    // @Name! stays the explicit task form.
    await ex(`const i = $('#chat-input'); i.value = '@${b.name}! add a dark theme toggle'; i.dispatchEvent(new Event('input')); await w(200); $('#chat-send').click(); await w(800);`); api.run = origRun;
    const made = ps.listTasks().find((x) => x.title === 'add a dark theme toggle');
    await ex(`await refresh(); chatSig = null; renderChat(); const b = [...document.querySelectorAll('#chat-room .ch-choice')].find((x) => x.dataset.v === 'dark'); b && b.click(); await w(800);`);
    const cm = { mention, preview: pv, msg: sentMsg && { from: sentMsg.from, to: sentMsg.to }, task: made && { assignee: made.assignee, createdBy: made.createdBy }, answered: ps.getInboxItem(q.id).answer };
    console.log('[gui-e2e] chat', JSON.stringify({ room, thread: th, typing, ...cm }));
    expect('chat: @mention autocomplete + preview + @Name sends a message (no auto task)', mention.includes(b.name) && pv.includes('message to ' + b.name) && sentMsg && sentMsg.from === 'human' && noTaskYet, cm);
    expect('chat: @Name! is the explicit task form for the agent', made && made.assignee === b.id, cm);
    expect('chat: inline answer to ask_human', cm.answered === 'dark', cm);
  };
  // Plain text in the composer = a chat message to the core agent (t_7c4538d9): 'hi' wakes the idle
  // core with the humanPrompt wording and its reply lands in the room; no task is created. Runs on
  // a fake claude so the reply is deterministic and nothing real is spawned.
  const chatMsgShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t);
    let nodes = ps.getTeam().nodes;
    if (!nodes.length) { ps.addNode({ name: 'Rhea', role: 'PM', x: 60, y: 60 }); await ex(`await refresh(); await w(300);`); }
    // The composer's "core agent" is the RENDERER's head pick — resolve it there, then look it up main-side.
    const coreId = await ex(`return (S.team.nodes.find((n) => isLeadRole(n.role)) || S.team.nodes[0] || {}).id`);
    const core = ps.getTeam().nodes.find((n) => n.id === coreId);
    expect('chatmsg: a core agent exists for the composer target', !!core, coreId);
    const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'squad-chatmsg-'));
    const argsLog = path.join(d, 'args.txt');
    const fake = path.join(d, 'fake-claude.sh');
    fs.writeFileSync(fake, '#!/bin/sh\necho "$*" >> ' + argsLog + '\necho \'{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hi! Idle and ready — nothing to create."}]}}\'\necho \'{"type":"result","subtype":"success","session_id":"sess-chatmsg","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}\'\n');
    fs.chmodSync(fake, 0o755);
    ps.saveSettings({ claudePath: fake });
    const tasksBefore = ps.listTasks().length;
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(300); const i = $('#chat-input'); i.value = 'hi there'; i.dispatchEvent(new Event('input')); await w(200);`);
    const pv = await ex(`return $('#chat-preview').textContent`);
    expect('chatmsg: plain text previews as a message to the core agent', pv === 'Will send a message to the core agent', pv);
    await shot('chatmsg-preview');
    await ex(`$('#chat-send').click(); await w(400);`);
    const msg = ps.listMessages({ to: core.id }).find((m) => m.text === 'hi there');
    expect('chatmsg: message stored from the human', !!msg && msg.from === 'human', msg || null);
    let promptArgs = null;
    for (let i = 0; i < 60 && !promptArgs; i++) { await new Promise((r) => setTimeout(r, 500)); if (fs.existsSync(argsLog)) { const c = fs.readFileSync(argsLog, 'utf8'); if (c.includes('human operator')) promptArgs = c; } }
    expect('chatmsg: idle core woken with the human wording', !!promptArgs && promptArgs.includes('hi there') && promptArgs.includes('human operator') && promptArgs.includes('create_task only for real work'), promptArgs);
    expect('chatmsg: no task auto-created', ps.listTasks().length === tasksBefore, { before: tasksBefore, now: ps.listTasks().length });
    const reply = await waitFor(`return !!document.querySelector('#chat-room') && document.querySelector('#chat-room').textContent.includes('Idle and ready')`, 20000);
    expect('chatmsg: the core reply shows in the chat room', reply);
    await shot('chatmsg-reply');
    console.log('[gui-e2e] chatmsg', JSON.stringify({ pv, msg: !!msg, woken: !!promptArgs, reply }));
  };
  // Composer clear-on-send (t_ada3fae8): the input empties the moment Send is pressed, before the
  // bridge answers; a failed send hands the draft back. Success path is real (fake CLI), failure
  // path patches orch.sendToAgent to throw.
  const composerClearShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t);
    if (!ps.getTeam().nodes.length) { ps.addNode({ name: 'Rhea', role: 'PM', x: 60, y: 60 }); await ex(`await refresh(); await w(300);`); }
    const coreId = await ex(`return (S.team.nodes.find((n) => isLeadRole(n.role)) || S.team.nodes[0] || {}).id`);
    const core = ps.getTeam().nodes.find((n) => n.id === coreId);
    expect('composerclear: a core agent exists for the composer target', !!core, coreId);
    const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'squad-ccl-'));
    const fake = path.join(d, 'fake-claude.sh');
    fs.writeFileSync(fake, '#!/bin/sh\necho "$*" >> /dev/null\necho \'{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Idle and ready — nothing to create."}]}}\'\necho \'{"type":"result","subtype":"success","session_id":"sess-ccl","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":10}}\'\n');
    fs.chmodSync(fake, 0o755);
    ps.saveSettings({ claudePath: fake });
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(300); const i = $('#chat-input'); i.value = 'hi'; i.dispatchEvent(new Event('input')); await w(100);`);
    // The regression itself: the click handler's sync prefix must already have cleared the box —
    // before the fix the clear ran only after `await call(...)` answered.
    const cleared = await ex(`$('#chat-send').click(); return $('#chat-input').value`);
    expect('composerclear: input cleared the moment Send is pressed (not after the bridge answers)', cleared === '', cleared);
    await new Promise((r) => setTimeout(r, 400));
    const msg = ps.listMessages({ to: core.id }).find((m) => m.text === 'hi');
    expect('composerclear: the send still landed main-side after the clear', !!msg && msg.from === 'human', msg || null);
    await shot('composerclear-sent');
    const orch2 = orchFor(cur.p || pid()); const origSend = orch2.sendToAgent;
    orch2.sendToAgent = async () => { throw new Error('boom'); };
    const kept = await ex(`window.alert = () => {}; const i = $('#chat-input'); i.value = 'keep me'; i.dispatchEvent(new Event('input')); $('#chat-send').click(); await w(400); return i.value`);
    orch2.sendToAgent = origSend;
    expect('composerclear: failed send keeps the draft in the composer', kept === 'keep me', kept);
    await shot('composerclear-kept');
    console.log('[gui-e2e] composerclear', JSON.stringify({ cleared, sent: !!msg, kept }));
  };
  // Windowing (t_fb193107): 5k-message fixture, DOM bounded to the latest page, scroll-up prepends
  // older pages with the anchor held, auto-scroll only at the bottom. Injection-only, no real runs.
  const windowingShots = async () => {
    await ex(`window._refresh = refresh; refresh = async () => {}; // keep background refreshes from re-rendering mid-assertion
      await refresh(); S.allNodes = [{ id: 'a', name: 'Pia', role: 'PM' }, { id: 'b', name: 'Devon', role: 'Dev' }];
      S.messages = []; S.tasks = []; S.inbox = []; S.orch.agents = {}; RUNS = [];
      if (!window.__winseed) { window.__winseed = true; const N = 5000, now = Date.now();
        for (let i = 0; i < N; i++) logs.push({ projectId: ctx.p, nodeId: i % 7 ? 'b' : 'a', kind: ['text','tool','tool_result','text','text'][i % 5], text: 'line-' + i + ' windowing fixture row', at: now - (N - i) * 1000 }); }`);
    // Chat: latest page only + older bar; render time (median of 5) reported.
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(200); chatSig = null; renderChat(); await w(200);`);
    const chat = await ex(`const times = []; for (let i = 0; i < 6; i++) { chatSig = null; const t0 = performance.now(); renderChat(); times.push(performance.now() - t0); }
      return { med: Math.round([...times.slice(1)].sort((x, y) => x - y)[2] * 10) / 10, bubbles: document.querySelectorAll('#chat-room .bubble').length, nodes: document.querySelectorAll('#chat-room *').length, older: ($('#chat-older') || {}).textContent || '' }`);
    expect('chat windowing: 5k messages but DOM bounded to the latest page with an older bar', chat.bubbles > 0 && chat.bubbles <= 140 && /earlier/.test(chat.older), chat);
    // Scroll to the top: older page prepended (older count drops by one page), view anchored (not clamped at 0).
    await ex(`$('#chat-room').scrollTop = 0; await w(500);`);
    const chatUp = await ex(`return { bubbles: document.querySelectorAll('#chat-room .bubble').length, top: Math.round($('#chat-room').scrollTop), older: ($('#chat-older') || {}).textContent || '' }`);
    const olderCount = (t) => +(/(\d+)/.exec(t || '') || [])[1];
    expect('chat windowing: scroll-up loads older pages and keeps the scroll anchor', chatUp.bubbles > chat.bubbles && chatUp.top > 500 && olderCount(chat.older) - olderCount(chatUp.older) === 100, { chat, chatUp });
    // New messages while reading history: view stays put, "N new" pill appears; at the bottom it autoscrolls and the window shrinks back.
    await ex(`const now = Date.now(); for (let i = 0; i < 3; i++) logs.push({ projectId: ctx.p, nodeId: 'b', kind: 'text', text: 'fresh-' + i, at: now + i }); chatSig = null; renderChat(); await w(200);`);
    const chatKeep = await ex(`return { pill: !$('#chat-newpill').classList.contains('hidden'), top: Math.round($('#chat-room').scrollTop), bubbles: document.querySelectorAll('#chat-room .bubble').length }`);
    await ex(`$('#chat-room').scrollTop = $('#chat-room').scrollHeight; await w(500);`);
    const chatBottom = await ex(`return { pill: !$('#chat-newpill').classList.contains('hidden'), bubbles: document.querySelectorAll('#chat-room .bubble').length, atEnd: $('#chat-room').textContent.includes('fresh-2') }`);
    expect('chat windowing: history view holds with a new-pill, bottom autoscrolls and shrinks the window', chatKeep.pill && chatKeep.top > 500 && chatBottom.bubbles < chatUp.bubbles && chatBottom.atEnd && !chatBottom.pill, { chatKeep, chatBottom });
    // Logs: same bounds, older bar, agent filter still applies before windowing. Pin to the tail
    // first — background renderLogs (watcher events) may have run while the tab was hidden, leaving
    // the box at the top, and scrollTop assignments on a hidden box are no-ops (no scroll event).
    await ex(`$('#tabs button[data-tab=obs]').click(); await w(200); $('#log').scrollTop = $('#log').scrollHeight; await w(100);`);
    const log = await ex(`const times = []; for (let i = 0; i < 6; i++) { const t0 = performance.now(); renderLog(); times.push(performance.now() - t0); }
      return { med: Math.round([...times.slice(1)].sort((x, y) => x - y)[2] * 10) / 10, rows: document.querySelectorAll('#log .logrow').length, older: ($('#log-older') || {}).textContent || '' }`);
    expect('log windowing: 5k lines but at most one page rendered with an older bar', log.rows > 0 && log.rows <= 200 && /earlier/.test(log.older), log);
    await ex(`$('#log').scrollTop = 0; await w(500);`);
    const logUp = await ex(`return { rows: document.querySelectorAll('#log .logrow').length, top: Math.round($('#log').scrollTop), older: ($('#log-older') || {}).textContent || '' }`);
    expect('log windowing: scroll-up loads older lines and keeps the scroll anchor', logUp.rows > log.rows && logUp.top > 500 && /earlier/.test(logUp.older), logUp);
    // Back to the tail: the window shrinks again (bounded DOM), then the agent filter still holds.
    await ex(`$('#log').scrollTop = $('#log').scrollHeight; await w(400); $('#logfilter').innerHTML = '<option value="a">Pia</option>'; $('#logfilter').value = 'a'; renderLog(); await w(200);`);
    const logF = await ex(`return { rows: document.querySelectorAll('#log .logrow').length, agents: [...new Set([...document.querySelectorAll('#log .logrow .logagent')].map((d) => d.textContent))] }`);
    expect('log windowing: agent filter bounds the window and selects only that agent', logF.rows > 0 && logF.rows <= 200 && logF.agents.length === 1, logF);
    console.log('[gui-e2e] windowing', JSON.stringify({ chat, chatUp, chatKeep, chatBottom, log, logUp, logF }));
    // Drop the fixture so later full-run steps see clean logs, then hand refresh back.
    await ex(`for (let i = logs.length - 1; i >= 0; i--) if (/windowing fixture row|^fresh-/.test(logs[i].text)) logs.splice(i, 1);
      logWin = 200; CH.win = null; renderLog(); refresh = window._refresh; await refresh();`);
  };
  // Graph editor (shots 21-24): 12-node team, connect by mouse, cross-team edge, positions/viewport persistence.
  // Zoom/fit, context menu and auto-layout are feature-detected: checked once the UI ships them, logged as pending until then.
  const graphShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const gp = cur.p || pid(); const ps = pm.store(gp, cur.t);
    const other = pm.createTeam(gp, 'Graph peers'); const os = pm.store(gp, other.id || other); const peer = os.addNode({ name: 'Peer', role: 'Dev', x: 60, y: 60 });
    const base = ps.getTeam().nodes.length; for (let i = base; i < 12; i++) ps.addNode({ name: `G${i + 1}`, role: i ? 'Dev' : 'PM', x: 40 + (i % 4) * 200, y: 40 + Math.floor(i / 4) * 110 });
    const nodes = ps.getTeam().nodes; const [a, b] = nodes;
    const cross = ps.addEdge(a.id, peer.id, 'message');
    await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); await w(400);`);
    const g = { nodes: await ex(`return document.querySelectorAll('#graph .node').length`), crossIn: os.incomingCrossEdges().some((e) => e.id === cross.id && e.crossTeam) };
    expect('graph: 10+ node team rendered', g.nodes >= 12, g); expect('graph: cross-team edge stored and visible to target team', g.crossIn, g);
    await shot('21-graph-team');
    // Connect by mouse: Connect mode, click source then target (real input events).
    const at = (id) => ex(`const n = S.team.nodes.find((x) => x.id === '${id}'); const i = S.team.nodes.indexOf(n); const r = document.querySelectorAll('#graph .node')[i].getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];`);
    const tap = async ([x, y]) => { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); await new Promise((r) => setTimeout(r, 300)); };
    const target = nodes[5]; const before = ps.getTeam().edges.length;
    await ex(`window.alert = () => {}; $('#edgetype').value = 'review'; $('#connect').click(); await w(200);`); await tap(await at(a.id)); await tap(await at(target.id)); await ex(`await w(600);`);
    g.connected = ps.getTeam().edges.some((e) => e.from === a.id && e.to === target.id && e.type === 'review') && ps.getTeam().edges.length === before + 1;
    expect('graph: connect source -> target by mouse creates an edge', g.connected, g);
    await shot('22-graph-connected');
    // Drag moves a node and persists its position.
    const [x0, y0] = await at(b.id); win.webContents.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 5; k++) win.webContents.sendInputEvent({ type: 'mouseMove', x: x0 + k * 12, y: y0 + k * 8, button: 'left' });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x0 + 60, y: y0 + 40, button: 'left', clickCount: 1 }); await ex(`await w(600);`);
    const moved = ps.getTeam().nodes.find((n) => n.id === b.id); g.dragged = moved.x !== b.x || moved.y !== b.y;
    expect('graph: drag moves and persists a node', g.dragged, { from: [b.x, b.y], to: [moved.x, moved.y] });
    // Backend used by auto-layout / zoom: bulk positions + per-team viewport round-trip.
    ps.setPositions(Object.fromEntries(nodes.slice(0, 3).map((n, i) => [n.id, { x: 500 + i * 10, y: 300 }]))); ps.setViewport({ x: 10, y: 20, zoom: 1.5 });
    g.positions = ps.getTeam().nodes.filter((n) => n.x >= 500 && n.x <= 520 && n.y === 300).length; g.viewport = ps.getViewport();
    expect('graph: bulk positions + viewport persist', g.positions === 3 && g.viewport && g.viewport.zoom === 1.5, g); ps.setViewport({});
    // Planned UI (feature-detected).
    const has = (sels) => ex(`return ${JSON.stringify(sels)}.find((s) => document.querySelector(s)) || null`);
    const zoomIn = await has(['#zoomin', '#graph-zoomin', '[data-graph=zoomin]']); const fit = await has(['#fit', '#graph-fit', '[data-graph=fit]']);
    const layout = await has(['#autolayout', '#graph-layout', '[data-graph=layout]']);
    if (zoomIn && fit) {
      const tf = () => ex(`const v = document.querySelector('#graph > g.viewport, #graph > g[transform]'); return v ? v.getAttribute('transform') : $('#graph').getAttribute('viewBox')`);
      const t0 = await tf(); await ex(`$('${zoomIn}').click(); await w(300);`); const t1 = await tf(); await ex(`$('${fit}').click(); await w(300);`); const t2 = await tf();
      expect('graph: zoom in and fit change the view', t0 !== t1 && t1 !== t2, { t0, t1, t2 });
    } else console.log('[gui-e2e] graph: zoom/fit UI pending');
    if (layout) {
      const p0 = JSON.stringify(ps.getTeam().nodes.map((n) => [n.x, n.y])); await ex(`window.confirm = () => true; $('${layout}').click(); await w(800);`);
      const pos = ps.getTeam().nodes.map((n) => `${n.x},${n.y}`); g.layout = { changed: JSON.stringify(ps.getTeam().nodes.map((n) => [n.x, n.y])) !== p0, unique: new Set(pos).size === pos.length };
      expect('graph: auto-layout repositions 12 nodes without overlap', g.layout.changed && g.layout.unique, g.layout); await shot('23-graph-layout');
    } else console.log('[gui-e2e] graph: auto-layout UI pending');
    // Context menus: real right-clicks on a node, an edge and empty canvas; each must open #ctxmenu with actions (no pending fallback).
    const rclick = async ([x, y]) => { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'right', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'contextMenu', x, y, button: 'right' }); await ex(`await w(300);`); };
    const readMenu = () => ex(`const m = $('#ctxmenu'); return m && !m.classList.contains('hidden') ? [...m.querySelectorAll('button')].map((x) => x.textContent.trim()) : null`);
    const closeMenu = () => ex(`hideMenus(); await w(150);`);
    const edgeAt = () => ex(`const p = document.querySelector('#graph .edges:not(.cross-layer) .edge'); const L = p.getTotalLength(); const m = p.getScreenCTM(); const q = p.getPointAtLength(L / 2); return [Math.round(q.x * m.a + m.e), Math.round(q.y * m.d + m.f)];`);
    const canvasAt = () => ex(`const r = $('#graph').getBoundingClientRect(); return [Math.round(r.left + 24), Math.round(r.top + 60)];`);
    const menu = {};
    await rclick(await at(target.id)); menu.node = await readMenu(); await closeMenu();
    await rclick(await edgeAt()); menu.edge = await readMenu(); await closeMenu();
    await rclick(await canvasAt()); menu.canvas = await readMenu(); await closeMenu();
    expect('graph: right-click opens node, edge and canvas context menus with actions', ['node', 'edge', 'canvas'].every((k) => menu[k] && menu[k].length >= 2), menu);
    // Guide must not cover the editor: it collapses to a chip once the team exists.
    g.guide = await ex(`const r = $('#guide').getBoundingClientRect(); return $('#guide').classList.contains('hidden') ? 'hidden' : r.width < 300 ? 'mini' : 'open'`);
    expect('graph: Get started guide does not cover the editor', g.guide !== 'open', g);
    // (t_6674705d removed the .idlebanner the old cross-team ghost check read; the presence chips now
    // carry the same team-scoped idle info.)
    g.presence = await ex(`renderIdle(); return { chips: document.querySelectorAll('#presence .pchip').length, idle: document.querySelectorAll('#presence .pchip.idle').length }`);
    expect('graph: presence chips still render after the idle banner removal', g.presence.chips >= 2, g.presence);
    for (const t of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = t; await ex(`await w(400); fitView(); selectNode('${target.id}'); await w(300);`);
      await rclick(await at(target.id)); await shot(`24-graph-menu-${t}`); await closeMenu(); await shot(`25-graph-panel-${t}`);
    }
    require('electron').nativeTheme.themeSource = 'system';
    console.log('[gui-e2e] graph', JSON.stringify({ ...g, zoomIn, fit, layout, menu }));
  };
  // Parallel runs: 3 independent Dev tasks across 2 teams run at once (fake claude, 20s each: a board refresh can take ~6s while runs are live, so this is not a race); a dependent waits for its blocker.
  const parallelShots = async () => {
    const p = pid(); const t1 = pm.get(p).teams[0].id; const t2 = pm.createTeam(p, 'Parallel B').id; const s = pm.store(p);
    const fake = path.join(require('os').tmpdir(), 'squad-par-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\nsleep 20\necho '{"type":"result","subtype":"success","session_id":"s","total_cost_usd":0,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}'\n`); fs.chmodSync(fake, 0o755);
    const prev = s.getSettings(); s.saveSettings({ claudePath: fake, maxConcurrency: 8 });
    const [a, b] = ['ParA', 'ParB'].map((n) => pm.store(p, t1).addNode({ name: n, role: 'Dev' })); const c = pm.store(p, t2).addNode({ name: 'ParC', role: 'Dev' });
    // These fresh nodes have no capabilities snapshot yet, which would make the very next getAll() (auto-probe,
    // main.js probeNodeLater) run a synchronous `--help` probe against the fake claudePath above — a real CLI
    // returns instantly, but this fake script only ever sleeps, so execFileSync's probe blocks the whole main
    // process for its full 10s timeout per node (~30s serialized for 3 nodes), starving the child 'close' events
    // and IPC calls this test's 18s parallel-window check depends on. Stub a capabilities snapshot upfront so the
    // auto-probe sees them as already probed and skips it, matching what a real prior Refresh/run would leave behind.
    const stubCaps = { ok: true, probedAt: new Date().toISOString(), source: 'stub', slashCommands: [], commands: [], skills: [], modes: [], categorized: [] };
    pm.store(p, t1).updateNode(a.id, { capabilities: stubCaps }); pm.store(p, t1).updateNode(b.id, { capabilities: stubCaps }); pm.store(p, t2).updateNode(c.id, { capabilities: stubCaps });
    const ts = [a, b, c].map((n) => s.createTask({ title: 'Parallel ' + n.name, assignee: n.id }));
    const dep = s.createTask({ title: 'Depends on ParA', assignee: c.id, blockedBy: [ts[0].id] });
    const o = orchFor(p); const done = new Promise((r) => o.once('done', r)); o.start();
    await ex(`$('#tabs button[data-tab=board]').click(); await refresh();`);
    const live = await waitFor(`await refresh(); return /Running \\(3\\)/.test($('#runstate').textContent) && [...document.querySelectorAll('.card')].some((c) => /Depends on ParA/.test(c.textContent) && /Blocked by Parallel ParA/.test((c.querySelector('.tag.blocked') || {}).textContent || ''))`, 18000);
    const hdr = await ex(`return $('#runstate').textContent`);
    expect('parallel: header shows "Running (3)" and dependent shows Blocked by Parallel ParA', live, hdr);
    expect('parallel: 3 agents working at once across 2 teams', ts.every((t) => s.getTask(t.id).status === 'in_progress') && s.getTask(dep.id).status === 'todo', ts.map((t) => s.getTask(t.id).status));
    for (const t of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = t;
      await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`); await shot(`26-parallel-board-${t}`);
      await ex(`$('#tabs button[data-tab=overview]').click(); await w(300);`); await shot(`27-parallel-overview-${t}`);
    }
    require('electron').nativeTheme.themeSource = 'system';
    expect('parallel: still Running (3) after shots', /Running \(3\)/.test(await ex(`await refresh(); return $('#runstate').textContent`)));
    await done;
    const win = (tid) => { const r = s.listRuns().find((x) => x.taskId === tid && x.kind === 'agent'); return r ? [Date.parse(r.startedAt), Date.parse(r.endedAt)] : [0, 0]; };
    const [A, B, C] = ts.map((t) => win(t.id)); const D = win(dep.id); const ov = (x, y) => x[0] < y[1] && y[0] < x[1];
    expect('parallel: run windows overlap pairwise', ov(A, B) && ov(A, C) && ov(B, C), { A, B, C });
    expect('parallel: dependent starts after blocker ends', D[0] >= A[1], { A, D });
    s.saveSettings({ claudePath: prev.claudePath, maxConcurrency: prev.maxConcurrency });
  };
  // Run lifecycle (t_e3e2e397): a stub agent run (no real model) drives the header Run/Stop toggle
  // and the state pill, then the idle loop: the run stays alive when the board drains, spawns
  // nothing while idle, and a new todo task is picked up on its own; only an explicit Stop ends it.
  // The idle half is feature-gated like limits-providers: until the run idles at drain instead of
  // stopping (t_b2273507 core idle, t_7d5834a6 always-visible toggle), those checks log a pending
  // line instead of failing — the suite defines the target behavior, it doesn't enshrine drain-stops.
  const runIdleShots = async () => {
    const p = pid(); const s = pm.store(p); const team = pm.store(p, pm.get(p).teams[0].id);
    // Fast fake claude: one clean second, then the success result the run parser records.
    const fake = path.join(require('os').tmpdir(), 'squad-runidle-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\nsleep 1\necho '{"type":"result","subtype":"success","session_id":"ri","total_cost_usd":0,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}'\n`); fs.chmodSync(fake, 0o755);
    const prev = s.getSettings(); s.saveSettings({ claudePath: fake, maxConcurrency: 4 });
    const A = team.addNode({ name: 'IdlePM', role: 'PM' }); const B = team.addNode({ name: 'IdleDev', role: 'Dev' });
    team.addEdge(A.id, B.id, 'assign');
    // Stub capabilities like parallelShots: fresh nodes would otherwise trigger a blocking --help auto-probe.
    const stubCaps = { ok: true, probedAt: new Date().toISOString(), source: 'stub', slashCommands: [], commands: [], skills: [], modes: [], categorized: [] };
    team.updateNode(A.id, { capabilities: stubCaps }); team.updateNode(B.id, { capabilities: stubCaps });
    const until = async (fn, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
    // Watch the header pill through a ~1s stub pickup window and report whether it ever read
    // 'running'. A single sample after in_progress is observed races the proc's exit (poll lag +
    // refresh round-trip eat the window on a loaded machine), so poll instead: pass on the first
    // 'running' sighting; once the task left the pickup phase (review/done) without one, the window
    // is definitively over and the check fails on evidence.
    const pillRunning = async (task, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const st = s.getTask(task.id).status;
        const label = await ex(`await refresh(); return $('#runstate').textContent`);
        if (/running/i.test(label)) return { seen: true, label, status: st };
        if (st !== 'todo' && st !== 'in_progress') return { seen: false, label, status: st };
        await new Promise((r) => setTimeout(r, 120));
      }
      return { seen: false, label: await ex(`return $('#runstate').textContent`), status: s.getTask(task.id).status };
    };
    const o = orchFor(p);
    const { nativeTheme } = require('electron'); const prevTheme = nativeTheme.themeSource;
    expect('runidle: boot comes up stopped, never silently running', o.running === false, o.running);
    const first = s.createTask({ title: 'Idle: first piece of work', assignee: B.id });
    // Start through the real UI control (goal popover Run; the preflight confirm is auto-accepted like a human pressing "Run anyway").
    await ex(`await refresh(); window.confirm = () => true; window.alert = () => {}; $('#run').click(); await w(200);`);
    const started = await waitFor(`await refresh(); return /running/i.test($('#runstate').textContent)`);
    const dispatched = await until(() => s.getTask(first.id).status === 'in_progress');
    expect('runidle: the header Run control starts the run and dispatches the todo', started && dispatched, { started, status: s.getTask(first.id).status, label: await ex(`return $('#runstate').textContent`) });
    // Evidence (t_ac25444e): the three pill states, light mode, on Board and one other view. Running
    // first — the stub is at work and the pill is stably Running through the review pickup. Light
    // theme rides the whole evidence block and is restored at the end of the section.
    nativeTheme.themeSource = 'light'; await ex(`await w(300);`);
    await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`); await shot('31-runidle-running-board');
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(300);`); await shot('31-runidle-running-chat');
    // The stub leaves the task in review; the PM's review pickup closes it, then the board drains.
    expect('runidle: first task closes done through the review pickup', await until(() => s.getTask(first.id).status === 'done', 30000), s.getTask(first.id).status);
    // The gate must be deterministic: right after done, running is transiently true before the core
    // drain-stop lands (t_b2273507), so sampling it here raced the stop underneath the idle branch.
    // Settle first — the run either actually stops, or survives 2s straight with zero procs (core
    // idle keeps it alive at drain) — then choose the branch on the settled state, never the transient.
    const idling = await (async () => {
      const end = Date.now() + 15000;
      while (Date.now() < end && o.running) {
        let stableMs = 0;
        while (Date.now() < end && o.running && stableMs < 2000) { if (o.procs.size > 0) stableMs = 0; else stableMs += 100; await new Promise((r) => setTimeout(r, 100)); }
        if (o.running && stableMs >= 2000) return true;
      }
      return false;
    })();
    if (idling) {
      await ex(`await refresh(); await w(300);`);
      const label = await ex(`return $('#runstate').textContent`);
      expect('idle: the run stays alive with the board drained', o.running === true, o.running);
      expect('idle: the pill reads Idle (nothing to do)', /idle/i.test(label) && !/running/i.test(label), label);
      expect('idle: Stop stays in the bar while the run idles', await ex(`return !$('#stop').classList.contains('hidden') && $('#stop').getBoundingClientRect().width > 0`));
      const runsBefore = s.listRuns().length;
      await new Promise((r) => setTimeout(r, 2500));
      expect('idle: nothing spawns while idle (zero cost waiting)', s.listRuns().length === runsBefore && o.procs.size === 0, { before: runsBefore, after: s.listRuns().length, procs: o.procs.size });
      await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`); await shot('31-runidle-idle-board');
      await ex(`$('#tabs button[data-tab=chat]').click(); await w(300);`); await shot('31-runidle-idle-chat');
      const second = s.createTask({ title: 'Idle: picked up without a click', assignee: B.id });
      expect('idle: a new todo is picked up on its own', await until(() => s.getTask(second.id).status === 'in_progress', 8000), s.getTask(second.id).status);
      expect('idle: the pill reads running again during pickup', (await pillRunning(second)).seen);
      await until(() => s.getTask(second.id).status === 'done', 30000);
    } else {
      console.log('[gui-e2e] runidle: the run still stops when the board drains — the idle-waiting and self-pickup checks stay gated on t_b2273507 (core idle); the Stopped pill + header Run checks below run either way');
    }
    // Stopped state (t_ac25444e), shared by both drain shapes — the run is off by here (explicit
    // Stop while idle, or the drain-stop): the pill must say Stopped, show the waiting todos, and
    // the header Run button must be the visible way back.
    if (o.running) { await ex(`$('#stop').click(); await w(400);`); } // Stop while idle: the explicit off switch
    expect('stopped: the run is off (Stop works while idle too)', await until(() => !o.running, 5000), o.running);
    await ex(`await refresh(); await w(300);`);
    const stoppedLabel = await ex(`return $('#runstate').textContent`);
    expect('stopped: the pill reads Stopped, never idle, once the run is off', /stopped/i.test(stoppedLabel) && !/idle/i.test(stoppedLabel) && !/running/i.test(stoppedLabel), stoppedLabel);
    expect('stopped: Stop leaves the bar once the run is off', await ex(`return $('#stop').classList.contains('hidden')`));
    expect('stopped: the header shows the Run button', await ex(`return !$('#runbtn').classList.contains('hidden') && $('#runbtn').getBoundingClientRect().width > 0`));
    const third = s.createTask({ title: 'Idle: must wait while stopped', assignee: B.id });
    await new Promise((r) => setTimeout(r, 2500));
    expect('stopped: a new todo is not dispatched while stopped', s.getTask(third.id).status === 'todo' && !o.running, { status: s.getTask(third.id).status, running: o.running });
    const stoppedPending = await ex(`await refresh(); return $('#runstate').textContent`);
    expect('stopped: the pill shows the pending todo work', /stopped/i.test(stoppedPending) && /todo/i.test(stoppedPending), stoppedPending);
    const runLbl = await ex(`return $('#runbtn').textContent`);
    expect('stopped: the Run button carries the waiting count ("N tasks waiting — Run")', /tasks? waiting — Run/.test(runLbl), runLbl);
    await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`); await shot('31-runidle-stopped-board');
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(300);`); await shot('31-runidle-stopped-chat');
    // The header Run button is the way back: clicking it restarts the run and dispatches the waiter.
    await ex(`$('#runbtn').click(); await w(200);`);
    const resumed = await until(() => s.getTask(third.id).status === 'in_progress') && (await pillRunning(third)).seen;
    expect('stopped: the header Run button restarts the run and dispatches the waiting todo', resumed, s.getTask(third.id).status);
    expect('stopped: the Run button reverts to plain Run once the run is on', (await ex(`await refresh(); return $('#runbtn').textContent`)) === 'Run', await ex(`return $('#runbtn').textContent`));
    await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`); await shot('31-runidle-resumed-board');
    await ex(`$('#stop').click(); await w(300);`); await until(() => !o.running, 5000);
    await ex(`await refresh(); await w(300);`); await shot('31-runidle-board');
    nativeTheme.themeSource = prevTheme;
    s.saveSettings({ claudePath: prev.claudePath, maxConcurrency: prev.maxConcurrency });
    console.log('[gui-e2e] runidle', JSON.stringify({ first: s.getTask(first.id).status, running: o.running }));
  };
  // Mixed vendors: Claude/Opus PM -> Codex Dev -> Claude/Haiku Reviewer finish a chain through the board (fake bins); graph runtime/model chips + overview.
  const mixedShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const p = cur.p || pid(); const ts = pm.store(p, cur.t); const s = pm.store(p); const tmp = require('os').tmpdir();
    const cl = path.join(tmp, 'squad-mix-claude.sh'); const cx = path.join(tmp, 'squad-mix-codex.sh');
    fs.writeFileSync(cl, `#!/bin/sh\nsleep 3\necho '{"type":"result","subtype":"success","session_id":"cs","total_cost_usd":0.01,"num_turns":1,"usage":{"input_tokens":5,"output_tokens":2}}'\n`);
    fs.writeFileSync(cx, `#!/bin/sh\nsleep 3\necho '{"type":"thread.started","thread_id":"T1"}'\necho '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"added hello.txt"}}'\necho '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}'\n`);
    fs.chmodSync(cl, 0o755); fs.chmodSync(cx, 0o755);
    const prev = s.getSettings(); s.saveSettings({ claudePath: cl, codexPath: cx });
    const P = ts.addNode({ name: 'MixPM', role: 'PM', runtime: 'claude', model: 'opus', x: 60, y: 60 });
    const D = ts.addNode({ name: 'MixDev', role: 'Dev', runtime: 'codex', model: 'gpt-5.6-terra', x: 320, y: 60 });
    const R = ts.addNode({ name: 'MixRev', role: 'Reviewer', runtime: 'claude', model: 'haiku', x: 580, y: 60 });
    ts.addEdge(P.id, D.id, 'assign'); ts.addEdge(R.id, D.id, 'review');
    const plan = s.createTask({ title: 'Mix: plan hello.txt', assignee: P.id });
    const impl = s.createTask({ title: 'Mix: write hello.txt', assignee: D.id, blockedBy: [plan.id] });
    const rev = s.createTask({ title: 'Mix: review hello.txt', assignee: R.id, blockedBy: [impl.id] });
    await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); await w(400);`);
    const chips = await ex(`return [...document.querySelectorAll('#graph .chip text')].map((t) => t.textContent)`);
    expect('mixed: graph chips show codex + claude runtimes and opus/haiku models', ['codex', 'claude', 'opus', 'haiku'].every((c) => chips.some((x) => x.toLowerCase().startsWith(c))), chips);
    const o = orchFor(p); const done = new Promise((r) => o.once('done', r)); o.start();
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); await w(400);`); await shot(`28-mixed-graph-${t}`); }
    await done;
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=overview]').click(); await refresh(); await w(400);`); await shot(`29-mixed-overview-${t}`); }
    const ov = await ex(`return [...document.querySelectorAll('#ov-graph .ov-vendor')].map((t) => t.textContent)`);
    expect('mixed: overview nodes show vendor · model', ov.join() === 'Claude · opus,Codex · gpt-5.6-terra,Claude · haiku', ov);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=usage]').click(); await refresh(); await w(600);`); await shot(`30-mixed-usage-${t}`); }
    const us = await ex(`return [...document.querySelectorAll('#us-summary h4')].find((h) => h.textContent === 'By account').nextElementSibling.innerText`);
    // Per-key usage ledger (t_f8032a7d), re-grouped per account (t_b1115e48): the By-account table is
    // the visible account>runtime>provider>model table (inside <details> innerText is empty —
    // unrendered content). Each nested row is one key, so the codex line carries its own per-key
    // token total (100 in + 7 out + 40 cached reads = 147; the old "107" predates cached_input_tokens
    // counting as cache-read) and its cost stays "—"; claude keys report real $.
    const codexRow = us.split('\n').find((l) => l.startsWith('Codex'));
    // The ledger prices models the CLI leaves uncosted from a small list-price table, so codex shows
    // an estimate ("est") or "—" — never a bare $0; claude keys carry the CLI's own $.
    expect('mixed: usage By account splits per-model Codex and Claude rows; claude reports $, codex est or — but never $0', !!codexRow && /\d/.test(codexRow) && !/\$0\.0000/.test(codexRow) && (/est\s*$/.test(codexRow) || /—\s*$/.test(codexRow)) && /Claude[^\n]*\$0\.0/.test(us), us);
    require('electron').nativeTheme.themeSource = 'system';
    const st = [plan, impl, rev].map((t) => s.getTask(t.id).status); expect('mixed: all three tasks done', st.every((x) => x === 'done'), st);
    const rt = [plan, impl, rev].map((t) => (s.listRuns().find((r) => r.taskId === t.id && r.kind === 'agent') || {}).runtime);
    expect('mixed: runs recorded as claude, codex, claude', rt.join() === 'claude,codex,claude', rt);
    console.log('[gui-e2e] mixed', JSON.stringify({ chips, st, rt }));
    s.saveSettings({ claudePath: prev.claudePath, codexPath: prev.codexPath });
  };
  // Usage limits meter (stubbed rate-limit runs, no real model calls), the dispatch guard pausing at threshold,
  // graph vendor/model badges, and capability auto-discovery firing the moment a new agent is added.
  const limitsShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const p = cur.p || pid(); const ts = pm.store(p, cur.t); const s = pm.store(p); const o = orchFor(p);
    let nodes = ts.getTeam().nodes;
    if (nodes.length < 2) { ts.addNode({ name: 'Pia', role: 'PM', runtime: 'claude', model: 'opus', x: 60, y: 60 }); ts.addNode({ name: 'Devon', role: 'Dev', runtime: 'codex', model: 'gpt-5.6-terra', x: 320, y: 60 }); nodes = ts.getTeam().nodes; }
    const [pm1, dev] = nodes;
    // Stub subscription runs: 6 inside the 5h window (below a limit of 10 -> 60%, under the 80% warn line) plus
    // one stale run from 6h ago that must NOT count (proves the window "resets" rather than accumulating forever).
    // runtime is set the way the orchestrator stamps real runs — usageProviders attributes runs to
    // providers by it, so unstamped seeds would leave the provider honestly "unknown".
    for (let i = 0; i < 6; i++) s.addRun({ id: 'lim-' + i, projectId: p, nodeId: pm1.id, agent: pm1.name, kind: 'agent', runtime: 'claude', billingSource: 'subscription', startedAt: new Date(Date.now() - i * 1000).toISOString(), inputTokens: 10, outputTokens: 5 });
    s.addRun({ id: 'lim-stale', projectId: p, nodeId: pm1.id, agent: pm1.name, kind: 'agent', runtime: 'claude', billingSource: 'subscription', startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), inputTokens: 10, outputTokens: 5 });
    const prevLim = s.getSettings().usageLimits; s.saveSettings({ usageLimits: { fiveHourLimit: 10, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
    await ex(`$('#tabs button[data-tab=usage]').click(); await refresh(); await w(500);`);
    const meterQ = `{ pct: $('#limitmeter .lm-fill')?.style.width, text: $('#limitmeter').textContent, warn: /near limit/.test($('#limitmeter').textContent), pause: /paused/.test($('#limitmeter').textContent) }`;
    const under = await ex(`return ${meterQ}`);
    expect('usage limits: top-bar #limitmeter is quiet at 60% used (warning chip only from 80%, t_ea33cef4)', under.text === '' && !under.warn && !under.pause, under);
    expect('usage limits: the Usage tab still shows the 60% window with a reset countdown', await ex(`return /60%/.test($('#us-limits').textContent)`));
    // The meter must also honor the CLI's own reported subscription rate-limit % (usage.js parseRateLimits,
    // fed into orch.subscriptionRateLimits off the CLI's init event), not only the local run-derived count —
    // other clients sharing the same subscription window aren't reflected in this project's local runs.
    o.subscriptionRateLimits = { [pm1.id]: { fiveHour: { pct: 0.97, resetsAt: new Date(Date.now() + 3600000).toISOString() } } };
    await ex(`await refresh(); await w(400);`);
    const cli = await ex(`return ${meterQ}`);
    expect('usage limits: #limitmeter prefers the higher CLI-reported rate-limit % (97%) over the 60% local count', cli.pct === '97%' && cli.warn && !cli.pause, cli);
    o.subscriptionRateLimits = {};
    await ex(`await refresh(); await w(400);`);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(200);`); await shot(`limits-meter-${t}`); }
    // Cross the warn line (80%), then the pause line (100%) — both computed straight off the same stubbed runs.
    s.saveSettings({ usageLimits: { fiveHourLimit: 7, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
    await ex(`await refresh(); await w(400);`);
    const warn = await ex(`return ${meterQ}`);
    expect('usage limits: 6/7 = 86% crosses the warn line', warn.pct === '86%' && warn.warn, warn);
    s.saveSettings({ usageLimits: { fiveHourLimit: 6, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
    await ex(`await refresh(); await w(400);`);
    const pause = await ex(`return ${meterQ}`);
    expect('usage limits: 6/6 = 100% crosses the pause line', pause.pct === '100%' && pause.pause, pause);
    await shot('limits-pause-banner');
    // The dispatch guard itself: a real orchestrator with a todo task ready to run must NOT start it while paused.
    o.checkUsageLimits(pm1.id);
    expect('usage limits: checkUsageLimits() flips the in-memory guard on at 100%', o.usagePaused === true, { usagePaused: o.usagePaused });
    const guardTask = s.createTask({ title: 'Should stay paused', assignee: pm1.id });
    o.start(); await new Promise((r) => setTimeout(r, 500)); o.stop();
    expect('usage limits: guard blocks dispatch, task never left todo', s.getTask(guardTask.id).status === 'todo', s.getTask(guardTask.id).status);
    s.saveSettings({ usageLimits: prevLim }); o.usagePaused = false;
    // Graph node badges: vendor/model chips on the two existing nodes, plus an effort chip on one of them.
    ts.updateNode(pm1.id, { effort: 'high' });
    await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); await w(300);`);
    const chips = await ex(`return [...document.querySelectorAll('#graph .chip text')].map((t) => t.textContent)`);
    expect('graph: node badges render runtime + model chips', ['claude', 'opus', 'codex', 'gpt-5.6-terra'].every((c) => chips.some((x) => x.toLowerCase() === c)), chips);
    const effortChips = await ex(`return [...document.querySelectorAll('#graph .chip-em text')].map((t) => t.textContent)`);
    expect('graph: effort chip renders for the node with effort set', effortChips.includes('E:high'), effortChips);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(200);`); await shot(`limits-graph-badges-${t}`); }
    // Probe badge: a node added directly (bypassing the auto-probe IPC path) starts on the untested dot
    // (.capsdot.caps-none), and flips off it once probed — the same transition a stubbed CLI init event drives.
    const untested = ts.addNode({ name: 'Unprobed', role: 'QA', runtime: 'claude', model: 'sonnet', x: 500, y: 200 });
    await ex(`await refresh(); renderGraph(); await w(200);`);
    const dotBefore = await ex(`return document.querySelector('g[data-id="${untested.id}"] .capsdot')?.getAttribute('class')`);
    expect('probe badge: manually-added node starts on the untested dot', dotBefore === 'capsdot caps-none', dotBefore);
    await ex(`await call('discoverCapabilities', '${untested.id}'); await refresh(); renderGraph(); await w(200);`);
    const dotAfter = await ex(`return document.querySelector('g[data-id="${untested.id}"] .capsdot')?.getAttribute('class')`);
    expect('probe badge: flips off the untested dot once probed (stubbed init event)', dotAfter !== 'capsdot caps-none', dotAfter);
    // Capability auto-discovery: adding a new agent through the real UI (#addnode -> IPC addNode) probes it
    // immediately, so the node form never shows "Not probed yet" for it.
    await ex(`document.querySelector('#addnode').click(); await w(600);`);
    const added = ts.getTeam().nodes.find((n) => !['Pia', 'Devon', 'Unprobed', pm1.name, dev.name].includes(n.name)) || ts.getTeam().nodes[ts.getTeam().nodes.length - 1];
    await ex(`sel.node = '${added.id}'; renderNodeForm(); await w(200);`);
    const disc = await ex(`return $('#nf-caps-view').textContent`);
    expect('discovery: auto-runs on a newly added agent (not "not probed yet")', !/Not probed yet/.test(disc) && added.capabilities != null, { disc: disc.slice(0, 120), capabilities: added.capabilities });
    console.log('[gui-e2e] limits', JSON.stringify({ under, cli, warn, pause, guardTaskStatus: s.getTask(guardTask.id).status, chips, effortChips, probeBefore: dotBefore, probeAfter: dotAfter, discovered: !!added.capabilities }));
    require('electron').nativeTheme.themeSource = 'system';
  };
  // Per-provider top-bar limits (three team compositions, stubbed limit data, no model calls): the meter
  // must follow the providers the team actually uses. Claude-only shows the CLI's own utilization (it
  // wins outright even when the local run count is higher); a Codex-only team — Codex reports no
  // rate-limit windows at all — gets an honest per-node reason and never a fabricated 0%; a mixed team
  // must not let Claude's numbers bleed onto the silent provider. The per-provider CHIP contract
  // (label per provider, "limits unknown") is feature-gated: it asserts once usageStatus carries
  // provider-keyed data or the meter renders [data-provider] chips, and until then logs how many
  // checks it skipped — gating on the feature instead of enshrining the old single-provider wording.
  const limitsProvidersShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`);
    const prevCtx = await ex(`return { ...ctx }`);
    // A stub codex CLI so the Codex-only team counts as installed-but-silent ("codex --version" works,
    // yet no rate-limit event ever arrives) — the real-world Codex shape today.
    const cx = path.join(require('os').tmpdir(), 'squad-limits-codex.sh');
    fs.writeFileSync(cx, `#!/bin/sh\necho 'codex-cli 0.0.0'\n`); fs.chmodSync(cx, 0o755);
    const rl = (pct, hrs) => ({ pct, resetsAt: new Date(Date.now() + hrs * 3600000).toISOString() });
    const grab = `(async () => ({ txt: $('#limitmeter').textContent, hidden: $('#limitmeter').classList.contains('hidden'), chips: document.querySelectorAll('#limitmeter [data-provider]').length, st: await call('usageStatus') }))()`;
    // Chip geometry: the single summary chip must be fully visible and the "· limits unknown" wording
    // must never shrink-ellipsise ("Codex U… lim…"). This suite runs at the DEFAULT window width
    // (1400px): since t_db67859d the header holds only fixed-size chrome (the goal composer is a
    // popover off "New goal"), so the meter must clip NOTHING here — tail clipping is allowed only
    // in the narrow sweeps of the 'topbar' suite (< 1400px). +1 tolerates sub-pixel flex rounding.
    const geom = `(async () => { const m = $('#limitmeter');
      const chips = [...m.querySelectorAll('[data-provider]')].map((c) => { const r = c.getBoundingClientRect(); return { p: c.dataset.provider, l: Math.round(r.left), r: Math.round(r.right) }; });
      let overlap = null;
      for (let i = 0; i < chips.length && !overlap; i++) for (let j = i + 1; j < chips.length; j++) { const a = chips[i], b = chips[j]; if (a.l < b.r - 1 && b.l < a.r - 1) overlap = [a.p, b.p]; }
      const unknown = [...m.querySelectorAll('.lm-unknown')].map((c) => { const s = c.querySelector('small'); return { p: c.dataset.provider, txt: c.textContent.trim(), cut: s ? s.scrollWidth > s.clientWidth + 1 : false }; });
      const h = document.querySelector('header'); const vis = (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= window.innerWidth + 1; };
      return { chips, overlap, unknown, clipped: m.scrollWidth > m.clientWidth + 1, fit: h.scrollWidth <= h.clientWidth + 1, goal: vis('#newgoal'), help: vis('#help') }; })()`;
    const geomCheck = async (label) => {
      const g = await ex(`return ${geom}`);
      expect(`limits-providers: ${label} — chips lay side by side, bounding rects do not overlap`, g.chips.length >= 1 && !g.overlap, g);
      expect(`limits-providers: ${label} — header fits, New goal/help visible`, g.fit && g.goal && g.help, g);
      expect(`limits-providers: ${label} — every chip fully visible, meter clips nothing (default width: goal absorbs first)`, !g.clipped, g);
      expect(`limits-providers: ${label} — every chip keeps a legible width, never squeezed away`, g.chips.every((c) => c.r - c.l >= 100), g);
      if (g.unknown.length) expect(`limits-providers: ${label} — unknown wording legible ("· limits unknown", never ellipsised)`, g.unknown.every((u) => !u.cut && /· limits unknown/.test(u.txt)), g.unknown);
      return g;
    };
    const go = async (name) => { const pj = pm.create(name); await ex(`P = await call('listProjects'); renderSidebar(); await switchTo({ p: '${pj.id}' }); await w(700);`); return { pj, s: pm.store(pj.id), o: orchFor(pj.id) }; };
    const scenarios = [];
    // Claude-only: CLI-reported 42%/13% must show even though the local run count says 60%.
    {
      const { pj, s, o } = await go('Limits: Claude only');
      const a = s.addNode({ name: 'ClaPM', role: 'PM', runtime: 'claude', model: 'opus', x: 60, y: 60 });
      s.addNode({ name: 'ClaDev', role: 'Dev', runtime: 'claude', model: 'sonnet', x: 320, y: 60 });
      for (let i = 0; i < 6; i++) s.addRun({ id: 'lp' + i, projectId: pj.id, nodeId: a.id, agent: a.name, kind: 'agent', runtime: 'claude', billingSource: 'subscription', startedAt: new Date(Date.now() - i * 1000).toISOString(), inputTokens: 10, outputTokens: 5 });
      s.saveSettings({ usageLimits: { fiveHourLimit: 10, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
      o.subscriptionRateLimits = { [a.id]: { fiveHour: rl(0.42, 1), weekly: rl(0.13, 72) } };
      await ex(`await refresh(); await w(500);`);
      const m = await ex(`return ${grab}`);
      const title6 = await ex(`return (document.querySelector('#limitmeter [data-provider]') || {}).title || ''`);
      expect('limits-providers: Claude-only team at 42%: top bar stays quiet (chip only from 80%); usageStatus carries the CLI-reported 42%', m.hidden && m.chips === 0 && JSON.stringify(m.st.providers).includes('0.42'), { m, title6 });
        await shot('limits-providers-claude-only');
      scenarios.push({ name: 'Claude only', id: pj.id, m });
      // The stubs stay: the contract loop below re-reads each project's meter and asserts the very
      // windows seeded here (clearing them made every provider flip to 'unknown' by then).
    }
    // Codex-only: nothing ever reports — the meter explains that per agent instead of inventing a %.
    {
      const { pj, s, o } = await go('Limits: Codex only');
      s.addNode({ name: 'CodPM', role: 'PM', runtime: 'codex', model: 'gpt-5.6-terra', x: 60, y: 60 });
      s.addNode({ name: 'CodDev', role: 'Dev', runtime: 'codex', model: 'gpt-5.6-cipher', x: 320, y: 60 });
      s.saveSettings({ codexPath: cx });
      await ex(`await refresh(); await w(500);`);
      const m = await ex(`return ${grab}`);
      expect('limits-providers: Codex-only team (Codex reports nothing) shows nothing in the top bar, no fabricated percentage', m.hidden && !/\d+%/.test(m.txt), m.txt);
        await shot('limits-providers-codex-only');
      scenarios.push({ name: 'Codex only', id: pj.id, m });
    }
    // Mixed: only the Claude node reports — its numbers surface without being attributed to Codex.
    {
      const { pj, s, o } = await go('Limits: mixed');
      const c = s.addNode({ name: 'MixClaude', role: 'PM', runtime: 'claude', model: 'opus', x: 60, y: 60 });
      s.addNode({ name: 'MixCodex', role: 'Dev', runtime: 'codex', model: 'gpt-5.6-terra', x: 320, y: 60 });
      s.saveSettings({ codexPath: cx, usageLimits: { fiveHourLimit: 10, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
      o.subscriptionRateLimits = { [c.id]: { fiveHour: rl(0.42, 1), weekly: rl(0.13, 72) } };
      await ex(`await refresh(); await w(500);`);
      const m = await ex(`return ${grab}`);
      expect('limits-providers: mixed team at 42%: top bar quiet; Claude-reported 42% is in usageStatus', m.hidden && JSON.stringify(m.st.providers).includes('0.42'), m.txt);
      await shot('limits-providers-mixed');
      scenarios.push({ name: 'mixed', id: pj.id, m });
    }
    // Feature gate for the chip contract: provider-keyed usageStatus (Devon's model) or [data-provider]
    // chips (Uma's UI). Skipped loudly until then; once active, a mismatch red-lines the case on purpose.
    const provKeyed = scenarios.some((x) => x.m.st && x.m.st.providers && (Array.isArray(x.m.st.providers) ? x.m.st.providers.length : Object.keys(x.m.st.providers).length));
    const chipDom = scenarios.some((x) => x.m.chips > 0);
    if (!(provKeyed || chipDom)) {
      console.log('[gui-e2e] limits-providers: provider-keyed usageStatus / [data-provider] chips not present yet — 7 per-provider contract checks skipped (self-activate when the provider-keyed model + chips land)');
    } else {
      const provsOf = (st) => !st || !st.providers ? [] : (Array.isArray(st.providers) ? st.providers : Object.values(st.providers));
      const hasPct = (o) => /0\.42\b/.test(JSON.stringify(o)) || /"pct":\s*42\b/.test(JSON.stringify(o));
      for (const x of scenarios) {
        await ex(`await switchTo({ p: '${x.id}' }); await w(500);`);
        const t = (await ex(`return $('#limitmeter').textContent.toLowerCase()`)) || '';
        const provs = provsOf(x.m.st);
        expect(`limits-providers[contract]: ${x.name} — top bar has no chip below 80%`, t === '', t);
        if (x.name === 'Claude only') expect('limits-providers[contract]: Claude-only usageStatus carries the CLI window under the claude provider', provs.some((p) => JSON.stringify(p).toLowerCase().includes('claude')) && hasPct(provs), provs);
        else if (x.name === 'mixed') {
          const codex = provs.filter((p) => JSON.stringify(p).toLowerCase().includes('codex'));
          expect('limits-providers[contract]: mixed — Claude numbers never bleed onto the Codex entry', codex.length > 0 && codex.every((p) => !hasPct(p)), codex);
        }
      }
    }
    await ex(`await switchTo(${JSON.stringify(prevCtx)}); await w(300);`);
    console.log('[gui-e2e] limits-providers', JSON.stringify({ scenarios: scenarios.map((x) => ({ name: x.name, pct: (x.m.txt.match(/\d+%/g) || []).join(','), chips: x.m.chips, providerKeyed: !!(x.m.st && x.m.st.providers), rects: x.g && x.g.chips, overlap: x.g && x.g.overlap, clipped: x.g && x.g.clipped })) }));
  };
  // Discovery panel regression: the recorded real init event (58 skills / 123 slash commands, incl.
  // goal+loop modes — test/fixtures/real-init-event.json) drives the Usage tab's #us-discovery panel the
  // same way a real Refresh would (discoverCapabilities({initEvent}) -> node.capabilities), so the panel's
  // Skills/Commands cards must show exactly those counts, and the 5h/weekly reset chip must never render
  // for a resetsAt that is null or already past (0/negative ms) — no misleading "↻0m"/"↻NaNm".
  const discoveryPanelShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const p = cur.p || pid(); const ts = pm.store(p, cur.t); const s = pm.store(p);
    let nodes = ts.getTeam().nodes;
    if (!nodes.length) { ts.addNode({ name: 'Pia', role: 'PM', runtime: 'claude', model: 'opus', x: 60, y: 60 }); nodes = ts.getTeam().nodes; }
    const [pm1] = nodes;
    const initEvent = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'real-init-event.json'), 'utf8'));
    const rt = RT.getRuntime(pm1.runtime || 'claude');
    // Same call main.js's discoverCapabilities IPC makes on a real Refresh once a live init event exists.
    const capabilities = CAP.discoverCapabilities(rt, s.getSettings(), { exec: () => '', initEvent });
    ts.updateNode(pm1.id, { capabilities, capabilitiesProbedAt: capabilities.probedAt });
    const prevLim = s.getSettings().usageLimits; s.saveSettings({ usageLimits: { fiveHourLimit: 0, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
    await ex(`$('#tabs button[data-tab=usage]').click(); await refresh(); await w(400);`);
    const panel = await ex(`return { skills: $('#us-discovery .cards .stat:nth-child(1) b')?.textContent, commands: $('#us-discovery .cards .stat:nth-child(2) b')?.textContent, modes: $('#us-discovery .cards .stat:nth-child(3) small:last-child')?.textContent, text: $('#us-discovery').textContent }`);
    expect('discovery panel: Skills card equals the fixture\'s 58 skills after Refresh', panel.skills === '58', panel);
    expect('discovery panel: Commands card equals the fixture\'s 123 slash commands after Refresh', panel.commands === '123', panel);
    expect('discovery panel: Modes list includes goal and loop', /goal/.test(panel.modes) && /loop/.test(panel.modes), panel.modes);
    expect('discovery panel: no reset chip (↻) rendered when no limit/resetsAt is reported', !/↻/.test(panel.text), panel.text);
    await shot('discovery-panel');
    // Now with a limit configured but resetsAt null/at-or-before-now (unavailable/expired): still no "↻0m".
    s.saveSettings({ usageLimits: { fiveHourLimit: 10, weeklyLimit: 10, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
    for (let i = 0; i < 3; i++) s.addRun({ id: 'disc-' + i, projectId: p, nodeId: pm1.id, agent: pm1.name, kind: 'agent', billingSource: 'subscription', startedAt: new Date(0).toISOString(), inputTokens: 10, outputTokens: 5 });
    await ex(`await refresh(); await w(400);`);
    const noReset = await ex(`return $('#us-discovery').textContent`);
    expect('discovery panel: reset chip never renders for a resetsAt already in the past (stale window)', !/↻0m|↻NaN/.test(noReset), noReset);
    s.saveSettings({ usageLimits: prevLim });
    console.log('[gui-e2e] discovery', JSON.stringify({ panel, skillsCount: capabilities.skills.length, commandsCount: capabilities.slashCommands.length }));
  };
  // Per-model usage accounting (t_14533d6d): seeded runs for three different models (fixtures only, no CLI
  // runs) must show as separate per-model rows carrying exactly that model's own tokens — never a merged or
  // cross-model-summed token figure — while cost is the only number with a grand total across models.
  // On the API side, modelStats() must expose exactly one bucket per model, each holding only its own
  // tokens/cost. When Uma's per-model Usage rework (t_f8032a7d) changes this view, these are the invariants
  // it has to keep: one row per model, per-model token cells exact, single cost grand total.
  const usagePerModelShots = async () => {
    const up = pm.create('Usage per model'); const s = pm.store(up.id); const o = orchFor(up.id);
    const now = Date.now();
    const seeds = [
      { model: 'claude-opus-4-5', runtime: 'claude', inputTokens: 1100, outputTokens: 220, cacheReadTokens: 330, cacheCreationTokens: 44, reportedCostUsd: 0.0123 },
      { model: 'claude-sonnet-5', runtime: 'claude', inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 5600, cacheCreationTokens: 700, reportedCostUsd: 0.0456 },
      { model: 'glm-5.3-flash', runtime: 'helpycode', inputTokens: 500, outputTokens: 150, cacheReadTokens: 60, cacheCreationTokens: 0, reportedCostUsd: 0.0079 },
    ];
    seeds.forEach((x, i) => s.addRun({ id: 'usage-seed-' + i, projectId: up.id, nodeId: 'n_seed' + i, agent: 'Seed ' + (i + 1), kind: 'agent',
      startedAt: new Date(now - (seeds.length - i) * 60000).toISOString(), endedAt: new Date(now - (seeds.length - 1 - i) * 60000).toISOString(),
      durationMs: 60000, taskId: null, task: '', model: x.model, models: [x.model], runtime: x.runtime,
      apiKeySource: 'ANTHROPIC_API_KEY', billingMode: 'auto', billingSource: 'api', billingDetail: 'ANTHROPIC_API_KEY',
      inputTokens: x.inputTokens, outputTokens: x.outputTokens, cacheReadTokens: x.cacheReadTokens, cacheCreationTokens: x.cacheCreationTokens,
      numTurns: 2, reportedCostUsd: x.reportedCostUsd, exitCode: 0, isError: false, sessionId: 'usage-seed-' + i }));
    const tot = (x) => x.inputTokens + x.outputTokens + x.cacheReadTokens + x.cacheCreationTokens;
    // API level: one bucket per model, each carrying only its own tokens and cost — no cross-model token sum.
    const ms = o.modelStats();
    expect('usage: modelStats has exactly one bucket per model', JSON.stringify(Object.keys(ms).sort()) === JSON.stringify(seeds.map((x) => x.model).sort()), Object.keys(ms));
    expect('usage: modelStats buckets hold only their own model tokens/cost', seeds.every((x) => ms[x.model] && ms[x.model].runs === 1 && ms[x.model].tokens === tot(x) && Math.abs(ms[x.model].costUsd - x.reportedCostUsd) < 1e-9), ms);
    await ex(`await switchTo({ p: '${up.id}' }); await w(500);`);
    const fmtTok = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n); };
    const costTotal = seeds.reduce((a, x) => a + x.reportedCostUsd, 0);
    const ranked = seeds.slice().sort((a, b) => tot(b) - tot(a));
    for (const theme of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = theme;
      await ex(`$('#tabs button[data-tab=usage]').click(); await refresh(); await w(500);
        const g = $('#g-close'); if (g) g.click(); // the Get-started card must not cover the evidence
        $('#us-summary details').open = true; await w(200);`);
      const brk = await ex(`const c = document.querySelectorAll('#us-summary .us-breakdowns .us-card')[0]; return [...c.querySelectorAll('.usr')].map((n) => [n.querySelector('.usr-name').childNodes[0].textContent.trim(), n.querySelector('.usr-val b').textContent])`);
      expect('usage: By-model breakdown has a separate ranked row per model', JSON.stringify(brk.map((r) => r[0])) === JSON.stringify(ranked.map((x) => x.model)), brk);
      expect('usage: breakdown row tokens are that model own total, not a cross-model sum', JSON.stringify(brk.map((r) => r[1])) === JSON.stringify(ranked.map((x) => fmtTok(tot(x)))), brk);
      // Detailed By-model table: exact raw per-model cells, no extra merged/total row.
      const tbl = await ex(`const h = [...document.querySelectorAll('#us-summary details h4')].find((x) => x.textContent === 'By model'); return h ? [...h.nextElementSibling.querySelectorAll('tr')].map((tr) => [...tr.cells].map((td) => td.textContent.trim())) : null`);
      const byModel = Object.fromEntries((tbl || []).filter((c) => c[0]).map((c) => [c[0], c]));
      expect('usage: By-model table has exactly one row per model (no merged/total row)', (tbl || []).filter((c) => c[0]).length === seeds.length && seeds.every((x) => byModel[x.model]), (tbl || []).map((c) => c[0]));
      expect('usage: By-model table cells are exact per-model tokens', seeds.every((x) => { const c = byModel[x.model] || []; return c[1] === '1' && c[2] === String(x.inputTokens) && c[3] === String(x.outputTokens) && c[4] === String(x.cacheReadTokens) && c[5] === String(x.cacheCreationTokens) && c[6] === String(tot(x)); }), byModel);
      expect('usage: By-model table row cost is that model own', seeds.every((x) => ((byModel[x.model] || [])[7] || '').includes('$' + x.reportedCostUsd.toFixed(4))), byModel);
      // Cost is the only grand total: #us-cost equals the sum across models; tokens stay per-model above.
      const cost = await ex(`return { total: $('#us-cost b') ? $('#us-cost b').textContent : null, kpis: document.querySelector('.us-kpis').textContent }`);
      expect('usage: cost grand total equals the sum of per-model costs', cost.total === '$' + costTotal.toFixed(4), cost);
      expect('usage: hero cost KPI matches the grand total (2dp)', cost.kpis.includes('$' + costTotal.toFixed(2)), cost.kpis);
      // Per-run history: one row per run with its own model and cost.
      const hist = await ex(`return [...document.querySelectorAll('#us-runs tr')].slice(1).map((tr) => [...tr.cells].map((td) => td.textContent.trim()))`);
      expect('usage: run history shows one row per run with its model and cost', hist.length === seeds.length && hist.every((c) => seeds.some((x) => c[4] === x.model && (c[12].includes('$' + x.reportedCostUsd.toFixed(4)) || c[12] === '—'))), hist.map((c) => [c[4], c[12]]));
      // Header pill reads the same per-run ledger as this tab: it must agree with the grand total
      // instead of drifting (the old session-counter pill said "no cost yet" while the tab showed $0.07).
      // The old ledger pill is gone (t_bc19b2f5): the per-model keys are this tab's job now.
      const pill = await ex(`return { cost: $('#totalcost').textContent }`);
      expect('usage: header money pill matches the tab grand total (2dp)', pill.cost.includes('$' + costTotal.toFixed(2)), pill);
      await shot(`usage-permodel-${theme}`);
      // Prove the per-model table visually: it lives below the fold — scroll it into view and shoot it.
      await ex(`const h = [...document.querySelectorAll('#us-summary details h4')].find((x) => x.textContent === 'By model'); if (h) h.scrollIntoView({ block: 'center' }); await w(250);`);
      await shot(`usage-permodel-bymodel-${theme}`);
    }
    require('electron').nativeTheme.themeSource = 'system';
    const csv = (await api.usageCSV({ p: up.id })).trim().split('\n');
    expect('usage: CSV has one line per run plus the header, model named', csv.length === seeds.length + 1 && seeds.every((x) => csv.some((l) => l.includes(x.model))), csv.length);
    console.log('[gui-e2e] usage-permodel', JSON.stringify({ models: seeds.map((x) => x.model), costTotal: '$' + costTotal.toFixed(4) }));
  };
  // Existing-data scenario: a project that predates capability probing, usage limits and reasoning-effort
  // fields (nodes added straight through the store, like a real legacy project.json). Nothing here should
  // crash or silently no-op: probing still works on demand, the limit meter still shows up once the CLI's
  // own init event reports a rate limit (even with usageLimits never configured), and effort falls back to 'low'.
  const existingDataShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const p = cur.p || pid(); const ts = pm.store(p, cur.t); const s = pm.store(p); const o = orchFor(p);
    // Legacy nodes: added via the store directly (no capabilities/capabilitiesProbedAt/effort fields), the
    // same shape a project created before those features existed would have on disk.
    const pm1 = ts.addNode({ name: 'LegacyPM', role: 'PM', runtime: 'claude', model: 'opus', x: 60, y: 60 });
    const dev = ts.addNode({ name: 'LegacyDev', role: 'Dev', runtime: 'claude', model: 'sonnet', x: 320, y: 60 });
    expect('existing-data: fixture nodes start with no capabilities (never probed)', !pm1.capabilities && !dev.capabilities, { pm1: pm1.capabilities, dev: dev.capabilities });
    expect('existing-data: fixture nodes normalize to the default "low" effort (unset on input)', pm1.effort === 'low' && dev.effort === 'low', { pm1: pm1.effort, dev: dev.effort });
    expect('existing-data: settings have no usageLimits configured', JSON.stringify(s.getSettings().usageLimits) === '{}', s.getSettings().usageLimits);
    await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); await w(300);`);
    const dotBefore = await ex(`return document.querySelector('g[data-id="${pm1.id}"] .capsdot')?.getAttribute('class')`);
    expect('existing-data: legacy node graph badge starts on the untested dot', dotBefore === 'capsdot caps-none', dotBefore);
    // renderNodeForm() auto-triggers a probe for any never-probed node (see refreshCaps), so by the time we
    // read the panel it's already discovering or done - "Not probed yet" never has a chance to render here.
    await ex(`sel.node = '${pm1.id}'; renderNodeForm(); await w(200);`);
    const before = await ex(`return $('#nf-caps-view').textContent`);
    expect('existing-data: node form auto-probes a legacy node (no manual refresh needed)', !/Not probed yet/.test(before), before.slice(0, 120));
    await ex(`await w(400);`);
    const after = await ex(`return $('#nf-caps-view').textContent`);
    expect('existing-data: probe completes and shows discovered capabilities', !/Not probed yet/.test(after) && !/Discovering/.test(after), after.slice(0, 120));
    await ex(`await refresh(); renderGraph(); await w(300);`);
    const dotAfter = await ex(`return document.querySelector('g[data-id="${pm1.id}"] .capsdot')?.getAttribute('class')`);
    expect('existing-data: graph badge flips off the untested dot once probed', dotAfter !== 'capsdot caps-none', dotAfter);
    // Limits meter: no usageLimits configured, but the CLI's own init event (stubbed here) reports a
    // subscription rate-limit % — the meter must still surface that, not stay hidden just because the
    // project never had a limits config saved.
    // Default billingMode 'auto' counts as a subscription user (isSubscriptionUser in renderLimitMeter), so
    // the meter stays visible in a "pending" state rather than hidden, even with no limits config yet.
    const meterPendingBefore = await ex(`return { hidden: $('#limitmeter').classList.contains('hidden'), pending: $('#limitmeter').textContent }`);
    // The provider-chip era replaced the old "5h – no limit data" pending chips with one honest
    // "Limits: … · limits unknown" summary chip (t_bc19b2f5) — still visible, never a fabricated %.
    expect('existing-data: limit meter is hidden with no limits config and no CLI-reported rate limit yet (warning chip only)', meterPendingBefore.hidden === true, meterPendingBefore);
    o.subscriptionRateLimits = { [pm1.id]: { fiveHour: { pct: 0.42, resetsAt: new Date(Date.now() + 3600000).toISOString() } } };
    await ex(`await refresh(); await w(400);`);
    const meterQ = `{ hidden: $('#limitmeter').classList.contains('hidden'), pct: $('#limitmeter .lm-fill')?.style.width, text: $('#limitmeter').textContent }`;
    const meter = await ex(`return ${meterQ}`);
    expect('existing-data: limit meter stays hidden at a CLI-reported 42% (quiet below 80%)', meter.hidden === true, meter);
    o.subscriptionRateLimits = { [pm1.id]: { fiveHour: { pct: 0.92, resetsAt: new Date(Date.now() + 3600000).toISOString() } } };
    await ex(`await refresh(); await w(400);`);
    const meter92 = await ex(`return ${meterQ}`);
    expect('existing-data: limit warning chip appears from the CLI-reported rate limit alone at 92%', meter92.hidden === false && meter92.pct === '92%', meter92);
    o.subscriptionRateLimits = {};
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(200);`); await shot(`existingdata-limits-${t}`); }
    // Effort badge: never set on this node, so the node form must fall back to the 'low' default.
    const effortSel = await ex(`return $('#nf-effort-sel').value`);
    expect("existing-data: effort select defaults to 'low' for a node with no effort field", effortSel === 'low', effortSel);
    // Effort chips always render, even at the 'low' default (normalizeAgentConfig fills in n.effort='low' on
    // add, so these are indistinguishable from an explicit choice - no chip-default styling to check here).
    const effortChipInfo = await ex(`return [...document.querySelectorAll('#graph .chip-em')].map((g) => g.querySelector('text')?.textContent)`);
    expect('existing-data: E:low chip renders on the graph for these nodes', effortChipInfo.filter((c) => c === 'E:low').length === 2, effortChipInfo);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(200);`); await shot(`existingdata-graph-${t}`); }
    console.log('[gui-e2e] existingdata', JSON.stringify({ dotBefore, dotAfter, before: before.slice(0, 80), after: after.slice(0, 80), meterPendingBefore, meter, effortSel, effortChipInfo }));
    require('electron').nativeTheme.themeSource = 'system';
  };
  // Wiki + Logs tabs: empty states, page list + rendered markdown typography, readable log rows (time/avatar/level), filter by agent + search, auto-scroll.
  const wikiLogsShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (nodes.length < 2) { ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ps.getTeam().nodes; }
    const [a, b] = nodes;
    await ex(`$('#tabs button[data-tab=wiki]').click(); await refresh(); sel.page = null; renderWiki(); await w(300);`);
    const wempty = await ex(`return { list: $('#wikilist').textContent, view: $('#wk-empty').textContent }`);
    expect('wiki: empty state (no pages)', /No pages yet/.test(wempty.list) && /No wiki pages yet/.test(wempty.view), wempty);
    await shot('28-wiki-empty');
    await ex(`$('#tabs button[data-tab=obs]').click(); await refresh(); await w(300);`);
    const lempty = await ex(`return $('#log').textContent`);
    expect('logs: empty state (no activity)', /No activity yet/.test(lempty), lempty);
    await shot('29-logs-empty');
    ps.writeWiki('Runbook', '# Runbook\n\nHow the team operates.\n\n## Steps\n\n- Plan the work\n- Assign to Devon\n- Review before done\n\nSee [the repo](https://example.com) for more.\n\n```\nnpm test\n```\n', 'Pia');
    ps.writeWiki('Glossary', '## Terms\n\n- **PM**: plans the work\n- **Dev**: builds it\n', 'Devon');
    await ex(`await refresh(); renderWiki(); await w(300);`);
    const wlist = await ex(`return document.querySelectorAll('#wikilist div[data-t]').length`);
    expect('wiki: page list populated', wlist === 2, wlist);
    await ex(`document.querySelector('#wikilist div[data-t="Runbook"]').click(); await w(300);`);
    const wview = await ex(`return { h1: document.querySelectorAll('#wk-view h1').length, h2: document.querySelectorAll('#wk-view h2').length, li: document.querySelectorAll('#wk-view li').length, ul: document.querySelectorAll('#wk-view ul').length, a: document.querySelectorAll('#wk-view a').length, pre: document.querySelectorAll('#wk-view pre').length }`);
    expect('wiki: rendered markdown has headings, list, link, code block', wview.h1 === 1 && wview.h2 === 1 && wview.li >= 3 && wview.ul >= 1 && wview.a === 1 && wview.pre === 1, wview);
    const L = (ago, nodeId, kind, text) => `logs.push({ projectId: ctx.p, nodeId: '${nodeId}', kind: '${kind}', text: ${JSON.stringify(text)}, at: Date.now() - ${ago} });`;
    await ex(`$('#tabs button[data-tab=obs]').click(); ${L(90000, a.id, 'system', '▶ ' + a.name + ' starts "Runbook" in /x')}${L(80000, a.id, 'text', 'Planning the steps.')}${L(70000, b.id, 'tool', 'Write {"file_path":"color.txt"}')}${L(60000, b.id, 'error', 'ENOENT: no such file')}
      await refresh(); renderLog(); await w(300);`);
    const rows = await ex(`return document.querySelectorAll('#log .logrow').length`);
    expect('logs: readable rows rendered for all agents', rows === 4, rows);
    await shot('30-logs-rows');
    await ex(`$('#logfilter').value = '${b.id}'; $('#logfilter').dispatchEvent(new Event('change')); await w(200);`);
    const filtered = await ex(`return document.querySelectorAll('#log .logrow').length`);
    expect('logs: filter by agent narrows rows', filtered === 2, filtered);
    await ex(`$('#logfilter').value = ''; $('#logfilter').dispatchEvent(new Event('change')); $('#logsearch').value = 'ENOENT'; $('#logsearch').dispatchEvent(new Event('input')); await w(200);`);
    const searched = await ex(`return { rows: document.querySelectorAll('#log .logrow').length, err: !!document.querySelector('#log .logrow.lv-error') }`);
    expect('logs: search narrows rows and error level is coloured', searched.rows === 1 && searched.err, searched);
    await ex(`$('#logsearch').value = ''; $('#logsearch').dispatchEvent(new Event('input')); await w(200);`);
    const gp2 = cur.p || pid(); const other = pm.createTeam(gp2, 'Logs peers'); const otherId = other.id || other; const os = pm.store(gp2, otherId); const peer = os.addNode({ name: 'Peer', role: 'Dev', x: 60, y: 60 });
    await ex(`logs.push({ projectId: ctx.p, nodeId: '${peer.id}', kind: 'text', text: 'Peer team activity.', at: Date.now() - 5000 }); await refresh(); renderObs(); renderLog(); await w(200);`);
    const teamOpts = await ex(`return [...document.querySelectorAll('#logteam option')].map((o) => o.textContent)`);
    expect('logs: team filter lists all teams', teamOpts.includes('All teams') && teamOpts.includes('Logs peers'), teamOpts);
    await ex(`$('#logteam').value = '${otherId}'; $('#logteam').dispatchEvent(new Event('change')); await w(200);`);
    const teamFiltered = await ex(`return { agents: document.querySelectorAll('#logagents .logagent-row[data-id]').length, opts: document.querySelectorAll('#logfilter option').length, rows: document.querySelectorAll('#log .logrow').length }`);
    expect('logs: team filter narrows agent list and rows to that team', teamFiltered.agents === 2 && teamFiltered.opts === 2 && teamFiltered.rows === 1, teamFiltered);
    await ex(`$('#logteam').value = ''; $('#logteam').dispatchEvent(new Event('change')); await w(200);`);
    for (const t of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = t;
      await ex(`$('#tabs button[data-tab=wiki]').click(); await w(300);`); await shot(`wiki-${t}`);
      await ex(`$('#tabs button[data-tab=obs]').click(); await w(300);`); await shot(`logs-${t}`);
    }
    require('electron').nativeTheme.themeSource = 'system';
    console.log('[gui-e2e] wikilogs', JSON.stringify({ wempty, lempty, wlist, wview, rows, filtered, searched }));
  };
  // Team filter for Logs (t_cb945259, plan t_db23070d): 2 teams (Alpha, Beta) plus a cross-team message
  // logged under the recipient (Beta's dev, sent by Alpha's PM). With per-team log scope (t_8d3d6989)
  // the log defaults to the current team's lines and "All teams" is the explicit lift. Checks: the
  // default scope shows only the current team; All teams shows every line; selecting a team hides other
  // teams' lines and narrows #logfilter to that team's agents; a cross-team message renders only on the
  // recipient's team side (the sender's team does not mirror it); changing team resets an out-of-scope
  // agent filter; a team with no activity shows a dedicated empty state. The #logteam select is
  // feature-detected (Uma's t_86da3a0b) — logged as pending until then.
  const teamFilterShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const gp = cur.p || pid(); const alpha = pm.store(gp, cur.t);
    pm.renameTeam(gp, cur.t, 'Alpha');
    const pmA = alpha.getTeam().nodes[0] || alpha.addNode({ name: 'AlphaPM', role: 'PM', x: 60, y: 60 });
    const devA = alpha.addNode({ name: 'AlphaDev', role: 'Dev', x: 260, y: 60 });
    const beta = pm.createTeam(gp, 'Beta'); const betaId = beta.id || beta; const bs = pm.store(gp, betaId);
    const devB = bs.addNode({ name: 'BetaDev', role: 'Dev', x: 60, y: 60 });
    const revB = bs.addNode({ name: 'BetaRev', role: 'Reviewer', x: 260, y: 60 });
    alpha.addEdge(pmA.id, devB.id, 'message'); // cross-team edge: Alpha's PM can message Beta's dev
    await ex(`switchTo({ p: '${gp}', t: '${cur.t}' }); await refresh(); $('#tabs button[data-tab=obs]').click(); await w(300);`);
    const now = Date.now();
    const L = (nodeId, text, ago = 0) => ({ projectId: gp, nodeId, kind: 'text', text, at: now - ago });
    const fixture = [
      L(pmA.id, 'AlphaPM: planning the sprint', 5000), L(devA.id, 'AlphaDev: writing the feature', 4000),
      L(devB.id, 'BetaDev: reviewing the spec', 3000), L(revB.id, 'BetaRev: left comments', 2000),
      L(devB.id, "✉ message from AlphaPM (cross-team): please prioritise the spec review", 1000),
    ];
    await ex(`const F = ${JSON.stringify(fixture)}; for (const l of F) logs.push(l); await refresh(); renderLog(); renderObs(); await w(300);`);
    const has = (sels) => ex(`return ${JSON.stringify(sels)}.find((s) => document.querySelector(s)) || null`);
    const teamSel = await has(['#logteam', '#log-team', '[data-log=team]']);
    if (!teamSel) { console.log('[gui-e2e] teamfilter: #logteam UI pending (Uma t_86da3a0b)'); return; }
    const rowsText = () => ex(`return [...document.querySelectorAll('#log .logrow .logtext')].map((r) => r.textContent)`);
    const selectTeam = (name) => ex(`const s = $('${teamSel}'); const o = [...s.options].find((x) => new RegExp('${name}', 'i').test(x.textContent)); s.value = o.value; s.dispatchEvent(new Event('change')); await w(250);`);
    // Per-team log scope (t_8d3d6989): switchTo scopes the log to the current team, so the default view
    // is Alpha-only, and "All teams" is the explicit way to see every line.
    const scoped = await rowsText();
    expect('teamfilter: log scope defaults to the current team (Alpha only)', scoped.some((r) => r.includes('AlphaPM: planning')) && scoped.some((r) => r.includes('AlphaDev: writing')) && !scoped.some((r) => r.includes('BetaDev: reviewing')) && !scoped.some((r) => r.includes('BetaRev: left')), scoped);
    await shot('teamfilter-default');
    await selectTeam('all');
    const all = await rowsText();
    expect('teamfilter: All teams shows every team\'s line', fixture.every((l) => all.some((r) => r.includes(l.text.slice(0, 15)))), { all });
    await shot('teamfilter-all');
    const teamOptions = await ex(`return [...document.querySelectorAll('${teamSel} option')].map((o) => o.textContent.trim())`);
    expect('teamfilter: select lists All teams + Alpha + Beta', /all/i.test(teamOptions[0] || '') && teamOptions.some((t) => /alpha/i.test(t)) && teamOptions.some((t) => /beta/i.test(t)), teamOptions);
    // Select Beta: hides Alpha-only lines, keeps Beta's own, narrows the agent filter to Beta's agents,
    // and shows the cross-team message (it is logged under Beta's dev — the recipient side).
    await selectTeam('beta');
    const betaRows = await rowsText();
    const betaAgentOpts = await ex(`return [...document.querySelectorAll('#logfilter option')].map((o) => o.textContent.trim())`);
    expect('teamfilter: Beta hides Alpha-only lines', !betaRows.some((r) => r.includes('AlphaDev: writing')) && !betaRows.some((r) => r.includes('AlphaPM: planning')), betaRows);
    expect('teamfilter: Beta keeps Beta\'s own lines', betaRows.some((r) => r.includes('BetaDev: reviewing')) && betaRows.some((r) => r.includes('BetaRev: left')), betaRows);
    expect('teamfilter: Beta narrows agent filter to Beta agents', betaAgentOpts.some((o) => /BetaDev/.test(o)) && betaAgentOpts.some((o) => /BetaRev/.test(o)) && !betaAgentOpts.some((o) => /AlphaDev/.test(o)), betaAgentOpts);
    expect('teamfilter: cross-team message visible from the recipient (Beta) side', betaRows.some((r) => r.includes('cross-team')), betaRows);
    await shot('teamfilter-beta');
    // Select Alpha: Beta-only lines are hidden, and the cross-team message is NOT mirrored here — it is
    // logged under the recipient, so per-team scope keeps it on the Beta side only.
    await selectTeam('alpha');
    const alphaRows = await rowsText();
    expect('teamfilter: Alpha hides Beta-only lines', !alphaRows.some((r) => r.includes('BetaRev: left')) && !alphaRows.some((r) => r.includes('BetaDev: reviewing')), alphaRows);
    expect('teamfilter: cross-team message stays on the recipient (Beta) side, not mirrored to Alpha', alphaRows.some((r) => r.includes('AlphaPM: planning')) && !alphaRows.some((r) => r.includes('cross-team')), alphaRows);
    await shot('teamfilter-alpha');
    // Agent filter resets to All when the previously selected agent isn't in the newly selected team.
    await ex(`$('#logfilter').value = '${devB.id}'; $('#logfilter').dispatchEvent(new Event('change')); await w(150);`);
    await selectTeam('alpha');
    const resetVal = await ex(`return $('#logfilter').value`);
    expect('teamfilter: agent filter resets to All on an invalid team/agent combo', resetVal === '', resetVal);
    // Empty state: a freshly created team with no activity shows a dedicated message, not a generic one.
    const gamma = pm.createTeam(gp, 'Gamma'); await ex(`await refresh();`); await selectTeam('gamma');
    const emptyMsg = await ex(`return $('#log').textContent`);
    expect('teamfilter: empty team shows a team-specific empty state', /no messages for this team/i.test(emptyMsg), emptyMsg);
    await shot('teamfilter-empty');
    // All restores everything.
    await selectTeam('all');
    const restored = await rowsText();
    expect('teamfilter: All restores every line', fixture.every((l) => restored.some((r) => r.includes(l.text.slice(0, 15)))), { restored });
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await selectTeam('beta'); await ex(`await w(300);`); await shot(`teamfilter-${t}`); }
    require('electron').nativeTheme.themeSource = 'system'; await selectTeam('all');
    console.log('[gui-e2e] teamfilter', JSON.stringify({ teamOptions, betaAgentOpts, resetVal }));
  };
  // Team scoping for Chat & Board (t_ee2482f9, plan t_38c2a918): 2 teams (Alpha, Beta) plus an empty
  // Gamma. Seeded tasks/messages prove each view shows only the selected team's items, "All teams"
  // lifts the scope with no badges, cross-team items (counterparty in another team) show that team's
  // name as a badge, a sidebar switch resets the filter to the new team, the Team graph still renders
  // the selected team's roster, and an empty team shows team-scoped empty states. Select contract
  // (Critic, final): #boardteam / #chatteam exactly — a missing select FAILS the run, never passes
  // vacuously; badges are data-testid="team-badge" elements naming the other team.
  const teamScopeShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const gp = cur.p || pid();
    let alphaId = cur.t; if (!alphaId) { const t0 = pm.createTeam(gp, 'Alpha'); alphaId = t0.id || t0; }
    const alpha = pm.store(gp, alphaId); pm.renameTeam(gp, alphaId, 'Alpha');
    if (!alpha.getTeam().nodes.some((n) => n.role === 'PM')) alpha.addNode({ name: 'Ann', role: 'PM', x: 60, y: 60 });
    if (alpha.getTeam().nodes.length < 2) alpha.addNode({ name: 'Ari', role: 'Dev', x: 260, y: 60 });
    const an = alpha.getTeam().nodes; const pmA = an.find((n) => n.role === 'PM'); const devA = an.find((n) => n.id !== pmA.id);
    const betaT = pm.createTeam(gp, 'Beta'); const betaId = betaT.id || betaT; const bs = pm.store(gp, betaId);
    const pmB = bs.addNode({ name: 'Ben', role: 'PM', x: 60, y: 60 }); const devB = bs.addNode({ name: 'Bea', role: 'Dev', x: 260, y: 60 });
    const gammaT = pm.createTeam(gp, 'Gamma'); const gammaId = gammaT.id || gammaT;
    const ps = pm.store(gp); // board + messages are project-wide; scoping keys off each item's participants' teams
    ps.createTask({ title: 'Scope Alpha deliverable', assignee: devA.id, createdBy: pmA.id });
    ps.createTask({ title: 'Scope Beta deliverable', assignee: devB.id, createdBy: pmB.id });
    ps.createTask({ title: 'Scope cross handoff AB', assignee: devA.id, createdBy: pmB.id }); // Alpha card, badge Beta
    ps.createTask({ title: 'Scope cross handoff BA', assignee: devB.id, createdBy: pmA.id }); // Beta card, badge Alpha
    ps.sendMessage({ from: pmA.id, to: devA.id, text: 'Alpha standup notes for Ari' });
    ps.sendMessage({ from: pmB.id, to: devB.id, text: 'Beta standup notes for Bea' });
    ps.sendMessage({ from: pmA.id, to: devB.id, text: 'Please prioritise the spec review' }); // cross-team: badge on both sides
    await ex(`await refresh(); await w(300);`);
    // Critic contract, final (t_38c2a918): the selects ARE #boardteam / #chatteam (same shape as
    // #logteam — "All teams" first with value '', other options value = team id). A missing select
    // must FAIL the run; there is no pending pass-through.
    const bsel = '#boardteam'; const csel = '#chatteam';
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(300); $('#tabs button[data-tab=board]').click(); await w(400);`);
    const present = await ex(`return { b: !!$('${bsel}'), c: !!$('${csel}') }`);
    expect('teamscope: #boardteam and #chatteam selects exist (Critic contract)', present.b && present.c, present);
    if (!(present.b && present.c)) return;
    const opt0 = await ex(`const f = (id) => { const o = ($(id).options || [])[0] || {}; return { t: o.textContent, v: o.value }; }; return { b: f('${bsel}'), c: f('${csel}') }`);
    expect('teamscope: both selects list All teams first with an empty value', /all/i.test(opt0.b.t || '') && opt0.b.v === '' && /all/i.test(opt0.c.t || '') && opt0.c.v === '', opt0);
    // Read through the DOM only — the suite must pass via the real sidebar/select event path, never a forced re-render.
    const badgeSel = '[data-testid="team-badge"]';
    const boardState = () => ex(`const s = $('${bsel}');
      return { opt: ([...s.options].find((o) => o.selected) || {}).textContent, tab: $('#tab-board').textContent,
        titles: [...document.querySelectorAll('#columns .card > b')].map((b) => b.textContent),
        cards: [...document.querySelectorAll('#columns .card')].map((c) => ({ t: (c.querySelector('b') || {}).textContent, badge: (c.querySelector('${badgeSel}') || {}).textContent || null })),
        badges: document.querySelectorAll('#columns ${badgeSel}').length }`);
    const chatState = () => ex(`const s = $('${csel}');
      return { opt: ([...s.options].find((o) => o.selected) || {}).textContent, tab: $('#tab-chat').textContent,
        text: $('#chat-room').textContent,
        bubbles: [...document.querySelectorAll('#chat-room .bubble')].map((b) => ({ text: b.textContent.slice(0, 120), badge: (b.querySelector('${badgeSel}') || {}).textContent || null })),
        badges: document.querySelectorAll('#chat-room ${badgeSel}').length }`);
    const pickTeam = (sel, name) => ex(`const s = $('${sel}'); const o = [...s.options].find((x) => new RegExp('${name}', 'i').test(x.textContent)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); } await w(300); return o ? o.textContent.trim() : null`);
    const sideTeam = (tid) => ex(`document.querySelector('#teamlist [data-tid="${tid}"]').click(); await w(700); await refresh(); await w(300);`);
    // Board: default = sidebar team (Alpha), only Alpha-assignee tasks, badge on the cross-team card.
    let B = await boardState();
    expect('teamscope: board filter defaults to the sidebar team (Alpha)', /alpha/i.test(B.opt || ''), B.opt);
    expect('teamscope: Alpha board shows only Alpha-assignee tasks', B.titles.includes('Scope Alpha deliverable') && B.titles.includes('Scope cross handoff AB') && !B.titles.includes('Scope Beta deliverable') && !B.titles.includes('Scope cross handoff BA'), B.titles);
    const xCard = B.cards.find((c) => c.t === 'Scope cross handoff AB'); const aCard = B.cards.find((c) => c.t === 'Scope Alpha deliverable');
    expect('teamscope: cross-team card (created by Beta) shows a Beta badge', !!xCard && xCard.badge === 'Beta', xCard && xCard.badge);
    expect('teamscope: in-team card shows no team badge', !!aCard && aCard.badge == null, aCard && aCard.badge);
    await shot('teamscope-board-alpha');
    await pickTeam(bsel, 'beta');
    B = await boardState();
    expect('teamscope: board filter Beta shows only Beta-assignee tasks', B.titles.includes('Scope Beta deliverable') && B.titles.includes('Scope cross handoff BA') && !B.titles.includes('Scope Alpha deliverable') && !B.titles.includes('Scope cross handoff AB'), B.titles);
    const yCard = B.cards.find((c) => c.t === 'Scope cross handoff BA');
    expect('teamscope: Beta-side cross-team card shows an Alpha badge', !!yCard && yCard.badge === 'Alpha', yCard && yCard.badge);
    await shot('teamscope-board-beta');
    await pickTeam(bsel, 'all');
    B = await boardState();
    expect('teamscope: board All teams shows every task', ['Scope Alpha deliverable', 'Scope Beta deliverable', 'Scope cross handoff AB', 'Scope cross handoff BA'].every((t) => B.titles.includes(t)), B.titles);
    expect('teamscope: All teams board shows no team badges', B.badges === 0, B.badges);
    await shot('teamscope-board-all');
    // Sidebar switch: the filter follows the team (Beta), board re-scopes without touching the select.
    await sideTeam(betaId);
    B = await boardState();
    expect('teamscope: sidebar switch resets the board filter to that team', /beta/i.test(B.opt || ''), B.opt);
    expect('teamscope: Beta board shows only Beta-assignee tasks after the switch', B.titles.includes('Scope Beta deliverable') && B.titles.includes('Scope cross handoff BA') && !B.titles.includes('Scope Alpha deliverable') && !B.titles.includes('Scope cross handoff AB'), B.titles);
    // Chat: same contract on messages (sender OR receiver in team; badge names the other side).
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(600);`);
    let C = await chatState();
    expect('teamscope: chat filter defaults to the sidebar team (Beta)', /beta/i.test(C.opt || ''), C.opt);
    expect('teamscope: Beta chat shows only Beta conversations', C.text.includes('Beta standup notes') && C.text.includes('Please prioritise the spec review') && !C.text.includes('Alpha standup notes'), C.text.slice(0, 400));
    const xB = C.bubbles.find((b) => b.text.includes('spec review'));
    expect('teamscope: cross-team message in Beta shows an Alpha badge', !!xB && xB.badge === 'Alpha', xB && xB.badge);
    await shot('teamscope-chat-beta');
    await sideTeam(alphaId);
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(400);`);
    C = await chatState();
    expect('teamscope: Alpha chat shows only Alpha conversations', C.text.includes('Alpha standup notes') && C.text.includes('Please prioritise the spec review') && !C.text.includes('Beta standup notes'), C.text.slice(0, 400));
    const xA = C.bubbles.find((b) => b.text.includes('spec review'));
    expect('teamscope: cross-team message in Alpha shows a Beta badge', !!xA && xA.badge === 'Beta', xA && xA.badge);
    await shot('teamscope-chat-alpha');
    await pickTeam(csel, 'all');
    C = await chatState();
    expect('teamscope: chat All teams shows every conversation', C.text.includes('Alpha standup notes') && C.text.includes('Beta standup notes') && C.text.includes('Please prioritise the spec review'), null);
    expect('teamscope: All teams chat shows no team badges', C.badges === 0, C.badges);
    await shot('teamscope-chat-all');
    // Team graph unchanged: it still renders exactly the selected team's roster, whatever the filters say.
    await ex(`$('#tabs button[data-tab=team]').click(); await w(700);`);
    const roster = alpha.getTeam().nodes.map((n) => n.name);
    const g = await ex(`return [...document.querySelectorAll('#graph .node')].map((x) => x.textContent)`);
    expect('teamscope: team graph unchanged (renders the selected team\'s roster)', g.length === roster.length && roster.every((nm) => g.join(' ').includes(nm)), { g, roster });
    await shot('teamscope-graph');
    // Empty team last: no cards, team-scoped empty state in both views.
    await sideTeam(gammaId);
    await ex(`$('#tabs button[data-tab=board]').click(); await w(400);`);
    B = await boardState();
    expect('teamscope: empty team board shows no cards and the team empty state', B.titles.length === 0 && /no tasks for this team/i.test(B.tab), { titles: B.titles, hit: (B.tab.match(/no tasks[^.]*\./i) || [])[0] });
    await shot('teamscope-board-empty');
    await ex(`$('#tabs button[data-tab=chat]').click(); await w(500);`);
    C = await chatState();
    expect('teamscope: empty team chat shows the team empty state', /no messages for this team/i.test(C.tab), (C.tab.match(/no messages[^.]*\./i) || [])[0] || C.tab.slice(0, 200));
    await shot('teamscope-chat-empty');
    await sideTeam(alphaId);
    console.log('[gui-e2e] teamscope', JSON.stringify({ alpha: alphaId, beta: betaId, gamma: gammaId }));
  };
  // Realistic Logs/Wiki fixture (t_2f1aa27f): 20 agents, 30+ wiki pages, 500+ log lines spread across 3
  // sessions per agent. Proves the log pane scrolls and reads as multi-turn conversations per agent
  // ("session" = clicking an agent in #logagents filters #log to just its lines), the wiki page list and
  // search work at scale, and a fresh team still shows the empty states.
  const mainLogsWikiShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    // Belt-and-suspenders: dismiss the onboarding card so it can't cover the log/wiki pane in the shots below.
    await ex(`if (!$('#guide').classList.contains('hidden') && $('#g-close')) $('#g-close').click(); await w(200);`);
    const gp = cur.p || pid(); const ps = pm.store(gp, cur.t);
    const roles = ['PM', 'Dev', 'Dev', 'Dev', 'Reviewer', 'Critic'];
    for (let i = ps.getTeam().nodes.length; i < 20; i++) ps.addNode({ name: `LWAgent ${i + 1}`, role: roles[i % roles.length], x: 40 + (i % 5) * 200, y: 40 + Math.floor(i / 5) * 120 });
    const nodes = ps.getTeam().nodes.slice(0, 20);
    for (let i = 0; i < 32; i++) ps.writeWiki(`Runbook ${i + 1}`, `# Runbook ${i + 1}\n\nStep-by-step notes for scenario ${i + 1}.\n\n- Plan\n- Build\n- Review\n`, nodes[i % nodes.length].name);
    const kinds = ['text', 'tool', 'tool_result', 'error'];
    const logData = [];
    for (const node of nodes) {
      for (let session = 0; session < 3; session++) {
        logData.push({ nodeId: node.id, kind: 'system', text: `▶ ${node.name} starts session ${session + 1}` });
        for (let line = 1; line < 9; line++) {
          const kind = kinds[(line + session) % kinds.length];
          logData.push({ nodeId: node.id, kind, text: `[session ${session + 1}] ${kind} turn ${line}: ${kind === 'error' ? 'ENOENT: missing fixture' : kind === 'tool' ? 'Read {"file_path":"notes.txt"}' : kind === 'tool_result' ? '42 lines' : 'Working through step ' + line + '.'}` });
        }
      }
    }
    logData.forEach((d, i) => { d.at = Date.now() - (logData.length - i) * 1000; });
    expect('logs fixture has 500+ lines across 20 agents x 3 sessions', logData.length >= 500, logData.length);
    await ex(`$('#tabs button[data-tab=obs]').click(); const D = ${JSON.stringify(logData)}; for (const d of D) logs.push({ projectId: ctx.p, ...d }); await refresh(); renderLog(); renderObs(); await w(400);`);
    const agents = await ex(`return document.querySelectorAll('#logagents .logagent-row[data-id]').length`);
    expect('logs: sidebar lists all 20 agents (+ All agents)', agents === 21, agents);
    const overview = await ex(`const box = $('#log'); return { rows: document.querySelectorAll('#log .logrow').length, scrolls: box.scrollHeight > box.clientHeight }`);
    expect('logs: pane shows 20+ lines and scrolls', overview.rows > 20 && overview.scrolls, overview);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(300);`); await shot(`main-logs-${t}`); }
    const target = nodes[3];
    await ex(`document.querySelector('#logagents .logagent-row[data-id="${target.id}"]').click(); await w(300);`);
    const session = await ex(`return { sel: document.querySelector('#logagents .logagent-row.sel')?.dataset.id, rows: [...document.querySelectorAll('#log .logrow')].map((r) => r.querySelector('.logtext').textContent) }`);
    expect('logs: clicking an agent opens just its own session conversation (27 lines, 3 "starts session")', session.sel === target.id && session.rows.length === 27 && session.rows.filter((r) => /starts session/.test(r)).length === 3, { sel: session.sel, count: session.rows.length, starts: session.rows.filter((r) => /starts session/.test(r)).length });
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(300);`); await shot(`main-logs-session-${t}`); }
    await ex(`$('#logagents .logagent-row[data-id=""]').click(); await w(200);`);
    await ex(`$('#tabs button[data-tab=wiki]').click(); await refresh(); sel.page = null; renderWiki(); await w(300);`);
    const wlist = await ex(`return document.querySelectorAll('#wikipages div[data-t]').length`);
    expect('wiki: page list has 30+ pages', wlist >= 30, wlist);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(300);`); await shot(`main-wiki-${t}`); }
    await ex(`$('#wk-search').value = 'Runbook 7'; $('#wk-search').dispatchEvent(new Event('input')); await w(200);`);
    const searched = await ex(`return document.querySelectorAll('#wikipages div[data-t]').length`);
    expect('wiki: search narrows the page list (title match)', searched >= 1 && searched < wlist, { searched, wlist });
    await ex(`$('#wk-search').value = 'no such page anywhere'; $('#wk-search').dispatchEvent(new Event('input')); await w(200);`);
    const noMatch = await ex(`return { count: document.querySelectorAll('#wikipages div[data-t]').length, msg: $('#wikipages').textContent }`);
    expect('wiki: search with no results shows a no-match empty state', noMatch.count === 0 && /No pages match/.test(noMatch.msg), noMatch);
    await ex(`$('#wk-search').value = ''; $('#wk-search').dispatchEvent(new Event('input')); await w(200);`);
    require('electron').nativeTheme.themeSource = 'system';
    // Wiki (and logs) are project-scoped, not team-scoped, so the empty state needs a brand-new project.
    const emptyProject = pm.create('Fresh project');
    await ex(`switchTo({ p: '${emptyProject.id}' }); await w(300); $('#tabs button[data-tab=wiki]').click(); await refresh(); sel.page = null; renderWiki(); await w(300);`);
    const wempty = await ex(`return { list: $('#wikipages').textContent, view: $('#wk-view').textContent }`);
    expect('wiki: fresh team shows the empty state', /No pages yet/.test(wempty.list) && /No wiki pages yet/.test(wempty.view), wempty);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(300);`); await shot(`main-wiki-empty-${t}`); }
    require('electron').nativeTheme.themeSource = 'system';
    await ex(`switchTo(${JSON.stringify(cur.p ? cur : { p: gp })}); await w(300);`);
    console.log('[gui-e2e] mainlogswiki', JSON.stringify({ agents, overview, wlist, searched, noMatch: noMatch.count, wempty }));
  };
  // Logs view design evidence (t_e503dd78): 7 agents with distinct runtime/model lines, 40+ seeded log
  // lines carrying taskId+task, live orchestrator statuses. Asserts agent rows show a status line with a
  // short task id, an ellipsizing muted model line, a labelled count badge, hover-only actions, a
  // segmented level control and an Auto-scroll switch — then screenshots light+dark at 1440x900.
  const logsDesignShots = async () => {
    win.setSize(1440, 900);
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cp = pm.create('Logs design'); const ds = pm.store(cp.id);
    const spec = [['Pia', 'PM', 'claude', 'opus'], ['Devon', 'Dev', 'claude', 'sonnet'], ['Dana', 'Dev', 'codex', 'gpt-5.3-codex'], ['Rex', 'Reviewer', 'claude', 'haiku'], ['Cy', 'Critic', 'helpycode', ''], ['Mia', 'Dev', 'opencode', 'gpt-5'], ['Leo', 'Researcher', 'claude', 'opusplan']];
    for (const [n, r, rt, m] of spec) ds.addNode({ name: n, role: r, x: 40, y: 40, runtime: rt, model: m });
    const teamId = pm.get(cp.id).teams[0].id; // store.getTeam() on an unbound store has no id — bind explicitly
    const ns = ds.getTeam().nodes;
    const titles = ['Logs view: agent list clips model chips', 'Filter chips: one segmented control style', 'Orchestration is wasteful when every retry re-reads the whole repository', 'Wake-on-message sweep floods idle agents'];
    const tasks = titles.map((t, i) => ds.createTask({ title: t, assignee: ns[i + 1].id }));
    const kinds = [['text', 'Planning the steps.'], ['tool', 'Read {"file_path":"app/renderer/style.css"}'], ['tool_result', '42 lines'], ['text', 'Editing the agent rows now.'], ['tool', 'Edit {"filePath":"app/renderer/app.js"}'], ['error', 'ENOENT: no such file or directory, open missing.txt']];
    const logData = [];
    ns.forEach((n, i) => { const tk = tasks[i % tasks.length];
      logData.push({ nodeId: n.id, kind: 'system', taskId: tk.id, task: tk.title, text: `▶ ${n.name} starts "${tk.title}" in /repo` });
      for (let line = 0; line < 5; line++) { const [kind, txt] = kinds[(line + i) % kinds.length]; logData.push({ nodeId: n.id, kind, taskId: tk.id, task: tk.title, text: txt }); } });
    logData.forEach((d, i) => { d.at = Date.now() - (logData.length - i) * 45000; });
    // Live working/idle states through the REAL orchestrator (not renderer injection): refresh() rebuilds
    // S.orch from getAll on every pass, so injected agent state would be wiped before the shots.
    const orch = orchFor(cp.id);
    [[ns[0], tasks[0]], [ns[1], tasks[1]], [ns[2], tasks[2]]].forEach(([n, tk]) => { const a = orch.agent(n.id); a.status = 'working'; a.taskId = tk.id; a.task = tk.title; });
    for (const n of [ns[3], ns[4], ns[5], ns[6]]) orch.agent(n.id).status = 'idle';
    await ex(`await switchTo({ p: '${cp.id}', t: '${teamId}' }); await w(400); const D = ${JSON.stringify(logData)}; for (const d of D) logs.push({ projectId: ctx.p, ...d });
      $('#tabs button[data-tab=obs]').click(); await refresh(); renderObs(); renderLog(); await w(400);`);
    const got = await ex(`const mo = [...document.querySelectorAll('#logagents .lamodel')]; const st = [...document.querySelectorAll('#logagents .lastat')];
      return { rows: document.querySelectorAll('#log .logrow').length, chips: document.querySelectorAll('#log .logtask').length, ids: [...document.querySelectorAll('#log .logtask')].slice(0, 3).map((d) => d.textContent),
        ltid: !!document.querySelector('#logagents .ltid'), count: !!document.querySelector('#logagents .lacount'),
        ellModel: mo.length && mo.every((d) => getComputedStyle(d).textOverflow === 'ellipsis'), ellStat: st.length && st.every((d) => getComputedStyle(d).textOverflow === 'ellipsis'),
        actHidden: getComputedStyle(document.querySelector('#logagents .logagent-row[data-id]:not([data-id=""]) .lactions')).opacity === '0',
        seg: !!document.querySelector('#loglevels .lvchip .dot'), ckGone: !document.querySelector('#loglevels .ck'), sw: !!document.querySelector('.asswitch .sw'), nativeCb: !!document.querySelector('.asswitch input[type=checkbox]') }`);
    expect('logsdesign: 30+ log lines rendered', got.rows >= 30, got.rows);
    expect('logsdesign: every seeded line carries a short task id chip', got.chips >= 30, got.chips);
    expect('logsdesign: chips render as t_xxxx', got.ids.every((s) => /^t_[0-9a-f]{4}$/.test(s)), got.ids);
    expect('logsdesign: status line with task id; model/status lines ellipsize cleanly', got.ltid && got.ellModel && got.ellStat, { ltid: got.ltid, ellModel: got.ellModel, ellStat: got.ellStat });
    expect('logsdesign: count badge, hover-only actions, segmented level control (no check glyph), Auto-scroll switch', got.count && got.actHidden && got.seg && got.ckGone && got.sw && got.nativeCb, got);
    for (const theme of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = theme; await ex(`await w(400);`);
      await shot(`logs-design-${theme}`);
      const side = await ex(`const b = $('#logagents').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }`);
      fs.writeFileSync(path.join(out, `logs-design-agents-${theme}.png`), (await win.capturePage(side)).toPNG());
    }
    // Hover a working agent: ⏹/✉ fade in.
    require('electron').nativeTheme.themeSource = 'dark';
    const hv = await ex(`const r = document.querySelector('#logagents .logagent-row[data-id="${ns[1].id}"]').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: hv[0], y: hv[1] });
    await new Promise((r) => setTimeout(r, 300));
    expect('logsdesign: actions visible on hover', await ex(`return getComputedStyle(document.querySelector('#logagents .logagent-row[data-id="${ns[1].id}"] .lactions')).opacity`) === '1');
    await shot('logs-design-agents-hover-dark');
    require('electron').nativeTheme.themeSource = 'system';
    console.log('[gui-e2e] logsdesign', JSON.stringify(got));
  };
  // Polish shots: graph at zoom 0.4 and 1.0 plus the sidebar, for both teams, light+dark. Node names must stay >= 11px on screen at 0.4.
  const polishShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const gp = cur.p || pid(); const ps = pm.store(gp, cur.t); const other = pm.createTeam(gp, 'Polish peers'); const os = pm.store(gp, other.id || other);
    for (let i = ps.getTeam().nodes.length; i < 8; i++) ps.addNode({ name: `Agent ${i + 1}`, role: i ? 'Dev' : 'PM', x: 40 + (i % 4) * 220, y: 40 + Math.floor(i / 4) * 130 });
    for (let i = 0; i < 4; i++) os.addNode({ name: `Peer ${i + 1}`, role: i ? 'Dev' : 'PM', x: 40 + i * 220, y: 60 });
    const teams = [cur.t || ps.getTeam().id, other.id || other];
    for (const [ti, tid] of teams.entries()) {
      await ex(`switchTo({ p: '${gp}', t: '${tid}' }); await w(300); $('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); await w(500);`);
      for (const z of [0.4, 1]) {
        // On-screen font of the smallest visible node name: CSS font-size x the SVG screen scale.
        const px = await ex(`const r = $('#graph').getBoundingClientRect(); VP = { x: 20, y: 20, zoom: ${z} }; applyVP(); await w(300);
          const ts = [...document.querySelectorAll('#graph .node .nname, #graph .ghost .nname')].filter((t) => { const b = t.getBoundingClientRect(); return b.width && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom; });
          return ts.length ? Math.min(...ts.map((t) => parseFloat(getComputedStyle(t).fontSize) * t.getScreenCTM().a)) : 0`);
        if (z === 0.4) expect(`polish: team ${ti + 1} node label >= 11px on screen at zoom 0.4`, px >= 11, { px });
        for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(400); VP = { x: 20, y: 20, zoom: ${z} }; applyVP();`); await shot(`28-polish-team${ti + 1}-zoom${z * 100}-${t}`); }
      }
      for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(400);`); fs.writeFileSync(path.join(out, `29-polish-sidebar-team${ti + 1}-${t}.png`), (await win.capturePage(await ex(`const b = $('#sidebar').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }`))).toPNG()); }
    }
    expect('polish: sidebar lists both teams', await ex(`return document.querySelectorAll('#teamlist [data-tid]').length >= 2`));
    require('electron').nativeTheme.themeSource = 'system'; await ex(`VP = { x: 20, y: 20, zoom: 1 }; applyVP();`); ps.setViewport({}); os.setViewport({});
  };
  // Critique evidence (t_110eda30): 24 agents in one team (the scale design/critique-views.md must-fix #2
  // demands) plus 3 small peer teams for cross-team edges, at 1440x900. Shots of Overview, Timeline, Logs,
  // Wiki and the Graph editor in light+dark. Checks: node names stay >=11px on screen at fit-to-view, or a
  // LOD collapsed-frame fallback is shown instead; edge stroke contrast is >=3:1 (WCAG 1.4.11); the minimap
  // hides once the view already fits the graph; a second edge popover replaces (does not stack on) the
  // first; and the Logs "new lines" pill, if shipped, stays hidden while already scrolled to the tail.
  // Several of these depend on Uma's t_961b3b38 (still in progress) — checks are written now and pass/fail
  // is reported per item rather than assumed, per the plan (t_7f8764c8).
  const auditShots = async () => {
    win.setSize(1440, 900); const outDir = process.env.AUDIT_OUT || out;
    const cp = pm.create('Audit'); const st = pm.store(cp.id);
    for (const [n, r, x, y] of [['Pia', 'PM', 60, 60], ['Devon', 'Dev', 320, 40], ['Dana', 'Dev', 320, 200], ['Rex', 'Reviewer', 580, 120], ['Cy', 'Critic', 580, 260]]) st.addNode({ name: n, role: r, x, y });
    const ns = st.getTeam().nodes; for (const d of [1, 2]) { st.addEdge(ns[0].id, ns[d].id, 'assign'); st.addEdge(ns[d].id, ns[3].id, 'message'); }
    const titles = ['Add dark mode toggle', 'Fix login redirect loop', 'Refactor usage aggregation into a reusable module with tests', 'Write onboarding copy', 'Sidebar icons', 'Stale worker badge', 'Wiki backlinks', 'Graph zoom'];
    titles.forEach((t, i) => { const k = st.createTask({ title: t, assignee: ns[1 + (i % 2)].id, description: 'Demo ' + t }); st.commentTask(k.id, ns[0].id, 'Please handle.'); if (i > 1) st._updateTask(k.id, { status: ['todo', 'in_progress', 'review', 'waiting_for_human', 'done', 'done'][i % 6] }); });
    for (let i = 0; i < 22; i++) { const k = st.createTask({ title: 'Shipped item ' + (i + 1), assignee: ns[1].id }); st._updateTask(k.id, { status: 'done' }); }
    const mc = st.createTask({ title: 'Merge conflict demo', assignee: ns[2].id }); st._updateTask(mc.id, { status: 'merge_conflict' });
    st.writeWiki('Runbook', '# Runbook\n\nSee [[Glossary]].\n', 'human'); st.writeWiki('Glossary', '## Terms\n\n- **LOD**\n', 'human');
    const L = (ago, n, kind, text) => `logs.push({ projectId: '${cp.id}', nodeId: '${n.id}', kind: '${kind}', text: ${JSON.stringify(text)}, at: Date.now() - ${ago} });`;
    await ex(`await refresh(); await switchTo({ p: '${cp.id}', t: '${pm.get(cp.id).teams[0].id}' }); await w(400); ${ns.map((n, i) => L(60000 - i * 900, n, 'system', '▶ ' + n.name + ' starts a task') + L(30000, n, 'tool', 'Read {"file_path":"a.txt"}')).join('')} await refresh(); S.orch.agents = { '${ns[1].id}': { status: 'working', taskId: '${st.listTasks ? '' : ''}' } };`);
    const sh = async (name) => { fs.writeFileSync(path.join(outDir, 'audit-' + name + '.png'), (await win.capturePage()).toPNG()); };
    for (const theme of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = theme; await ex(`await w(300);`);
      for (const tab of ['chat', 'board', 'overview', 'team', 'wiki', 'obs', 'usage', 'settings', 'inbox']) {
        await ex(`$('[data-tab=${tab}]').click(); await w(700);`); await sh(`${tab}-${theme}`);
        if (tab === 'board') { await ex(`const c = document.querySelector('#board, .board'); if (c) c.scrollLeft = 99999; await w(300);`); await sh(`board-right-${theme}`); }
        if (tab === 'usage') { await ex(`const m = document.querySelector('#usage, .view.active, main'); (document.scrollingElement || m).scrollTop = 99999; if (m) m.scrollTop = 99999; await w(300);`); await sh(`usage-scrolled-${theme}`); }
        if (tab === 'team') { await ex(`try { VP.zoom = 0.3; applyView && applyView(); } catch (e) {} await w(300);`); await sh(`team-small-${theme}`); }
      }
    }
    require('electron').nativeTheme.themeSource = 'system';
  };
  const critiqueShots = async () => {
    const prevSize = win.getSize(); win.setSize(1440, 900);
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cp = pm.create('Critique 24'); const cs = pm.store(cp.id);
    const roles = ['PM', 'Dev', 'Dev', 'Dev', 'Reviewer', 'Critic'];
    for (let i = cs.getTeam().nodes.length; i < 24; i++) cs.addNode({ name: `Cx${i + 1}`, role: roles[i % roles.length], x: 40 + (i % 6) * 220, y: 40 + Math.floor(i / 6) * 130 });
    const mainId = pm.get(cp.id).teams[0].id; const main = cs.getTeam();
    // Reports-to edges within each 6-agent group (PM assigns Devs, Devs message the Reviewer, Reviewer reviews
    // back to the PM, Critic reviews the Devs) so the 24-agent graph actually has edges to render/verify.
    for (let g = 0; g < main.nodes.length; g += 6) {
      const [pmN, d1, d2, d3, rev, crit] = main.nodes.slice(g, g + 6);
      if (!pmN || !d1 || !d2 || !d3 || !rev || !crit) break;
      for (const d of [d1, d2, d3]) { cs.addEdge(pmN.id, d.id, 'assign'); cs.addEdge(d.id, rev.id, 'message'); cs.addEdge(crit.id, d.id, 'review'); }
      cs.addEdge(rev.id, pmN.id, 'review');
    }
    const peerTeams = ['Peers A', 'Peers B', 'Peers C'].map((n) => pm.createTeam(cp.id, n));
    const peerStores = peerTeams.map((p) => pm.store(cp.id, p.id || p));
    peerStores.forEach((s, i) => { s.addNode({ name: `Peer${i + 1}a`, role: 'Dev', x: 60, y: 60 }); s.addNode({ name: `Peer${i + 1}b`, role: 'Reviewer', x: 300, y: 60 }); });
    peerStores.forEach((s) => cs.addEdge(main.nodes[0].id, s.getTeam().nodes[0].id, 'message')); // cross-team edges into each peer
    cs.createTask({ title: 'Critique demo task', assignee: main.nodes[1].id });
    cs.writeWiki('Critique Runbook', '# Critique Runbook\n\nHow this 24-agent fixture was built.\n\n- 24 agents in one team\n- 3 peer teams, cross-team edges\n', 'human');
    cs.writeWiki('Critique Glossary', '## Terms\n\n- **LOD**: level of detail fallback when names would be unreadable\n', 'human');
    const L = (ago, nodeId, kind, text) => `logs.push({ projectId: '${cp.id}', nodeId: '${nodeId}', kind: '${kind}', text: ${JSON.stringify(text)}, at: Date.now() - ${ago} });`;
    // 'system' starts a timeline run lane, 'tool' adds a tick, so the 24-lane timeline actually has activity to show.
    const seedLog = (n, i) => `${L(70000 - i * 500, n.id, 'system', `▶ ${n.name} starts "Critique demo task" in /x`)}${L(60000 - i * 500, n.id, 'tool', 'Read {"file_path":"notes.txt"}')}`;
    await ex(`await switchTo({ p: '${cp.id}', t: '${mainId}' }); await w(400); ${main.nodes.map(seedLog).join('')} await refresh(); renderLog(); renderObs(); await w(200);`);
    await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); fitView(); await w(500);`);
    // 1) Names stay legible at fit-to-view for 24 agents, or a LOD collapsed-frame fallback stands in.
    const nameCheck = await ex(`const ts = [...document.querySelectorAll('#graph .node .nname')];
      const px = ts.length ? Math.min(...ts.map((t) => parseFloat(getComputedStyle(t).fontSize) * t.getScreenCTM().a)) : 0;
      const frame = !!document.querySelector('.team-frame, .lod-frame, [data-lod-frame], [data-team-frame]');
      return { px, frame, nodes: ts.length, zoom: VP.zoom };`);
    expect('critique: names >=11px at fit-to-view (24 agents), or a LOD collapsed-frame fallback', nameCheck.px >= 11 || nameCheck.frame, nameCheck);
    // 2) Edge stroke contrast against the canvas background, both themes (WCAG 1.4.11 non-text minimum 3:1).
    const edgeContrast = async (theme) => { require('electron').nativeTheme.themeSource = theme; await ex(`await w(300);`);
      return ex(`const p = document.querySelector('#graph .edge'); if (!p) return null;
        const resolve = (c) => { const d = document.createElement('div'); d.style.color = c; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return (v.match(/[\\d.]+/g) || [0, 0, 0]).map(Number); };
        const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const edge = resolve(getComputedStyle(p).stroke); const bg = resolve(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff');
        const [l1, l2] = [lum(edge), lum(bg)].sort((a, b) => b - a); return { ratio: (l1 + 0.05) / (l2 + 0.05), edge, bg };`); };
    const cLight = await edgeContrast('light'); const cDark = await edgeContrast('dark');
    expect('critique: graph edge contrast >=3:1 in light', !cLight || cLight.ratio >= 3, cLight);
    expect('critique: graph edge contrast >=3:1 in dark', !cDark || cDark.ratio >= 3, cDark);
    // 3) Minimap hides once the view already fits the whole graph (fitView() above matches the graph bbox).
    const mmHidden = await ex(`const m = $('#minimap'); return !m || m.classList.contains('hidden') || getComputedStyle(m).display === 'none';`);
    expect('critique: minimap hidden once fit-to-view already fits the graph', mmHidden, { mmHidden });
    // 3b) t_0c3b6126: edges are orthogonal elbows that never cross a node card, fit-to-view centres the
    // whole graph (ghosts included), and every edge marker is the 8px arrowhead.
    const orth = await ex(`const shr = (r, m) => ({ x: r.x + m, y: r.y + m, w: r.width - 2 * m, h: r.height - 2 * m });
      const hit = (r, p) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
      const cards = [...document.querySelectorAll('#graph .node .card')].map((c) => shr(c.getBoundingClientRect(), 3));
      let cross = 0, diag = 0;
      for (const p of document.querySelectorAll('#graph .edge')) {
        if (p.getAttribute('d').includes('C')) diag++;
        const ctm = p.getScreenCTM(), L = p.getTotalLength();
        for (let t = 0; t <= L; t += 3) { const pt = p.getPointAtLength(t).matrixTransform(ctm); if (cards.some((r) => hit(r, pt))) { cross++; break; } }
      }
      const gr = document.querySelector('#graph').getBoundingClientRect();
      const pts = [...document.querySelectorAll('#graph .node, #graph .ghost')].map((g) => { const m = g.transform.baseVal.consolidate().matrix; return [m.e, m.f]; });
      const vp = document.querySelector('#graph > g.viewport').transform.baseVal.consolidate().matrix;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 184); y1 = Math.max(y1, y + 80); }
      const arrows = [...document.querySelectorAll('#graph defs marker')].map((m) => m.markerWidth.baseVal.value).join(',');
      return { diag, cross, nodes: pts.length, arrows, zoom: Math.round(vp.a * 100) / 100, dx: Math.round((x0 + x1) / 2 * vp.a + vp.e - gr.width / 2), dy: Math.round((y0 + y1) / 2 * vp.d + vp.f - gr.height / 2) };`);
    expect('critique: edges are orthogonal elbows (no bezier diagonals)', orth.diag === 0, orth);
    expect('critique: no edge passes through a node card', orth.cross === 0, orth);
    expect('critique: fit-to-view centres the graph', Math.abs(orth.dx) <= 24 && Math.abs(orth.dy) <= 24, orth);
    expect('critique: 8px arrowheads on every edge marker', orth.arrows === '8,8,8,8', orth);
    // 4) A second edge popover replaces the first instead of stacking a duplicate on top of it.
    const [a, b, c, d] = main.nodes;
    await ex(`window.alert = () => {}; edgePopover(200, 200, '${a.id}', '${b.id}'); await w(80); edgePopover(260, 260, '${c.id}', '${d.id}');`);
    const popovers = await ex(`return { openCtxMenus: document.querySelectorAll('[id="ctxmenu"]:not(.hidden)').length, dupIds: document.querySelectorAll('[id="ctxmenu"]').length, head: ($('.mhead') || {}).textContent || '' };`);
    expect('critique: a second edge popover replaces the first (no stacked popovers)', popovers.openCtxMenus === 1 && popovers.dupIds === 1 && popovers.head.includes(c.name) && popovers.head.includes(d.name), popovers);
    await ex(`hideMenus();`);
    // 5) Logs "new lines" pill (critique-views.md #8): feature-detected, since it's part of Uma's pending fixes.
    await ex(`$('#tabs button[data-tab=obs]').click(); await refresh(); await w(400);`);
    const pillSel = await ex(`return ['#log-newpill', '.newpill', '[data-newpill]', '#lognew'].find((s) => document.querySelector(s)) || null`);
    if (pillSel) {
      await ex(`$('#log').scrollTop = $('#log').scrollHeight; await w(200);`);
      const hiddenAtTail = await ex(`const p = $('${pillSel}'); return !p || p.classList.contains('hidden') || getComputedStyle(p).display === 'none';`);
      expect('critique: Logs new-lines pill hidden while already at the tail', hiddenAtTail, { pillSel });
    } else console.log('[gui-e2e] critique: Logs new-lines pill not shipped yet (Uma t_961b3b38 pending), skipping check');
    console.log('[gui-e2e] critique', JSON.stringify({ nameCheck, cLight, cDark, mmHidden, popovers, pillSel }));
    // Shots: Overview, Timeline (cropped), Logs, Wiki, Graph editor -- light + dark.
    for (const t of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = t;
      await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); renderGraph(); fitView(); await w(500);`); await shot(`critique-graph-${t}`);
      await ex(`$('#tabs button[data-tab=overview]').click(); await refresh(); await w(500);`); await shot(`critique-overview-${t}`);
      const tb = await ex(`const b = $('#ov-timelinewrap').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };`);
      fs.writeFileSync(path.join(out, `critique-timeline-${t}.png`), (await win.capturePage(tb)).toPNG());
      await ex(`$('#tabs button[data-tab=obs]').click(); await refresh(); renderLog(); renderObs(); await w(400);`); await shot(`critique-logs-${t}`);
      await ex(`$('#tabs button[data-tab=wiki]').click(); await refresh(); await w(400);`); await shot(`critique-wiki-${t}`);
    }
    require('electron').nativeTheme.themeSource = 'system';
    win.setSize(prevSize[0], prevSize[1]);
  };
  // Merge-conflict guard: a task with a real worktree branch that conflicts with base. Marking it
  // done must abort the auto-merge, park the task as merge_conflict (visible on the Board, not hidden), and
  // spawn a "Resolve merge conflict" follow-up.
  // Board layout shots (t_95f4c836): 34 done tasks + a long blocked tag, light/dark, narrow/wide.
  const boardShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const s = pm.store(cur.p || pid()); let nodes = s.getTeam().nodes; if (!nodes.length) { s.addNode({ name: 'Devon', role: 'Dev', x: 60, y: 60 }); nodes = s.getTeam().nodes; }
    const dev = nodes[0]; const blocker = s.createTask({ title: 'Blocker with a very long unbreakable title_' + 'x'.repeat(40), assignee: dev.id });
    s.createTask({ title: 'Blocked demo', assignee: dev.id, blockedBy: [blocker.id] });
    for (let i = 0; i < 34; i++) { const t = s.createTask({ title: 'Done task ' + i, assignee: dev.id }); s.updateTask(t.id, { status: 'done' }); }
    await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`);
    expect('board: done column shows 20 of 34', await ex(`return /20\\/34/.test($('#done-h').textContent)`));
    expect('board: no tag chip spills out of its card', await ex(`return [...document.querySelectorAll('.ctags .tag')].every((t) => t.scrollWidth <= t.clientWidth + 1 || getComputedStyle(t).textOverflow === 'ellipsis')`));
    const size = win.getSize();
    for (const [w, h, tag] of [[900, 800, 'narrow'], [1900, 900, 'wide']]) for (const th of ['light', 'dark']) { win.setSize(w, h); require('electron').nativeTheme.themeSource = th; await ex(`await w(500);`); await shot(`board-${tag}-${th}`); }
    require('electron').nativeTheme.themeSource = 'system'; win.setSize(...size);
  };
  const conflictShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const p = cur.p || pid(); const s = pm.store(p);
    const { execFileSync } = require('child_process'); const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, stdio: 'pipe' }).toString().trim();
    const repo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'squad-conflict-repo-'));
    g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
    const { ensureWorktree } = require('./worktree'); const wt = ensureWorktree(repo, 'conflictdemo');
    let nodes = s.getTeam().nodes; if (!nodes.length) { s.addNode({ name: 'Devon', role: 'Dev', x: 60, y: 60 }); nodes = s.getTeam().nodes; }
    const dev = nodes.find((n) => n.role === 'Dev') || nodes[0];
    let task = s.createTask({ title: 'Conflict demo: edit a.txt', assignee: dev.id });
    task = s._updateTask(task.id, { worktreePath: wt.worktreePath, worktreeBranch: wt.worktreeBranch });
    fs.writeFileSync(path.join(wt.worktreePath, 'a.txt'), 'theirs\n'); g(wt.worktreePath, 'commit', '-qam', 'theirs edit');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n'); g(repo, 'commit', '-qam', 'ours edit');
    task = s.updateTask(task.id, { status: 'done' });
    expect('conflict: guard parks the task as merge_conflict instead of done', task.status === 'merge_conflict', task);
    await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`);
    const col = await ex(`return [...document.querySelectorAll('#columns h3')].map((h) => h.textContent)`);
    expect('conflict: Board shows a merge conflict column (task is not hidden)', col.some((h) => /merge conflict/.test(h)), col);
    const card = await ex(`return document.querySelector('.card[data-id="${task.id}"]')?.textContent || ''`);
    expect('conflict: the parked card is the conflicting task', /Conflict demo/.test(card), card);
    await ex(`document.querySelector('.card[data-id="${task.id}"]').click(); await w(200);`);
    const detail = await ex(`return $('#taskdetail').textContent`);
    expect('conflict: task detail explains the auto-merge was blocked', /auto-merge blocked, task moved to merge_conflict/.test(detail), detail.slice(0, 300));
    const followUp = await ex(`return [...document.querySelectorAll('#columns .card')].map((c) => c.textContent).find((t) => /Resolve merge conflict/.test(t)) || ''`);
    expect('conflict: a "Resolve merge conflict" follow-up task was created', /Resolve merge conflict/.test(followUp), followUp);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(300);`); await shot(`31-conflict-board-${t}`); }
    require('electron').nativeTheme.themeSource = 'system';
  };
  // TEMP evidence scenario for t_04f36a69 (helpycode runtime/model selectable + persisted), not a permanent fixture.
  const helpycodeShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (!nodes.length) { ps.addNode({ name: 'Devon', role: 'Dev', x: 60, y: 60 }); nodes = ps.getTeam().nodes; }
    const n = nodes[0];
    await ex(`document.querySelector('#tabs button[data-tab=settings], #settingsbtn').click(); await refresh(); await w(300); $('#rt-path').value = 'helpycode'; $('#rt-detect').click(); await w(4000);`);
    const draft = await ex(`return { label: $('#rd-label') && $('#rd-label').value, models: $('#rd-models') && $('#rd-models').value, stub: !!document.querySelector('#rt-draft .costnote') }`);
    expect('helpycode: Detect populates a real (non-stub) draft', draft.label === 'helpycode' && !draft.stub, draft);
    // The introspector now parses `models` output into names, but the reviewer still confirms/edits the
    // list by hand from `helpycode models` output, same as any other free-text CLI model id.
    await ex(`$('#rd-models').value = 'elice/z-ai/glm-5.3-flash, elice/z-ai/glm-5.3'; $('#rd-defmodel').value = 'elice/z-ai/glm-5.3-flash'; $('#rd-save').click(); await w(300);`);
    const rtId = await ex(`return (JSON.parse(localStorage.getItem('customRuntimes')) || []).find((r) => r.bin === 'helpycode')?.id`);
    await ex(`$('#tabs button[data-tab=team]').click(); await refresh(); selectNode('${n.id}'); await w(300); $('#nf-runtime').value = '${rtId}'; $('#nf-runtime').dispatchEvent(new Event('change')); await w(200);`);
    const modelOpts = await ex(`return [...document.querySelectorAll('#modellist option')].map((o) => o.value)`);
    const model = modelOpts.find((m) => /glm/i.test(m)) || modelOpts[0];
    await ex(`$('#nf-model').value = ${JSON.stringify(model)}; $('#nf-save').click(); await w(400);`);
    await shot('helpycode-node-config');
    await ex(`await refresh(); selectNode('${n.id}'); await w(300);`);
    const saved = await ex(`const nn = S.team.nodes.find((x) => x.id === '${n.id}'); return { runtime: nn.runtime, model: nn.model, formRuntime: $('#nf-runtime').value, formModel: $('#nf-model').value };`);
    expect('helpycode: runtime+model persisted on the node and reflected in the form after reload', saved.runtime === rtId && saved.model === model && saved.formRuntime === rtId && saved.formModel === model, saved);
    await shot('helpycode-node-config-reloaded');
    console.log('[gui-e2e] helpycode', JSON.stringify({ draft, rtId, model, saved }));
  };
  // Wake-run UI (t_03a0e1a0): feed S.orch.agents[id].activity exactly as the backend shapes it
  // (orchestrator wakeRun: {trigger:'message', messageId, fromNodeId, excerpt, taskId, count, startedAt};
  // count = unread msgs delivered this run, renderer maps it to "+N queued") and
  // check the Board banner + presence chip, the Team and Overview node badges, then cleared again.
  const wakeShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (nodes.length < 2) { ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ps.getTeam().nodes; }
    const [pmN, dev] = nodes;
    const task = ps.createTask({ title: 'Wake demo', assignee: dev.id });
    await ex(`await refresh(); await w(200);`); // pick up the seeded nodes before injecting wake state
    // Re-seed right before every read: a background refresh() replaces S (and S.orch) at any time.
    const seed = `S.orch.agents = { '${dev.id}': { status: 'working', activity: { trigger: 'message', messageId: 'm1', fromNodeId: '${pmN.id}', excerpt: 'Please look at the failing test', taskId: '${task.id}', startedAt: Date.now() } } }; renderIdle(); renderGraph(); renderOverview();`;
    await ex(`$('#tabs button[data-tab=board]').click(); await w(200);`);
    const board = await ex(`${seed} await w(100); return { wakebar: !$('#wakebar').classList.contains('hidden'), text: ($('#wakebar .wakebar') || {}).textContent || '', chip: !!document.querySelector('#presence .pchip.wake') }`);
    expect('wake: Board banner shows woken-by-message with presence chip and task link', board.wakebar && board.text.includes('woken by message from Pia') && board.chip && board.text.includes('Wake demo'), board);
    await shot('wake-board-on');
    await ex(`$('#tabs button[data-tab=team]').click(); await w(200);`);
    const team = await ex(`${seed} await w(100); return { badge: !!document.querySelector('#graph .wakerunbadge'), linked: !!document.querySelector('#graph .wakerunbadge.linked'), txt: (document.querySelector('#graph .wakerunbadge text') || {}).textContent || '' }`);
    expect('wake: Team node shows the linked wake badge, visible text keeps the sender after the clip (t_0cd29f4d)', team.badge && team.linked && team.txt.includes('Pia'), team);
    await shot('wake-team-on');
    await ex(`$('#tabs button[data-tab=overview]').click(); await w(200);`);
    const ov = await ex(`${seed} await w(100); return { badge: !!document.querySelector('#ov-graph .wakerunbadge'), working: !!document.querySelector('#ov-graph .node.working'), txt: (document.querySelector('#ov-graph .wakerunbadge text') || {}).textContent || '' }`);
    expect('wake: Overview node shows the wake badge while working, visible text keeps the sender', ov.badge && ov.working && ov.txt.includes('Pia'), ov);
    await shot('wake-overview-on');
    await ex(`$('#tabs button[data-tab=board]').click(); await w(200);`);
    const off = await ex(`S.orch.agents = {}; renderIdle(); renderGraph(); renderOverview(); await w(100); return { wakebarHidden: $('#wakebar').classList.contains('hidden'), chip: !!document.querySelector('#presence .pchip.wake') }`);
    expect('wake: cleared activity hides the banner and chip', off.wakebarHidden && !off.chip, off);
    await shot('wake-board-cleared');
    console.log('[gui-e2e] wake', JSON.stringify({ board, team, ov, off }));
  };
  // Timeline with a live task run and a message-wake run (t_59147edd, plan t_6e1bb175/(b)). The landed
  // fix (t_634c6702) is the data layer: orchestrator timeline() merges live working agents as open-ended
  // bars and carries wakeFrom ("who woke it") on taskId-null runs — from live activity for in-flight
  // wakes, from the stored run record's fromNodeId (stamped by record()) for ended ones. That data is
  // not renderer-visible yet (getAll ships snapshotSlim(), which drops `timeline`, and the Overview
  // DOM lanes are built from '▶ ... starts' log lines only), so the live bar is asserted in the DOM
  // while the wake bar is asserted directly on the orchestrator. Seeds every real input channel:
  // backend agent state via orchFor (the orchestrator agent()/wakeRun shapes), a stored runs.json wake
  // record with fromNodeId, and the '▶' log lines the DOM lanes use.
  const timelineLiveShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cp = pm.create('Timeline Live'); const ps = pm.store(cp.id);
    const stubCaps = { ok: true, probedAt: new Date().toISOString(), source: 'stub', slashCommands: [], commands: [], skills: [], modes: [], categorized: [] };
    const pia = ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 });
    const devon = ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 120 });
    const dana = ps.addNode({ name: 'Dana', role: 'Dev', x: 320, y: 240 });
    ps.addEdge(pia.id, devon.id, 'assign'); ps.addEdge(pia.id, dana.id, 'message');
    [pia, devon, dana].forEach((n) => ps.updateNode(n.id, { capabilities: stubCaps }));
    const task = ps.createTask({ title: 'Fix the login redirect loop', assignee: devon.id });
    ps._updateTask(task.id, { status: 'in_progress' });
    // Backend agent state exactly as the orchestrator holds it while Devon runs the task and Dana
    // handles a message wake — the seed below mirrors it renderer-side for the Overview lanes.
    const orch = orchFor(cp.id);
    const oa = orch.agent(devon.id); oa.status = 'working'; oa.taskId = task.id; oa.task = 'Fix the login redirect loop'; oa.activity = { trigger: 'task', startedAt: Date.now() };
    const od = orch.agent(dana.id); od.status = 'working'; od.taskId = null; od.task = null; od.activity = { trigger: 'message', messageId: 'm1', fromNodeId: pia.id, taskId: null, count: 1, startedAt: Date.now() };
    // Stored (ended) wake run with taskId null and the waker stamped, as orchestrator.record() writes it.
    ps.addRun({ id: 'r_e2ewake', kind: 'agent', nodeId: dana.id, taskId: null, task: '', startedAt: Date.now() - 120000, endedAt: Date.now() - 60000, durationMs: 60000, model: 'stub', isError: false, fromNodeId: pia.id, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostUsd: 0, billingSource: 'api', sessionId: 'e2e-wake' });
    await ex(`await switchTo({ p: '${cp.id}', t: '${pm.get(cp.id).teams[0].id}' }); await w(300);`);
    const L = (ago, n, kind, text) => `logs.push({ projectId: '${cp.id}', nodeId: '${n.id}', kind: '${kind}', text: ${JSON.stringify(text)}, at: Date.now() - ${ago} });`;
    const seed = `${L(120000, devon, 'system', '▶ Devon starts "Fix the login redirect loop" in /work [mode=once]')}${L(60000, devon, 'tool', 'Read {"file_path":"login.ts"}')}${L(60000, dana, 'system', '▶ Dana wakes to handle messages from Pia in /work')}`
      + `S.orch.agents = { '${devon.id}': { status: 'working', taskId: '${task.id}', task: 'Fix the login redirect loop' }, '${dana.id}': { status: 'working', taskId: null, activity: { trigger: 'message', messageId: 'm1', messageIds: ['m1'], fromNodeId: '${pia.id}', excerpt: 'Please check the failing build', taskId: null, count: 1, startedAt: Date.now() } } }; renderIdle(); renderGraph(); renderOverview();`;
    await ex(`$('#tabs button[data-tab=overview]').click(); await w(300);`);
    const bars = await ex(`${seed} await w(200); return [...document.querySelectorAll('#ov-timeline rect.run')].map((r) => ({ live: r.classList.contains('live'), t: (r.querySelector('title') || {}).textContent || '' }));`);
    expect('timelinelive: the in-flight task run renders as an open live bar', bars.some((b) => b.live && /login redirect/i.test(b.t)), bars);
    // The re-scoped wake fix (5bbe2ba) lives in the renderer: the wake log line labels an open live bar 'wake: <who>'.
    expect('timelinelive: the wake run renders as an open live bar labelled wake: Pia', bars.some((b) => b.live && b.t === 'wake: Pia'), bars);
    const tb = await ex(`${seed} await w(100); const b = $('#ov-timelinewrap').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };`);
    fs.writeFileSync(path.join(out, 'timelinelive-overview.png'), (await win.capturePage(tb)).toPNG());
    await shot('timelinelive-overview-full');
    console.log('[gui-e2e] timelinelive', JSON.stringify({ bars, crop: tb }));
  };
  // Monitor log lines (t_43243765, plan t_a4ceb629/C): the core's watchdog decisions render as
  // accent "Monitor" rows — badge + action — reason with plain taskIds; a line persisted without
  // the structured fields falls back to its raw text.
  const monitorShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (!nodes.length) { ps.addNode({ name: 'Root', role: 'PM', x: 60, y: 60 }); nodes = ps.getTeam().nodes; }
    const core = nodes[0];
    await ex(`$('#tabs button[data-tab=obs]').click(); await refresh(); await w(300);`);
    await ex(`logs.push({ projectId: ctx.p, nodeId: '${core.id}', kind: 'monitor', text: 'woke the core', reason: '2 open tasks with all agents idle', taskIds: ['t_1','t_2'], action: 'woke core', at: Date.now() - 1000 });
      logs.push({ projectId: ctx.p, nodeId: '${core.id}', kind: 'monitor', text: 'legacy monitor line without fields', at: Date.now() - 500 });
      renderLog(); await w(300);`);
    const rows = await ex(`return [...document.querySelectorAll('#log .logrow.lv-monitor')].map((r) => ({ badge: r.querySelector('.loglevel').textContent, text: r.querySelector('.logtext').textContent }))`);
    expect('monitor: badge + action — reason with plain taskIds', rows[0] && rows[0].badge === 'Monitor' && rows[0].text === 'woke core — 2 open tasks with all agents idle (t_1, t_2)', rows);
    expect('monitor: line without structured fields falls back to raw text', rows[1] && rows[1].badge === 'Monitor' && rows[1].text === 'legacy monitor line without fields', rows);
    await shot('monitor-log');
    console.log('[gui-e2e] monitorlog', JSON.stringify(rows));
  };
  // Alerts center (t_6674705d): one bell + panel fed by the pure collector (src/alerts.js), which
  // replaced the stacked banners (#redbar, #rtbar, #restartst + #rstpop, .idlebanner). Checks the
  // PM/Critic matrix: no old banner DOM ids left; 0/1/6 alerts x 1100/1400 x light/dark shots; panel
  // open at 1100 stays inside the window; dismiss hides until the state changes (id+fingerprint);
  // real-state smokes: redMaster (Fix opens the fix task), restart pending, runtime down (error,
  // Resume, no dismiss while down), orphan task (Open task lands on the Retest+Resume stuckbar).
  const alertsShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (nodes.length < 2) { ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ps.getTeam().nodes; }
    const [pmN, dev] = nodes;
    const fix = ps.createTask({ title: 'P0: fix red master — usage invariants', assignee: dev.id, priority: 'P0' });
    await ex(`await refresh(); await w(300);`); // todo tasks raise no alerts: the 0-alert baseline is clean
    const rows = () => `[...document.querySelectorAll('#alertpanel .al-what')].map((e) => e.textContent)`;
    const rowAct = (re) => `(() => { const r = [...document.querySelectorAll('#alertpanel .al-row')].find((r) => ${re}.test(r.textContent)); return r && r.querySelector('.al-act') ? r.querySelector('.al-act').textContent : null; })()`;

    const gone = await ex(`return ['#redbar', '#rtbar', '#restartst', '#rstpop', '.idlebanner'].filter((s) => document.querySelector(s))`);
    expect('alerts: no old banner DOM ids left (#redbar #rtbar #restartst #rstpop .idlebanner)', gone.length === 0, gone);
    const bell0 = await ex(`return { bell: !!$('#alertbell'), badgeHidden: $('#alertbell-n').classList.contains('abadge-none'), plain: !$('#alertbell-n').textContent }`);
    expect('alerts: bell present, 0 alerts -> plain bell, no badge, no count', bell0.bell && bell0.badgeHidden && bell0.plain, bell0);
    for (const [wd, tag] of [[1400, 1400], [1100, 1100]]) for (const th of ['light', 'dark']) {
      win.setSize(wd, 800); require('electron').nativeTheme.themeSource = th; await ex(`await w(400);`);
      const hd = await ex(`const vis = (s) => { const e = document.querySelector(s); return !!e && e.offsetWidth > 2; };
        return { brand: vis('header > strong.brand'), chat: vis('#tabs button[data-tab=chat]'), team: vis('#tabs button[data-tab=team]'), board: vis('#tabs button[data-tab=board]'), bell: vis('#alertbell') }`);
      expect(`alerts: header keeps the logo, the Chat/Team/Board tabs and the bell at ${tag}px ${th} even with 0 alerts`, hd.brand && hd.chat && hd.team && hd.board && hd.bell, hd);
      await shot(`alerts-0-${tag}-${th}`);
    }
    win.setSize(1000, 800); require('electron').nativeTheme.themeSource = 'light'; await ex(`await w(400);`);
    await shot('alerts-0-1000-light'); // Critic edge check: exactly at the breakpoint (brand + secondary tabs hide, primary icon tabs stay)

    for (let i = 2; i <= 6; i++) ps.createTask({ title: `Fake target ${i}`, assignee: dev.id }); // todo tasks raise no alerts; they give fakes 2-6 a real task so every fake row gets its Open task action
    await ex(`await refresh(); await w(200);`);
    let one;
    for (const [wd, tag] of [[1400, 1400], [1100, 1100]]) for (const th of ['light', 'dark']) {
      win.setSize(wd, 800); require('electron').nativeTheme.themeSource = th;
      await ex(`__fakeAlerts(1); await w(400); if (alertsOpen) { $('#alertbell').click(); await w(250); }`); // panel closed: bell + badge only
      one = await ex(`return { n: $('#alertbell-n').textContent, cls: $('#alertbell-n').className }`);
      expect('alerts: 1 fake alert -> badge 1 with error color (worst severity)', one.n === '1' && /abadge-error/.test(one.cls), one);
      await shot(`alerts-1-${tag}-${th}`);
    }
    win.setSize(1100, 800); require('electron').nativeTheme.themeSource = 'light';
    await ex(`if (!alertsOpen) { $('#alertbell').click(); await w(250); }`);
    const panel = await ex(`return { open: !$('#alertpanel').classList.contains('hidden'), rows: document.querySelectorAll('#alertpanel .al-row').length, empty: !!$('#alertpanel .al-empty') }`);
    expect('alerts: panel opens with 1 row (not the empty state)', panel.open && panel.rows === 1 && !panel.empty, panel);
    await shot('alerts-1-panel-open');
    await ex(`[...document.querySelectorAll('#alertpanel .al-x')].find((b) => /Fake alert/.test(b.closest('.al-row').textContent)).click(); await w(400);`);
    const dim = await ex(`return { rows: document.querySelectorAll('#alertpanel .al-row').length, empty: !!$('#alertpanel .al-empty'), badge: $('#alertbell-n').className }`);
    expect('alerts: dismiss hides the row -> empty state, badge hidden', dim.rows === 0 && dim.empty && /abadge-none/.test(dim.badge), dim);
    const still = await ex(`__fakeAlerts(1); await w(400); return { rows: document.querySelectorAll('#alertpanel .al-row').length, empty: !!$('#alertpanel .al-empty') }`);
    expect('alerts: same state re-injected -> stays dismissed (id+fingerprint)', still.rows === 0 && still.empty, still);
    const bump = await ex(`__fakeAlerts(1, 'v2'); await w(400); return { rows: document.querySelectorAll('#alertpanel .al-row').length }`);
    expect('alerts: state changed (new fingerprint) -> row reappears', bump.rows === 1, bump);
    await ex(`__fakeAlerts(0); dismissed.clear(); await w(300);`);

    for (const [wd, tag] of [[1400, 1400], [1100, 1100]]) for (const th of ['light', 'dark']) {
      win.setSize(wd, 800); require('electron').nativeTheme.themeSource = th;
      await ex(`__fakeAlerts(6); await w(400); if (!alertsOpen) { $('#alertbell').click(); await w(250); }`);
      const g = await ex(`const r = $('#alertpanel').getBoundingClientRect(); return { n: $('#alertbell-n').textContent, rows: document.querySelectorAll('#alertpanel .al-row').length, acts: document.querySelectorAll('#alertpanel .al-act').length, first: document.querySelector('#alertpanel .al-dot').className, right: Math.round(r.right), iw: window.innerWidth }`);
      expect(`alerts: 6 alerts at ${tag}px ${th} — badge 6, 6 rows each with a working action, error dot first, panel inside viewport`, g.n === '6' && g.rows === 6 && g.acts === 6 && /al-error/.test(g.first) && g.right > 0 && g.right <= g.iw - 4, g);
      await shot(`alerts-6-${tag}-${th}`);
      await ex(`__fakeAlerts(0); await w(300);`);
    }
    require('electron').nativeTheme.themeSource = 'system';

    win.setSize(1400, 800);
    await ex(`$('#tabs button[data-tab=board]').click(); await w(200); if (!alertsOpen) { $('#alertbell').click(); await w(250); }
      S.orch.redMaster = { red: true, since: Date.now() - 42 * 60000, failingTests: ['usage-invariants.test.js › vendorTable resolves in renderer/app.js'], fixTaskId: '${fix.id}', gateBlocks: [] }; renderAlerts(); await w(400);`);
    const red = await ex(`return { n: $('#alertbell-n').textContent, cls: $('#alertbell-n').className, rows: ${rows()}, act: ${rowAct('/Master is red/')}, xs: document.querySelectorAll('#alertpanel .al-x').length }`);
    expect('alerts: master red -> row with failing test + Fix action, no dismiss (stays until green)', red.rows.length === 1 && /Master is red/.test(red.rows[0]) && /usage-invariants/.test(red.rows[0]) && red.act === 'Fix' && /abadge-error/.test(red.cls) && red.xs === 0, red);
    await shot('alerts-redmaster');
    await ex(`[...document.querySelectorAll('#alertpanel .al-act')].find((b) => b.textContent === 'Fix').click(); await w(400);`);
    const opened = await ex(`return { boardTab: $('#tab-board').classList.contains('active'), detail: ($('#taskdetail h3') || {}).textContent || '', sel: sel.task === '${fix.id}' }`);
    expect('alerts: Fix action opens the board task detail for the fix task', opened.boardTab && opened.detail.includes('P0: fix red master') && opened.sel, opened);
    await shot('alerts-fixtask');
    await ex(`S.orch.redMaster = { red: false }; renderAlerts(); await w(200); if (!alertsOpen) { $('#alertbell').click(); await w(250); }`);

    const rst = await ex(`rst = normRestart({ pendingCount: 3, targetSha: 'abcdef123456', since: Date.now() - 60000, stub: false }); renderAlerts(); await w(300);
      return { rows: ${rows()}, act: ${rowAct('/Restart pending/')}, n: $('#alertbell-n').textContent }`);
    expect('alerts: restart pending -> row "Restart pending — 3 commits behind" with Restart now', rst.rows.some((t) => /Restart pending — 3 commits behind/.test(t)) && rst.act === 'Restart now', rst);
    await shot('alerts-restart');
    await ex(`rst = normRestart({ pendingCount: 0, stub: true }); renderAlerts(); await w(150); if (!alertsOpen) { $('#alertbell').click(); await w(250); }`);

    const rt = await ex(`setRtu({ runtime: 'claude', error: 'exit 1', agents: [], since: Date.now() }); await w(300);
      return { rows: ${rows()}, act: ${rowAct('/unavailable/')}, cls: $('#alertbell-n').className, xs: document.querySelectorAll('#alertpanel .al-x').length }`);
    expect('alerts: runtime down -> error row with Resume, NO dismiss while down (Critic condition)', rt.rows.length === 1 && /Claude unavailable/.test(rt.rows[0]) && rt.act === 'Resume' && /abadge-error/.test(rt.cls) && rt.xs === 0, rt);
    await shot('alerts-runtimedown');
    await ex(`clearRtu('claude'); await w(150); if (!alertsOpen) { $('#alertbell').click(); await w(250); }`);

    const orph = await ex(`return { rows: ${rows()} }`);
    expect('alerts: nothing left but the clean state before the orphan smoke', orph.rows.length === 0, orph);
    const orphan = ps.createTask({ title: 'Stopped with work left demo', assignee: dev.id });
    ps.updateTask(orphan.id, { status: 'in_progress' }); // assignee has no live agent process -> stuck-task alert
    const orph2 = await ex(`await refresh(); await w(400); return { rows: ${rows()}, n: $('#alertbell-n').textContent }`);
    expect('alerts: stopped with work left -> row names the task, no live worker', orph2.rows.some((t) => /Stopped with work left demo/.test(t) && /no live worker/.test(t)), orph2);
    const openTask = await ex(`const b = [...document.querySelectorAll('#alertpanel .al-act')].find((b) => b.textContent === 'Open task'); b.click(); await w(400);
      return { sel: sel.task === '${orphan.id}', detail: ($('#taskdetail h3') || {}).textContent || '', stuck: !!document.querySelector('#taskdetail .stuckbar'), retest: [...document.querySelectorAll('#taskdetail button')].some((b) => /Retest \\+ Resume/.test(b.textContent)) }`);
    expect('alerts: Open task lands on the task detail where the t_747e0d1e Retest+Resume button lives (no duplication)', openTask.sel && openTask.stuck && openTask.retest && /Stopped with work left demo/.test(openTask.detail), openTask);
    await shot('alerts-orphan-open');
    // The idle banner is gone (.idlebanner removed): the same team-scoped idle detection now lives in
    // the presence chips — assert it the way the old firstrun check did, on the seeded team.
    const idle = await ex(`await switchTo({ t: S.project.teams[0].id }); $('#tabs button[data-tab=team]').click(); await w(300); const keep = [S.orch.agents, S.orch.idle];
      S.orch.agents = {}; S.orch.idle = S.allNodes.map((n) => n.id); renderGraph(); renderIdle(); await w(300); window.__idleKeep = keep;
      const chips = [...document.querySelectorAll('#presence .pchip.idle')].map((c) => c.textContent).join('|');
      return { chips, n: document.querySelectorAll('#presence .pchip').length, idleN: document.querySelectorAll('#presence .pchip.idle').length };`);
    expect('alerts: idle agents still visible as presence chips after the banner removal', idle.n >= 2 && idle.idleN === idle.n && /Pia/.test(idle.chips) && /Devon/.test(idle.chips), idle);
    await ex(`[S.orch.agents, S.orch.idle] = window.__idleKeep; await refresh(); await w(300);`);
    await ex(`if (alertsOpen) $('#alertbell').click(); await w(100);`);
    console.log('[gui-e2e] alerts', JSON.stringify({ bell0, one, panel, dim, still, bump, red, opened, rst, rt, orph, orph2, openTask }));
  };
  // Packaged-mode simulation (t_7fbee55f): with an identical stale dev-only state (restart pending,
  // watcher live, self-update draining, a gated task), a non-dev backend must render none of it —
  // the dev shot with the same injected state shows exactly what the gate hides.
  const packagedShots = async () => {
    await ex(`await refresh(); await w(300);`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (nodes.length < 2) { ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ps.getTeam().nodes; }
    // Assign the gated task: team-scoped board views hide unassigned (teamless) tasks (t_1158f757).
    const gated = ps.createTask({ title: 'Gated demo task', assignee: nodes[1].id });
    await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(400);`); // renderBoard only builds cards on the active tab; refresh picks up the gated card
    const inject = (dev) => ex(`rst = normRestart({ pendingCount: 3, targetSha: 'abcdef123456', since: Date.now() - 60000, gating: ['${gated.id}'], stub: false });
      watch = { lastWatchAt: Date.now() - 60000, active: true, digest: '3 behind · 1 merge failed', intervalMin: 10, stub: false };
      upd = normUpd({ phase: 'draining', waitingOn: 2, from: 'aaa1111', to: 'bbb2222', reason: 'packaged simulation', devMode: ${dev} }); upd.stub = false;
      rstSeen = true; boardSig = null; renderSelfUpdate(); renderHeader(); renderAlerts(); renderBoard(); await w(400);`);
    await inject(true);
    await ex(`if (!alertsOpen) { $('#alertbell').click(); await w(300); }`);
    const dv = await ex(`return { row: [...document.querySelectorAll('#alertpanel .al-what')].some((e) => /Restart pending/.test(e.textContent)),
      act: !![...document.querySelectorAll('#alertpanel .al-act')].find((b) => b.textContent === 'Restart now'),
      watch: !$('#watchst').classList.contains('hidden'), upd: !$('#updst').classList.contains('hidden'),
      veil: !$('#updveil').classList.contains('hidden'), rstwait: document.querySelectorAll('.rstwait').length }`);
    expect('dev mode (baseline): stale state shows restart row + Restart now, watch pill, update pill + veil, waits-for-restart tag',
      dv.row && dv.act && dv.watch && dv.upd && dv.veil && dv.rstwait === 1, dv);
    await shot('packaged-dev-header');
    await inject(false);
    const pk = await ex(`const vis = (s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); };
      return { row: [...document.querySelectorAll('#alertpanel .al-what')].some((e) => /Restart pending/.test(e.textContent)),
        watch: vis('#watchst'), upd: vis('#updst'), veil: vis('#updveil'),
        rstwait: document.querySelectorAll('.rstwait').length, body: document.body.textContent.includes('Restart pending') }`);
    expect('packaged: restart row, Restart now, watch pill, update pill + veil, waits-for-restart tag all hidden despite stale state',
      !pk.row && !pk.watch && !pk.upd && !pk.veil && pk.rstwait === 0 && !pk.body, pk);
    await shot('packaged-header');
    console.log('[gui-e2e] packaged', JSON.stringify({ dv, pk }));
  };
  // Wake run on an agent that ALSO has an in_progress task (t_8af586bc) — the case that used to
  // render bare "working": the backend keeps a.taskId null for the whole wake, so the old
  // wakeRun() veto on any in_progress task hid the wake info everywhere. Same seeded activity
  // shape as wakeShots, plus count (queued) and the in_progress task.
  const wakeBusyShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p || pid(), cur.t); let nodes = ps.getTeam().nodes;
    if (nodes.length < 2) { ps.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ps.getTeam().nodes; }
    const [pmN, dev] = nodes;
    const task = ps.createTask({ title: 'Busy wake demo', assignee: dev.id });
    ps.updateTask(task.id, { status: 'in_progress' });
    await ex(`await refresh(); await w(200);`); // pick up the seeded task before injecting wake state
    const seed = (onTask) => `S.orch.agents = { '${dev.id}': { status: 'working', activity: { trigger: 'message', messageId: 'm1', fromNodeId: '${pmN.id}', excerpt: 'Please look at the failing test', taskId: null, count: 2, startedAt: Date.now() }${onTask ? `, taskId: '${task.id}'` : ''} } }; renderIdle(); renderGraph(); renderOverview(); renderChat();`;
    await ex(`$('#tabs button[data-tab=team]').click(); await w(200);`);
    const team = await ex(`${seed(false)} await w(100); return { badge: !!document.querySelector('#graph .wakerunbadge'), chip: !!document.querySelector('#presence .pchip.wake'), typing: '', txt: (document.querySelector('#graph .wakerunbadge text') || {}).textContent || '' }`);
    expect('wakebusy: wake badge shows despite the in_progress task (was bare working), visible text keeps the sender', team.badge && team.chip && team.txt.includes('Pia'), team);
    await shot('wakebusy-team');
    const chat = await ex(`$('#tabs button[data-tab=chat]').click(); await w(200); ${seed(false)} await w(100); return { typing: $('#chat-typing').textContent || '' }`);
    expect('wakebusy: chat header shows the wake reason, not bare "Name is working"', chat.typing.includes('woken by message from Pia') && !/^Devon is working/.test(chat.typing), chat);
    await shot('wakebusy-chat');
    await ex(`$('#tabs button[data-tab=overview]').click(); await w(200);`);
    const ov = await ex(`${seed(false)} await w(100); return { badge: !!document.querySelector('#ov-graph .wakerunbadge'), txt: (document.querySelector('#ov-graph .wakerunbadge text') || {}).textContent || '' }`);
    expect('wakebusy: Overview shows the wake badge despite the in_progress task, visible text keeps the sender', ov.badge && ov.txt.includes('Pia'), ov);
    await shot('wakebusy-overview');
    // The veto still applies when the live run IS the task run (a.taskId set): badge goes away.
    await ex(`$('#tabs button[data-tab=team]').click(); await w(200);`);
    const onTask = await ex(`${seed(true)} await w(100); return { badge: !!document.querySelector('#graph .wakerunbadge') }`);
    expect('wakebusy: task badge wins when the live run is the task run (a.taskId set)', !onTask.badge, onTask);
    await shot('wakebusy-taskwins');
    console.log('[gui-e2e] wakebusy', JSON.stringify({ team, chat, ov, onTask }));
  };
  // Subagent (Task/Agent tool) visibility: replay REAL captured CLI streams (test/fixtures/subagents-*.jsonl —
  // claude 2.1.283 with two parallel Agent spawns + parent_tool_use_id child events, helpycode 0.3.5 with two
  // task-tool parts) through the backend's own event parsers — no mocks, no model runs — then assert the
  // renderer nests child activity under the parent with own tokens ('n/a' when the CLI reports none) and a
  // per-agent count. Selector contract with Uma (t_d716779d): .subblock/.subhead/.subdesc/.submeta/
  // .subrows (collapsed by default, [data-subtoggle]) in Logs, .subbadge on Team+Overview graphs,
  // details.cchip.subagent in Chat; tokens label "N / M tok", "n/a" when the CLI reports none.
  const subagentShots = async () => {
    const { SubagentTracker } = require('./subagents');
    const fx = (f) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const CLAUDE = fx('subagents-claude.jsonl'), HC = fx('subagents-helpycode.jsonl');
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const p = cur.p || pid(); const ts = pm.store(p, cur.t); const o = orchFor(p);
    let nodes = ts.getTeam().nodes;
    if (nodes.length < 2) { ts.addNode({ name: 'Pia', role: 'PM', x: 60, y: 60 }); ts.addNode({ name: 'Devon', role: 'Dev', x: 320, y: 160 }); nodes = ts.getTeam().nodes; }
    const [n1, n2] = nodes;
    const tsk = ts.createTask({ title: 'Subagent demo', assignee: n1.id }); // overview thread + board render assume a task exists
    // Replay through the backend's real parsers: claude stream-json on n1, helpycode profile events on n2.
    const replay = (node, events, runtime) => {
      const run = { sessionId: null, result: '', usage: U.newRun({ nodeId: node.id, agent: node.name }) };
      run.subs = new SubagentTracker(node.id);
      for (const ev of events) o.onEvent(node, JSON.stringify(ev), run, runtime);
      return run;
    };
    replay(n1, CLAUDE, 'claude');
    RT.RUNTIMES.stubsub = { id: 'stubsub', parseEvent: (ev) => RT.parseProfileEvent(ev, { label: 'Stub', eventMapping: {} }) };
    try { replay(n2, HC, 'stubsub'); } finally { delete RT.RUNTIMES.stubsub; }
    const [a1, a2] = [o.agent(n1.id), o.agent(n2.id)];
    expect('subagents: backend replay -> 2 records per node (claude Agent, helpycode task)', a1.subagentCount === 2 && a2.subagentCount === 2, { n1: a1.subagentCount, n2: a2.subagentCount });
    expect('subagents: claude tokens breakdown (2x 10in/4out), helpycode none (n/a)', JSON.stringify(a1.subagentTokens) === '{"inputTokens":20,"outputTokens":8}' && a2.subagents.every((r) => r.tokens === null), { a1: a1.subagentTokens });
    await ex(`$('#tabs button[data-tab=obs]').click(); await refresh(); renderLog(); await w(600);`); // re-render: a refresh may land after the live 'log' renders (S.orch was still empty then)
    await shot('31-subagents-logs');
    // Only the claude fixture's children stream as tagged rows; the helpycode task tool surfaces the whole
    // spawn as ONE completed part (no child events), so its 2 records show via the badge counts, not blocks.
    const blocks = await ex(`return [...document.querySelectorAll('#log .subblock[data-sub]')].map((b) => ({ desc: (b.querySelector('.subdesc')||{}).textContent || '', status: (b.querySelector('.substatus')||{}).dataset ? b.querySelector('.substatus').dataset.substatus : '', meta: (b.querySelector('.submeta')||{}).textContent || '', open: b.classList.contains('open') }))`);
    expect('subagents: Logs nest one collapsed block per claude subagent', blocks.length === 2 && blocks.every((b) => !b.open), blocks);
    expect('subagents: block heads carry the descriptions + completed status', ['Run alpha echo command', 'Run beta echo command'].every((d) => blocks.some((b) => b.desc === d)) && blocks.every((b) => b.status === 'completed'), blocks.map((b) => [b.desc, b.status]));
    expect('subagents: own tokens in the block meta (breakdown, not parent totals)', blocks.every((b) => /10 \/ 4 tok/.test(b.meta)), blocks.map((b) => [b.desc, b.meta]));
    // Toggling re-renders the list, so re-query the block by its data-sub id after the click.
    const expand = await ex(`const all = [...document.querySelectorAll('#log .subblock[data-sub]')]; const alpha = all.find((x) => (x.querySelector('.subdesc')||{}).textContent === 'Run alpha echo command'); if (!alpha) return { found: false, collapsed: false }; const sid = alpha.dataset.sub; const collapsed = all.every((x) => !x.classList.contains('open')); alpha.querySelector('[data-subtoggle]').click(); await w(400); const b = document.querySelector('#log .subblock[data-sub="' + sid + '"]'); return { found: true, collapsed, open: !!b && b.classList.contains('open') && !b.querySelector('.subrows').hidden, childText: !!b && b.textContent.includes('echo alpha-subagent-result') }`);
    expect('subagents: blocks collapsed by default; expanding reveals the child rows', expand.found && expand.collapsed && expand.open && expand.childText, expand);
    await shot('32-subagents-logs-expanded');
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=team]').click(); await w(400);`); await shot(`33-subagents-team-${t}`); }
    const counts = await ex(`return [...document.querySelectorAll('#graph .subbadge')].map((b) => ({ txt: b.querySelector('text') ? b.querySelector('text').textContent : '', full: b.querySelector('title') ? b.querySelector('title').textContent : '' }))`);
    expect('subagents: per-agent count badge (2) on both cards, claude totals as a breakdown of the parent', counts.length === 2 && counts.every((c) => /2/.test(c.txt)) && counts.some((c) => /2 subagents · 20 in \/ 8 out tok/.test(c.full)), counts);
    const ovb = await ex(`$('#ov-task').value = '${tsk.id}'; $('#tabs button[data-tab=overview]').click(); await w(400); return [...document.querySelectorAll('#ov-graph .subbadge')].map((b) => b.querySelector('text') ? b.querySelector('text').textContent : '')`);
    expect('subagents: Overview shows the count badges too', ovb.length >= 1, ovb);
    for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=overview]').click(); await w(400);`); await shot(`35-subagents-overview-${t}`); }
    const chat = await ex(`$('#tabs button[data-tab=chat]').click(); await w(300); await refresh(); CH.key = ''; renderChat(); await w(400); return [...document.querySelectorAll('#chat-room details.cchip.subagent')].map((d) => d.querySelector('summary') ? d.querySelector('summary').textContent : '')`);
    expect('subagents: Chat shows a nested subagent chip per spawn with its own tokens', chat.length >= 2 && chat.every((s) => /10 \/ 4 tok/.test(s)), chat);
    require('electron').nativeTheme.themeSource = 'system';
    await shot('34-subagents-chat');
    console.log('[gui-e2e] subagents', JSON.stringify({ blocks, expand, counts, ovb, chat }));
  };
  // Dynamic team GUI (t_2054825d): core toggle in the node form, lock badge + recruited chip on the graph, maxAgents/teamChangeApproval settings.
  const dynamicTeamShots = async () => {
    // refresh BEFORE the first tab click: a click renders the settings form, and empty S.settings
    // would trip the unguarded maxConcurrency/maxRuns number inputs ("cannot be parsed" warnings).
    await ex(`await refresh(); $('#tabs button[data-tab=team]').click(); await w(300); await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p, cur.t); const psettings = pm.store(cur.p);
    if (ps.getTeam().nodes.length < 3) { ps.addNode({ name: 'Corey', role: 'PM', x: 60, y: 60 }); ps.addNode({ name: 'Recruit A', role: 'Dev', x: 340, y: 60 }); ps.addNode({ name: 'Recruit B', role: 'Critic', x: 340, y: 200 }); }
    const team = ps.getTeam(); const corey = team.nodes.find((n) => n.name === 'Corey'); const ra = team.nodes.find((n) => n.name === 'Recruit A'); const rb = team.nodes.find((n) => n.name === 'Recruit B');
    await ex(`await refresh(); await w(400);`);
    const cores = () => ps.getTeam().nodes.filter((n) => n.core);
    const waitForStore = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (fn(ps.getTeam(), psettings.getSettings())) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
    // Core toggle through the node form: check, save, exactly one core in the team, lock badge on the graph.
    await ex(`selectNode('${corey.id}'); await w(300);`);
    const boxBefore = await ex(`return { present: !!$('#nf-core'), checked: $('#nf-core') ? $('#nf-core').checked : null }`);
    expect('core toggle present and unchecked for a fresh node', boxBefore.present && boxBefore.checked === false, boxBefore);
    await ex(`$('#nf-core').checked = true; $('#nf-save').click(); await w(600);`);
    expect('setting core saves core:true on the node', await waitForStore((t) => cores().length === 1 && cores()[0].id === corey.id), cores().map((n) => n.id));
    const lockOn = await ex(`return { core: !!document.querySelector('#graph .node[data-id="${corey.id}"] .corelock'), total: document.querySelectorAll('#graph .corelock').length }`);
    expect('lock badge shows on the core node only', lockOn.core && lockOn.total === 1, lockOn);
    // The form opens pre-checked for the core node; unchecking clears core (zero cores is safe, two are not).
    await ex(`selectNode('${corey.id}'); await w(300);`);
    const boxAfter = await ex(`return $('#nf-core') ? $('#nf-core').checked : null`);
    expect('form opens with the core box checked for the core node', boxAfter === true, boxAfter);
    await ex(`$('#nf-core').checked = false; $('#nf-save').click(); await w(600);`);
    expect('unchecking core saves core:false', await waitForStore((t) => !cores().length), cores().length);
    expect('lock badge gone when core is off', await ex(`return document.querySelectorAll('#graph .corelock').length`) === 0);
    await ex(`selectNode('${corey.id}'); await w(200); $('#nf-core').checked = true; $('#nf-save').click(); await w(600);`);
    expect('core re-enabled for the screenshots', await waitForStore((t) => cores().length === 1 && cores()[0].id === corey.id));
    // Recruited chip: nodes with createdBy (set the way recruit_agent does), not on the core or plain nodes.
    ps.updateNode(ra.id, { createdBy: corey.id });
    await ex(`await refresh(); await w(400);`);
    const chips = await ex(`return { a: !!document.querySelector('#graph .node[data-id="${ra.id}"] .chip-recruited'), b: !!document.querySelector('#graph .node[data-id="${rb.id}"] .chip-recruited'), core: !!document.querySelector('#graph .node[data-id="${corey.id}"] .chip-recruited') }`);
    expect('recruited chip on the createdBy node only', chips.a && !chips.b && !chips.core, chips);
    // wait for the badges instead of a fixed sleep so the shot cannot race the repaint (t_df6d61e4)
    await waitFor(`return !!document.querySelector('#graph .node[data-id="${ra.id}"] .chip-recruited') && !!document.querySelector('#graph .node[data-id="${corey.id}"] .corelock')`);
    await shot('36-dynamicteam-graph');
    // Settings: defaults 6/ask, saved values persist and re-render.
    // Settings gear lives outside the #tabs nav (it sits next to the help button), so match either.
    await ex(`document.querySelector('#tabs button[data-tab=settings], #settingsbtn').click(); await w(300);`);
    const defaults = await ex(`return { maxAgents: $('#st-maxagents') ? $('#st-maxagents').value : null, approval: $('#st-tcappr') ? $('#st-tcappr').value : null }`);
    expect('settings default maxAgents=6 and teamChangeApproval=ask', defaults.maxAgents === '6' && defaults.approval === 'ask', defaults);
    await ex(`$('#st-maxagents').value = '8'; $('#st-tcappr').value = 'auto'; $('#st-save').click(); await w(600);`);
    expect('settings save maxAgents=8 and teamChangeApproval=auto', await waitForStore((t, s) => s.maxAgents === 8 && s.teamChangeApproval === 'auto'), psettings.getSettings());
    await ex(`await refresh(); await w(300);`);
    const saved = await ex(`return { maxAgents: $('#st-maxagents').value, approval: $('#st-tcappr').value }`);
    expect('settings fields re-render the saved values', saved.maxAgents === '8' && saved.approval === 'auto', saved);
    await shot('37-dynamicteam-settings');
    console.log('[gui-e2e] dynamicteam', JSON.stringify({ cores: cores().map((n) => n.id), createdBy: ps.getTeam().nodes.find((n) => n.id === ra.id).createdBy, settings: { maxAgents: psettings.getSettings().maxAgents, teamChangeApproval: psettings.getSettings().teamChangeApproval } }));
  };
  // Delete-agent backend (t_749f4cc1): the removeNode IPC must refuse the core, refuse while the
  // agent still owns an in_progress task (it may be running right now), and hand the agent's other
  // open tasks to its manager (first incoming edge source, else the team core) instead of leaving
  // them stranded on a deleted node. Done tasks keep their assignee as history.
  const deleteNodeShots = async () => {
    await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ps = pm.store(cur.p, cur.t);
    const core = ps.getTeam().nodes.find((n) => n.core) || ps.addNode({ name: 'Corey', role: 'PM', core: true, x: 60, y: 60 });
    const mgr = ps.addNode({ name: 'Manager', role: 'PM', x: 340, y: 60 });
    const w = ps.addNode({ name: 'Wally', role: 'Dev', x: 620, y: 60 });
    ps.addEdge(mgr.id, w.id);
    // (0) the real UI path: select + Delete button -> deleteNode() -> confirm text lists the open tasks (confirm is stubbed, a native box cannot be clicked from JS)
    const w0 = ps.addNode({ name: 'Uni', role: 'Dev', x: 620, y: 200 }); ps.setNodeProtected(w0.id, false); // human-made nodes start protected
     ps.addEdge(mgr.id, w0.id);
    const u1 = ps.createTask({ title: 'UI open one', assignee: w0.id }); ps.createTask({ title: 'UI open two', assignee: w0.id });
    await ex(`await refresh(); selectNode('${w0.id}'); await w(300); window.__confirms = []; window.__alerts = []; window.alert = (m) => window.__alerts.push(m); window.confirm = (m) => { window.__confirms.push(m); return true; };`);
    await shot('44-deletenode-confirm');
    await ex(`$('#delsel').click(); await w(800); await refresh(); await w(300);`);
    const msgs = await ex(`return window.__confirms`);
    expect('deletenode: confirm box names the agent and the open-task count', msgs.length === 1 && /Delete Uni\?/.test(msgs[0]) && (msgs[0].match(/•/g) || []).length === 2, msgs);
    expect('deletenode: UI delete removed node + edges, tasks went to the manager', !ps.getTeam().nodes.some((n) => n.id === w0.id) && !ps.getTeam().edges.some((e) => e.from === w0.id || e.to === w0.id) && ps.getTask(u1.id).assignee === mgr.id, ps.getTask(u1.id).assignee);
    expect('deletenode: node gone from the graph DOM', await ex(`return !document.querySelector('#graph .node[data-id="${w0.id}"]')`));
    const todo = ps.createTask({ title: 'Delete-me open work', assignee: w.id });
    const done = ps.createTask({ title: 'Already shipped', assignee: w.id });
    ps.updateTask(done.id, { status: 'done' });
    await ex(`$('#tabs button[data-tab=team]').click(); await w(400); await refresh();`);
    await shot('45-deletenode-before');
    // (1) the core is refused by the backend, not just hidden by the UI
    const coreTry = await ex(`try { await call('removeNode', '${core.id}'); return 'deleted'; } catch (e) { return 'refused: ' + (e.message || e); }`);
    expect('deletenode: core refused by the removeNode IPC', /core/i.test(coreTry) && !!ps.getTeam().nodes.find((n) => n.id === core.id), coreTry);
    // (2) refused while an in_progress task is owned (the agent may be running it)
    const run = ps.createTask({ title: 'Running right now', assignee: w.id });
    ps.updateTask(run.id, { status: 'in_progress' });
    const runTry = await ex(`try { await call('removeNode', '${w.id}'); return 'deleted'; } catch (e) { return 'refused: ' + (e.message || e); }`);
    expect('deletenode: refuses while an in_progress task is owned', /in_progress/i.test(runTry) && !!ps.getTeam().nodes.find((n) => n.id === w.id) && ps.getTask(run.id).status === 'in_progress', runTry);
    // (3) open tasks go to the manager, node + edges go, done task untouched
    ps.updateTask(run.id, { status: 'todo' });
    await ex(`await call('removeNode', '${w.id}'); await w(300); await refresh();`);
    const after = { wGone: !ps.getTeam().nodes.some((n) => n.id === w.id), edgesGone: !ps.getTeam().edges.some((e) => e.from === w.id || e.to === w.id),
      todoTo: ps.getTask(todo.id).assignee, runTo: ps.getTask(run.id).assignee, doneKeeps: ps.getTask(done.id).assignee };
    expect('deletenode: open tasks to the manager, done untouched, node+edges gone', after.wGone && after.edgesGone && after.todoTo === mgr.id && after.runTo === mgr.id && after.doneKeeps === w.id, after);
    // (4) no incoming edge -> the team core inherits
    const w2 = ps.addNode({ name: 'Loner', role: 'Dev', x: 860, y: 60 });
    const loner = ps.createTask({ title: 'Orphan work', assignee: w2.id });
    await ex(`await call('removeNode', '${w2.id}'); await w(300);`);
    expect('deletenode: no manager -> the core inherits', !ps.getTeam().nodes.some((n) => n.id === w2.id) && ps.getTask(loner.id).assignee === core.id, ps.getTask(loner.id).assignee);
    await ex(`$('#tabs button[data-tab=team]').click(); await w(300); await refresh();`);
    await shot('46-deletenode-after');
    console.log('[gui-e2e] deletenode', JSON.stringify({ coreTry, runTry, after }));
  };
  // Recruit approval through the human Inbox (t_49f926ea): a core's recruit_agent files an approval
  // request in the Inbox; approving it in the UI must add the node to the graph LIVE (no reload),
  // declining must not — and the core is told either way. The REAL tool implementation runs
  // in-process against the project-level store (exactly what mcp-server.js does), so the suite
  // needs no claude run and stays red until the answer handler applies approved changes.
  const recruitInboxShots = async () => {
    const { makeTools } = require('./board-tools');
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`);
    const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const ts = pm.store(cur.p, cur.t); const proj = pm.store(cur.p);
    if (ts.getTeam().nodes.length < 2) { ts.addNode({ name: 'Corey', role: 'PM', x: 60, y: 60 }); ts.addNode({ name: 'Morgan', role: 'Dev', x: 340, y: 60 }); }
    const corey = ts.getTeam().nodes.find((n) => n.name === 'Corey');
    for (const n of ts.getTeam().nodes) if (n.core && n.id !== corey.id) ts.updateNode(n.id, { core: false });
    if (!corey.core) ts.updateNode(corey.id, { core: true });
    const task = ts.createTask({ title: 'Grow the team', assignee: corey.id, createdBy: corey.id });
    ts.updateTask(task.id, { status: 'in_progress' });
    const tools = makeTools(proj, corey.id);
    const nodesBefore = ts.getTeam().nodes.length;
    const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
    const named = (name) => ts.getTeam().nodes.filter((n) => n.name === name);
    const openItem = (re) => proj.listInbox({ status: 'open' }).find((i) => i.change && re.test(i.question));
    // (a) The core asks for a recruit: nothing changes until the human answers.
    const req1 = tools.recruit_agent({ name: 'Rookie', role: 'Dev', reason: 'e2e: an extra pair of hands for the goal' });
    const item1 = openItem(/Rookie/);
    await ex(`await refresh(); await w(300); $('#sb-inbox').click(); await w(400);`);
    const asked = { pending: !!req1.pending, item: !!item1, badge: await ex(`return $('#inbox-tab-badge').textContent`), parked: ts.getTask(task.id).status, nodes: ts.getTeam().nodes.length };
    expect('recruit ask: pending result, open item, badge 1, task parked, no node yet', asked.pending && asked.item && asked.badge === '1' && asked.parked === 'waiting_for_human' && asked.nodes === nodesBefore, asked);
    await shot('41-recruitinbox-request');
    // (b) Approve in the Inbox: the node joins the graph live — marker proves no reload happened.
    await ex(`window.__noreload = 'alive'; const d = [...document.querySelectorAll('.inboxitem')].find((x) => x.textContent.includes('Rookie')); d.querySelector('.ib-choice[data-v=approve]').click(); await w(600);`);
    const applied = await until(() => named('Rookie').length === 1);
    const rookie = named('Rookie')[0] || {};
    await ex(`await refresh(); await w(300); $('#tabs button[data-tab=team]').click(); await w(500);`);
    const approved = {
      applied, marker: await ex(`return window.__noreload === 'alive'`),
      dom: await ex(`return { nodes: document.querySelectorAll('#graph .node').length, rookie: [...document.querySelectorAll('#graph .node')].some((n) => n.textContent.includes('Rookie')) }`),
      createdBy: rookie.createdBy || null, edges: ts.getTeam().edges.filter((e) => (e.from === corey.id && e.to === rookie.id) || (e.from === rookie.id && e.to === corey.id)).map((e) => e.type).sort(),
      itemClosed: !!item1 && proj.getInboxItem(item1.id).status !== 'open',
      badgeAfter: await ex(`await refresh(); $('#sb-inbox').click(); await w(300); return $('#inbox-tab-badge').textContent`),
      task: ts.getTask(task.id).status,
      toldCore: proj.listMessages({ to: corey.id }).some((m) => /Rookie/.test(m.text)),
    };
    expect('recruit approved: node appears live (no reload), createdBy=core, both edges, item closed, badge 0, task back, core told',
      approved.applied && approved.marker && approved.dom.nodes === nodesBefore + 1 && approved.dom.rookie && approved.createdBy === corey.id && approved.edges.join() === 'assign,message' && approved.itemClosed && approved.badgeAfter === '' && approved.task === 'in_progress' && approved.toldCore, approved);
    await ex(`$('#tabs button[data-tab=team]').click(); await w(300);`); await shot('42-recruitinbox-approved');
    // (c) Decline: any non-'approve' answer changes nothing; the core still gets told.
    const req2 = tools.recruit_agent({ name: 'Nova', role: 'Critic', reason: 'e2e: decline-path coverage' });
    const item2 = openItem(/Nova/);
    await ex(`await refresh(); await w(300); $('#sb-inbox').click(); await w(400);`);
    await shot('43-recruitinbox-decline-request');
    await ex(`const d = [...document.querySelectorAll('.inboxitem')].find((x) => x.textContent.includes('Nova')); d.querySelector('.ib-text').value = 'decline: not needed for this goal'; d.querySelector('.ib-send').click(); await w(800);`);
    await new Promise((r) => setTimeout(r, 2000)); // settle: nothing is supposed to change
    await ex(`await refresh(); await w(300);`);
    const it2 = item2 && proj.getInboxItem(item2.id);
    const declined = {
      pending: !!req2.pending, answered: it2 ? it2.status === 'answered' && it2.answer : null,
      nodes: ts.getTeam().nodes.length, task: ts.getTask(task.id).status,
      badge: await ex(`return $('#inbox-tab-badge').textContent`),
      toldCore: proj.listMessages({ to: corey.id }).some((m) => /Nova/.test(m.text)),
    };
    expect('recruit declined: no node, item answered, badge 0, task back, core told',
      declined.pending && declined.answered && declined.nodes === nodesBefore + 1 && declined.task === 'in_progress' && declined.badge === '' && declined.toldCore, declined);
    await ex(`$('#tabs button[data-tab=team]').click(); await w(300);`); await shot('44-recruitinbox-declined');
    console.log('[gui-e2e] recruitinbox', JSON.stringify({ asked, approved, declined }));
  };
  // Top bar must fit any window width with the meter filled (bug t_19ec5471): header never overflows
  // (scrollWidth <= clientWidth), New goal/Help stay visible (the goal composer is a popover since
  // t_db67859d; Stop only shows while a run is live), and the bar stays a FIXED-SIZE
  // summary — one limit chip whatever the provider count (t_bc19b2f5; the tokens pill is gone, the
  // cost pill stays at every width). Widths swept via setContentSize so the CSS viewport is exact.
  // The chat pane must reach the window's right edge (t_a99ed2c2): the 360px task-thread aside must
  // actually hide (its ID display:flex used to beat .hidden) and come back when a thread is opened.
  const topbarShots = async () => {
    await waitFor(`return !!document.querySelector('#tpl-select option')`); await ex(`await refresh();`); const cur = await ex(`return { p: ctx.p, t: S.teamId }`);
    const p = cur.p || pid(); const ts = pm.store(p, cur.t); const o = orchFor(p);
    let nodes = ts.getTeam().nodes;
    if (nodes.length < 2) { ts.addNode({ name: 'Pia', role: 'PM', runtime: 'claude', model: 'opus', x: 60, y: 60 }); ts.addNode({ name: 'Devon', role: 'Dev', runtime: 'codex', model: 'gpt-5.6-terra', x: 320, y: 60 }); nodes = ts.getTeam().nodes; }
    const rl = (pct, hrs) => ({ pct, resetsAt: new Date(Date.now() + hrs * 3600000).toISOString() });
    o.subscriptionRateLimits = { [nodes[0].id]: { fiveHour: rl(0.92, 1), weekly: rl(0.13, 72) }, [nodes[1].id]: { fiveHour: rl(0.66, 2) } };
    // Real usage rows too: an empty #totalcost hides itself, and the human's overflow happens with
    // the pill populated.
    for (let i = 0; i < 3; i++) {
      ts.addRun({ id: 'tb-c' + i, projectId: p, nodeId: nodes[0].id, agent: nodes[0].name, kind: 'agent', runtime: 'claude', billingSource: 'subscription', startedAt: new Date(Date.now() - i * 1000).toISOString(), inputTokens: 5000, outputTokens: 1200, reportedCostUsd: 0.02 + i * 0.01 });
      ts.addRun({ id: 'tb-x' + i, projectId: p, nodeId: nodes[1].id, agent: nodes[1].name, kind: 'agent', runtime: 'codex', billingSource: 'subscription', startedAt: new Date(Date.now() - i * 1000).toISOString(), inputTokens: 4000, outputTokens: 900, reportedCostUsd: 0.02 + i * 0.01 });
    }
    // A task with createdBy renders a handoff bubble carrying data-thread — used below to open the
    // thread pane and prove #chat-thread.hidden still toggles (t_a99ed2c2).
    ts.createTask({ title: 'Thread pane geometry', assignee: nodes[0].id, createdBy: nodes[1].id });
    await ex(`await refresh(); await w(500);`);
    expect('topbar: exactly ONE limit chip, naming the worst provider (claude 92%)', await ex(`return document.querySelectorAll('#limitmeter [data-provider]').length === 1 && document.querySelector('#limitmeter button[data-provider]').getAttribute('aria-label') === 'Claude 5h limit 92%' && document.querySelector('#limitmeter [data-provider]').dataset.provider === 'claude' && /92%/.test($('#limitmeter [data-provider]').getAttribute('aria-label')) && !$('#limitmeter').classList.contains('hidden')`));
    expect('topbar: cost pill populated (tokens pill removed; cost visible)', await ex(`return !$('#totalcost').classList.contains('hidden') && !/no cost yet/.test($('#totalcost').textContent) && !document.querySelector('#totaltokens')`));
    // Regime (t_bc19b2f5, t_57421101 round 3; goal popover in t_db67859d): the meter and the cost
    // pill are FIXED — they may never shrink or clip, at any width. #updst/#runstate ellipsize as
    // the last valves, and below 1200px the brand text hides and the tab labels collapse to icons.
    // The header holds only fixed-size chrome now: the goal composer lives in a popover off the
    // "New goal" button, asserted to open focused and fully on-screen at 1400px below.
    const measure = `(async () => { const h = document.querySelector('header'); const d = document.documentElement; const vis = (s) => { const e = document.querySelector(s); if (!e || e.getClientRects().length === 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight; };
      const cm = document.querySelector('#tab-chat.active .chat-main'); const th = document.querySelector('#chat-thread');
      return { sw: Math.max(d.scrollWidth, document.body.scrollWidth), cw: Math.min(d.clientWidth, document.body.clientWidth), edge: Math.round(Math.max(...[...h.children].map((c) => c.getBoundingClientRect().right))), iw: window.innerWidth, hdrSw: h.scrollWidth, hdrCw: h.clientWidth, newgoal: vis('#newgoal'), help: vis('#help'), cost: vis('#totalcost'), clipped: [...h.children].filter((c) => c.id !== 'goalpop' && c.scrollWidth > c.clientWidth + 1).map((c) => c.id || c.className), kids: [...h.children].map((c) => ({ id: c.id || c.className, w: Math.round(c.getBoundingClientRect().width), sw: c.scrollWidth, cw: c.clientWidth })), meterKids: [...document.querySelector('#limitmeter').children].map((c) => ({ cls: c.className, w: Math.round(c.getBoundingClientRect().width), t: c.textContent.trim().slice(0, 24) })), cm: cm ? Math.round(cm.getBoundingClientRect().right) : null, thDisp: !!(th && th.getClientRects().length), thW: th ? Math.round(th.getBoundingClientRect().width) : 0 }; })()`;
    const prevSize = win.getContentSize();
    const sweep = [];
    for (const cw of [1900, 1600, 1400, 900]) {
      win.setContentSize(cw, Math.max(600, Math.min(prevSize[1], 800))); await new Promise((r) => setTimeout(r, 350));
      const m = await ex(`return ${measure}`); sweep.push({ cw, ...m });
      expect(`topbar: no horizontal scroll at ${cw}px (page scrollWidth ${m.sw} <= ${m.cw})`, m.sw <= m.cw + 1, m);
      expect(`topbar: no header item cut off at ${cw}px (rightmost edge ${m.edge} <= window ${m.iw})`, m.edge <= m.iw + 1, m);
      expect(`topbar: New goal/Help visible at ${cw}px`, m.newgoal && m.help, m);
      expect(`topbar: cost pill visible at ${cw}px (no breakpoint: the pill stays at every width)`, m.cost, m);
      if (cw >= 1400) expect(`topbar: nothing clipped at ${cw}px — goal absorbs, the summary chip shows full text`, m.clipped.length === 0, m);
      else expect(`topbar: below 1400px only #updst/#runstate may clip — the chip and the cost pill never do`, m.clipped.every((x) => /updst|runstate|restartst|watchst/.test(String(x))), m);
      if (cw === 1600 || cw === 1400 || cw === 900) expect(`topbar: chat pane reaches the window's right edge at ${cw}px (chat right ${m.cm} vs window ${m.iw}, thread hidden)`, m.cm !== null && m.cm >= m.iw - 1 && !m.thDisp, m);
      await shot(`topbar-${cw}`);
      if (cw === 1400) { // the composer popover must open focused and sit fully on-screen (t_db67859d)
        await ex(`$('#newgoal').click(); await w(200);`);
        const gp = await ex(`return { open: !$('#goalpop').classList.contains('hidden'), w: Math.round($('#goalpop').getBoundingClientRect().width), r: Math.round($('#goalpop').getBoundingClientRect().right), b: Math.round($('#goalpop').getBoundingClientRect().bottom), ih: window.innerHeight, focused: document.activeElement === $('#goal') }`);
        expect(`topbar: goal popover opens focused and fits at 1400px (w ${gp.w}, right ${gp.r})`, gp.open && gp.focused && gp.w >= 440 && gp.r <= m.iw + 1 && gp.b <= gp.ih + 1, gp);
        await shot('topbar-1400-goalpop');
        await ex(`$('#goalpop').classList.add('hidden'); await w(100);`);
      }
      if (cw === 1400) { // the fix must not hide the thread pane for good: opening a task thread shows it again
        await ex(`document.querySelector('#chat-room [data-thread]').click(); await w(300);`);
        const th = await ex(`return { disp: $('#chat-thread').getClientRects().length > 0, w: Math.round($('#chat-thread').getBoundingClientRect().width), cm: Math.round($('#tab-chat.active .chat-main').getBoundingClientRect().right) }`);
        expect(`topbar: opened thread pane is displayed with width > 0 at 1400px (chat right ${th.cm} = window ${m.iw} - thread ${th.w})`, th.disp && th.w > 0 && th.cm <= m.iw - th.w + 1, th);
        await shot('topbar-1400-thread');
        await ex(`CH.thread = null; chatSig = null; renderChat(); await w(200);`);
        const m2 = await ex(`return ${measure}`);
        expect(`topbar: chat pane reaches the right edge again after closing the thread at 1400px (chat right ${m2.cm} vs window ${m2.iw})`, m2.cm >= m2.iw - 1 && !m2.thDisp, m2);
      }
    }
    // Overflow guard (t_ea33cef4): every optional pill forced on (restart pending + core watching + update chip +
    // limit warning + Stop) must still fit at 1100 and 1400px. Screenshots per width for the Critic.
    await ex(`rst = { ...rst, pendingCount: 3, stub: false, since: new Date().toISOString() }; watch = { ...watch, active: true, lastWatchAt: new Date().toISOString() }; await renderAlerts(); renderWatchPill(); $('#stop').classList.remove('hidden'); const u = $('#updst'); u.classList.remove('hidden'); u.textContent = 'Update ready · restart to apply';`);
    await ex(`$('#tabs button[data-tab=board]').click(); await w(300);`);
    for (const cw of [1100, 1400]) {
      win.setContentSize(cw, 700); await new Promise((r) => setTimeout(r, 350));
      const g = await ex(`$('#stop').classList.remove('hidden'); $('#updst').classList.remove('hidden'); const h = document.querySelector('header'); const d = document.documentElement; const inV = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth; }; return { hs: h.scrollWidth, hc: h.clientWidth, ds: d.scrollWidth, iw: window.innerWidth, chip: !$('#limitmeter').classList.contains('hidden'), aria: (document.querySelector('#limitmeter button') || {}).ariaLabel, kids: [...h.children].filter((c) => c.getClientRects().length).map((c) => (c.id || c.className) + ':' + Math.round(c.getBoundingClientRect().width)).join(' '), run: inV('#stop'), goal: inV('#newgoal'), theme: inV('#themebtn'), settings: inV('#settingsbtn') };`);
      expect(`overflow-guard: header fits at ${cw}px with all pills on (${g.hs} <= ${g.hc}, page ${g.ds} <= ${g.iw})`, g.hs <= g.hc + 1 && g.ds <= g.iw + 1, g);
      expect(`overflow-guard: warning chip, Stop, New goal, theme, settings all inside the window at ${cw}px`, g.chip && g.run && g.goal && g.theme && g.settings, g);
      for (const th of ['light', 'dark']) { require('electron').nativeTheme.themeSource = th; await ex(`await w(250);`); await shot(`board-topbar-${cw}-${th}`); }
      require('electron').nativeTheme.themeSource = 'system';
    }
    await ex(`rst = { ...rst, pendingCount: 0 }; watch = { ...watch, active: false, lastWatchAt: null }; await renderAlerts(); renderWatchPill(); $('#stop').classList.add('hidden'); $('#updst').classList.add('hidden'); $('#tabs button[data-tab=chat]').click();`);
    win.setContentSize(1400, Math.max(600, Math.min(prevSize[1], 800))); await new Promise((r) => setTimeout(r, 350));
    // Critic round 3: the chip and the cost pill must be READABLE at 900px, not squashed — assert
    // unclipped (scrollWidth <= clientWidth) and width-stable (the SAME width as at 1400px).
    const kidAt = (cw2, id) => { const s2 = sweep.find((s3) => s3.cw === cw2); return (s2 && s2.kids.find((k2) => k2.id === id)) || null; };
    for (const id of ['limitmeter', 'totalcost']) {
      const k9 = kidAt(900, id), k14 = kidAt(1400, id);
      expect(`topbar: ${id} unclipped and the SAME width at 900px as at 1400px (${k9 && k9.w}px vs ${k14 && k14.w}px)`, k9 && k14 && k9.sw <= k9.cw && Math.abs(k9.w - k14.w) <= 1, { at900: k9, at1400: k14 });
    }
    // Fixed-size bar whatever the provider count (t_bc19b2f5): 6 providers must still render the SAME
    // one-chip summary — the same width as the 2-provider header swept above — with no overflow at
    // 1600/1400/900, and clicking the chip must open the Usage tab listing every provider. The team
    // mixes real and unknown runtime ids (agent-config keeps those), so usageStatus really keys 6
    // providers; claude gets the same windows as the main team so the chip text — and thus the chip
    // width — is directly comparable.
    const prevCtx6 = await ex(`return { ...ctx }`);
    const pj6 = pm.create('Topbar: 6 providers'); await ex(`P = await call('listProjects'); renderSidebar(); await switchTo({ p: '${pj6.id}' }); await w(700);`);
    const s6 = pm.store(pj6.id); const o6 = orchFor(pj6.id);
    const rts = ['claude', 'codex', 'opencode', 'helpycode', 'gemini', 'droid'];
    const nodes6 = rts.map((rt, i) => s6.addNode({ name: 'Six' + i, role: i ? 'Dev' : 'PM', runtime: rt, model: i ? '' : 'opus', x: 60 + i * 40, y: 60 }));
    for (let i = 0; i < 3; i++) s6.addRun({ id: 'tb6-c' + i, projectId: pj6.id, nodeId: nodes6[0].id, agent: nodes6[0].name, kind: 'agent', runtime: 'claude', billingSource: 'subscription', startedAt: new Date(Date.now() - i * 1000).toISOString(), inputTokens: 5000, outputTokens: 1200, reportedCostUsd: 0.02 });
    o6.subscriptionRateLimits = Object.fromEntries(nodes6.map((n, i) => [n.id, i === 0
      ? { fiveHour: rl(0.92, 1), weekly: rl(0.13, 72), runtime: 'claude' }
      : { fiveHour: rl(0.35 - i * 0.06, 1), weekly: rl(0.07, 72), runtime: rts[i] }]));
    await ex(`await refresh(); await w(500);`);
    expect('topbar-6: exactly one chip despite 6 providers — the worst one (claude 92%), never the others', await ex(`return document.querySelectorAll('#limitmeter [data-provider]').length === 1 && document.querySelector('#limitmeter [data-provider]').dataset.provider === 'claude' && /92%/.test($('#limitmeter [data-provider]').getAttribute('aria-label')) && !/codex|opencode|helpycode|gemini|droid/i.test($('#limitmeter').textContent) && !$('#limitmeter').classList.contains('hidden')`));
    const chipW2 = (cw2) => { const x = sweep.find((s2) => s2.cw === cw2); return x && x.meterKids[0] ? x.meterKids[0].w : null; };
    const six = {};
    for (const cw of [1600, 1400, 900]) {
      win.setContentSize(cw, Math.max(600, Math.min(prevSize[1], 800))); await new Promise((r) => setTimeout(r, 350));
      const m = await ex(`return ${measure}`); six[cw] = m;
      expect(`topbar-6: no overflow at ${cw}px (page ${m.sw} <= ${m.cw}, rightmost ${m.edge} <= ${m.iw})`, m.sw <= m.cw + 1 && m.edge <= m.iw + 1, m);
      expect(`topbar-6: New goal/Help visible at ${cw}px`, m.newgoal && m.help, m);
      if (cw >= 1400) expect(`topbar-6: nothing clipped at ${cw}px`, m.clipped.length === 0, m);
      else expect(`topbar-6: below 1400px only #updst/#runstate may clip — the chip and the cost pill never do`, m.clipped.every((x) => /updst|runstate|restartst|watchst/.test(String(x))), m);
      expect(`topbar-6: bar same width as the 2-provider header at ${cw}px (${m.meterKids[0] ? m.meterKids[0].w : null}px vs ${chipW2(cw)}px)`, m.meterKids[0] && chipW2(cw) != null && Math.abs(m.meterKids[0].w - chipW2(cw)) <= 1, { six: m.meterKids[0], two: chipW2(cw) });
      await shot(`topbar-6-${cw}`);
    }
    for (const id of ['limitmeter', 'totalcost']) {
      const k9 = six[900].kids.find((k2) => k2.id === id), k14 = six[1400].kids.find((k2) => k2.id === id);
      expect(`topbar-6: ${id} unclipped and the SAME width at 900px as at 1400px (${k9 && k9.w}px vs ${k14 && k14.w}px)`, k9 && k14 && k9.sw <= k9.cw && Math.abs(k9.w - k14.w) <= 1, { at900: k9, at1400: k14 });
    }
    // Clicking the summary chip opens the Usage tab, which lists EVERY provider (the top bar names only the worst).
    await ex(`$('#limitmeter').click(); await w(300);`);
    await waitFor(`return $('#tab-usage').classList.contains('active') && document.querySelectorAll('#us-limits [data-provider]').length === 6`);
    const det = await ex(`return { provs: [...document.querySelectorAll('#us-limits [data-provider]')].map((c) => c.dataset.provider) }`);
    expect('topbar-6: clicking the chip opens the Usage tab listing every provider', det.provs.length === 6 && rts.every((r) => det.provs.includes(r)), det);
    await ex(`document.querySelector('#us-limits').scrollIntoView({ block: 'center' }); await w(250);`);
    const uv = await ex(`return (() => { const r = document.querySelector('#us-limits').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), ih: window.innerHeight }; })()`);
    expect('topbar-6: #us-limits is scrolled into view for the shot (evidence that all 6 providers are listed)', uv.top >= 0 && uv.bottom <= uv.ih, uv);
    await shot('topbar-6-usage');
    // Pause/near-limit renders INSIDE the one chip — the word replaces the % text — so the meter
    // never gains an element when the state changes and the equal-width comparison above stays
    // chip-vs-chip. Prove it with the flag actually shown on BOTH teams at 1400px.
    const flagGrab = `(async () => { const m2 = document.querySelector('#limitmeter'); const c = m2.querySelector('.lm-chip'); return { kids: m2.children.length, cls: c ? c.className : '', txt: c ? c.textContent.trim() : '', flagEl: !!m2.querySelector('.lm-flag'), w: c ? Math.round(c.getBoundingClientRect().width) : null }; })()`;
    win.setContentSize(1400, Math.max(600, Math.min(prevSize[1], 800))); await new Promise((r) => setTimeout(r, 350));
    o6.subscriptionRateLimits[nodes6[0].id] = { fiveHour: rl(1, 1), weekly: rl(0.13, 72), runtime: 'claude' };
    await ex(`await refresh(); await w(500);`);
    const pf6 = await ex(`return ${flagGrab}`);
    expect('topbar-6[paused]: flag lives inside the one chip — meter stays one element, no .lm-flag element, chip says "paused"', pf6.kids === 1 && pf6.cls.includes('lm-danger') && /paused/.test(pf6.txt) && !pf6.flagEl, pf6);
    await shot('topbar-6-paused');
    await ex(`await switchTo(${JSON.stringify(prevCtx6)}); await w(300);`);
    o.subscriptionRateLimits[nodes[0].id] = { fiveHour: rl(1, 1), weekly: rl(0.13, 72) };
    await ex(`await refresh(); await w(500);`);
    const pf2 = await ex(`return ${flagGrab}`);
    expect('topbar[paused]: same in-chip flag on the 2-provider team', pf2.kids === 1 && pf2.cls.includes('lm-danger') && /paused/.test(pf2.txt) && !pf2.flagEl, pf2);
    expect(`topbar[paused]: equal-width holds with the flag shown (${pf6.w}px vs ${pf2.w}px)`, pf6.w != null && pf2.w != null && Math.abs(pf6.w - pf2.w) <= 1, { six: pf6, two: pf2 });
    await shot('topbar-paused-1400');
    o6.subscriptionRateLimits = {};
    o.subscriptionRateLimits = {};
    console.log('[gui-e2e] topbar sweep', JSON.stringify(sweep.map(({ cw, hdrSw, hdrCw, goalW, clipped, kids, meterKids }) => ({ cw, hdrSw, hdrCw, goalW, clipped, kids, meterKids }))));
    win.setContentSize(prevSize[0], prevSize[1]); await ex(`await refresh(); await w(300);`);
  };
  try {
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'helpycode') { await helpycodeShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'wikilogs') { await wikiLogsShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'board') { await boardShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'conflict') { await conflictShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'graph') { await graphShots(); for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=team]').click(); await w(500);`); await shot(`graph-${t}`); } require('electron').nativeTheme.themeSource = 'system'; throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'chat') { await chatShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'chatmsg') { await chatMsgShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'windowing') { await windowingShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'firstrun') { await firstrunInbox(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'overview') { await overviewShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'teamscope') { await teamScopeShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'parallel') { await parallelShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'runidle') { await runIdleShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'mixed') { await mixedShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'limits') { await limitsShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'limits-providers') { await limitsProvidersShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'discovery') { await discoveryPanelShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'usage') { await usagePerModelShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'existingdata') { await existingDataShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'agentname') {
      const cur = await ex(`return { p: ctx.p, t: S.teamId }`); const ps = pm.store(cur.p || pid(), cur.t);
      if (!ps.getTeam().nodes.length) { ps.addNode({ name: 'Rhea', role: 'PM', x: 60, y: 60 }); await ex(`await refresh(); await w(300);`); }
      await ex(`$('#tabs button[data-tab=team]').click(); await w(300); $('#addnode').click(); await w(400); $('#addnode').click(); await w(400); $('#addnode').click(); await w(500);`);
      const names = ps.getTeam().nodes.map((n) => n.name); console.log('[gui-e2e] agentname', JSON.stringify(names));
      // Editor steps (t_28bbf522): rename through the form, then a manual role change must keep the typed name and the face.
      const tgt = ps.getTeam().nodes[ps.getTeam().nodes.length - 1];
      await ex(`selectNode('${tgt.id}'); await w(400); $('#nf-name').value = 'Renamy'; $('#nf-save').click(); await w(600); await refresh(); await w(300);`);
      expect('agentname: rename in the editor saved', ps.getTeam().nodes.find((n) => n.id === tgt.id).name === 'Renamy', ps.getTeam().nodes.map((n) => n.name));
      expect('agentname: renamed label on the graph', await ex(`return /Renamy/.test((document.querySelector('#graph .node[data-id="${tgt.id}"]') || {}).textContent || '')`));
      const av0 = await ex(`const g = document.querySelector('#graph .node[data-id="${tgt.id}"]'); return { bg: g.querySelector('.avatar').style.fill, face: (g.querySelector('image') || g.querySelector('img') || {}).getAttribute?.('href') || null }`);
      await ex(`selectNode('${tgt.id}'); await w(400); $('#nf-role').value = 'Reviewer'; $('#nf-save').click(); await w(600); await refresh(); await w(300);`);
      const av1 = await ex(`const g = document.querySelector('#graph .node[data-id="${tgt.id}"]'); return { bg: g.querySelector('.avatar').style.fill, face: (g.querySelector('image') || g.querySelector('img') || {}).getAttribute?.('href') || null }`);
      expect('agentname: manual role/avatar change sticks, typed name and face kept', ps.getTeam().nodes.find((n) => n.id === tgt.id).name === 'Renamy' && av1.bg !== av0.bg && av1.face === av0.face, { av0, av1 });
      await shot('agentname-rename');
      for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`await w(400);`); await shot(`agentname-${t}`); }
      require('electron').nativeTheme.themeSource = 'system'; throw null;
    }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'polish') { await polishShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'mainlogswiki') { await mainLogsWikiShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'teamfilter') { await teamFilterShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'logsdesign') { await logsDesignShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'audit') { await auditShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'critique') { await critiqueShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'wake') { await wakeShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'wakebusy') { await wakeBusyShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'monitorlog') { await monitorShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'alerts') { await alertsShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'packaged') { await packagedShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'subagents') { await subagentShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'dynamicteam') { await dynamicTeamShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'recruitinbox') { await recruitInboxShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'deletenode') { await deleteNodeShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'topbar') { await topbarShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'composerclear') { await composerClearShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'timelinelive') { await timelineLiveShots(); throw null; }
    // project/team management through the UI: create a project from the Startup template, then a Solo team, then switch back.
    // The template select renders with the Settings view (tab-scoped rendering, t_8d586961), so open
    // Settings first and wait until the first refresh has filled it before choosing a template.
    await ex(`$('#settingsbtn').click(); await w(300);`);
    expect('templates loaded', await waitFor(`return !!document.querySelector('#tpl-select option[value=startup]') && !!document.querySelector('#tpl-select option[value=solo]')`));
    const answer = (sel, text) => ex(`$('#tpl-select').value = '${sel[1]}'; if ($('#tpl-select').value !== '${sel[1]}') return false; $('${sel[0]}').click(); await w(200); $('#ask-input').value = '${text}'; $('#ask-ok').click(); await w(800); return true;`);
    expect('startup template selectable', await answer(['#newproject', 'startup'], 'GUI project'));
    expect('solo template selectable', await answer(['#newteam', 'solo'], 'Solo team'));
    await ex(`$('#tabs button[data-tab=team]').click(); await w(300);`); // the flow below clicks the graph
    await shot('0-projects');
    const mp = pm.list(); const gp = mp.find((p) => p.name === 'GUI project');
    const gpTeams = gp ? pm.get(gp.id).teams : []; const tn = (i) => (gpTeams[i] ? pm.store(gp.id, gpTeams[i].id).getTeam() : { nodes: [], edges: [] });
    const projInfo = { projects: mp.map((p) => p.name), guiTeams: gpTeams.map((t) => t.name), mainNodes: tn(0).nodes.map((n) => n.role), mainEdges: tn(0).edges.length, soloNodes: tn(1).nodes.length };
    console.log('[gui-e2e] projects', JSON.stringify(projInfo));
    expect('GUI project created', !!gp, projInfo);
    expect('Startup template: 4 nodes (PM, Dev, Reviewer, Critic) and 3 edges', tn(0).nodes.length === 4 && tn(0).edges.length === 3, projInfo);
    expect('Solo team created from template', gpTeams.length === 2 && tn(1).nodes.length === 1, projInfo);
    await ex(`document.querySelector('#projectlist [data-pid="${pid()}"]').click(); await w(600);`);
    await ex(`$('#addnode').click(); await w(400); $('#addnode').click(); await w(400);`);
    await ex(`$('#connect').click(); await w(200);`);
    const nodes = await ex(`return [...document.querySelectorAll('#graph .node')].map((g, i, a) => { const b = g.getBoundingClientRect(); return [i < a.length - 1 ? b.x + 8 : b.x + b.width - 24, b.y + b.height / 2]; });`); // added nodes overlap (20px offset): click each one's visible part
    for (const [x, y] of nodes) { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }); await new Promise((r) => setTimeout(r, 600)); }
    await shot('1-team');
    // F2: free-form role + per-agent permissions on the Dev, saved as a project role preset; edge type panel.
    const devId = store.getTeam().nodes[1].id;
    await ex(`const g = [...document.querySelectorAll('#graph .node')][1]; g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 })); window.dispatchEvent(new MouseEvent('mouseup')); await w(400);
      $('#nf-role').value = 'Builder'; $('#nf-model').value = 'haiku'; $('#nf-perms').open = true; $('#nf-maxturns').value = 40; $('#nf-disallowed').value = 'WebFetch'; $('#nf-env').value = 'SQUAD_GUI=1';
      [...document.querySelectorAll('#nf-tools input')].find((x) => x.value === 'write_wiki').checked = false;
      $('#nf-mode').value = 'goal'; $('#nf-mode').dispatchEvent(new Event('change')); $('#nf-goalcond').value = 'hello.txt exists and contains hello world'; $('#nf-maxiter').value = 3; $('#nf-continue').checked = true; $('#nf-billing').value = 'subscription'; $('#nf-billing').dispatchEvent(new Event('change'));
      $('#nf-savepreset').click(); await w(300); $('#ask-input').value = 'Builder'; $('#ask-ok').click(); await w(1000);`);
    await ex(`$('#nf-perms').open = true; await w(200);`); await shot('1b-agent');
    const modeVisible = await ex(`const g = $('.mode-goal'); return !!g && !g.classList.contains('hidden')`);
    // Model is a free-text field (with suggestions): a custom model ID can be typed.
    const customModel = await ex(`const i = $('#nf-model'); if (!i || i.tagName !== 'INPUT' || !i.list) return false; const old = i.value; i.value = 'my-proxy/model-x'; const ok = i.value === 'my-proxy/model-x'; i.value = old; return ok;`);
    expect('model field accepts a custom ID', customModel);
    await ex(`$('#graph .edge').dispatchEvent(new MouseEvent('click', { bubbles: true })); await w(400);`); await shot('1c-edge');
    const dn = store.getTeam().nodes.find((n) => n.id === devId);
    expect('agent fields saved from the panel', dn.role === 'Builder' && dn.model === 'haiku' && dn.maxTurns === 40 && dn.mode === 'goal' && dn.billingMode === 'subscription' && (dn.disabledBoardTools || []).includes('write_wiki'), dn);
    expect('goal mode fields visible', modeVisible);
    expect('Builder preset saved', store.getSettings().rolePresets.some((p) => p.name === 'Builder'));
    console.log('[gui-e2e] agent', JSON.stringify({ role: dn.role, model: dn.model, maxTurns: dn.maxTurns, disallowed: dn.disallowedTools, env: dn.env, disabledBoardTools: dn.disabledBoardTools, mode: dn.mode, goalCondition: dn.goalCondition, maxIterations: dn.maxIterations, continueSession: dn.continueSession, billingMode: dn.billingMode, modeVisible, presets: store.getSettings().rolePresets.map((p) => p.name), edgeForm: await ex(`return !!$('#ef-type')`) }));
    // F5: preflight "Test team" through the UI, badges on the nodes, then Run (auto-confirm the warning if any agent failed).
    await ex(`$('#graph').dispatchEvent(new MouseEvent('click')); await w(200);`);
    await click('#testteam');
    for (let i = 0; i < 90; i++) { await new Promise((r) => setTimeout(r, 2000)); if (await ex(`return !document.querySelector('#graph .pf-testing') && document.querySelectorAll('#graph .pfbadge').length > 0`)) break; }
    await new Promise((r) => setTimeout(r, 800));
    await ex(`const g = [...document.querySelectorAll('#graph .node')][0]; g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 })); window.dispatchEvent(new MouseEvent('mouseup')); await w(500);`);
    await shot('1d-preflight');
    // Badge must not cover the agent name.
    const overlap = await ex(`return [...document.querySelectorAll('#graph .node')].filter((g) => { const t = g.querySelector('text').getBoundingClientRect(); const b = g.querySelector('.pfbadge circle').getBoundingClientRect(); return !(t.right <= b.left || b.right <= t.left || t.bottom <= b.top || b.bottom <= t.top); }).length`);
    expect('preflight badges do not overlap names', overlap === 0, { overlap });
    const pfNodes = store.getTeam().nodes.map((n) => ({ name: n.name, ok: n.preflight && n.preflight.ok, error: n.preflight && n.preflight.error, apiKeySource: n.preflight && n.preflight.apiKeySource, ms: n.preflight && n.preflight.latencyMs }));
    expect('preflight badges shown', pfNodes.every((n) => typeof n.ok === 'boolean'), pfNodes);
    console.log('[gui-e2e] preflight', JSON.stringify({ nodes: pfNodes, badges: await ex(`return [...document.querySelectorAll('#graph .pfbadge text')].map((t) => t.textContent)`), summary: await ex(`return $('#pf-summary').textContent`), checks: await ex(`return document.querySelectorAll('#nf-pf .pf-checks li').length`) }));
    await ex(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return true; };`);
    await ex(`$('#goal').value = 'Create a file hello.txt containing exactly: hello world. PM should delegate the implementation to the Dev.'; $('#newgoal').click(); await w(150);`);
    await click('#run');
    for (let i = 0; i < 180; i++) { await new Promise((r) => setTimeout(r, 2000)); if (orch.runState().state === 'idle' && orch.runs > 0) break; }
    await new Promise((r) => setTimeout(r, 1500)); await shot('2-observability');
    // Header stays on one row once tokens and costs are filled in.
    const hdr = await ex(`const h = $('header'); const s = $('header strong'); return { h: h.getBoundingClientRect().height, title: s.getBoundingClientRect().height, cost: $('#totalcost').textContent }`);
    console.log('[gui-e2e] header', JSON.stringify(hdr));
    expect('header on one row', hdr.h < 56 && hdr.title < 24, hdr);
    expect('header money pill does not show $ for subscription-only runs', store.listRuns().some((r) => r.billingSource !== 'subscription') || !/\$/.test(hdr.cost), hdr);
    const hw = store.listTasks().find((t) => /hello\.txt/.test(t.title + t.description) && t.createdBy === 'human');
    expect('goal task done', hw && hw.status === 'done', hw && hw.status);
    await ex(`document.querySelector('#tabs button[data-tab=board]').click();`); await new Promise((r) => setTimeout(r, 500)); await shot('3-board');
    // F4: usage & billing tab (measured tokens, per-run history, CSV export).
    await ex(`document.querySelector('#tabs button[data-tab=usage]').click(); await w(600);`); await shot('4-usage');
    const runs = store.listRuns(); const csv = await api.usageCSV({ p: pid() });
    expect('usage recorded', runs.length > 0 && csv.trim().split('\n').length === runs.length + 1, { runs: runs.length });
    console.log('[gui-e2e] usage', JSON.stringify({ runs: runs.length, rows: await ex(`return document.querySelectorAll('#us-runs tr').length - 1`), tokens: runs.reduce((a, r) => a + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens, 0),
      models: [...new Set(runs.map((r) => r.model))], billing: [...new Set(runs.map((r) => r.billingSource))], csvLines: csv.trim().split('\n').length, subscriptionNote: await ex(`return document.body.innerText.includes('Covered by subscription')`) }));
    console.log('[gui-e2e] run warnings', JSON.stringify(await ex(`return window.__confirms || []`)));
    // F6: dependencies, approval gate, budget/approval settings, keyboard shortcuts, persisted logs, message to agent (no extra claude runs).
    const devNode = store.getTeam().nodes[1];
    const ta = store.createTask({ title: 'F6 build', assignee: devNode.id }); const tb = store.createTask({ title: 'F6 ship', assignee: devNode.id });
    store.updateTask(ta.id, { status: 'review', awaitingApproval: true });
    await ex(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, bubbles: true })); await w(300);`);
    const boardViaKey = await ex(`return document.querySelector('#tab-board').classList.contains('active')`);
    await ex(`$('#stop').click(); await w(600); document.querySelector('.card[data-id="${tb.id}"]').click(); await w(300);
      const cb = [...document.querySelectorAll('#td-deps input')].find((x) => x.value === '${ta.id}'); cb.checked = true; cb.dispatchEvent(new Event('change')); await w(800);
      $('#td-msg').value = 'Please also add a README'; $('#td-send').click(); await w(600);`);
    await shot('5-deps');
    const blockedTag = await ex(`return !!document.querySelector('.card[data-id="${tb.id}"] .tag.blocked')`);
    await ex(`document.querySelector('.card[data-id="${ta.id}"]').click(); await w(300);`); await shot('6-approval');
    await ex(`$('#td-note').value = 'looks good'; $('#td-approve').click(); await w(800);`);
    const afterApprove = { a: store.getTask(ta.id).status, bBlockedBy: store.getTask(tb.id).blockedBy, blockedTagAfter: await ex(`return !!document.querySelector('.card[data-id="${tb.id}"] .tag.blocked')`) };
    await ex(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '6', metaKey: true, bubbles: true })); await w(300);
      $('#st-budgetusd').value = 1.5; $('#st-approval').checked = true; $('#st-save').click(); await w(600);`);
    await shot('7-settings');
    await ex(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); await w(300);`); await shot('8-shortcuts');
    const helpOpen = await ex(`const o = $('#helpdlg').open; $('#helpdlg').close(); return o`);
    const st6 = store.getSettings();
    expect('F6: shortcut, deps, approval, settings, help', boardViaKey && blockedTag && afterApprove.a === 'done' && !afterApprove.blockedTagAfter && st6.budgetUsd === 1.5 && st6.requireApproval === true && helpOpen, { boardViaKey, blockedTag, afterApprove, helpOpen });
    console.log('[gui-e2e] f6', JSON.stringify({ boardViaKey, blockedTag, afterApprove, budgetUsd: st6.budgetUsd, requireApproval: st6.requireApproval, helpOpen,
      humanMsg: store.listMessages({ to: devNode.id }).filter((m) => m.from === 'human').length, savedLogLines: store.readLogs().length }));
    store.saveSettings({ requireApproval: false, budgetUsd: 0 });
    // F7: second project with its own run: team export/import, a failing preflight badge, and goal (multi-iteration,
    // resumed session), loop and workflow modes configured through the agent panel.
    if (gp) {
      const gpid = gp.id; const gorch = orchFor(gpid); const gstore = pm.store(gpid);
      const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'squad-gui7-'));
      fs.mkdirSync(path.join(work, '.claude', 'commands'), { recursive: true });
      fs.writeFileSync(path.join(work, '.claude', 'commands', 'e2ecmd.md'), 'Write a file cmd.txt in the current directory whose content is exactly: CMD-RAN $ARGUMENTS\nThen stop.\n');
      await ex(`document.querySelector('#tabs button[data-tab=team]').click(); document.querySelector('#projectlist [data-pid="${gpid}"]').click(); await w(800);`);
      await ex(`const d = [...document.querySelectorAll('#teamlist div')].find((x) => x.textContent === 'Solo team'); d.click(); await w(800);`);
      // Export through the button (capture the blob instead of downloading), then import it back through the file input.
      const exported = await ex(`let blob = null; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
        const oa = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
        $('#exportteam').click(); for (let i = 0; i < 25 && !blob; i++) await w(200); URL.createObjectURL = orig; HTMLAnchorElement.prototype.click = oa;
        if (!blob) return null; const text = await blob.text(); window.__exported = text; return text;`);
      const teamsBefore = pm.get(gpid).teams.length;
      await ex(`const dt = new DataTransfer(); dt.items.add(new File([window.__exported], 'solo.team.json', { type: 'application/json' })); const i = $('#importfile'); i.files = dt.files; i.dispatchEvent(new Event('change')); await w(1500);`);
      const gTeams = pm.get(gpid).teams; const imported = gTeams[gTeams.length - 1];
      let exportedNodes = -1; try { exportedNodes = JSON.parse(exported).nodes.length; } catch {}
      expect('team exported through the UI', exportedNodes === 1, { exported: String(exported).slice(0, 200) });
      expect('team imported through the UI', gTeams.length === teamsBefore + 1 && pm.store(gpid, imported.id).getTeam().nodes.length === 1, gTeams.map((t) => t.name));
      await ex(`$('#addnode').click(); await w(400); $('#addnode').click(); await w(400); $('#addnode').click(); await w(400);`);
      const tstore = pm.store(gpid, imported.id);
      const setNode = (i, js) => ex(`const g = [...document.querySelectorAll('#graph .node')][${i}]; g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 })); window.dispatchEvent(new MouseEvent('mouseup')); await w(400);
        $('#nf-workdir').value = ${JSON.stringify(work)}; $('#nf-model').value = 'haiku'; ${js} $('#nf-mode').dispatchEvent(new Event('change')); $('#nf-save').click(); await w(800);`);
      await setNode(0, `$('#nf-name').value = 'Goaler'; $('#nf-mode').value = 'goal'; $('#nf-goalcond').value = 'a file step2.txt exists in the working directory'; $('#nf-maxiter').value = 3;`);
      await setNode(1, `$('#nf-name').value = 'Looper'; $('#nf-mode').value = 'loop'; $('#nf-loopcount').value = 2;`);
      await setNode(2, `$('#nf-name').value = 'Flow'; $('#nf-mode').value = 'workflow'; $('#nf-slash').value = '/e2ecmd';`);
      await setNode(3, `$('#nf-name').value = 'BadModel'; $('#nf-model').value = 'claude-nonexistent-9';`);
      const tn7 = tstore.getTeam().nodes; const byName = (n) => tn7.find((x) => x.name === n) || {};
      expect('F7 modes saved from the panel', byName('Goaler').mode === 'goal' && byName('Looper').mode === 'loop' && byName('Looper').loopCount === 2 && byName('Flow').slashCommand === '/e2ecmd' && byName('BadModel').model === 'claude-nonexistent-9', tn7.map((n) => [n.name, n.mode, n.model]));
      // Failing preflight: test only the bad agent from its panel; its badge must turn red.
      await ex(`const g = [...document.querySelectorAll('#graph .node')][3]; g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 })); window.dispatchEvent(new MouseEvent('mouseup')); await w(400); $('#nf-test').click();`);
      const failBadge = await waitFor(`return !!document.querySelector('#graph .pfbadge.pf-fail')`, 120000);
      await new Promise((r) => setTimeout(r, 500)); await shot('9-preflight-fail');
      const bad = tstore.getTeam().nodes.find((n) => n.name === 'BadModel');
      expect('failing preflight badge shown', failBadge && bad.preflight && bad.preflight.ok === false, bad.preflight && { ok: bad.preflight.ok, error: bad.preflight.error });
      gstore.createTask({ title: 'Two steps', description: 'Iterative task. If step1.txt does NOT exist in the working directory: create step1.txt containing 1 and stop right away; do NOT create step2.txt in this pass. If step1.txt already exists: create step2.txt containing 2.', assignee: byName('Goaler').id });
      gstore.createTask({ title: 'Loop append', description: 'Append exactly one line containing only the letter L to the file loop.txt in the working directory (create it if missing). Do this once per pass.', assignee: byName('Looper').id });
      gstore.createTask({ title: 'ARGTEXT', assignee: byName('Flow').id });
      await ex(`window.confirm = () => true; window.__alerts = []; window.alert = (m) => window.__alerts.push(m); $('#goal').value = ''; $('#newgoal').click(); await refresh(); await w(300);`);
      await click('#run');
      for (let i = 0; i < 240; i++) { await new Promise((r) => setTimeout(r, 2000)); if (gorch.runState().state === 'idle' && gorch.runs > 0) break; }
      await new Promise((r) => setTimeout(r, 1500)); await shot('10-second-project');
      const gRuns = gstore.listRuns({ kind: 'agent' });
      const goalRuns = gRuns.filter((r) => r.nodeId === byName('Goaler').id); const loopRuns = gRuns.filter((r) => r.nodeId === byName('Looper').id);
      const rd = (f) => (fs.existsSync(path.join(work, f)) ? fs.readFileSync(path.join(work, f), 'utf8').trim() : null);
      const f7 = { goalRuns: goalRuns.map((r) => [r.iteration, !!r.resumedFrom, r.usageBasis, r.cacheReadTokens]), loopRuns: loopRuns.map((r) => [r.iteration, !!r.resumedFrom, r.usageBasis, r.cacheReadTokens]),
        step2: rd('step2.txt'), loopL: (rd('loop.txt') || '').split('\n').filter((l) => l.trim() === 'L').length, cmd: rd('cmd.txt'), mainProjectRuns: store.listRuns().filter((r) => r.projectId === gpid).length,
        goalTask: (gstore.listTasks().find((t) => t.title === 'Two steps') || {}).iterations };
      f7.alerts = await ex(`return window.__alerts`);
      console.log('[gui-e2e] f7', JSON.stringify(f7));
      expect('second project ran its own tasks', gRuns.length >= 4 && f7.mainProjectRuns === 0, f7);
      expect('goal needed 2+ iterations and resumed the session', goalRuns.length >= 2 && goalRuns.slice(1).every((r) => r.resumedFrom) && f7.step2 === '2', f7);
      expect('loop mode ran 2 passes through the GUI', loopRuns.length === 2 && f7.loopL === 2, f7);
      expect('workflow mode ran the slash command through the GUI', f7.cmd === 'CMD-RAN ARGTEXT', f7);
      expect('resumed runs are counted per run, not cumulatively', [...goalRuns, ...loopRuns].filter((r) => r.resumedFrom).every((r) => r.usageBasis === 'delta'), f7);
    }
    await firstrunInbox();
    await overviewShots();
    await chatShots();
    await windowingShots();
    if (!process.env.SKIP_GRAPH) await graphShots();
    // Main screens in light + dark (the renderer themes via prefers-color-scheme, driven by nativeTheme).
    const { nativeTheme } = require('electron');
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme; await ex(`await w(300);`);
      for (const tab of ['chat', 'team', 'board', 'inbox', 'overview', 'wiki', 'obs']) { await ex(`$('#tabs button[data-tab=${tab}]').click(); await w(500);`); await shot(`main-${tab === 'obs' ? 'logs' : tab}-${theme}`); }
      await ex(`$('#tabs button[data-tab=team]').click(); $('#reopenguide').click(); await w(400);`); await shot(`main-firstrun-${theme}`);
      expect(`firstrun guide opens (${theme})`, await ex(`return !$('#guide').classList.contains('hidden')`));
      await ex(`$('#g-close').click(); await w(200);`); // real dismiss (resets forced/hidden state), not just a CSS class -- otherwise the next renderGuide() re-opens it full-size over later shots
      // Idle detection on the real team: the PM's Dev report is working -> presence names the rest; Dev's node shows the busy arc.
      // (t_6674705d: the idle banner is gone; the same team-scoped idle detection is asserted on the presence chips.)
      const ip = (global.__idleP ||= pm.create('Idle demo')); const istore = pm.store(ip.id); const iorch = orchFor(ip.id);
      if (!istore.getTeam().nodes.length) { const [p, d, r] = [['PM', 'PM'], ['Dev', 'Dev'], ['Reviewer', 'Reviewer']].map(([name, role], i) => istore.addNode({ name, role, x: 80 + i * 220, y: 120 })); istore.addEdge(p.id, d.id); istore.addEdge(p.id, r.id); }
      const team = istore.getTeam(); const pmN = team.nodes.find((n) => n.role === 'PM'); const reps = team.edges.filter((e) => e.from === pmN.id).map((e) => e.to);
      const dev = team.nodes.find((n) => n.role === 'Dev'); const prevCtx = await ex(`const c = ctx; await switchTo({ p: '${ip.id}' }); await w(500); return c;`);
      const idleNames = team.nodes.filter((n) => n.id !== dev.id).map((n) => n.name);
      const idle = await ex(`$('#tabs button[data-tab=team]').click(); await w(300); const keep = [S.orch.agents, S.orch.idle];
        S.orch.agents = { '${dev.id}': { status: 'working' } }; S.orch.idle = S.allNodes.filter((n) => n.id !== '${dev.id}').map((n) => n.id);
        renderGraph(); renderIdle(); await w(300); window.__idleKeep = keep;
        const chips = [...document.querySelectorAll('#presence .pchip.idle')].map((c) => c.textContent).join('|');
        return { txt: chips, busy: document.querySelectorAll('#graph .pres.busy').length, idleRings: document.querySelectorAll('#graph .pres.idle').length };`);
      await shot(`idle-presence-${theme}`);
      expect(`presence chips name real idle agents, not busy Dev (${theme})`, idleNames.every((nm) => idle.txt.includes(nm)) && !idle.txt.includes(dev.name) && idle.busy === 1 && idle.idleRings === idleNames.length, { idle, idleNames, dev: dev.name });
      await ex(`[S.orch.agents, S.orch.idle] = window.__idleKeep; await switchTo(${JSON.stringify(prevCtx)}); await w(300);`);
      if (theme === 'dark') { // Live orchestrator nudge: PM with an open goal + idle reports gets a board message.
        const goal = istore.createTask({ title: 'Idle nudge goal', assignee: pmN.id, createdBy: pmN.id }); iorch.nudgeIdle();
        const msg = istore.listMessages().find((m) => m.from === 'system' && m.to === pmN.id && /idle:/.test(m.text));
        console.log('[gui-e2e] idle nudge', JSON.stringify(msg || null));
        expect('orchestrator nudgeIdle() posts the PM board message', !!msg && reps.every((id) => msg.text.includes(team.nodes.find((n) => n.id === id).name)), { msg });
        istore.updateTask(goal.id, { status: 'done' });
      }
      const bg = await ex(`return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`); expect(`theme ${theme} applied`, bg === BG[theme], { bg, dt: await ex(`return document.documentElement.dataset.theme + '|' + matchMedia('(prefers-color-scheme: dark)').matches + '|' + getComputedStyle(document.documentElement).getPropertyValue('--bg-app')`) });
    }
    if (!process.env.SKIP_WIKILOGS) await mainLogsWikiShots();
    if (!process.env.SKIP_TEAMFILTER) await teamFilterShots();
    if (!process.env.SKIP_CRITIQUE) await critiqueShots();
    if (!process.env.SKIP_RUNIDLE) await runIdleShots();
    if (!process.env.SKIP_LIMITS) await limitsShots();
    if (!process.env.SKIP_LIMITS_PROVIDERS) await limitsProvidersShots();
    if (!process.env.SKIP_DISCOVERY) await discoveryPanelShots();
    if (!process.env.SKIP_USAGEPM) await usagePerModelShots();
    nativeTheme.themeSource = 'system';
    const tasks = store.listTasks();
    console.log('[gui-e2e]', JSON.stringify({ edges: store.getTeam().edges.length, tasks: tasks.map((t) => [t.title, t.status, t.iterations || 0, !!t.sessions]), cost: orch.snapshot().totalCost }));
  } catch (e) { if (e !== null) { console.error('[gui-e2e] failed', e); failures.push('exception: ' + e.message); } }
  console.log(failures.length ? `[gui-e2e] FAIL (${failures.length}): ${failures.join('; ')}` : '[gui-e2e] PASS');
  if (procguard) procguard.reapAll();
  app.exit(failures.length ? 1 : 0);
}
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

// Every API call receives ctx = { p: projectId, t: teamId } from the renderer first.
  const ST = (c) => pm.store(c.p); // project-wide (board, wiki, settings, merged team)
  const TS = (c) => { const ts = pm.get(c.p).teams; return pm.store(c.p, (ts.find((t) => t.id === c.t) || ts[0]).id); }; // the selected team graph
  // Cheap change fingerprint for the renderer's polling (t_9d92c3d3): file signatures + the
  // orchestrator's in-memory sig. `team` folds in settings because getAll decorates team nodes withPF.
  const stateVersion = (c) => { const s = ST(c); const t = TS(c); const v = s.versions(); v.team = t.sigFile(t.teamFile()) + '|' + v.settings; v.teams = v.teams + '|' + v.settings; v.orch = orchFor(c.p).versionSig(); return v; };
const withPF = (nodes, settings) => nodes.map((n) => ({ ...n, preflightStatus: PF.preflightStatus(n, settings) }));
// Test one agent with its exact config and save the result on the node (in whichever team owns it).
async function testAgent(c, nodeId) {
  const s = ST(c); const settings = s.getSettings();
  const team = pm.get(c.p).teams.find((t) => pm.store(c.p, t.id).getTeam().nodes.some((n) => n.id === nodeId));
  if (!team) throw new Error('no agent ' + nodeId);
  const ts = pm.store(c.p, team.id); const node = ts.getTeam().nodes.find((n) => n.id === nodeId);
  const r = await orchFor(c.p).preflight(node, settings);
  ts.updateNode(nodeId, { preflight: r });
  send('state', { ...orchFor(c.p).snapshotSlim(), projectId: c.p });
  return r;
}
async function testTeam(c) {
  const nodes = TS(c).getTeam().nodes; const limit = Math.max(1, ST(c).getSettings().maxConcurrency || 2);
  const out = {}; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, nodes.length) }, async () => { while (i < nodes.length) { const n = nodes[i++]; try { out[n.id] = await testAgent(c, n.id); } catch (e) { out[n.id] = { ok: false, error: e.message }; } } }));
  return out;
}
const wtTask = (c, id) => { const t = ST(c).listTasks().find((x) => x.id === id); if (!t || !t.worktreePath) throw new Error('task has no worktree'); return t; };
// Backend RuntimeProfile (low-level: argsTemplate/effortValues/effortFlag/resumeFlag/mcp/eventMapping
// with dotted paths) -> renderer's draft-profile schema (label/bin/version/models/defaultModel/effort/
// variants/resume/eventMapping{kind:label}), agreed with Uma per t_833956fa. Conversion lives here so
// neither side has to know the other's shape.
function toDraftProfile(bin, profile, derived = {}) {
  const hasModels = Array.isArray(profile.modelsCommand) && profile.modelsCommand.length > 0;
  const em = profile.eventMapping || {};
  const models = (derived.models || []).length ? derived.models : (hasModels ? [] : ['default']);
  return {
    label: profile.label || bin, bin: profile.binary || bin, version: null,
    models, defaultModel: models[0] || '',
    effort: profile.effortValues || [], variants: [],
    resume: !!profile.resumeFlag,
    eventMapping: {
      text: em.textPath || 'text', session: em.sessionIdPath || 'session_id', cost: em.costPath || 'cost',
      input: em.inputPath || 'input_tokens', output: em.outputPath || 'output_tokens',
      reasoning: em.reasoningPath || 'reasoning_tokens', cache: em.cachePath || 'cache_read_tokens',
    },
    // per-field provenance ({source, confidence}) from the introspector: the UI shows where every
    // value came from (help/models/probe/agent); 'agent' sources are low-confidence and opt-in.
    sources: derived.sources || {},
  };
}
const api = {
  introspectRuntime: (_c, bin) => { const r = runIntrospectRuntime(bin); return toDraftProfile(bin, r.profile, r); },  listProjects: () => ({ projects: pm.list().map((p) => ({ ...p, running: !!(orchs.get(p.id) || {}).running })), templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.label])) }),
  createProject: (_c, name, tpl) => pm.create(name, tpl), renameProject: (_c, pid, name) => pm.rename(pid, name),
  deleteProject: (_c, pid) => { if ((orchs.get(pid) || {}).running) throw new Error('stop the project first'); const p = pumps.get(pid); if (p) { p.close(); pumps.delete(pid); } orchs.delete(pid); return pm.remove(pid); },
  createTeam: (c, name, tpl) => pm.createTeam(c.p, name, tpl), renameTeam: (c, tid, name) => pm.renameTeam(c.p, tid, name),
  deleteTeam: (c, tid) => pm.removeTeam(c.p, tid), duplicateTeam: (c, tid) => pm.duplicateTeam(c.p, tid),
  exportTeam: (c, tid) => pm.exportTeam(c.p, tid), importTeam: (c, json) => pm.importTeam(c.p, json),
  // Delta getAll (t_9d92c3d3): with `since` (the client's last version map) only sections whose
  // signature changed are returned, so the 2s poll moves kilobytes instead of ~1.8MB of JSON.
  // Without `since` (first load, project switch, old callers) every section is returned as before.
  getAll: (c, since) => {
    const s = ST(c); const t = TS(c); probeUnprobedAgents(c.p);
    const v = stateVersion(c);
    const all = { project: s.meta(), team: { ...t.getTeam(), nodes: withPF(t.getTeam().nodes, s.getSettings()) }, allNodes: withPF(s.getTeam().nodes, s.getSettings()), tasks: s.listTasks(), wiki: s.listWiki(), settings: s.getSettings(), messages: s.listMessages().slice(-200), orch: orchFor(c.p).snapshotSlim(),
      config: { runtimes: runtimes(s.getSettings()), billingModes: U.BILLING_MODES, permissionModes: AC.PERMISSION_MODES, edgeTypes: AC.EDGE_TYPES, boardTools: AC.BOARD_TOOLS, roles: AC.roleSuggestions(s.getSettings().rolePresets, s.getTeam().nodes) } };
    const sectionOf = { project: 'project', team: 'team', teams: 'allNodes', board: 'tasks', wiki: 'wiki', settings: 'settings', messages: 'messages', orch: 'orch' };
    const out = { v, teamId: t.teamId, dir: s.dir };
    for (const k of pickChanged(v, since)) { if (sectionOf[k]) out[sectionOf[k]] = all[sectionOf[k]]; if (k === 'settings') out.config = all.config; }
    return out;
  },
  getStateVersion: (c) => stateVersion(c),
  // New agents are auto-probed for capabilities right away (same probe as the manual Refresh button) so the
  // node form and graph badges never sit on "not probed yet" for an agent the user just added.
  addNode: (c, n) => {
    const node = TS(c).addNode(n);
    try {
      const rt = RT.getRuntime(node.runtime);
      const capabilities = CAP.discoverCapabilities(rt, ST(c).getSettings());
      return TS(c).updateNode(node.id, { capabilities, capabilitiesProbedAt: capabilities.probedAt });
    } catch (e) { return node; }
  },
  updateNode: (c, id, p) => TS(c).updateNode(id, p), removeNode: (c, id) => TS(c).removeNode(id),
  // Human-only: the single writer of node.protected (the UI's agent-editor toggle). IPC is reachable
  // only from the renderer; no MCP tool wraps it, and updateNode/store refuse the key everywhere else.
  setNodeProtected: (c, id, v) => TS(c).setNodeProtected(id, v),
  addEdge: (c, a, b, type) => TS(c).addEdge(a, b, type), updateEdge: (c, id, p) => TS(c).updateEdge(id, p),
  savePreset: (c, p) => ST(c).savePreset(p), deletePreset: (c, name) => ST(c).deletePreset(name), removeEdge: (c, id) => TS(c).removeEdge(id),
  createTask: (c, t) => ST(c).createTask(t), updateTask: (c, id, p) => ST(c).updateTask(id, p), deleteTask: (c, id) => ST(c).deleteTask(id),
  // Paste/upload: bytes land on disk under <store>/attachments and only {path,name,mime,size} comes
  // back ({error} on rejection) — messages.json never holds base64.
  saveAttachment: (c, input) => ST(c).saveAttachment(input || {}),
  commentTask: (c, id, text) => ST(c).commentTask(id, 'human', text),
  // Unclean-exit recovery info (t_2ca99830): what the renderer's banner (Uma, t_6911ba60) shows —
  // whether the previous instance died without a clean exit, when it was last seen alive, and
  // which orphan runs were reaped (with their interrupted tasks) at this boot.
  getLastExit: (c) => bootRecovery(c.p) || { unclean: false, reaped: [], interruptedTasks: [] },
  writeWiki: (c, t, x) => ST(c).writeWiki(t, x, 'human'), deleteWiki: (c, t) => ST(c).deleteWiki(t),
  listWikiSummaries: (c) => ST(c).listWikiSummaries(), searchWiki: (c, q) => ST(c).searchWiki(q),
  listSessions: (c, nodeId) => ST(c).listSessions({ nodeId }), getSessionLog: (c, sessionId, opts) => ST(c).getSessionLog(sessionId, opts || {}),
  saveSettings: (c, s) => ST(c).saveSettings(s),
  listRuns: (c, f) => ST(c).listRuns(f || {}), clearRuns: (c) => ST(c).clearRuns(), usageCSV: (c, all) => U.toCSV(all ? pm.list().flatMap((p) => pm.store(p.id).listRuns()) : ST(c).listRuns()),
  // Per project: the usage ledger's $ totals and key count. Token amounts are only offered per
  // {runtime, provider, model} key (usageLedger) — never as a cross-model sum.
  usageByProject: () => pm.list().map((p) => { const l = U.usageLedger(pm.store(p.id).listRuns()); return { id: p.id, name: p.name, runs: l.rows.reduce((a, r) => a + r.runs, 0), keys: l.rows.length, costUsd: l.costUsd, costPartial: l.costPartial }; }),
  // Run-derived counts alone miss it when the CLI itself reports a higher subscription rate-limit %
  // (e.g. usage from other clients sharing the same subscription window), so fold in the CLI's own
  // reported utilization (usage.js parseRateLimits, fed by orchestrator's init-event handling) whenever
  // it's more constraining than the local run count.
  usageStatus: (c) => {
    const s = ST(c); const settings = s.getSettings();
    const runs = s.listRuns();
    const status = U.usageStatus(runs, settings.usageLimits);
    const warnPct = (settings.usageLimits && settings.usageLimits.warnPct) || 80;
    const inMemory = orchFor(c.p).subscriptionRateLimits || {};
    // The in-memory map is only populated after a run/probe this session, so it's empty right after a restart —
    // fall back to each node's persisted rateLimits snapshot (discoverCapabilities/orchestrator writes
    // node.rateLimits alongside the in-memory map) so a restart doesn't lose the last known real CLI %.
    const nodes = TS(c).getTeam().nodes;
    // nodeLiveRateLimits, not liveRateLimits alone: a reading captured by a runtime the node has since
    // left (e.g. claude -> helpycode) must not meter or pause under the new provider.
    const rlAll = nodes.map((n) => U.nodeLiveRateLimits(n, inMemory)).filter(Boolean);
    // Provider-keyed view (t_8f8ab37d): one entry per provider the team's agents actually run, each carrying
    // its own windows — Claude's CLI-reported 5h/weekly among them, others 'unknown' until their CLI reports.
    const providers = U.usageProviders({ runs, limits: settings.usageLimits, nodes, rateLimitsByNode: inMemory, warnPct });
    return { ...U.applyCliRateLimits(status, rlAll, warnPct), providers };
  },
  // Real per-provider subscription usage (5h/weekly used % + reset time) for one agent, as self-reported by its
  // own CLI's init event — with an explicit reason when there is nothing to report yet.
  providerUsage: (c, nodeId) => {
    const s = ST(c); const node = TS(c).getTeam().nodes.find((n) => n.id === nodeId); if (!node) throw new Error('no agent ' + nodeId);
    const rl = U.nodeLiveRateLimits(node, orchFor(c.p).subscriptionRateLimits || {}) || null;
    const installed = runtimes(s.getSettings())[node.runtime] ? runtimes(s.getSettings())[node.runtime].installed : undefined;
    return U.providerUsageStatus(rl, { installed, billingMode: node.billingMode });
  },
  // Manual Refresh: the --help probe alone. If this node has never had a real init event (no capabilities at
  // all, or a capabilities snapshot that only ever came from --help/local scan), --help text is a poor substitute
  // for the CLI's own real slash_commands/skills, so fall back to one live
  // `claude -p --output-format stream-json --verbose` probe (capabilities.probeInitEvent) to seed a real snapshot
  // — the same data a normal run's init/rate_limit_event would have given us for free. If a real init event was
  // already captured (this session or a prior one), it's the CLI's own authoritative report — Refresh's --help
  // probe must not clobber it with smaller/fallback data, so its slash_commands/skills/modes are kept as-is.
  discoverCapabilities: async (c, nodeId) => {
    const node = TS(c).getTeam().nodes.find((n) => n.id === nodeId); if (!node) throw new Error('no agent ' + nodeId);
    const rt = RT.getRuntime(node.runtime);
    const settings = ST(c).getSettings();
    const prevCap = node.capabilities;
    const hasPrevInit = !!(prevCap && prevCap.source === 'init-event');
    const prevSlashCommands = (prevCap && Array.isArray(prevCap.slashCommands)) ? prevCap.slashCommands : [];
    let capabilities = CAP.discoverCapabilities(rt, settings, { prevSlashCommands });
    if (hasPrevInit) {
      const mcpServers = Object.keys((settings.mcpServers && typeof settings.mcpServers === 'object') ? settings.mcpServers : {});
      const modes = [...new Set([...CAP.detectAppModes('', prevCap.slashCommands), ...(prevCap.modes || [])])];
      const categorized = CAP.categorize({ modes, skills: prevCap.skills, slashCommands: prevCap.slashCommands, mcpServers });
      capabilities = { ...capabilities, source: prevCap.source, slashCommands: prevCap.slashCommands, skills: prevCap.skills, modes, categorized };
    }
    const patch = { capabilities, capabilitiesProbedAt: capabilities.probedAt };
    if (!hasPrevInit) {
      try {
        const { init, rateLimit } = await CAP.probeInitEvent(rt.bin(settings), { cwd: settings.workdir, env: process.env });
        if (init) {
          capabilities = CAP.discoverCapabilities(rt, settings, { initEvent: init });
          patch.capabilities = capabilities; patch.capabilitiesProbedAt = capabilities.probedAt;
        }
        const rl0 = rateLimit ? U.parseRateLimits(rateLimit) : null;
        if (rl0) { const rl = { ...rl0, runtime: rt.id }; patch.rateLimits = rl; patch.rateLimitsAt = new Date().toISOString(); (orchFor(c.p).subscriptionRateLimits ||= {})[nodeId] = rl; }
      } catch {}
    }
    const kept = capabilities !== node.capabilities && CAP.mergeCapabilities(node.capabilities, capabilities) === node.capabilities;
    if (kept) { capabilities = node.capabilities; patch.capabilities = node.capabilities; patch.capabilitiesProbedAt = node.capabilitiesProbedAt; }
    TS(c).updateNode(nodeId, patch);
    return capabilities;
  },
  testAgent, testTeam,
  stopAgent: (c, nodeId) => orchFor(c.p).stopAgent(nodeId), sendToAgent: (c, nodeId, text, taskId, extra) => orchFor(c.p).sendToAgent(nodeId, text, taskId, extra),
  listInbox: (c) => ST(c).listInbox({ status: 'open' }),
  // Recording the answer is not enough for askGate approvals (recruit/retire/update): the core is
  // idle by then, so team-answers.js applies/consumes the answered item right here and messages the
  // core. It never throws — the answer is already recorded either way.
  answerInbox: (c, id, answer) => { const s = ST(c); const r = s.answerInbox(id, answer); applyAnsweredChange(s, orchFor(c.p), s.getInboxItem(id), answer); return r; },
  inboxCounts: () => Object.fromEntries(pm.list().map((p) => [p.id, pm.store(p.id).listInbox({ status: 'open' }).length])),
  approveTask: (c, id, ok, note) => ST(c).approveTask(id, ok, note), getLogs: (c, n) => ST(c).readLogs(n || 2000), clearLogs: (c) => ST(c).clearLogs(),
  taskDiff: (c, id) => WT.worktreeDiff(wtTask(c, id)),
  taskMerge: (c, id, opts) => ST(c).mergeTask(id, opts),
  taskDiscard: (c, id) => { const r = WT.worktreeDiscard(wtTask(c, id)); ST(c).updateTask(id, { worktreePath: null, worktreeBranch: null }); return r; },
  unmergedBranches: (c) => ST(c).listUnmergedBranches(),
  // Worktree lifecycle (t_9b662983): cached worktree count + bytes for the header/settings UI.
  getDiskUsage: (c) => WT.diskUsage(APP_ROOT),
  pickDir: async () => { const { dialog } = require('electron'); const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
  agentStates: (c) => orchFor(c.p).agentStates(),
  // Live per-node data for the graph: runtime, model, status (working|idle|needs-human).
  nodeStatus: (c) => { const s = ST(c); const st = orchFor(c.p).agentStates(); const ag = orchFor(c.p).agents || {}; const inbox = s.listInbox({ status: 'open' });
    return Object.fromEntries(s.getTeam().nodes.map((n) => [n.id, { runtime: n.runtime, model: n.model || null, teamId: n.teamId,
      status: inbox.some((i) => i.nodeId === n.id) ? 'needs-human' : (ag[n.id] || {}).status === 'working' || st[n.id] === 'busy' ? 'working' : 'idle' }])); },
  crossEdges: (c) => TS(c).incomingCrossEdges(), setViewport: (c, v) => TS(c).setViewport(v), getViewport: (c) => TS(c).getViewport(), setPositions: (c, pos) => TS(c).setPositions(pos),
  run: (c) => orchFor(c.p).start(), stop: (c) => orchFor(c.p).stop(),
  // Core-agent watch (plan t_42f310cf item 2): pull the watch indicator state; live updates arrive on the 'watch-status' push channel.
  getWatchStatus: (c) => orchFor(c.p).watchStatus(),
  // Scheduled restarts (plan t_42f310cf item 1): pull state + the pill's two actions (t_8c795573);
  // live updates arrive on the 'restart-state' push channel.
  getRestartState: (c) => orchFor(c.p).restartState(),
  restartNow: (c) => { orchFor(c.p).restartNow(); return orchFor(c.p).restartState(); },
  cancelRestart: (c) => { orchFor(c.p).cancelRestart(); return orchFor(c.p).restartState(); },
  // Runtime breaker resume (t_419062e2): clears the unavailable state and re-dispatches the queued
  // tasks. Throws the reason on failure — the renderer shows it inline in the banner.
  resumeRuntime: (c, runtime) => orchFor(c.p).resumeRuntime(runtime),
  // Stuck-task action (t_0895a580): the renderer's 'Retest + Resume' / 'Rerun fresh' buttons
  // (t_747e0d1e). Returns {ok, skipped?|resumeFailed?, error?}; resumeFailed flips the button state.
  retestAndResume: (c, id) => orchFor(c.p).retestAndResume(id), rerunFresh: (c, id) => orchFor(c.p).rerunFresh(id),
  getSelfUpdateStatus: (c) => ({ ...watcherFor(c.p).status(), devMode: DEV_MODE }),
  setAutoRestart: (c, on) => { if (DEV_MODE) ST(c).saveSettings({ autoRestart: !!on }); return { ...watcherFor(c.p).status(), devMode: DEV_MODE }; },
  restartSelfUpdate: (c) => { watcherFor(c.p).restartNow(); return { ...watcherFor(c.p).status(), devMode: DEV_MODE }; },
  getPrefs: () => getPrefs(), setPrefs: (_c, patch) => setPrefs(patch || {}),
};
nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']); send('theme', { dark: nativeTheme.shouldUseDarkColors }); });
ipcMain.handle('api', async (_e, name, ctx, ...args) => {
  if (!api[name]) throw new Error('unknown api ' + name);
  return api[name](ctx || {}, ...args);
});

// Human inbox watcher: MCP servers write inbox.json from other processes, so poll for new open items.
const seenInbox = new Set();
function pollInbox(first) {
  for (const p of pm.list()) {
    let items = []; try { items = pm.store(p.id).listInbox({ status: 'open' }); } catch {}
    for (const it of items) if (!seenInbox.has(it.id)) {
      seenInbox.add(it.id); if (first) continue;
      const n = { title: it.kind === 'approval' ? 'Approval needed' : 'Agent asks you', body: it.question, taskId: it.taskId, inbox: true };
      send('notify', { ...n, projectId: p.id }); notify(n, p.id);
    }
  }
}

app.whenReady().then(() => {
  if (!appLockHeld) return; // second launch: the running instance stays, this one exits
  createWindow();
  probeUnprobedAgents();
  for (const p of pm.list()) pumpFor(p.id); // delta pumps stream every project's changes (t_39bf39ac)
  pollInbox(true); setInterval(() => pollInbox(false), 1500);
  // Unclean-exit detection must see the PREVIOUS instance's heartbeat (t_2ca99830): recover for
  // every known project before the heartbeat below stamps over the evidence.
  for (const p of pm.list()) { try { bootRecovery(p.id); } catch {} }
  // Heartbeat breadcrumb (t_2ca99830): the lock holder stamps each store dir every few seconds;
  // a boot that finds the stamp without a clean marker knows the last instance died silently.
  const heartbeat = () => { for (const p of pm.list()) { try { BS.writeAlive(pm.store(p.id).dir); } catch {} } };
  heartbeat();
  setInterval(heartbeat, 5000);
  // Worktree lifecycle sweep (t_9b662983): at boot (before any agent can spawn) and periodically
  // while each project is idle — drops worktrees whose task is done/missing (clean + merged only,
  // never a dirty or unmerged tree, never in-flight tasks) and prunes stale worktree entries.
  // Harness guard (t_e23df71f): perf/e2e drivers boot the app with a throwaway AGENTS_SQUAD_PROJECT
  // whose store knows none of this repo's tasks — sweeping APP_ROOT from it deleted live worktrees
  // (worktree.js also retains unknown ids as the second belt). Only a real install root may sweep.
  const sweepableRoot = !TEST_MODE && !pm.root.startsWith(require('os').tmpdir());
  const sweepWorktrees = () => { if (!sweepableRoot) return; for (const p of pm.list()) { try { const o = orchs.get(p.id); if (o && o.running) continue; const r = WT.sweepWorktrees({ repoDir: APP_ROOT, store: pm.store(p.id) }); if (r.removed.length || r.retained.length) console.log('[worktrees]', JSON.stringify(r)); } catch {} } };
  sweepWorktrees();
  setInterval(sweepWorktrees, 10 * 60_000).unref();
  // Self-update: resume a Run interrupted by a safe restart (or roll back a bad update that fails to
  // boot). markBootOk ~15s in proves the new code booted, so a later crash is not a boot failure.
  for (const p of pm.list()) {
    if (!DEV_MODE) continue; // real users: no self-update polling, no boot resume/rollback
    try {
      const r = SU.bootResume(pm.store(p.id), { repoDir: APP_ROOT });
      watcherFor(p.id); // start polling for new commits right away
      if (r.resume) setImmediate(() => orchFor(p.id).start());
    } catch (e) { console.error('[self-update] boot resume failed:', e.message); }
  }
  setTimeout(() => { for (const p of pm.list()) { try { SU.markBootOk(pm.store(p.id)); } catch {} } }, 15000).unref();
  console.log('[agents-squad] ready, data root:', pm.root);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { for (const o of orchs.values()) if (o.running) o.stop(); if (process.platform !== 'darwin') app.quit(); });
// Any exit we can still act on must stamp the breadcrumbs clean (t_2ca99830), or the next boot
// shows a false "died silently". app.exit() skips 'will-quit' — relaunchApp marks clean itself.
function markCleanExits() {
  if (!appLockHeld) return;
  for (const p of pm.list()) { try { BS.writeAlive(pm.store(p.id).dir, { cleanExitAt: Date.now() }); } catch {} }
}
app.on('will-quit', () => { try { BoardCache.closeAll(); } catch {} }); // no leaked fs.watch handles across project switches/quit
app.on('will-quit', markCleanExits);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  try {
    process.on(sig, () => { try { markCleanExits(); } catch {} app.exit(0); });
  } catch {}
}
