/* global squad */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODELS = ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const RUN_MODES = [['single', 'Single: one run per task'], ['goal', 'Goal: resume until condition met'], ['loop', 'Loop: repeat N times'], ['workflow', 'Workflow: slash command / skill']];
const STATUSES = ['todo', 'in_progress', 'waiting_for_human', 'review', 'done', 'merge_conflict'];
const call = (name, ...args) => squad.call(name, ctx, ...args); // every call is scoped to the selected project/team
let ctx = (() => { try { return JSON.parse(localStorage.getItem('ctx')) || {}; } catch { return {}; } })();
let P = { projects: [], templates: {} };
let S = { allNodes: [], team: { nodes: [], edges: [] }, tasks: [], wiki: {}, settings: { rolePresets: [] }, messages: [], orch: { agents: {} }, config: { permissionModes: [], edgeTypes: ['assign'], boardTools: [], roles: [] } };
const EDGE_DESC = { assign: 'can assign tasks to and message', message: 'can send messages to', review: 'is reviewed by' };
const list = (v) => (Array.isArray(v) ? v : []).join('\n');
let sel = { node: null, edge: null, task: null, page: null, logTeam: '' };
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

// Change-driven refresh (t_9d92c3d3): the 2s tick polls the tiny state version; only when some
// signature changed is getAll called, and then it returns just the changed sections (deltas merged
// into S). Same data as before — whole-project fetches and full re-renders only happen on real change.
let lastV = null, lastVProject = null, runsChanged = true;
const sameVersion = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function refresh() {
  // Store-touching update phases in flight (see updFrozen near the self-update code): keep the last
  // known-good snapshot on screen — fetch and swap nothing; just keep the veil/chip current (status
  // pushes do too). pending/draining are NOT store-touching, so there the UI keeps updating.
  if (updFrozen()) { await loadSelfUpdate(); renderSelfUpdate(); return; }
  // Fetch into locals first; only swap the live P/S/ctx (and render) once everything required succeeds,
  // so a failed/partial IPC round-trip can't blank out a good previous render.
  const prevCtx = ctx;
  try {
    let v = null;
    if (ctx.p) { try { v = await call('getStateVersion'); } catch { v = null; } } // unknown project (boot/deleted): fall through to the full path
    if (v && lastVProject === ctx.p && lastV && sameVersion(v, lastV)) return; // nothing changed anywhere
    const p = await call('listProjects');
    if (!p.projects.some((pr) => pr.id === ctx.p)) ctx = { p: p.projects[0].id }; // must land on global ctx before the calls below, which read it
    const since = v && lastVProject === ctx.p ? lastV : null;
    const runsChanged = !since || since.runs !== v.runs;
    const s = await call('getAll', since);
    s.inbox = await call('listInbox');
    try { s.nstat = await call('nodeStatus'); s.cross = await call('crossEdges'); }
    catch { s.nstat = S.nstat || {}; s.cross = S.cross || []; }
    ctx.t = s.teamId;
    P = p; S = { ...S, ...s };
    lastV = s.v || v; lastVProject = ctx.p;
  } catch (e) {
    ctx = prevCtx; console.warn('refresh failed, keeping previous data', e); return;
  }
  if (runsChanged) await loadRuns(); // runs.json (796KB) is re-read only when its file actually changed
  await loadLogs(ctx.p); await loadSelfUpdate();
  try { localStorage.setItem('ctx', JSON.stringify(ctx)); } catch {}
  renderAll();
}
const nodeName = (id) => (S.allNodes.find((n) => n.id === id) || {}).name || (id ? id : 'unassigned');
function renderAll() { renderSidebar(); renderGraph(); renderPreflightBar(); renderNodeForm(); renderBoard(); renderWiki(); renderObs(); renderSettings(); renderHeader(); renderSelfUpdate(); renderLimitMeter(); renderUsage(); renderOverview(); renderInbox(); renderGuide(); renderChat(); }
const fmtTok = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n); };
const COST_NOTE = { subscription: 'Covered by subscription — not billed per token', other: 'API-equivalent (reported by Claude CLI)' };
const VENDOR = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const canCost = (rt) => { const r = ((S.config || {}).runtimes || {})[rt || 'claude']; return !r || !r.capabilities || r.capabilities.cost !== false; };
const vbadge = (n) => n ? `<span class="vbadge vb-${esc(n.runtime || 'claude')}" title="runtime · model">${esc(VENDOR[n.runtime || 'claude'] || n.runtime)}<i>${esc(n.model || 'default')}</i></span>` : '';
const RT_PRESETS = [{ name: 'Planner', runtime: 'claude', model: 'opus' }, { name: 'Dev', runtime: 'codex', model: '' }, { name: 'Checker', runtime: 'claude', model: 'haiku' }];
const billTag = (src, detail) => `<span class="bill bill-${esc(src || 'unknown')}" title="${esc(detail || '')}">${esc(src || 'unknown')}</span>`;

// ---------- custom runtimes: add-by-path -> stub introspection -> editable draft profile ----------
// Stored client-side (no backend support yet); node.runtime holds "custom:<id>" once assigned.
const CUSTOM_RT_KEY = 'customRuntimes';
const loadCustomRuntimes = () => { try { return JSON.parse(localStorage.getItem(CUSTOM_RT_KEY)) || []; } catch { return []; } };
const saveCustomRuntimes = (list) => { try { localStorage.setItem(CUSTOM_RT_KEY, JSON.stringify(list)); } catch {} };
const isCustomRuntime = (id) => String(id || '').startsWith('custom:');
const customRuntimeId = (bin) => 'custom:' + String(bin).split(/[\\/]/).pop().replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
const findCustomRuntime = (id) => loadCustomRuntimes().find((r) => r.id === id);
const runtimeLabel = (id) => VENDOR[id] || (findCustomRuntime(id) || {}).label || id;
// Every runtime selectable on a node, backend-known (C.runtimes) plus locally-defined custom ones.
function allRuntimeOptions() {
  const backend = Object.entries((S.config || {}).runtimes || {}).map(([id, r]) => ({ id, label: r.label, installed: r.installed, version: r.version, capabilities: r.capabilities, custom: false }));
  const custom = loadCustomRuntimes().map((r) => ({ id: r.id, label: r.label, installed: true, version: r.version, capabilities: { tokens: false, cost: false, mcp: false, resume: !!r.resume }, custom: true }));
  return [...backend, ...custom];
}
// Agreed introspection result shape (t_94eef7a1): { profile, sources } — sources says where each derived
// field came from: help = --help parsing, probe = live probe run, agent = agent-reported, fallback =
// default guess. Backends still returning the bare profile get conservatively inferred sources here, so
// unconfirmed fields always show up as low-confidence and the UI contract stays stable either way.
const SRC_META = {
  help: { label: 'help', title: 'parsed from the CLI --help output' },
  models: { label: 'models', title: 'parsed from the CLI models command output' },
  probe: { label: 'probe', title: 'from a live probe run of the CLI' },
  agent: { label: 'agent', title: 'reported by the agent itself' },
  fallback: { label: 'fallback', title: 'default assumption — not confirmed by the CLI' },
  edited: { label: 'edited', title: 'manually edited' },
};
const normSrc = (s, def) => {
  const o = typeof s === 'string' ? { source: s } : (s || def || {});
  const source = SRC_META[o.source] ? o.source : 'fallback';
  return { source, confidence: o.confidence || (source === 'fallback' ? 'low' : 'high'), note: o.note || '' };
};
// Values matching the introspector's fallback defaults (models ['default'], default event-mapping paths,
// empty effort) can't be told apart from real parses by the renderer, so they are marked low-confidence.
function inferSources(p) {
  const emDefaults = { text: 'text', session: 'session_id', cost: 'cost', input: 'input_tokens', output: 'output_tokens', reasoning: 'reasoning_tokens', cache: 'cache_read_tokens' };
  const em = p.eventMapping || {};
  const stubNote = { source: 'fallback', note: 'stub — no live CLI response' };
  return {
    bin: { source: 'edited', note: 'binary path you entered' },
    label: p.label && p.label !== p.bin ? { source: 'help' } : { source: 'fallback', note: 'defaults to the binary name' },
    models: (p.models || []).length && !(p.models.length === 1 && p.models[0] === 'default') ? { source: 'help' } : { source: 'fallback', note: 'no model list parsed — please fill in' },
    defaultModel: p.defaultModel && p.defaultModel !== 'default' ? { source: 'help' } : { source: 'fallback', note: 'no default parsed' },
    effort: (p.effort || []).length ? { source: 'help' } : { source: 'fallback', note: 'no effort levels parsed' },
    variants: (p.variants || []).length ? { source: 'help' } : { source: 'fallback' },
    resume: p.resume ? { source: 'help' } : { source: 'fallback', note: 'no resume flag found in help' },
    eventMapping: Object.fromEntries(Object.entries(emDefaults).map(([k, def]) => [k, em[k] && em[k] !== def ? { source: 'probe' } : { source: 'fallback', note: 'default path — no probe data' }])),
    ...(p.stub ? Object.fromEntries(['label', 'models', 'defaultModel', 'effort', 'variants', 'resume'].map((k) => [k, stubNote])) : {}),
  };
}
function draftSources(p, sources) {
  const inf = inferSources(p);
  const raw = sources || {};
  // The backend reports provenance under introspector field names (effortValues, resumeFlag,
  // modelsCommand, ...); map them onto the draft form's field names, falling back to inference.
  const aliases = { effort: ['effortValues'], resume: ['resumeFlag'], models: ['modelsCommand'] };
  const srcFor = (uiKey) => {
    if (uiKey in raw) return normSrc(raw[uiKey]);
    const hit = (aliases[uiKey] || []).find((a) => a in raw);
    return normSrc(hit ? raw[hit] : inf[uiKey]);
  };
  const out = {};
  for (const k of ['label', 'bin', 'models', 'defaultModel', 'effort', 'variants', 'resume']) out[k] = srcFor(k);
  out.eventMapping = {};
  const emRaw = raw.eventMapping;
  if (typeof emRaw === 'string' || (emRaw && (emRaw.source || emRaw.confidence))) {
    // single provenance for the whole mapping — the backend derives it in one probe/agent pass
    for (const k of Object.keys(p.eventMapping || {})) out.eventMapping[k] = normSrc(emRaw);
  } else {
    for (const [ek, ev] of Object.entries(emRaw || {})) out.eventMapping[ek] = normSrc(ev);
    for (const [k, v] of Object.entries(inf.eventMapping)) if (!out.eventMapping[k]) out.eventMapping[k] = normSrc(v);
  }
  if (!Object.keys(out.eventMapping).length) out.eventMapping = Object.fromEntries(Object.entries(inf.eventMapping).map(([k, v]) => [k, normSrc(v)]));
  return out;
}
async function introspectRuntime(bin) {
  let profile = null, sources = null;
  try {
    const real = await call('introspectRuntime', bin);
    if (real) { profile = real.profile || real; sources = real.sources; }
  } catch {} // no backend handler yet (or it failed) -> fall back to a client-side stub
  if (!profile) {
    const name = String(bin).split(/[\\/]/).pop().replace(/\.(exe|sh)$/i, '');
    profile = {
      bin, stub: true, label: name.charAt(0).toUpperCase() + name.slice(1), version: null,
      models: ['default'], defaultModel: 'default',
      effort: ['low', 'medium', 'high'], variants: [],
      resume: false,
      eventMapping: { text: 'text', tool: 'tool', tool_result: 'tool_result', error: 'error', result: 'result', system: 'system' },
    };
  }
  return { ...profile, bin: profile.bin || bin, stub: !!profile.stub, sources: draftSources(profile, sources) };
}
function renderRuntimesSection() {
  const list = loadCustomRuntimes();
  const rows = list.map((r) => `<tr><td>${esc(r.label)}${r.stub ? ' <span class="costnote" title="Introspection stub — no live CLI probe yet">stub</span>' : ''}</td><td><code>${esc(r.bin)}</code></td><td>${esc(r.version || '?')}</td><td>${esc(r.models.join(', '))}</td><td>${r.resume ? '✓' : '✗'}</td><td><button data-editrt="${esc(r.id)}">Edit</button><button data-delrt="${esc(r.id)}">Delete</button></td></tr>`).join('');
  return `<h3>Runtimes</h3><p class="muted">Add a runtime by its binary path, review the detected (or stubbed) profile, then assign it to an agent node from the Team tab.</p>
    <table id="runtimetable"><tr><th>Label</th><th>Binary</th><th>Version</th><th>Models</th><th>Resume</th><th></th></tr>${rows || '<tr><td colspan="6" class="muted">No custom runtimes yet.</td></tr>'}</table>
    <div class="toolbar"><input id="rt-path" placeholder="/usr/local/bin/my-agent-cli" style="flex:1"><button id="rt-detect">Detect</button></div>
    <div id="rt-draft"></div>`;
}
let rtDraft = null; // in-progress add/edit draft profile, or null
// Provenance badge for one draft field (or one eventMapping sub-key via `sub`); low-confidence fields
// get a "· verify" hint and an amber row. After the user edits a field the badge flips to "edited"
// while the title keeps the original derivation.
function srcBadge(key, sub) {
  const map = rtDraft.sources || {};
  const s = normSrc(sub ? (map.eventMapping || {})[sub] : map[key]);
  const low = s.confidence === 'low';
  const title = `${SRC_META[s.source].title}${s.note ? ' — ' + s.note : ''}${low ? ' · low confidence — please verify' : ''}`;
  return `<span class="srcbadge src-${s.source}${low ? ' srclow' : ''}" data-srckey="${esc(key)}" data-srcsub="${esc(sub || '')}" data-srctitle="${esc(SRC_META[s.source].title)}" title="${esc(title)}">${SRC_META[s.source].label}${low ? ' · verify' : ''}</span>`;
}
// Composite badge for the eventMapping textarea: "probe" when the probe run confirmed anything,
// "fallback · verify" when every path is a default guess.
function emBadge() {
  const em = (rtDraft.sources || {}).eventMapping || {};
  const vals = Object.values(em).map(normSrc);
  const has = (s) => vals.some((v) => v.source === s);
  const src = has('probe') ? 'probe' : has('agent') ? 'agent' : 'fallback';
  const low = src !== 'probe';
  const defaults = Object.keys(em).filter((k) => normSrc(em[k]).source !== 'probe');
  const note = has('probe') ? `paths confirmed by the probe run${defaults.length ? ' · defaults kept for: ' + defaults.join(', ') : ''}` : vals.length ? SRC_META[src].title : 'no probe data — all paths are defaults';
  return `<span class="srcbadge src-${src}${low ? ' srclow' : ''}" data-srckey="eventMapping" data-srctitle="${esc(SRC_META[src].title)}" title="${esc(note + (low ? ' · low confidence — please verify' : ''))}">${SRC_META[src].label}${low ? ' · verify' : ''}</span>`;
}
function draftFieldsHtml(d) {
  const isLow = (key) => normSrc((rtDraft.sources || {})[key]).confidence === 'low';
  const f = (label, inner, key) => `<div class="rt-field${isLow(key) ? ' lowconf' : ''}"><label>${label} ${srcBadge(key)}</label>${inner}</div>`;
  const emLow = !Object.values((rtDraft.sources || {}).eventMapping || {}).some((s) => normSrc(s).source === 'probe');
  return `<fieldset><legend>${d.editingId ? 'Edit' : 'Review'} runtime profile${d.stub ? ' <span class="costnote">(stub — no live CLI response; edit before saving)</span>' : ''}
    <span class="muted">source: <b>help</b> = --help · <b>probe</b> = live run · <b>agent</b> = self-reported · <b>fallback</b> = guess</span></legend>
    ${f('Label', `<input id="rd-label" value="${esc(d.label)}">`, 'label')}
    ${f('Binary path', `<input id="rd-bin" value="${esc(d.bin)}">`, 'bin')}
    ${f('Models (comma-separated)', `<input id="rd-models" value="${esc(d.models.join(', '))}">`, 'models')}
    ${f('Default model', `<input id="rd-defmodel" value="${esc(d.defaultModel || '')}">`, 'defaultModel')}
    ${f('Effort levels (comma-separated)', `<input id="rd-effort" value="${esc((d.effort || []).join(', '))}">`, 'effort')}
    ${f('Variants (comma-separated, optional)', `<input id="rd-variants" value="${esc((d.variants || []).join(', '))}">`, 'variants')}
    <div class="rt-field"><label class="inline"><input type="checkbox" id="rd-resume" ${d.resume ? 'checked' : ''}> Supports resume/continue session ${srcBadge('resume')}</label></div>
    <div class="rt-field${emLow ? ' lowconf' : ''}"><label>Event mapping <span class="muted">(stream kind: label, one per line)</span> ${emBadge()}</label><textarea id="rd-eventmap" rows="4">${esc(Object.entries(d.eventMapping || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}</textarea></div>
    <div id="rd-error" role="alert"></div>
    <p><button id="rd-save" class="primary">Save runtime</button> <button id="rd-cancel">Cancel</button></p>
  </fieldset>`;
}
// Flip a field's badge to "edited" (keeping the original derivation in the tooltip + draft.sources).
function markEdited(key, sub) {
  const map = rtDraft.sources || (rtDraft.sources = {});
  const prev = sub ? (map.eventMapping || {})[sub] : map[key];
  const orig = normSrc(prev);
  if (orig.source === 'edited') return;
  const rec = { source: 'edited', confidence: 'high', note: `was ${SRC_META[orig.source].title}` };
  if (sub) { map.eventMapping = map.eventMapping || {}; map.eventMapping[sub] = rec; } else map[key] = rec;
  document.querySelectorAll(`.srcbadge[data-srckey="${key}"]`).forEach((b) => {
    b.className = 'srcbadge src-edited'; // the human has now confirmed the value — no more low-confidence warn
    b.textContent = 'edited';
    b.title = `manually edited — ${b.dataset.srctitle || 'originally derived'}`;
  });
}
function draftErrors(p, mapLines) {
  const errs = [];
  if (!p.label) errs.push('Label is required.');
  if (!p.bin) errs.push('Binary path is required.');
  if (!p.models.length) errs.push('At least one model is required — the CLI reported none, so add one.');
  if (p.defaultModel && !p.models.includes(p.defaultModel)) errs.push(`Default model "${p.defaultModel}" is not in the model list.`);
  if (mapLines.bad.length) errs.push(`Event mapping: ${mapLines.bad.length} line(s) without "kind: label" were dropped — fix or remove them.`);
  return errs;
}
function wireDraftForm() {
  const box = $('#rt-draft'); if (!rtDraft) { box.innerHTML = ''; return; }
  box.innerHTML = draftFieldsHtml(rtDraft);
  for (const [id, key] of [['rd-label', 'label'], ['rd-bin', 'bin'], ['rd-models', 'models'], ['rd-defmodel', 'defaultModel'], ['rd-effort', 'effort'], ['rd-variants', 'variants']]) {
    const el = document.getElementById(id); if (el) el.addEventListener('input', () => markEdited(key));
  }
  $('#rd-resume').addEventListener('change', () => markEdited('resume'));
  $('#rd-eventmap').addEventListener('input', () => markEdited('eventMapping'));
  $('#rd-save').onclick = () => {
    const mapLines = $('#rd-eventmap').value.split('\n').map((l) => l.split(':').map((s) => s.trim())).reduce((a, kv) => { (kv[0] && kv[1] ? a.good : a.bad).push(kv); return a; }, { good: [], bad: [] });
    const profile = {
      id: rtDraft.editingId || customRuntimeId($('#rd-bin').value.trim() || rtDraft.bin),
      label: $('#rd-label').value.trim() || rtDraft.label, bin: $('#rd-bin').value.trim() || rtDraft.bin, version: rtDraft.version,
      models: $('#rd-models').value.split(',').map((s) => s.trim()).filter(Boolean), defaultModel: $('#rd-defmodel').value.trim(),
      effort: $('#rd-effort').value.split(',').map((s) => s.trim()).filter(Boolean), variants: $('#rd-variants').value.split(',').map((s) => s.trim()).filter(Boolean),
      resume: $('#rd-resume').checked, eventMapping: Object.fromEntries(mapLines.good), stub: !!rtDraft.stub,
      sources: rtDraft.sources,
    };
    const errs = draftErrors(profile, mapLines);
    for (const [id, bad] of [['rd-label', !profile.label], ['rd-bin', !profile.bin], ['rd-models', !profile.models.length], ['rd-defmodel', !!profile.defaultModel && !profile.models.includes(profile.defaultModel)], ['rd-eventmap', !!mapLines.bad.length]]) document.getElementById(id).classList.toggle('invalid', bad);
    $('#rd-error').textContent = errs.join('\n');
    if (errs.length) return; // block save on an invalid profile; errors are shown inline above
    const list = loadCustomRuntimes().filter((r) => r.id !== profile.id);
    list.push(profile); saveCustomRuntimes(list); rtDraft = null; refresh();
  };
  $('#rd-cancel').onclick = () => { rtDraft = null; renderSettings(); };
}
function wireRuntimesSection() {
  $('#rt-detect').onclick = act(async () => {
    const bin = $('#rt-path').value.trim(); if (!bin) return;
    const profile = await introspectRuntime(bin); rtDraft = profile; wireDraftForm();
  });
  document.querySelectorAll('[data-editrt]').forEach((b) => b.onclick = () => { const r = findCustomRuntime(b.dataset.editrt); rtDraft = { ...r, editingId: r.id, sources: draftSources(r, r.sources) }; wireDraftForm(); });
  document.querySelectorAll('[data-delrt]').forEach((b) => b.onclick = act(async () => { saveCustomRuntimes(loadCustomRuntimes().filter((r) => r.id !== b.dataset.delrt)); refresh(); }));
}

// ---------- discovered capabilities (modes/skills/commands/MCP): collapsible groups, search, per-agent toggles ----------
const CAPS_LOADING = new Set();
let capsSearch = '';
// Groups shown in this fixed order: Modes first, then Skills, Commands, MCP.
function capsGroups(n) {
  const c = n.capabilities || {};
  // Modes come from the categorized 'mode' entries (goal/loop/workflow run modes detected from --help/init
  // event), not the raw c.modes field, which holds CLI permission_modes (default/plan/acceptEdits) or is empty.
  const modes = [...new Set((c.categorized || []).filter((x) => x.category === 'mode').map((x) => x.name))];
  return [
    { key: 'modes', label: 'Modes', items: modes },
    { key: 'skills', label: 'Skills', items: c.skills || [] },
    { key: 'commands', label: 'Commands', items: [...new Set([...(c.slashCommands || []), ...(c.commands || [])])] },
    { key: 'mcp', label: 'MCP', items: ['board', ...(n.allowedTools || []).filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__board')).map((t) => t.slice(5).split('__')[0])].filter((v, i, a) => a.indexOf(v) === i) },
  ];
}
function capsView(n) {
  if (CAPS_LOADING.has(n.id)) return 'Discovering…';
  const c = n.capabilities;
  if (!c) return `Not probed yet. Click Refresh to ask the runtime (${esc(n.runtime || 'claude')}) what it supports.`;
  if (c.error || c.ok === false) return `Could not discover capabilities: ${esc(c.error || 'unknown error')}`;
  const disabled = n.disabledCaps || {};
  const q = capsSearch.trim().toLowerCase();
  const groups = capsGroups(n);
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  const body = groups.map((g) => {
    const offSet = new Set(disabled[g.key] || []);
    const items = q ? g.items.filter((x) => x.toLowerCase().includes(q)) : g.items;
    if (q && !items.length) return '';
    const rows = items.length ? items.map((x) => `<label class="cap-row"><input type="checkbox" data-capgroup="${g.key}" value="${esc(x)}" ${offSet.has(x) ? '' : 'checked'}> <code>${esc(x)}</code></label>`).join('') :
      '<div class="muted">none found</div>';
    return `<details class="cap-group" ${g.key === 'modes' || q ? 'open' : ''}><summary>${g.label} <span class="muted">(${items.length}${q ? '/' + g.items.length : ''})</span></summary><div class="cap-items">${rows}</div></details>`;
  }).join('');
  return `<div class="cap-search"><input type="search" id="nf-caps-search" placeholder="Search ${total} capabilities…" value="${esc(capsSearch)}"></div>` +
    (total ? body || '<div class="muted">No capabilities match your search.</div>' : '<div class="muted">none found</div>') +
    (n.capabilitiesProbedAt ? `<small class="muted">probed ${new Date(n.capabilitiesProbedAt).toLocaleString()}</small>` : '');
}
function wireCapsView(n) {
  const search = $('#nf-caps-search');
  if (search) search.oninput = () => { capsSearch = search.value; $('#nf-caps-view').innerHTML = capsView(n); wireCapsView(n); };
  document.querySelectorAll('#nf-caps-view input[data-capgroup]').forEach((cb) => cb.onchange = async () => {
    const g = cb.dataset.capgroup; const d = { ...(n.disabledCaps || {}) }; const set = new Set(d[g] || []);
    if (cb.checked) set.delete(cb.value); else set.add(cb.value);
    d[g] = [...set]; n.disabledCaps = d;
    await call('updateNode', n.id, { disabledCaps: d });
  });
}
async function refreshCaps(n) {
  CAPS_LOADING.add(n.id); $('#nf-caps-view').innerHTML = capsView(n);
  try { n.capabilities = await call('discoverCapabilities', n.id); n.capabilitiesProbedAt = Date.now(); }
  catch (e) { n.capabilities = { error: e.message || 'not supported by this runtime yet' }; }
  CAPS_LOADING.delete(n.id);
  if (sel.node === n.id) { $('#nf-caps-view').innerHTML = capsView(n); wireCapsView(n); }
}

// ---------- projects & teams sidebar ----------
// The sidebar re-renders on every refresh (every 2s during a run, plus debounced state pushes).
// Per-item onclick bindings died with each rebuild, so a click straddling a rebuild was swallowed.
// Handlers are therefore delegated to the static list containers, and a render whose inputs did not
// change leaves the DOM — and any in-flight click — untouched.
$('#projectlist').onclick = (e) => { const d = e.target.closest('[data-pid]'); if (d) switchTo({ p: d.dataset.pid }); };
$('#teamlist').onclick = (e) => { const d = e.target.closest('[data-tid]'); if (d) switchTo({ p: ctx.p, t: d.dataset.tid }); };
let sidebarSig = null;
function renderSidebar() {
  const teams = (S.project && S.project.teams) || [];
  const sig = JSON.stringify([P.projects.map((p) => [p.id, p.name, !!p.running]), teams.map((t) => [t.id, t.name]), ctx.p, ctx.t]);
  if (sig === sidebarSig) return;
  sidebarSig = sig;
  $('#projectlist').innerHTML = P.projects.map((p) => `<div data-pid="${p.id}" class="${p.id === ctx.p ? 'sel' : ''}">${esc(p.name)}${p.running ? '<span class="dot" title="running"></span>' : ''}</div>`).join('');
  $('#teamlist').innerHTML = teams.map((t) => `<div data-tid="${t.id}" class="${t.id === ctx.t ? 'sel' : ''}">${esc(t.name)}</div>`).join('');
  const ts = $('#tpl-select'); const cur = ts.value;
  ts.innerHTML = Object.entries(P.templates).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''); if (cur) ts.value = cur;
}
function switchTo(c) {
  if (c.p !== ctx.p) { sel = { node: null, edge: null, task: null, page: null, logTeam: '' }; wikiEdit = false; $('#wk-title').value = ''; $('#wk-content').value = ''; }
  else sel = { ...sel, node: null, edge: null };
  connectFrom = null; connectMode = false; $('#connect').classList.remove('on');
  ctx = c;
  // A team click must always land visually: drop the cached version's team signatures so the refresh
  // below cannot short-circuit as "nothing changed" (sigs are size:mtime — two teams can share one)
  // and skip the re-render that moves the selection (t_93ffac88).
  if (lastV && c.t) { delete lastV.team; delete lastV.teams; }
  // The sidebar selection drives every team-scoped tab: sync the Logs tab's own team filter so
  // switching teams here is visible there too (the dropdown can still narrow it afterwards).
  if (c.t && sel.logTeam !== c.t) { sel.logTeam = c.t; $('#logfilter').value = ''; }
  // refresh() mutates ctx (ctx.t = s.teamId) and ctx IS c, so the "was this a project switch?"
  // intent must be captured before the await — c.t is unreliable by the time the .then runs.
  const projectSwitch = !c.t;
  refresh().then(() => {
    if (projectSwitch && sel.logTeam !== (ctx.t || '')) { sel.logTeam = ctx.t || ''; $('#logfilter').value = ''; } // follow the auto-picked team
    renderObs(); renderLog();
  });
}
// Electron has no window.prompt, so use a small <dialog>.
function ask(title, value = '') {
  return new Promise((resolve) => {
    const d = $('#askdlg'); $('#ask-title').textContent = title; $('#ask-input').value = value;
    d.onclose = () => resolve(d.returnValue === 'ok' ? $('#ask-input').value.trim() : null);
    d.returnValue = ''; d.showModal(); $('#ask-input').select();
  });
}
const act = (fn) => async (ev) => { try { await fn(ev); } catch (e) { alert(String(e.message || e).replace(/^Error invoking remote method 'api': (Error: )?/, '')); } };
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
  // Hidden heavy sections skip rendering (t_9315f18a); a freshly shown one must draw once even
  // if nothing changed since it was last hidden. renderLog is not part of renderAll — call it here.
  if (b.dataset.tab === 'board') boardSig = null; else if (b.dataset.tab === 'obs') { logSig = null; obsSig = null; } else if (b.dataset.tab === 'usage') usageSig = null;
  renderAll();
  if (b.dataset.tab === 'obs') renderLog();
});

