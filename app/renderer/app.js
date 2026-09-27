/* global squad */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODELS = ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const RUN_MODES = [['single', 'Single: one run per task'], ['goal', 'Goal: resume until condition met'], ['loop', 'Loop: repeat N times'], ['workflow', 'Workflow: slash command / skill']];
const STATUSES = ['todo', 'in_progress', 'waiting_for_human', 'review', 'done'];
const call = (name, ...args) => squad.call(name, ctx, ...args); // every call is scoped to the selected project/team
let ctx = (() => { try { return JSON.parse(localStorage.getItem('ctx')) || {}; } catch { return {}; } })();
let P = { projects: [], templates: {} };
let S = { allNodes: [], team: { nodes: [], edges: [] }, tasks: [], wiki: {}, settings: { rolePresets: [] }, messages: [], orch: { agents: {} }, config: { permissionModes: [], edgeTypes: ['assign'], boardTools: [], roles: [] } };
const EDGE_DESC = { assign: 'can assign tasks to and message', message: 'can send messages to', review: 'is reviewed by' };
const list = (v) => (Array.isArray(v) ? v : []).join('\n');
let sel = { node: null, edge: null, task: null, page: null };
let connectFrom = null, connectMode = false, wikiEdit = false;
const logs = [];
const logsLoaded = new Set(); // projects whose persisted logs.jsonl was merged into logs
async function loadLogs(pid) {
  if (logsLoaded.has(pid)) return; logsLoaded.add(pid);
  let saved = []; try { saved = await call('getLogs', 1500); } catch {}
  const first = Math.min(...logs.filter((l) => l.projectId === pid).map((l) => l.at), Infinity);
  logs.unshift(...saved.filter((l) => l.at < first).map((l) => ({ ...l, projectId: pid, saved: true })));
  renderLog();
}
const testing = new Set(); // node ids with a preflight test in flight
const PF_LABEL = { pass: 'PASS', fail: 'FAIL', stale: 'RETEST', untested: 'untested', testing: 'testing…' };
const pfState = (n) => (testing.has(n.id) ? 'testing' : n.preflightStatus || 'untested');
async function testAgents(ids) {
  ids.forEach((id) => testing.add(id)); renderGraph(); renderNodeForm(); renderPreflightBar();
  try { await Promise.all(ids.map(async (id) => { try { await call('testAgent', id); } catch (e) { console.warn('preflight', e); } finally { testing.delete(id); } })); }
  finally { await refresh(); }
}
function renderPreflightBar() {
  const b = $('#pf-summary'); if (!b) return; const ns = S.team.nodes; const c = { pass: 0, fail: 0, stale: 0, untested: 0, testing: 0 };
  for (const n of ns) c[pfState(n)]++;
  b.textContent = ns.length ? `Preflight: ${c.pass}/${ns.length} pass` + (c.fail ? ` · ${c.fail} fail` : '') + (c.stale + c.untested ? ` · ${c.stale + c.untested} untested` : '') + (c.testing ? ` · ${c.testing} testing` : '') : '';
  b.className = 'pill pf-' + (c.fail ? 'fail' : c.testing ? 'testing' : c.pass === ns.length && ns.length ? 'pass' : 'untested');
  $('#testteam').disabled = !ns.length || c.testing > 0;
}
// Check rows; an error text already shown (in the summary or an earlier check) is not repeated.
function pfCheckRows(p) {
  const seen = new Set(p.error ? [p.error] : []); const shown = (d) => [...seen].some((x) => x.includes(d));
  return (p.checks || []).map((c) => {
    const d = String(c.detail || ''); const dup = !c.ok && d.length > 30 && shown(d); if (!c.ok && d) seen.add(d);
    return `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} ${esc(c.label)} <span class="muted">${dup ? '(same error as above)' : esc(d)}</span></li>`;
  }).join('');
}
function pfDetail(n) {
  const p = n.preflight; const st = pfState(n);
  if (st === 'testing') return '<p class="muted">Testing with this agent\'s exact config…</p>';
  if (!p) return '<p class="muted">Not tested yet. Runs claude with this agent\'s config (max 3 turns) and checks binary, model, auth, board MCP and a list_team call.</p>';
  const t = p.tokens || {};
  return `${st === 'stale' ? '<p class="warn">Config changed since this test: test again.</p>' : ''}${p.error ? `<p class="pf-err">${esc(p.error)}</p>` : ''}
    <ul class="pf-checks">${pfCheckRows(p)}</ul>
    <p class="muted">${p.version ? 'claude ' + esc(p.version) + ' · ' : ''}${p.model ? esc(p.model) + ' · ' : ''}apiKeySource=${esc(p.apiKeySource ?? '?')} · ${p.latencyMs || 0} ms · ${fmtTok(t.inputTokens)} in / ${fmtTok(t.outputTokens)} out${t.cacheReadTokens || t.cacheCreationTokens ? ' / ' + fmtTok((t.cacheReadTokens || 0) + (t.cacheCreationTokens || 0)) + ' cache' : ''} · $${(p.costUsd || 0).toFixed(4)} · ${esc(new Date(p.at).toLocaleString())}</p>`;
}

async function refresh() {
  P = await call('listProjects');
  if (!P.projects.some((p) => p.id === ctx.p)) ctx = { p: P.projects[0].id };
  S = await call('getAll'); S.inbox = await call('listInbox'); ctx.t = S.teamId; await loadRuns(); await loadLogs(ctx.p);
  try { localStorage.setItem('ctx', JSON.stringify(ctx)); } catch {}
  renderAll();
}
const nodeName = (id) => (S.allNodes.find((n) => n.id === id) || {}).name || (id ? id : 'unassigned');
function renderAll() { renderSidebar(); renderGraph(); renderPreflightBar(); renderNodeForm(); renderBoard(); renderWiki(); renderObs(); renderSettings(); renderHeader(); renderUsage(); renderOverview(); renderInbox(); renderGuide(); renderChat(); }
const fmtTok = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n); };
const COST_NOTE = { subscription: 'Covered by subscription — not billed per token', other: 'API-equivalent (reported by Claude CLI)' };
const costCell = (usd, source) => source === 'subscription' ? `<span class="costnote" title="API-equivalent $${(usd || 0).toFixed(4)} (reported by Claude CLI)">${COST_NOTE.subscription}</span>` : `$${(usd || 0).toFixed(4)} <span class="costnote">API-equivalent</span>`;
const billTag = (src, detail) => `<span class="bill bill-${esc(src || 'unknown')}" title="${esc(detail || '')}">${esc(src || 'unknown')}</span>`;

// ---------- projects & teams sidebar ----------
function renderSidebar() {
  $('#projectlist').innerHTML = P.projects.map((p) => `<div data-pid="${p.id}" class="${p.id === ctx.p ? 'sel' : ''}">${esc(p.name)}${p.running ? '<span class="dot" title="running"></span>' : ''}</div>`).join('');
  document.querySelectorAll('#projectlist div').forEach((d) => d.onclick = () => switchTo({ p: d.dataset.pid }));
  const teams = (S.project && S.project.teams) || [];
  $('#teamlist').innerHTML = teams.map((t) => `<div data-tid="${t.id}" class="${t.id === ctx.t ? 'sel' : ''}">${esc(t.name)}</div>`).join('');
  document.querySelectorAll('#teamlist div').forEach((d) => d.onclick = () => switchTo({ p: ctx.p, t: d.dataset.tid }));
  const ts = $('#tpl-select'); const cur = ts.value;
  ts.innerHTML = Object.entries(P.templates).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''); if (cur) ts.value = cur;
}
function switchTo(c) {
  if (c.p !== ctx.p) { sel = { node: null, edge: null, task: null, page: null }; wikiEdit = false; $('#wk-title').value = ''; $('#wk-content').value = ''; }
  else sel = { ...sel, node: null, edge: null };
  connectFrom = null; connectMode = false; $('#connect').classList.remove('on');
  ctx = c; refresh().then(renderLog);
}
// Electron has no window.prompt, so use a small <dialog>.
function ask(title, value = '') {
  return new Promise((resolve) => {
    const d = $('#askdlg'); $('#ask-title').textContent = title; $('#ask-input').value = value;
    d.onclose = () => resolve(d.returnValue === 'ok' ? $('#ask-input').value.trim() : null);
    d.returnValue = ''; d.showModal(); $('#ask-input').select();
  });
}
const act = (fn) => async () => { try { await fn(); } catch (e) { alert(String(e.message || e).replace(/^Error invoking remote method 'api': (Error: )?/, '')); } };
const curTeam = () => (S.project.teams.find((t) => t.id === ctx.t) || {});
$('#newproject').onclick = act(async () => { const n = await ask('Project name', 'New project'); if (!n) return; const p = await call('createProject', n, $('#tpl-select').value); switchTo({ p: p.id }); });
$('#renproject').onclick = act(async () => { const n = await ask('Rename project', S.project.name); if (n) { await call('renameProject', ctx.p, n); refresh(); } });
$('#delproject').onclick = act(async () => { if (!confirm(`Delete project "${S.project.name}" with its board, wiki and teams?`)) return; await call('deleteProject', ctx.p); switchTo({}); });
$('#newteam').onclick = act(async () => { const n = await ask('Team name', 'New team'); if (!n) return; const t = await call('createTeam', n, $('#tpl-select').value); switchTo({ p: ctx.p, t: t.id }); });
$('#renteam').onclick = act(async () => { const n = await ask('Rename team', curTeam().name); if (n) { await call('renameTeam', ctx.t, n); refresh(); } });
$('#dupteam').onclick = act(async () => { const t = await call('duplicateTeam', ctx.t); switchTo({ p: ctx.p, t: t.id }); });
$('#delteam').onclick = act(async () => { if (!confirm(`Delete team "${curTeam().name}"?`)) return; await call('deleteTeam', ctx.t); switchTo({ p: ctx.p }); });
$('#exportteam').onclick = act(async () => {
  const data = await call('exportTeam', ctx.t);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = (data.name || 'team').replace(/[^\w-]+/g, '_') + '.team.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#importteam').onclick = () => $('#importfile').click();
$('#importfile').onchange = act(async (e) => {
  const f = $('#importfile').files[0]; if (!f) return; const text = await f.text(); $('#importfile').value = '';
  const t = await call('importTeam', text); switchTo({ p: ctx.p, t: t.id });
});

// ---------- tabs ----------
document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
});

