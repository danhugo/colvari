const { app, BrowserWindow, ipcMain, Notification, nativeTheme } = require('electron');
const path = require('path');
const { Orchestrator } = require('./orchestrator');
const { ProjectManager, TEMPLATES } = require('./projects');
const AC = require('./agent-config');
const WT = require('./worktree');
const U = require('./usage');
const PF = require('./preflight');
const RT = require('./runtimes');
let runtimesCache = null; // detected once per app start (binary + version)
const runtimes = (settings) => (runtimesCache ||= RT.detectRuntimes(settings, { ...process.env, PATH: [process.env.PATH, require('os').homedir() + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(':') }));

const pm = new ProjectManager();
const orchs = new Map(); // projectId -> Orchestrator (projects run independently / concurrently)
function orchFor(pid) {
  let o = orchs.get(pid);
  if (!o) {
    o = new Orchestrator(pm.store(pid));
    o.on('log', (l) => send('log', { ...l, projectId: pid }));
    o.on('state', (s) => send('state', { ...s, projectId: pid }));
    o.on('notify', (n) => { send('notify', { ...n, projectId: pid }); notify(n, pid); });
    orchs.set(pid, o);
  }
  return o;
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
      await refresh(); CH.key = ''; renderChat(); await w(300); document.querySelector('#chat-room .cchip').open = true; await w(200);`);
    const room = await ex(`return { groups: document.querySelectorAll('#chat-room .cgroup').length, avatars: document.querySelectorAll('#chat-room .avatar').length, chips: document.querySelectorAll('#chat-room .cchip').length, question: !!document.querySelector('#chat-room .bubble.question .ch-choice'), roles: document.querySelectorAll('#chat-room .role').length, defaultTab: !!$('#tabs button[data-tab=chat]') && TABS[0] === 'chat' }`);
    expect('chat: room with bubbles, avatars, role badges, tool chips, inline question', room.groups >= 2 && room.chips >= 2 && room.question && room.roles >= 2 && room.defaultTab, room);
    await ex(`await refresh(); CH.key = ''; renderChat(); document.querySelector('#chat-room .cchip').open = true; await w(200);`); await shot('17-chat-room');
    await ex(`document.querySelector('#chat-room [data-thread="${t.id}"]').click(); await w(300);`);
    const th = await ex(`return { open: !$('#chat-thread').classList.contains('hidden'), title: $('#chat-thread .chat-head').textContent, items: document.querySelectorAll('#chat-threadroom .bubble, #chat-threadroom .cchip').length }`);
    expect('chat: thread pane shows the task', th.open && th.title.includes('Chat demo') && th.items >= 3, th);
    await shot('18-chat-thread');
    const seedWorking = `S.orch = { ...S.orch, running: true, runs: 1, agents: { '${b.id}': { status: 'working', taskId: '${t.id}' } } }; renderHeader(); CH.key = ''; renderChat();`;
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
    await ex(`await refresh(); CH.key = ''; renderChat(); const b = [...document.querySelectorAll('#chat-room .ch-choice')].find((x) => x.dataset.v === 'dark'); b && b.click(); await w(800);`);
    const cm = { mention, preview: pv, task: made && { assignee: made.assignee, createdBy: made.createdBy }, answered: ps.getInboxItem(q.id).answer };
    console.log('[gui-e2e] chat', JSON.stringify({ room, thread: th, typing, ...cm }));
    expect('chat: @mention autocomplete + preview + creates a task for the agent', mention.includes(b.name) && pv.includes('task for ' + b.name) && made && made.assignee === b.id, cm);
    expect('chat: inline answer to ask_human', cm.answered === 'dark', cm);
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
    for (const t of ['light', 'dark']) {
      require('electron').nativeTheme.themeSource = t;
      await ex(`$('#tabs button[data-tab=wiki]').click(); await w(300);`); await shot(`wiki-${t}`);
      await ex(`$('#tabs button[data-tab=obs]').click(); await w(300);`); await shot(`logs-${t}`);
    }
    require('electron').nativeTheme.themeSource = 'system';
    console.log('[gui-e2e] wikilogs', JSON.stringify({ wempty, lempty, wlist, wview, rows, filtered, searched }));
  };
  try {
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'wikilogs') { await wikiLogsShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'graph') { await graphShots(); for (const t of ['light', 'dark']) { require('electron').nativeTheme.themeSource = t; await ex(`$('#tabs button[data-tab=team]').click(); await w(500);`); await shot(`graph-${t}`); } require('electron').nativeTheme.themeSource = 'system'; throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'chat') { await chatShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'firstrun') { await firstrunInbox(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'overview') { await overviewShots(); throw null; }
    if (process.env.AGENTS_SQUAD_GUI_E2E_ONLY === 'parallel') { await parallelShots(); throw null; }
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
    if (!process.env.SKIP_GRAPH) await graphShots();
    // Main screens in light + dark (the renderer themes via prefers-color-scheme, driven by nativeTheme).
    const { nativeTheme } = require('electron');
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme; await ex(`await w(300);`);
      for (const tab of ['chat', 'team', 'board', 'inbox', 'overview']) { await ex(`$('#tabs button[data-tab=${tab}]').click(); await w(500);`); await shot(`main-${tab}-${theme}`); }
      await ex(`$('#tabs button[data-tab=team]').click(); $('#reopenguide').click(); await w(400);`); await shot(`main-firstrun-${theme}`);
      expect(`firstrun guide opens (${theme})`, await ex(`return !$('#guide').classList.contains('hidden')`));
      await ex(`$('#guide').classList.add('hidden'); await w(200);`);
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
const withPF = (nodes, settings) => nodes.map((n) => ({ ...n, preflightStatus: PF.preflightStatus(n, settings) }));
// Test one agent with its exact config and save the result on the node (in whichever team owns it).
async function testAgent(c, nodeId) {
  const s = ST(c); const settings = s.getSettings();
  const team = pm.get(c.p).teams.find((t) => pm.store(c.p, t.id).getTeam().nodes.some((n) => n.id === nodeId));
  if (!team) throw new Error('no agent ' + nodeId);
  const ts = pm.store(c.p, team.id); const node = ts.getTeam().nodes.find((n) => n.id === nodeId);
  const r = await orchFor(c.p).preflight(node, settings);
  ts.updateNode(nodeId, { preflight: r });
  send('state', { ...orchFor(c.p).snapshot(), projectId: c.p });
  return r;
}
async function testTeam(c) {
  const nodes = TS(c).getTeam().nodes; const limit = Math.max(1, ST(c).getSettings().maxConcurrency || 2);
  const out = {}; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, nodes.length) }, async () => { while (i < nodes.length) { const n = nodes[i++]; try { out[n.id] = await testAgent(c, n.id); } catch (e) { out[n.id] = { ok: false, error: e.message }; } } }));
  return out;
}
const wtTask = (c, id) => { const t = ST(c).listTasks().find((x) => x.id === id); if (!t || !t.worktreePath) throw new Error('task has no worktree'); return t; };
const api = {
  listProjects: () => ({ projects: pm.list().map((p) => ({ ...p, running: !!(orchs.get(p.id) || {}).running })), templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.label])) }),
  createProject: (_c, name, tpl) => pm.create(name, tpl), renameProject: (_c, pid, name) => pm.rename(pid, name),
  deleteProject: (_c, pid) => { if ((orchs.get(pid) || {}).running) throw new Error('stop the project first'); orchs.delete(pid); return pm.remove(pid); },
  createTeam: (c, name, tpl) => pm.createTeam(c.p, name, tpl), renameTeam: (c, tid, name) => pm.renameTeam(c.p, tid, name),
  deleteTeam: (c, tid) => pm.removeTeam(c.p, tid), duplicateTeam: (c, tid) => pm.duplicateTeam(c.p, tid),
  exportTeam: (c, tid) => pm.exportTeam(c.p, tid), importTeam: (c, json) => pm.importTeam(c.p, json),
  getAll: (c) => { const s = ST(c); const t = TS(c); return { project: s.meta(), teamId: t.teamId, dir: s.dir, team: { ...t.getTeam(), nodes: withPF(t.getTeam().nodes, s.getSettings()) }, allNodes: withPF(s.getTeam().nodes, s.getSettings()), tasks: s.listTasks(), wiki: s.listWiki(), settings: s.getSettings(), messages: s.listMessages().slice(-200), orch: orchFor(c.p).snapshot(),
    config: { runtimes: runtimes(s.getSettings()), billingModes: U.BILLING_MODES, permissionModes: AC.PERMISSION_MODES, edgeTypes: AC.EDGE_TYPES, boardTools: AC.BOARD_TOOLS, roles: AC.roleSuggestions(s.getSettings().rolePresets, s.getTeam().nodes) } }; },
  addNode: (c, n) => TS(c).addNode(n), updateNode: (c, id, p) => TS(c).updateNode(id, p), removeNode: (c, id) => TS(c).removeNode(id),
  addEdge: (c, a, b, type) => TS(c).addEdge(a, b, type), updateEdge: (c, id, p) => TS(c).updateEdge(id, p),
  savePreset: (c, p) => ST(c).savePreset(p), deletePreset: (c, name) => ST(c).deletePreset(name), removeEdge: (c, id) => TS(c).removeEdge(id),
  createTask: (c, t) => ST(c).createTask(t), updateTask: (c, id, p) => ST(c).updateTask(id, p), deleteTask: (c, id) => ST(c).deleteTask(id),
  commentTask: (c, id, text) => ST(c).commentTask(id, 'human', text),
  writeWiki: (c, t, x) => ST(c).writeWiki(t, x, 'human'), deleteWiki: (c, t) => ST(c).deleteWiki(t),
  saveSettings: (c, s) => ST(c).saveSettings(s),
  listRuns: (c, f) => ST(c).listRuns(f || {}), clearRuns: (c) => ST(c).clearRuns(), usageCSV: (c, all) => U.toCSV(all ? pm.list().flatMap((p) => pm.store(p.id).listRuns()) : ST(c).listRuns()),
  usageByProject: () => pm.list().map((p) => ({ id: p.id, name: p.name, ...U.total(pm.store(p.id).listRuns()) })),
  testAgent, testTeam,
  stopAgent: (c, nodeId) => orchFor(c.p).stopAgent(nodeId), sendToAgent: (c, nodeId, text, taskId) => orchFor(c.p).sendToAgent(nodeId, text, taskId),
  listInbox: (c) => ST(c).listInbox({ status: 'open' }), answerInbox: (c, id, answer) => ST(c).answerInbox(id, answer),
  inboxCounts: () => Object.fromEntries(pm.list().map((p) => [p.id, pm.store(p.id).listInbox({ status: 'open' }).length])),
  approveTask: (c, id, ok, note) => ST(c).approveTask(id, ok, note), getLogs: (c, n) => ST(c).readLogs(n || 2000), clearLogs: (c) => ST(c).clearLogs(),
  taskDiff: (c, id) => WT.worktreeDiff(wtTask(c, id)),
  taskMerge: (c, id) => { const r = WT.worktreeMerge(wtTask(c, id)); ST(c).commentTask(id, 'human', `merged ${r.branch} into ${r.base}`); return r; },
  taskDiscard: (c, id) => { const r = WT.worktreeDiscard(wtTask(c, id)); ST(c).updateTask(id, { worktreePath: null, worktreeBranch: null }); return r; },
  pickDir: async () => { const { dialog } = require('electron'); const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
  agentStates: (c) => orchFor(c.p).agentStates(),
  // Live per-node data for the graph: runtime, model, status (working|idle|needs-human).
  nodeStatus: (c) => { const s = ST(c); const st = orchFor(c.p).agentStates(); const ag = orchFor(c.p).agents || {}; const inbox = s.listInbox({ status: 'open' });
    return Object.fromEntries(s.getTeam().nodes.map((n) => [n.id, { runtime: n.runtime, model: n.model || null, teamId: n.teamId,
      status: inbox.some((i) => i.nodeId === n.id) ? 'needs-human' : (ag[n.id] || {}).status === 'working' || st[n.id] === 'busy' ? 'working' : 'idle' }])); },
  crossEdges: (c) => TS(c).incomingCrossEdges(), setViewport: (c, v) => TS(c).setViewport(v), getViewport: (c) => TS(c).getViewport(), setPositions: (c, pos) => TS(c).setPositions(pos),
  run: (c) => orchFor(c.p).start(), stop: (c) => orchFor(c.p).stop(),
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
  pollInbox(true); setInterval(() => pollInbox(false), 1500);
  console.log('[agents-squad] ready, data root:', pm.root);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { for (const o of orchs.values()) if (o.running) o.stop(); if (process.platform !== 'darwin') app.quit(); });