// ---------- header ----------
function renderHeader() {
  const o = S.orch; const par = o.running ? runningIds().length : 0;
  $('#runstate').textContent = o.running ? `running · ${par > 1 ? `${par} in parallel` : `${par || 1} agent`} · ${o.runs || 0} runs` : 'idle';
  $('#runstate').classList.toggle('on', !!o.running);
  // Money pill: the app's single cost total — API-eq over ALL recorded runs, the same per-run ledger
  // sum the Usage tab's grand total shows, so pill and tab can never disagree (t_b1115e48). The
  // billed vs subscription split stays in the tooltip: subscription usage is covered by the plan,
  // not billed per token, but its API-eq is part of the total for comparability across accounts.
  let billed = 0, sub = 0, total = 0;
  if (RUNS.length) {
    for (const r of RUNS) { const isSub = (r.billingSource || 'auto') === 'subscription';
      for (const e of runLedger(r)) { const rc = e.costUsd || 0; total += rc; if (isSub) sub += rc; else billed += rc; } }
  } else { billed = o.billedCost || 0; sub = o.subCost || 0; total = billed + sub; }
  const c = $('#totalcost');
  c.textContent = total > 0 ? `API-eq $${total.toFixed(2)}` : 'no cost yet';
  // An empty placeholder pill is dead weight in an already tight header — hide it until it has
  // something to say (the meter chips need every pixel at 1400px).
  c.classList.toggle('hidden', !(total > 0));
  c.classList.toggle('quiet', !(billed > 0));
  c.title = total > 0
    ? `API-eq (API-equivalent) $${total.toFixed(4)} — what all recorded usage would cost at API list prices; the same single total the Usage tab's grand total shows. Actually billed per token (API key / proxy / cloud): $${billed.toFixed(4)}. Covered by subscription, not billed per token: $${sub.toFixed(4)}. "est" marks list-price estimates for keys that report no cost themselves.`
    : 'No recorded usage yet.';
}
// ---------- top-bar limits meter (subscription 5h/weekly windows; no $ shown, just % + reset countdown) ----------
const fmtCountdown = (ms) => {
  if (ms <= 0) return 'now';
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  if (totalMin >= 24 * 60) { const d = Math.floor(totalMin / (24 * 60)), h = Math.floor((totalMin % (24 * 60)) / 60); return `${d}d ${h}h`; }
  const h = Math.floor(totalMin / 60), m = totalMin % 60; return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
function resetIn(u) { return u && u.resetsAt ? Math.max(0, new Date(u.resetsAt).getTime() - Date.now()) : 0; }
// Why the meter has no real 5h/weekly % yet — a per-node reason (not installed / non-subscription billing /
// no usage reported) beats a generic "–" with the explanation hidden behind a hover title only.
async function noLimitDataReason() {
  const node = S.team.nodes[0];
  if (!node) return 'no agent configured yet';
  try { const pu = await call('providerUsage', node.id); if (pu && pu.reason) return pu.reason; } catch {}
  return 'no usage reported yet by the CLI (run this agent once to get real usage)';
}
// Per-provider usage chips (provider-keyed model in usageStatus): one compact pill per provider the
// team actually uses, labeled by that provider — no vendor's wording unless that vendor is in use.
// A provider whose CLI reports no usage windows gets an honest "limits unknown" (never a fabricated
// 0%), and while runs are live, providers whose members are all idle render dimmed. Until usageStatus
// carries a providers list, the classic 5h/weekly meter below renders instead.
// Backstop (t_c2ca9fe9): entries with a missing or "unknown" provider, entries with nothing real to
// show, and same-provider duplicates never render. Source-side attribution is usageProviders (src/usage.js).
const prettyProvider = (id) => id.charAt(0).toUpperCase() + id.slice(1);
// "weekly" is the only label too wide for a two-provider header — abbreviate on display only;
// tooltips and titles keep the full label.
const shortWindowLabel = (l) => (l === 'weekly' ? 'wk' : l);
function normProviderWindow(w) {
  if (!w || typeof w !== 'object') return null;
  let pct = w.pct != null ? Number(w.pct) : (Number(w.limit) > 0 && w.used != null ? Number(w.used) / Number(w.limit) : null);
  if (pct != null && (!Number.isFinite(pct) || pct < 0)) pct = null;
  else if (pct > 1) pct /= 100; // some windows report 0-100 instead of 0-1
  return { label: String(w.label || '?'), pct, resetsAt: w.resetAt || w.resetsAt || null, warn: !!w.warn, pause: !!w.pause };
}
function normProviderEntry(e) {
  if (!e || typeof e !== 'object') return null;
  // A chip must name a real provider: drop entries with no provider/id and "unknown" placeholders
  // (a runtime-less node or unstamped run groups under a literal "unknown" — rendering that chip
  // misattributes whatever numbers it carries). Also drop entries with nothing real to show.
  const provider = String(e.provider != null ? e.provider : (e.id != null ? e.id : '')).trim();
  if (!provider || provider.toLowerCase() === 'unknown') return null;
  const windows = (Array.isArray(e.windows) ? e.windows : []).map(normProviderWindow).filter(Boolean);
  const plan = e.plan && String(e.plan).toLowerCase() !== 'unknown' ? String(e.plan) : null;
  const reason = e.reason ? String(e.reason) : null;
  if (!windows.some((w) => w.pct != null) && !plan && !reason) return null;
  return {
    provider,
    plan,
    unknown: !windows.some((w) => w.pct != null) || e.status === 'unknown',
    reason,
    windows,
    warn: windows.some((w) => w.warn),
    pause: windows.some((w) => w.pause),
  };
}
function providerIsIdle(p) {
  const nodes = S.team.nodes.filter((n) => { const rt = String(n.runtime || '').toLowerCase(); return rt === p.provider || rt.includes(p.provider); });
  return runningIds().length > 0 && nodes.length > 0 && nodes.every((n) => presence(n.id) === 'idle');
}
function providerChipHtml(p, idle) {
  const head = `<b>${esc(prettyProvider(p.provider))}</b>${p.plan ? ` <small class="lm-plan">${esc(p.plan)}</small>` : ''}`;
  if (p.unknown) {
    const why = p.reason || 'the provider CLI reports no usage windows';
    return `<span class="lm-part lm-chip lm-unknown${idle ? ' lm-idle' : ''}" data-provider="${esc(p.provider)}" title="${esc(prettyProvider(p.provider))}${p.plan ? ` · ${esc(p.plan)}` : ''} — limits unknown: ${esc(why)}">${head} <small>· limits unknown</small></span>`;
  }
  const cls = p.pause ? 'lm-danger' : p.warn ? 'lm-warn' : 'lm-ok';
  // Space rule: only the first window carries the inline bar + reset countdown; further windows are
  // label + % (their reset lives in the chip's title). Two fully-dressed windows cannot share the
  // header with a second provider chip at 1400px — that squeeze is what garbled the chips before.
  const win = (w, full) => {
    const pct = Math.min(100, Math.round(w.pct * 100)); const ms = resetIn(w);
    const resetTitle = ms > 0 ? ` · resets in ${fmtCountdown(ms)}` : '';
    const resetChip = full && ms > 0 ? `<small>↻${fmtCountdown(ms)}</small>` : '';
    const bar = full ? `<i class="lm-bar"><i class="lm-fill" style="width:${pct}%"></i></i>` : '';
    return `<span class="lm-win" title="${esc(w.label)}: ${pct}% used${resetTitle}"><b>${esc(shortWindowLabel(w.label))}</b> ${pct}%${bar}${resetChip}</span>`;
  };
  const full = p.windows.filter((w) => w.pct != null);
  const all = full.map((w) => `${w.label}: ${Math.min(100, Math.round(w.pct * 100))}% used${resetIn(w) > 0 ? ` · resets in ${fmtCountdown(resetIn(w))}` : ''}`).join(' · ');
  return `<span class="lm-part lm-chip ${cls}${idle ? ' lm-idle' : ''}" data-provider="${esc(p.provider)}" title="${esc(prettyProvider(p.provider))}${p.plan ? ` · ${esc(p.plan)}` : ''} — ${esc(all)}">${head} ${full.map((w, i) => win(w, i === 0)).join('')}</span>`;
}
// Normalized + deduped provider list from usageStatus (array or object form) — shared by the
// top-bar summary chip and the Usage tab's full per-provider list.
function limitProviders(st) {
  const rawProvs = st && st.providers ? (Array.isArray(st.providers) ? st.providers : Object.entries(st.providers).map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? { provider: k, ...v } : { provider: k }))) : null;
  const provs = rawProvs ? rawProvs.map(normProviderEntry).filter(Boolean) : [];
  // Never render the same provider twice (case-insensitive): keep the first entry that carries a
  // real % window, else the first.
  const hasRealPct = (p) => p.windows.some((w) => w.pct != null);
  const uniq = [];
  for (const p of provs) {
    const i = uniq.findIndex((q) => q.provider.toLowerCase() === p.provider.toLowerCase());
    if (i < 0) uniq.push(p);
    else if (!hasRealPct(uniq[i]) && hasRealPct(p)) uniq[i] = p;
  }
  return uniq;
}
async function renderLimitMeter() {
  let st; try { st = await call('usageStatus'); } catch { st = null; }
  const m = $('#limitmeter');
  m.title = 'Usage limits — one summary chip for the worst provider/window; click for the full per-provider detail in the Usage tab';
  m.onclick = () => showTab('usage');
  // The summary chip: provider name + the worst window's number (the tiny bar and reset countdown of
  // exactly that window); the full per-window detail stays in the tooltip and the Usage tab.
  const worstChip = (p) => {
    const head = `Limits: <b>${esc(prettyProvider(p.provider))}</b>${p.plan ? ` <small class="lm-plan">${esc(p.plan)}</small>` : ''}`;
    const idle = providerIsIdle(p) ? ' lm-idle' : '';
    const real = p.windows.filter((w) => w.pct != null);
    if (!real.length) { // nothing real to show: one honest chip, never a fabricated 0%
      const why = p.reason || 'the provider CLI reports no usage windows';
      return `<span class="lm-part lm-chip lm-unknown${idle}" data-provider="${esc(p.provider)}" title="${esc(prettyProvider(p.provider))}${p.plan ? ` · ${esc(p.plan)}` : ''} — limits unknown: ${esc(why)}">${head} <small>· limits unknown</small></span>`;
    }
    const w = real.slice().sort((a, b) => b.pct - a.pct)[0];
    const pct = Math.min(100, Math.round(w.pct * 100));
    const cls = p.pause ? 'lm-danger' : p.warn ? 'lm-warn' : 'lm-ok';
    const all = p.windows.map((x) => `${x.label}: ${x.pct != null ? `${Math.min(100, Math.round(x.pct * 100))}% used` : 'no data'}${resetIn(x) > 0 ? ` · resets in ${fmtCountdown(resetIn(x))}` : ''}`).join(' · ');
    const ms = resetIn(w);
    // The paused/near-limit flag lives INSIDE the chip: its word replaces the % text, so the meter
    // never grows an extra element when the state changes — the exact % stays in the bar and tooltip.
    const state = p.pause ? 'paused' : p.warn ? 'near limit' : `${pct}%`;
    return `<span class="lm-part lm-chip ${cls}${idle}" data-provider="${esc(p.provider)}" title="${esc(prettyProvider(p.provider))}${p.plan ? ` · ${esc(p.plan)}` : ''} — ${esc(all)}">${head} ${state}<i class="lm-bar"><i class="lm-fill" style="width:${pct}%"></i></i>${ms > 0 ? `<small>↻${fmtCountdown(ms)}</small>` : ''}</span>`;
  };
  const provs = limitProviders(st);
  if (provs.length) {
    // The one provider the fixed-size summary chip names: paused > near limit > carries a real %
    // window > silent, ties broken by the highest single-window %.
    const rank = (p) => (p.pause ? 3 : p.warn ? 2 : p.windows.some((w) => w.pct != null) ? 1 : 0);
    const maxPct = (p) => Math.max(-1, ...p.windows.map((w) => (w.pct != null ? w.pct : -1)));
    const worst = provs.slice().sort((a, b) => rank(b) - rank(a) || maxPct(b) - maxPct(a))[0];
    m.classList.remove('hidden');
    m.innerHTML = worstChip(worst);
    return;
  }
  const isSubscriptionUser = S.team.nodes.some((n) => (n.billingMode || 'auto') !== 'api' && (n.billingMode || 'auto') !== 'proxy');
  if (!st || (!st.fiveHour.limit && !st.weekly.limit)) {
    if (!isSubscriptionUser) { m.classList.add('hidden'); m.innerHTML = ''; return; }
    m.classList.remove('hidden');
    const reason = await noLimitDataReason();
    const why = `Subscription 5h/weekly usage appears here once the CLI reports it (after a run) or a limit is set in Usage &amp; limits. (${esc(reason)})`;
    m.innerHTML = `<span class="lm-part lm-pending" title="${why}"><b>Limits</b> <small>– no limit data: ${esc(reason)}</small></span>`;
    return;
  }
  m.classList.remove('hidden');
  const wins = ['5h', 'weekly'].map((label) => { const u = st[label === '5h' ? 'fiveHour' : 'weekly']; return u && u.limit ? { label, pct: Math.min(1, u.pct != null ? u.pct : u.used / u.limit), warn: !!u.warn, pause: !!u.pause, resetsAt: u.resetsAt } : { label, pct: null, warn: false, pause: false, resetsAt: u && u.resetsAt }; });
  const worst = wins.filter((w) => w.pct != null).sort((a, b) => (b.pause - a.pause) || (b.warn - a.warn) || (b.pct - a.pct))[0];
  const pct = Math.min(100, Math.round(worst.pct * 100));
  const cls = worst.pause ? 'danger' : worst.warn ? 'warn' : 'ok';
  const pctR = (w) => Math.min(100, Math.round(w.pct * 100));
  const title = wins.map((w) => w.pct != null ? `${w.label}: ${pctR(w)}% used${resetIn(w) > 0 ? ` · resets in ${fmtCountdown(resetIn(w))}` : ''}` : `${w.label}: no limit set`).join(' · ');
  const ms = resetIn(worst);
  // Same in-chip flag as the provider path: the state word replaces the % text, exact numbers stay
  // in the bar and the tooltip.
  const state = worst.pause ? 'paused' : worst.warn ? 'near limit' : `${pct}%`;
  m.innerHTML = `<span class="lm-part lm-${cls}" title="${esc(title)}">Limits: ${state} <b>${esc(worst.label)}</b><i class="lm-bar"><i class="lm-fill" style="width:${pct}%"></i></i>${ms > 0 ? `<small>↻${fmtCountdown(ms)}</small>` : ''}</span>`;
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

// ---------- team graph (design-tool editor: pan/zoom, drag-to-connect, minimap, auto-layout, context menu) ----------
const W = 184, H = 80, SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
let VP = { x: 20, y: 20, zoom: 1 }, vpTeam = null, vpSave = null, lastEdgeType = 'assign', linkDrag = null;
const agentColor = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 8) + 1; };
const edgeSeed = (e) => { let h = 0; for (const c of String(e.id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const initials = (s) => String(s || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const nodeLive = (n) => ((S.nstat || {})[n.id] || {}).status || ((S.orch.agents[n.id] || {}).status === 'working' ? 'working' : 'idle');
const applyVP = () => { const v = $('#graph > g.viewport'); if (v) v.setAttribute('transform', `translate(${VP.x},${VP.y}) scale(${VP.zoom})`); const gs = $('#graph'); if (gs) { gs.classList.toggle('lod-far', VP.zoom < 0.6); gs.style.setProperty('--nz', Math.max(1, 11 / (13 * VP.zoom)).toFixed(3)); } renderMinimap(); $('#zoomlvl') && ($('#zoomlvl').textContent = Math.round(VP.zoom * 100) + '%'); };
const saveVP = () => { clearTimeout(vpSave); vpSave = setTimeout(() => call('setViewport', VP).catch(() => {}), 400); };
const toWorld = (cx, cy) => { const r = $('#graph').getBoundingClientRect(); return [(cx - r.left - VP.x) / VP.zoom, (cy - r.top - VP.y) / VP.zoom]; };
function zoomAt(f, cx, cy) {
  const r = $('#graph').getBoundingClientRect(); cx ??= r.left + r.width / 2; cy ??= r.top + r.height / 2;
  const z = Math.min(2.5, Math.max(0.25, VP.zoom * f)); const [wx, wy] = toWorld(cx, cy);
  VP = { zoom: z, x: cx - r.left - wx * z, y: cy - r.top - wy * z }; applyVP(); saveVP();
}
function graphBox(nodes) {
  if (!nodes.length) return { x: 0, y: 0, w: 400, h: 300 };
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y); const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) + W - x, h: Math.max(...ys) + H - y };
}
let vpCount = 0, edgeLayout = null; // per-render edge geometry + DOM refs; patched in place by dragEdges during node drags
function fitIfClipped() { const r = $('#graph').getBoundingClientRect(); const b = graphBox(allGraphNodes()); if (r.width && (b.x * VP.zoom + VP.x < 0 || b.y * VP.zoom + VP.y < 0 || (b.x + b.w) * VP.zoom + VP.x > r.width || (b.y + b.h) * VP.zoom + VP.y > r.height)) fitView(); }
function fitView() {
  const r = $('#graph').getBoundingClientRect(); const b = graphBox(allGraphNodes()); const pad = 48;
  const z = Math.min(1.5, Math.max(0.25, Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h)));
  VP = { zoom: z, x: (r.width - b.w * z) / 2 - b.x * z, y: (r.height - b.h * z) / 2 - b.y * z }; applyVP(); saveVP();
}
// Nodes from other teams linked by cross-team edges, shown as dashed ghosts beside the graph.
function ghostNodes() {
  const mine = new Set(S.team.nodes.map((n) => n.id)); const b = graphBox(S.team.nodes); const out = new Map();
  for (const e of S.team.edges) if (!mine.has(e.to) && !out.has(e.to)) out.set(e.to, { id: e.to, side: 1 });
  for (const e of S.cross || []) if (!mine.has(e.from) && !out.has(e.from)) out.set(e.from, { id: e.from, side: -1 });
  let r = 0, l = 0;
  return [...out.values()].map((g) => ({ ...g, ghost: true, name: nodeName(g.id), role: 'other team', x: g.side > 0 ? b.x + b.w + 120 : b.x - W - 120, y: b.y + (g.side > 0 ? r++ : l++) * (H + 40) }));
}
const allGraphNodes = () => [...S.team.nodes, ...ghostNodes()];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// ---------- orthogonal edge routing ----------
// Edges are elbow (right-angle) paths, never diagonals: a horizontally-dominated pair exits through
// the node sides and turns on a vertical rail between them; vertical pairs are the same transposed.
// No segment may cross a node card: a blocked rail moves to the nearest free corridor, and when no
// corridor exists between the two nodes the edge detours around both rows. `off` fans parallel edges
// apart; `seed` spreads detours across corridors so shared bus segments don't stack.
const segHit = (o, x0, y0, x1, y1) => Math.min(x0, x1) < o.x + o.w && Math.max(x0, x1) > o.x && Math.min(y0, y1) < o.y + o.h && Math.max(y0, y1) > o.y;
const clearH = (obs, y, x0, x1) => !obs.some((o) => segHit(o, x0, y, x1, y));
const clearV = (obs, x, y0, y1) => !obs.some((o) => segHit(o, x, y0, x, y1));
const freeCors = (obs, lo, hi, mid0, clear) => { // centres of free bands (8px sampling), nearest to mid0 first
  const cs = []; let run = null;
  for (let p = Math.ceil(lo / 8) * 8; p <= hi; p += 8) { if (clear(p)) { run = run || [p, p]; run[1] = p; } else if (run) { cs.push((run[0] + run[1]) / 2); run = null; } }
  if (run) cs.push((run[0] + run[1]) / 2);
  return cs.sort((x, y) => Math.abs(x - mid0) - Math.abs(y - mid0));
};
function orthPath(pts, r = 8) { // polyline with rounded corners
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [px, py] = pts[i - 1], [qx, qy] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py) || 1, l2 = Math.hypot(qx - x, qy - y) || 1, rr = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${(x - (x - px) / l1 * rr).toFixed(1)},${(y - (y - py) / l1 * rr).toFixed(1)} Q${x},${y} ${(x + (qx - x) / l2 * rr).toFixed(1)},${(y + (qy - y) / l2 * rr).toFixed(1)}`;
  }
  const [ex, ey] = pts[pts.length - 1]; return d + ` L${ex},${ey}`;
}
function edgeGeom(a, b, off, obs = [], seed = 0) {
  const flip = Math.abs(b.y - a.y) * W >= Math.abs(b.x - a.x) * H; // vertical pair: solve transposed
  const T = (n) => ({ x: n.y, y: n.x }), To = (o) => ({ x: o.y, y: o.x, w: o.h, h: o.w }), P = (p) => (flip ? [p[1], p[0]] : p);
  const A = flip ? T(a) : a, B = flip ? T(b) : b, NW = flip ? H : W, NH = flip ? W : H;
  const covers = (o, n) => o.x <= n.x && o.y <= n.y && o.x + o.w >= n.x + (flip ? H : W) && o.y + o.h >= n.y + (flip ? W : H);
  const OBS = (flip ? obs.map(To) : obs).filter((o) => !covers(o, a) && !covers(o, b)); // endpoints may touch their own cards
  const anchors = () => { // p1 exits a toward b, p2 enters b facing a — direction-aware side anchors
    const sx = Math.sign(B.x - A.x) || 1;
    return { sx, p1: [sx > 0 ? A.x + NW : A.x, A.y + NH / 2 + off * 0.6], p2: [sx > 0 ? B.x : B.x + NW, B.y + NH / 2 + off * 0.6] };
  };
  const solve = () => { // side exits + vertical rail between the nodes
    const { p1, p2 } = anchors();
    if (p1[1] === p2[1] && clearH(OBS, p1[1], p1[0], p2[0])) return { pts: [p1, p2], mid: [(p1[0] + p2[0]) / 2, p1[1]], n: [0, 1] };
    const lo = Math.min(p1[0], p2[0]) + 14, hi = Math.max(p1[0], p2[0]) - 14, rail0 = clamp((p1[0] + p2[0]) / 2 + off, lo, hi);
    const yLo = Math.min(p1[1], p2[1]), yHi = Math.max(p1[1], p2[1]);
    const cands = lo <= hi ? [rail0, ...freeCors(OBS, lo, hi, rail0, (x) => clearV(OBS, x, yLo, yHi))] : [(p1[0] + p2[0]) / 2 + off];
    const z = (rail) => ({ pts: [p1, [rail, p1[1]], [rail, p2[1]], p2], mid: [rail, (p1[1] + p2[1]) / 2], n: [0, 1] });
    for (const rail of cands) if (clearV(OBS, rail, p1[1], p2[1]) && clearH(OBS, p1[1], p1[0], rail) && clearH(OBS, p2[1], rail, p2[0])) return z(rail);
    return null;
  };
  const detour = () => { // 6-point route through the nearest corridor clear of both nodes' bands
    const { sx, p1, p2 } = anchors();
    const x0 = Math.min(p1[0], p2[0]) - 170, x1 = Math.max(p1[0], p2[0]) + 170;
    const y0 = Math.min(A.y, B.y) - 100, y1 = Math.max(A.y + NH, B.y + NH) + 100;
    const cors = freeCors(OBS, y0, y1, (p1[1] + p2[1]) / 2, (y) => clearH(OBS, y, x0, x1));
    if (!cors.length) return null;
    const k0 = cors.length > 1 ? seed % cors.length : 0; const order = cors.slice(k0).concat(cors.slice(0, k0));
      for (const cor of order.slice(0, 4)) {
        const r1s = [], r2s = [];
        for (let k = 12; k <= 156; k += 16) { // legs walk away from the node along the travel direction
          if (clearV(OBS, p1[0] + k * sx, Math.min(p1[1], cor), Math.max(p1[1], cor))) r1s.push(p1[0] + k * sx);
          if (clearV(OBS, p2[0] - k * sx, Math.min(p2[1], cor), Math.max(p2[1], cor))) r2s.push(p2[0] - k * sx);
        }
      for (const r1 of r1s.slice(0, 3)) for (const r2 of r2s.slice(0, 3))
        if ((r2 - r1) * sx > 28 && clearH(OBS, cor, r1, r2))
          return { pts: [p1, [r1, p1[1]], [r1, cor], [r2, cor], [r2, p2[1]], p2], mid: [(r1 + r2) / 2, cor], n: [0, 1] };
    }
    return null;
  };
  const r = solve() || detour();
  if (!r) { const p1 = [A.x + NW, A.y + NH / 2 + off * 0.6], p2 = [B.x, B.y + NH / 2 + off * 0.6], rail = (p1[0] + p2[0]) / 2 + off; return { d: orthPath([p1, [rail, p1[1]], [rail, p2[1]], p2].map(P)), mid: P([rail, (p1[1] + p2[1]) / 2]), n: flip ? [1, 0] : [0, 1] }; }
  return { d: orthPath(r.pts.map(P)), mid: P(r.mid), n: flip ? [r.n[1], r.n[0]] : r.n };
}
const overlaps = (r, q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h;
function renderGraph() {
  const svg = $('#graph'); svg.innerHTML = '';
  if (vpTeam !== ctx.t) { vpTeam = ctx.t; vpCount = 0; VP = { x: 20, y: 20, zoom: 1 }; call('getViewport').then((v) => { if (v && v.zoom) { VP = v; applyVP(); fitIfClipped(); } else if (S.team.nodes.length) fitView(); }).catch(() => {}); }
  const defs = el('defs', {}, svg);
  for (const t of ['assign', 'message', 'review', 'sel']) { const m = el('marker', { id: 'arr-' + t, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, defs); el('path', { d: 'M0,1 L9,5 L0,9 z', class: 'arrow arrow-' + t }, m); }
  const vp = el('g', { class: 'viewport' }, svg); const eL = el('g', { class: 'edges' }, vp), nL = el('g', { class: 'nodes' }, vp), xL = el('g', { class: 'edges cross-layer' }, vp), lL = el('g', { class: 'labels' }, vp); // cross-team edges draw above nodes so the dashed line into the ghost stays visible
  const nodes = allGraphNodes(); const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = [...S.team.edges, ...(S.cross || []).filter((e) => !S.team.edges.some((x) => x.id === e.id))];
  const pairN = {}, pairI = {}; const pk = (e) => [e.from, e.to].sort().join('|'); edges.forEach((e) => { pairN[pk(e)] = (pairN[pk(e)] || 0) + 1; });
  const blocks = nodes.map((n) => ({ x: n.x - 4, y: n.y - 4, w: W + 8, h: H + 8 })); const pills = [];
  edgeLayout = { nodes, blocks, per: [] };
  for (const e of edges) {
    const a = byId[e.from], b = byId[e.to]; if (!a || !b) continue;
    const key = pk(e); const i = (pairI[key] = (pairI[key] ?? -1) + 1); const cnt = pairN[key];
    const sign = e.from < e.to ? 1 : -1; const off = (i - (cnt - 1) / 2) * 22 * sign;
    const type = e.type || 'assign'; const cross = !!(e.crossTeam || a.ghost || b.ghost); const g = edgeGeom(a, b, off, blocks, edgeSeed(e));
    const isSel = sel.edge === e.id;
    const L = cross ? xL : eL; const hit = el('path', { d: g.d, class: 'edgehit' }, L);
    const ep = el('path', { d: g.d, class: `edge edge-${type}` + (cross ? ' cross' : '') + (isSel ? ' sel' : ''), 'marker-end': `url(#arr-${isSel ? 'sel' : type})`, 'data-id': e.id }, L);
    // label pill at the curve midpoint, nudged along the normal until it clears nodes and other pills
    const label = type + (cross ? ' · cross-team' : ''); const pw = 10 + label.length * 5.8, ph = 16;
    let [px, py] = g.mid; for (let s = 0, r = { x: px - pw / 2, y: py - ph / 2, w: pw, h: ph }; s < 12 && [...blocks, ...pills].some((q) => overlaps(r, q)); s++) { const d = (s % 2 ? -1 : 1) * Math.ceil((s + 1) / 2) * 12; px = g.mid[0] + g.n[0] * d; py = g.mid[1] + g.n[1] * d; r = { x: px - pw / 2, y: py - ph / 2, w: pw, h: ph }; }
    pills.push({ x: px - pw / 2, y: py - ph / 2, w: pw, h: ph });
    const pg = el('g', { class: `epill epill-${type}` + (isSel ? ' sel' : ''), transform: `translate(${px - pw / 2},${py - ph / 2})` }, lL);
    el('rect', { width: pw, height: ph, rx: ph / 2 }, pg); el('text', { x: pw / 2, y: 11.5, 'text-anchor': 'middle' }, pg).textContent = label;
    edgeLayout.per.push({ e, a, b, off, geo: g, pw, ph, hit, path: ep, pill: pg });
    const pick = (ev) => { ev.stopPropagation(); hideMenus(); sel = { ...sel, edge: e.id, node: null }; renderGraph(); renderNodeForm(); };
    hit.onclick = pick; pg.onclick = pick; hit.oncontextmenu = pg.oncontextmenu = (ev) => { pick(ev); ev.preventDefault(); edgeMenu(ev, e); };
  }
  for (const n of nodes) {
    if (n.ghost) { const g = el('g', { class: 'ghost', transform: `translate(${n.x},${n.y})` }, nL); el('rect', { width: W, height: H, rx: 12 }, g); el('text', { x: 14, y: 28, class: 'nname' }, g).textContent = clipText(n.name, 22); el('text', { x: 14, y: 46, class: 'nrole' }, g).textContent = 'in another team'; continue; }
    const live = nodeLive(n); const ns = (S.nstat || {})[n.id] || {}; const c = agentColor(n.id);
    const g = el('g', { class: 'node' + (sel.node === n.id || connectFrom === n.id ? ' sel' : '') + ' st-' + live + (live === 'working' ? ' working' : ''), transform: `translate(${n.x},${n.y})`, 'data-id': n.id }, nL);
    el('rect', { class: 'card', width: W, height: H, rx: 12 }, g);
    el('rect', { class: 'stripe', width: 4, height: H - 20, x: 0, y: 10, rx: 2, style: `fill:var(--agent-${c})` }, g);
    el('circle', { class: 'avatar', cx: 30, cy: 26, r: 14, style: `fill:var(--agent-${c})` }, g);
    el('text', { x: 30, y: 30.5, class: 'avtext', 'text-anchor': 'middle' }, g).textContent = initials(n.name);
    el('text', { x: 52, y: 23, class: 'nname' }, g).textContent = clipText(n.name, Math.max(6, Math.round(16 / Math.max(1, 11 / (13 * VP.zoom)))));
    el('text', { x: 52, y: 38, class: 'nrole' }, g).textContent = clipText(n.role, 20);
    const rtId = ns.runtime || n.runtime || 'claude';
    // Chip row wraps to a second line when it would run into the card edge or the subagent badge
    // (row 1 reserves the badge's corner; the badge itself sits in row 1's band, right-aligned).
    const sub = Subagents.badge(S.orch.agents[n.id] || {});
    const sb = sub.count ? subBadgeInfo(sub) : null;
    let cx = 12, cy = 46;
    const putChip = (text, max, cls, title) => { const t = clipText(text, max); const w = 10 + t.length * 5.6; const lim = cy === 46 && sb ? W - sb.w - 12 : W - 10; if (cx + w > lim && cx > 12) { cx = 12; cy = 62; } const cg = el('g', { class: cls, transform: `translate(${cx},${cy})` }, g); if (title) el('title', {}, cg).textContent = title; el('rect', { width: w, height: 14, rx: 7 }, cg); el('text', { x: w / 2, y: 10.5, 'text-anchor': 'middle' }, cg).textContent = t; cx += w + 4; };
    for (const chip of [runtimeLabel(rtId), ns.model || n.model || 'default'].filter(Boolean)) putChip(chip, 14, 'chip');
    if (rtId !== 'claude') { const rows = ((S.orch.ledger || {}).byAgent || {})[n.name] || []; const cost = rows.reduce((c, r) => c + (r.costUsd || 0), 0);
      putChip(rows.length ? `$${cost.toFixed(2)} · ${rows.length} key${rows.length === 1 ? '' : 's'}` : 'no usage', 20, 'chip chip-usage', rows.length ? `${runtimeLabel(rtId)} usage, per model key (tokens are never summed across models): ${rows.map((r) => `${r.model}: ${r.runs} run(s) · ${r.costUsd != null ? '$' + r.costUsd.toFixed(4) + (r.costSource === 'estimated' ? ' est' : '') : 'cost —'}`).join(' · ')}` : `${runtimeLabel(rtId)} has no recorded usage yet`); }
    const effort = n.effort || 'low';
    for (const chip of [`E:${effort}`, n.autoCompact ? `AC:${n.autoCompact}` : null].filter(Boolean)) { const isDefaultEffort = chip === `E:${effort}` && !n.effort; putChip(chip, 14, 'chip chip-em' + (isDefaultEffort ? ' chip-default' : ''), chip.startsWith('E:') ? `Reasoning effort: ${effort}${isDefaultEffort ? ' (default)' : ''}` : `Auto-compact window: ${n.autoCompact}`); }
    if (n.createdBy && !n.core) putChip('recruited', 10, 'chip chip-recruited', 'Recruited by ' + nodeName(n.createdBy));
    const capsSt = !n.capabilities ? 'none' : (n.capabilities.error || n.capabilities.ok === false) ? 'error' : 'ok';
    const cb = el('g', { class: 'capsdot caps-' + capsSt, transform: `translate(7,${H - 8})` }, g); el('circle', { r: 4 }, cb);
    el('title', {}, cb).textContent = capsSt === 'none' ? 'Capabilities not probed yet' : capsSt === 'error' ? 'Capability probe failed' : `Capabilities probed${n.capabilitiesProbedAt ? ' ' + new Date(n.capabilitiesProbedAt).toLocaleString() : ''}`;
    const sg = el('g', { class: 'status s-' + live, transform: `translate(${W - 16},16)` }, g); el('circle', { r: 5 }, sg); el('title', {}, sg).textContent = live;
    const pres = el('g', { class: 'pres ' + presence(n.id), transform: `translate(${W - 16},16)` }, g); el('circle', { r: 8 }, pres);
    const pf = pfState(n); const bw = 8 + PF_LABEL[pf].length * 6;
    const badge = el('g', { class: 'pfbadge pf-' + pf, transform: `translate(${W - bw - 30},-8)` }, g);
    el('title', {}, badge).textContent = pf === 'fail' && n.preflight ? 'Preflight failed: ' + n.preflight.error : 'Preflight: ' + PF_LABEL[pf];
    el('rect', { width: bw, height: 15, rx: 7 }, badge); el('text', { x: bw / 2, y: 11, 'font-size': 9, 'text-anchor': 'middle' }, badge).textContent = PF_LABEL[pf];
    if (n.core) { const cl = el('g', { class: 'corelock', transform: 'translate(10,-8)' }, g); el('title', {}, cl).textContent = 'Core agent — protected; recruits and retires teammates'; el('rect', { width: 46, height: 15, rx: 7 }, cl); el('text', { x: 23, y: 11, 'font-size': 9, 'text-anchor': 'middle' }, cl).textContent = '🔒 core'; }
    if (live === 'working') {
      const ctxPct100 = typeof ns.contextPct === 'number' ? ns.contextPct * 100 : null;
      const pctTxt = typeof ctxPct100 === 'number' ? `${Math.round(Math.max(0, Math.min(100, ctxPct100)))}% ctx` : '— ctx';
      const pctCls = typeof ctxPct100 !== 'number' ? 'unknown' : ctxPct100 >= 85 ? 'danger' : ctxPct100 >= (S.settings.autoCompactPct || 40) ? 'warn' : 'ok';
      const ctxlabel = el('text', { x: W - 24, y: 30, class: 'ctxpct ctx-' + pctCls, 'text-anchor': 'end' }, g); ctxlabel.textContent = pctTxt;
      el('title', {}, ctxlabel).textContent = typeof ctxPct100 === 'number' ? `${fmtTok(ns.contextTokens || 0)} / ${fmtTok(ns.contextWindow || 0)} tokens` : 'Context usage unknown';
    }
    if (ns.compactedAt && Date.now() - ns.compactedAt < 30000) {
      const cbg = el('g', { class: 'compactbadge', transform: `translate(${W / 2 - 44},-8)` }, g);
      el('rect', { width: 88, height: 15, rx: 7 }, cbg); el('text', { x: 44, y: 11, 'font-size': 9, 'text-anchor': 'middle' }, cbg).textContent = 'compacted';
      el('title', {}, cbg).textContent = ns.lastCompact ? `Compacted ${fmtTok(ns.lastCompact.preTokens)}→${fmtTok(ns.lastCompact.postTokens)}` : 'Compacted';
    }
    // wake badge is gated by wakeRun itself, not `live`: nodeLive trusts the possibly stale nstat status
    // stall badge outranks it: a stalled run must not read as one still working
    const st = stallState(n.id);
    if (st) drawStallBadge(g, st, () => openWakeTask(st.taskId));
    else { const wk = wakeRun(n.id); if (wk) drawWakeBadge(g, wk, () => openWakeTask(wk.taskId)); }
    drawSubBadge(g, S.orch.agents[n.id] || {}, 46);
    el('title', {}, g).textContent = `${n.name} (${n.role}) — ${live}`;
    if (typeof ns.contextPct === 'number' && live === 'working') {
      const pct = Math.max(0, Math.min(100, ns.contextPct * 100));
      const cls = pct >= 85 ? 'danger' : pct >= (S.settings.autoCompactPct || 40) ? 'warn' : 'ok';
      const ctxg = el('g', { class: 'ctxbar', transform: `translate(0,${H - 4})` }, g);
      el('rect', { class: 'ctxbar-bg', width: W, height: 4 }, ctxg);
      el('rect', { class: 'ctxbar-fill ctx-' + cls, width: W * pct / 100, height: 4 }, ctxg);
      el('title', {}, ctxg).textContent = `${Math.round(pct)}% ctx · ${fmtTok(ns.contextTokens || 0)} / ${fmtTok(ns.contextWindow || 0)} tokens`;
    }
    // hover quick actions
    const qa = el('g', { class: 'qacts', transform: `translate(${W - 104},-30)` }, g);
    [['✎', 'Edit', () => selectNode(n.id)], ['⧉', 'Duplicate', () => duplicateNode(n)], ['→', 'Connect from here', () => startConnect(n)], ['✕', 'Delete', () => deleteNode(n)]].forEach(([ic, tip, fn], k) => {
      const b = el('g', { class: 'qa', transform: `translate(${k * 26},0)` }, qa); el('rect', { width: 24, height: 22, rx: 6 }, b); el('text', { x: 12, y: 15.5, 'text-anchor': 'middle' }, b).textContent = ic; el('title', {}, b).textContent = tip;
      b.onmousedown = (ev) => ev.stopPropagation(); b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    });
    const h = el('circle', { class: 'handle', cx: W, cy: H / 2, r: 6 }, g); el('title', {}, h).textContent = 'Drag to connect';
    h.onmousedown = (ev) => startLink(ev, n);
    g.onmousedown = (ev) => { if (ev.button === 0) startDrag(ev, n, g); else if (ev.button === 2) { ev.stopPropagation(); selectNode(n.id); nodeMenu(ev, n); } };
    g.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); if ($('#ctxmenu').classList.contains('hidden')) { selectNode(n.id); nodeMenu(ev, n); } };
  }
  // New nodes landing outside the view (e.g. added in bulk) -> refit so nothing is cut off.
  if (nodes.length > vpCount && svg.getBoundingClientRect().width) { fitIfClipped(); vpCount = nodes.length; } // only once visible (hidden tab has 0 width)
  applyVP();
  svg.onmousedown = (ev) => { if (ev.button === 0) startPan(ev); };
  svg.oncontextmenu = (ev) => { ev.preventDefault(); canvasMenu(ev); };
  svg.onwheel = (ev) => { ev.preventDefault(); if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) > 40 && !ev.deltaX) zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.002)), ev.clientX, ev.clientY); else { VP.x -= ev.deltaX; VP.y -= ev.deltaY; applyVP(); saveVP(); } };
}
function renderMinimap() {
  const mm = $('#minimap'); if (!mm) return; mm.innerHTML = ''; const nodes = allGraphNodes(); const r = $('#graph').getBoundingClientRect(); if (!r.width) return;
  const view = { x: -VP.x / VP.zoom, y: -VP.y / VP.zoom, w: r.width / VP.zoom, h: r.height / VP.zoom }; const b = graphBox(nodes);
  // The graph already fits entirely inside the viewport (no panning possible) -> the minimap is redundant. Hide it.
  const fits = b.x >= view.x && b.y >= view.y && b.x + b.w <= view.x + view.w && b.y + b.h <= view.y + view.h;
  mm.classList.toggle('hidden', fits);
  if (fits) return;
  const x0 = Math.min(b.x, view.x) - 20, y0 = Math.min(b.y, view.y) - 20, x1 = Math.max(b.x + b.w, view.x + view.w) + 20, y1 = Math.max(b.y + b.h, view.y + view.h) + 20;
  mm.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  for (const n of nodes) el('rect', { x: n.x, y: n.y, width: W, height: H, rx: 12, class: n.ghost ? 'mghost' : 'mnode', style: n.ghost ? '' : `fill:var(--agent-${agentColor(n.id)})` }, mm);
  el('rect', { ...view, width: view.w, height: view.h, class: 'mview' }, mm);
  mm.onmousedown = (ev) => { const go = (e) => { const mr = mm.getBoundingClientRect(); const s = Math.max((x1 - x0) / mr.width, (y1 - y0) / mr.height); const wx = x0 + (e.clientX - mr.left - (mr.width - (x1 - x0) / s) / 2) * s, wy = y0 + (e.clientY - mr.top - (mr.height - (y1 - y0) / s) / 2) * s; VP.x = r.width / 2 - wx * VP.zoom; VP.y = r.height / 2 - wy * VP.zoom; const v = $('#graph > g.viewport'); v && v.setAttribute('transform', `translate(${VP.x},${VP.y}) scale(${VP.zoom})`); };
    go(ev); const up = () => { window.removeEventListener('mousemove', go); window.removeEventListener('mouseup', up); applyVP(); saveVP(); }; window.addEventListener('mousemove', go); window.addEventListener('mouseup', up); };
}
function startPan(ev) {
  hideMenus(); const sx = ev.clientX, sy = ev.clientY, ox = VP.x, oy = VP.y; let moved = false; $('#graph').classList.add('panning');
  const mv = (e) => { moved = moved || Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3; VP.x = ox + e.clientX - sx; VP.y = oy + e.clientY - sy; applyVP(); };
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); $('#graph').classList.remove('panning');
    if (moved) return saveVP(); if (sel.node || sel.edge) { sel = { ...sel, node: null, edge: null }; renderGraph(); renderNodeForm(); } };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