// ---------- header ----------
function renderHeader() {
  const o = S.orch; $('#runstate').textContent = o.running ? `running (${o.runs} runs)` : 'idle';
  $('#runstate').classList.toggle('on', !!o.running);
  // Money pill: only runs billed per token (API key / proxy / cloud) show a $ figure; subscription-only sessions show a quiet "subscription" pill.
  const c = $('#totalcost'); const billed = o.billedCost || 0; const sub = o.subCost || 0;
  c.textContent = billed > 0 ? `API-eq $${billed.toFixed(2)}` : sub > 0 ? 'subscription' : 'no cost yet';
  c.classList.toggle('quiet', !(billed > 0));
  c.title = (billed > 0 ? `API-equivalent $${billed.toFixed(4)} for API key / proxy / cloud runs (reported by Claude CLI).` : 'No per-token billed runs this session.') + (sub > 0 ? ` Subscription runs: covered by subscription — not billed per token (API-equivalent $${sub.toFixed(4)}).` : '');
  const t = o.tokens || {}; const tt = $('#totaltokens');
  tt.textContent = `${fmtTok((t.inputTokens || 0) + (t.outputTokens || 0))} tok · ${fmtTok((t.cacheReadTokens || 0) + (t.cacheCreationTokens || 0))} cache`;
  tt.title = `Measured tokens this session: ${t.inputTokens || 0} in / ${t.outputTokens || 0} out / ${t.cacheReadTokens || 0} cache read / ${t.cacheCreationTokens || 0} cache write`;
}
function showTab(name) { document.querySelector(`#tabs button[data-tab="${name}"]`).click(); }
$('#run').onclick = async () => {
  const goal = $('#goal').value.trim();
  if (!S.team.nodes.length) { alert('Add at least one agent in the Team tab first.'); return showTab('team'); }
  if (goal) {
    const hasIn = new Set(S.team.edges.map((e) => e.to));
    const lead = S.team.nodes.find((n) => n.id === sel.node) || S.team.nodes.find((n) => !hasIn.has(n.id)) || S.team.nodes[0];
    await call('createTask', { title: goal.slice(0, 80), description: goal, assignee: lead.id }); $('#goal').value = '';
  } else if (!S.tasks.some((t) => t.status === 'todo')) { alert('Type a goal next to Run (or create a todo task in Board) first.'); return $('#goal').focus(); }
  const bad = S.allNodes.filter((n) => ['fail', 'untested', 'stale'].includes(pfState(n)));
  if (bad.length && !confirm(`Preflight not passed for ${bad.length} agent(s):\n${bad.map((n) => `- ${n.name}: ${n.preflightStatus === 'fail' ? 'FAILED' + (n.preflight && n.preflight.error ? ' (' + n.preflight.error.slice(0, 120) + ')' : '') : n.preflightStatus === 'stale' ? 'config changed since test' : 'untested'}`).join('\n')}\n\nRun anyway? (Use "Test team" in the Team tab to check them.)`)) return showTab('team');
  if (!$('#tab-chat.active')) showTab('obs'); await call('run'); refresh();
};
$('#stop').onclick = async () => { await call('stop'); refresh(); };

// ---------- team graph ----------
const W = 150, H = 54, SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
function renderGraph() {
  const svg = $('#graph'); svg.innerHTML = '';
  const defs = el('defs', {}, svg); const m = el('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto' }, defs);
  el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'currentColor', style: 'color:gray' }, m);
  const byId = Object.fromEntries(S.team.nodes.map((n) => [n.id, n]));
  for (const e of S.team.edges) {
    const a = byId[e.from], b = byId[e.to]; if (!a || !b) continue;
    const [x1, y1, x2, y2] = clip(a, b);
    const type = e.type || 'assign';
    const p = el('line', { x1, y1, x2, y2, class: `edge edge-${type}` + (sel.edge === e.id ? ' sel' : ''), 'marker-end': 'url(#arr)', 'data-id': e.id }, svg);
    if (type !== 'assign') el('text', { x: (x1 + x2) / 2 + 4, y: (y1 + y2) / 2 - 4, class: 'edgelabel', 'font-size': 10 }, svg).textContent = type;
    p.onclick = (ev) => { ev.stopPropagation(); sel = { ...sel, edge: e.id, node: null }; renderGraph(); renderNodeForm(); };
  }
  for (const n of S.team.nodes) {
    const st = (S.orch.agents[n.id] || {}).status;
    const g = el('g', { class: 'node' + (sel.node === n.id || connectFrom === n.id ? ' sel' : '') + (st === 'working' ? ' working' : ''), transform: `translate(${n.x},${n.y})`, style: 'cursor:move' }, svg);
    el('rect', { width: W, height: H, rx: 8 }, g);
    const nameEl = el('text', { x: 10, y: 24, 'font-weight': 600 }, g); nameEl.textContent = clipText(n.name, 20); el('title', {}, g).textContent = `${n.name} (${n.role})`;
    el('text', { x: 10, y: 42, 'font-size': 11, opacity: 0.7 }, g).textContent = clipText(`${n.role}${st === 'working' ? ' · working' : ''}`, 24);
    const pg = el('g', { class: 'pres ' + presence(n.id), transform: `translate(${W - 14},${H - 14})` }, g); el('circle', { r: 5 }, pg); el('title', {}, pg).textContent = presence(n.id);
    // Preflight badge sits on the node's top border (a tag), so it never covers the name.
    const pf = pfState(n); const bw = 8 + PF_LABEL[pf].length * 6;
    const badge = el('g', { class: 'pfbadge pf-' + pf, transform: `translate(${W - bw - 8},-8)` }, g);
    el('title', {}, badge).textContent = pf === 'fail' && n.preflight ? 'Preflight failed: ' + n.preflight.error : 'Preflight: ' + PF_LABEL[pf];
    el('rect', { width: bw, height: 15, rx: 7 }, badge); el('text', { x: bw / 2, y: 11, 'font-size': 9, 'text-anchor': 'middle' }, badge).textContent = PF_LABEL[pf];
    g.onmousedown = (ev) => startDrag(ev, n, g);
  }
  svg.onclick = () => { sel = { ...sel, node: null, edge: null }; renderGraph(); renderNodeForm(); };
}
const clipText = (s, max) => (String(s).length > max ? String(s).slice(0, max - 1) + '…' : String(s));
function clip(a, b) { // line from centre of a to border of b
  const ax = a.x + W / 2, ay = a.y + H / 2, bx = b.x + W / 2, by = b.y + H / 2, dx = bx - ax, dy = by - ay;
  const t = Math.min(Math.abs((W / 2) / (dx || 1e-9)), Math.abs((H / 2) / (dy || 1e-9)));
  return [ax + dx * t, ay + dy * t, bx - dx * t, by - dy * t];
}
function startDrag(ev, n, g) {
  ev.stopPropagation(); const sx = ev.clientX, sy = ev.clientY, ox = n.x, oy = n.y; let moved = false;
  const mv = (e) => { moved = true; n.x = Math.max(0, ox + e.clientX - sx); n.y = Math.max(10, oy + e.clientY - sy); g.setAttribute('transform', `translate(${n.x},${n.y})`); };
  const up = async () => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    if (moved) { await call('updateNode', n.id, { x: n.x, y: n.y }); renderGraph(); return; }
    if (connectMode) {
      if (!connectFrom) { connectFrom = n.id; $('#hint').textContent = `From ${n.name}: now click the target node`; }
      else { try { await call('addEdge', connectFrom, n.id, $('#edgetype').value); } catch (e) { alert(e.message); } connectFrom = null; connectMode = false; $('#connect').classList.remove('on'); $('#hint').textContent = 'Edge added.'; return refresh(); }
    } else sel = { ...sel, node: n.id, edge: null };
    renderGraph(); renderNodeForm();
  };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
