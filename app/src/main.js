const { app, BrowserWindow, ipcMain, Notification, nativeTheme } = require('electron');
const path = require('path');
const { Orchestrator } = require('./orchestrator');
const { ProjectManager, TEMPLATES } = require('./projects');
const { pickChanged } = require('./store');
const AC = require('./agent-config');
const WT = require('./worktree');
const U = require('./usage');
const PF = require('./preflight');
const RT = require('./runtimes');
const CAP = require('./capabilities');
const SU = require('./self-update');
const { introspectRuntime: runIntrospectRuntime } = require('./introspector');
// The app repo (main checkout): what the UpdateWatcher polls and fast-forwards.
const APP_ROOT = path.join(__dirname, '..', '..');
// Self-update (auto-restart on new merged code) is a developer/dogfood feature: only unpackaged
// runs (electron .) get it. A packaged build — real users — never starts a watcher and shows no
// update UI; AGENTS_SQUAD_DEV=1 opts a packaged build back into dogfood mode, =0 forces it off
// from source (e.g. to check the gated-off UX). Exported so agents' MCP servers inherit the gate.
const DEV_MODE = process.env.AGENTS_SQUAD_DEV ? process.env.AGENTS_SQUAD_DEV !== '0' : !app.isPackaged;
if (DEV_MODE) process.env.AGENTS_SQUAD_DEV = '1';
let runtimesCache = null; // detected once per app start (binary + version)
const runtimes = (settings) => (runtimesCache ||= RT.detectRuntimes(settings, { ...process.env, PATH: [process.env.PATH, require('os').homedir() + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(':') }));

const pm = new ProjectManager();
const orchs = new Map(); // projectId -> Orchestrator (projects run independently / concurrently)
function orchFor(pid) {
  let o = orchs.get(pid);
  if (!o) {
    o = new Orchestrator(pm.store(pid));
    o.on('log', (l) => send('log', { ...l, projectId: pid }));
    o.on('state', (s) => send('state', { ...s, projectId: pid })); // slim: the renderer refreshes from the store on receipt
    o.on('notify', (n) => { send('notify', { ...n, projectId: pid }); notify(n, pid); });
    o.on('woken_by_message', (w) => send('woken_by_message', { ...w, projectId: pid }));
    o.on('run.stalled', (e) => send('run-stalled', { ...e, projectId: pid }));
    o.on('run.recovering', (e) => send('run-recovering', { ...e, projectId: pid }));
    o.on('run.recovery_failed', (e) => send('run-recovery-failed', { ...e, projectId: pid }));
    orchs.set(pid, o);
  }
  return o;
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
      relaunch: () => { app.relaunch(); app.exit(0); },
      procCount: () => (orchs.get(pid) || { procs: new Map() }).procs.size,
      runActive: () => (orchs.get(pid) || {}).running || false,
      // Unpausing after an aborted update must re-tick: the drain held the run session open with
      // nothing dispatched, so only this nudge resumes dispatching.
      setPaused: (v) => { const o = orchs.get(pid); if (o) { o.dispatchPaused = v; if (!v) setImmediate(() => o.tick()); } },
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
  win = new BrowserWindow({ width: 1400, height: 900, title: 'Agents Squad', backgroundColor: BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'],
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
    app.exit(0);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[agents-squad] renderer gone', d.reason));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}
// GUI e2e: drive the real UI with clicks, run a PM -> Dev team, screenshot each tab.
async function guiE2E() {
  const out = process.env.AGENTS_SQUAD_GUI_E2E; const fs = require('fs');
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
    ib.badge = await ex(`await refresh(); return $('#inbox-badge').textContent`);
    await ex(`$('#tabs button[data-tab=inbox]').click(); await w(400);`); await shot('15-inbox-question');
    ib.clicked = await ex(`const b = [...document.querySelectorAll('.ib-choice')].find((x) => x.dataset.v === 'blue'); if (!b) return false; b.click(); await w(800); return true;`);
    ib.statusAfterAnswer = q && q.taskId && fstore.getTask(q.taskId).status; ib.answer = q && fstore.getInboxItem(q.id).answer;
    await shot('15-inbox-answered');
    for (let i = 0; i < 150; i++) { await new Promise((r) => setTimeout(r, 2000)); if (!forch.running) break; }
    ib.color = fs.existsSync(path.join(work, 'color.txt')) ? fs.readFileSync(path.join(work, 'color.txt'), 'utf8').trim() : null;
    ib.badgeAfter = await ex(`await refresh(); return $('#inbox-badge').textContent`);
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
    ps.sendMessage({ from: a.id, to: b.id, text: 'Please keep it vanilla JS.', taskId: t.id }); ps.commentTask(t.id, b.id, 'On it.');
    const q = ps.addInbox({ kind: 'question', taskId: t.id, nodeId: b.id, question: 'Dark or light theme?', choices: ['dark', 'light'] });
    const L = (ago, nodeId, kind, text) => `logs.push({ projectId: ctx.p, nodeId: '${nodeId}', kind: '${kind}', text: ${JSON.stringify(text)}, at: Date.now() - ${ago} });`;
    await ex(`$('#tabs button[data-tab=chat]').click(); ${L(90000, b.id, 'system', '▶ ' + b.name + ' starts "Chat demo" in /x')}${L(80000, b.id, 'text', 'I will add a chat view with bubbles and tool chips.')}
      ${L(70000, b.id, 'tool', 'Read {"file_path":"renderer/app.js"}')}${L(69000, b.id, 'tool_result', '587 lines')}${L(60000, b.id, 'tool', 'Bash {"command":"npm test"}')}${L(59000, b.id, 'tool_result', 'pass 78 fail 0')}
      await refresh(); chatSig = null; renderChat(); await w(300); document.querySelector('#chat-room .cchip').open = true; await w(200);`);
    const room = await ex(`return { groups: document.querySelectorAll('#chat-room .cgroup').length, avatars: document.querySelectorAll('#chat-room .avatar').length, chips: document.querySelectorAll('#chat-room .cchip').length, question: !!document.querySelector('#chat-room .bubble.question .ch-choice'), roles: document.querySelectorAll('#chat-room .role').length, defaultTab: !!$('#tabs button[data-tab=chat]') && TABS[0] === 'chat' }`);
    expect('chat: room with bubbles, avatars, role badges, tool chips, inline question', room.groups >= 2 && room.chips >= 2 && room.question && room.roles >= 2 && room.defaultTab, room);
    await ex(`await refresh(); chatSig = null; renderChat(); document.querySelector('#chat-room .cchip').open = true; await w(200);`); await shot('17-chat-room');
    await ex(`document.querySelector('#chat-room [data-thread="${t.id}"]').click(); await w(300);`);
    const th = await ex(`return { open: !$('#chat-thread').classList.contains('hidden'), title: $('#chat-thread .chat-head').textContent, items: document.querySelectorAll('#chat-threadroom .bubble, #chat-threadroom .cchip').length }`);
    expect('chat: thread pane shows the task', th.open && th.title.includes('Chat demo') && th.items >= 3, th);
    await shot('18-chat-thread');
    const seedWorking = `S.orch = { ...S.orch, running: true, runs: 1, agents: { '${b.id}': { status: 'working', taskId: '${t.id}' } } }; renderHeader(); chatSig = null; renderChat();`;
    await ex(`window._refresh = refresh; refresh = async () => {}; if (!$('#tab-chat.active')) $('#tabs button[data-tab=chat]').click(); ${seedWorking} await w(400);`);
    const typing = await ex(`return { typing: $('#chat-typing').textContent, header: $('#runstate').textContent, dot: !!document.querySelector('#chat-room .avatar.working') }`);
    expect('chat: working indicator (text, running header, green dot)', typing.typing.includes(b.name + ' is working') && typing.header.startsWith('running') && typing.dot, typing);
    await shot('19-chat-working'); await ex(`refresh = window._refresh; await refresh();`);
    const origRun = api.run; api.run = () => ({ stubbed: true });
    await ex(`CH.thread = null; const i = $('#chat-input'); i.value = '@${b.name.slice(0, 2)}'; i.dispatchEvent(new Event('input')); await w(200);`);
    const mention = await ex(`return [...document.querySelectorAll('#chat-mentions div')].map((d) => d.dataset.name)`);
    await ex(`$('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); $('#chat-input').value += 'add a dark theme toggle'; $('#chat-input').dispatchEvent(new Event('input')); await w(200);`);
    const pv = await ex(`return $('#chat-preview').textContent`); await shot('20-chat-mention');
    await ex(`$('#chat-send').click(); await w(1200);`); api.run = origRun;
    const made = ps.listTasks().find((x) => x.title === 'add a dark theme toggle');
    await ex(`await refresh(); chatSig = null; renderChat(); const b = [...document.querySelectorAll('#chat-room .ch-choice')].find((x) => x.dataset.v === 'dark'); b && b.click(); await w(800);`);
    const cm = { mention, preview: pv, task: made && { assignee: made.assignee, createdBy: made.createdBy }, answered: ps.getInboxItem(q.id).answer };
    console.log('[gui-e2e] chat', JSON.stringify({ room, thread: th, typing, ...cm }));
    expect('chat: @mention autocomplete + preview + creates a task for the agent', mention.includes(b.name) && pv.includes('task for ' + b.name) && made && made.assignee === b.id, cm);
    expect('chat: inline answer to ask_human', cm.answered === 'dark', cm);
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
    g.idle = await ex(`renderIdle(); return document.querySelector('.idlebanner[data-where=team]').textContent`);
    expect('graph: idle banner counts only this team (no cross-team ghost)', /12 agents idle/.test(g.idle), g);
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
    const live = await waitFor(`await refresh(); return /3 in parallel/.test($('#runstate').textContent) && [...document.querySelectorAll('.card')].some((c) => /Depends on ParA/.test(c.textContent) && /Blocked by Parallel ParA/.test((c.querySelector('.tag.blocked') || {}).textContent || ''))`, 18000);
    const hdr = await ex(`return $('#runstate').textContent`);
    expect('parallel: header shows "3 in parallel" and dependent shows Blocked by Parallel ParA', live, hdr);
    expect('parallel: 3 agents working at once across 2 teams', ts.every((t) => s.getTask(t.id).status === 'in_progress') && s.getTask(dep.id).status === 'todo', ts.map((t) => s.getTask(t.id).status));
    for (const t of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = t;
      await ex(`$('#tabs button[data-tab=board]').click(); await refresh(); await w(300);`); await shot(`26-parallel-board-${t}`);
      await ex(`$('#tabs button[data-tab=overview]').click(); await w(300);`); await shot(`27-parallel-overview-${t}`);
    }
    require('electron').nativeTheme.themeSource = 'system';
    expect('parallel: still 3 in parallel after shots', /3 in parallel/.test(await ex(`await refresh(); return $('#runstate').textContent`)));
    await done;
    const win = (tid) => { const r = s.listRuns().find((x) => x.taskId === tid && x.kind === 'agent'); return r ? [Date.parse(r.startedAt), Date.parse(r.endedAt)] : [0, 0]; };
    const [A, B, C] = ts.map((t) => win(t.id)); const D = win(dep.id); const ov = (x, y) => x[0] < y[1] && y[0] < x[1];
    expect('parallel: run windows overlap pairwise', ov(A, B) && ov(A, C) && ov(B, C), { A, B, C });
    expect('parallel: dependent starts after blocker ends', D[0] >= A[1], { A, D });
    s.saveSettings({ claudePath: prev.claudePath, maxConcurrency: prev.maxConcurrency });
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
    const us = await ex(`return [...document.querySelectorAll('#us-summary h4')].find((h) => h.textContent === 'By vendor').nextElementSibling.innerText`);
    expect('mixed: usage By vendor splits Codex (cost —) and Claude ($)', /Codex[^\n]*107[^\n]*—/.test(us) && /Claude[^\n]*\$0\.0/.test(us), us);
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
    for (let i = 0; i < 6; i++) s.addRun({ id: 'lim-' + i, projectId: p, nodeId: pm1.id, agent: pm1.name, kind: 'agent', billingSource: 'subscription', startedAt: new Date(Date.now() - i * 1000).toISOString(), inputTokens: 10, outputTokens: 5 });
    s.addRun({ id: 'lim-stale', projectId: p, nodeId: pm1.id, agent: pm1.name, kind: 'agent', billingSource: 'subscription', startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), inputTokens: 10, outputTokens: 5 });
    const prevLim = s.getSettings().usageLimits; s.saveSettings({ usageLimits: { fiveHourLimit: 10, weeklyLimit: 0, tokenLimit: 0, costLimit: 0, warnPct: 80 } });
    await ex(`$('#tabs button[data-tab=usage]').click(); await refresh(); await w(500);`);
    const meterQ = `{ pct: $('#limitmeter .lm-fill')?.style.width, text: $('#limitmeter').textContent, warn: /near limit/.test($('#limitmeter').textContent), pause: /paused/.test($('#limitmeter').textContent) }`;
    const under = await ex(`return ${meterQ}`);
    expect('usage limits: top-bar #limitmeter shows 60% used, 6 stale-excluded, no warn/pause yet', under.pct === '60%' && !under.warn && !under.pause, under);
    expect('usage limits: #limitmeter includes a reset countdown', /↻\d+[hm]/.test(under.text), under.text);
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
      await ex(`$('#tabs button[data-tab=usage]').click(); await refresh(); await w(500); $('#us-summary details').open = true; await w(200);`);
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
      await shot(`usage-permodel-${theme}`);
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
    expect('existing-data: limit meter shows pending state (not hidden) with no limits config and no CLI-reported rate limit yet', meterPendingBefore.hidden === false && /–/.test(meterPendingBefore.pending), meterPendingBefore);
    o.subscriptionRateLimits = { [pm1.id]: { fiveHour: { pct: 0.42, resetsAt: new Date(Date.now() + 3600000).toISOString() } } };
    await ex(`await refresh(); await w(400);`);
    const meterQ = `{ hidden: $('#limitmeter').classList.contains('hidden'), pct: $('#limitmeter .lm-fill')?.style.width, text: $('#limitmeter').textContent }`;
    const meter = await ex(`return ${meterQ}`);
    expect('existing-data: limit meter becomes visible from the CLI-reported rate limit alone', meter.hidden === false && meter.pct === '42%', meter);
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
    const wempty = await ex(`return { list: $('#wikilist').textContent, view: $('#wk-view').textContent }`);
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
    await ex(`$('#tabs button[data-tab=settings]').click(); await refresh(); await w(300); $('#rt-path').value = 'helpycode'; $('#rt-detect').click(); await w(4000);`);
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
  // (orchestrator wakeRun: {trigger:'message', messageId, fromNodeId, excerpt, taskId, startedAt}) and
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
    const team = await ex(`${seed} await w(100); return { badge: !!document.querySelector('#graph .wakerunbadge'), linked: !!document.querySelector('#graph .wakerunbadge.linked') }`);
    expect('wake: Team node shows the linked wake badge', team.badge && team.linked, team);
    await shot('wake-team-on');
    await ex(`$('#tabs button[data-tab=overview]').click(); await w(200);`);
    const ov = await ex(`${seed} await w(100); return { badge: !!document.querySelector('#ov-graph .wakerunbadge'), working: !!document.querySelector('#ov-graph .node.working') }`);
    expect('wake: Overview node shows the wake badge while working', ov.badge && ov.working, ov);
    await shot('wake-overview-on');
    await ex(`$('#tabs button[data-tab=board]').click(); await w(200);`);
    const off = await ex(`S.orch.agents = {}; renderIdle(); renderGraph(); renderOverview(); await w(100); return { wakebarHidden: $('#wakebar').classList.contains('hidden'), chip: !!document.querySelector('#presence .pchip.wake') }`);
    expect('wake: cleared activity hides the banner and chip', off.wakebarHidden && !off.chip, off);
    await shot('wake-board-cleared');
    console.log('[gui-e2e] wake', JSON.stringify({ board, team, ov, off }));
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
  try {
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'helpycode') { await helpycodeShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'wikilogs') { await wikiLogsShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'conflict') { await conflictShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'graph') { await graphShots(); for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=team]').click(); await w(500);`); await shot(`graph-${t}`); } require('electron').nativeTheme.themeSource = 'system'; throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'chat') { await chatShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'windowing') { await windowingShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'firstrun') { await firstrunInbox(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'overview') { await overviewShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'parallel') { await parallelShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'mixed') { await mixedShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'limits') { await limitsShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'discovery') { await discoveryPanelShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'usage') { await usagePerModelShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'existingdata') { await existingDataShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'polish') { await polishShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'mainlogswiki') { await mainLogsWikiShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'critique') { await critiqueShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'wake') { await wakeShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'subagents') { await subagentShots(); throw null; }
    // project/team management through the UI: create a project from the Startup template, then a Solo team, then switch back.
    // Wait until the template select is filled (the first refresh loads the templates) before choosing one.
    await ex(`$('#tabs button[data-tab=team]').click(); await w(300);`); // Chat is the default tab; the flow below clicks the graph
    expect('templates loaded', await waitFor(`return !!document.querySelector('#tpl-select option[value=startup]') && !!document.querySelector('#tpl-select option[value=solo]')`));
    const answer = (sel, text) => ex(`$('#tpl-select').value = '${sel[1]}'; if ($('#tpl-select').value !== '${sel[1]}') return false; $('${sel[0]}').click(); await w(200); $('#ask-input').value = '${text}'; $('#ask-ok').click(); await w(800); return true;`);
    expect('startup template selectable', await answer(['#newproject', 'startup'], 'GUI project'));
    expect('solo template selectable', await answer(['#newteam', 'solo'], 'Solo team'));
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
    const overlap = await ex(`return [...document.querySelectorAll('#graph .node')].filter((g) => { const t = g.querySelector('text').getBoundingClientRect(); const b = g.querySelector('.pfbadge rect').getBoundingClientRect(); return !(t.right <= b.left || b.right <= t.left || t.bottom <= b.top || b.bottom <= t.top); }).length`);
    expect('preflight badges do not overlap names', overlap === 0, { overlap });
    const pfNodes = store.getTeam().nodes.map((n) => ({ name: n.name, ok: n.preflight && n.preflight.ok, error: n.preflight && n.preflight.error, apiKeySource: n.preflight && n.preflight.apiKeySource, ms: n.preflight && n.preflight.latencyMs }));
    expect('preflight badges shown', pfNodes.every((n) => typeof n.ok === 'boolean'), pfNodes);
    console.log('[gui-e2e] preflight', JSON.stringify({ nodes: pfNodes, badges: await ex(`return [...document.querySelectorAll('#graph .pfbadge text')].map((t) => t.textContent)`), summary: await ex(`return $('#pf-summary').textContent`), checks: await ex(`return document.querySelectorAll('#nf-pf .pf-checks li').length`) }));
    await ex(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return true; };`);
    await ex(`$('#goal').value = 'Create a file hello.txt containing exactly: hello world. PM should delegate the implementation to the Dev.';`);
    await click('#run');
    for (let i = 0; i < 180; i++) { await new Promise((r) => setTimeout(r, 2000)); if (!orch.running && orch.runs > 0) break; }
    await new Promise((r) => setTimeout(r, 1500)); await shot('2-observability');
    // Header stays on one row once tokens and costs are filled in.
    const hdr = await ex(`const h = $('header'); const s = $('header strong'); return { h: h.getBoundingClientRect().height, title: s.getBoundingClientRect().height, cost: $('#totalcost').textContent, tok: $('#totaltokens').textContent }`);
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
      await ex(`window.confirm = () => true; window.__alerts = []; window.alert = (m) => window.__alerts.push(m); $('#goal').value = ''; await refresh(); await w(300);`);
      await click('#run');
      for (let i = 0; i < 240; i++) { await new Promise((r) => setTimeout(r, 2000)); if (!gorch.running && gorch.runs > 0) break; }
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
      // Idle detection on the real team: the PM's Dev report is working -> banner names the rest; Dev's node shows the busy arc.
      const ip = (global.__idleP ||= pm.create('Idle demo')); const istore = pm.store(ip.id); const iorch = orchFor(ip.id);
      if (!istore.getTeam().nodes.length) { const [p, d, r] = [['PM', 'PM'], ['Dev', 'Dev'], ['Reviewer', 'Reviewer']].map(([name, role], i) => istore.addNode({ name, role, x: 80 + i * 220, y: 120 })); istore.addEdge(p.id, d.id); istore.addEdge(p.id, r.id); }
      const team = istore.getTeam(); const pmN = team.nodes.find((n) => n.role === 'PM'); const reps = team.edges.filter((e) => e.from === pmN.id).map((e) => e.to);
      const dev = team.nodes.find((n) => n.role === 'Dev'); const prevCtx = await ex(`const c = ctx; await switchTo({ p: '${ip.id}' }); await w(500); return c;`);
      const idleNames = team.nodes.filter((n) => n.id !== dev.id).map((n) => n.name);
      const idle = await ex(`$('#tabs button[data-tab=team]').click(); await w(300); const keep = [S.orch.agents, S.orch.idle];
        S.orch.agents = { '${dev.id}': { status: 'working' } }; S.orch.idle = S.allNodes.filter((n) => n.id !== '${dev.id}').map((n) => n.id);
        renderGraph(); renderIdle(); await w(300); const b = document.querySelector('.idlebanner[data-where=team]'); window.__idleKeep = keep;
        return { txt: b.classList.contains('hidden') ? '' : b.textContent, busy: document.querySelectorAll('#graph .pres.busy').length, idleRings: document.querySelectorAll('#graph .pres.idle').length };`);
      await shot(`idle-banner-${theme}`);
      expect(`idle banner names real idle agents, not busy Dev (${theme})`, idle.txt.includes(`${idleNames.length} agent`) && idleNames.every((nm) => idle.txt.includes(nm)) && !idle.txt.includes(dev.name) && idle.busy === 1 && idle.idleRings === idleNames.length, { idle, idleNames, dev: dev.name });
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
    if (!process.env.SKIP_CRITIQUE) await critiqueShots();
    if (!process.env.SKIP_LIMITS) await limitsShots();
    if (!process.env.SKIP_DISCOVERY) await discoveryPanelShots();
    if (!process.env.SKIP_USAGEPM) await usagePerModelShots();
    nativeTheme.themeSource = 'system';
    const tasks = store.listTasks();
    console.log('[gui-e2e]', JSON.stringify({ edges: store.getTeam().edges.length, tasks: tasks.map((t) => [t.title, t.status, t.iterations || 0, !!t.sessionId]), cost: orch.snapshot().totalCost }));
  } catch (e) { if (e !== null) { console.error('[gui-e2e] failed', e); failures.push('exception: ' + e.message); } }
  console.log(failures.length ? `[gui-e2e] FAIL (${failures.length}): ${failures.join('; ')}` : '[gui-e2e] PASS');
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
  introspectRuntime: (_c, bin) => { const r = runIntrospectRuntime(bin); return toDraftProfile(bin, r.profile, r); },
  listProjects: () => ({ projects: pm.list().map((p) => ({ ...p, running: !!(orchs.get(p.id) || {}).running })), templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.label])) }),
  createProject: (_c, name, tpl) => pm.create(name, tpl), renameProject: (_c, pid, name) => pm.rename(pid, name),
  deleteProject: (_c, pid) => { if ((orchs.get(pid) || {}).running) throw new Error('stop the project first'); orchs.delete(pid); return pm.remove(pid); },
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
  addEdge: (c, a, b, type) => TS(c).addEdge(a, b, type), updateEdge: (c, id, p) => TS(c).updateEdge(id, p),
  savePreset: (c, p) => ST(c).savePreset(p), deletePreset: (c, name) => ST(c).deletePreset(name), removeEdge: (c, id) => TS(c).removeEdge(id),
  createTask: (c, t) => ST(c).createTask(t), updateTask: (c, id, p) => ST(c).updateTask(id, p), deleteTask: (c, id) => ST(c).deleteTask(id),
  commentTask: (c, id, text) => ST(c).commentTask(id, 'human', text),
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
    const status = U.usageStatus(s.listRuns(), settings.usageLimits);
    const warnPct = (settings.usageLimits && settings.usageLimits.warnPct) || 80;
    const inMemory = orchFor(c.p).subscriptionRateLimits || {};
    // The in-memory map is only populated after a run/probe this session, so it's empty right after a restart —
    // fall back to each node's persisted rateLimits snapshot (discoverCapabilities/orchestrator writes
    // node.rateLimits alongside the in-memory map) so a restart doesn't lose the last known real CLI %.
    const nodes = TS(c).getTeam().nodes;
    const rlAll = nodes.map((n) => U.liveRateLimits(inMemory[n.id] || n.rateLimits)).filter(Boolean);
    return U.applyCliRateLimits(status, rlAll, warnPct);
  },
  // Real per-provider subscription usage (5h/weekly used % + reset time) for one agent, as self-reported by its
  // own CLI's init event — with an explicit reason when there is nothing to report yet.
  providerUsage: (c, nodeId) => {
    const s = ST(c); const node = TS(c).getTeam().nodes.find((n) => n.id === nodeId); if (!node) throw new Error('no agent ' + nodeId);
    const rl = U.liveRateLimits((orchFor(c.p).subscriptionRateLimits || {})[nodeId] || node.rateLimits) || null;
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
        const rl = rateLimit ? U.parseRateLimits(rateLimit) : null;
        if (rl) { patch.rateLimits = rl; patch.rateLimitsAt = new Date().toISOString(); (orchFor(c.p).subscriptionRateLimits ||= {})[nodeId] = rl; }
      } catch {}
    }
    const kept = capabilities !== node.capabilities && CAP.mergeCapabilities(node.capabilities, capabilities) === node.capabilities;
    if (kept) { capabilities = node.capabilities; patch.capabilities = node.capabilities; patch.capabilitiesProbedAt = node.capabilitiesProbedAt; }
    TS(c).updateNode(nodeId, patch);
    return capabilities;
  },
  testAgent, testTeam,
  stopAgent: (c, nodeId) => orchFor(c.p).stopAgent(nodeId), sendToAgent: (c, nodeId, text, taskId) => orchFor(c.p).sendToAgent(nodeId, text, taskId),
  listInbox: (c) => ST(c).listInbox({ status: 'open' }), answerInbox: (c, id, answer) => ST(c).answerInbox(id, answer),
  inboxCounts: () => Object.fromEntries(pm.list().map((p) => [p.id, pm.store(p.id).listInbox({ status: 'open' }).length])),
  approveTask: (c, id, ok, note) => ST(c).approveTask(id, ok, note), getLogs: (c, n) => ST(c).readLogs(n || 2000), clearLogs: (c) => ST(c).clearLogs(),
  taskDiff: (c, id) => WT.worktreeDiff(wtTask(c, id)),
  taskMerge: (c, id) => { const r = WT.worktreeMerge(wtTask(c, id)); ST(c).commentTask(id, 'human', `merged ${r.branch} into ${r.base}`); return r; },
  taskDiscard: (c, id) => { const r = WT.worktreeDiscard(wtTask(c, id)); ST(c).updateTask(id, { worktreePath: null, worktreeBranch: null }); return r; },
  unmergedBranches: (c) => ST(c).listUnmergedBranches(),
  pickDir: async () => { const { dialog } = require('electron'); const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
  agentStates: (c) => orchFor(c.p).agentStates(),
  // Live per-node data for the graph: runtime, model, status (working|idle|needs-human).
  nodeStatus: (c) => { const s = ST(c); const st = orchFor(c.p).agentStates(); const ag = orchFor(c.p).agents || {}; const inbox = s.listInbox({ status: 'open' });
    return Object.fromEntries(s.getTeam().nodes.map((n) => [n.id, { runtime: n.runtime, model: n.model || null, teamId: n.teamId,
      status: inbox.some((i) => i.nodeId === n.id) ? 'needs-human' : (ag[n.id] || {}).status === 'working' || st[n.id] === 'busy' ? 'working' : 'idle' }])); },
  crossEdges: (c) => TS(c).incomingCrossEdges(), setViewport: (c, v) => TS(c).setViewport(v), getViewport: (c) => TS(c).getViewport(), setPositions: (c, pos) => TS(c).setPositions(pos),
  run: (c) => orchFor(c.p).start(), stop: (c) => orchFor(c.p).stop(),
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
  createWindow();
  probeUnprobedAgents();
  pollInbox(true); setInterval(() => pollInbox(false), 1500);
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