const clipText = (s, max) => (String(s).length > max ? String(s).slice(0, max - 1) + '…' : String(s));
function selectNode(id) { hideMenus(); sel = { ...sel, node: id, edge: null }; renderGraph(); renderNodeForm(); }
async function duplicateNode(n) { const { id, ...rest } = n; const c = await call('addNode', { ...rest, name: n.name + ' copy', x: n.x + 30, y: n.y + H + 30 }); sel.node = c.id; refresh(); }
async function deleteNode(n) { if (!confirm(`Delete ${n.name}?`)) return; await call('removeNode', n.id); sel.node = null; refresh(); }
function startConnect(n) { connectMode = true; connectFrom = n.id; $('#connect').classList.add('on'); $('#hint').textContent = `From ${n.name}: click the target node`; renderGraph(); }
async function connect(from, to, type) { try { await call('addEdge', from, to, type); lastEdgeType = type; } catch (e) { alert(e.message); } refresh(); }
// Drag from a node's handle; drop on another node opens the edge-type popover (default = last used).
function startLink(ev, n) {
  ev.stopPropagation(); ev.preventDefault(); hideMenus(); const vp = $('#graph > g.viewport');
  const tmp = el('path', { class: 'edge linking' }, vp); const sx = n.x + W, sy = n.y + H / 2; $('#graph').classList.add('linking');
  const mv = (e) => { const [x, y] = toWorld(e.clientX, e.clientY); const mx = (sx + x) / 2; tmp.setAttribute('d', `M${sx},${sy} L${mx},${sy} L${mx},${y} L${x},${y}`);
    document.querySelectorAll('#graph .node.droptarget').forEach((d) => d.classList.remove('droptarget')); const t = e.target.closest && e.target.closest('#graph .node'); t && t.dataset.id !== n.id && t.classList.add('droptarget'); };
  const up = (e) => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); tmp.remove(); $('#graph').classList.remove('linking');
    const t = e.target.closest && e.target.closest('#graph .node'); document.querySelectorAll('#graph .node.droptarget').forEach((d) => d.classList.remove('droptarget'));
    if (t && t.dataset.id !== n.id) edgePopover(e.clientX, e.clientY, n.id, t.dataset.id); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