$('#addnode').onclick = async () => {
  const k = S.team.nodes.length; const role = k === 0 ? 'PM' : 'Dev';
  const n = await call('addNode', { name: `${role} ${k + 1}`, role, x: 60 + (k % 4) * 200, y: 60 + Math.floor(k / 4) * 120 });
  sel.node = n.id; refresh();
};
$('#connect').onclick = () => { connectMode = !connectMode; connectFrom = null; $('#connect').classList.toggle('on', connectMode); $('#hint').textContent = connectMode ? 'Click the source node, then the target node' : ''; renderGraph(); };
$('#testteam').onclick = () => testAgents(S.team.nodes.map((n) => n.id));
$('#delsel').onclick = async () => {
  if (sel.edge) await call('removeEdge', sel.edge);
  else if (sel.node && confirm('Delete this agent?')) await call('removeNode', sel.node);
  sel.node = sel.edge = null; refresh();
};
function renderNodeForm() {
  const f = $('#nodeform'); const n = S.team.nodes.find((x) => x.id === sel.node);
  if (!n) {
    const e = S.team.edges.find((x) => x.id === sel.edge);
    if (!e) { f.innerHTML = '<h3>Team</h3><p class="muted">Select an agent to edit it. Edge A → B: <b>assign</b> = A can create tasks for B (and message B), <b>message</b> = A can message B, <b>review</b> = B reviews A\'s tasks (can move them to review/done).</p>'; return; }
    const type = e.type || 'assign';
    f.innerHTML = `<h3>Edge</h3><p>${esc(nodeName(e.from))} → ${esc(nodeName(e.to))}</p>
      <label>Type</label><select id="ef-type">${S.config.edgeTypes.map((t) => `<option ${t === type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <p class="muted" id="ef-desc">${esc(type === 'review' ? `${nodeName(e.to)} reviews the tasks of ${nodeName(e.from)} and can move them to review/done.` : `${nodeName(e.from)} ${EDGE_DESC[type]} ${nodeName(e.to)}.`)}</p>`;
    $('#ef-type').onchange = act(async (ev) => { await call('updateEdge', e.id, { type: ev.target.value }); refresh(); });
    return;
  }
  const a = S.orch.agents[n.id] || {}; const C = S.config; const off = new Set(n.disabledBoardTools || []);
  const presets = S.settings.rolePresets || [];
  f.innerHTML = `<h3>Agent <span class="pill pf-${pfState(n)}" id="nf-pfbadge">${PF_LABEL[pfState(n)]}</span></h3>
    <div class="toolbar"><button id="nf-test" ${testing.has(n.id) ? 'disabled' : ''}>Test agent</button><span class="muted">saves first, then runs a cheap check</span></div>
    <div id="nf-pf">${pfDetail(n)}</div>
    <label>Name</label><input id="nf-name" value="${esc(n.name)}">
    <label>Role <span class="muted">(free text; presets: ${presets.length})</span></label><input id="nf-role" list="rolelist" value="${esc(n.role)}"><datalist id="rolelist">${C.roles.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
    <div class="toolbar"><button id="nf-applypreset" ${presets.some((p) => p.name.toLowerCase() === String(n.role).toLowerCase()) ? '' : 'disabled'}>Apply preset</button><button id="nf-savepreset">Save as role preset</button></div>
    <label>Runtime</label><select id="nf-runtime">${Object.entries(C.runtimes || { claude: { installed: true, label: 'Claude Code', capabilities: {} } }).map(([id, r]) => `<option value="${id}" ${id === (n.runtime || 'claude') ? 'selected' : ''} ${r.installed ? '' : 'disabled'}>${esc(r.label)}${r.installed ? ' ' + esc(r.version || '') : ' (not installed)'}</option>`).join('')}</select>
    <div id="nf-caps" class="muted"></div>
    <label>Model <span class="muted">(alias or any model ID, e.g. a proxy/provider model; empty = claude CLI default)</span></label><input id="nf-model" list="modellist" value="${esc(n.model || '')}" placeholder="default (claude CLI default)" spellcheck="false"><datalist id="modellist">${MODELS.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
    <label>Working directory</label><input id="nf-workdir" value="${esc(n.workdir)}" placeholder="${esc(S.dir)}">
    <label>System prompt</label><textarea id="nf-prompt" rows="6">${esc(n.systemPrompt)}</textarea>
    <fieldset id="nf-modebox"><legend>Run mode</legend>
      <select id="nf-mode">${RUN_MODES.map(([v, l]) => `<option value="${v}" ${v === (n.mode || 'single') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="mode-goal"><label>Completion condition <span class="muted">(judged by a cheap check run after each iteration)</span></label><textarea id="nf-goalcond" rows="2" placeholder="npm test passes and hello.txt exists">${esc(n.goalCondition || '')}</textarea>
        <label>Max iterations</label><input id="nf-maxiter" type="number" min="1" max="50" value="${n.maxIterations || 5}">
        <label>Check model</label><input id="nf-checkmodel" value="${esc(n.checkModel == null ? 'haiku' : n.checkModel)}" placeholder="haiku"></div>
      <div class="mode-loop"><label>Repeat count <span class="muted">(runs exactly N passes; only the last pass marks the task done)</span></label><input id="nf-loopcount" type="number" min="1" max="50" value="${n.loopCount || 3}"></div>
      <div class="mode-workflow"><label>Slash command / skill <span class="muted">(the task text is passed as its arguments; team context goes in the system prompt)</span></label><input id="nf-slash" list="slashlist" value="${esc(n.slashCommand || '')}" placeholder="/review"><datalist id="slashlist">${['/review', '/security-review', '/simplify', '/init'].map((c) => `<option value="${c}">`).join('')}</datalist></div>
      <label class="inline"><input type="checkbox" id="nf-continue" ${n.continueSession ? 'checked' : ''}> Continue conversation (resume this agent's last session for its next task)</label>
    </fieldset>
    <fieldset id="nf-billbox"><legend>Billing</legend>
      <select id="nf-billing">${(C.billingModes || ['auto']).map((m) => `<option value="${m}" ${m === (n.billingMode || 'auto') ? 'selected' : ''}>${{ auto: 'Auto-detect (whatever the claude CLI uses)', subscription: 'Subscription (Pro/Max login)', api: 'API key (ANTHROPIC_API_KEY)', proxy: 'Proxy / provider (base URL)' }[m] || m}</option>`).join('')}</select>
      <div class="bill-proxy-url"><label>Proxy base URL <span class="muted">(sets ANTHROPIC_BASE_URL)</span></label><input id="nf-billurl" value="${esc(n.billingBaseUrl || '')}" placeholder="http://localhost:4000"></div>
      <p class="muted" id="nf-billnote"></p>
    </fieldset>
    <fieldset id="nf-limits"><legend>Budget &amp; approval</legend>
      <label>Budget per Run, $ <span class="muted">(reported cost; 0 = none)</span></label><input id="nf-budgetusd" type="number" min="0" step="0.01" value="${n.budgetUsd || 0}">
      <label>Token budget per Run <span class="muted">(input + output; 0 = none)</span></label><input id="nf-budgettok" type="number" min="0" step="1000" value="${n.budgetTokens || 0}">
      <label class="inline"><input type="checkbox" id="nf-approval" ${n.requireApproval ? 'checked' : ''}> Require human approval (this agent's "done" goes to review until you approve)</label>
    </fieldset>
    <details id="nf-perms" ${sel.permsOpen ? 'open' : ''}><summary>Permissions &amp; CLI</summary>
      <label>Permission mode</label><select id="nf-perm"><option value="">project default (${esc(S.settings.permissionMode)})</option>${C.permissionModes.map((m) => `<option ${m === n.permissionMode ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <label>Allowed tools <span class="muted">(--allowedTools, one per line or comma)</span></label><textarea id="nf-allowed" rows="2" placeholder="Read&#10;Bash(git log:*)">${esc(list(n.allowedTools))}</textarea>
      <label>Disallowed tools <span class="muted">(--disallowedTools)</span></label><textarea id="nf-disallowed" rows="2" placeholder="WebFetch">${esc(list(n.disallowedTools))}</textarea>
      <label>Max turns <span class="muted">(0 = unlimited)</span></label><input id="nf-maxturns" type="number" min="0" value="${n.maxTurns || 0}">
      <label>Append system prompt</label><textarea id="nf-append" rows="2">${esc(n.appendSystemPrompt || '')}</textarea>
      <label>Additional dirs <span class="muted">(--add-dir, one per line)</span></label><textarea id="nf-adddirs" rows="2">${esc(list(n.addDirs))}</textarea>
      <label>Env vars <span class="muted">(KEY=value per line)</span></label><textarea id="nf-env" rows="2">${esc(Object.entries(n.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea>
      <label>Extra CLI args</label><input id="nf-extra" value="${esc(n.extraArgs || '')}" placeholder='--fallback-model sonnet'>
      <label>Board MCP tools</label><div id="nf-tools" class="checks">${C.boardTools.map((t) => `<label><input type="checkbox" value="${t}" ${off.has(t) ? '' : 'checked'}> ${t}</label>`).join('')}</div>
    </details>
    <p><button id="nf-save" class="primary">Save</button></p>
    ${a.budgetStop ? `<p class="warn">${esc(a.budgetStop)}</p>` : ''}<p class="muted">Status: ${a.status || 'idle'} · runs ${a.runs || 0} · ${fmtTok(a.inputTokens)} in / ${fmtTok(a.outputTokens)} out / ${fmtTok(a.cacheTokens)} cache tok${a.model ? ' · ' + esc(a.model) : ''}${a.billingSource ? ' · ' + a.billingSource : ''}</p>`;
  const BILL_NOTE = { auto: 'Detected per run from the CLI init event (apiKeySource) and env.', subscription: 'API keys and proxy/Bedrock/Vertex env vars are removed so the run uses your claude.ai login. ' + COST_NOTE.subscription + '.', api: 'Billed per token to the API key in the agent env vars (or inherited env).', proxy: 'Requests go to the base URL; the provider bills you. Reported cost is only an API-equivalent estimate.' };
  const showCaps = () => { const r = (C.runtimes || {})[$('#nf-runtime').value]; $('#nf-caps').innerHTML = r ? ['tokens', 'cost', 'mcp', 'resume'].map((k) => `<span class="cap ${r.capabilities[k] ? 'on' : 'off'}">${r.capabilities[k] ? '✓' : '✗'} ${k}</span>`).join(' ') : ''; };
  $('#nf-runtime').onchange = showCaps; showCaps();
  const showBill = () => { const m = $('#nf-billing').value; $('.bill-proxy-url').classList.toggle('hidden', m !== 'proxy'); $('#nf-billnote').textContent = BILL_NOTE[m] || ''; };
  $('#nf-billing').onchange = showBill; showBill();
  const showMode = () => { const m = $('#nf-mode').value; for (const k of ['goal', 'loop', 'workflow']) document.querySelector('.mode-' + k).classList.toggle('hidden', m !== k); };
  $('#nf-mode').onchange = showMode; showMode();
  $('#nf-perms').ontoggle = () => { sel.permsOpen = $('#nf-perms').open; };
  const read = () => ({
    runtime: $('#nf-runtime').value, name: $('#nf-name').value, role: $('#nf-role').value.trim() || 'Dev', model: $('#nf-model').value.trim(), workdir: $('#nf-workdir').value.trim(), systemPrompt: $('#nf-prompt').value,
    permissionMode: $('#nf-perm').value, allowedTools: $('#nf-allowed').value, disallowedTools: $('#nf-disallowed').value, maxTurns: +$('#nf-maxturns').value || 0,
    appendSystemPrompt: $('#nf-append').value, addDirs: $('#nf-adddirs').value, env: $('#nf-env').value, extraArgs: $('#nf-extra').value.trim(),
    mode: $('#nf-mode').value, goalCondition: $('#nf-goalcond').value, maxIterations: +$('#nf-maxiter').value || 5, checkModel: $('#nf-checkmodel').value.trim(),
    loopCount: +$('#nf-loopcount').value || 3, slashCommand: $('#nf-slash').value.trim(), continueSession: $('#nf-continue').checked,
    billingMode: $('#nf-billing').value, billingBaseUrl: $('#nf-billurl').value.trim(),
    budgetUsd: +$('#nf-budgetusd').value || 0, budgetTokens: +$('#nf-budgettok').value || 0, requireApproval: $('#nf-approval').checked,
    disabledBoardTools: [...document.querySelectorAll('#nf-tools input')].filter((x) => !x.checked).map((x) => x.value),
  });
  $('#nf-save').onclick = act(async () => { await call('updateNode', n.id, read()); refresh(); });
  $('#nf-test').onclick = act(async () => { await call('updateNode', n.id, read()); await testAgents([n.id]); });
  $('#nf-savepreset').onclick = act(async () => {
    const v = read(); const name = await ask('Role preset name', v.role); if (!name) return;
    await call('savePreset', { name, systemPrompt: v.systemPrompt, allowedTools: v.allowedTools, disallowedTools: v.disallowedTools, permissionMode: v.permissionMode });
    await call('updateNode', n.id, { ...v, role: name }); refresh();
  });
  $('#nf-applypreset').onclick = act(async () => {
    const p = presets.find((x) => x.name.toLowerCase() === $('#nf-role').value.trim().toLowerCase()); if (!p) return;
    await call('updateNode', n.id, { role: p.name, systemPrompt: p.systemPrompt, allowedTools: p.allowedTools, disallowedTools: p.disallowedTools, permissionMode: p.permissionMode }); refresh();
  });
  $('#nf-role').oninput = () => { $('#nf-applypreset').disabled = !presets.some((p) => p.name.toLowerCase() === $('#nf-role').value.trim().toLowerCase()); };
}

// ---------- idle / busy ----------
// Busy = an agent run in progress. Uses S.orch.idle (node ids) when the API provides it, else derives from agent status.
const presence = (id) => (S.orch.idle ? S.orch.idle.includes(id) : (S.orch.agents[id] || {}).status !== 'working') ? 'idle' : 'busy';
function renderIdle() {
  const idle = S.allNodes.filter((n) => presence(n.id) === 'idle'); const show = S.allNodes.length && idle.length;
  document.querySelectorAll('.idlebanner').forEach((b) => { b.classList.toggle('hidden', !show); if (!show) return;
    b.innerHTML = `<span class="pres idle"><i></i></span><b>${idle.length} agent${idle.length > 1 ? 's' : ''} idle</b><span class="muted">${esc(idle.slice(0, 4).map((n) => n.name).join(', '))}${idle.length > 4 ? '…' : ''}</span><span class="spacer"></span><button class="primary" data-assignidle="${idle[0].id}">Assign work</button>`; });
  document.querySelectorAll('[data-assignidle]').forEach((b) => b.onclick = () => { showTab('board'); $('#nt-assignee').value = b.dataset.assignidle; $('#nt-title').focus(); });
  $('#presence').innerHTML = S.allNodes.map((n) => { const p = presence(n.id); return `<span class="pchip ${p}" title="${esc(n.role)}"><span class="pres ${p}"><i></i></span>${esc(n.name)} <span class="muted">${p}</span></span>`; }).join('');
}

// ---------- board ----------
function renderBoard() {
  const sa = $('#nt-assignee'); const cur = sa.value;
  sa.innerHTML = S.allNodes.map((n) => `<option value="${n.id}">${esc(n.name)} (${n.role})</option>`).join('') || '<option value="">(add agents first)</option>';
  if (cur) sa.value = cur;
  renderIdle();
  $('#columns').innerHTML = STATUSES.map((st) => `<div class="col"><h3>${st.replaceAll('_', ' ')} (${S.tasks.filter((t) => t.status === st).length})</h3>${
    S.tasks.filter((t) => t.status === st).map((t) => { const bl = openBlockers(t); const w = (S.orch.agents[t.assignee] || {}); const live = w.status === 'working' && w.taskId === t.id;
      return `<div class="card ${sel.task === t.id ? 'sel' : ''}${t.awaitingApproval ? ' approval' : ''}" data-id="${t.id}"><b>${esc(t.title)}</b>${live ? '<span class="tag live">live</span>' : ''}${bl.length ? `<span class="tag blocked" title="waits for: ${esc(bl.map(taskTitle).join(', '))}">blocked (${bl.length})</span>` : ''}${t.awaitingApproval ? '<span class="tag approval">needs approval</span>' : ''}<small>${esc(nodeName(t.assignee))} · ${t.comments.length} comments</small></div>`; }).join('')}</div>`).join('');
  document.querySelectorAll('.card').forEach((c) => c.onclick = () => { sel.task = c.dataset.id; renderBoard(); });
  const d = $('#taskdetail'); const t = S.tasks.find((x) => x.id === sel.task);
  if (!t) { d.innerHTML = '<p class="muted">Create a goal task, assign it to an agent (usually the PM), then press Run.</p>'; return; }
  const keep = Object.fromEntries(['td-msg', 'td-note', 'td-comment'].map((k) => [k, $('#' + k) && $('#' + k).value])); const focused = document.activeElement && document.activeElement.id;
  const ag = S.orch.agents[t.assignee] || {}; const live = ag.status === 'working' && ag.taskId === t.id; const bl = openBlockers(t); const deps = new Set(t.blockedBy || []);
  d.innerHTML = `<h3>${esc(t.title)}</h3><p class="muted">${t.id} · by ${esc(t.createdBy === 'human' ? 'human' : nodeName(t.createdBy))}</p>
    ${t.awaitingApproval ? `<div class="approvebox"><b>Waiting for your approval.</b> The agent marked this task done.<textarea id="td-note" rows="2" placeholder="Note (optional; required context when requesting changes)"></textarea><p><button id="td-approve" class="primary">Approve → done</button> <button id="td-reject">Request changes → todo</button></p></div>` : ''}
    ${live || (t.assignee && ag.status === 'working') ? `<div class="livebox"><div class="toolbar"><b>${live ? 'Live' : esc(nodeName(t.assignee)) + ' is working on another task'}</b>${live ? `<span class="muted">iteration ${ag.iteration || 1}${ag.pendingHuman ? ' · message queued' : ''}</span><span class="spacer"></span><button id="td-stopagent">Stop agent</button>` : ''}</div>${live ? '<pre id="td-live"></pre>' : ''}</div>` : ''}
    ${t.assignee ? `<label>Message ${esc(nodeName(t.assignee))} <span class="muted">(${live ? 'interrupts the run and resumes the same session with your message' : 'stored in the agent inbox for its next run'})</span></label><div class="toolbar"><input id="td-msg" placeholder="Answer or instruction for the agent" style="flex:1"><button id="td-send">Send</button></div>` : ''}
    <label>Status</label><select id="td-status">${STATUSES.map((s) => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <label>Assignee</label><select id="td-assignee">${S.allNodes.map((n) => `<option value="${n.id}" ${n.id === t.assignee ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select>
    <label>Blocked by <span class="muted">(runs only after these are done${bl.length ? ` · ${bl.length} open` : ''})</span></label>
    <div id="td-deps" class="checks deps">${S.tasks.filter((x) => x.id !== t.id).map((x) => `<label class="${deps.has(x.id) && x.status !== 'done' ? 'open' : ''}"><input type="checkbox" value="${x.id}" ${deps.has(x.id) ? 'checked' : ''}> ${esc(x.title)} <span class="muted">(${x.status})</span></label>`).join('') || '<span class="muted">no other tasks</span>'}</div>
    <label>Description</label><div class="comment">${esc(t.description) || '<span class="muted">none</span>'}</div>
    ${t.sessionId ? `<p class="muted">Session <code>${esc(t.sessionId)}</code>${t.iterations ? ` · ${t.iterations} iteration(s)` : ''}</p>` : ''}
    <label>Comments</label>${t.comments.map((c) => `<div class="comment"><b>${esc(c.author)}</b>: ${esc(c.text)}</div>`).join('') || '<p class="muted">none</p>'}
    <textarea id="td-comment" rows="2" placeholder="Add comment"></textarea>
    <p><button id="td-addc">Comment</button> <button id="td-del">Delete task</button>${t.worktreePath ? ` <button id="td-diff">Diff</button> <button id="td-merge">Merge</button> <button id="td-discard">Discard</button>` : ''}</p><div id="td-diffbox"></div>`;
  if ($('#td-diff')) {
    $('#td-diff').onclick = act(async () => { const r = await call('taskDiff', t.id); $('#td-diffbox').innerHTML = `<p class="muted">${esc(r.branch)} vs ${esc(r.base)}</p>${r.files.map((f) => `<div><code>${esc(f.status)}</code> ${esc(f.file)}</div>`).join('') || '<p class="muted">no changes</p>'}<pre>${esc(r.diff)}</pre>`; });
    $('#td-merge').onclick = act(async () => { if (!confirm('Merge ' + t.worktreeBranch + ' into the base branch?')) return; await call('taskMerge', t.id); refresh(); });
    $('#td-discard').onclick = act(async () => { if (!confirm('Remove the worktree and delete ' + t.worktreeBranch + '?')) return; await call('taskDiscard', t.id); refresh(); });
  }
  $('#td-status').onchange = async (e) => { await call('updateTask', t.id, { status: e.target.value }); refresh(); };
  $('#td-assignee').onchange = async (e) => { await call('updateTask', t.id, { assignee: e.target.value }); refresh(); };
  $('#td-addc').onclick = async () => { const v = $('#td-comment').value.trim(); if (v) { await call('commentTask', t.id, v); refresh(); } };
  document.querySelectorAll('#td-deps input').forEach((x) => x.onchange = act(async () => { await call('updateTask', t.id, { blockedBy: [...document.querySelectorAll('#td-deps input')].filter((y) => y.checked).map((y) => y.value) }); refresh(); }));
  if ($('#td-approve')) { $('#td-approve').onclick = act(async () => { await call('approveTask', t.id, true, $('#td-note').value.trim()); refresh(); }); $('#td-reject').onclick = act(async () => { await call('approveTask', t.id, false, $('#td-note').value.trim()); refresh(); }); }
  if ($('#td-stopagent')) $('#td-stopagent').onclick = act(async () => { await call('stopAgent', t.assignee); refresh(); });
  if ($('#td-send')) { const send = act(async () => { const v = $('#td-msg').value.trim(); if (!v) return; await call('sendToAgent', t.assignee, v, t.id); $('#td-msg').value = ''; refresh(); }); $('#td-send').onclick = send; $('#td-msg').onkeydown = (e) => { if (e.key === 'Enter') send(); }; }
  if (renderBoard.last === t.id) for (const [k, v] of Object.entries(keep)) if (v && $('#' + k)) $('#' + k).value = v;
  if (renderBoard.last === t.id && focused && focused.startsWith('td-') && $('#' + focused)) $('#' + focused).focus();
  renderBoard.last = t.id; renderLive();
  $('#td-del').onclick = async () => { if (confirm('Delete task?')) { await call('deleteTask', t.id); sel.task = null; refresh(); } };
}
$('#nt-add').onclick = async () => {
  const title = $('#nt-title').value.trim(); if (!title) return;
  const t = await call('createTask', { title, description: $('#nt-desc').value, assignee: $('#nt-assignee').value || null });
  $('#nt-title').value = ''; $('#nt-desc').value = ''; sel.task = t.id; refresh();
};

const taskTitle = (id) => (S.tasks.find((x) => x.id === id) || {}).title || id;
function openBlockers(t) { return (t.blockedBy || []).filter((id) => { const x = S.tasks.find((y) => y.id === id); return x && x.status !== 'done'; }); }
// Per-task live view: the last log lines of the agent working on the selected task.
function renderLive() {
  const box = $('#td-live'); const t = S.tasks.find((x) => x.id === sel.task); if (!box || !t) return;
  box.innerHTML = logs.filter((l) => l.projectId === ctx.p && l.nodeId === t.assignee && !l.saved).slice(-40).map((l) => `<span class="${l.kind}">${new Date(l.at).toLocaleTimeString()} ${l.kind}: ${esc(String(l.text).slice(0, 400))}</span>`).join('\n');
  box.scrollTop = box.scrollHeight;
}

// ---------- wiki ----------
function md(src) {
  const blocks = esc(src).split(/```/);
  return blocks.map((b, i) => i % 2 ? `<pre>${b.replace(/^\w*\n/, '')}</pre>` : b
    .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n{2,}/g, '<br><br>')).join('');
}
function renderWiki() {
  const titles = Object.keys(S.wiki).sort();
  $('#wikilist').innerHTML = `<p><button id="wk-new">+ New page</button></p>` + titles.map((t) => `<div class="${t === sel.page ? 'sel' : ''}" data-t="${esc(t)}">${esc(t)}<br><small class="muted">${esc(S.wiki[t].author)}</small></div>`).join('');
  document.querySelectorAll('#wikilist div').forEach((d) => d.onclick = () => { sel.page = d.dataset.t; wikiEdit = false; loadPage(); renderWiki(); });
  $('#wk-new').onclick = () => { sel.page = null; wikiEdit = true; $('#wk-title').value = ''; $('#wk-content').value = ''; showWiki(); };
  if (sel.page && S.wiki[sel.page] && !wikiEdit) loadPage();
}
function loadPage() { const p = S.wiki[sel.page]; if (!p) return; $('#wk-title').value = p.title; $('#wk-content').value = p.content; showWiki(); }
function showWiki() { $('#wk-content').classList.toggle('hidden', !wikiEdit); $('#wk-view').classList.toggle('hidden', wikiEdit); $('#wk-view').innerHTML = md($('#wk-content').value); }
$('#wk-edit').onclick = () => { wikiEdit = !wikiEdit; showWiki(); };
$('#wk-save').onclick = async () => { const t = $('#wk-title').value.trim(); if (!t) return; await call('writeWiki', t, $('#wk-content').value); sel.page = t; wikiEdit = false; refresh(); };
$('#wk-del').onclick = async () => { if (sel.page && confirm('Delete page?')) { await call('deleteWiki', sel.page); sel.page = null; $('#wk-title').value = ''; $('#wk-content').value = ''; refresh(); } };

// ---------- observability ----------
function renderObs() {
  const rows = S.allNodes.map((n) => { const a = S.orch.agents[n.id] || {};
    return `<tr><td>${esc(n.name)}</td><td>${n.role}</td><td class="st-${a.status || 'idle'}">${a.status || 'idle'}${a.iteration > 1 ? ` (iter ${a.iteration})` : ''}</td><td>${esc(n.mode || 'single')}</td><td>${a.taskId ? esc((S.tasks.find((t) => t.id === a.taskId) || {}).title || a.taskId) : ''}</td><td class="num">${a.runs || 0}</td><td>${esc(a.model || n.model || '')}</td><td class="num">${a.inputTokens || 0}</td><td class="num">${a.outputTokens || 0}</td><td class="num">${a.cacheReadTokens || 0}</td><td class="num">${a.cacheCreationTokens || 0}</td><td>${a.billingSource ? billTag(a.billingSource) : `<span class="muted">${esc(n.billingMode || 'auto')}</span>`}</td><td>${costCell(a.cost, a.billingSource)}${a.budgetStop ? `<br><span class="warn">${esc(a.budgetStop)}</span>` : ''}</td><td class="actions">${a.status === 'working' ? `<button data-stopagent="${n.id}">Stop</button>` : ''}<button data-msgagent="${n.id}">Message</button></td></tr>`; }).join('');
  const T = S.orch.tokens || {};
  $('#agenttable').innerHTML = `<tr><th>Agent</th><th>Role</th><th>Status</th><th>Mode</th><th>Task</th><th title="Agent iterations started this session (initial run, loop/goal iterations, human-message resumes). Goal checks and preflights are not counted; see Usage for all claude processes.">Agent runs</th><th>Model</th><th>In tok</th><th>Out tok</th><th>Cache read</th><th>Cache write</th><th>Billing</th><th>Reported cost</th><th></th></tr>${rows}<tr><th colspan="7">Total (this session)</th><th class="num">${T.inputTokens || 0}</th><th class="num">${T.outputTokens || 0}</th><th class="num">${T.cacheReadTokens || 0}</th><th class="num">${T.cacheCreationTokens || 0}</th><th></th><th>$${(S.orch.totalCost || 0).toFixed(4)} <span class="costnote">API-equivalent (reported by Claude CLI)</span></th><th></th></tr>`;
  document.querySelectorAll('[data-stopagent]').forEach((b) => b.onclick = act(async () => { await call('stopAgent', b.dataset.stopagent); refresh(); }));
  document.querySelectorAll('[data-msgagent]').forEach((b) => b.onclick = act(async () => { const v = await ask(`Message to ${nodeName(b.dataset.msgagent)} (a running agent is interrupted and resumed with it)`); if (v) { await call('sendToAgent', b.dataset.msgagent, v); refresh(); } }));
  const bs = S.orch.budgetStop; const st = S.settings;
  $('#budgetbar').innerHTML = (st.budgetUsd || st.budgetTokens ? `Run budget: ${st.budgetUsd ? `$${(S.orch.runCost || 0).toFixed(4)} / $${st.budgetUsd}` : ''}${st.budgetUsd && st.budgetTokens ? ' · ' : ''}${st.budgetTokens ? `${fmtTok(S.orch.runTokens)} / ${fmtTok(st.budgetTokens)} tok` : ''}` : '') + (bs ? ` <span class="warn">Stopped: ${esc(bs)}</span>` : '');
  $('#msglist').innerHTML = S.messages.length ? S.messages.slice(-50).reverse().map((m) => `<div class="comment"><b>${esc(nodeName(m.from))} → ${esc(nodeName(m.to))}</b> <small class="muted">${new Date(m.at).toLocaleTimeString()}${m.read ? '' : ' · unread'}</small><br>${esc(m.text)}</div>`).join('') : '<p class="muted">No agent messages yet.</p>';
  const f = $('#logfilter'); const cur = f.value;
  f.innerHTML = '<option value="">All agents</option>' + S.allNodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join(''); f.value = cur;
}
function renderLog() {
  const f = $('#logfilter').value; const box = $('#log'); const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.innerHTML = logs.filter((l) => l.projectId === ctx.p && (!f || l.nodeId === f)).slice(-800).map((l) => `<span class="${l.kind}">${new Date(l.at).toLocaleTimeString()} [${esc(l.nodeId ? nodeName(l.nodeId) : 'system')}] ${l.kind}: ${esc(l.text)}</span>`).join('\n');
  if (atBottom) box.scrollTop = box.scrollHeight;
}
$('#logfilter').onchange = renderLog;
$('#clearlog').onclick = act(async () => { if (!confirm('Clear the log of this project (also the saved log file)?')) return; for (let i = logs.length - 1; i >= 0; i--) if (logs[i].projectId === ctx.p) logs.splice(i, 1); await call('clearLogs'); renderLog(); });

// ---------- usage & billing ----------
let RUNS = [];
async function loadRuns() { try { RUNS = await call('listRuns'); } catch { RUNS = []; } }
function sumRuns(rs) {
  const s = { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0, durationMs: 0, sub: 0, billed: 0 };
  for (const r of rs) { s.runs++; for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'numTurns', 'durationMs']) s[k] += r[k] || 0; if (r.billingSource === 'subscription') s.sub += r.reportedCostUsd || 0; else s.billed += r.reportedCostUsd || 0; }
  s.total = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens; return s;
}
function groupTable(title, rs, keyFn, labelFn) {
  const g = {}; for (const r of rs) (g[keyFn(r)] ||= []).push(r);
  const rows = Object.entries(g).map(([k, v]) => [k, sumRuns(v)]).sort((a, b) => b[1].total - a[1].total);
  return `<div><h4>${title}</h4><table><tr><th></th><th title="claude processes recorded for this project: agent runs, goal checks and preflights">Processes</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Total tok</th><th>Reported cost (API-equivalent)</th></tr>${rows.map(([k, s]) => `<tr><td>${esc(labelFn(k))}</td><td class="num">${s.runs}</td><td class="num">${s.inputTokens}</td><td class="num">${s.outputTokens}</td><td class="num">${s.cacheReadTokens}</td><td class="num">${s.cacheCreationTokens}</td><td class="num"><b>${s.total}</b></td><td>${s.billed ? '$' + s.billed.toFixed(4) : ''}${s.sub ? `${s.billed ? ' + ' : ''}<span class="costnote" title="$${s.sub.toFixed(4)} API-equivalent">subscription runs: not billed per token</span>` : ''}${!s.billed && !s.sub ? '$0' : ''}</td></tr>`).join('')}</table></div>`;
}
function renderUsage() {
  const fa = $('#us-agent'); const cur = fa.value;
  fa.innerHTML = '<option value="">All</option>' + S.allNodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join(''); fa.value = cur;
  const fb = $('#us-billing').value;
  const rs = RUNS.filter((r) => (!fa.value || r.nodeId === fa.value) && (!fb || r.billingSource === fb));
  const s = sumRuns(rs);
  const agentName = (id) => { const r = RUNS.find((x) => x.nodeId === id); return S.allNodes.some((n) => n.id === id) ? nodeName(id) : (r && r.agent) || id; };
  const taskName = (id) => { const t = S.tasks.find((x) => x.id === id); const r = RUNS.find((x) => x.taskId === id); return (t && t.title) || (r && r.task) || id || '(none)'; };
  const mism = rs.filter((r) => r.billingMismatch).length;
  $('#us-summary').innerHTML = `<div class="cards">
    <div class="stat"><small>Measured tokens (total)</small><b>${fmtTok(s.total)}</b><small title="Every claude process recorded for this project (all sessions): agent runs, goal checks and preflights.">${s.runs} claude process(es): ${['agent', 'check', 'preflight'].map((k) => `${rs.filter((r) => (r.kind || 'agent') === k).length} ${k}`).join(' · ')} · ${s.numTurns} turns</small></div>
    <div class="stat"><small>Input / Output</small><b>${fmtTok(s.inputTokens)} / ${fmtTok(s.outputTokens)}</b></div>
    <div class="stat"><small>Cache read / write</small><b>${fmtTok(s.cacheReadTokens)} / ${fmtTok(s.cacheCreationTokens)}</b></div>
    <div class="stat" id="us-cost"><small>Reported cost, API-equivalent (Claude CLI)</small><b>$${(s.billed + s.sub).toFixed(4)}</b><small>Billed per token (API key / proxy / cloud): $${s.billed.toFixed(4)}<br>Subscription runs (${rs.filter((r) => r.billingSource === 'subscription').length}): $${s.sub.toFixed(4)}, covered by subscription, not billed per token</small></div>
  </div>${mism ? `<p class="warn">${mism} run(s) did not run on the billing mode set for the agent (see Billing column).</p>` : ''}
  <div class="toolbar" style="align-items:flex-start">${groupTable('By agent', rs, (r) => r.nodeId, agentName)}${groupTable('By model', rs, (r) => r.model || '?', (k) => k)}${groupTable('By billing source', rs, (r) => r.billingSource || 'unknown', (k) => k)}</div>
  <details><summary>By task</summary>${groupTable('By task', rs, (r) => r.taskId || '', taskName)}</details>`;
  $('#us-runs').innerHTML = `<tr><th>Time</th><th>Agent</th><th>Task</th><th>Kind</th><th>Model</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Duration</th><th>Turns</th><th>Billing source</th><th>Reported cost</th></tr>` +
    (rs.slice().reverse().slice(0, 500).map((r) => `<tr><td>${new Date(r.startedAt).toLocaleString()}</td><td>${esc(r.agent || agentName(r.nodeId))}</td><td>${esc(r.task || taskName(r.taskId))}</td><td>${esc(r.kind)}${r.iteration > 1 ? ' #' + r.iteration : ''}</td><td title="${esc((r.models || []).join(', '))}">${esc(r.model || '?')}</td><td class="num">${r.inputTokens}</td><td class="num">${r.outputTokens}</td><td class="num">${r.cacheReadTokens}</td><td class="num">${r.cacheCreationTokens}</td><td class="num">${((r.durationMs || 0) / 1000).toFixed(1)}s</td><td class="num">${r.numTurns}</td><td>${billTag(r.billingSource, r.billingDetail)}${r.billingMismatch ? ` <span class="warn" title="agent billing mode: ${esc(r.billingMode)}">≠ ${esc(r.billingMode)}</span>` : ''}</td><td>${costCell(r.reportedCostUsd, r.billingSource)}</td></tr>`).join('') || '<tr><td colspan="13" class="muted">No runs recorded yet.</td></tr>');
}
$('#us-agent').onchange = renderUsage; $('#us-billing').onchange = renderUsage;
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
$('#us-export').onclick = act(async () => download(`usage-${(S.project.name || 'project').replace(/[^\w-]+/g, '_')}.csv`, await call('usageCSV', false), 'text/csv'));
$('#us-exportall').onclick = act(async () => download('usage-all-projects.csv', await call('usageCSV', true), 'text/csv'));
$('#us-clear').onclick = act(async () => { if (!confirm('Clear the usage history of this project?')) return; await call('clearRuns'); refresh(); });

// ---------- settings ----------
function renderSettings() {
  const s = S.settings;
  $('#settingsform').innerHTML = `<h3>Settings</h3><p class="muted">Project data: ${esc(S.dir)}</p>
    <label>Claude CLI path</label><input id="st-claude" value="${esc(s.claudePath)}">
    <label>Max concurrent agents</label><input id="st-conc" type="number" min="1" max="8" value="${s.maxConcurrency}">
    <label>Max agent runs per Run (safety cap)</label><input id="st-runs" type="number" min="1" value="${s.maxRuns}">
    <label>Default permission mode (agents can override)</label><select id="st-perm">${['bypassPermissions', 'acceptEdits', 'default', 'plan'].map((m) => `<option ${m === s.permissionMode ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <label>Project budget per Run, $ <span class="muted">(stops all agents; 0 = none)</span></label><input id="st-budgetusd" type="number" min="0" step="0.01" value="${s.budgetUsd || 0}">
    <label>Project token budget per Run <span class="muted">(input + output; 0 = none)</span></label><input id="st-budgettok" type="number" min="0" step="1000" value="${s.budgetTokens || 0}">
    <label>Stuck warning after N minutes without output</label><input id="st-stuck" type="number" min="1" value="${s.stuckMinutes || 5}">
    <label class="inline"><input type="checkbox" id="st-approval" ${s.requireApproval ? 'checked' : ''}> Require human approval for every agent's "done"</label>
    <label class="inline"><input type="checkbox" id="st-notify" ${s.notifications === false ? '' : 'checked'}> Desktop notifications (approval needed, budget reached, run finished)</label>
    <p><button id="st-save" class="primary">Save settings</button></p>
    <h3>Role presets (this project)</h3><p class="muted">Presets appear as role suggestions. A new agent whose role matches a preset gets its prompt, tools and permission mode.</p>
    <table id="presettable"><tr><th>Name</th><th>Permission</th><th>Allowed</th><th>Disallowed</th><th></th></tr>${(s.rolePresets || []).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.permissionMode || 'default')}</td><td>${esc(p.allowedTools.join(', '))}</td><td>${esc(p.disallowedTools.join(', '))}</td><td><button data-editp="${esc(p.name)}">Edit</button><button data-delp="${esc(p.name)}">Delete</button></td></tr>`).join('')}</table>
    <div id="presetform"><label>Name</label><input id="pr-name"><label>Default system prompt</label><textarea id="pr-prompt" rows="3"></textarea>
    <label>Default allowed tools</label><input id="pr-allowed" placeholder="Read, Grep"><label>Default disallowed tools</label><input id="pr-disallowed">
    <label>Permission mode</label><select id="pr-perm"><option value="">project default</option>${(S.config.permissionModes || []).map((m) => `<option>${m}</option>`).join('')}</select>
    <p><button id="pr-save">Save preset</button></p></div>`;
  document.querySelectorAll('[data-delp]').forEach((b) => b.onclick = act(async () => { await call('deletePreset', b.dataset.delp); refresh(); }));
  document.querySelectorAll('[data-editp]').forEach((b) => b.onclick = () => { const p = s.rolePresets.find((x) => x.name === b.dataset.editp); $('#pr-name').value = p.name; $('#pr-prompt').value = p.systemPrompt; $('#pr-allowed').value = p.allowedTools.join(', '); $('#pr-disallowed').value = p.disallowedTools.join(', '); $('#pr-perm').value = p.permissionMode; });
  $('#pr-save').onclick = act(async () => { await call('savePreset', { name: $('#pr-name').value, systemPrompt: $('#pr-prompt').value, allowedTools: $('#pr-allowed').value, disallowedTools: $('#pr-disallowed').value, permissionMode: $('#pr-perm').value }); refresh(); });
  $('#st-save').onclick = async () => { await call('saveSettings', { claudePath: $('#st-claude').value.trim() || 'claude', maxConcurrency: +$('#st-conc').value || 2, maxRuns: +$('#st-runs').value || 30, permissionMode: $('#st-perm').value,
    budgetUsd: +$('#st-budgetusd').value || 0, budgetTokens: +$('#st-budgettok').value || 0, requireApproval: $('#st-approval').checked, notifications: $('#st-notify').checked, stuckMinutes: +$('#st-stuck').value || 5 }); refresh(); };
}

// ---------- overview ----------
const projLogs = () => logs.filter((l) => l.projectId === ctx.p);
function renderOverview() {
  if (!$('#tab-overview.active')) return;
  const now = Date.now(); const L = projLogs(); const stuck = new Set(Overview.stuckAgents(S.orch.agents, L, now, S.settings.stuckMinutes || 5));
  const hot = Overview.edgeFlashes(L, S.team.edges, now);
  const svg = $('#ov-graph'); svg.innerHTML = ''; const byId = Object.fromEntries(S.team.nodes.map((n) => [n.id, n]));
  for (const e of S.team.edges) { const a = byId[e.from], b = byId[e.to]; if (!a || !b) continue; const [x1, y1, x2, y2] = clip(a, b); el('line', { x1, y1, x2, y2, class: 'edge' + (hot.has(e.id) ? ' flash' : '') }, svg); }
  for (const n of S.team.nodes) {
    const st = (S.orch.agents[n.id] || {}).status;
    const g = el('g', { class: 'node' + (st === 'working' ? ' working' : '') + (stuck.has(n.id) ? ' stuck' : ''), transform: `translate(${n.x},${n.y})`, 'data-id': n.id }, svg);
    el('rect', { width: W, height: H, rx: 8 }, g); el('text', { x: 10, y: 24, 'font-weight': 600 }, g).textContent = clipText(n.name, 20);
    el('text', { x: 10, y: 42, 'font-size': 11, opacity: 0.7 }, g).textContent = stuck.has(n.id) ? '⚠ stuck' : `${n.role}${st === 'working' ? ' · working' : ''}`;
  }
  $('#ov-stuck').innerHTML = [...stuck].map((id) => `<div class="stuckbar">⚠ <b>${esc(nodeName(id))}</b> has produced no output for ${S.settings.stuckMinutes || 5}+ min<span class="spacer"></span><button data-ovstop="${id}">Stop</button><button data-ovnudge="${id}">Nudge</button></div>`).join('');
  document.querySelectorAll('[data-ovstop]').forEach((b) => b.onclick = act(async () => { await call('stopAgent', b.dataset.ovstop); refresh(); }));
  document.querySelectorAll('[data-ovnudge]').forEach((b) => b.onclick = act(async () => { await call('sendToAgent', b.dataset.ovnudge, 'Status check: you have produced no output for a while. Reply with a short status (what you are doing, whether you are blocked), then continue or finish your task.'); refresh(); }));
  // Timeline: last 15 minutes, one lane per agent, auto-scrolled to now.
  const ids = S.team.nodes.map((n) => n.id); const lanes = Overview.timeline(L, ids, now); const span = 15 * 60000, LW = 110, PX = Math.max(600, $("#ov-timeline").clientWidth - LW - 30), LH = 26;
  const x = (t) => LW + Math.max(0, (t - (now - span)) / span * PX);
  const tl = el('svg', { width: LW + PX + 10, height: ids.length * LH + 18 }, null);
  ids.forEach((id, i) => { const y = i * LH; const ln = lanes[id];
    el('rect', { x: 0, y, width: LW + PX, height: LH, class: 'lane' + (stuck.has(id) ? ' stuck' : ''), fill: 'transparent' }, tl);
    el('text', { x: 4, y: y + 17 }, tl).textContent = (stuck.has(id) ? '⚠ ' : '') + clipText(nodeName(id), 14);
    for (const r of ln.runs) if (r.end >= now - span) el('title', {}, el('rect', { x: x(r.start), y: y + 5, width: Math.max(2, x(r.end) - x(r.start)), height: LH - 10, rx: 3, class: 'run' + (r.live ? ' live' : '') }, tl)).textContent = r.task;
    for (const t of ln.ticks) if (t.at >= now - span) el('title', {}, el('line', { x1: x(t.at), x2: x(t.at), y1: y + 3, y2: y + LH - 3, class: 'tick' }, tl)).textContent = t.name;
    for (const m of ln.marks) if (m.at >= now - span) el('title', {}, el('circle', { cx: x(m.at), cy: y + 5, r: 4, class: 'mark' }, tl)).textContent = '→ ' + m.status; });
  for (let m = 0; m <= 15; m += 5) el('text', { x: x(now - m * 60000) - 14, y: ids.length * LH + 14 }, tl).textContent = m ? `-${m}m` : 'now';
  const box = $('#ov-timeline'); box.innerHTML = ''; box.appendChild(tl); box.scrollLeft = box.scrollWidth;
  // Readable task thread.
  const ts = $('#ov-task'); const cur = ts.value || sel.task || (S.tasks[S.tasks.length - 1] || {}).id || '';
  ts.innerHTML = S.tasks.map((t) => `<option value="${t.id}">${esc(t.title)} (${t.status})</option>`).join(''); ts.value = cur;
  const t = S.tasks.find((x) => x.id === ts.value); const open = new Set([...document.querySelectorAll('#ov-thread details[open]')].map((d) => d.dataset.k));
  $('#ov-thread').innerHTML = !t ? '<p class="muted">No tasks yet.</p>' : Overview.taskThread(t, L, S.messages).map((it, k) => it.type === 'tool'
    ? `<details data-k="${k}" ${open.has(String(k)) ? 'open' : ''}><summary class="chip">🔧 ${esc(it.summary)}</summary><pre>${esc(it.text)}</pre></details>`
    : `<div class="comment ${it.type === 'message' ? 'msg' : ''}"><b>${esc(it.type === 'message' ? `${nodeName(it.who)} → ${nodeName(it.to)}` : it.who === 'human' || it.who === 'orchestrator' ? it.who : nodeName(it.who))}</b> <small class="muted">${new Date(it.at).toLocaleTimeString()}</small><br>${esc(it.text)}</div>`).join('') || '<p class="muted">Nothing yet.</p>';
}
$('#ov-task').onchange = renderOverview;
document.querySelector('#tabs button[data-tab=overview]').addEventListener('click', () => setTimeout(renderOverview));
setInterval(renderOverview, 1000);

// ---------- chat: #company room, task threads, working indicator, composer ----------
const CH = { thread: null, key: '', mi: 0, asks: [] };
const who = (id) => { const n = S.allNodes.find((x) => x.id === id); return n ? { name: n.name, role: n.role, color: Chat.avatarColor(n.id), ini: Chat.initials(n.name) } : id === 'human' ? { name: 'You', role: '', color: 'transparent', ini: '', human: true } : { name: id || 'system', role: '', color: '#3a3f4b', ini: '⚙' }; };
function bubble(e) {
  const link = e.taskId && !CH.thread ? ` data-thread="${e.taskId}"` : ''; const tl = link ? `<span class="tlink">↳ ${esc(taskTitle(e.taskId).slice(0, 40))}</span>` : '';
  if (e.type === 'tool') return `<details class="cchip"><summary>🔧 ${esc(e.label)}</summary><pre>${esc(e.text)}${e.result != null ? '\n→ ' + esc(String(e.result).slice(0, 2000)) : ''}</pre></details>${tl ? `<span class="bubble linked"${link}>${tl}</span>` : ''}<br>`;
  if (e.type === 'question') return `<div class="bubble question" data-iid="${e.inboxId}">❓ <b>Question for you</b>${tl}<br>${esc(e.text)}<br>${e.choices.map((c) => `<button class="primary ch-choice" data-v="${esc(c)}">${esc(c)}</button>`).join('')}<textarea class="ch-ans" rows="1" placeholder="Or type an answer"></textarea><button class="ch-send">Answer</button></div>`;
  const text = e.type === 'handoff' ? `📋 assigned “${e.text}” to @${who(e.to).name}` : e.type === 'message' ? `✉ @${who(e.to).name} ${e.text}` : e.type === 'comment' ? `💬 ${e.text}` : e.text;
  return `<div class="bubble ${e.type}${link ? ' linked' : ''}"${link}>${esc(text)}${tl}</div>`;
}
// Merge adjacent same-author groups (no repeated "You" headers); questions stay separate.
const mergeGroups = (gs) => gs.reduce((out, g) => { const p = out[out.length - 1]; if (p && p.who === g.who && g.items[0].type !== 'question' && p.items[0].type !== 'question') p.items.push(...g.items); else out.push({ ...g, items: [...g.items] }); return out; }, []);
const needsYou = () => new Set([...(S.inbox || []).map((i) => i.nodeId), ...CH.asks]);
const avatarHtml = (id, working, ask) => { const w = who(id); return `<div class="avatar${w.human ? ' human' : ''}${working.has(id) ? ' working' : ''}${ask.has(id) ? ' ask' : ''}" style="background:${w.color}" title="${esc(w.name)}${working.has(id) ? ' · working' : ask.has(id) ? ' · needs you' : ''}">${esc(w.ini)}</div>`; };
const renderGroups = (events, working) => { const ask = needsYou(); return mergeGroups(Chat.group(events)).map((g) => { const w = who(g.who);
  return `<div class="cgroup${w.human ? ' self' : ''}">${avatarHtml(g.who, working, ask)}<div class="cbody"><div class="cname">${esc(w.name)}${w.role ? `<span class="role">${esc(w.role)}</span>` : ''}<time>${new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>${g.items.map(bubble).join('')}</div></div>`; }).join(''); };
// Sticky "Your turn" bar above the composer: every pending ask_human question/approval.
function renderYourTurn(ev) {
  const seen = new Set((S.inbox || []).map((i) => i.id)); const items = [...(S.inbox || []), ...ev.filter((e) => e.type === 'question' && !seen.has(e.inboxId)).map((e) => ({ id: e.inboxId, nodeId: e.who, question: e.text, choices: e.choices, kind: 'question' }))]; const bar = $('#chat-yourturn'); bar.classList.toggle('hidden', !items.length);
  bar.innerHTML = items.length ? `<div class="yt-head"><span class="yt-badge">!</span><b>Your turn</b><span class="muted">${items.length} waiting</span></div>` + items.map((i) => `<div class="yt-item" data-iid="${i.id}"><b>${esc(nodeName(i.nodeId))}</b> <span>${esc(i.question)}</span><span class="spacer"></span>${(i.kind === 'approval' ? ['approve'] : i.choices || []).map((c) => `<button class="primary yt-choice" data-v="${esc(c)}">${esc(c)}</button>`).join('')}<input class="yt-ans" placeholder="${i.kind === 'approval' ? 'Request changes…' : 'Answer…'}"><button class="yt-send">Send</button></div>`).join('') : '';
  bar.querySelectorAll('.yt-item').forEach((d) => { const answer = (v) => act(async () => { if (!v) return; await call('answerInbox', d.dataset.iid, v); refresh(); })();
    d.querySelectorAll('.yt-choice').forEach((b) => b.onclick = () => answer(b.dataset.v)); d.querySelector('.yt-send').onclick = () => answer(d.querySelector('.yt-ans').value.trim());
    d.querySelector('.yt-ans').onkeydown = (e) => { if (e.key === 'Enter') answer(e.target.value.trim()); }; });
}
function renderChat() {
  if (!$('#tab-chat.active')) return;
  const ev = Chat.roomEvents(projLogs(), S.tasks, S.messages, S.inbox); const working = new Set(Object.keys(S.orch.agents || {}).filter((id) => S.orch.agents[id].status === 'working'));
  CH.asks = ev.filter((e) => e.type === 'question').map((e) => e.who);
  const key = [ctx.p, ev.length, (ev[ev.length - 1] || {}).at, [...working].join(), CH.thread, S.allNodes.map((n) => n.name).join(), (S.inbox || []).map((i) => i.id).join()].join('|');
  $('#chat-typing').innerHTML = [...working].map((id) => `<span class="typing"><span class="spin"></span>${esc(who(id).name)} is working<span class="dots"></span></span>`).join(' · ');
  if (key === CH.key) return; CH.key = key; renderYourTurn(ev);
  const room = $('#chat-room'); const atBottom = room.scrollHeight - room.scrollTop - room.clientHeight < 40;
  room.innerHTML = ev.length ? renderGroups(ev, working) : S.team.nodes.length ? `<div class="cempty"><b>#company is quiet</b>Type a goal below, or @mention an agent (e.g. <code>@${esc(S.team.nodes[0].name)} write hello.txt</code>).</div>` : '<div class="cempty"><b>No team yet</b>Create your team in the Team tab (or use the first-run guide), then chat with it here.</div>';
  if (atBottom) room.scrollTop = room.scrollHeight;
  const th = $('#chat-thread'); const t = S.tasks.find((x) => x.id === CH.thread); th.classList.toggle('hidden', !t);
  if (t) { const tev = ev.filter((e) => e.taskId === t.id);
    th.innerHTML = `<div class="chat-head"><b>🧵 ${esc(t.title)}</b><span class="role">${esc(t.status)}</span><span class="spacer"></span><button id="ch-close" title="Close thread">✕</button></div><div id="chat-threadroom">${tev.length ? renderGroups(tev, working) : '<p class="muted" style="padding:16px">Nothing in this thread yet.</p>'}</div>`;
    $('#ch-close').onclick = () => { CH.thread = null; renderChat(); }; }
  document.querySelectorAll('#tab-chat [data-thread]').forEach((b) => b.onclick = () => { CH.thread = b.dataset.thread; renderChat(); });
  document.querySelectorAll('#tab-chat .bubble.question').forEach((d) => {
    const answer = (v) => act(async () => { if (!v) return; await call('answerInbox', d.dataset.iid, v); refresh(); })();
    d.querySelectorAll('.ch-choice').forEach((b) => b.onclick = () => answer(b.dataset.v)); d.querySelector('.ch-send').onclick = () => answer(d.querySelector('.ch-ans').value.trim());
  });
}
function chatPreview() {
  const v = $('#chat-input').value; const p = Chat.parseComposer(v, S.team.nodes); const pv = $('#chat-preview');
  pv.textContent = Chat.preview(p); pv.className = p ? p.kind : 'muted';
  const ms = Chat.mentionMatches(v, S.team.nodes); const box = $('#chat-mentions'); box.classList.toggle('hidden', !ms || !ms.length);
  CH.mi = Math.min(CH.mi, Math.max(0, (ms || []).length - 1));
  box.innerHTML = (ms || []).map((n, i) => `<div data-name="${esc(n.name)}" class="${i === CH.mi ? 'sel' : ''}"><span class="avatar" style="background:${Chat.avatarColor(n.id)}">${esc(Chat.initials(n.name))}</span>${esc(n.name)} <span class="role">${esc(n.role)}</span></div>`).join('');
  box.querySelectorAll('div').forEach((d) => d.onmousedown = (e) => { e.preventDefault(); pickMention(d.dataset.name); });
}
function pickMention(name) { const i = $('#chat-input'); i.value = i.value.replace(/@(\w*)$/, '@' + name + ' '); i.focus(); CH.mi = 0; chatPreview(); }
async function chatSend() {
  const i = $('#chat-input'); const p = Chat.parseComposer(i.value, S.team.nodes); if (!p) return;
  if (p.kind === 'error') return chatPreview();
  if (p.kind === 'task') { await call('createTask', { title: p.text.slice(0, 80), description: p.text, assignee: p.nodeId }); if (!S.orch.running) await call('run'); }
  else if (p.kind === 'message') await call('sendToAgent', p.nodeId, p.text);
  else { if (!confirm(`Start a new goal for the team?\n\n“${p.text.slice(0, 200)}”\n\nThis runs your agents (may cost tokens).`)) return; $('#goal').value = p.text; await $('#run').onclick(); }
  i.value = ''; chatPreview(); CH.key = ''; refresh();
}
$('#chat-input').addEventListener('input', chatPreview);
$('#chat-input').addEventListener('keydown', (e) => {
  const box = $('#chat-mentions'); const open = !box.classList.contains('hidden'); const items = box.querySelectorAll('div');
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); CH.mi = (CH.mi + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; chatPreview(); }
  else if (open && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pickMention(items[CH.mi].dataset.name); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); act(chatSend)(); }
});
$('#chat-send').onclick = act(chatSend);
document.querySelector('#tabs button[data-tab=chat]').addEventListener('click', () => setTimeout(() => { CH.key = ''; renderChat(); }));
setInterval(renderChat, 1000);

// ---------- human inbox (ask_human questions + approvals) ----------
function renderInbox() {
  const items = S.inbox || []; const n = items.length ? String(items.length) : '';
  $('#inbox-badge').textContent = n; $('#inbox-tab-badge').textContent = n;
  const taskTitle = (id) => (S.tasks.find((t) => t.id === id) || {}).title || '';
  $('#inboxlist').innerHTML = items.length ? items.map((i) => `<div class="inboxitem" data-iid="${i.id}">
    <small>${i.kind === 'approval' ? 'Approval' : 'Question'} from <b>${esc(nodeName(i.nodeId))}</b>${i.taskId ? ' · task: ' + esc(taskTitle(i.taskId)) : ''} · ${esc(new Date(i.at).toLocaleString())}</small>
    <p>${esc(i.question)}</p>
    <p>${(i.kind === 'approval' ? ['approve'] : i.choices).map((c) => `<button class="ib-choice primary" data-v="${esc(c)}">${esc(c)}</button>`).join(' ')}</p>
    <textarea class="ib-text" rows="2" placeholder="${i.kind === 'approval' ? 'Or describe the changes you want' : 'Your answer'}"></textarea>
    <p><button class="ib-send">${i.kind === 'approval' ? 'Request changes' : 'Send answer'}</button></p></div>`).join('') : '<p class="muted">Nothing waiting for you.</p>';
  document.querySelectorAll('.inboxitem').forEach((d) => {
    const answer = (v) => act(async () => { if (!v) return; await call('answerInbox', d.dataset.iid, v); refresh(); })();
    d.querySelectorAll('.ib-choice').forEach((b) => b.onclick = () => answer(b.dataset.v));
    d.querySelector('.ib-send').onclick = () => answer(d.querySelector('.ib-text').value.trim());
  });
}
$('#inbox-side').onclick = () => showTab('inbox');

// ---------- live updates ----------
let pending = null, pendingP = null;
squad.on('log', (l) => { logs.push(l); if (logs.length > 8000) logs.splice(0, 1000); renderLog(); renderLive(); });
// In-app toast for orchestrator notifications (desktop notifications are shown by the main process).
squad.on('notify', (n) => {
  if (n.projectId && n.projectId !== ctx.p) return;
  const d = document.createElement('div'); d.className = 'toast'; d.innerHTML = `<b>${esc(n.title)}</b><br>${esc(n.body)}`;
  if (n.inbox) refresh();
  d.onclick = () => { if (n.inbox) { showTab('inbox'); d.remove(); return; } if (n.taskId) { sel.task = n.taskId; showTab('board'); renderBoard(); } d.remove(); };
  $('#toasts').appendChild(d); setTimeout(() => d.remove(), 8000);
});
// Keyboard shortcuts: Ctrl/Cmd+1..6 tabs, Ctrl/Cmd+Enter Run, Ctrl/Cmd+. Stop, Esc clear selection / close, ? help.
const TABS = ['chat', 'team', 'board', 'wiki', 'obs', 'usage', 'settings', 'overview', 'inbox'];
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey; const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (mod && e.key >= '1' && e.key <= '9') { e.preventDefault(); showTab(TABS[+e.key - 1]); }
  else if (mod && e.key === 'Enter') { e.preventDefault(); $('#run').click(); }
  else if (mod && e.key === '.') { e.preventDefault(); $('#stop').click(); }
  else if (e.key === 'Escape' && !$('#askdlg').open) { if ($('#helpdlg').open) return; if (typing) return document.activeElement.blur(); sel = { ...sel, node: null, edge: null, task: null }; connectMode = false; connectFrom = null; $('#connect').classList.remove('on'); renderGraph(); renderNodeForm(); renderBoard(); }
  else if (!typing && !mod && e.key === '?') $('#helpdlg').showModal();
  else if (!typing && !mod && e.key === 'n' && document.querySelector('#tab-board.active')) { e.preventDefault(); $('#nt-title').focus(); }
  else if (!typing && !mod && e.key === '/') { e.preventDefault(); $('#goal').focus(); }
});
squad.on('state', (st) => { if (st.projectId && st.projectId !== ctx.p) { clearTimeout(pendingP); pendingP = setTimeout(async () => { P = await call('listProjects'); renderSidebar(); }, 200); return; } clearTimeout(pending); pending = setTimeout(refresh, 100); });
setInterval(() => { if (S.orch.running) refresh(); }, 2000); // pick up board changes made by agents
refresh();
$('#help').onclick = () => $('#helpdlg').showModal();

// ---------- first-run guide: workdir + runtime -> starter team (+ Test team) -> first goal ----------
const G = { dir: '', runtime: 'claude', hidden: localStorage.getItem('guideHidden') === '1', forced: false };
function renderGuide() {
  const g = $('#guide'); const ns = S.team.nodes; const started = S.tasks.length > 0;
  if (G.hidden || (!G.forced && (ns.length && started))) return g.classList.add('hidden');
  g.classList.remove('hidden');
  const rts = S.config.runtimes || { claude: { installed: true, label: 'Claude Code', capabilities: {} } }; const rt = rts[G.runtime] || {};
  const pass = ns.filter((n) => pfState(n) === 'pass').length; const busy = ns.some((n) => pfState(n) === 'testing');
  const s1 = !!G.dir || ns.length > 0, s2 = ns.length > 0, s3 = started;
  g.innerHTML = `<b>Get started</b> <span class="muted">${[s1, s2, s3].filter(Boolean).length}/3</span> <button id="g-close" style="float:right" title="Dismiss (reopen from ? help)">✕</button>
  <div class="gstep"><h4 class="${s1 ? 'gdone' : ''}">1. Working directory + runtime</h4>
    <button id="g-dir">${G.dir ? 'Change folder' : 'Choose folder'}</button> <span class="muted">${esc(G.dir || (ns.length ? 'set on agents' : 'project folder is used if skipped'))}</span><br>
    <select id="g-rt">${Object.entries(rts).map(([id, r]) => `<option value="${id}" ${id === G.runtime ? 'selected' : ''} ${r.installed ? '' : 'disabled'}>${esc(r.label)}${r.installed ? '' : ' (not installed)'}</option>`).join('')}</select>
    <span class="${rt.installed ? '' : 'muted'}">${rt.installed ? '✓ installed ' + esc(rt.version || '') : '✗ not found on PATH'}</span></div>
  <div class="gstep ${s2 || rt.installed ? '' : 'off'}"><h4 class="${s2 && pass === ns.length ? 'gdone' : ''}">2. Starter team (PM → Dev → Reviewer)</h4>
    ${s2 ? `<span>${busy ? 'Testing each agent…' : `Test team: ${pass}/${ns.length} responded`}</span> <button id="g-test" ${busy ? 'disabled' : ''}>Test team</button>
      <ul>${ns.map((n) => `<li>${esc(n.name)}: ${PF_LABEL[pfState(n)]}</li>`).join('')}</ul>` : '<button id="g-team" class="primary">Create starter team + test</button>'}</div>
  <div class="gstep ${s2 ? '' : 'off'}"><h4 class="${s3 ? 'gdone' : ''}">3. First goal</h4>
    ${s3 ? '<span class="muted">Goal started — watch it in Observability.</span>' : '<textarea id="g-goal" rows="2" placeholder="e.g. Create hello.txt with hello world"></textarea><button id="g-start" class="primary">Start</button>'}</div>`;
  $('#g-close').onclick = () => { G.hidden = true; G.forced = false; localStorage.setItem('guideHidden', '1'); renderGuide(); };
  $('#g-dir').onclick = async () => { const d = await call('pickDir'); if (d) { G.dir = d; renderGuide(); } };
  $('#g-rt').onchange = (e) => { G.runtime = e.target.value; renderGuide(); };
  if ($('#g-test')) $('#g-test').onclick = () => testAgents(ns.map((n) => n.id));
  if ($('#g-team')) $('#g-team').onclick = async () => {
    $('#g-team').disabled = true; const ids = [];
    for (const [i, role] of ['PM', 'Dev', 'Reviewer'].entries()) ids.push((await call('addNode', { name: role, role, x: 60 + i * 220, y: 80, runtime: G.runtime, ...(G.dir ? { workdir: G.dir } : {}) })).id);
    await call('addEdge', ids[0], ids[1], 'assign'); await call('addEdge', ids[1], ids[2], 'review');
    await refresh(); testAgents(ids);
  };
  if ($('#g-start')) $('#g-start').onclick = () => { const v = $('#g-goal').value.trim(); if (!v) return $('#g-goal').focus(); $('#goal').value = v; G.forced = false; $('#run').click(); };
}
$('#reopenguide').onclick = () => { G.hidden = false; G.forced = true; localStorage.removeItem('guideHidden'); renderGuide(); };

// Theme: mirror the OS/nativeTheme scheme onto <html data-theme> so tokens flip reliably (media query alone didn't re-apply in Electron).
{ const mq = matchMedia('(prefers-color-scheme: dark)'); const apply = () => document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light'; apply(); mq.addEventListener('change', apply); squad.on('theme', (t) => { document.documentElement.dataset.theme = t.dark ? 'dark' : 'light'; }); }