function edgePopover(x, y, from, to) {
  const types = S.config.edgeTypes.length ? S.config.edgeTypes : ['assign', 'message', 'review'];
  showMenu(x, y, `<div class="mhead">${esc(nodeName(from))} → ${esc(nodeName(to))}</div>` + types.map((t) => `<button data-t="${t}" class="${t === lastEdgeType ? 'def' : ''}"><i class="sw sw-${t}"></i>${t}<small>${esc(EDGE_DESC[t] || '')}</small></button>`).join(''), 'edgepop');
  document.querySelectorAll('#ctxmenu button').forEach((b) => b.onclick = () => { hideMenus(); connect(from, to, b.dataset.t); });
  const d = $('#ctxmenu button.def') || $('#ctxmenu button'); d && d.focus();
}
function showMenu(x, y, html, cls = '') {
  const m = $('#ctxmenu'); m.className = 'ctxmenu ' + cls; m.innerHTML = html; m.style.left = x + 'px'; m.style.top = y + 'px';
  const r = m.getBoundingClientRect(); if (r.right > innerWidth - 8) m.style.left = (x - r.width) + 'px'; if (r.bottom > innerHeight - 8) m.style.top = (y - r.height) + 'px';
}
const hideMenus = () => { const m = $('#ctxmenu'); if (m) m.className = 'ctxmenu hidden'; };
const menuItems = (items) => items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}" class="${it[2] || ''}">${it[0]}</button>`).join('');
function bindMenu(items) { document.querySelectorAll('#ctxmenu button[data-i]').forEach((b) => b.onclick = act(async () => { hideMenus(); await items[b.dataset.i][1](); })); }
function nodeMenu(ev, n) {
  const items = [['Edit', () => selectNode(n.id)], ['Connect from here', () => startConnect(n)], ['Duplicate', () => duplicateNode(n)], ['Test agent', () => testAgents([n.id])], '-', ['Delete', () => deleteNode(n), 'danger']];
  showMenu(ev.clientX, ev.clientY, `<div class="mhead">${esc(n.name)}</div>` + menuItems(items)); bindMenu(items);
}
function edgeMenu(ev, e) {
  const items = [...S.config.edgeTypes.map((t) => [`Make ${t}`, async () => { await call('updateEdge', e.id, { type: t }); refresh(); }, (e.type || 'assign') === t ? 'def' : '']), '-', ['Delete edge', async () => { await call('removeEdge', e.id); sel.edge = null; refresh(); }, 'danger']];
  showMenu(ev.clientX, ev.clientY, `<div class="mhead">${esc(nodeName(e.from))} → ${esc(nodeName(e.to))}</div>` + menuItems(items)); bindMenu(items);
}
function canvasMenu(ev) {
  const [x, y] = toWorld(ev.clientX, ev.clientY);
  const items = [['Add agent here', () => addAgentAt(x, y)], ['Auto-layout', autoLayout], ['Fit view', fitView], ['Reset zoom', () => zoomAt(1 / VP.zoom)]];
  showMenu(ev.clientX, ev.clientY, menuItems(items)); bindMenu(items);
}
async function addAgentAt(x, y) { const k = S.team.nodes.length; const role = k === 0 ? 'PM' : 'Dev'; const n = await call('addNode', { name: `${role} ${k + 1}`, role, x: Math.round(x), y: Math.round(y) }); sel.node = n.id; refresh(); }
// Layered (Sugiyama-lite) layout: longest-path layers over assign/review edges, barycentre ordering, centred rows.
async function autoLayout() {
  const ns = S.team.nodes; if (!ns.length) return; const ids = new Set(ns.map((n) => n.id));
  const es = S.team.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to && (e.type || 'assign') !== 'message');
  const layer = Object.fromEntries(ns.map((n) => [n.id, 0]));
  for (let it = 0; it < ns.length; it++) { let ch = false; for (const e of es) if (layer[e.to] < layer[e.from] + 1 && layer[e.from] + 1 < ns.length) { layer[e.to] = layer[e.from] + 1; ch = true; } if (!ch) break; }
  const layers = []; ns.forEach((n) => (layers[layer[n.id]] ||= []).push(n.id)); const rows = []; layers.filter(Boolean).forEach((l) => { for (let i = 0; i < l.length; i += 4) rows.push(l.slice(i, i + 4)); });
  const pos = {}; const maxW = Math.max(...rows.filter(Boolean).map((r) => r.length)); const GX = W + 60, GY = H + 80;
  rows.filter(Boolean).forEach((row, li) => {
    if (li) { const bc = (id) => { const p = es.filter((e) => e.to === id && pos[e.from]).map((e) => pos[e.from].x); return p.length ? p.reduce((a, b) => a + b, 0) / p.length : Infinity; }; row.sort((a, b) => bc(a) - bc(b)); }
    const x0 = 40 + (maxW - row.length) * GX / 2; row.forEach((id, i) => { pos[id] = { x: Math.round(x0 + i * GX), y: 40 + li * GY }; });
  });
  await call('setPositions', pos); await refresh(); fitView();
}
// While a node is dragged, re-route every edge against its new position and patch the existing
// path/pill DOM in place, so connections track the card live instead of jumping on mouseup.
function dragEdges(n) {
  if (!edgeLayout) return;
  const ni = edgeLayout.nodes.indexOf(n); if (ni < 0) return;
  edgeLayout.blocks[ni] = { x: n.x - 4, y: n.y - 4, w: W + 8, h: H + 8 };
  const pills = [];
  for (const it of edgeLayout.per) {
    it.geo = edgeGeom(it.a, it.b, it.off, edgeLayout.blocks, edgeSeed(it.e));
    let [px, py] = it.geo.mid; for (let s = 0, r = { x: px - it.pw / 2, y: py - it.ph / 2, w: it.pw, h: it.ph }; s < 12 && [...edgeLayout.blocks, ...pills].some((q) => overlaps(r, q)); s++) { const d = (s % 2 ? -1 : 1) * Math.ceil((s + 1) / 2) * 12; px = it.geo.mid[0] + it.geo.n[0] * d; py = it.geo.mid[1] + it.geo.n[1] * d; r = { x: px - it.pw / 2, y: py - it.ph / 2, w: it.pw, h: it.ph }; }
    pills.push({ x: px - it.pw / 2, y: py - it.ph / 2, w: it.pw, h: it.ph });
    it.hit.setAttribute('d', it.geo.d); it.path.setAttribute('d', it.geo.d);
    it.pill.setAttribute('transform', `translate(${px - it.pw / 2},${py - it.ph / 2})`);
  }
}
function startDrag(ev, n, g) {
  ev.stopPropagation(); hideMenus(); const sx = ev.clientX, sy = ev.clientY, ox = n.x, oy = n.y; let moved = false;
  const mv = (e) => { moved = moved || Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 2; if (!moved) return; n.x = Math.round(ox + (e.clientX - sx) / VP.zoom); n.y = Math.round(oy + (e.clientY - sy) / VP.zoom); g.setAttribute('transform', `translate(${n.x},${n.y})`); dragEdges(n); };
  const up = async () => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    if (moved) { await call('updateNode', n.id, { x: n.x, y: n.y }); renderGraph(); return; }
    if (connectMode) {
      if (!connectFrom) { connectFrom = n.id; $('#hint').textContent = `From ${n.name}: now click the target node`; }
      else { const from = connectFrom; connectFrom = null; connectMode = false; $('#connect').classList.remove('on'); $('#hint').textContent = ''; return connect(from, n.id, $('#edgetype').value); }
    } else sel = { ...sel, node: n.id, edge: null };
    renderGraph(); renderNodeForm();
  };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
$('#addnode').onclick = async () => {
  const r = $('#graph').getBoundingClientRect(); const [x, y] = toWorld(r.left + r.width / 2 - W / 2, r.top + r.height / 2 - H / 2); addAgentAt(x + (S.team.nodes.length % 3) * 20, y);
};
$('#connect').onclick = () => { connectMode = !connectMode; connectFrom = null; $('#connect').classList.toggle('on', connectMode); $('#hint').textContent = connectMode ? 'Click the source node, then the target — or drag from a node\'s right handle' : ''; renderGraph(); };
$('#zoomin').onclick = () => zoomAt(1.2); $('#zoomout').onclick = () => zoomAt(1 / 1.2); $('#fit').onclick = fitView; $('#autolayout').onclick = act(autoLayout);
document.addEventListener('mousedown', (e) => { if (e.button !== 2 && !e.target.closest('#ctxmenu')) hideMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenus(); });
window.addEventListener('resize', () => renderMinimap());
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
    <label class="inline"><input type="checkbox" id="nf-core" ${n.core ? 'checked' : ''}> Core agent <span class="muted">(protected; recruits and retires teammates; one per team)</span></label>
    <label>Runtime</label><select id="nf-runtime">${allRuntimeOptions().map((r) => `<option value="${r.id}" ${r.id === (n.runtime || 'claude') ? 'selected' : ''} ${r.installed ? '' : 'disabled'}>${esc(r.label)}${r.custom ? ' (custom)' : ''}${r.installed ? ' ' + esc(r.version || '') : ' (not installed)'}</option>`).join('')}</select>
    <div id="nf-caps" class="muted"></div>
    <div class="toolbar rtpresets"><span class="muted">Quick preset:</span>${RT_PRESETS.map((p) => `<button data-rtp="${p.name}" ${(C.runtimes || {})[p.runtime] && !C.runtimes[p.runtime].installed ? 'disabled title="' + p.runtime + ' not installed"' : ''}>${p.name} <small>${VENDOR[p.runtime]}/${p.model || 'default'}</small></button>`).join('')}</div>
    <label>Model <span class="muted">(alias or any model ID, e.g. a proxy/provider model; empty = claude CLI default)</span></label><input id="nf-model" list="modellist" value="${esc(n.model || '')}" placeholder="default (claude CLI default)" spellcheck="false"><datalist id="modellist">${(isCustomRuntime(n.runtime) && findCustomRuntime(n.runtime) ? findCustomRuntime(n.runtime).models : MODELS).map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
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
    <fieldset id="nf-effort"><legend>Effort &amp; context</legend>
      <label>Reasoning effort</label><select id="nf-effort-sel">${['low', 'medium', 'high', 'xhigh', 'max'].map((v) => `<option value="${v}" ${(n.effort || 'low') === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>
      <label>Auto-compact window <span class="muted">(blank = runtime default, "auto", or a token count 100k-1M)</span></label><input id="nf-autocompact" placeholder="auto or 100000-1000000" value="${esc(n.autoCompact || '')}">
    </fieldset>
    <fieldset id="nf-caps-box"><legend>Discovered capabilities <button id="nf-caps-refresh" type="button">Refresh</button></legend>
      <div id="nf-caps-view" class="muted">${capsView(n)}</div>
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
  const showCaps = () => {
    const rid = $('#nf-runtime').value; const r = allRuntimeOptions().find((x) => x.id === rid);
    $('#nf-caps').innerHTML = r ? ['tokens', 'cost', 'mcp', 'resume'].map((k) => `<span class="cap ${r.capabilities[k] ? 'on' : 'off'}">${r.capabilities[k] ? '✓' : '✗'} ${k}</span>`).join(' ') : '';
    const custom = findCustomRuntime(rid); $('#modellist').innerHTML = (custom ? custom.models : MODELS).map((m) => `<option value="${esc(m)}">`).join('');
  };
  $('#nf-runtime').onchange = showCaps; showCaps();
  f.querySelectorAll('[data-rtp]').forEach((b) => { b.onclick = () => { const p = RT_PRESETS.find((x) => x.name === b.dataset.rtp); $('#nf-runtime').value = p.runtime; $('#nf-model').value = p.model; showCaps(); }; });
  const showBill = () => { const m = $('#nf-billing').value; $('.bill-proxy-url').classList.toggle('hidden', m !== 'proxy'); $('#nf-billnote').textContent = BILL_NOTE[m] || ''; };
  $('#nf-billing').onchange = showBill; showBill();
  const showMode = () => { const m = $('#nf-mode').value; for (const k of ['goal', 'loop', 'workflow']) document.querySelector('.mode-' + k).classList.toggle('hidden', m !== k); };
  $('#nf-mode').onchange = showMode; showMode();
  $('#nf-perms').ontoggle = () => { sel.permsOpen = $('#nf-perms').open; };
  $('#nf-caps-refresh').onclick = () => refreshCaps(n);
  wireCapsView(n);
  if (!n.capabilities && !CAPS_LOADING.has(n.id)) refreshCaps(n);
  const read = () => ({
    runtime: $('#nf-runtime').value, name: $('#nf-name').value, role: $('#nf-role').value.trim() || 'Dev', model: $('#nf-model').value.trim(), workdir: $('#nf-workdir').value.trim(), systemPrompt: $('#nf-prompt').value,
    permissionMode: $('#nf-perm').value, allowedTools: $('#nf-allowed').value, disallowedTools: $('#nf-disallowed').value, maxTurns: +$('#nf-maxturns').value || 0,
    appendSystemPrompt: $('#nf-append').value, addDirs: $('#nf-adddirs').value, env: $('#nf-env').value, extraArgs: $('#nf-extra').value.trim(),
    effort: $('#nf-effort-sel').value, autoCompact: $('#nf-autocompact').value.trim(),
    mode: $('#nf-mode').value, goalCondition: $('#nf-goalcond').value, maxIterations: +$('#nf-maxiter').value || 5, checkModel: $('#nf-checkmodel').value.trim(),
    loopCount: +$('#nf-loopcount').value || 3, slashCommand: $('#nf-slash').value.trim(), continueSession: $('#nf-continue').checked,
    billingMode: $('#nf-billing').value, billingBaseUrl: $('#nf-billurl').value.trim(),
    budgetUsd: +$('#nf-budgetusd').value || 0, budgetTokens: +$('#nf-budgettok').value || 0, requireApproval: $('#nf-approval').checked,
    core: $('#nf-core').checked,
    disabledBoardTools: [...document.querySelectorAll('#nf-tools input')].filter((x) => !x.checked).map((x) => x.value),
  });
  // Core handover: clear the previous core in this team FIRST, then save — a failed second write
  // leaves zero cores (safe), never two.
  const saveNode = async (v) => { if (v.core) for (const o of S.team.nodes) if (o.id !== n.id && o.core) await call('updateNode', o.id, { core: false }); await call('updateNode', n.id, v); };
  $('#nf-save').onclick = act(async () => { await saveNode(read()); refresh(); });
  $('#nf-test').onclick = act(async () => { await saveNode(read()); await testAgents([n.id]); });
  $('#nf-savepreset').onclick = act(async () => {
    const v = read(); const name = await ask('Role preset name', v.role); if (!name) return;
    await call('savePreset', { name, systemPrompt: v.systemPrompt, allowedTools: v.allowedTools, disallowedTools: v.disallowedTools, permissionMode: v.permissionMode });
    await saveNode({ ...v, role: name }); refresh();
  });
  $('#nf-applypreset').onclick = act(async () => {
    const p = presets.find((x) => x.name.toLowerCase() === $('#nf-role').value.trim().toLowerCase()); if (!p) return;
    await call('updateNode', n.id, { role: p.name, systemPrompt: p.systemPrompt, allowedTools: p.allowedTools, disallowedTools: p.disallowedTools, permissionMode: p.permissionMode }); refresh();
  });
  $('#nf-role').oninput = () => { $('#nf-applypreset').disabled = !presets.some((p) => p.name.toLowerCase() === $('#nf-role').value.trim().toLowerCase()); };
}

// ---------- idle / busy ----------
// Busy = an agent run in progress. Uses S.orch.idle (node ids) when the API provides it, else derives from agent status.
// Parallel runs: S.orch.running may be an array of node ids (or {nodeId}) when the API provides it; else agents with status 'working', else assignees of in-progress tasks.
function runningIds() {
  const r = S.orch.running; if (Array.isArray(r)) return r.map((x) => (typeof x === 'string' ? x : x.nodeId || x.id));
  const w = Object.entries(S.orch.agents || {}).filter(([, a]) => a.status === 'working').map(([k]) => k);
  return w.length || !r ? w : [...new Set(S.tasks.filter((t) => t.status === 'in_progress' && t.assignee).map((t) => t.assignee))];
}
const presence = (id) => (S.orch.idle ? S.orch.idle.includes(id) : !runningIds().includes(id)) ? 'idle' : 'busy';
// Wake-run: an agent running without an in_progress task because a message woke it. One selector so
// Board, Team and Overview can't disagree. Reads the backend's live-run activity fields
// (a.activity: {trigger:'message', fromNodeId, excerpt, taskId, count}); null when the run isn't a wake, the
// agent isn't actually running, or the live run IS the task run (a.taskId set — the task badge wins; a
// wake keeps taskId null even when an in_progress task sits assigned, so the wake label shows there).
function wakeRun(id) {
  const a = S.orch.agents[id] || {};
  const r = a.activity && typeof a.activity === 'object' ? a.activity : (a.run && typeof a.run === 'object' ? a.run : a);
  const w = a.wake && typeof a.wake === 'object' ? { ...r, ...a.wake } : (r.trigger === 'message' ? r : null);
  if (!w) return null;
  if (a.status !== 'working' && presence(id) !== 'busy') return null;
  if (a.taskId && S.tasks.some((t) => t.status === 'in_progress' && t.assignee === id)) return null;
  return { from: nodeName(w.fromNodeId || w.from || ''), excerpt: String(w.excerpt || ''), taskId: w.taskId || w.relatedTaskId || null, queued: Math.max(0, (w.count || 1) - 1) };
}
const wakeLabel = (id) => { const w = wakeRun(id); return w ? `Working — woken by message from ${w.from}: "${w.excerpt}"${w.queued ? ` (+${w.queued} queued)` : ''}` : ''; };
// Shared badge drawing for the Team and Overview node SVGs: a strip just below the node card
// (inside the card there is no free row — the chip row and ctx bar own the bottom edge).
function drawWakeBadge(g, w, onclick) {
  const full = `Working — woken by message from ${w.from}: "${w.excerpt}"${w.queued ? ` (+${w.queued} queued)` : ''}`;
  const bg = el('g', { class: 'wakerunbadge' + (w.taskId ? ' linked' : ''), transform: `translate(4,${H + 3})` }, g);
  el('rect', { width: W - 8, height: 13, rx: 6 }, bg);
  el('text', { x: (W - 8) / 2, y: 9.5, 'text-anchor': 'middle' }, bg).textContent = clipText(full, 30);
  el('title', {}, bg).textContent = full;
  if (w.taskId && onclick) bg.onclick = onclick;
}
const openWakeTask = (taskId) => { sel.task = taskId; showTab('board'); renderBoard(); };
// Stall / recovery state (contract with Devon, t_10137e17): the supervisor logs run.stalled /
// run.recovering / run.recovery_failed and (preferred) keeps a.stall = {state, attempt, max, taskId}
// live on the agent. The selector prefers the live field and falls back to the newest matching log
// event; stale fallbacks clear themselves, recovery_failed stays until the agent runs again.
const STALL_KINDS = new Set(['run.stalled', 'run.recovering', 'run.recovery_failed']);
const STALL_TTL_MS = 10 * 60000;
function stallState(id) {
  const a = S.orch.agents[id] || {};
  const live = (a.stall && typeof a.stall === 'object' && a.stall.state) ? a.stall : (a.run && a.run.stall && typeof a.run.stall === 'object' && a.run.stall.state ? a.run.stall : null);
  if (live) return { state: live.state, attempt: +live.attempt || 1, max: +live.max || 2, taskId: live.taskId || null };
  let latest = null;
  for (const l of logs) if (l.projectId === ctx.p && l.nodeId === id && STALL_KINDS.has(l.kind) && (!latest || l.at > latest.at)) latest = l;
  if (!latest) return null;
  const m = /\((\d+)\s*\/\s*(\d+)\)/.exec(latest.text || '');
  if (latest.kind === 'run.recovery_failed') {
    if (Date.now() - latest.at > 60 * 60000) return null;
    for (const l of logs) if (l.projectId === ctx.p && l.nodeId === id && l.at > latest.at && !STALL_KINDS.has(l.kind)) return null; // ran again since — failure is history
    return { state: 'recovery_failed', attempt: m ? +m[1] : 2, max: m ? +m[2] : 2, taskId: latest.taskId || null };
  }
  if (Date.now() - latest.at > STALL_TTL_MS) return null; // recovery either succeeded (progress resumed) or the supervisor will re-emit
  return { state: latest.kind === 'run.recovering' ? 'recovering' : 'stalled', attempt: m ? +m[1] : 1, max: m ? +m[2] : 2, taskId: latest.taskId || null };
}
const stallLabel = (st) => st.state === 'recovery_failed' ? 'Recovery failed' : `Stalled — recovering (${st.attempt}/${st.max})`;
// Board tag for the task a stalled/recovering agent is (or was last) working on.
function stallTag(t) {
  if (t.status !== 'in_progress' || !t.assignee) return '';
  const st = stallState(t.assignee); if (!st || (st.taskId && st.taskId !== t.id)) return '';
  return `<span class="tag stall${st.state === 'recovery_failed' ? ' fail' : ''}">${esc(stallLabel(st))}</span>`;
}
// Shared strip below the agent card (same slot as the wake badge, which it outranks: a stalled run
// must not read as one still working). Amber while recovering, red once recovery failed.
function drawStallBadge(g, st, onclick) {
  const full = `${stallLabel(st)}${st.taskId ? ` — ${taskTitle(st.taskId)}` : ''}`;
  const bg = el('g', { class: 'stallbadge' + (st.state === 'recovery_failed' ? ' fail' : '') + (st.taskId ? ' linked' : ''), transform: `translate(4,${H + 3})` }, g);
  el('rect', { width: W - 8, height: 13, rx: 6 }, bg);
  el('text', { x: (W - 8) / 2, y: 9.5, 'text-anchor': 'middle' }, bg).textContent = clipText(full, 30);
  el('title', {}, bg).textContent = full;
  if (st.taskId && onclick) bg.onclick = onclick;
}
// Subagent chip on an agent card (Team graph + Overview): count + compact total tokens for the current
// run's subagents. Per contract t_c33656ba the parent's own totals ALREADY include these — the badge is
// a breakdown, never something to add on top. Hidden when the agent spawned nothing. y places it in the
// card: the Team chip row passes its row-1 band (46), Overview keeps the bottom strip (H-18).
function subBadgeInfo(b) {
  const tot = b.tokens ? (b.tokens.inputTokens || 0) + (b.tokens.outputTokens || 0) : 0;
  // totals() reports 0/0 when the CLI publishes no per-subagent usage — count only, "n/a" never "0 tok"
  const txt = tot > 0 ? `🤖${b.count} ${fmtTok(tot)}` : `🤖${b.count}`;
  return { txt, w: 14 + txt.length * 5.6, full: `${b.count} subagent${b.count === 1 ? '' : 's'}${tot > 0 ? ` · ${b.tokens.inputTokens} in / ${b.tokens.outputTokens} out tok (included in this agent's totals)` : ' · token usage n/a'}` };
}
function drawSubBadge(g, a, y = H - 18) {
  const b = Subagents.badge(a); if (!b.count) return;
  const i = subBadgeInfo(b);
  const bg = el('g', { class: 'subbadge', transform: `translate(${W - i.w - 8},${y})` }, g);
  el('rect', { width: i.w, height: 14, rx: 7 }, bg);
  el('text', { x: i.w / 2, y: 10.5, 'text-anchor': 'middle' }, bg).textContent = i.txt;
  el('title', {}, bg).textContent = i.full;
}
// A task stuck in_progress whose assignee has no live agent process: the orchestrator will reset/re-dispatch it,
// but until then it needs to be visible so a stalled run isn't mistaken for one still working.
function orphanedTasks() { const r = runningIds(); return S.tasks.filter((t) => t.status === 'in_progress' && t.assignee && !r.includes(t.assignee)); }
// Log a wake-run in the activity feed the first time it becomes visible (same wakeRun selector as the
// badges, so the feed can't disagree with them); the entry is kept when the wake ends.
const wakeSeen = new Set();
function noteWakes() {
  let added = false;
  for (const n of S.allNodes) {
    const w = wakeRun(n.id);
    if (w && !wakeSeen.has(n.id)) { wakeSeen.add(n.id); logs.push({ projectId: ctx.p, nodeId: n.id, kind: 'event', at: Date.now(), text: `woken by message from ${w.from}` }); added = true; }
    else if (!w) wakeSeen.delete(n.id);
  }
  if (added) renderLog();
}
function renderIdle() {
  noteWakes();
  const idle = S.team.nodes.filter((n) => presence(n.id) === 'idle'); const show = S.team.nodes.length && idle.length;
  document.querySelectorAll('.idlebanner').forEach((b) => { b.classList.toggle('hidden', !show); if (!show) return;
    b.innerHTML = `<span class="pres idle"><i></i></span><b>${idle.length} agent${idle.length > 1 ? 's' : ''} idle</b><span class="muted">${esc(idle.slice(0, 4).map((n) => n.name).join(', '))}${idle.length > 4 ? '…' : ''}</span><span class="spacer"></span><button class="primary" data-assignidle="${idle[0].id}">Assign work</button>`; });
  document.querySelectorAll('[data-assignidle]').forEach((b) => b.onclick = () => { showTab('board'); $('#nt-assignee').value = b.dataset.assignidle; $('#nt-title').focus(); });
  $('#presence').innerHTML = S.allNodes.map((n) => { const p = presence(n.id); const wk = wakeLabel(n.id); return `<span class="pchip ${p}${wk ? ' wake' : ''}" title="${esc(wk || n.role)}"><span class="pres ${p}"><i></i></span>${esc(n.name)} <span class="muted">${wk ? esc(clipText(wk, 52)) : p}</span></span>`; }).join('');
  const wakes = S.allNodes.map((n) => ({ n, w: wakeRun(n.id) })).filter((x) => x.w);
  const wb = $('#wakebar');
  if (wb) { wb.classList.toggle('hidden', !wakes.length);
    wb.innerHTML = wakes.map(({ n, w }) => `<div class="wakebar"><span class="pres busy"><i></i></span><b>${esc(n.name)}</b><span>Working — woken by message from ${esc(w.from)}: "${esc(w.excerpt)}"${w.queued ? ` <span class="muted">(+${w.queued} queued)</span>` : ''}</span><span class="spacer"></span>${w.taskId ? `<button class="linklike" data-waketask="${w.taskId}">${esc(taskTitle(w.taskId))} →</button>` : ''}</div>`).join('');
    wb.querySelectorAll('[data-waketask]').forEach((b) => b.onclick = () => openWakeTask(b.dataset.waketask)); }
}

// ---------- board ----------
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const priorityOf = (t) => PRIORITIES.includes(t.priority) ? t.priority : 'P2';
const priorityBadge = (t) => `<span class="tag prio prio-${priorityOf(t)}" title="Priority ${priorityOf(t)}">${priorityOf(t)}</span>`;
const byPriorityThenTitle = (a, b) => PRIORITIES.indexOf(priorityOf(a)) - PRIORITIES.indexOf(priorityOf(b)) || a.title.localeCompare(b.title);
// Skip-no-op renders (t_9315f18a): the storm profile showed every run push re-rendering ALL heavy
// sections (503-card board, 200-row log window, 300-run usage table) even when their inputs were
// unchanged, and even while their tab was hidden — p95 100ms frames at run cadence. Each gate is a
// cheap fingerprint of exactly what its renderer reads; hidden tabs skip entirely and re-render on
// activation (sig reset in the tab-click handler).
let boardSig = null, logSig = null, obsSig = null, usageSig = null;
const agentStamp = () => Object.entries(S.orch.agents || {}).map(([k, a]) => `${k}${a.status}${a.taskId || ''}${a.iteration || 0}${a.stall ? '!' : ''}${a.run && a.run.stall ? '!' : ''}`).join();
function renderBoard() {
  if (!$('#tab-board').classList.contains('active')) return;
  const bkey = [S.v && S.v.board, sel.task, S.orch.running, Math.floor(Date.now() / 6e4), agentStamp()].join('|');
  if (bkey === boardSig) return; boardSig = bkey;
  const sa = $('#nt-assignee'); const cur = sa.value;
  sa.innerHTML = S.allNodes.map((n) => `<option value="${n.id}">${esc(n.name)} (${n.role})</option>`).join('') || '<option value="">(add agents first)</option>';
  if (cur) sa.value = cur;
  renderIdle();
  $('#columns').innerHTML = STATUSES.map((st) => `<div class="col"><h3>${st.replaceAll('_', ' ')} (${S.tasks.filter((t) => t.status === st).length})</h3>${
    S.tasks.filter((t) => t.status === st).slice().sort(byPriorityThenTitle).map((t) => { const bl = openBlockers(t); const w = (S.orch.agents[t.assignee] || {}); const live = (w.status === 'working' && w.taskId === t.id) || (!w.status && t.status === 'in_progress' && runningIds().includes(t.assignee));
      const ready = !bl.length && ['todo', 'backlog'].includes(t.status);
      const noWorker = t.status === 'in_progress' && t.assignee && !live;
      return `<div class="card ${sel.task === t.id ? 'sel' : ''}${t.awaitingApproval ? ' approval' : ''}" data-id="${t.id}">${priorityBadge(t)} <b>${esc(t.title)}</b>${live ? '<span class="tag live">live</span>' : ''}${noWorker ? `<span class="tag noworker" title="in_progress but no live agent process for ${esc(nodeName(t.assignee))}">No worker</span>` : ''}${stallTag(t)}${bl.length ? `<span class="tag blocked" title="waits for: ${esc(bl.map(taskTitle).join(', '))}">Blocked by ${esc(taskTitle(bl[0]).slice(0, 28))}${bl.length > 1 ? ` +${bl.length - 1}` : ''}</span>` : ready ? '<span class="tag ready">Ready</span>' : ''}${t.awaitingApproval ? '<span class="tag approval">needs approval</span>' : ''}<small>${esc(nodeName(t.assignee))} · ${t.comments.length} comments</small></div>`; }).join('')}</div>`).join('');
  document.querySelectorAll('.card').forEach((c) => c.onclick = () => { sel.task = c.dataset.id; renderBoard(); });
  const d = $('#taskdetail'); const t = S.tasks.find((x) => x.id === sel.task);
  if (!t) { d.innerHTML = '<p class="muted">Create a goal task, assign it to an agent (usually the PM), then press Run.</p>'; return; }
  const keep = Object.fromEntries(['td-msg', 'td-note', 'td-comment'].map((k) => [k, $('#' + k) && $('#' + k).value])); const focused = document.activeElement && document.activeElement.id;
  const ag = S.orch.agents[t.assignee] || {}; const live = ag.status === 'working' && ag.taskId === t.id; const bl = openBlockers(t); const deps = new Set(t.blockedBy || []);
  const cmtCut = Math.max(0, t.comments.length - 200); const cmts = t.comments.slice(-200); // cap long comment threads
  d.innerHTML = `<h3>${priorityBadge(t)} ${esc(t.title)}</h3><p class="muted">${t.id} · by ${esc(t.createdBy === 'human' ? 'human' : nodeName(t.createdBy))}</p>
    ${t.awaitingApproval ? `<div class="approvebox"><b>Waiting for your approval.</b> The agent marked this task done.<textarea id="td-note" rows="2" placeholder="Note (optional; required context when requesting changes)"></textarea><p><button id="td-approve" class="primary">Approve → done</button> <button id="td-reject">Request changes → todo</button></p></div>` : ''}
    ${live || (t.assignee && ag.status === 'working') ? `<div class="livebox"><div class="toolbar"><b>${live ? 'Live' : esc(wakeLabel(t.assignee) || nodeName(t.assignee) + ' is working on another task')}</b>${live ? `<span class="muted">iteration ${ag.iteration || 1}${ag.pendingHuman ? ' · message queued' : ''}</span><span class="spacer"></span><button id="td-stopagent">Stop agent</button>` : ''}</div>${live ? '<pre id="td-live"></pre>' : ''}</div>` : ''}
    ${t.assignee ? `<label>Message ${esc(nodeName(t.assignee))} <span class="muted">(${live ? 'interrupts the run and resumes the same session with your message' : 'stored in the agent inbox for its next run'})</span></label><div class="toolbar"><input id="td-msg" placeholder="Answer or instruction for the agent" style="flex:1"><button id="td-send">Send</button></div>` : ''}
    <label>Priority</label><select id="td-priority">${PRIORITIES.map((p) => `<option ${p === priorityOf(t) ? 'selected' : ''}>${p}</option>`).join('')}</select>
    <label>Status</label><select id="td-status">${STATUSES.map((s) => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <label>Assignee</label><select id="td-assignee">${S.allNodes.map((n) => `<option value="${n.id}" ${n.id === t.assignee ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select>
    <label>Blocked by <span class="muted">(runs only after these are done${bl.length ? ` · ${bl.length} open` : ''})</span></label>
    <div id="td-deps" class="checks deps">${S.tasks.filter((x) => x.id !== t.id).map((x) => `<label class="${deps.has(x.id) && x.status !== 'done' ? 'open' : ''}"><input type="checkbox" value="${x.id}" ${deps.has(x.id) ? 'checked' : ''}> ${esc(x.title)} <span class="muted">(${x.status})</span></label>`).join('') || '<span class="muted">no other tasks</span>'}</div>
    <label>Description</label><div class="comment">${esc(t.description) || '<span class="muted">none</span>'}</div>
    ${t.sessionId ? `<p class="muted">Session <code>${esc(t.sessionId)}</code>${t.iterations ? ` · ${t.iterations} iteration(s)` : ''}</p>` : ''}
    <label>Comments</label>${(cmtCut ? `<p class="muted">${cmtCut} earlier comments hidden</p>` : '') + cmts.map((c) => `<div class="comment"><b>${esc(c.author)}</b>: ${esc(c.text)}</div>`).join('') || '<p class="muted">none</p>'}
    <textarea id="td-comment" rows="2" placeholder="Add comment"></textarea>
    <p><button id="td-addc">Comment</button> <button id="td-del">Delete task</button>${t.worktreePath ? ` <button id="td-diff">Diff</button> <button id="td-merge">Merge</button> <button id="td-discard">Discard</button>` : ''}</p><div id="td-diffbox"></div>`;
  if ($('#td-diff')) {
    $('#td-diff').onclick = act(async () => { const r = await call('taskDiff', t.id); $('#td-diffbox').innerHTML = `<p class="muted">${esc(r.branch)} vs ${esc(r.base)}</p>${r.files.map((f) => `<div><code>${esc(f.status)}</code> ${esc(f.file)}</div>`).join('') || '<p class="muted">no changes</p>'}<pre>${esc(r.diff)}</pre>`; });
    $('#td-merge').onclick = act(async () => { if (!confirm('Merge ' + t.worktreeBranch + ' into the base branch?')) return; await call('taskMerge', t.id); refresh(); });
    $('#td-discard').onclick = act(async () => { if (!confirm('Remove the worktree and delete ' + t.worktreeBranch + '?')) return; await call('taskDiscard', t.id); refresh(); });
  }
  $('#td-priority').onchange = async (e) => { await call('updateTask', t.id, { priority: e.target.value }); refresh(); };
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
  if (!src.trim()) return '<p class="muted wk-empty-body">Nothing written yet. Click Edit / Preview to start writing.</p>';
  const blocks = esc(src).split(/```/);
  const closeList = (h) => h.replace(/(?:<li>.*?<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, '')}</ul>`);
  return blocks.map((b, i) => i % 2 ? `<pre>${b.replace(/^\w*\n/, '')}</pre>` : closeList(b
    .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n{2,}/g, '<br><br>'))).join('');
}
function renderWiki() {
  const q = ($('#wk-search').value || '').trim().toLowerCase();
  const titles = Object.keys(S.wiki).sort().filter((t) => !q || t.toLowerCase().includes(q) || (S.wiki[t].content || '').toLowerCase().includes(q));
  const all = Object.keys(S.wiki).length;
  $('#wikipages').innerHTML = titles.length
    ? titles.map((t) => `<div class="${t === sel.page ? 'sel' : ''}" data-t="${esc(t)}"><b>${esc(t)}</b><br><small class="muted">by ${esc(S.wiki[t].author)}</small></div>`).join('')
    : all ? '<p class="muted wk-empty-body">No pages match your search.</p>' : '<p class="muted wk-empty-body">No pages yet. Click + New page to write your first one — e.g. a runbook, a glossary, or notes for the team.</p>';
  document.querySelectorAll('#wikipages div[data-t]').forEach((d) => d.onclick = () => { sel.page = d.dataset.t; wikiEdit = false; loadPage(); renderWiki(); });
  if (sel.page && S.wiki[sel.page] && !wikiEdit) loadPage();
  else if (!sel.page) $('#wk-view').innerHTML = all ? '<p class="muted wk-empty-body">Pick a page on the left, or start a new one.</p>' : '<p class="muted wk-empty-body">No wiki pages yet. Click + New page on the left to write the first one — a runbook, a glossary, or anything the team should share.</p>';
}
$('#wk-new').onclick = () => { sel.page = null; wikiEdit = true; $('#wk-title').value = ''; $('#wk-content').value = ''; showWiki(); renderWiki(); };
$('#wk-search').oninput = renderWiki;
function loadPage() { const p = S.wiki[sel.page]; if (!p) return; $('#wk-title').value = p.title; $('#wk-content').value = p.content; showWiki(); }
// Cheap backlinks: tasks whose title or description mention this page's title.
function wikiBacklinks(title) { const q = title.trim().toLowerCase(); if (!q) return []; return S.tasks.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)); }
function showWiki() {
  $('#wk-content').classList.toggle('hidden', !wikiEdit); $('#wk-view').classList.toggle('hidden', wikiEdit);
  const bl = wikiEdit ? [] : wikiBacklinks($('#wk-title').value);
  $('#wk-view').innerHTML = md($('#wk-content').value) + (bl.length ? `<div class="wk-backlinks"><b>Linked from tasks</b><ul>${bl.map((t) => `<li data-task="${esc(t.id)}">${esc(t.title)}</li>`).join('')}</ul></div>` : '');
  $('#wk-view').querySelectorAll('.wk-backlinks li').forEach((d) => d.onclick = () => { sel.task = d.dataset.task; showTab('board'); renderBoard(); });
}
$('#wk-edit').onclick = () => { wikiEdit = !wikiEdit; showWiki(); };
$('#wk-save').onclick = async () => { const t = $('#wk-title').value.trim(); if (!t) return; await call('writeWiki', t, $('#wk-content').value); sel.page = t; wikiEdit = false; refresh(); };
$('#wk-del').onclick = async () => { if (sel.page && confirm('Delete page?')) { await call('deleteWiki', sel.page); sel.page = null; $('#wk-title').value = ''; $('#wk-content').value = ''; refresh(); } };

// ---------- observability ----------
const logTeamNodes = () => sel.logTeam ? S.allNodes.filter((n) => n.teamId === sel.logTeam) : S.allNodes;
function renderObs() {
  if (!$('#tab-obs').classList.contains('active')) return;
  const okey = [S.v && S.v.project, S.v && S.v.teams, S.v && S.v.settings, ctx.p, logs.length, (logs[logs.length - 1] || {}).at, S.tasks.length, sel.logTeam, S.orch.runCost, S.orch.runTokens, agentStamp()].join('|');
  if (okey === obsSig) return; obsSig = okey;
  const teams = (S.project && S.project.teams) || [];
  const tf = $('#logteam'); tf.innerHTML = '<option value="">All teams</option>' + teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join(''); tf.value = sel.logTeam;
  const nodes = logTeamNodes();
  let cur = $('#logfilter').value;
  if (cur && !nodes.some((n) => n.id === cur)) cur = '';
  const counts = {}; let total = 0;
  const ids = new Set(nodes.map((n) => n.id));
  for (const l of logs) if (l.projectId === ctx.p && ids.has(l.nodeId)) { counts[l.nodeId] = (counts[l.nodeId] || 0) + 1; total++; }
  const rows = nodes.map((n) => { const a = S.orch.agents[n.id] || {}; const w = who(n.id);
    const task = a.taskId ? esc((S.tasks.find((t) => t.id === a.taskId) || {}).title || a.taskId) : '';
    return `<div class="logagent-row ${cur === n.id ? 'sel' : ''}" data-id="${n.id}"><span class="avatar sm ${a.status === 'working' ? 'working' : ''}" style="background:${w.color}" title="${esc(w.name)}">${esc(w.ini)}</span><span class="lameta"><b>${esc(n.name)}</b> ${vbadge(n)}<br><small class="muted st-${a.status || 'idle'}">${a.status || 'idle'}${task ? ` · ${task}` : ''}</small></span><span class="lacount" title="log lines">${counts[n.id] || 0}</span><span class="lactions">${a.status === 'working' ? `<button data-stopagent="${n.id}" title="Stop">⏹</button>` : ''}<button data-msgagent="${n.id}" title="Message">✉</button></span></div>`; }).join('');
  $('#logagents').innerHTML = `<div class="logagent-row ${!cur ? 'sel' : ''}" data-id=""><span class="avatar sm" style="background:#3a3f4b">∀</span><span class="lameta"><b>All agents</b><br><small class="muted">every session</small></span><span class="lacount" title="log lines">${total}</span></div>` +
    (rows || '<p class="muted logempty">No agents in this team.</p>');
  document.querySelectorAll('#logagents .logagent-row[data-id]').forEach((d) => d.onclick = (e) => { if (e.target.closest('.lactions')) return; $('#logfilter').value = d.dataset.id; renderLog(); renderObs(); });
  document.querySelectorAll('[data-stopagent]').forEach((b) => b.onclick = act(async (e) => { e.stopPropagation(); await call('stopAgent', b.dataset.stopagent); refresh(); }));
  document.querySelectorAll('[data-msgagent]').forEach((b) => b.onclick = act(async (e) => { e.stopPropagation(); const v = await ask(`Message to ${nodeName(b.dataset.msgagent)} (a running agent is interrupted and resumed with it)`); if (v) { await call('sendToAgent', b.dataset.msgagent, v); refresh(); } }));
  const bs = S.orch.budgetStop ? esc(S.orch.budgetStop) : ''; const st = S.settings; const orphans = orphanedTasks();
  const orphanNote = orphans.length ? `${orphans.length} task${orphans.length > 1 ? 's' : ''} stuck in_progress with no live worker (${esc(orphans.slice(0, 3).map((t) => t.title).join(', '))}${orphans.length > 3 ? '…' : ''})` : '';
  const stopMsg = !S.orch.running ? [bs, orphanNote].filter(Boolean).join(' · ') : (bs ? [bs, orphanNote].filter(Boolean).join(' · ') : '');
  $('#budgetbar').innerHTML = (st.budgetUsd || st.budgetTokens ? `Run budget: ${st.budgetUsd ? `$${(S.orch.runCost || 0).toFixed(4)} / $${st.budgetUsd}` : ''}${st.budgetUsd && st.budgetTokens ? ' · ' : ''}${st.budgetTokens ? `token budget ${fmtTok(st.budgetTokens)} tok per run (enforced — per-key split in Usage; token totals are no longer summed)` : ''}` : '') + (stopMsg ? ` <span class="warn">Stopped: ${stopMsg}</span>` : '');
  const f = $('#logfilter'); f.innerHTML = '<option value="">All agents</option>' + nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join(''); f.value = cur;
}
const LOG_LEVEL = { error: 'error', stderr: 'error', tool_error: 'error', system: 'info', tool: 'tool', tool_result: 'tool', result: 'ok', raw: 'muted', compacted: 'compact', event: 'info' };
function logRow(l) {
  const w = who(l.nodeId); const lvl = LOG_LEVEL[l.kind] || 'text';
  const task = l.task ? `<span class="logtask" ${l.taskId ? `data-tasklink="${esc(l.taskId)}" title="Open in task thread"` : ''}>${esc(l.task)}</span>` : '';
  return `<div class="logrow lv-${lvl}"><span class="logtime">${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><span class="avatar sm" style="background:${w.color}" title="${esc(w.name)}">${esc(w.ini)}</span><span class="logagent" title="${esc(w.name)}">${esc(w.name)}</span>${task}<span class="loglevel lv-${lvl}">${esc(l.kind)}</span><span class="logtext">${esc(l.text)}</span></div>`;
}
// ---------- subagents (contract: t_c33656ba) ----------
// Records live on the owning agent (S.orch.agents[id].subagents) for the current run and persist per
// run in RUNS[i].subagents; a child log row carries subagentId. Unknown ids render a minimal block.
function subRecOf(sid) {
  for (const a of Object.values(S.orch.agents || {})) { const r = (a.subagents || []).find((x) => x.id === sid); if (r) return r; }
  for (const r of RUNS) { const x = (r.subagents || []).find((y) => y.id === sid); if (x) return x; }
  return null;
}
const subOpen = new Set(); // expanded subagent block ids (survives re-renders within the session)
function subMetaTxt(rec) {
  const dur = Subagents.durationMs(rec); const d = Subagents.fmtDuration(dur);
  return `${d ? d + ' · ' : ''}${Subagents.tokensLabel(rec && rec.tokens)}`;
}
// Collapsible nested block for one subagent: description, status, duration, own tokens (+ its children).
function subBlockHtml(it, depth = 0) {
  const rec = subRecOf(it.rec.id) || it.rec || {}; const sid = rec.id;
  const open = subOpen.has(sid);
  const count = (function n(xs) { return xs.reduce((a, x) => a + (x.kind === 'sub' ? n(x.rows) : 1), 0); })(it.rows);
  const head = `<span class="subcaret">${open ? '▾' : '▸'}</span><span class="subicon">🤖</span>` +
    `<span class="subdesc">${esc(rec.description || rec.toolName || 'Subagent')}</span>` +
    `<span class="substatus ss-${esc(rec.status || 'unknown')}" data-substatus="${esc(rec.status || 'unknown')}">${esc(rec.status || 'unknown')}</span>` +
    `<span class="submeta">${esc(subMetaTxt(rec))}</span><span class="subcount">${count} event${count === 1 ? '' : 's'}</span>`;
  const inner = it.rows.map((x) => x.kind === 'sub' ? subBlockHtml(x, depth + 1) : logRow(x.l)).join('');
  return `<div class="subblock d${depth}${open ? ' open' : ''}" data-sub="${esc(sid)}"><div class="subhead" data-subtoggle="${esc(sid)}" title="${esc(rec.description || sid)} — ${esc(subMetaTxt(rec))}">${head}</div><div class="subrows"${open ? '' : ' hidden'}>${inner}</div></div>`;
}
function bindSubToggles(rerender) { document.querySelectorAll('[data-subtoggle]').forEach((d) => d.onclick = (e) => { e.stopPropagation(); const sid = d.dataset.subtoggle; subOpen.has(sid) ? subOpen.delete(sid) : subOpen.add(sid); rerender(); }); }
// All severities shown by default; chips let you narrow the feed down to warn/error only.
const logLevels = new Set(['info', 'warn', 'error']);
const LOG_SEVERITY = { error: 'error', tool_error: 'error', stderr: 'warn' };
const severityOf = (l) => l.level || LOG_SEVERITY[l.kind] || 'info';
function renderLogLevelChips() {
  $('#loglevels').innerHTML = ['info', 'warn', 'error'].map((lv) => `<button class="lvchip lv-${lv}${logLevels.has(lv) ? ' on' : ''}" data-lv="${lv}" aria-pressed="${logLevels.has(lv)}"><span class="ck">✓</span>${lv}</button>`).join('');
  document.querySelectorAll('#loglevels [data-lv]').forEach((b) => b.onclick = () => { const lv = b.dataset.lv; logLevels.has(lv) ? logLevels.delete(lv) : logLevels.add(lv); renderLogLevelChips(); renderLog(); });
}
renderLogLevelChips();
// Windowing (t_fb193107): like the chat room, the log list renders only the last LOG_PAGE matching
// lines; scroll-up (or the older-bar) prepends the next page, anchored. Returning to the bottom
// (the live tail) shrinks the window again so streaming keeps the DOM bounded.
const LOG_PAGE = 200;
let logWin = LOG_PAGE;
$('#log').addEventListener('scroll', () => { const box = $('#log');
  if (box.scrollTop < 80 && renderLog.total > logWin) { logWin += LOG_PAGE; renderLog(); }
  else if (box.scrollTop + box.clientHeight >= box.scrollHeight - 20 && logWin > LOG_PAGE) { logWin = LOG_PAGE; renderLog(); } });
function renderLog() {
  if (!$('#tab-obs').classList.contains('active')) return;
  const lkey = [ctx.p, logs.length, (logs[logs.length - 1] || {}).at, logWin, $('#logfilter').value, $('#logsearch').value, [...logLevels].join(), sel.logTeam, logsLoaded.has(ctx.p)].join('|');
  if (lkey === logSig) return; logSig = lkey;
  const f = $('#logfilter').value; const q = ($('#logsearch').value || '').trim().toLowerCase();
  const teamIds = sel.logTeam ? new Set(logTeamNodes().map((n) => n.id)) : null;
  const box = $('#log'); const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  const prevH = box.scrollHeight, prevTop = box.scrollTop;
  const all = logs.filter((l) => l.projectId === ctx.p && (!teamIds || teamIds.has(l.nodeId)));
  const base = all.filter((l) => (!f || l.nodeId === f) && (!q || l.text.toLowerCase().includes(q)));
  let rows = base.filter((l) => logLevels.has(severityOf(l)));
  let hiddenInfo = 0;
  if (!rows.length && base.length) {
    hiddenInfo = base.filter((l) => !logLevels.has(severityOf(l))).length;
    if (hiddenInfo) rows = base;
  }
  renderLog.total = rows.length;
  const page = Chat.pageOf(rows, logWin);
  const empty = teamIds && !all.length ? 'No messages for this team.' : (all.length ? 'No log lines match your filter.' : 'No activity yet — run the team to see agent logs here.');
  const older = page.hidden ? `<button id="log-older" class="olderbar linklike">↑ ${page.hidden} earlier line${page.hidden === 1 ? '' : 's'} — scroll up or click to load</button>` : '';
  box.innerHTML = rows.length ? (hiddenInfo ? `<p class="muted logempty">${hiddenInfo} info line(s) hidden by the level filter — showing all. <button id="log-showall" class="linklike">Show all</button></p>` : '') + older +
    Subagents.nestRows(page.items, subRecOf, null).map((x) => x.kind === 'sub' ? subBlockHtml(x) : logRow(x.l)).join('') : `<p class="muted logempty">${empty}</p>`;
  const sa = document.getElementById('log-showall'); if (sa) sa.onclick = () => { logLevels.add('info'); logLevels.add('warn'); logLevels.add('error'); renderLogLevelChips(); renderLog(); };
  const ob = document.getElementById('log-older'); if (ob) ob.onclick = () => { logWin += LOG_PAGE; renderLog(); };
  bindSubToggles(renderLog);
  document.querySelectorAll('#log [data-tasklink]').forEach((d) => d.onclick = () => { sel.task = d.dataset.tasklink; $('#ov-task').value = ''; showTab('overview'); });
  if (atBottom && $('#logauto').checked) box.scrollTop = box.scrollHeight;
  else box.scrollTop = Chat.anchorScroll(prevTop, prevH, box.scrollHeight);
}
$('#logteam').onchange = () => { sel.logTeam = $('#logteam').value; $('#logfilter').value = ''; renderObs(); renderLog(); };
$('#logfilter').onchange = renderLog;
$('#logsearch').oninput = renderLog;
$('#clearlog').onclick = act(async () => { if (!confirm('Clear the log of this project (also the saved log file)?')) return; for (let i = logs.length - 1; i >= 0; i--) if (logs[i].projectId === ctx.p) logs.splice(i, 1); await call('clearLogs'); renderLog(); });

// ---------- usage & billing ----------
let RUNS = [];
async function loadRuns() { try { RUNS = await call('listRuns'); } catch (e) { console.warn('listRuns failed, keeping previous runs', e); } }
function sumRuns(rs) {
  const s = { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0, durationMs: 0, sub: 0, billed: 0 };
  for (const r of rs) { s.runs++; for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'numTurns', 'durationMs']) s[k] += r[k] || 0; if (r.billingSource === 'subscription') s.sub += r.reportedCostUsd || 0; else s.billed += r.reportedCostUsd || 0; }
  s.total = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens; return s;
}
// Usage is tracked per key {runtime, provider, model} in the usage ledger (t_3318ff63): token
// columns exist ONLY per key and are never summed across models — cost is the only grand total,
// and a key whose cost is unknown renders "—", never a guessed $0.
function runLedger(r) {
  // Billing is detected per run at finish (detectBilling); stamp it onto every entry so account
  // grouping (t_b1115e48) can attribute each key to the account that actually paid for it.
  const bill = { billingSource: r.billingSource || 'unknown', billingDetail: r.billingDetail || '', apiKeySource: r.apiKeySource || null };
  if (Array.isArray(r.ledger) && r.ledger.length) return r.ledger.map((e) => (e.billingSource ? e : { ...bill, ...e }));
  if (!r || !(r.inputTokens || r.outputTokens || r.cacheReadTokens || r.cacheCreationTokens)) return [];
  const cost = r.reportedCostUsd > 0 ? r.reportedCostUsd : null;
  return [{ ...bill, runtime: r.runtime || 'unknown', provider: r.provider || '', model: r.model || (r.models && r.models[0]) || 'unknown',
    inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0, cacheReadTokens: r.cacheReadTokens || 0, cacheCreationTokens: r.cacheCreationTokens || 0, costUsd: cost, costSource: cost != null ? 'reported' : 'unknown' }];
}
// One usage row per ACCOUNT (t_b1115e48): an account is where the money actually goes — billing
// source + its detail (which login, API key or endpoint) — not the CLI's provider label, and the
// literal "unknown" never surfaces as an account or provider name. A runtime-less legacy run folds
// into the Claude subscription account only when its model is claude-* (they predate runtime
// tracking but billing was still detected); anything else stays an explicit "Unattributed" row
// instead of being silently folded into a guessed account (Cato, t_fd822d04 #2).
function accountOf(e) {
  let rt = e.runtime, src = e.billingSource;
  const legacy = !rt || rt === 'unknown';
  if (legacy && /^claude([-\s:]|$)/i.test(e.model || '')) { rt = 'claude'; if (!src || src === 'unknown') src = 'subscription'; }
  const label = runtimeLabel(rt);
  const bySrc = {
    subscription: { name: `${label} subscription`, detail: e.billingDetail || 'subscription login (not billed per token)' },
    api: { name: `${label} API key`, detail: e.billingDetail || e.apiKeySource || 'per-token API billing' },
    proxy: { name: `${label} proxy`, detail: e.billingDetail || (e.provider && e.provider !== 'unknown' ? e.provider : 'proxy endpoint') },
    bedrock: { name: `${label} on AWS Bedrock`, detail: e.billingDetail || 'AWS Bedrock' },
    vertex: { name: `${label} on Google Vertex`, detail: e.billingDetail || 'Google Vertex AI' },
  }[src] || (rt && rt !== 'unknown'
    ? { name: `${label} — billing undetected`, detail: e.billingDetail || 'the run published no init event, so its billing channel could not be detected' }
    : { name: 'Unattributed', detail: 'legacy run with no runtime and no billing info — shown separately, never folded into a guessed account' });
  return { key: `${src || 'unknown'}¦${bySrc.detail}¦${rt || ''}`, name: bySrc.name, detail: bySrc.detail + (legacy ? ' · includes legacy runs recorded before runtimes were tracked' : ''), rt, legacy, billingSource: src || 'unknown' };
}
// Aggregate runs into ledger rows keyed {runtime, provider, model} — same shape as the backend
// usageLedger (src/usage.js). Used for the filtered views; unfiltered renderUsage prefers the
// backend's S.orch.ledger (canonical model ids) so both stay consistent.
function ledgerFromRuns(rs) {
  const F = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
  const add = (map, gk, e) => { const row = map.get(gk) || { key: gk, runtime: e.runtime, provider: e.provider, model: e.model, runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, reported: 0, estimated: 0, unknown: 0 };
    row.runs++; for (const k of F) if (e[k] != null) row[k] = (row[k] || 0) + e[k];
    if (e.costUsd != null) { row.costUsd = (row.costUsd || 0) + e.costUsd; row[e.costSource === 'estimated' ? 'estimated' : 'reported']++; } else row.unknown++;
    map.set(gk, row); };
  const top = new Map(), byAgent = new Map(), byTask = new Map(); const accts = new Map();
  for (const r of rs) for (const e of runLedger(r)) {
    add(top, `${e.runtime}¦${e.provider}¦${e.model}`, e);
    add(byAgent, `${r.agent || r.nodeId || 'unknown'}¦${e.runtime}¦${e.provider}¦${e.model}`, e);
    if (r.taskId) add(byTask, `${r.taskId}¦${e.runtime}¦${e.provider}¦${e.model}`, e);
    // Account view (t_b1115e48): the same entries grouped by the account that paid, model keys
    // nested. Folded legacy rows display (and merge) under their attributed runtime, so the same
    // Claude subscription no longer splits into "claude" and "unknown" rows. Keys display (and
    // merge under) the billing channel for subscription runs — mirroring src/usage.js providerOf
    // (t_f514cc2e) — so stale persisted "firstParty" labels join the same row after the rework.
    const a = accountOf(e);
    const acc = accts.get(a.key) || { key: a.key, name: a.name, detail: a.detail, billingSource: a.billingSource, rows: new Map() };
    const ae = { ...e, runtime: a.rt, provider: e.billingSource === 'subscription' ? 'subscription' : e.provider };
    add(acc.rows, `${ae.runtime}¦${ae.provider}¦${ae.model}`, ae);
    accts.set(a.key, acc);
  }
  const finish = (m) => [...m.values()].map(({ reported, estimated, unknown, ...row }) => ({ ...row,
    costSource: reported && estimated ? 'mixed' : estimated ? 'estimated' : reported ? 'reported' : 'unknown',
    costPartial: unknown > 0 && row.costUsd != null })).sort((a, b) => (a.runtime + a.provider + a.model).localeCompare(b.runtime + b.provider + b.model));
  const nest = (m) => { const o = {}; for (const row of finish(m)) { const i = row.key.indexOf('¦'); (o[row.key.slice(0, i)] ||= []).push({ ...row, key: row.key.slice(i + 1) }); } return o; };
  const rows = finish(top);
  const costUsd = rows.reduce((a, r) => a + (r.costUsd || 0), 0);
  // One aggregate per account: runs + raw cost sum of its keys' known costs (null when no key has a
  // usable cost — missing $ is never rounded into a guessed zero), costSource mixed from the keys.
  const accounts = [...accts.values()].map((a) => { const arows = finish(a.rows).sort((x, y) => (y.costUsd || 0) - (x.costUsd || 0) || String(x.model).localeCompare(String(y.model)));
      const known = arows.filter((r) => r.costUsd != null); const rep = arows.filter((r) => r.costSource === 'reported' || r.costSource === 'mixed').length; const est = arows.filter((r) => r.costSource === 'estimated' || r.costSource === 'mixed').length;
      return { key: a.key, name: a.name, detail: a.detail, billingSource: a.billingSource, rows: arows,
        runtime: arows[0] && arows[0].runtime, runs: arows.reduce((s, r) => s + r.runs, 0),
        costUsd: known.length ? known.reduce((s, r) => s + r.costUsd, 0) : null,
        costSource: rep && est ? 'mixed' : est ? 'estimated' : rep ? 'reported' : 'unknown',
        costPartial: arows.some((r) => r.costSource === 'unknown' || r.costPartial) }; })
    .sort((x, y) => (y.costUsd || 0) - (x.costUsd || 0) || x.name.localeCompare(y.name));
  return { rows, byAgent: nest(byAgent), byTask: nest(byTask), accounts, costUsd, costPartial: rows.some((r) => r.costSource === 'unknown' || r.costPartial) };
}
const rowTokTotal = (row) => (row.inputTokens || 0) + (row.outputTokens || 0) + (row.cacheReadTokens || 0) + (row.cacheCreationTokens || 0);
const estTag = (t) => ` <span class="costnote est" title="${t}">est</span>`;
// Per-key cost cell: "—" when the key has no usable cost (never a guessed $0), "est" when the $ is a list-price estimate.
// A known cost always renders, even for runtimes declared cost-less: reporting one is strictly more information.
function ledgerCostCell(row) {
  if (row.costUsd == null) return canCost(row.runtime) ? '<span class="costnote" title="no cost reported or estimable for this runtime · provider · model key">—</span>' : '<span class="costnote" title="this runtime does not report cost">—</span>';
  return `$${row.costUsd.toFixed(4)}${row.costSource === 'estimated' || row.costSource === 'mixed' ? estTag(row.costSource === 'mixed' ? 'partly estimated from list prices' : 'estimated from list prices — this key reports no cost itself') : ''}${row.costPartial ? ' <span class="costnote" title="some runs under this key report no cost — the $ covers only the known part">partial</span>' : ''}`;
}
// Run-history cost cell: the run's own ledger entries (estimates included), "—" when unknown.
function runCostCell(r) {
  const es = runLedger(r); const known = es.filter((e) => e.costUsd != null);
  if (!known.length) return `<span class="costnote" title="${!es.length ? 'no usage reported for this run' : 'tokens recorded, but no cost reported or estimable'}">—</span>`;
  return `$${known.reduce((a, e) => a + e.costUsd, 0).toFixed(4)}${known.some((e) => e.costSource === 'estimated') ? estTag('estimated from list prices') : ''}${known.length < es.length ? ' <span class="costnote" title="some model keys of this run report no cost">partial</span>' : ''}`;
}
// The primary table (t_b1115e48): one row per ACCOUNT — where the money actually goes (billing
// source + its detail) — with that account's model keys nested beneath it. Token columns stay
// strictly per key on the nested rows; the account row carries only runs + cost (raw sum of its
// keys' known costs, rounded once at display). Providers render "—", never the CLI's "unknown".
function accountTable(accounts) {
  const prov = (p) => (p && p !== 'unknown' ? esc(p) : '—');
  const bill = (a) => a.billingSource && a.billingSource !== 'unknown' ? billTag(a.billingSource, a.detail)
    : '<span class="costnote" title="billing source undetected — the run published no init event">undetected</span>';
  return `<table><tr><th>Account</th><th>Billing</th><th>Runs</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Total tok</th><th>Cost</th></tr>` +
    accounts.map((a) => `<tr class="us-acct"><td title="${esc(a.detail)}"><b>${esc(a.name)}</b></td><td>${bill(a)}</td><td class="num">${a.runs}</td><td colspan="5" class="us-acct-note">tokens stay per model key — see nested rows</td><td>${ledgerCostCell(a)}</td></tr>` +
      a.rows.map((row) => `<tr class="us-acct-key"><td class="muted">↳ ${row.runtime && row.runtime !== 'unknown' ? esc(runtimeLabel(row.runtime)) : '—'} · ${prov(row.provider)} · <span title="${esc(row.model)}">${esc(row.model || '?')}</span></td><td></td><td class="num">${row.runs}</td><td class="num">${row.inputTokens}</td><td class="num">${row.outputTokens}</td><td class="num">${row.cacheReadTokens ?? '—'}</td><td class="num">${row.cacheCreationTokens ?? '—'}</td><td class="num"><b>${rowTokTotal(row)}</b></td><td>${ledgerCostCell(row)}</td></tr>`).join('')).join('') + '</table>';
}
// hero: last-14-days cost bars (reported vs estimated — token sums across models are not offered) + headline numbers.
// o = { global, filtered }: the app-wide ledger total + whether a filter is active, so the grand total
// can show its scope (the header pill always reads the app-wide number — same field, same sum).
function usageHero(rs, led, o) {
  const EQ = 'API-eq (API-equivalent): what this usage would cost at API list prices. Billed = what you are actually invoiced per token (API key / proxy / cloud). Subscription usage is covered by your plan — not billed per token — but its API-eq still counts here so every account stays comparable.';
  const DAYS = 14, day = 864e5, t0 = new Date(); t0.setHours(0, 0, 0, 0); const start = t0.getTime() - (DAYS - 1) * day;
  const b = Array.from({ length: DAYS }, (_, i) => ({ d: new Date(start + i * day), rep: 0, est: 0, runs: 0 }));
  for (const r of rs) { const i = Math.floor((new Date(r.startedAt).getTime() - start) / day); if (i < 0 || i >= DAYS) continue; b[i].runs++;
    for (const e of runLedger(r)) if (e.costUsd != null) (e.costSource === 'estimated' ? b[i].est += e.costUsd : b[i].rep += e.costUsd); }
  // Scale floor is $0.01, not $1: with a $1 floor a $0.07 day renders as a ~7% sliver that reads
  // as "no usage" — the chart is a relative daily-cost view; absolute $ lives in the tooltips/KPIs.
  const max = Math.max(0.01, ...b.map((x) => x.rep + x.est)); const W = 100 / DAYS;
  const bars = b.map((x, i) => { const hr = x.rep / max * 100, he = x.est / max * 100; if (!hr && !he) return `<g><title>${x.d.toLocaleDateString()} · no usage</title></g>`;
    return `<g><title>${x.d.toLocaleDateString()} · $${(x.rep + x.est).toFixed(2)} (${x.runs} run${x.runs === 1 ? '' : 's'})${x.est ? ' · includes estimates' : ''}</title><rect class="usb-est" x="${i * W + W * .15}" y="${100 - he - hr}" width="${W * .7}" height="${he}"/><rect class="usb-rep" x="${i * W + W * .15}" y="${100 - hr}" width="${W * .7}" height="${hr}"/></g>`; }).join('');
  const today = b[DAYS - 1];
  const scope = o && o.filtered && o.global != null && Math.abs(o.global - led.costUsd) > 0.005 ? ` · all runs $${o.global.toFixed(2)} (the header pill)` : 'the app’s single cost total — same number as the header pill';
  return `<div class="us-hero"><div class="us-kpis">
    <div><small>API-eq, today</small><b title="${esc(EQ)}">$${(today.rep + today.est).toFixed(2)}</b><small>${today.runs} run${today.runs === 1 ? '' : 's'} today</small></div>
    <div><small>API-eq, grand total</small><b title="${esc(EQ)}">$${led.costUsd.toFixed(2)}</b><small>${led.costPartial ? 'partial — some keys report no cost · ' : ''}${scope}</small></div>
    <div><small>Avg cost / run</small><b>$${(rs.length ? led.costUsd / rs.length : 0).toFixed(2)}</b><small>across ${rs.length} recorded run${rs.length === 1 ? '' : 's'}</small></div>
    <div><small>Model keys</small><b>${led.rows.length}</b><small>runtime · provider · model combinations</small></div>
  </div><div class="us-chart"><div class="us-chart-head"><small>API-eq, last ${DAYS} days</small><span class="us-leg"><i class="usb-rep"></i>reported <i class="usb-est"></i>estimated</span></div>
  <svg viewBox="0 0 100 100" preserveAspectRatio="none">${bars}</svg><div class="us-axis"><small>${b[0].d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small><small>today</small></div></div></div>`;
}
// ranked share bars, per model: token-based (a per-model total is legitimate — it never mixes models)
function modelBars(rows) {
  const g = {}; for (const row of rows) (g[row.model || '?'] ||= []).push(row);
  const list = Object.entries(g).map(([m, v]) => ({ name: m, runs: v.reduce((a, r) => a + r.runs, 0),
    io: v.reduce((a, r) => a + (r.inputTokens || 0) + (r.outputTokens || 0), 0),
    cache: v.reduce((a, r) => a + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0), 0),
    tot: v.reduce((a, r) => a + rowTokTotal(r), 0), cost: v.reduce((a, r) => a + (r.costUsd || 0), 0), anyCost: v.some((r) => r.costUsd != null),
    sub: [...new Set(v.map((r) => runtimeLabel(r.runtime) + (r.provider ? ' · ' + r.provider : '')))].join(', ') })).sort((a, b) => b.tot - a.tot);
  const max = Math.max(1, ...list.map((x) => x.tot));
  return `<div class="us-card"><h4>By model</h4>${list.map((x) => `<div class="usr" title="${x.runs} run${x.runs === 1 ? '' : 's'} of this model · ${fmtTok(x.io)} in/out · ${fmtTok(x.cache)} cache — tokens are never summed across models">
    <div class="usr-top"><span class="usr-name">${esc(x.name)} <small>${esc(x.sub)}</small></span><span class="usr-val"><b>${fmtTok(x.tot)}</b>${x.anyCost ? ` <small>$${x.cost.toFixed(2)}</small>` : ''}</span></div>
    <i class="usr-bar"><i class="usr-io" style="width:${x.io / max * 100}%"></i><i class="usr-cache" style="width:${x.cache / max * 100}%"></i></i></div>`).join('') || '<p class="muted">No runs yet.</p>'}</div>`;
}
// cost-ranked share bars for grains where token sums would cross models (runtime, agent): $ is the only comparable total
function costBars(title, entries) {
  const list = entries.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const max = Math.max(1, ...list.map((x) => x.cost || 0));
  return `<div class="us-card"><h4>${title}</h4>${list.map((x) => `<div class="usr" title="${esc(x.title)}">
    <div class="usr-top"><span class="usr-name">${esc(x.name)} <small>${esc(x.sub)}</small></span><span class="usr-val"><b>${x.cost != null && x.cost > 0 ? '$' + x.cost.toFixed(2) : '—'}</b></span></div>
    <i class="usr-bar"><i class="usr-usd" style="width:${(x.cost || 0) / max * 100}%"></i></i></div>`).join('') || '<p class="muted">No runs yet.</p>'}</div>`;
}
// folded detail tables: per key everywhere except billing source, which is cost-only (its token sums
// would cross models); unknown cache cells render "—" (unknown ≠ 0)
function modelTableBlock(rows) {
  const g = {}; for (const row of rows) (g[row.model || '?'] ||= []).push(row);
  const agg = Object.entries(g).map(([m, v]) => { const c = { reported: 0, estimated: 0, unknown: 0 };
      for (const r of v) { if (r.costSource === 'reported' || r.costSource === 'mixed') c.reported++; if (r.costSource === 'estimated' || r.costSource === 'mixed') c.estimated++; if (r.costSource === 'unknown' || r.costPartial) c.unknown++; }
      const costUsd = v.some((r) => r.costUsd != null) ? v.reduce((a, r) => a + (r.costUsd || 0), 0) : null;
      return { model: m, runtime: v[0].runtime, runs: v.reduce((a, r) => a + r.runs, 0),
        inputTokens: v.reduce((a, r) => a + (r.inputTokens || 0), 0), outputTokens: v.reduce((a, r) => a + (r.outputTokens || 0), 0),
        cacheReadTokens: v.some((r) => r.cacheReadTokens != null) ? v.reduce((a, r) => a + (r.cacheReadTokens || 0), 0) : null,
        cacheCreationTokens: v.some((r) => r.cacheCreationTokens != null) ? v.reduce((a, r) => a + (r.cacheCreationTokens || 0), 0) : null,
        costUsd, costSource: c.reported && c.estimated ? 'mixed' : c.estimated ? 'estimated' : c.reported ? 'reported' : 'unknown',
        costPartial: c.unknown > 0 && costUsd != null }; }).sort((a, b) => b.runs - a.runs);
  return `<div><h4>By model</h4><table><tr><th></th><th>Runs</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Total tok</th><th>Cost</th></tr>${agg.map((row) => `<tr><td>${esc(row.model)}</td><td class="num">${row.runs}</td><td class="num">${row.inputTokens}</td><td class="num">${row.outputTokens}</td><td class="num">${row.cacheReadTokens ?? '—'}</td><td class="num">${row.cacheCreationTokens ?? '—'}</td><td class="num"><b>${rowTokTotal(row)}</b></td><td>${ledgerCostCell(row)}</td></tr>`).join('')}</table></div>`;
}
function keyTableBlock(title, entries) {
  const list = entries.slice().sort((a, b) => (b.row.costUsd || 0) - (a.row.costUsd || 0) || String(a.name).localeCompare(String(b.name)));
  return `<div><h4>${title}</h4><table><tr><th></th><th>Key (runtime · provider · model)</th><th>Runs</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Total tok</th><th>Cost</th></tr>${list.map(({ name, row }) => `<tr><td>${esc(name)}</td><td class="muted">${esc(runtimeLabel(row.runtime))} · ${esc(row.provider || '—')} · ${esc(row.model || '?')}</td><td class="num">${row.runs}</td><td class="num">${row.inputTokens}</td><td class="num">${row.outputTokens}</td><td class="num">${row.cacheReadTokens ?? '—'}</td><td class="num">${row.cacheCreationTokens ?? '—'}</td><td class="num"><b>${rowTokTotal(row)}</b></td><td>${ledgerCostCell(row)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No runs recorded yet.</td></tr>'}</table></div>`;
}
function billingTable(rs) {
  const g = {}; for (const r of rs) { const k = r.billingSource || 'unknown'; (g[k] ||= { runs: 0, cost: 0 }); g[k].runs++; g[k].cost += r.reportedCostUsd || 0; }
  return `<div><h4>By billing source</h4><table><tr><th></th><th>Runs</th><th>Cost</th><th></th></tr>${Object.entries(g).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => `<tr><td>${billTag(k)}</td><td class="num">${v.runs}</td><td class="num">$${v.cost.toFixed(4)}</td><td>${k === 'subscription' ? '<span class="costnote">covered by subscription — not billed per token</span>' : k === 'unknown' ? '<span class="costnote">billing source undetected</span>' : ''}</td></tr>`).join('')}</table></div>`;
}
function renderUsage() {
  if (!$('#tab-usage').classList.contains('active')) return;
  const ukey = [S.v && S.v.runs, S.v && S.v.board, RUNS.length, $('#us-agent').value, $('#us-billing').value, S.allNodes.length].join('|');
  if (ukey === usageSig) return; usageSig = ukey;
  const fa = $('#us-agent'); const cur = fa.value;
  fa.innerHTML = '<option value="">All</option>' + S.allNodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join(''); fa.value = cur;
  const fb = $('#us-billing').value;
  const rs = RUNS.filter((r) => (!fa.value || r.nodeId === fa.value) && (!fb || r.billingSource === fb));
  const s = sumRuns(rs);
  // Unfiltered views use the backend ledger (canonical model ids); filtered ones aggregate the same
  // way client-side (ledgerFromRuns mirrors src/usage.js usageLedger). The backend ledger has no
  // account split yet (it lands with the backend grouping task), so the By-account table always
  // aggregates client-side from the same per-run entries — same entries, same cost totals.
  const led = (fa.value || fb) ? ledgerFromRuns(rs) : (S.orch.ledger || ledgerFromRuns(rs));
  const filtered = !!(fa.value || fb);
  const accounts = led.accounts || ledgerFromRuns(rs).accounts;
  const globalCost = RUNS.reduce((a, r) => a + runLedger(r).reduce((s2, e) => s2 + (e.costUsd || 0), 0), 0);
  const agentName = (id) => { const r = RUNS.find((x) => x.nodeId === id); return S.allNodes.some((n) => n.id === id) ? nodeName(id) : (r && r.agent) || id; };
  const taskName = (id) => { const t = S.tasks.find((x) => x.id === id); const r = RUNS.find((x) => x.taskId === id); return (t && t.title) || (r && r.task) || id || '(none)'; };
  const mism = rs.filter((r) => r.billingMismatch).length;
  const cs = { reported: 0, estimated: 0, unknown: 0 };
  for (const row of led.rows) { if (row.costSource === 'reported' || row.costSource === 'mixed') cs.reported++; if (row.costSource === 'estimated' || row.costSource === 'mixed') cs.estimated++; if (row.costSource === 'unknown') cs.unknown++; }
  const rtBars = led.rows.reduce((a, row) => { const k = row.runtime || 'unknown'; const x = a.find((y) => y.k === k);
    if (x) { x.cost = x.cost == null ? (row.costUsd == null ? null : row.costUsd) : x.cost + (row.costUsd || 0); x.models++; x.runs += row.runs; }
    else a.push({ k, name: runtimeLabel(k), cost: row.costUsd, models: 1, runs: row.runs }); return a; }, [])
    .map((x) => ({ ...x, sub: `${x.models} model key${x.models === 1 ? '' : 's'}`, title: `${x.runs} run${x.runs === 1 ? '' : 's'} · cost only — tokens would cross models here` }));
  const agBars = Object.entries(led.byAgent).map(([name, rows2]) => { const top = rows2.slice().sort((a, b) => rowTokTotal(b) - rowTokTotal(a))[0];
    return { name, cost: rows2.some((r) => r.costUsd != null) ? rows2.reduce((a, r) => a + (r.costUsd || 0), 0) : null, sub: `${rows2.length} key${rows2.length === 1 ? '' : 's'} · top: ${top && top.model}`, title: `${name}: per-key rows under Detailed tables` }; });
  $('#us-summary').innerHTML = usageHero(rs, led, { global: globalCost, filtered }) + `
  <div class="us-vendor"><small>One row per account — where the money actually goes (billing source + its detail: which login, API key or endpoint) — with each account's model keys nested beneath. Token columns stay strictly per key (never summed across models); cost is the only grand total. "—" marks keys whose cost is unknown, "est" marks list-price estimates.</small><h4>By account</h4>${accounts.length ? accountTable(accounts) : '<p class="muted">No usage recorded yet.</p>'}</div>
  <div class="cards">
    <div class="stat" id="us-cost"><small>API-eq — the only grand total</small><b>$${led.costUsd.toFixed(4)}</b><small>$${s.billed.toFixed(4)} billed per token (API key / proxy / cloud) · $${s.sub.toFixed(4)} on ${rs.filter((r) => r.billingSource === 'subscription').length} subscription run(s), covered${led.costPartial ? '<br><span class="warn">Partial: some model keys report no cost — their $ is missing, not zero</span>' : ''}</small></div>
    <div class="stat"><small>Runs</small><b>${s.runs}</b><small>${['agent', 'check', 'preflight'].map((k) => `${rs.filter((r) => (r.kind || 'agent') === k).length} ${k}`).join(' · ')} · ${s.numTurns} turns</small></div>
    <div class="stat"><small>Cost sources</small><b>${cs.reported} reported${cs.estimated ? ` · ${cs.estimated} est` : ''}</b><small>${cs.unknown ? `${cs.unknown} key${cs.unknown === 1 ? '' : 's'} with unknown cost render as —` : cs.estimated ? 'est = list-price estimate for keys that report no cost themselves' : 'every key reports its own cost'}</small></div>
    <div class="stat"><small>Tracking</small><b>${led.rows.length} model key${led.rows.length === 1 ? '' : 's'}</b><small>${S.orch.usageSince ? `since ${new Date(S.orch.usageSince).toLocaleDateString()} · ` : ''}tokens are never summed across models</small></div>
  </div>${mism ? `<p class="warn">${mism} run(s) did not run on the billing mode set for the agent (see Billing column).</p>` : ''}
  <div class="us-breakdowns">${modelBars(led.rows)}${costBars('By runtime', rtBars)}${costBars('By agent', agBars)}</div>
  <details><summary>Detailed tables</summary><div class="toolbar" style="align-items:flex-start">${modelTableBlock(led.rows)}${keyTableBlock('By agent', Object.entries(led.byAgent).flatMap(([name, rows2]) => rows2.map((row) => ({ name, row }))))}${billingTable(rs)}${keyTableBlock('By task', Object.entries(led.byTask).flatMap(([tid, g2]) => (g2.rows || g2).map((row) => ({ name: taskName(tid), row }))))}</div></details>`;
  $('#us-runs').innerHTML = `<tr><th>Time</th><th>Agent</th><th>Task</th><th>Kind</th><th>Model</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Duration</th><th>Turns</th><th>Billing source</th><th>Cost</th></tr>` +
    (rs.slice().reverse().slice(0, 500).map((r) => `<tr><td>${new Date(r.startedAt).toLocaleString()}</td><td>${esc(r.agent || agentName(r.nodeId))}</td><td>${esc(r.task || taskName(r.taskId))}</td><td>${esc(r.kind)}${r.iteration > 1 ? ' #' + r.iteration : ''}</td><td title="${esc((r.models || []).join(', '))}">${esc(r.model || '?')}</td><td class="num">${r.inputTokens}</td><td class="num">${r.outputTokens}</td><td class="num">${r.cacheReadTokens}</td><td class="num">${r.cacheCreationTokens}</td><td class="num">${((r.durationMs || 0) / 1000).toFixed(1)}s</td><td class="num">${r.numTurns}</td><td>${billTag(r.billingSource, r.billingDetail)}${r.billingMismatch ? ` <span class="warn" title="agent billing mode: ${esc(r.billingMode)}">≠ ${esc(r.billingMode)}</span>` : ''}</td><td>${runCostCell(r)}</td></tr>`).join('') || '<tr><td colspan="13" class="muted">No runs recorded yet.</td></tr>');
  renderDiscovery();
  renderUsageLimits();
}
// ---------- discovery snapshot: aggregated modes/skills/commands + 5h/weekly across probed agents ----------
// There is no single global "capabilities snapshot" IPC — each agent probes its own runtime independently
// (discoverCapabilities per node) and usageStatus reports 5h/weekly from real runs + the CLI's own rate-limit
// events. This unions those real, per-machine sources rather than inventing a snapshot shape nothing produces.
function discoverySnapshot() {
  const nodes = S.allNodes.filter((n) => n.capabilities && n.capabilities.ok !== false && !n.capabilities.error);
  if (!nodes.length) return null;
  const byCat = (cat) => [...new Set(nodes.flatMap((n) => (n.capabilities.categorized || []).filter((x) => x.category === cat).map((x) => x.name)))];
  const probedAts = nodes.map((n) => n.capabilitiesProbedAt).filter(Boolean).map((d) => new Date(d).getTime()).filter((t) => !isNaN(t));
  return { modes: byCat('mode'), skills: byCat('skill'), commands: byCat('command'), capturedAt: probedAts.length ? new Date(Math.max(...probedAts)) : null };
}
async function renderDiscovery() {
  const box = $('#us-discovery'); if (!box) return;
  const snap = discoverySnapshot();
  let st; try { st = await call('usageStatus'); } catch { st = null; }
  const cnt = (n) => n > 0 ? String(n) : '—';
  const reason = (!st || (!st.fiveHour.limit && !st.weekly.limit)) ? await noLimitDataReason() : null;
  const limPart = (label, u) => {
    if (!u || !u.limit) return `<span class="lm-part lm-pending" title="No ${esc(label)} limit set or reported yet"><b>${esc(label)}</b> <small>${reason ? `– no limit data: ${esc(reason)}` : '– no limit set'}</small></span>`;
    const pct = Math.min(100, Math.round(u.pct * 100)); const cls = u.pause ? 'danger' : u.warn ? 'warn' : 'ok';
    const ms = u.resetsAt ? new Date(u.resetsAt).getTime() - Date.now() : 0;
    const resetTitle = ms > 0 ? ` · resets in ${fmtCountdown(ms)}` : '';
    const resetChip = ms > 0 ? `<small>↻${fmtCountdown(ms)}</small>` : '';
    return `<span class="lm-part lm-${cls}" title="${esc(label)}: ${pct}% used${resetTitle}"><b>${esc(label)}</b> ${pct}%<i class="lm-bar"><i class="lm-fill" style="width:${pct}%"></i></i>${resetChip}</span>`;
  };
  const hasLimits = st && (st.fiveHour.limit || st.weekly.limit);
  const asOf = snap && snap.capturedAt ? snap.capturedAt : hasLimits ? new Date() : null;
  box.innerHTML = `<h3>Discovery</h3>` +
    (!snap ? '<p class="muted">Not probed yet — click Refresh on an agent in the Team tab to discover its modes, skills and commands.</p>' :
      `<div class="cards">
        <div class="stat"><small>Skills</small><b>${cnt(snap.skills.length)}</b></div>
        <div class="stat"><small>Commands</small><b>${cnt(snap.commands.length)}</b></div>
        <div class="stat"><small>Modes</small><b>${cnt(snap.modes.length)}</b><small>${snap.modes.map(esc).join(', ') || 'none found'}</small></div>
      </div>`) +
    `<div class="limitmeter" style="margin:8px 0 4px">${limPart('5h', st && st.fiveHour)}${limPart('weekly', st && st.weekly)}</div>` +
    `<small class="muted">as of ${asOf ? esc(asOf.toLocaleString()) : '–'}</small>`;
}
// ---------- usage limits (5h/weekly for subscription, tokens/cost for API) ----------
function usageLimitBar(label, u, fmt) {
  if (!u || !u.limit) return `<div class="stat"><small>${esc(label)}</small><b>${fmt((u && u.used) || 0)}</b><small class="muted">no limit set</small></div>`;
  const pct = Math.min(100, Math.round((u.pct != null ? u.pct : (u.used / u.limit)) * 100));
  const cls = u.pause ? 'danger' : u.warn ? 'warn' : 'ok';
  return `<div class="stat"><small>${esc(label)}</small><b>${fmt(u.used)} <span class="muted">/ ${fmt(u.limit)}</span></b>
    <div class="meter"><div class="meter-fill ${cls}" style="width:${pct}%"></div></div>
    <small class="${cls === 'ok' ? 'muted' : 'warn'}">${pct}% used${u.pause ? ' — limit reached' : u.warn ? ' — approaching limit' : ''}</small></div>`;
}
async function renderUsageLimits() {
  const lim = S.settings.usageLimits || {}; let st;
  try { st = await call('usageStatus'); } catch { st = null; }
  const money = (v) => '$' + (v || 0).toFixed(2);
  // The top bar names only the worst provider; this tab lists every provider's windows (same chips).
  const provs = limitProviders(st);
  $('#us-limits').innerHTML = `<h3>Usage limits</h3><p class="muted">The top bar shows only the worst provider as one summary chip; every provider's limit windows are listed here (5h/weekly budgets settable below).</p>${st && st.warn ? `<p class="warn">Approaching a usage limit.</p>` : ''}${st && st.pause ? `<p class="warn">A usage limit has been reached; new runs may be paused.</p>` : ''}
    ${provs.length ? `<div class="limitmeter us-list">${provs.map((p) => providerChipHtml(p, false)).join('')}</div>` : ''}
    <div class="toolbar" style="align-items:flex-start">
    <div class="cards">
      ${usageLimitBar('API key/proxy, reported cost', st && st.cost, money)}
      ${usageLimitBar('API key/proxy, tokens', st && st.tokens, fmtTok)}
    </div>
    <form id="lim-form" class="toolbar" style="flex-wrap:wrap">
      <label>5h limit, $ <input id="lim-5h" type="number" min="0" step="1" value="${lim.fiveHourLimit || ''}" placeholder="none"></label>
      <label>Weekly limit, $ <input id="lim-7d" type="number" min="0" step="1" value="${lim.weeklyLimit || ''}" placeholder="none"></label>
      <label>API cost limit, $ <input id="lim-apiusd" type="number" min="0" step="1" value="${lim.costLimit || ''}" placeholder="none"></label>
      <label>API token limit <input id="lim-apitok" type="number" min="0" step="1000" value="${lim.tokenLimit || ''}" placeholder="none"></label>
      <label>Warn at, % <input id="lim-warnpct" type="number" min="1" max="100" step="1" value="${lim.warnPct || 80}"></label>
      <button id="lim-save">Save limits</button>
    </form></div>`;
  $('#lim-save').onclick = act(async (ev) => { ev.preventDefault();
    await call('saveSettings', { usageLimits: { fiveHourLimit: +$('#lim-5h').value || 0, weeklyLimit: +$('#lim-7d').value || 0, costLimit: +$('#lim-apiusd').value || 0, tokenLimit: +$('#lim-apitok').value || 0, warnPct: +$('#lim-warnpct').value || 80 } });
    refresh();
  });
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
    <label>Max agents per team <span class="muted">(core agent recruit limit)</span></label><input id="st-maxagents" type="number" min="1" value="${s.maxAgents ?? 6}">
    <label>Core team changes <span class="muted">(recruit / retire / update — ask the human first, or apply automatically)</span></label><select id="st-tcappr">${['ask', 'auto'].map((m) => `<option ${m === (s.teamChangeApproval ?? 'ask') ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <label>Default permission mode (agents can override)</label><select id="st-perm">${['bypassPermissions', 'acceptEdits', 'default', 'plan'].map((m) => `<option ${m === s.permissionMode ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <label>Project budget per Run, $ <span class="muted">(stops all agents; 0 = none)</span></label><input id="st-budgetusd" type="number" min="0" step="0.01" value="${s.budgetUsd || 0}">
    <label>Project token budget per Run <span class="muted">(input + output; 0 = none)</span></label><input id="st-budgettok" type="number" min="0" step="1000" value="${s.budgetTokens || 0}">
    <label>Stuck warning after N minutes without output</label><input id="st-stuck" type="number" min="1" value="${s.stuckMinutes || 5}">
    <label>Stall timeout — stop + auto-resume a silent run after N minutes <span class="muted">(max 2 recoveries, then the task is marked recovery failed)</span></label><input id="st-stall" type="number" min="1" value="${s.stallTimeoutMin ?? 10}">
    <label>Auto-compact at % <span class="muted">(context usage that triggers /compact; 0 = off)</span></label><input id="st-autocompactpct" type="number" min="0" max="95" value="${s.autoCompactPct ?? 40}">
    <label class="inline"><input type="checkbox" id="st-approval" ${s.requireApproval ? 'checked' : ''}> Require human approval for every agent's "done"</label>
    <label class="inline"><input type="checkbox" id="st-notify" ${s.notifications === false ? '' : 'checked'}> Desktop notifications (approval needed, budget reached, run finished)</label>
    <p><button id="st-save" class="primary">Save settings</button></p>
    ${upd.devMode === false ? '' : `<hr><h3>App updates</h3>
    <label class="inline"><input type="checkbox" id="st-autorestart" ${upd.enabled ? 'checked' : ''}> Auto-restart on new merged code</label>
    <p class="muted">When new commits land on this app's base branch: pause the scheduler, wait for running agents to finish, test the new code, then relaunch and resume the run. Failed tests cancel the restart.</p>
    <div id="upd-history"></div>`}
    <h3>Role presets (this project)</h3><p class="muted">Presets appear as role suggestions. A new agent whose role matches a preset gets its prompt, tools and permission mode.</p>
    <table id="presettable"><tr><th>Name</th><th>Permission</th><th>Allowed</th><th>Disallowed</th><th></th></tr>${(s.rolePresets || []).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.permissionMode || 'default')}</td><td>${esc(p.allowedTools.join(', '))}</td><td>${esc(p.disallowedTools.join(', '))}</td><td><button data-editp="${esc(p.name)}">Edit</button><button data-delp="${esc(p.name)}">Delete</button></td></tr>`).join('')}</table>
    <div id="presetform"><label>Name</label><input id="pr-name"><label>Default system prompt</label><textarea id="pr-prompt" rows="3"></textarea>
    <label>Default allowed tools</label><input id="pr-allowed" placeholder="Read, Grep"><label>Default disallowed tools</label><input id="pr-disallowed">
    <label>Permission mode</label><select id="pr-perm"><option value="">project default</option>${(S.config.permissionModes || []).map((m) => `<option>${m}</option>`).join('')}</select>
    <p><button id="pr-save">Save preset</button></p></div>
    <hr>${renderRuntimesSection()}`;
  wireRuntimesSection(); wireDraftForm();
  document.querySelectorAll('[data-delp]').forEach((b) => b.onclick = act(async () => { await call('deletePreset', b.dataset.delp); refresh(); }));
  document.querySelectorAll('[data-editp]').forEach((b) => b.onclick = () => { const p = s.rolePresets.find((x) => x.name === b.dataset.editp); $('#pr-name').value = p.name; $('#pr-prompt').value = p.systemPrompt; $('#pr-allowed').value = p.allowedTools.join(', '); $('#pr-disallowed').value = p.disallowedTools.join(', '); $('#pr-perm').value = p.permissionMode; });
  $('#pr-save').onclick = act(async () => { await call('savePreset', { name: $('#pr-name').value, systemPrompt: $('#pr-prompt').value, allowedTools: $('#pr-allowed').value, disallowedTools: $('#pr-disallowed').value, permissionMode: $('#pr-perm').value }); refresh(); });
  $('#st-save').onclick = async () => { await call('saveSettings', { claudePath: $('#st-claude').value.trim() || 'claude', maxConcurrency: +$('#st-conc').value || 2, maxRuns: +$('#st-runs').value || 30, permissionMode: $('#st-perm').value,
    budgetUsd: +$('#st-budgetusd').value || 0, budgetTokens: +$('#st-budgettok').value || 0, requireApproval: $('#st-approval').checked, notifications: $('#st-notify').checked, stuckMinutes: +$('#st-stuck').value || 5,
    stallTimeoutMin: Math.max(1, +$('#st-stall').value || 10),
    maxAgents: Math.max(1, parseInt($('#st-maxagents').value, 10) || 6), teamChangeApproval: $('#st-tcappr').value === 'auto' ? 'auto' : 'ask',
    autoCompactPct: Math.max(0, Math.min(95, +$('#st-autocompactpct').value || 0)) }); refresh(); };
  renderUpdSettings();
  const stAr = $('#st-autorestart');
  if (stAr) stAr.onchange = act(async (ev) => {
    const on = ev.target.checked;
    try {
      let r; try { r = await squad.call('setAutoRestart', ctx, on); } catch { r = await squad.call('setAutoRestart', on); }
      upd = { ...normUpd(r), stub: false }; trackUpd();
    } catch { upd = { ...upd, enabled: on, stub: true }; } // backend not merged yet: keep a local stub so the control still responds
    renderSelfUpdate(); renderUpdSettings();
  });
}

// ---------- self-update: auto-restart on new merged code ----------
// IPC contract (Devon, t_5e1b4a4b): getSelfUpdateStatus / setAutoRestart + a status push. Until it
// lands, the UI runs on a local stub (marked as such) so the toggle, chip and history stay usable.
const UPD_STATES = { pending: 'update pending', draining: 'waiting for agents', testing: 'testing new code', restarting: 'restarting', failed: 'update failed' };
let upd = { state: 'idle', enabled: false, history: [], stub: true };
// (t_9dea9325) While an update runs, this app can share its store with mixed-version processes:
// once the watcher ff-merges, newly spawned children run the NEW code while the app still runs the
// old — and a new-code store open can migrate files away mid-run (board.json was renamed to .bak
// under the live app, whose old-code reads then silently returned an empty board, and the
// change-driven layer swapped that emptiness onto the screen). While the veil is up — and for a
// grace period after it hides, since children also spawn right after an aborted update — keep the
// last known-good snapshot instead of trusting what a mid-update read returns.
const UPD_FREEZE_GRACE_MS = 60 * 1000;
const updIsLive = () => upd.state !== 'idle' && !!UPD_STATES[upd.state];
// Only testing/restarting freeze data refreshes: they run after the fast-forward (mixed-version
// reads, t_9dea9325) and block the main process with sync npm anyway. pending/draining only pause
// dispatch and touch no store, so there the UI must keep following real agent state — freezing
// them staled every spinner and swallowed sidebar team clicks for as long as the drain waited on
// a running agent (t_93ffac88: the live app sat frozen 00:28:54->01:03 while Flux ran). The grace
// likewise tracks only the freeze-worthy phases: it shields the dispatch-resume burst right after
// an aborted post-merge update, not every status push.
const updFreezes = () => upd.state === 'testing' || upd.state === 'restarting';
let updFrozenAt = 0;
const updFrozen = () => updFreezes() || Date.now() - updFrozenAt < UPD_FREEZE_GRACE_MS;
const trackUpd = () => { if (updFreezes()) updFrozenAt = Date.now(); };
const shortSha = (s) => String(s || '').slice(0, 7);
// Defensive about the exact payload shape (Devon's task is still in flight): state/phase aliases,
// from/to vs fromSha/toSha, history vs restarts, and per-row {ts,why,from,to,result|ok}.
const normUpd = (d) => {
  d = d || {};
  const st = String(d.state || d.phase || 'idle').toLowerCase();
  return {
    state: st === 'idle' || UPD_STATES[st] ? st : 'idle',
    enabled: !!(d.enabled ?? d.autoRestart),
    devMode: d.devMode !== false, // absent (stub/older backend) means the gated-off UX isn't in play
    reason: d.reason || '',
    fromSha: shortSha(d.fromSha ?? d.from),
    toSha: shortSha(d.toSha ?? d.to),
    waiting: d.waitingOn || d.waiting || [],
    lastError: d.lastError || d.error || '',
    history: (d.history || d.restarts || []).map((h) => ({
      ts: h.ts || h.at || h.when,
      why: h.why || h.reason || '',
      from: shortSha(h.fromSha ?? h.from),
      to: shortSha(h.toSha ?? h.to),
      result: h.result || (h.ok === undefined ? 'ok' : h.ok ? 'ok' : 'failed'),
    })),
  };
};
async function loadSelfUpdate() {
  try {
    let d; try { d = await squad.call('getSelfUpdateStatus', ctx); } catch { d = await squad.call('getSelfUpdateStatus'); }
    upd = { ...normUpd(d), stub: false }; trackUpd();
  } catch { upd = { ...upd, stub: true }; } // no backend yet: keep the last known (stub) state
}
// waitingOn arrives as a count from the watcher; older shapes may pass a list of nodes.
const updWaitingCount = (w) => (typeof w === 'number' ? w : Array.isArray(w) ? w.length : 0);
function renderSelfUpdate() {
  const c = $('#updst'); if (!c) return;
  const live = updIsLive() && upd.devMode !== false; // dev-only feature: no pill outside dev mode
  c.classList.toggle('hidden', !live);
  if (!live) { renderUpdVeil(false); return; }
  c.className = 'pill upd-' + upd.state;
  const n = updWaitingCount(upd.waiting);
  c.textContent = n ? `${UPD_STATES[upd.state]} · ${n}` : UPD_STATES[upd.state];
  const bits = [];
  if (upd.reason) bits.push(upd.reason);
  if (upd.fromSha || upd.toSha) bits.push(`${upd.fromSha || '?'} → ${upd.toSha || '?'}`);
  if (upd.state === 'draining' && n) bits.push(`waiting on ${n} agent${n === 1 ? '' : 's'}`);
  if (upd.stub) bits.push('backend pending');
  c.title = bits.join(' · ');
  renderUpdVeil(true);
}

// Small corner notice while a self-update runs (t_6703ba9c): the old full-window veil covered the
// screen and got in the way, so now it tucks under the header's right edge — still there while the
// watcher blocks the main process during merge/build/test (so "updating, not hung" stays visible
// and clicks pass through), but out of the content's way. Red on failure.
const UPD_PHASE_LINE = {
  pending: 'New code detected; pausing new runs.',
  testing: 'Running the test suite on the new code.',
  restarting: 'Restarting now — the window will close and reopen by itself.',
};
function renderUpdVeil(show) {
  const v = $('#updveil'); if (!v) return;
  v.classList.toggle('hidden', !show);
  if (!show) return;
  const failed = upd.state === 'failed';
  const n = updWaitingCount(upd.waiting);
  const phase = failed
    ? (upd.lastError || 'Update failed; staying on the current code.')
    : (UPD_PHASE_LINE[upd.state] || (upd.state === 'draining' ? (n ? `Waiting for ${n} running agent${n === 1 ? '' : 's'} to finish.` : 'Waiting for running agents to finish.') : ''));
  v.innerHTML = `<div class="uv-card${failed ? ' failed' : ''}">
    <div class="uv-title">⟳ Updating · ${esc(UPD_STATES[upd.state] || upd.state)}</div>
    ${phase ? `<div class="uv-phase">${esc(phase)}</div>` : ''}
    ${(upd.fromSha || upd.toSha) ? `<div class="uv-meta"><code>${esc(upd.fromSha || '?')} → ${esc(upd.toSha || '?')}</code>${upd.reason ? ` · ${esc(upd.reason)}` : ''}</div>` : ''}
    ${failed ? '' : '<div class="uv-note">Briefly unresponsive — updating, not hung. It restarts itself; don’t close this window.</div>'}
  </div>`;
}
function renderUpdSettings() {
  const t = $('#st-autorestart'); if (t) t.checked = !!upd.enabled;
  const h = $('#upd-history'); if (!h) return;
  const rows = upd.history || [];
  h.innerHTML = (rows.length
    ? `<table class="updhist"><tr><th>When</th><th>Why</th><th>From → To</th><th>Result</th></tr>${rows.map((r) => `<tr><td>${esc(r.ts ? new Date(r.ts).toLocaleString() : '?')}</td><td>${esc(r.why)}</td><td><code>${esc(r.from || '?')} → ${esc(r.to || '?')}</code></td><td><span class="updres ${r.result === 'failed' ? 'bad' : 'ok'}">${esc(r.result)}</span></td></tr>`).join('')}</table>`
    : `<p class="muted">No restarts yet.${upd.stub ? ' Self-update backend not merged yet — this page is a local stub until then.' : ''}</p>`);
}

// ---------- overview ----------
const projLogs = () => logs.filter((l) => l.projectId === ctx.p);
// Nodes added without explicit positions default to the same (x,y); spread stacked duplicates out so every node stays visible.
function spreadOverlaps(nodes) {
  const seen = new Map(); return nodes.map((n) => {
    const key = `${n.x},${n.y}`; const k = seen.get(key) || 0; seen.set(key, k + 1);
    return k === 0 ? n : { ...n, x: n.x + k * (W + 24), y: n.y };
  });
}
// Skip-no-op renders (t_9d92c3d3): the 1s tick rebuilds the Overview (graph SVG + timeline + thread)
// only when an input changed. ovLive remembers whether the last render drew time-visible state
// (live run bars, edge flashes, stuck badges) — those keep a 2s cadence; a fully idle board freezes.
let ovSig = null, ovLive = false;
function renderOverview() {
  if (!$('#tab-overview.active')) return;
  const now = Date.now(); const L = projLogs();
  const working = Object.values(S.orch.agents || {}).some((a) => a.status === 'working');
  const bucket = working || ovLive ? Math.floor(now / 2000) : 0;
  const sig = Overview.overviewKey({ projectId: ctx.p, nodes: S.team.nodes, edges: S.team.edges, agents: S.orch.agents, tasks: S.tasks, messages: S.messages, logs: L, stuckMinutes: S.settings.stuckMinutes, selectedTask: $('#ov-task').value || sel.task || '', bucket });
  if (sig === ovSig) return;
  ovSig = sig;
  const stuck = new Set(Overview.stuckAgents(S.orch.agents, L, now, S.settings.stuckMinutes || 5));
  const hot = Overview.edgeFlashes(L, S.team.edges, now);
  const ovNodes = spreadOverlaps(S.team.nodes);
  const svg = $('#ov-graph'); svg.innerHTML = ''; const byId = Object.fromEntries(ovNodes.map((n) => [n.id, n]));
  const defs = el('defs', {}, svg);
  for (const t of ['assign', 'message', 'review']) { const m = el('marker', { id: 'ovarr-' + t, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, defs); el('path', { d: 'M0,1 L9,5 L0,9 z', class: 'arrow arrow-' + t }, m); }
  // Same orthogonal geometry (and parallel-edge offsets) as the Team graph, so both views read alike.
  const pk = (e) => [e.from, e.to].sort().join('|'); const pairN = {}, pairI = {}; S.team.edges.forEach((e) => { pairN[pk(e)] = (pairN[pk(e)] || 0) + 1; });
  // Glance view: plain elbows between facing sides (drawn under the cards), no obstacle detours — detours made long bus lines that ran off-canvas.
  for (const e of S.team.edges) {
    const a = byId[e.from], b = byId[e.to]; if (!a || !b) continue; const type = e.type || 'assign';
    const key = pk(e); const i = (pairI[key] = (pairI[key] ?? -1) + 1); const off = (i - (pairN[key] - 1) / 2) * 22 * (e.from < e.to ? 1 : -1);
    el('path', { d: edgeGeom(a, b, off).d, class: `edge edge-${type}` + (hot.has(e.id) ? ' flash' : ''), 'marker-end': `url(#ovarr-${type})` }, svg);
  }
  for (const n of ovNodes) {
    const live = (S.orch.agents[n.id] || {}).status === 'working' ? 'working' : nodeLive(n); const isStuck = stuck.has(n.id); const c = agentColor(n.id);
    const g = el('g', { class: 'node' + (live === 'working' ? ' working st-working' : '') + (isStuck ? ' stuck' : ''), transform: `translate(${n.x},${n.y})`, 'data-id': n.id }, svg);
    el('rect', { class: 'card', width: W, height: H, rx: 12 }, g);
    el('rect', { class: 'stripe', width: 4, height: H - 20, x: 0, y: 10, rx: 2, style: `fill:var(--agent-${c})` }, g);
    el('circle', { class: 'avatar', cx: 26, cy: 24, r: 13, style: `fill:var(--agent-${c})` }, g);
    el('text', { x: 26, y: 28.5, class: 'avtext', 'text-anchor': 'middle' }, g).textContent = initials(n.name);
    el('text', { x: 47, y: 21, class: 'nname' }, g).textContent = clipText(n.name, 16);
    el('text', { x: 47, y: 36, class: 'nrole' }, g).textContent = isStuck ? '⚠ stuck' : `${clipText(n.role, 14)}${live === 'working' ? ' · working' : ''}`;
    el('text', { x: 47, y: 50, 'font-size': 10, opacity: 0.8, class: 'ov-vendor' }, g).textContent = clipText(`${VENDOR[n.runtime || 'claude'] || n.runtime} · ${n.model || 'default'}`, 26);
    const st = stallState(n.id);
    if (st) drawStallBadge(g, st, () => openWakeTask(st.taskId));
    else if (live === 'working') { const wk = wakeRun(n.id); if (wk) drawWakeBadge(g, wk, () => openWakeTask(wk.taskId)); }
    drawSubBadge(g, S.orch.agents[n.id] || {});
    const sg = el('g', { class: 'status s-' + live, transform: `translate(${W - 14},14)` }, g); el('circle', { r: 5 }, sg); el('title', {}, sg).textContent = live;
    el('title', {}, g).textContent = `${n.name} (${n.role}) — ${isStuck ? 'stuck' : live}`;
  }
  // Fit the graph to the available canvas without ever shrinking node text below its authored (readable) size:
  // fit the whole graph in the wrap (never clipped); shrink down to 0.6 before letting the wrap scroll, grow up to 1.3.
  const gbox = graphBox(ovNodes), gpad = 40, bw = gbox.w + gpad * 2, bh = gbox.h + gpad * 2;
  const wrap = svg.parentElement, r = wrap.getBoundingClientRect();
  const scale = clamp(r.width && r.height ? Math.min(r.width / bw, r.height / bh) : 1, 0.6, 1.3);
  const vbw = Math.max(bw, r.width ? r.width / scale : bw), vbh = Math.max(bh, r.height ? r.height / scale : bh);
  svg.setAttribute('viewBox', `${gbox.x - gpad - (vbw - bw) / 2} ${gbox.y - gpad - (vbh - bh) / 2} ${vbw} ${vbh}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = `${vbw * scale}px`; svg.style.height = `${vbh * scale}px`;
  $('#ov-stuck').innerHTML = [...stuck].map((id) => `<div class="stuckbar">⚠ <b>${esc(nodeName(id))}</b> has produced no output for ${S.settings.stuckMinutes || 5}+ min<span class="spacer"></span><button data-ovstop="${id}">Stop</button><button data-ovnudge="${id}">Nudge</button></div>`).join('');
  document.querySelectorAll('[data-ovstop]').forEach((b) => b.onclick = act(async () => { await call('stopAgent', b.dataset.ovstop); refresh(); }));
  document.querySelectorAll('[data-ovnudge]').forEach((b) => b.onclick = act(async () => { await call('sendToAgent', b.dataset.ovnudge, 'Status check: you have produced no output for a while. Reply with a short status (what you are doing, whether you are blocked), then continue or finish your task.'); refresh(); }));
  // Timeline: last 15 minutes, one lane per agent (idle lanes with no recent activity collapsed), auto-scrolled to now.
  const idsAll = Overview.sortByAttention(S.team.nodes.map((n) => n.id), S.orch.agents, S.tasks); const attn = Overview.laneAttention(idsAll, S.orch.agents, S.tasks);
  const lanes = Overview.timeline(L, idsAll, now); const span = 15 * 60000, LW = 110, PX = Math.max(600, $("#ov-timeline").clientWidth - LW - 30), LH = 26;
  const x = (t) => LW + Math.max(0, (t - (now - span)) / span * PX);
  const active = (id) => attn[id] || lanes[id].runs.some((r) => r.end >= now - span) || lanes[id].ticks.some((k) => k.at >= now - span) || lanes[id].marks.some((m) => m.at >= now - span);
  const ids = idsAll.filter(active); const hiddenCount = idsAll.length - ids.length;
  const ATTN_BADGE = { waiting_for_human: '⏳', blocked: '⛔', error: '❗' };
  const tlbox = $('#ov-timeline'); tlbox.innerHTML = '';
  if (hiddenCount) { const note = document.createElement('div'); note.className = 'ovtl-note'; note.textContent = `${hiddenCount} idle lane${hiddenCount > 1 ? 's' : ''} hidden (no activity in the last 15m)`; tlbox.appendChild(note); }
  if (!ids.length) { const empty = document.createElement('p'); empty.className = 'muted ovtl-empty'; empty.textContent = 'No agent activity in the last 15 minutes.'; tlbox.appendChild(empty); }
  else {
    const tl = el('svg', { width: LW + PX + 10, height: ids.length * LH + 18 }, null);
    const defs = el('defs', {}, tl);
    const hatch = el('pattern', { id: 'tl-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'tl-hatch-line' }, hatch);
    for (let m = 0; m <= 15; m += 5) { const gx = x(now - m * 60000); el('line', { x1: gx, x2: gx, y1: 0, y2: ids.length * LH, class: 'axisline' }, tl); }
    ids.forEach((id, i) => { const y = i * LH; const ln = lanes[id]; const at = attn[id];
      el('rect', { x: 0, y, width: LW + PX, height: LH, class: 'lane' + (stuck.has(id) ? ' stuck' : '') + (at ? ' attn-' + at : ''), fill: at === 'waiting_for_human' ? 'url(#tl-hatch)' : 'transparent' }, tl);
      el('text', { x: 4, y: y + 17 }, tl).textContent = (stuck.has(id) ? '⚠ ' : at ? ATTN_BADGE[at] + ' ' : '') + clipText(nodeName(id), 14);
      for (const r of ln.runs) if (r.end >= now - span) el('title', {}, el('rect', { x: x(r.start), y: y + 5, width: Math.max(2, x(r.end) - x(r.start)), height: LH - 10, rx: 3, class: 'run' + (r.live ? ' live' : '') }, tl)).textContent = r.task;
      for (const t of ln.ticks) if (t.at >= now - span) el('title', {}, el('line', { x1: x(t.at), x2: x(t.at), y1: y + 3, y2: y + LH - 3, class: 'tick' }, tl)).textContent = t.name;
      for (const m of ln.marks) if (m.at >= now - span) el('title', {}, el('circle', { cx: x(m.at), cy: y + 5, r: 4, class: 'mark' }, tl)).textContent = '→ ' + m.status; });
    for (let m = 0; m <= 15; m += 5) el('text', { x: x(now - m * 60000) - 14, y: ids.length * LH + 14 }, tl).textContent = m ? `-${m}m` : 'now';
    tlbox.appendChild(tl); tlbox.scrollLeft = tlbox.scrollWidth;
  }
  // Readable task thread (capped to the latest 300 entries; older history stays on the Board).
  const ts = $('#ov-task'); const activeTask = S.tasks.find((t) => t.status === 'in_progress');
  const cur = ts.value || sel.task || (activeTask || S.tasks[S.tasks.length - 1] || {}).id || '';
  ts.innerHTML = S.tasks.map((t) => `<option value="${t.id}">${esc(t.title)} (${t.status})</option>`).join(''); ts.value = cur;
  const t = S.tasks.find((x) => x.id === ts.value); const open = new Set([...document.querySelectorAll('#ov-thread details[open]')].map((d) => d.dataset.k));
  const head = $('#ov-threadhead');
  if (!t) { head.innerHTML = ''; ts.classList.add('hidden'); }
  else {
    ts.classList.remove('hidden');
    const as = byId[t.assignee]; const ac = as ? agentColor(as.id) : 0;
    head.innerHTML = `<div class="ovth-title">${esc(t.title)}</div><div class="ovth-meta"><span class="ovth-status ${esc(t.status)}">${esc(t.status)}</span>${as ? `<span class="ovth-assignee"><span class="ovth-av" style="background:var(--agent-${ac})">${esc(initials(as.name))}</span>${esc(as.name)}</span>` : '<span class="muted">Unassigned</span>'}</div>`;
  }
  // Collapsible nested block for a subagent's tool activity inside the task thread (native <details>,
  // open state preserved via data-k like the tool chips).
  const ovSubBlock = (it, depth) => {
    const rec = subRecOf(it.rec.id) || it.rec || {}; const sid = rec.id; const key = `sub:${sid}`;
    const isopen = open.has(key);
    const inner = it.rows.map((x) => x.kind === 'sub' ? ovSubBlock(x, depth + 1) : x.l.type === 'tool'
      ? `<details data-k="t:${esc(x.l.summary || x.l.at)}" ${open.has(`t:${x.l.summary || x.l.at}`) ? 'open' : ''}><summary class="chip">🔧 ${esc(x.l.summary)}</summary><pre>${esc(x.l.text)}</pre></details>`
      : `<div class="comment"><small class="muted">${new Date(x.l.at).toLocaleTimeString()}</small><br>${esc(x.l.text)}</div>`).join('');
    return `<details class="subthread d${depth}" data-k="${esc(key)}" data-sub="${esc(sid)}" ${isopen ? 'open' : ''}><summary><span class="subcaret">${isopen ? '▾' : '▸'}</span> 🤖 <b>${esc(rec.description || rec.toolName || 'Subagent')}</b> <span class="substatus ss-${esc(rec.status || 'unknown')}">${esc(rec.status || 'unknown')}</span> <span class="submeta">${esc(subMetaTxt(rec))}</span> <span class="subcount">${it.rows.length} event${it.rows.length === 1 ? '' : 's'}</span></summary><div class="subrows">${inner}</div></details>`;
  };
  // Task thread capped to the latest 300 entries before nesting; older history stays on the Board.
  const threadItems = t ? Overview.taskThread(t, L, S.messages) : []; const cut = Math.max(0, threadItems.length - 300); const shown = cut ? threadItems.slice(-300) : threadItems;
  $('#ov-thread').innerHTML = !t ? '<p class="muted empty">No tasks yet.</p>' : (cut ? `<p class="muted empty">${cut} earlier entries hidden — open the task on the Board for the full history.</p>` : '') + (Subagents.nestRows(shown, subRecOf, t.assignee).map((it, k) => it.kind === 'sub' ? ovSubBlock(it, 0) : it.l.type === 'tool'
    ? `<details data-k="${k}" ${open.has(String(k)) ? 'open' : ''}><summary class="chip">🔧 ${esc(it.l.summary)}</summary><pre>${esc(it.l.text)}</pre></details>`
    : `<div class="comment ${it.l.type === 'message' ? 'msg' : ''}"><b>${esc(it.l.type === 'message' ? `${nodeName(it.l.who)} → ${nodeName(it.l.to)}` : it.l.who === 'human' || it.l.who === 'orchestrator' ? it.l.who : nodeName(it.l.who))}</b> <small class="muted">${new Date(it.l.at).toLocaleTimeString()}</small><br>${esc(it.l.text)}</div>`).join('') || '<p class="muted empty">Nothing yet.</p>');
  ovLive = stuck.size > 0 || hot.size > 0 || Object.values(lanes).some((l) => l.runs.some((r) => r.live));
}
$('#ov-task').onchange = renderOverview;
// Drag the empty canvas to pan (the wrap scrolls), matching the Team graph's grab-to-move.
{ const w = $('#ov-graph-wrap'); let d = null;
  w.addEventListener('pointerdown', (ev) => { if (ev.button !== 0 || ev.target.closest('.node')) return; d = { x: ev.clientX, y: ev.clientY, l: w.scrollLeft, t: w.scrollTop }; w.classList.add('panning'); w.setPointerCapture(ev.pointerId); });
  w.addEventListener('pointermove', (ev) => { if (d) { w.scrollLeft = d.l - (ev.clientX - d.x); w.scrollTop = d.t - (ev.clientY - d.y); } });
  const end = () => { d = null; w.classList.remove('panning'); }; w.addEventListener('pointerup', end); w.addEventListener('pointercancel', end); }
document.querySelector('#tabs button[data-tab=overview]').addEventListener('click', () => setTimeout(() => { ovSig = null; renderOverview(); }));
setInterval(renderOverview, 1000);

// ---------- chat: #company room, task threads, working indicator, composer ----------
const CH = { thread: null, key: '', mi: 0, asks: [] };
const who = (id) => { const n = S.allNodes.find((x) => x.id === id); return n ? { name: n.name, role: n.role, color: Chat.avatarColor(n.id), ini: Chat.initials(n.name) } : id === 'human' ? { name: 'You', role: '', color: 'transparent', ini: '', human: true } : { name: id || 'system', role: '', color: '#3a3f4b', ini: '⚙' }; };
function bubble(e) {
  const link = e.taskId && !CH.thread ? ` data-thread="${e.taskId}"` : ''; const tl = link ? `<span class="tlink">↳ ${esc(taskTitle(e.taskId).slice(0, 40))}</span>` : '';
  const rep = e.count > 1 ? `<span class="repeat" title="repeated ${e.count} times">×${e.count}</span>` : '';
  if (e.type === 'tool') return `<details class="cchip"><summary>🔧 ${esc(e.label)}</summary><pre>${esc(e.text)}${e.result != null ? '\n→ ' + esc(String(e.result).slice(0, 2000)) : ''}</pre></details>${tl ? `<span class="bubble linked"${link}>${tl}</span>` : ''}<br>`;
  // One collapsible bubble per subagent (children folded in roomEvents, sub-subagents nested inside):
  // summary header carries description/status/duration/tokens; expanded shows compact child lines.
  if (e.type === 'subagent') {
    const rec = subRecOf(e.subagentId) || {};
    const dur = Subagents.fmtDuration(Subagents.durationMs(rec));
    const meta = [dur, `tok: ${Subagents.tokensLabel(rec.tokens)}`].filter(Boolean).join(' · ');
    const line = (x) => x.kind === 'tool' ? `<span class="sev-tool">🔧 ${esc(Chat.toolLabel(x.text))}</span>` : x.kind === 'tool_result' ? `<span class="sev-res">→ ${esc(String(x.text).slice(0, 160))}</span>` : esc(String(x.text).slice(0, 160));
    const sevHtml = (ev2) => ev2.events.map((x) => `<div class="sev">${line(x)}</div>`).join('') + (ev2.total > ev2.events.length ? `<div class="sev muted">+ ${ev2.total - ev2.events.length} more event(s)</div>` : '');
    const childHtml = (e2) => `<details class="cchip subagent child"><summary>↳ 🤖 ${esc((subRecOf(e2.subagentId) || e2).description || 'Subagent')} <span class="substatus ss-${esc((subRecOf(e2.subagentId) || {}).status || 'unknown')}">${esc((subRecOf(e2.subagentId) || {}).status || 'unknown')}</span> <span class="submeta">${esc([Subagents.fmtDuration(Subagents.durationMs(subRecOf(e2.subagentId) || {})), `tok: ${Subagents.tokensLabel((subRecOf(e2.subagentId) || {}).tokens)}`].filter(Boolean).join(' · '))}</span> <span class="subcount">${e2.total}</span></summary><div class="subevents">${sevHtml(e2)}${(e2.children || []).map(childHtml).join('')}</div></details>`;
    return `<details class="cchip subagent"><summary>🤖 ${esc(rec.description || 'Subagent')} <span class="substatus ss-${esc(rec.status || 'unknown')}">${esc(rec.status || 'unknown')}</span> <span class="submeta">${esc(meta)}</span> <span class="subcount">${e.total}</span></summary><div class="subevents">${sevHtml(e)}${(e.children || []).map(childHtml).join('')}</div></details>${tl ? `<span class="bubble linked"${link}>${tl}</span>` : ''}<br>`;
  }
  if (e.type === 'question') return `<div class="bubble question" data-iid="${e.inboxId}">❓ <b>Question for you</b>${tl}<br>${esc(e.text)}<br>${e.choices.map((c) => `<button class="primary ch-choice" data-v="${esc(c)}">${esc(c)}</button>`).join('')}<textarea class="ch-ans" rows="1" placeholder="Or type an answer"></textarea><button class="ch-send">Answer</button></div>`;
  const text = e.type === 'handoff' ? `📋 assigned “${e.text}” to @${who(e.to).name}` : e.type === 'message' ? `✉ @${who(e.to).name} ${e.text}` : e.type === 'comment' ? `💬 ${e.text}` : e.text;
  return `<div class="bubble ${e.type}${link ? ' linked' : ''}"${link}>${esc(text)}${tl}${rep}</div>`;
}
// Collapse consecutive identical messages (same type/target/text) from one author into one bubble + a ×N badge at the end.
const collapseRepeats = (items) => items.reduce((out, it) => { const p = out[out.length - 1]; if (p && p.type === it.type && p.text === it.text && p.to === it.to && it.type !== 'tool' && it.type !== 'question' && it.type !== 'subagent') p.count = (p.count || 1) + 1; else out.push({ ...it }); return out; }, []);
// Merge adjacent same-author groups (no repeated "You" headers); questions stay separate.
const mergeGroups = (gs) => gs.reduce((out, g) => { const p = out[out.length - 1]; if (p && p.who === g.who && g.items[0].type !== 'question' && p.items[0].type !== 'question') p.items.push(...g.items); else out.push({ ...g, items: [...g.items] }); return out; }, []).map((g) => ({ ...g, items: collapseRepeats(g.items) }));
const needsYou = () => new Set([...(S.inbox || []).map((i) => i.nodeId), ...CH.asks]);
const avatarHtml = (id, working, ask) => { const w = who(id); return `<div class="avatar${w.human ? ' human' : ''}${working.has(id) ? ' working' : ''}${ask.has(id) ? ' ask' : ''}" style="background:${w.color}" title="${esc(w.name)}${working.has(id) ? ' · working' : ask.has(id) ? ' · needs you' : ''}">${esc(w.ini)}</div>`; };
const renderGroups = (events, working) => { const ask = needsYou(); return mergeGroups(Chat.group(events)).map((g) => { const w = who(g.who);
  return `<div class="cgroup${w.human ? ' self' : ''}">${avatarHtml(g.who, working, ask)}<div class="cbody"><div class="cname">${esc(w.name)}${w.role ? `<span class="role">${esc(w.role)}</span>` : ''}${w.human ? '' : vbadge((S.allNodes || []).find((n) => n.id === g.who))}<time>${new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>${g.items.map(bubble).join('')}</div></div>`; }).join(''); };
// Sticky "Your turn" bar above the composer: every pending ask_human question/approval.
function renderYourTurn(ev) {
  const seen = new Set((S.inbox || []).map((i) => i.id)); const items = [...(S.inbox || []), ...ev.filter((e) => e.type === 'question' && !seen.has(e.inboxId)).map((e) => ({ id: e.inboxId, nodeId: e.who, question: e.text, choices: e.choices, kind: 'question' }))]; const bar = $('#chat-yourturn'); bar.classList.toggle('hidden', !items.length);
  bar.innerHTML = items.length ? `<div class="yt-head"><span class="yt-badge">!</span><b>Your turn</b><span class="muted">${items.length} waiting</span></div>` + items.map((i) => `<div class="yt-item" data-iid="${i.id}"><b>${esc(nodeName(i.nodeId))}</b> <span>${esc(i.question)}</span><span class="spacer"></span>${(i.kind === 'approval' ? ['approve'] : i.choices || []).map((c) => `<button class="primary yt-choice" data-v="${esc(c)}">${esc(c)}</button>`).join('')}<input class="yt-ans" placeholder="${i.kind === 'approval' ? 'Request changes…' : 'Answer…'}"><button class="yt-send">Send</button></div>`).join('') : '';
  bar.querySelectorAll('.yt-item').forEach((d) => { const answer = (v) => act(async () => { if (!v) return; await call('answerInbox', d.dataset.iid, v); refresh(); })();
    d.querySelectorAll('.yt-choice').forEach((b) => b.onclick = () => answer(b.dataset.v)); d.querySelector('.yt-send').onclick = () => answer(d.querySelector('.yt-ans').value.trim());
    d.querySelector('.yt-ans').onkeydown = (e) => { if (e.key === 'Enter') answer(e.target.value.trim()); }; });
}
// "↓ N new" pill: only shown when the user has scrolled up and new messages arrived below the fold.
function updateNewPill() { const btn = $('#chat-newpill'); const n = CH.pendingNew || 0; btn.classList.toggle('hidden', n <= 0); if (n > 0) btn.querySelector('span').textContent = n; }
$('#chat-newpill').onclick = () => { const room = $('#chat-room'); room.scrollTop = room.scrollHeight; CH.pendingNew = 0; updateNewPill(); };
// Windowing (t_fb193107): only the last Chat.PAGE events are in the DOM; scrolling near the top
// prepends the next older page (anchored, no jump), and returning to the bottom shrinks again.
const chatGrow = () => { CH.win = (CH.win || Chat.PAGE) + Chat.PAGE; chatSig = null; renderChat(); };
$('#chat-room').addEventListener('scroll', () => { const room = $('#chat-room');
  if (room.scrollHeight - room.scrollTop - room.clientHeight < 40) { CH.pendingNew = 0; if ((CH.win || Chat.PAGE) > Chat.PAGE) { CH.win = Chat.PAGE; chatSig = null; renderChat(); } updateNewPill(); }
  else if (room.scrollTop < 80 && CH.ev && CH.ev.length > (CH.win || Chat.PAGE)) chatGrow(); });
// Skip-no-op renders (t_9d92c3d3): the feed signature is checked BEFORE the expensive roomEvents walk,
// so an unchanged room costs no DOM work at all. chatSig is reset to force a redraw (tab switch, send).
let chatSig = null;
function renderChat() {
  if (!$('#tab-chat.active')) return;
  const working = new Set(Object.keys(S.orch.agents || {}).filter((id) => S.orch.agents[id].status === 'working'));
  const L = projLogs();
  const sig = Chat.feedKey({ projectId: ctx.p, thread: CH.thread, logs: L, tasks: S.tasks, messages: S.messages, inbox: S.inbox, nodes: S.allNodes, working, agents: S.orch.agents, runs: RUNS });
  if (sig === chatSig) return;
  chatSig = sig;
  const ev = Chat.roomEvents(L, S.tasks, S.messages, S.inbox, Chat.MAX, subRecOf); // capped to the last Chat.MAX (500) events
  CH.ev = ev;
  CH.asks = ev.filter((e) => e.type === 'question').map((e) => e.who);
  $('#chat-typing').innerHTML = [...working].map((id) => { const wk = wakeLabel(id); return `<span class="typing"><span class="spin"></span>${esc(clipText(wk || `${who(id).name} is working`, 64))}<span class="dots"></span></span>`; }).join(' · ');
  renderYourTurn(ev);
  const room = $('#chat-room'); const atBottom = room.scrollHeight - room.scrollTop - room.clientHeight < 40;
  const prevH = room.scrollHeight, prevTop = room.scrollTop;
  const page = Chat.pageOf(ev, CH.win || Chat.PAGE);
  // The event list is a sliding window (capped at MAX), so ev.length alone can't count new arrivals —
  // count events newer than the previous tail instead.
  const delta = ev.filter((e) => e.at > (CH.evTailAt ?? -Infinity)).length;
  if (ev.length) CH.evTailAt = ev[ev.length - 1].at;
  room.innerHTML = page.items.length ? (page.hidden ? `<button id="chat-older" class="olderbar linklike">↑ ${page.hidden} earlier message${page.hidden === 1 ? '' : 's'} — scroll up or click to load</button>` : '') + renderGroups(page.items, working)
    : S.team.nodes.length ? `<div class="cempty"><b>#company is quiet</b>Type a goal below, or @mention an agent (e.g. <code>@${esc(S.team.nodes[0].name)} write hello.txt</code>).</div>` : '<div class="cempty"><b>No team yet</b>Create your team in the Team tab (or use the first-run guide), then chat with it here.</div>';
  if (atBottom) { CH.win = Chat.PAGE; room.scrollTop = room.scrollHeight; CH.pendingNew = 0; }
  else { room.scrollTop = Chat.anchorScroll(prevTop, prevH, room.scrollHeight); CH.pendingNew = (CH.pendingNew || 0) + delta; }
  const ob = $('#chat-older'); if (ob) ob.onclick = chatGrow;
  updateNewPill();
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
  i.value = ''; chatPreview(); chatSig = null; refresh();
}
$('#chat-input').addEventListener('input', chatPreview);
$('#chat-input').addEventListener('keydown', (e) => {
  const box = $('#chat-mentions'); const open = !box.classList.contains('hidden'); const items = box.querySelectorAll('div');
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); CH.mi = (CH.mi + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; chatPreview(); }
  else if (open && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pickMention(items[CH.mi].dataset.name); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); act(chatSend)(); }
});
$('#chat-send').onclick = act(chatSend);
document.querySelector('#tabs button[data-tab=chat]').addEventListener('click', () => setTimeout(() => { chatSig = null; renderChat(); }));
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
// Self-update status push: prefer the dedicated bridge method, fall back to either plausible channel name.
const onUpdPush = (d) => { upd = { ...normUpd(d), stub: false }; trackUpd(); renderSelfUpdate(); renderUpdSettings(); };
if (squad.onSelfUpdateStatus) squad.onSelfUpdateStatus(onUpdPush);
else { squad.on('selfUpdateStatus', onUpdPush); squad.on('self-update-status', onUpdPush); }
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
  g.classList.remove('hidden'); g.classList.toggle('mini', !G.forced && !G.open && ns.length > 0);
  if (g.classList.contains('mini')) { g.innerHTML = `<button id="g-open" title="Open the Get started guide">Get started <span class="muted">${[true, true, started].filter(Boolean).length}/3</span></button><button id="g-close" title="Dismiss">✕</button>`; $('#g-open').onclick = () => { G.open = true; renderGuide(); }; $('#g-close').onclick = () => { G.hidden = true; localStorage.setItem('guideHidden', '1'); renderGuide(); }; return; }
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
  $('#g-close').onclick = () => { G.open = false; if (ns.length && !G.forced) return renderGuide(); G.hidden = true; G.forced = false; localStorage.setItem('guideHidden', '1'); renderGuide(); };
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
