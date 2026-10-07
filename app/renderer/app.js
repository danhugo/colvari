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
let sel = { node: null, edge: null, task: null, page: null, logTeam: '', chatTeam: '', boardTeam: '' };
let connectFrom = null, connectMode = false, wikiEdit = false;
let bootTeam = true; // first fill only: Board/Chat team filters start on the sidebar team (t_ce954427)
const logs = [];
const logsLoaded = new Set(); // projects whose persisted logs.jsonl was merged into logs
async function loadLogs(pid) {
  if (logsLoaded.has(pid)) return; logsLoaded.add(pid);
  let saved = []; try { saved = await call('getLogs', 1500); } catch {}
  if (!Array.isArray(saved)) saved = [];
  const first = Math.min(...logs.filter((l) => l.projectId === pid).map((l) => l.at || 0), Infinity);
  logs.unshift(...saved.filter((l) => l && (l.at || 0) < first).map((l) => ({ ...l, projectId: pid, saved: true })));
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
// usageStatus feeds the top-bar limits chip, the alert bell and (on the Usage tab) the discovery
// and limits panels — one state event used to pay for it up to three times. All callers share one
// result per second instead (t_8d586961).
let usCache = null, usAt = 0;
const usageStatusOnce = async () => {
  if (usCache && Date.now() - usAt < 1000) return usCache;
  usAt = Date.now();
  try { usCache = await call('usageStatus'); } catch { usCache = null; }
  return usCache;
};
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
    // One batched round per state event (t_8d586961): these four snapshot calls used to run
    // back-to-back, each a full IPC round-trip on the hot path. nodeStatus/crossEdges keep the
    // old all-or-nothing fallback (either fails -> both keep the previous values).
    const [s, inbox, nstat, cross] = await Promise.all([
      call('getAll', since), call('listInbox'),
      call('nodeStatus').catch(() => null), call('crossEdges').catch(() => null),
    ]);
    s.inbox = inbox;
    s.nstat = nstat && cross ? nstat : (S.nstat || {});
    s.cross = nstat && cross ? cross : (S.cross || []);
    ctx.t = s.teamId;
    if (bootTeam && ctx.t) { bootTeam = false; sel.chatTeam = sel.boardTeam = ctx.t; } // boot: follow the sidebar team (t_ce954427) — boot never goes through switchTo(); empty ctx.t keeps the flag for a later refresh
    P = p; S = { ...S, ...s };
    lastV = s.v || v; lastVProject = ctx.p;
    runsChanged = !since || since.runs !== v.runs; // (assigns the module flag — a shadowing const here made every refresh reload runs.json)
  } catch (e) {
    ctx = prevCtx; console.warn('refresh failed, keeping previous data', e); return;
  }
  if (runsChanged) await loadRuns(); // runs.json (796KB) is re-read only when its file actually changed
  await Promise.all([loadLogs(ctx.p), loadSelfUpdate(), loadCoreState()]); // three independent round-trips, overlapped
  syncRtu(); // banner follows the snapshot across reloads / missed pushes
  chatBump(); // applied changes may cover the sections deltas do not carry (team/nodes) — the chat epoch must follow
  usCache = null; // this refresh changed state: the alerts/meter must read fresh usageStatus, not the 1s-shared result of a pre-change fetch (a stale hit rendered the limits chip hidden forever — no later render re-checks it; gui-e2e topbar red)
  try { localStorage.setItem('ctx', JSON.stringify(ctx)); } catch {}
  // Debounced draw (t_ae99a65e): refresh's full render joins the same coalesced queue the delta
  // path draws from, so the 2s backstop poll and the visibility catch-up no longer stack a second
  // full renderAll on a delta draw in the same frame while agents stream. Idle single-shot refreshes
  // (user actions) still draw on the scheduler's next tick — last + minMs is in the past, timeout 0.
  renderSched.bump();
}
const nodeName = (id) => (S.allNodes.find((n) => n.id === id) || {}).name || (id ? id : 'unassigned');
// Tab-scoped rendering (t_8d586961): renderAll draws the always-visible chrome plus ONLY the
// active tab's heavy view. Hidden tabs keep their DOM and render signature, so a revisit costs
// nothing when nothing changed, an incremental tail-append when only new lines arrived (obs), and
// a full rebuild only when the content really moved. Board / usage reset their
// signature on activation (TAB_RESIG below) so size-measuring views always redraw once visible.
// Same pixels on screen; state events stop paying for the tabs you cannot see.
const TAB_VIEW = {
  team: () => { renderGraph(); renderNodeForm(); },
  board: renderBoard,
  wiki: renderWiki,
  obs: () => { renderObs(); flushLogTail(); },
  usage: renderUsage,
  settings: renderSettings,
  inbox: renderInbox,
  chat: renderChat,
};
function renderAll() {
  renderChrome();
  drawActiveView(true);
}
// The sidebar Inbox badge is always-visible chrome: it tracks the inbox count on every render,
// not only while the inbox tab itself is drawn — an inline update inside renderInbox left the
// badge stale whenever items landed while another tab was active.
// Perf instrumentation (t_f6b343a5): ring of recent durations + slow-call count, inspect via
// window.__perf.inboxBadge — nothing is logged unless a call exceeds SLOW_MS.
const PERF = { inboxBadge: { samples: [], slow: 0, SLOW_MS: 2 }, logPane: { samples: [], slow: 0, SLOW_MS: 16 } };
// Leading+trailing debounce, same discipline as the usage ledger (t_6cbe12ed): the write itself is
// flat O(1) (perf t_476d3ba0), but tab clicks and direct chrome redraws can stack repeated badge
// writes while S.inbox churns; a burst coalesces into at most one write per window and the
// trailing call guarantees the last count lands. The badge is always-visible chrome, so unlike
// renderUsage there is no tab gate — quiet renders still draw at once.
const INBOX_BADGE_DEBOUNCE_MS = 100;
let badgeLastDraw = 0, badgeTimer = 0, badgeText = null;
function renderInboxBadge() {
  const draw = () => {
    const t0 = performance.now();
    // Text cache (t_2c20c0b0): #inbox-tab-badge is static chrome (index.html) whose only writes
    // happen here, so an unchanged count string can skip the textContent assignment entirely —
    // repeated chrome redraws cost no DOM invalidation; a count change writes as before.
    const text = (S.inbox || []).length ? String(S.inbox.length) : '';
    if (text !== badgeText) $('#inbox-tab-badge').textContent = badgeText = text;
    const ms = performance.now() - t0;
    const p = PERF.inboxBadge;
    p.samples.push(ms); if (p.samples.length > 120) p.samples.shift();
    if (ms > p.SLOW_MS) { p.slow++; console.debug('inbox badge render slow', ms.toFixed(2), 'ms'); }
  };
  const now = Date.now();
  if (now - badgeLastDraw >= INBOX_BADGE_DEBOUNCE_MS) {
    if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = 0; }
    badgeLastDraw = now;
    draw();
  } else if (!badgeTimer) {
    badgeTimer = setTimeout(() => { badgeTimer = 0; badgeLastDraw = Date.now(); draw(); }, INBOX_BADGE_DEBOUNCE_MS - (now - badgeLastDraw));
  }
}
window.__perf = PERF;
// The always-visible chrome (Perry's contract, t_8d586961): badges, counts and the restart chip
// track state even while their tab is hidden, so they draw synchronously everywhere. Only the
// heavy active-tab view may defer, and only on a revisit (see drawActiveView).
function renderChrome() {
  renderSidebar(); renderInboxBadge(); renderPreflightBar(); renderHeader(); renderSelfUpdate(); renderAlerts(); renderGuide();
}
// The active tab's view, tracked per tab so activation can tell "never drawn" (synchronous draw —
// no blank frame) from "DOM left over from the last visit" (draw after the activation paint: the
// click paints chrome over the still-correct old view instantly; the heavy rebuild — obs/chat run
// ~70ms while agents stream — lands one frame later, off the input->paint path, t_8d586961).
const TAB_PAINTED = new Set();
function drawActiveView(sync) {
  const name = ((document.querySelector('.tab.active') || {}).id || '').slice(4);
  const view = TAB_VIEW[name];
  if (!view) return;
  if (sync || !TAB_PAINTED.has(name)) { TAB_PAINTED.add(name); view(); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => { if ($('#tab-' + name).classList.contains('active')) { TAB_PAINTED.add(name); view(); } }));
}
const fmtTok = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n); };
const COST_NOTE = { subscription: 'Covered by subscription — not billed per token', other: 'API-equivalent (reported by Claude CLI)' };
const VENDOR = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const canCost = (rt) => { const r = ((S.config || {}).runtimes || {})[rt || 'claude']; return !r || !r.capabilities || r.capabilities.cost !== false; };
const vbadge = (n) => n ? `<span class="vbadge vb-${esc(n.runtime || 'claude')}" title="runtime · model">${esc(VENDOR[n.runtime || 'claude'] || n.runtime)}<i>${esc(n.model || 'default')}</i></span>` : '';
// t_e503dd78: log lines and status lines show a short id chip (t_8308) — the full title lives in the tooltip.
const shortTaskId = (id) => /^t_/.test(id || '') ? id.slice(0, 6) : (id || '');
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
  $('#rd-cancel').onclick = () => { rtDraft = null; renderSettings(true); };
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
  $('#teamlist').innerHTML = teams.map((t) => `<div data-tid="${t.id}" class="${t.id === ctx.t ? 'sel' : ''}"><i class="teamdot" style="background:var(--agent-${teamHue(t.id)})"></i>${esc(t.name)}</div>`).join('');
}
function switchTo(c) {
  if (c.p !== ctx.p) { if (!discardWikiEdit()) return; sel = { node: null, edge: null, task: null, page: null, logTeam: '', chatTeam: '', boardTeam: '' }; wikiEdit = false; wkBaseUpdated = null; $('#wk-title').value = ''; $('#wk-content').value = ''; }
  else sel = { ...sel, node: null, edge: null };
  connectFrom = null; connectMode = false; $('#connect').classList.remove('on');
  ctx = c;
  // A team click must always land visually: drop the cached version's team signatures so the refresh
  // below cannot short-circuit as "nothing changed" (sigs are size:mtime — two teams can share one)
  // and skip the re-render that moves the selection (t_93ffac88).
  if (lastV && c.t) { delete lastV.team; delete lastV.teams; }
  // The sidebar selection drives every team-scoped tab: sync the Logs tab's own team filter so
  // switching teams here is visible there too (the dropdown can still narrow it afterwards).
  // Chat and Board follow the same rule (t_1158f757): their selects reset to the clicked team.
  if (c.t && sel.logTeam !== c.t) { sel.logTeam = c.t; $('#logfilter').value = ''; }
  if (c.t && sel.chatTeam !== c.t) sel.chatTeam = c.t;
  if (c.t && sel.boardTeam !== c.t) sel.boardTeam = c.t;
  // refresh() mutates ctx (ctx.t = s.teamId) and ctx IS c, so the "was this a project switch?"
  // intent must be captured before the await — c.t is unreliable by the time the .then runs.
  const projectSwitch = !c.t;
  refresh().then(() => {
    if (projectSwitch && sel.logTeam !== (ctx.t || '')) { sel.logTeam = ctx.t || ''; $('#logfilter').value = ''; } // follow the auto-picked team
    if (projectSwitch) { sel.chatTeam = ctx.t || ''; sel.boardTeam = ctx.t || ''; syncRecovery(); } // each project carries its own boot-recovery story (t_6911ba60)
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
// Every element with data-tab switches tabs — the header nav, the sidebar Inbox row and the
// Settings gear all share the one active-state treatment (t_db67859d).
// Views that measure their size draw once per activation even when nothing changed while hidden:
// activation resets their render signature (t_9315f18a; board/usage, t_8d586961) so they
// never size against a hidden (0-width) layout. obs and chat keep their signatures instead: their
// DOM stays valid across the hide, so a revisit is a no-op when nothing moved, an incremental
// tail-append when only new log lines arrived (flushLogTail), and a full rebuild only on real
// content change. team/settings/inbox have no signature — renderAll rebuilds them whenever shown.
// wiki does keep one (t_9bb0596c): its list is plain DOM that stays valid across a hide, so with a
// signature the every-poll renderAll tick no longer rebuilds the page list (and re-wires its click
// handlers) when no page, search or selection moved.
const TAB_RESIG = {
  board: () => { boardSig = null; },
  obs: () => { obsSig = null; },
  usage: () => { usageSig = null; },
};
document.querySelectorAll('button[data-tab]').forEach((b) => b.onclick = () => {
  const wasActive = b.classList.contains('active');
  document.querySelectorAll('button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'team') { if (!wasActive) pinTeamMode(); } else unpinTeamMode(); // mode decided once per Team visit (t_d8e41e6a)
  (TAB_RESIG[b.dataset.tab] || (() => {}))();
  renderChrome();
  drawActiveView(false);
});

// ---------- header ----------
function renderHeader() {
  const o = S.orch; const par = o.running ? runningIds().length : 0;
  // Run-state pill (t_ac25444e), three distinct states off the orchestrator's runState contract
  // (t_b2273507): Running (agents at work), Idle (run on, nothing to do), Stopped (scheduler off —
  // with todo work waiting, the count shows too and the pill flags it). A stopped team with work
  // left used to read "idle" with no start control anywhere outside the New-goal popover.
  const rs = o.runState || (o.running ? { state: 'running' } : { state: 'stopped', reason: 'not started' });
  const todos = S.tasks.filter((t) => t.status === 'todo').length;
  const pill = $('#runstate');
  // Guarded writes (t_h0a1c2f9): these pills are rewritten on every renderAll tick while agents
  // stream; a same-value textContent assignment still dirties the header's layout, and the
  // layout-shift probe pinned recurring shifts on exactly these chips. Write only on change.
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const setTitle = (el, text) => { if (el.title !== text) el.title = text; };
  if (rs.state === 'running') {
    setText(pill, `Running (${par || 1})`); // short status chip (t_db67859d): full wording in the tooltip
    setTitle(pill, `running · ${par > 1 ? `${par} in parallel` : `${par || 1} agent`} · ${o.runs || 0} runs`);
  } else if (rs.state === 'idle') {
    setText(pill, 'Idle (nothing to do)');
    setTitle(pill, `idle · ${rs.reason || 'waiting for todo tasks'} · ${o.runs || 0} runs`);
  } else {
    setText(pill, todos ? `Stopped (${todos} todo)` : 'Stopped');
    setTitle(pill, `stopped — ${rs.reason || 'scheduler off'}${todos ? ` · ${todos} todo waiting` : ''} · Run (or ⌘⏎) starts the team`);
  }
  pill.classList.toggle('on', rs.state === 'running');
  pill.classList.toggle('halt', rs.state === 'stopped' && todos > 0);
  $('#stop').classList.toggle('hidden', rs.state === 'stopped'); // Stop stays in the bar while the run is on — running or idle (⌘. always works)
  $('#runbtn').classList.toggle('hidden', rs.state !== 'stopped'); // the visible way back while the scheduler is off
  setText($('#runbtn'), rs.state === 'stopped' && todos ? `${todos} task${todos === 1 ? '' : 's'} waiting — Run` : 'Run'); // the waiting count rides the button (t_bd295f0e)
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
  const costText = total > 0 ? `API-eq $${total.toFixed(2)}` : 'no cost yet';
  setText(c, costText);
  // An empty placeholder pill is dead weight in an already tight header — hide it until it has
  // something to say (the meter chips need every pixel at 1400px).
  c.classList.toggle('hidden', !(total > 0));
  c.classList.toggle('quiet', !(billed > 0));
  setTitle(c, total > 0
    ? `API-eq (API-equivalent) $${total.toFixed(4)} — what all recorded usage would cost at API list prices; the same single total the Usage tab's grand total shows. Actually billed per token (API key / proxy / cloud): $${billed.toFixed(4)}. Covered by subscription, not billed per token: $${sub.toFixed(4)}. "est" marks list-price estimates for keys that report no cost themselves.`
    : 'No recorded usage yet.');
  renderWatchPill();
}
// ---------- worktree disk pill (t_fe10d3e0; IPC by Devon, t_9b662983) ----------
// getDiskUsage -> { count, bytes } over <repo>/.squad/worktrees (du -sk, never follows symlinks,
// 30s cache server-side — so a 30s poll here is as fresh as the number gets). Amber above the cap
// (>20 worktrees or >2GB, warn only — no auto-delete). A core without the handler leaves the pill
// hidden instead of showing a wrong "0": bounded-disk visibility must not pretend on old cores.
const WT_DISK_CAP = { count: 20, bytes: 2 * 1024 ** 3 };
let wtDisk = null;
const fmtWtBytes = (n) => !(n > 0) ? '0 B'
  : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB`
  : n < 1073741824 ? `${Math.round(n / 1048576)} MB`
  : `${(n / 1073741824).toFixed(1)} GB`;
function renderWtDisk() {
  const c = $('#wtdisk'); if (!c) return;
  if (!wtDisk) { c.classList.add('hidden'); return; }
  const over = wtDisk.count > WT_DISK_CAP.count || wtDisk.bytes > WT_DISK_CAP.bytes;
  c.classList.remove('hidden');
  c.classList.toggle('wtwarn', over);
  const text = `${over ? '⚠ ' : ''}${wtDisk.count} wt · ${fmtWtBytes(wtDisk.bytes)}`;
  if (c.textContent !== text) c.textContent = text; // 30s poll: skip the write (and the header reflow) when the number didn't move
  const title = over
    ? `Worktrees above cap (>20 or >2GB): ${wtDisk.count} worktrees, ${fmtWtBytes(wtDisk.bytes)} in .squad/worktrees. Done+merged tasks are removed on merge; retained ones are flagged on their task.`
    : `.squad/worktrees: ${wtDisk.count} worktree${wtDisk.count === 1 ? '' : 's'}, ${fmtWtBytes(wtDisk.bytes)} of disk.`;
  if (c.title !== title) c.title = title;
}
async function pollWtDisk() { try { const d = await call('getDiskUsage'); if (d && typeof d === 'object') { wtDisk = d; renderWtDisk(); } } catch {} }
pollWtDisk(); setInterval(pollWtDisk, 30e3);
// ---------- core: restart-pending pill + "Core watching" indicator (plan t_42f310cf item 3, t_5a1661d5) ----------
// IPC contract (Devon, t_20d5a23c / t_74f1f65d): pull getRestartState / getWatchStatus + pushes on
// 'restart-state' / 'watch-status' (watch digests also arrive as kind:'watch' log lines). Until the
// backend lands this runs on the last known state, stub-marked like the self-update chip above —
// with nothing known, no pill shows at all rather than a wrong one.
let rst = { pendingCount: 0, since: null, scheduledAfter: null, scheduledNow: false, gating: [], waitingReasons: undefined, blockedReason: undefined, busyAgents: undefined, targetSha: null, stub: true };
let watch = { lastWatchAt: null, active: false, digest: '', intervalMin: 10, stub: true };
// Blocker lines for the popover. Devon's landed core shape (t_acae4863) is authoritative:
// blockedReason (one human line: anchor / drain with names / updater phase) + busyAgents. Absent
// fields mean an older core without any reason → the popover stubs; blockedReason === null means
// landed and nothing blocks — the next tick fires. waitingReasons stays as a defensive alias for
// the prose-array contract proposed on t_acae4863.
const normWaiting = (v) => !Array.isArray(v) ? undefined
  : v.map((r) => (typeof r === 'string' ? r : (r && (r.text || r.reason)) || '')).filter(Boolean);
// Defensive about the exact payload shape (pending/count vs pendingCount, afterTaskId vs
// scheduledAfter, gatedTaskIds vs gating, waitingReasons vs waiting.reasons).
const normRestart = (d) => { d = d || {}; return {
  pendingCount: Math.max(0, Number(d.pendingCount ?? d.pending ?? d.count) || 0),
  since: d.since || null,
  scheduledAfter: d.scheduledAfter || d.afterTaskId || null,
  scheduledNow: !!d.scheduledNow || d.now === true,
  gating: Array.isArray(d.gating) ? d.gating : Array.isArray(d.gatedTaskIds) ? d.gatedTaskIds : [],
  waitingReasons: normWaiting(d.waitingReasons ?? (d.waiting && d.waiting.reasons)),
  blockedReason: d.blockedReason === undefined ? undefined : (typeof d.blockedReason === 'string' && d.blockedReason ? d.blockedReason : null),
  busyAgents: Array.isArray(d.busyAgents) ? d.busyAgents.map(String).filter(Boolean) : undefined,
  targetSha: typeof d.targetSha === 'string' && d.targetSha ? d.targetSha : null,
}; };
const normWatch = (d) => { d = d || {}; return {
  lastWatchAt: d.lastWatchAt || d.at || null,
  active: d.active != null ? !!d.active : !!d.lastWatchAt,
  digest: String(d.digest || ''),
  intervalMin: Number(d.intervalMin) > 0 ? Number(d.intervalMin) : 10,
}; };
let rstSeen = false; // any successful pull or push proves the backend exists; a failed pull after that must not re-stub (buttons would vanish while real state is on screen)
async function loadCoreState() {
  try { let d; try { d = await squad.call('getRestartState', ctx); } catch { d = await squad.call('getRestartState'); } rst = { ...normRestart(d), stub: false }; rstSeen = true; }
  catch { if (!rstSeen) rst = { ...rst, stub: true }; } // no backend yet: keep the last known (stub) state
  try { let d; try { d = await squad.call('getWatchStatus', ctx); } catch { d = await squad.call('getWatchStatus'); } watch = { ...normWatch(d), stub: false }; }
  catch { watch = { ...watch, stub: true }; }
}
// A task is held by the restart gate if Devon's state lists it, or defensively via per-task flags.
const rstGated = (t) => rst.gating.includes(t.id) || t.restartGated === true || t.waitReason === 'restart';
const agoTxt = (ts) => { const a = ago(ts); return !a ? '' : a === 'now' ? 'just now' : `${a} ago`; };
// The restart-pending pill and its blocker popover (t_42f310cf/t_ec59eefa) became a bell alert row
// (t_6674705d); only the action survived. restartNow / cancelRestart (Devon, t_20d5a23c contract):
// the state push re-renders the bell; if the push is missed we re-pull getRestartState.
// Every click answers visibly (t_f8897886): the new-core result {status:'noop'|'scheduled'|'error',
// message, sha?} drives a toast (or the persistent "Restarting…" spinner while the restart drains);
// an old core without `status` gets the same feedback derived from the re-pulled state.
let rstBusy = null;
let rstToast = null; // the persistent "Restarting…" toast — outlives auto-expiring toasts, see rstRestarting()
const rstArmed = () => !!(rst.scheduledNow || rst.scheduledAfter);
const clearRstToast = () => { if (rstToast) { const d = rstToast; rstToast = null; d.remove(); } };
// The drain can outlast any auto-expiring toast, so "Restarting…" stays until the flow itself becomes
// visible (updater leaves idle: veil/pill take over), the schedule disarms, or the user clicks it.
function rstRestarting(what) {
  clearRstToast();
  const d = document.createElement('div'); d.className = 'toast';
  d.innerHTML = `<b>Restart</b><br><span class="spin"></span> ${esc(what || 'Restarting…')}`;
  d.onclick = () => { if (rstToast === d) rstToast = null; d.remove(); renderAlerts(); };
  $('#toasts').appendChild(d); rstToast = d;
  renderAlerts(); // the armed row's button flips to the spinner state at once
}
async function rstAction(kind) {
  if (rstBusy || rst.stub) return;
  if (upd.devMode === false) return; // dev-only control (t_7fbee55f): no restart machinery outside dev mode, whatever the state says
  rstBusy = kind; renderAlerts();
  const names = kind === 'now' ? ['restartNow', 'restartPendingNow'] : ['cancelRestart', 'cancelScheduledRestart'];
  let ok = false, res = null, err = null;
  for (const nm of names) {
    try { let r; try { r = await squad.call(nm, ctx); } catch { r = await squad.call(nm); } if (r && r.error) throw new Error(r.error); ok = true; res = r; break; }
    catch (e) { err = e; }
  }
  rstBusy = null;
  if (!ok) { showToast('Restart failed', (err && err.message) || 'not available'); renderAlerts(); return; }
  const status = res && typeof res === 'object' ? res.status : null;
  // sha comes from the result field when present; Devon's core (t_f6d37ca4) embeds it in the
  // message instead ("already running abc1234 — nothing to restart onto"), so parse it back out.
  const resSha = (r, m) => (typeof r.sha === 'string' && r.sha ? r.sha : (String(m || '').match(/\b[0-9a-f]{7,40}\b/i) || [])[0] || '');
  if (kind === 'now' && status === 'noop') {
    rst = { ...rst, pendingCount: 0, scheduledAfter: null, scheduledNow: false }; // the chip clears at once; the core's pending-cleared push confirms
    const sha = resSha(res, res.message).slice(0, 7);
    showToast('Restart', sha ? `Already running latest (${sha})` : (res.message || 'Already running latest'));
    renderAlerts();
  } else if (kind === 'now' && status === 'error') {
    showToast('Restart failed', res.message || 'restart failed');
  } else if (kind === 'now' && status === 'scheduled') {
    rstRestarting(res.message || 'Restarting…');
  } else if (kind === 'cancel') {
    clearRstToast();
  }
  await loadCoreState().catch(() => {});
  if (kind === 'now' && !status) { // legacy core (raw state, no result): read the fresh state instead
    const lsha = rst.targetSha && rst.pendingCount === 0 ? String(rst.targetSha).slice(0, 7) : '';
    if (rstArmed()) rstRestarting();
    else if (rst.pendingCount === 0) showToast('Restart', lsha ? `Already running latest (${lsha})` : 'Already running latest');
    else showToast('Restart', `Still ${rst.pendingCount} commit${rst.pendingCount === 1 ? '' : 's'} behind — restart did not arm`);
  }
  renderHeader(); renderAlerts();
}
// ---- blocker popover: removed with the restart pill (t_6674705d) — the bell row carries the state ----
function renderWatchPill() {
  const c = $('#watchst'); if (!c) return;
  const t = watch.lastWatchAt ? new Date(watch.lastWatchAt).getTime() : 0;
  // The loop goes idle-off when nothing is active; a fresh last check stays visible briefly.
  // Dev-only machinery (t_7fbee55f): the digest/restart loop exists only in dev builds — no pill
  // outside dev mode, whatever a stale state says.
  const live = upd.devMode !== false && (watch.active || (t && Date.now() - t < 30 * 60 * 1000));
  c.classList.toggle('hidden', !live);
  if (!live) return;
  c.className = 'pill watchst';
  c.textContent = `Core watching · last check ${agoTxt(watch.lastWatchAt) || '—'}`;
  c.title = ['The core agent (PM) receives a periodic status digest: restart backlog, stalled tasks, idle agents, merge failures.',
    watch.digest ? `Last digest: ${watch.digest}` : '', `Every ~${watch.intervalMin} min while work is active.`,
    'Click to see digests in the logs.', watch.stub ? 'backend pending' : ''].filter(Boolean).join(' ');
  c.onclick = () => showTab('obs');
}
setInterval(() => { const c = $('#watchst'); if (c && !c.classList.contains('hidden')) renderWatchPill(); }, 30e3); // keep "last check Xm ago" ticking without a run active
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
// st comes from renderAlerts (same usageStatus read feeds the limits-hit alert), so one IPC call per
// render feeds both the meter and the bell.
async function renderLimitMeter(st) {
  if (st === undefined) { try { st = await call('usageStatus'); } catch { st = null; } }
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
    return `<button type="button" class="lm-part lm-chip ${cls}${idle}" data-provider="${esc(p.provider)}" aria-label="${esc(prettyProvider(p.provider))} ${esc(w.label)} limit ${pct}%" title="${esc(prettyProvider(p.provider))}${p.plan ? ` · ${esc(p.plan)}` : ''} — ${esc(all)}">${head} ${state}<i class="lm-bar"><i class="lm-fill" style="width:${pct}%"></i></i>${ms > 0 ? `<small>↻${fmtCountdown(ms)}</small>` : ''}</button>`;
  };
  const provs = limitProviders(st);
  if (provs.length) {
    // The one provider the fixed-size summary chip names: paused > near limit > carries a real %
    // window > silent, ties broken by the highest single-window %.
    const rank = (p) => (p.pause ? 3 : p.warn ? 2 : p.windows.some((w) => w.pct != null) ? 1 : 0);
    const maxPct = (p) => Math.max(-1, ...p.windows.map((w) => (w.pct != null ? w.pct : -1)));
    const worst = provs.slice().sort((a, b) => rank(b) - rank(a) || maxPct(b) - maxPct(a))[0];
    // Top bar = warning chip only (t_ea33cef4): quiet under 80% / unknown; the Usage tab has the rest.
    const hot = worst.pause || worst.warn || maxPct(worst) >= 0.8;
    m.classList.toggle('hidden', !hot); m.innerHTML = hot ? worstChip(worst) : '';
    return;
  }
  if (!st || (!st.fiveHour.limit && !st.weekly.limit)) { m.classList.add('hidden'); m.innerHTML = ''; return; }
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
  const hot = worst.pause || worst.warn || worst.pct >= 0.8;
  m.classList.toggle('hidden', !hot);
  m.innerHTML = hot ? `<button type="button" class="lm-part lm-${cls}" aria-label="Claude ${esc(worst.label)} limit ${pct}%" title="${esc(title)}">Limits: ${state} <b>${esc(worst.label)}</b><i class="lm-bar"><i class="lm-fill" style="width:${pct}%"></i></i>${ms > 0 ? `<small>↻${fmtCountdown(ms)}</small>` : ''}</button>` : '';
}
function showTab(name) { if (name === 'overview') name = 'team'; // legacy id: Overview merged into Team (wiki decision-one-team-view)
  document.querySelector(`button[data-tab="${name}"]`)?.click(); }
// New goal composer (t_db67859d): the goal box lives in a popover off the "New goal" button, so the
// header holds context + actions only and nothing in it can truncate. Run keeps its id — the chat
// flow and the first-run guide set #goal and click #run programmatically (also gui-e2e autorun).
function openGoalPop() { $('#goalpop').classList.remove('hidden'); $('#goal').focus(); }
$('#newgoal').onclick = () => { const p = $('#goalpop'); if (p.classList.contains('hidden')) openGoalPop(); else { p.classList.add('hidden'); $('#newgoal').focus(); } };
document.addEventListener('mousedown', (e) => { const p = $('#goalpop'); if (!p.classList.contains('hidden') && !p.contains(e.target) && !$('#newgoal').contains(e.target)) p.classList.add('hidden'); });
$('#run').onclick = async (runAtts) => {
  runAtts = Array.isArray(runAtts) ? runAtts : null; // chatSend passes saved attachments; real clicks pass an Event
  const goal = $('#goal').value.trim();
  if (!S.team.nodes.length) { alert('Add at least one agent in the Team tab first.'); return showTab('team'); }
  if (goal) {
    const hasIn = new Set(S.team.edges.map((e) => e.to));
    const lead = S.team.nodes.find((n) => n.id === sel.node) || S.team.nodes.find((n) => !hasIn.has(n.id)) || S.team.nodes[0];
    await call('createTask', { title: goal.slice(0, 80), description: goal, assignee: lead.id, ...(runAtts ? { attachments: runAtts } : {}) }); $('#goal').value = '';
  } else if (!S.tasks.some((t) => t.status === 'todo')) { alert('Type a goal next to Run (or create a todo task in Board) first.'); return openGoalPop(); }
  const bad = S.allNodes.filter((n) => ['fail', 'untested', 'stale'].includes(pfState(n)));
  if (bad.length && !confirm(`Preflight not passed for ${bad.length} agent(s):\n${bad.map((n) => `- ${n.name}: ${n.preflightStatus === 'fail' ? 'FAILED' + (n.preflight && n.preflight.error ? ' (' + n.preflight.error.slice(0, 120) + ')' : '') : n.preflightStatus === 'stale' ? 'config changed since test' : 'untested'}`).join('\n')}\n\nRun anyway? (Use "Test team" in the Team tab to check them.)`)) return showTab('team');
  if (!$('#tab-chat.active')) showTab('obs'); await call('run'); refresh(); $('#goalpop').classList.add('hidden');
};
$('#stop').onclick = async () => { await call('stop'); refresh(); };
$('#runbtn').onclick = () => $('#run').click(); // header Run shares the popover's start flow — the same path ⌘⏎ takes

// ---------- team graph (design-tool editor: pan/zoom, drag-to-connect, minimap, auto-layout, context menu) ----------
const W = 184, H = 80, SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
let VP = { x: 20, y: 20, zoom: 1 }, vpTeam = null, vpSave = null, lastEdgeType = 'assign', linkDrag = null;
// Team-tied colour system (t_b590b876 regression): the colour belongs to the TEAM (its index
// among the project's teams, sorted by id — stable across machines, up to 8 distinct hues; hash
// fallback covers unknown/teamless ids) and EVERY agent surface wears exactly that one token —
// graph avatar disc + stripe, minimap, chat, board, logs, mentions, live card, editor face.
// The role-tinted roleBg() and per-member mix steps (t_300e8fd2) both broke the
// "avatar colour = team colour, same as the frame" rule (wiki UI Design Direction — Graph Editor).
const _teamHue = new Map(); let _teamHueSrc = null;
const teamHue = (teamId) => {
  if (!teamId) return 0;
  const teams = (S.project && S.project.teams) || [];
  if (teams !== _teamHueSrc) { _teamHue.clear(); _teamHueSrc = teams; } // self-invalidating: any project/team change swaps the array
  if (_teamHue.has(teamId)) return _teamHue.get(teamId);
  const i = teams.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).findIndex((t) => t.id === teamId);
  const hue = i < 0 ? 0 : (i % 8) + 1;
  _teamHue.set(teamId, hue);
  return hue;
};
// O(1) id → node/task indexes (t_94b8df1f): chat open/switch used to scan allNodes and the whole
// task list linearly per event — a grown 550-task board turned teamSwitch into a 139ms long task
// inside taskTeamOf. Both caches invalidate on array identity: refresh() swaps the arrays
// wholesale, deltas mutate entries in place, so an entry may trail one refresh cycle (the same
// tolerance the taskTitle memo accepted); misses (new/unknown ids) fall back to the linear scan
// and fill the cache in.
const _idx = {};
const nodeById = (id) => { if (_idx.nodes !== S.allNodes) { _idx.nodes = S.allNodes; _idx.nodeMap = new Map(); }
  let v = _idx.nodeMap.get(id); if (v === undefined) { v = S.allNodes.find((x) => x.id === id) || null; _idx.nodeMap.set(id, v); } return v; };
const taskById = (id) => { if (_idx.tasks !== S.tasks) { _idx.tasks = S.tasks; _idx.taskMap = new Map(); }
  let v = _idx.taskMap.get(id); if (v === undefined) { v = S.tasks.find((x) => x.id === id) || null; _idx.taskMap.set(id, v); } return v; };
const agentColor = (id) => {
  const n = nodeById(id);
  const hue = n ? teamHue(n.teamId) : 0;
  if (hue) return hue;
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 8) + 1;
};
// Step within the team (0-2 colour mix) — removed (t_b590b876): teammates must share one colour;
// identity comes from the DiceBear face (incl. the avatarSeed override, which changes the face only).
const agentVar = (id) => `var(--agent-${agentColor(id)})`;
// Team scoping (t_1158f757): one predicate shared by the Logs/Chat/Board team filters.
// team = '' (All teams) passes everything; an id that is not a team node never passes a
// real team — chat events get their own "no team anywhere stays visible" rule on top.
const nodeTeamOf = (id) => { const n = id ? nodeById(id) : null; return (n && n.teamId) || null; };
const teamScoped = (team, id) => !team || nodeTeamOf(id) === team;
const taskTeamOf = (tid) => { const t = tid ? taskById(tid) : null; return t ? nodeTeamOf(t.assignee) : null; };
const teamNameOf = (tid) => (((S.project || {}).teams) || []).find((t) => t.id === tid);
// Cross-team badge: small pill with the other team's name, tinted by its teamHue.
const teamBadge = (tid) => { const tm = teamNameOf(tid); const name = tm ? tm.name : tid;
  return `<span class="tbadge" data-testid="team-badge" data-team="${esc(tid)}" style="--tb:var(--agent-${teamHue(tid)})" title="${esc(name)}">${esc(name)}</span>`; };
// Per-view team select (Chat + Board headers): options are rebuilt only when the team set
// or the value changes, so the 1s render ticks never clobber an open dropdown.
const fillTeamSelect = (el, val, teams) => { if (!el) return; const sig = teams.map((t) => t.id).join() + '|' + (val || '');
  if (el.dataset.tsig === sig) return; el.dataset.tsig = sig;
  el.innerHTML = '<option value="">All teams</option>' + teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join(''); el.value = val || ''; };
// Leads/PMs read as circles vs the member squircle (avatarHtml adds the class).
const isLeadRole = (role) => /\b(pm|lead|manager|chief|director|head)\b/i.test(String(role || ''));
const edgeSeed = (e) => { let h = 0; for (const c of String(e.id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
// S.orch.agents is patched by every delta; S.nstat only by refresh() (which the delta path keeps quiet) — so 'working' comes from the live agents, nstat only adds needs-human.
const nodeLive = (n) => (S.orch.agents[n.id] || {}).status === 'working' ? 'working' : ((S.nstat || {})[n.id] || {}).status === 'needs-human' ? 'needs-human' : 'idle';
const applyVP = () => { const v = $('#graph > g.viewport'); if (v) v.setAttribute('transform', `translate(${VP.x},${VP.y}) scale(${VP.zoom})`); const gs = $('#graph'); if (gs) { gs.classList.toggle('lod-far', VP.zoom < 0.6); gs.style.setProperty('--nz', Math.max(1, 12 / (13 * VP.zoom)).toFixed(3)); } renderMinimap(); $('#zoomlvl') && ($('#zoomlvl').textContent = Math.round(VP.zoom * 100) + '%'); };
const saveVP = () => { clearTimeout(vpSave); vpSave = setTimeout(() => call('setViewport', VP).catch(() => {}), 400); };
const toWorld = (cx, cy) => { const r = $('#graph').getBoundingClientRect(); return [(cx - r.left - VP.x) / VP.zoom, (cy - r.top - VP.y) / VP.zoom]; };
function zoomAt(f, cx, cy) {
  const r = $('#graph').getBoundingClientRect(); cx ??= r.left + r.width / 2; cy ??= r.top + r.height / 2;
  const z = Math.min(2.5, Math.max(0.25, VP.zoom * f)); const [wx, wy] = toWorld(cx, cy);
  VP = { zoom: z, x: cx - r.left - wx * z, y: cy - r.top - wy * z }; applyVP(); saveVP();
}
function graphBox(nodes, withEdges = false) {
  if (!nodes.length) return { x: 0, y: 0, w: 400, h: 300 };
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  let x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs) + W, y1 = Math.max(...ys) + H;
  if (withEdges && edgeLayout && nodes.length > 1) for (const it of edgeLayout.per) { // edge routes (detours, dashed cross-team lines) count toward the fit box
    const nums = (it.geo.d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) { x0 = Math.min(x0, nums[i] - 8); x1 = Math.max(x1, nums[i] + 8); y0 = Math.min(y0, nums[i + 1] - 8); y1 = Math.max(y1, nums[i + 1] + 8); }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
let vpCount = 0, edgeLayout = null; // per-render edge geometry + DOM refs; patched in place by dragEdges during node drags
function fitIfClipped() { const r = $('#graph').getBoundingClientRect(); const b = graphBox(allGraphNodes(), true); if (r.width && (b.x * VP.zoom + VP.x < 0 || b.y * VP.zoom + VP.y < 0 || (b.x + b.w) * VP.zoom + VP.x > r.width || (b.y + b.h) * VP.zoom + VP.y > r.height)) fitView(); }
function fitView() {
  const r = $('#graph').getBoundingClientRect(); const b = graphBox(allGraphNodes(), true); const px = r.width * 0.075, py = r.height * 0.075; // fit fills ~85% of the canvas
  const z = Math.min(1, Math.max(0.7, Math.min((r.width - px * 2) / b.w, (r.height - py * 2) / b.h))); // never below 70%: pan instead
  VP = { zoom: z, x: b.w * z > r.width - px * 2 ? px - b.x * z : (r.width - b.w * z) / 2 - b.x * z, y: b.h * z > r.height - py * 2 ? py - b.y * z : (r.height - b.h * z) / 2 - b.y * z }; applyVP(); saveVP();
}
// ---------- graph view model: automatic layered tree + team clusters above CLUSTER_MIN agents ----------
// The stored x/y stay the user's manual layout; while graphAuto is on, the view lays the assign hierarchy
// out as a tidy top-down tree (lead on top, reports underneath). Past CLUSTER_MIN agents each lead's
// WHOLE group (assign-subtree + edge-attached reviewers, >=3 agents — grouping lives in src/graph-view.js)
// collapses into one cluster card (count + working/idle summary); click expands it.
let graphAuto = true, GV = null; const expandedClusters = new Set();
const liveOf = (n) => (n.cluster ? (n.members.some((m) => nodeLive(m) === 'working') ? 'working' : n.members.some((m) => nodeLive(m) === 'needs-human') ? 'needs-human' : 'idle') : nodeLive(n));
// Shared collapsed-group card for the Team and Overview graphs: stacked cards, member-count avatar,
// live member dots and a working/idle summary; onExpand unfolds the group back into member cards.
function drawClusterCard(g, n, onExpand) {
  const cnt = { working: 0, 'needs-human': 0, idle: 0 }; n.members.forEach((m) => { cnt[nodeLive(m) === 'working' ? 'working' : nodeLive(m) === 'needs-human' ? 'needs-human' : 'idle']++; });
  // Back cards peek straight DOWN only: side anchors exit at the main card's left/right edges, so a
  // diagonal stack would put its overhang under every edge start (and the card-crossing check).
  el('rect', { class: 'card stack2', width: W, height: H, rx: 12, x: 0, y: 10 }, g); el('rect', { class: 'card stack1', width: W, height: H, rx: 12, x: 0, y: 5 }, g); el('rect', { class: 'card', width: W, height: H, rx: 12 }, g);
  const c = agentColor(n.head); el('circle', { class: 'avatar', cx: 30, cy: 26, r: 14, style: `fill:var(--agent-${c})` }, g); el('text', { x: 30, y: 30.5, class: 'avtext', 'text-anchor': 'middle' }, g).textContent = n.members.length;
  el('text', { x: 52, y: 23, class: 'nname' }, g).textContent = clipText(n.name, 18); el('text', { x: 52, y: 38, class: 'nrole' }, g).textContent = n.role + ' · expand';
  n.members.slice(0, 16).forEach((m, i) => el('circle', { class: 'mdot s-' + nodeLive(m), cx: 16 + i * 10, cy: 54, r: 3.5 }, g));
  el('text', { x: 12, y: 72, class: 'clsum' }, g).textContent = [cnt.working && cnt.working + ' working', cnt['needs-human'] && cnt['needs-human'] + ' needs you', cnt.idle && cnt.idle + ' idle'].filter(Boolean).join(' · ');
  el('title', {}, g).textContent = n.members.map((m) => `${m.name} — ${nodeLive(m)}`).join('\n');
  g.style.cursor = 'pointer'; g.onclick = (ev) => { ev.stopPropagation(); onExpand(); };
}
// Tidy top-down tree over assign edges (the engine behind graphAuto and the Auto-layout button).
// One parent per node — the first assign edge wins; later ones are ignored. Roots (no assign
// parent) place left-to-right, core agents first; children place recursively and a parent is
// centred over its first/last child. More than 5 all-leaf reports wrap under their lead into a
// 5-wide block instead of one endless row. Agents with no assign edges, plus anything not reached
// from a root, wrap into a near-landscape grid balanced toward the canvas aspect ratio. Spacing:
// GX = card width + 36, GY = card height + 64. Pure layout — the stored x/y stay the user's
// manual layout; the result is applied per render only while graphAuto is on. The same algorithm
// also lives (shared + instrumented) in app/src/graph-view.js as layoutTree/treeLayout, which
// test/graph-view.test.js exercises; this renderer copy is the one buildView actually calls.
// Cache (t_38aa0017): buildView re-runs the layout on every render while graphAuto is on, but it
// is a pure function of the visible ids (core flag included), the assign edges and the canvas
// aspect — an unchanged signature reuses the last position map instead of re-placing every node.
let tlCache = { sig: '', pos: null };
function treeLayout(nodes, edges) {
  const cr = ($('#graph') || {}).getBoundingClientRect ? $('#graph').getBoundingClientRect() : { width: 0 }, asp = cr.width && cr.height ? cr.width / cr.height : 1.6;
  const sig = nodes.map((n) => n.id + (n.core ? '*' : '')).join() + '|' + edges.filter((e) => (e.type || 'assign') === 'assign').map((e) => e.from + '>' + e.to).join() + '|' + asp.toFixed(3);
  if (tlCache.sig === sig) return tlCache.pos;
  const ids = new Set(nodes.map((n) => n.id)), kids = {}, hasParent = new Set(); const GX = W + 36, GY = H + 64, pos = {};
  for (const e of edges) if ((e.type || 'assign') === 'assign' && ids.has(e.from) && ids.has(e.to) && e.from !== e.to && !hasParent.has(e.to)) { (kids[e.from] ||= []).push(e.to); hasParent.add(e.to); }
  const seen = new Set();
  const place = (id, x0, y) => {
    seen.add(id); const ks = (kids[id] || []).filter((k) => !seen.has(k));
    if (!ks.length) { pos[id] = { x: x0, y }; return GX; }
    if (ks.length > 5 && ks.every((k) => !(kids[k] || []).length)) { // many leaf reports: wrap into a 5-wide block
      const cols = 5; ks.forEach((k, i) => { seen.add(k); pos[k] = { x: x0 + (i % cols) * GX, y: y + GY + Math.floor(i / cols) * (H + 26) }; });
      pos[id] = { x: x0 + (Math.min(cols, ks.length) - 1) * GX / 2, y }; return Math.min(cols, ks.length) * GX;
    }
    let x = x0; for (const k of ks) if (!seen.has(k)) x += place(k, x, y + GY);
    const first = pos[ks[0]].x, last = pos[ks[ks.length - 1]].x; pos[id] = { x: (first + last) / 2, y }; return Math.max(GX, x - x0);
  };
  const roots = nodes.filter((n) => !hasParent.has(n.id)).sort((p, q) => (q.core ? 1 : 0) - (p.core ? 1 : 0)); let x = 40;
  // Unconnected agents wrap into a near-landscape grid instead of one long row (a row of 12 fits at 25% zoom).
  const loners = roots.filter((r) => !(kids[r.id] || []).length);
  for (const r of roots) if ((kids[r.id] || []).length) x += place(r.id, x, 40);
  const rest = loners.concat(nodes.filter((n) => !pos[n.id] && !loners.includes(n))).filter((n) => !pos[n.id]);
  let cols = rest.length > 4 ? Math.max(3, Math.ceil(Math.sqrt(rest.length * asp * 0.55))) : rest.length; if (rest.length > 4) cols = Math.ceil(rest.length / Math.ceil(rest.length / cols)); // balanced rows (12 -> 4x3)
  rest.forEach((n, i) => { pos[n.id] = { x: x + (i % cols) * GX, y: 40 + Math.floor(i / cols) * (H + 40) }; });
  tlCache = { sig, pos };
  return pos;
}
function buildView() {
  const real = S.team.nodes;
  const cv = GraphView.clusterView(real, S.team.edges, expandedClusters);
  const nodes = cv.nodes;
  const edges = GraphView.mapEdges([...S.team.edges, ...(S.cross || []).filter((e) => !S.team.edges.some((x) => x.id === e.id))], cv.remap);
  if (graphAuto && nodes.length) { const p = treeLayout(nodes, edges.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))); for (const n of nodes) { n.x = p[n.id].x; n.y = p[n.id].y; } }
  GV = { nodes, edges, clustered: nodes.some((n) => n.cluster) };
}
// Nodes from other teams linked by cross-team edges, shown as dashed ghosts beside the graph.
function ghostNodes() {
  const vis = GV ? GV.nodes : S.team.nodes; const mine = new Set(S.team.nodes.map((n) => n.id)); const b = graphBox(vis); const out = new Map();
  for (const e of S.team.edges) if (!mine.has(e.to) && !out.has(e.to)) out.set(e.to, { id: e.to, side: 1 });
  for (const e of S.cross || []) if (!mine.has(e.from) && !out.has(e.from)) out.set(e.from, { id: e.from, side: -1 });
  let r = 0, l = 0;
  return [...out.values()].map((g) => ({ ...g, ghost: true, name: nodeName(g.id), role: 'other team', x: g.side > 0 ? b.x + b.w + 120 : b.x - W - 120, y: b.y + (g.side > 0 ? r++ : l++) * (H + 40) }));
}
const allGraphNodes = () => [...(GV ? GV.nodes : S.team.nodes), ...ghostNodes()];
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
  if (!r) { const { p1, p2 } = anchors(), rail = (p1[0] + p2[0]) / 2 + off; return { d: orthPath([p1, [rail, p1[1]], [rail, p2[1]], p2].map(P)), mid: P([rail, (p1[1] + p2[1]) / 2]), n: flip ? [1, 0] : [0, 1] }; }
  return { d: orthPath(r.pts.map(P)), mid: P(r.mid), n: flip ? [r.n[1], r.n[0]] : r.n };
}
const overlaps = (r, q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h;
// ---------- team watch/edit modes (wiki decision-one-team-view) ----------
// One Team view: Watch (read-only, default whenever any agent is running) and Edit (explicit
// toggle, `E` shortcut). The user's explicit choice sticks — no auto-return to Watch.
let teamModePref = null; // null = follow the default (TeamModes.resolveMode)
const teamRunning = () => runningIds().length > 0;
const teamMode = () => TeamModes.resolveMode(teamModePref, teamRunning());
const teamCan = () => TeamModes.can(teamMode());
// Mode is decided ONCE per visit: pinned at team-tab entry from the then-running state, so an
// agent starting/stopping mid-visit never flips the mode under the cursor (t_d8e41e6a). Leaving
// the tab clears the pin so the next visit re-decides; only explicit chip/E clicks change it.
function pinTeamMode() { teamModePref = TeamModes.resolveMode(null, teamRunning()); watchDragToasted = false; }
function unpinTeamMode() { teamModePref = null; }
function setTeamMode(m) {
  if (teamModePref === m) return;
  teamModePref = m;
  renderGraph(); renderNodeForm(); // re-gate the graph + swap the inspector to/from the live card
}
// Watch: a locked node must explain itself — the grab cursor invites the drag, and the FIRST
// blocked attempt toasts once per visit (no spam, no modal); a plain click still selects.
let watchDragToasted = false;
const showToast = (title, body, spin) => { const d = document.createElement('div'); d.className = 'toast'; d.innerHTML = (title ? `<b>${esc(title)}</b><br>` : '') + (spin ? '<span class="spin"></span>' : '') + esc(body); d.onclick = () => d.remove(); $('#toasts').appendChild(d); setTimeout(() => d.remove(), 6000); };
function startWatchDrag(ev, n) {
  const sx = ev.clientX, sy = ev.clientY; let moved = false;
  const mv = (e) => { if (moved || Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) <= 2) return; moved = true;
    if (!watchDragToasted) { watchDragToasted = true; showToast('Watch mode', 'Press E to edit — the team can’t be changed while watching'); } };
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); if (!moved) selectNode(n.id); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
// Deep-link from the graph screen into Chat: the agent's current task thread when it has one
// (that is where its updates land), the #company room otherwise.
const openNodeInChat = (id) => {
  const a = S.orch.agents[id] || {}; const t = a.taskId ? S.tasks.find((x) => x.id === a.taskId) : null;
  CH.thread = t ? t.id : null; showTab('chat'); chatSched.force();
};
function applyTeamModeChrome() {
  const tc = teamCan(); const on = (sel, dis) => { const b = $(sel); if (b) b.disabled = !!dis; };
  on('#addnode', !tc.add); on('#connect', !tc.connect); on('#edgetype', !tc.connect); on('#delsel', !tc.del); on('#autolayout', !tc.layout);
  const gm = teamMode();
  $('#mode-watch').classList.toggle('on', gm === 'watch'); $('#mode-edit').classList.toggle('on', gm === 'edit');
  $('#mode-watch').setAttribute('aria-pressed', String(gm === 'watch')); $('#mode-edit').setAttribute('aria-pressed', String(gm === 'edit'));
  const note = $('#mode-note'); if (note) note.classList.toggle('hidden', !(gm === 'edit' && teamRunning())); // inline note, no modal
  const hint = $('#hint'); if (hint) hint.textContent = tc.menu
    ? 'Drag a node\'s handle to connect · right-click for actions · scroll to pan, ⌘/pinch to zoom'
    : 'Watch mode — live status only · click a node for its live card · scroll to pan, ⌘/pinch to zoom';
  $('#graph').classList.toggle('watch', !tc.menu);
  const an = $('#addnode'); if (an) an.title = tc.add ? 'Add agent (or right-click the canvas)' : 'Switch to Edit team to add agents';
}
$('#mode-watch').onclick = () => setTeamMode('watch');
$('#mode-edit').onclick = () => setTeamMode('edit');
function renderGraph() {
  if (!$('#tab-team').classList.contains('active')) return; // hidden tab: redrawn on activation (renderAll / TAB_RESIG)
  const tc = teamCan(); applyTeamModeChrome();
  const svg = $('#graph'); svg.innerHTML = ''; buildView();
  if (vpTeam !== ctx.t) { vpTeam = ctx.t; vpCount = 0; } // first open always re-fits (once visible, see below) — a persisted viewport can be stale (tiny/panned away)
  const defs = el('defs', {}, svg);
  for (const t of ['assign', 'message', 'review', 'sel']) { const m = el('marker', { id: 'arr-' + t, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, defs); el('path', { d: 'M0,1 L9,5 L0,9 z', class: 'arrow arrow-' + t }, m); }
  // One shared round mask (objectBoundingBox → scales to every node's <image>) for the DiceBear faces.
  el('circle', { cx: 0.5, cy: 0.5, r: 0.5 }, el('clipPath', { id: 'avclip-team', clipPathUnits: 'objectBoundingBox' }, defs));
  const vp = el('g', { class: 'viewport' }, svg); const eL = el('g', { class: 'edges' }, vp), nL = el('g', { class: 'nodes' }, vp), xL = el('g', { class: 'edges cross-layer' }, vp), lL = el('g', { class: 'labels' }, vp); // cross-team edges draw above nodes so the dashed line into the ghost stays visible
  const nodes = allGraphNodes(); const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = GV.edges;
  const pairN = {}, pairI = {}; const pk = (e) => [e.from, e.to].sort().join('|'); edges.forEach((e) => { pairN[pk(e)] = (pairN[pk(e)] || 0) + 1; });
  const srcN = {}, srcI = {}; edges.forEach((e) => { srcN[e.from] = (srcN[e.from] || 0) + 1; });
   const blocks = nodes.map((n) => ({ x: n.x - 4, y: n.y - 4, w: W + 8, h: (n.cluster ? H + 16 : H + 8) })); const pills = []; // cluster blocks include the stacked-cards peek below the card
   // open (non-done) task count per assignee — surfaces routing skew on the node cards
   const openCnt = {}; for (const t of (S.tasks || [])) if (t.status !== 'done' && t.assignee) openCnt[t.assignee] = (openCnt[t.assignee] || 0) + 1;
   edgeLayout = { nodes, blocks, per: [] };
  for (const e of edges) {
    const a = byId[e.from], b = byId[e.to]; if (!a || !b) continue;
    const key = pk(e); const i = (pairI[key] = (pairI[key] ?? -1) + 1); const cnt = pairN[key];
    const sign = e.from < e.to ? 1 : -1; const lane = (srcI[e.from] = (srcI[e.from] ?? -1) + 1); const off = (i - (cnt - 1) / 2) * 22 * sign + (lane - ((srcN[e.from] || 1) - 1) / 2) * 14;
    const type = e.type || 'assign'; const cross = !!(e.crossTeam || a.ghost || b.ghost); const g = edgeGeom(a, b, off, blocks, edgeSeed(e));
    const isSel = sel.edge === e.id;
    const L = cross ? xL : eL; const hit = el('path', { d: g.d, class: 'edgehit' }, L);
    const ep = el('path', { d: g.d, class: `edge edge-${type}` + (type === 'assign' ? ' primary' : ' secondary') + (byId[e.to] && !byId[e.to].ghost && liveOf(byId[e.to]) === 'working' ? ' active' : '') + (cross ? ' cross' : '') + (isSel ? ' sel' : ''), 'marker-end': `url(#arr-${isSel ? 'sel' : type})`, 'data-id': e.id }, L);
    // Label pill at the curve midpoint, nudged along the normal until it clears nodes and other pills.
    // At far zoom (lod-far, <0.6) every pill is one more strand in the tangle — the edge colour and the
    // legend already carry the type, so pills drop out unless the edge is selected (t_1c907493).
    const pick = (ev) => { ev.stopPropagation(); hideMenus(); sel = { ...sel, edge: e.id, node: null }; renderGraph(); renderNodeForm(); };
    const pg = isSel ? (() => { // label pills only for the selected edge: colour + legend carry the type, hover reveals the rest
      const label = type + (cross ? ' · cross-team' : ''); const pw = 10 + label.length * 5.8, ph = 16;
      let [px, py] = g.mid; for (let s = 0, r = { x: px - pw / 2, y: py - ph / 2, w: pw, h: ph }; s < 12 && [...blocks, ...pills].some((q) => overlaps(r, q)); s++) { const d = (s % 2 ? -1 : 1) * Math.ceil((s + 1) / 2) * 12; px = g.mid[0] + g.n[0] * d; py = g.mid[1] + g.n[1] * d; r = { x: px - pw / 2, y: py - ph / 2, w: pw, h: ph }; }
      pills.push({ x: px - pw / 2, y: py - ph / 2, w: pw, h: ph });
      const pg = el('g', { class: `epill epill-${type}` + (isSel ? ' sel' : ''), transform: `translate(${px - pw / 2},${py - ph / 2})` }, lL);
      el('rect', { width: pw, height: ph, rx: ph / 2 }, pg); el('text', { x: pw / 2, y: 11.5, 'text-anchor': 'middle' }, pg).textContent = label;
      return pg;
    })() : null;
    edgeLayout.per.push({ e, a, b, off, geo: g, pw: 0, ph: 0, hit, path: ep, pill: pg });
    if (tc.menu) { // Watch: edges are not selectable/editable
      hit.onclick = pick; if (pg) pg.onclick = pick;
      hit.oncontextmenu = (ev) => { pick(ev); ev.preventDefault(); edgeMenu(ev, e); };
      if (pg) pg.oncontextmenu = hit.oncontextmenu;
    }
  }
  for (const n of nodes) {
    if (n.ghost) { const g = el('g', { class: 'ghost', transform: `translate(${n.x},${n.y})` }, nL); el('rect', { width: W, height: H, rx: 12 }, g); el('text', { x: 14, y: 28, class: 'nname' }, g).textContent = clipText(n.name, 22); el('text', { x: 14, y: 46, class: 'nrole' }, g).textContent = 'in another team'; continue; }
    if (n.cluster) {
      const lv = liveOf(n); const g = el('g', { class: 'node cluster st-' + lv, transform: `translate(${n.x},${n.y})`, 'data-id': n.id }, nL);
      drawClusterCard(g, n, () => { expandedClusters.add(n.head); renderGraph(); fitView(); });
      continue;
    }
    const live = nodeLive(n); const ns = (S.nstat || {})[n.id] || {}; const c = agentColor(n.id);
    const g = el('g', { class: 'node' + (sel.node === n.id || connectFrom === n.id ? ' sel' : '') + ' st-' + live + (live === 'working' ? ' working' : '') + (rtuFor(n.id) ? ' rtpaused' : ''), transform: `translate(${n.x},${n.y})`, 'data-id': n.id }, nL);
    el('rect', { class: 'card', width: W, height: H, rx: 12 }, g);
    el('rect', { class: 'stripe', width: 4, height: H - 20, x: 0, y: 10, rx: 2, style: `fill:${agentVar(n.id)}` }, g);
    el('circle', { class: 'avatar', cx: 30, cy: 26, r: 14, style: `fill:${agentVar(n.id)};--av:${agentVar(n.id)}` }, g);
    if (isLeadRole(n.role)) el('text', { x: 40, y: 37, class: 'leadstar', 'text-anchor': 'middle' }, g).textContent = '★';
    el('image', { class: 'avface', href: faceUri(n.id), x: 16, y: 12, width: 28, height: 28, 'clip-path': 'url(#avclip-team)' }, g);
    el('text', { x: 52, y: 23, class: 'nname' }, g).textContent = clipText(n.name, Math.max(6, Math.round(16 / Math.max(1, 11 / (13 * VP.zoom)))));
    el('text', { x: 52, y: 38, class: 'nrole' }, g).textContent = clipText(n.role, 20);
    const rtId = ns.runtime || n.runtime || 'claude';
    // Chip row wraps to a second line when it would run into the card edge or the subagent badge
    // (row 1 reserves the badge's corner; the badge itself sits in row 1's band, right-aligned).
    const sub = Subagents.badge(S.orch.agents[n.id] || {});
    const sb = sub.count ? subBadgeInfo(sub) : null;
    let cx = 12, cy = 46;
    const putChip = (text, max, cls, title) => { const t = clipText(text, max); const w = 10 + t.length * 5.6; const lim = cy === 46 && sb ? W - sb.w - 12 : W - 10; if (cx + w > lim && cx > 12) { cx = 12; cy = 62; } const cg = el('g', { class: cls, transform: `translate(${cx},${cy})` }, g); if (title) el('title', {}, cg).textContent = title; el('rect', { width: w, height: 14, rx: 7 }, cg); el('text', { x: w / 2, y: 10.5, 'text-anchor': 'middle' }, cg).textContent = t; cx += w + 4; };
    if (VP.zoom >= 0.6) { const oc = openCnt[n.id] || 0; if (oc) putChip(`${oc} open`, 12, 'chip chip-load', `${oc} open task${oc === 1 ? '' : 's'} assigned to ${n.name}`); else putChip('idle', 6, 'chip chip-idle', `${n.name} has no open tasks`); }
    if (VP.zoom >= 0.6) for (const chip of [runtimeLabel(rtId), ns.model || n.model || 'default'].filter(Boolean)) putChip(chip, 14, 'chip');
    if (VP.zoom >= 0.6 && rtId !== 'claude') { const rows = ((S.orch.ledger || {}).byAgent || {})[n.name] || []; const cost = rows.reduce((c, r) => c + (r.costUsd || 0), 0);
      putChip(rows.length ? `$${cost.toFixed(2)} · ${rows.length} key${rows.length === 1 ? '' : 's'}` : 'no usage', 20, 'chip chip-usage', rows.length ? `${runtimeLabel(rtId)} usage, per model key (tokens are never summed across models): ${rows.map((r) => `${r.model}: ${r.runs} run(s) · ${r.costUsd != null ? '$' + r.costUsd.toFixed(4) + (r.costSource === 'estimated' ? ' est' : '') : 'cost —'}`).join(' · ')}` : `${runtimeLabel(rtId)} has no recorded usage yet`); }
    const effort = n.effort || 'low';
    if (VP.zoom >= 0.6) for (const chip of [`E:${effort}`, n.autoCompact ? `AC:${n.autoCompact}` : null].filter(Boolean)) { const isDefaultEffort = chip === `E:${effort}` && !n.effort; putChip(chip, 14, 'chip chip-em' + (isDefaultEffort ? ' chip-default' : ''), chip.startsWith('E:') ? `Reasoning effort: ${effort}${isDefaultEffort ? ' (default)' : ''}` : `Auto-compact window: ${n.autoCompact}`); }
    if (VP.zoom >= 0.6 && n.createdBy && !n.core) putChip('recruited', 10, 'chip chip-recruited', 'Recruited by ' + nodeName(n.createdBy));
    const capsSt = !n.capabilities ? 'none' : (n.capabilities.error || n.capabilities.ok === false) ? 'error' : 'ok';
    const cb = el('g', { class: 'capsdot caps-' + capsSt, transform: `translate(7,${H - 8})` }, g); el('circle', { r: 4 }, cb);
    el('title', {}, cb).textContent = capsSt === 'none' ? 'Capabilities not probed yet' : capsSt === 'error' ? 'Capability probe failed' : `Capabilities probed${n.capabilitiesProbedAt ? ' ' + new Date(n.capabilitiesProbedAt).toLocaleString() : ''}`;
    const sg = el('g', { class: 'status s-' + live, transform: `translate(${W - 16},16)` }, g); el('circle', { r: 6 }, sg); el('title', {}, sg).textContent = live;
    const sp = el('g', { class: 'stpill sp-' + live, transform: `translate(${W - 78},-8)` }, g); const spi = el('g', { class: 'stpillin' }, sp); el('rect', { width: 70, height: 16, rx: 8 }, spi); el('text', { x: 35, y: 12, 'text-anchor': 'middle' }, spi).textContent = live === 'working' ? '● Working' : live === 'needs-human' ? '● Needs you' : 'Idle';
    const pres = el('g', { class: 'pres ' + presence(n.id), transform: `translate(${W - 16},16)` }, g); el('circle', { r: 8 }, pres);
    const pf = pfState(n);
    const badge = el('g', { class: 'pfbadge pf-' + pf, transform: `translate(${W - 34},16)` }, g);
    el('title', {}, badge).textContent = pf === 'fail' && n.preflight ? 'Preflight failed: ' + n.preflight.error : 'Preflight: ' + PF_LABEL[pf];
    el('circle', { r: 3.5 }, badge);
    if (n.core) { const cl = el('g', { class: 'corelock', transform: 'translate(10,-8)' }, g); el('title', {}, cl).textContent = 'Core agent — protected; recruits and retires teammates'; el('rect', { width: 46, height: 15, rx: 7 }, cl); el('text', { x: 23, y: 11, 'font-size': 9, 'text-anchor': 'middle' }, cl).textContent = '🔒 core'; }
    if (live === 'working' && typeof ns.contextPct === 'number') {
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
    // stall badge outranks it: a stalled run must not read as one still working; pending-wake is lowest rank
    const st = stallState(n.id); const pu = rtuFor(n.id);
    if (st) drawStallBadge(g, st, () => openWakeTask(st.taskId));
    else if (pu) drawRtuBadge(g, pu);
    else { const wk = wakeRun(n.id); if (wk) drawWakeBadge(g, wk, () => openWakeTask(wk.taskId)); else { const wp = wakePending(n.id); if (wp) drawPendingBadge(g, wp); } }
    drawSubBadge(g, S.orch.agents[n.id] || {}, 46);
    el('title', {}, g).textContent = `${n.name} (${n.role}) — ${live} · ${(openCnt[n.id] || 0) ? `${openCnt[n.id]} open task${openCnt[n.id] === 1 ? '' : 's'}` : 'idle'}`;
    if (typeof ns.contextPct === 'number' && live === 'working') {
      const pct = Math.max(0, Math.min(100, ns.contextPct * 100));
      const cls = pct >= 85 ? 'danger' : pct >= (S.settings.autoCompactPct || 40) ? 'warn' : 'ok';
      const ctxg = el('g', { class: 'ctxbar', transform: `translate(0,${H - 4})` }, g);
      el('rect', { class: 'ctxbar-bg', width: W, height: 4 }, ctxg);
      el('rect', { class: 'ctxbar-fill ctx-' + cls, width: W * pct / 100, height: 4 }, ctxg);
      el('title', {}, ctxg).textContent = `${Math.round(pct)}% ctx · ${fmtTok(ns.contextTokens || 0)} / ${fmtTok(ns.contextWindow || 0)} tokens`;
    }
    // hover quick actions (edit-only; Delete hidden on protected nodes — unprotect in the editor first)
    if (tc.rename) {
      const qacts = [['✎', 'Edit', () => selectNode(n.id)], ['⧉', 'Duplicate', () => duplicateNode(n)], ['→', 'Connect from here', () => startConnect(n)], ...(!n.protected ? [['✕', 'Delete', () => deleteNode(n)]] : [])];
      const qa = el('g', { class: 'qacts', transform: `translate(${W - qacts.length * 26},-30)` }, g);
      qacts.forEach(([ic, tip, fn], k) => {
        const b = el('g', { class: 'qa', transform: `translate(${k * 26},0)` }, qa); el('rect', { width: 24, height: 22, rx: 6 }, b); el('text', { x: 12, y: 15.5, 'text-anchor': 'middle' }, b).textContent = ic; el('title', {}, b).textContent = tip;
        b.onmousedown = (ev) => ev.stopPropagation(); b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      });
    }
    if (tc.connect) { const h = el('circle', { class: 'handle', cx: W, cy: H / 2, r: 6 }, g); el('title', {}, h).textContent = 'Drag to connect'; h.onmousedown = (ev) => startLink(ev, n); }
    const hl = (on) => { svg.classList.toggle('focusing', on); for (const it of edgeLayout.per) if (it.a === n || it.b === n) it.path.classList.toggle('hl', on); g.classList.toggle('hl', on); };
    g.onmouseenter = () => hl(true); g.onmouseleave = () => hl(false);
    g.onmousedown = (ev) => { if (ev.button === 0) { if (tc.drag) startDrag(ev, n, g); else { ev.stopPropagation(); startWatchDrag(ev, n); } } else if (ev.button === 2) { ev.stopPropagation(); selectNode(n.id); nodeMenu(ev, n); } };
    g.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (tc.menu && $('#ctxmenu').classList.contains('hidden')) { selectNode(n.id); nodeMenu(ev, n); } };
  }
  // First open of a team, or new nodes landing outside the view (e.g. added in bulk) -> fit/refit so nothing is cut off.
  if (nodes.length > vpCount && svg.getBoundingClientRect().width) { (vpCount ? fitIfClipped : fitView)(); vpCount = nodes.length; } // only once visible (hidden tab has 0 width)
  applyVP();
  svg.onmousedown = (ev) => { if (ev.button === 0) startPan(ev); };
  svg.oncontextmenu = (ev) => { ev.preventDefault(); if (tc.menu) canvasMenu(ev); };
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
  for (const n of nodes) el('rect', { x: n.x, y: n.y, width: W, height: H, rx: 12, class: n.ghost ? 'mghost' : 'mnode', style: n.ghost ? '' : `fill:${agentVar(n.id)}` }, mm);
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
// Confirm body for deleting an agent: names the mid-run state explicitly (t_d8e41e6a) and lists
// the open tasks that will move to its manager. Extracted so the e2e can assert the exact dialog
// text without driving a modal.
function deleteConfirmText(n, open) {
  const list = open.length ? `\n\nOpen tasks (moved to its manager or the core):\n${open.map((t) => `• ${t.title} [${t.status}]`).join('\n')}` : '';
  const runNote = nodeLive(n) === 'working' ? `\n\n${n.name} is currently running — changes apply on next turn.` : '';
  return `Delete ${n.name}?${runNote}${list}`;
}
async function deleteNode(n) {
  if (n.core) { alert(`${n.name} is the core agent and cannot be deleted.`); return; }
  if (n.protected) { alert(`${n.name} is protected from retirement — clear "Protected" in its editor first.`); return; }
  const open = S.tasks.filter((t) => t.assignee === n.id && t.status !== 'done');
  if (!confirm(deleteConfirmText(n, open))) return;
  try { await call('removeNode', n.id); } catch (e) { alert(e.message); }
  sel.node = null; refresh();
}
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
  if (!teamCan().menu) { // Watch: read-only — the menu deep-links into Chat instead of editing
    const ro = [['Open in Chat', () => openNodeInChat(n.id)]];
    showMenu(ev.clientX, ev.clientY, `<div class="mhead">${esc(n.name)}</div>` + menuItems(ro)); bindMenu(ro); return;
  }
  const items = [['Edit', () => selectNode(n.id)], ['Connect from here', () => startConnect(n)], ['Duplicate', () => duplicateNode(n)], ['Test agent', () => testAgents([n.id])], '-', ...(!n.protected ? [['Delete', () => deleteNode(n), 'danger']] : [])];
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
async function addAgentAt(x, y) { const role = S.team.nodes.length === 0 ? 'PM' : 'Dev'; const n = await call('addNode', { role, x: Math.round(x), y: Math.round(y) }); sel.node = n.id; refresh(); }
// Auto-layout button (also the canvas context menu's "Auto-layout"): flips graphAuto back on so
// every render recomputes positions via treeLayout above, collapses clusters to their heads,
// persists the fresh positions when the view is unclustered, then fits the result to the viewport.
// There is no separate layout pass here — treeLayout is the whole engine.
async function autoLayout() {
  if (!S.team.nodes.length) return; graphAuto = true; expandedClusters.clear(); renderGraph();
  if (!GV.clustered) await call('setPositions', Object.fromEntries(S.team.nodes.map((n) => [n.id, { x: n.x, y: n.y }])));
  fitView();
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
    if (it.pill) {
      let [px, py] = it.geo.mid; for (let s = 0, r = { x: px - it.pw / 2, y: py - it.ph / 2, w: it.pw, h: it.ph }; s < 12 && [...edgeLayout.blocks, ...pills].some((q) => overlaps(r, q)); s++) { const d = (s % 2 ? -1 : 1) * Math.ceil((s + 1) / 2) * 12; px = it.geo.mid[0] + it.geo.n[0] * d; py = it.geo.mid[1] + it.geo.n[1] * d; r = { x: px - it.pw / 2, y: py - it.ph / 2, w: it.pw, h: it.ph }; }
      pills.push({ x: px - it.pw / 2, y: py - it.ph / 2, w: it.pw, h: it.ph });
      it.pill.setAttribute('transform', `translate(${px - it.pw / 2},${py - it.ph / 2})`);
    }
    it.hit.setAttribute('d', it.geo.d); it.path.setAttribute('d', it.geo.d);
  }
}
function startDrag(ev, n, g) {
  ev.stopPropagation(); hideMenus(); const sx = ev.clientX, sy = ev.clientY, ox = n.x, oy = n.y; let moved = false;
  const mv = (e) => { moved = moved || Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 2; if (!moved) return; n.x = Math.round(ox + (e.clientX - sx) / VP.zoom); n.y = Math.round(oy + (e.clientY - sy) / VP.zoom); g.setAttribute('transform', `translate(${n.x},${n.y})`); dragEdges(n); };
  const up = async () => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    if (moved) { if (graphAuto) { graphAuto = false; if (!GV.clustered) await call('setPositions', Object.fromEntries(S.team.nodes.map((m) => [m.id, { x: m.x, y: m.y }]))); } await call('updateNode', n.id, { x: n.x, y: n.y }); renderGraph(); return; }
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
  if (sel.edge) { await call('removeEdge', sel.edge); sel.edge = null; refresh(); }
  else { const n = S.team.nodes.find((x) => x.id === sel.node); if (n) await deleteNode(n); }
};
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('input,textarea,select,[contenteditable]') && teamCan().del && $('#delsel').offsetParent) { e.preventDefault(); $('#delsel').click(); }
});
// Compact live card for the selected node (wiki decision-one-team-view): status, current task,
// last event, Open in Chat. Shown in both modes — it IS the inspector in Watch, and it sits atop
// the editor in Edit. Replaces the old graph-screen task-thread panel (dropped: it duplicated Chat).
function nodeLiveCard(n) {
  const a = S.orch.agents[n.id] || {}; const t = a.taskId ? S.tasks.find((x) => x.id === a.taskId) : null;
  const live = nodeLive(n); const isStuck = !!stallState(n.id);
  const lastEv = [...logs].reverse().find((l) => l.projectId === ctx.p && l.nodeId === n.id);
  const liveTxt = live === 'working' ? '● Working' : live === 'needs-human' ? '● Needs you' : '○ Idle';
  return `<div class="livecard">
    <div class="lc-head"><img class="lc-face" src="${faceUri(n.id)}" alt="" style="background:${agentVar(n.id)}"><div class="lc-id"><b>${esc(n.name)}</b><span class="lc-role">${esc(n.role)}${isLeadRole(n.role) ? ' ★' : ''}</span></div><span class="pill lc-live lc-${live}" title="${isStuck ? 'stalled — no output for a while · ' : ''}${esc(live)}">${isStuck ? '⚠ stuck · ' : ''}${liveTxt}</span></div>
    <div class="lc-task">${t ? `▸ <b>${esc(clipText(t.title, 60))}</b><span class="lc-tstatus">${esc(t.status)}</span>` : '<span class="muted">No current task</span>'}</div>
    <div class="lc-last">${lastEv ? `<small class="muted">${new Date(lastEv.at).toLocaleTimeString()}</small> ${esc(clipText(lastEv.text, 120))}` : '<span class="muted">No activity yet</span>'}</div>
    <div class="lc-actions"><button id="lc-chat" class="primary">Open in Chat</button></div>
  </div>`;
}
const wireLiveCard = (n) => { const lc = $('#lc-chat'); if (lc) lc.onclick = () => openNodeInChat(n.id); };
function renderNodeForm() {
  if (!$('#tab-team').classList.contains('active')) return; // hidden tab: redrawn on activation (renderAll)
  const tc = teamCan();
  const f = $('#nodeform'); const n = S.team.nodes.find((x) => x.id === sel.node);
  f.classList.toggle('hidden', !n && !S.team.edges.some((x) => x.id === sel.edge)); // collapse the help panel when nothing is selected
  if (!n) {
    const e = S.team.edges.find((x) => x.id === sel.edge);
    if (!e) { f.innerHTML = '<h3>Team</h3><p class="muted">Select an agent to see its live card (status, current task, last event, Open in Chat). In <b>Edit team</b> (E) selecting an agent opens its editor. Edge A → B: <b>assign</b> = A can create tasks for B (and message B), <b>message</b> = A can message B, <b>review</b> = B reviews A\'s tasks (can move them to review/done).</p>'; return; }
    const type = e.type || 'assign';
    if (!tc.rename) { f.innerHTML = `<h3>Edge</h3><p>${esc(nodeName(e.from))} → ${esc(nodeName(e.to))}</p><p class="muted">Read-only in Watch — switch to Edit team (E) to change this edge.</p>`; return; }
    f.innerHTML = `<h3>Edge</h3><p>${esc(nodeName(e.from))} → ${esc(nodeName(e.to))}</p>
      <label>Type</label><select id="ef-type">${S.config.edgeTypes.map((t) => `<option ${t === type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <p class="muted" id="ef-desc">${esc(type === 'review' ? `${nodeName(e.to)} reviews the tasks of ${nodeName(e.from)} and can move them to review/done.` : `${nodeName(e.from)} ${EDGE_DESC[type]} ${nodeName(e.to)}.`)}</p>`;
    $('#ef-type').onchange = act(async (ev) => { await call('updateEdge', e.id, { type: ev.target.value }); refresh(); });
    return;
  }
  if (!tc.rename) { // Watch: the live card IS the inspector — no editor fields
    f.innerHTML = nodeLiveCard(n) + '<p class="muted">Read-only in Watch — switch to <b>Edit team</b> (E) to change this agent.</p>';
    wireLiveCard(n); return;
  }
  const a = S.orch.agents[n.id] || {}; const C = S.config; const off = new Set(n.disabledBoardTools || []);
  const presets = S.settings.rolePresets || [];
  f.innerHTML = nodeLiveCard(n) + `<h3>Agent <span class="pill pf-${pfState(n)}" id="nf-pfbadge">${PF_LABEL[pfState(n)]}</span></h3>
    <div class="toolbar"><button id="nf-test" ${testing.has(n.id) ? 'disabled' : ''}>Test agent</button><span class="muted">saves first, then runs a cheap check</span></div>
    <div id="nf-pf">${pfDetail(n)}</div>
    <label>Name</label><input id="nf-name" value="${esc(n.name)}">
    <label>Face</label><div><img id="nf-face" width="40" height="40" alt="" style="background:${agentVar(n.id)};border-radius:50%;vertical-align:middle" src="${faceUri(n.id)}"> <button id="nf-newface" type="button">New face</button> <button id="nf-resetface" type="button">Reset</button></div>
    <label>Role <span class="muted">(free text; presets: ${presets.length})</span></label><input id="nf-role" list="rolelist" value="${esc(n.role)}"><datalist id="rolelist">${C.roles.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
    <div class="toolbar"><button id="nf-applypreset" ${presets.some((p) => p.name.toLowerCase() === String(n.role).toLowerCase()) ? '' : 'disabled'}>Apply preset</button><button id="nf-savepreset">Save as role preset</button></div>
    <label class="inline"><input type="checkbox" id="nf-core" ${n.core ? 'checked' : ''}> Core agent <span class="muted">(protected; recruits and retires teammates; one per team)</span></label>
    <label class="inline"><input type="checkbox" id="nf-protected" ${n.protected ? 'checked' : ''}> Protected from retirement <span class="muted">(agents cannot retire this node; only you may clear this)</span></label>
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
  wireLiveCard(n);
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
  let seed = n.avatarSeed || '';
  const showFace = () => { $('#nf-face').src = faceUri(n.id, seed); };
  $('#nf-newface').onclick = () => { seed = Math.random().toString(36).slice(2, 10); showFace(); };
  $('#nf-resetface').onclick = () => { seed = ''; showFace(); };
  const read = () => ({
    avatarSeed: seed,
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
  // leaves zero cores (safe), never two. `protected` never rides the updateNode patch (the store
  // refuses the key): it goes through the human-only setNodeProtected IPC when the toggle changed.
  const saveNode = async (v) => {
    if (v.core) for (const o of S.team.nodes) if (o.id !== n.id && o.core) await call('updateNode', o.id, { core: false });
    await call('updateNode', n.id, v);
    const p = $('#nf-protected');
    if (p && p.checked !== !!n.protected) await call('setNodeProtected', n.id, p.checked);
  };
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
// Board, Team and Chat can't disagree. Reads the backend's live-run activity fields
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
// Short badge text for drawWakeBadge: sender first, so the 30-char clip keeps WHO woke the agent
// (t_0cd29f4d); the linked task title trails and at that width usually survives only in the tooltip.
const wakeBadgeText = (w, task) => `${w.from} ✉ "${w.excerpt}"${w.queued ? ` (+${w.queued})` : ''}${task ? ` · ${task}` : ''}`;
// Pending wake (t_139bd3eb): unread agent->agent messages held back by the per-agent wake gap —
// a.wakePending {count, suppressed, nextWakeAt} from the orchestrator snapshot; absent = nothing pending.
function wakePending(id) { const w = (S.orch.agents[id] || {}).wakePending; return w && +w.count > 0 ? w : null; }
const pendingWakeText = (w) => { const n = +w.count; return w.suppressed ? `${n} message${n === 1 ? '' : 's'} pending — wake in ~${Math.max(1, Math.round((w.nextWakeAt - Date.now()) / 60000))}min` : `${n} message${n === 1 ? '' : 's'} pending — waking…`; };
const pendingWakeBadgeText = (w) => { const n = +w.count; return w.suppressed ? `${n} pending — wake in ~${Math.max(1, Math.round((w.nextWakeAt - Date.now()) / 60000))}min` : `${n} pending — waking…`; };
// Shared badge drawing for the Team and Overview node SVGs: a strip just below the node card
// (inside the card there is no free row — the chip row and ctx bar own the bottom edge).
function drawWakeBadge(g, w, onclick) {
  const full = `Working — woken by message from ${w.from}: "${w.excerpt}"${w.queued ? ` (+${w.queued} queued)` : ''}`;
  const bg = el('g', { class: 'wakerunbadge' + (w.taskId ? ' linked' : ''), transform: `translate(4,${H + 3})` }, g);
  el('rect', { width: W - 8, height: 13, rx: 6 }, bg);
  el('text', { x: (W - 8) / 2, y: 9.5, 'text-anchor': 'middle' }, bg).textContent = clipText(wakeBadgeText(w, w.taskId ? taskTitle(w.taskId) : null), 30);
  el('title', {}, bg).textContent = full;
  if (w.taskId && onclick) bg.onclick = onclick;
}
// Pending-wake strip, same slot as the wake/stall badges at the lowest rank (an actual wake or a
// stall says more than messages waiting). Deliberately calm — dashed neutral, not an alarm color.
function drawPendingBadge(g, wp) {
  const full = pendingWakeText(wp);
  const bg = el('g', { class: 'pendingwakebadge', transform: `translate(4,${H + 3})` }, g);
  el('rect', { width: W - 8, height: 13, rx: 6 }, bg);
  el('text', { x: (W - 8) / 2, y: 9.5, 'text-anchor': 'middle' }, bg).textContent = clipText(pendingWakeBadgeText(wp), 30);
  el('title', {}, bg).textContent = full;
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
// ---------- runtime unavailable (contract with Devon, t_419062e2 / t_d33685f3) ----------
// When a runtime's runs fail fast with auth/model errors, core trips a per-runtime breaker: it stops
// dispatching to that runtime (queued tasks wait) and emits runtime.unavailable; a successful resume
// or a healthy run emits runtime.available. Push channels 'runtime-unavailable' / 'runtime-available'
// match the dash style of the stall channels (camelCase variants registered until the preload grows
// helpers, same as restart/watch above). Payload {runtime, error, agents, since, projectId}; error is
// the redacted stderr tail (core caps ~2KB). Snapshot fallback: snapshotSlim carries orch.runtimeState
// so the banner survives a page reload. Resume: call('resumeRuntime', runtime) clears the breaker and
// re-dispatches the queued tasks.
let rtu = null;
function setRtu(d) {
  if (!d || !d.runtime) return;
  rtu = { runtime: d.runtime, error: String(d.error || ''), agents: Array.isArray(d.agents) ? d.agents : null, at: +d.since || +d.at || Date.now() };
  renderAlerts(); renderGraph(); renderNodeForm();
}
function clearRtu(runtime) {
  if (!rtu || (runtime && rtu.runtime !== runtime)) return;
  rtu = null;
  renderAlerts(); renderGraph(); renderNodeForm();
}
// Is this agent affected? Core's agents list wins when present; otherwise affected = agent's runtime
// (nstat overrides the node config, same precedence as the Team chip row) matches the broken runtime.
function rtuFor(id) {
  if (!rtu) return null;
  if (rtu.agents) return rtu.agents.includes(id) ? rtu : null;
  const n = S.allNodes.find((x) => x.id === id); if (!n) return null;
  return (((S.nstat || {})[id] || {}).runtime || n.runtime || 'claude') === rtu.runtime ? rtu : null;
}
// Reload / missed-push fallback: adopt unavailable state from the orchestrator snapshot, and drop our
// copy once the snapshot reports the runtime healthy again (core recovered without a resume call).
function syncRtu() {
  const rs = (S.orch || {}).runtimeState || {};
  const seen = new Set();
  for (const [id, st] of Object.entries(rs)) {
    seen.add(id);
    if (st && st.state === 'unavailable') { if (!rtu || rtu.runtime !== id || (+st.since || 0) > rtu.at) setRtu({ runtime: id, error: st.error, agents: st.agents, since: st.since }); }
  }
  if (rtu && !seen.has(rtu.runtime)) clearRtu(rtu.runtime); // snapshot dropped the entry: healthy again
}
// Red strip below the card for agents whose runtime is unavailable — same slot as the wake/stall
// badges, ranked under stall (a hung run is a distinct live problem) but above wake/pending: those
// claim the agent is working or about to, which it cannot be on a broken runtime.
function drawRtuBadge(g, r) {
  const label = runtimeLabel(r.runtime);
  const bg = el('g', { class: 'rtubadge', transform: `translate(4,${H + 3})` }, g);
  el('rect', { width: W - 8, height: 13, rx: 6 }, bg);
  el('text', { x: (W - 8) / 2, y: 9.5, 'text-anchor': 'middle' }, bg).textContent = clipText(`⏸ paused — ${label} unavailable`, 30);
  el('title', {}, bg).textContent = r.error ? `${label} unavailable: ${r.error}` : `${label} unavailable — fix it, then resume from the banner`;
}
// ---------- alerts center (t_6674705d): ONE bell + panel fed by the pure collector (src/alerts.js) ----------
// The old stacked banners are gone: #redbar (master red), #rtbar (runtime unavailable), #restartst +
// #rstpop (restart pending) and the .idlebanner all became bell rows. Dismissal keeps id + fingerprint
// in memory only — a row reappears when its state changes (different fingerprint) and resets on reload.
// Every action op dispatches to a handler that already existed; preflight-failed rows are filtered out
// here because the #pf-summary pill stays the single sanctioned inline signal (Critic t_7239c941 item 5).
const dismissed = new Map(); // alert id -> fingerprint hidden until the state changes
let alertsOpen = false;
let fakeAlertN = 0, fakeAlertFp = ''; // dev/test hook for gui-e2e: window.__fakeAlerts(n, fpBump?)
window.__fakeAlerts = (n, fpBump) => { fakeAlertN = Math.max(0, n | 0); fakeAlertFp = String(fpBump || ''); renderAlerts(); return fakeAlertN; };
const fakeAlerts = (n) => Array.from({ length: n }, (_, i) => {
  const t = S.tasks[i] || {}; const nd = S.team.nodes[i % Math.max(1, S.team.nodes.length)] || {};
  return { id: `fake:${i}`, kind: 'fake', severity: i % 2 ? 'warn' : 'error', at: Date.now() - i * 60000, dismissable: true,
    text: `Fake alert ${i + 1} — injected for testing`, agentId: nd.id || null, taskId: t.id || null, fingerprint: `fake${i}${fakeAlertFp}`,
    action: t.id ? { label: 'Open task', op: 'open-task', arg: t.id } : null };
});
async function renderAlerts() {
  const limits = await usageStatusOnce(); // shared per-second fetch (see usageStatusOnce)
  const stalls = S.allNodes.map((n) => ({ id: n.id, st: stallState(n.id) })).filter((x) => x.st && x.st.state === 'recovery_failed');
  const paused = rtu ? (rtu.agents ? rtu.agents.length : S.team.nodes.filter((n) => rtuFor(n.id)).length) : 0;
  const all = Alerts.collect({
    redMaster: (S.orch || {}).redMaster, rst, tasks: S.tasks, running: runningIds(),
    // Dev-only rows (restart pending, t_7fbee55f) hide when the backend says non-dev; upd.devMode
    // defaults true while stubbed (older backend), matching the self-update pill's convention.
    devMode: upd.devMode, updError: upd.state === 'idle' ? upd.lastError : '',
    agents: S.orch.agents || {}, stuck: Alerts.stuckAgents(S.orch.agents, logs, Date.now(), S.settings.stuckMinutes || 5),
    stalls, teamNodes: S.team.nodes, limits, stuckMinutes: S.settings.stuckMinutes || 5, now: Date.now(),
    nodeNames: Object.fromEntries(S.allNodes.map((n) => [n.id, n.name])),
    rtu: rtu ? { ...rtu, paused, label: runtimeLabel(rtu.runtime) } : null,
  }).filter((a) => a.kind !== 'preflight');
  if (fakeAlertN > 0) all.push(...fakeAlerts(fakeAlertN));
  const live = Alerts.sortAlerts(all).filter((a) => dismissed.get(a.id) !== a.fingerprint);
  renderAlertBell(live);
  renderAlertPanel(live);
  renderLimitMeter(limits); // same usageStatus read feeds the meter — no second IPC call
}
function renderAlertBell(live) {
  const b = $('#alertbell'); if (!b) return;
  const n = live.length; const worst = live[0]; // collect() sorts error first
  const badge = $('#alertbell-n');
  badge.textContent = n ? (n > 9 ? '9+' : String(n)) : '';
  badge.className = `abadge abadge-${n ? (worst ? worst.severity : 'info') : 'none'}`; // .abadge-none hides it: 0 alerts must not look wrong
  const errs = live.filter((a) => a.severity === 'error').length;
  b.title = n ? `Alerts — ${n}${errs ? ` (${errs} error${errs === 1 ? '' : 's'})` : ''}` : 'Alerts';
  b.setAttribute('aria-label', b.title);
  b.classList.toggle('active', alertsOpen);
  b.setAttribute('aria-expanded', String(alertsOpen));
}
function closeAlerts() {
  alertsOpen = false;
  const p = $('#alertpanel'); if (p) p.classList.add('hidden');
  const b = $('#alertbell'); if (b) { b.classList.remove('active'); b.setAttribute('aria-expanded', 'false'); }
}
function renderAlertPanel(live) {
  const p = $('#alertpanel'); if (!p) return;
  if (!alertsOpen) { p.classList.add('hidden'); return; }
  const who = (a) => [a.agentId ? `<a href="#" data-alagent="${esc(a.agentId)}">${esc(nodeName(a.agentId))}</a>` : '',
    a.taskId ? `<a href="#" data-altask="${esc(a.taskId)}">${esc(shortTaskId(a.taskId))}</a>` : ''].filter(Boolean).join(' · ');
  // The restart row's action doubles as its state (t_f8897886): in flight or armed it reads
  // "Restarting…" with a spinner — still clickable (re-arming is harmless; the busy guard dedups).
  const alLabel = (a) => a.kind === 'restart-pending' && a.action && (rstBusy === 'now' || rstArmed())
    ? '<span class="spin"></span>Restarting…' : esc(a.action.label);
  p.innerHTML = `<div class="al-head">Alerts</div>${live.length ? live.map((a) => `<div class="al-row"><i class="al-dot al-${esc(a.severity)}" title="${esc(a.severity)}"></i><div class="al-body"><span class="al-what" title="${esc(a.text)}">${esc(a.text)}</span><span class="al-who">${who(a)}</span></div><span class="al-side">${a.action ? `<button class="al-act" data-alop="${esc(a.action.op)}" data-alarg="${esc(a.action.arg || '')}">${alLabel(a)}</button>` : ''}${a.dismissable ? `<button class="al-x" title="Hide until the state changes" data-alx="${esc(a.id)}">×</button>` : ''}</span></div>`).join('') : '<div class="al-empty">All clear — nothing needs you right now.</div>'}`;
  p.classList.remove('hidden');
  const r = $('#alertbell').getBoundingClientRect();
  p.style.top = `${Math.round(r.bottom + 6)}px`;
  p.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  p.querySelectorAll('[data-alop]').forEach((b) => b.onclick = act(async () => { closeAlerts(); await runAlertOp(b.dataset.alop, b.dataset.alarg); }));
  p.querySelectorAll('[data-alx]').forEach((b) => b.onclick = () => { const a = live.find((x) => x.id === b.dataset.alx); if (!a) return; dismissed.set(a.id, a.fingerprint); renderAlerts(); });
  p.querySelectorAll('[data-altask]').forEach((a) => a.onclick = (e) => { e.preventDefault(); closeAlerts(); sel.task = a.dataset.altask; showTab('board'); renderBoard(); });
  p.querySelectorAll('[data-alagent]').forEach((a) => a.onclick = (e) => { e.preventDefault(); closeAlerts(); showTab('team'); selectNode(a.dataset.alagent); });
}
// The only dispatcher of collector ops — each maps onto an existing handler (no new IPC).
async function runAlertOp(op, arg) {
  if (op === 'open-task') { if (!arg) return; sel.task = arg; showTab('board'); renderBoard(); }
  else if (op === 'open-usage') { showTab('usage'); setTimeout(() => $('#us-limits')?.scrollIntoView({ block: 'start' }), 80); }
  else if (op === 'open-team') showTab('team');
  else if (op === 'restart-core') await rstAction('now');
  else if (op === 'resume-runtime') { try { await call('resumeRuntime', arg); clearRtu(arg); await refresh(); } catch (e) { alert(String(e.message || e).replace(/^Error invoking remote method 'api':\s*(Error:\s*)?/, '')); } }
  else if (op === 'retest') await testAgents(arg ? [arg] : []);
}
$('#alertbell').onclick = () => { alertsOpen = !alertsOpen; renderAlerts(); };
document.addEventListener('mousedown', (e) => { if (alertsOpen && !$('#alertpanel').contains(e.target) && !$('#alertbell').contains(e.target)) closeAlerts(); });

// Unclean-exit recovery banner (t_6911ba60): at boot the main process checks the heartbeat
// breadcrumb and reaps orphaned run groups; getLastExit reports what it found — {unclean,
// lastAliveAt, lastAlivePid, reaped:[{pid,cmd}], interruptedTasks:[id]}. unclean means the previous
// instance died without notice; the timestamp is "last seen alive" (±5s heartbeat), never an exact
// crash time. Interrupted tasks stay in_progress — resuming is the user's call, so they are links,
// not actions. Shown once per renderer session per project (boot + project switches); dismissal is
// in-memory, so a page reload re-asks rather than silently hiding a still-true warning.
const recDismissed = new Set();
async function syncRecovery() {
  const bar = $('#recoverybar'); if (!bar || !ctx.p) return;
  let d = null; try { d = await call('getLastExit'); } catch { return bar.classList.add('hidden'); } // older backend without the handler: stay quiet
  if (!d || !d.unclean || recDismissed.has(ctx.p)) return bar.classList.add('hidden');
  const n = (d.reaped || []).length, ts = d.interruptedTasks || [];
  const when = d.lastAliveAt
    ? `last seen alive ${agoTxt(d.lastAliveAt)} <span class="muted" title="last heartbeat before the exit (${esc(d.lastAlivePid ? 'pid ' + d.lastAlivePid : 'previous instance')})">(${esc(new Date(d.lastAliveAt).toLocaleString())})</span>`
    : 'last seen alive at an unknown time';
  const bits = [when, n ? `${n} orphan agent run${n === 1 ? '' : 's'} stopped` : '', `${ts.length} task${ts.length === 1 ? '' : 's'} interrupted`].filter(Boolean);
  bar.innerHTML = `<span class="rb-dot" title="warning"></span><span class="rb-txt"><b>Last session ended unexpectedly</b> — ${bits.join(' · ')}${ts.length ? ':' : ''}</span>${ts.map((id) => `<button class="linklike" data-rbtask="${esc(id)}" title="Open on the board">${esc(taskTitle(id) || id)} →</button>`).join('')}<span class="spacer"></span><button class="rb-x" title="Dismiss" aria-label="Dismiss recovery banner">✕</button>`;
  bar.querySelectorAll('[data-rbtask]').forEach((b) => b.onclick = () => { sel.task = b.dataset.rbtask; showTab('board'); renderBoard(); });
  bar.querySelector('.rb-x').onclick = () => { recDismissed.add(ctx.p); bar.classList.add('hidden'); };
  bar.classList.remove('hidden');
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
// Stuck task/agent action (t_747e0d1e): 'Retest + Resume'; after a failed resume the button becomes 'Rerun fresh'.
// IPC: retestAndResume(taskId) -> {ok, resumeFailed?, error?}; rerunFresh(taskId) -> {ok, error?}.
const rrFailed = new Set(); const rrBusy = new Set();
const stuckBtn = (taskId) => rrBusy.has(taskId) ? `<button disabled>Working…</button>` : `<button class="primary" data-rerun="${rrFailed.has(taskId) ? 'fresh' : 'resume'}" data-rrtask="${taskId}" title="${rrFailed.has(taskId) ? 'Resume failed. Start a new run with the same task.' : 'Check the CLI, then resume the last session'}">${rrFailed.has(taskId) ? 'Rerun fresh' : 'Retest + Resume'}</button>`;
function wireStuckBtns() {
  document.querySelectorAll('[data-rrtask]').forEach((b) => b.onclick = act(async (e) => { e.stopPropagation(); const id = b.dataset.rrtask; rrBusy.add(id); refresh();
    try { const r = await call(b.dataset.rerun === 'fresh' ? 'rerunFresh' : 'retestAndResume', id);
      if (r && r.ok === false) { if (r.resumeFailed) rrFailed.add(id); else alert(r.error || 'Failed'); } else rrFailed.delete(id);
    } finally { rrBusy.delete(id); refresh(); } }));
}
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
  // The old "N agents idle" banner (.idlebanner) is gone (t_6674705d): idle is a normal state, and
  // presence is already visible here and as node colors. Only the wake bars + presence chips remain.
  // Both follow the board's team scope (t_1158f757).
  const idleNodes = S.allNodes.filter((n) => teamScoped(sel.boardTeam, n.id));
  $('#presence').innerHTML = idleNodes.map((n) => { const p = presence(n.id); const wk = wakeLabel(n.id); const wp = wk ? null : wakePending(n.id); const pt = wk || (wp ? pendingWakeText(wp) : ''); return `<span class="pchip ${p}${wk ? ' wake' : ''}" title="${esc(pt || n.role)}"><span class="pres ${p}"><i></i></span>${esc(n.name)} <span class="muted">${pt ? esc(clipText(pt, 52)) : p}</span></span>`; }).join('');
  const wakes = idleNodes.map((n) => ({ n, w: wakeRun(n.id) })).filter((x) => x.w);
  const wb = $('#wakebar');
  if (wb) { wb.classList.toggle('hidden', !wakes.length);
    wb.innerHTML = wakes.map(({ n, w }) => `<div class="wakebar"><span class="pres busy"><i></i></span><b>${esc(n.name)}</b><span>Working — woken by message from ${esc(w.from)}: "${esc(w.excerpt)}"${w.queued ? ` <span class="muted">(+${w.queued} queued)</span>` : ''}</span><span class="spacer"></span>${w.taskId ? `<button class="linklike" data-waketask="${w.taskId}">${esc(taskTitle(w.taskId))} →</button>` : ''}</div>`).join('');
    wb.querySelectorAll('[data-waketask]').forEach((b) => b.onclick = () => openWakeTask(b.dataset.waketask)); }
}

// ---------- board ----------
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const priorityOf = (t) => PRIORITIES.includes(t.priority) ? t.priority : 'P2';
const priorityBadge = (t) => `<span class="tag prio prio-${priorityOf(t)}" title="Priority ${priorityOf(t)}">${priorityOf(t)}</span>`;
// Titles ride through String() so a corrupted task file without one cannot throw inside
// localeCompare and kill the whole board render (t_e25151db).
const byPriorityThenTitle = (a, b) => PRIORITIES.indexOf(priorityOf(a)) - PRIORITIES.indexOf(priorityOf(b)) || String(a.title ?? '').localeCompare(String(b.title ?? ''));
// Relative age for card meta ("2h", "3d") — a card's freshness is part of scanning a board.
const ago = (ts) => { if (!ts) return ''; const ms = new Date(ts).getTime(); if (Number.isNaN(ms)) return ''; const sec = (Date.now() - ms) / 1000;
  return sec < 60 ? 'now' : sec < 3600 ? `${Math.floor(sec / 60)}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86400)}d`; };
// Skip-no-op renders (t_9315f18a): the storm profile showed every run push re-rendering ALL heavy
// sections (503-card board, 200-row log window, 300-run usage table) even when their inputs were
// unchanged, and even while their tab was hidden — p95 100ms frames at run cadence. Each gate is a
// cheap fingerprint of exactly what its renderer reads; hidden tabs skip entirely and re-render on
// activation (sig reset in the tab-click handler).
let boardSig = null, logSig = null, obsSig = null, usageSig = null, usageGroup = 0;
const agentStamp = () => Object.entries(S.orch.agents || {}).map(([k, a]) => `${k}${a.status}${a.taskId || ''}${a.iteration || 0}${a.stall ? '!' : ''}${a.run && a.run.stall ? '!' : ''}`).join();
let showAllDone = false; let doneOpen = true; // open by default: the 20 most recent done tasks show without a click
// Done column: the 20 most recently updated, but a selected card is never allowed to vanish under the fold (t_db029901).
const doneCards = (list) => { const all = list.filter((t) => t.status === 'done').slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))); if (showAllDone) return all.slice().sort(byPriorityThenTitle); const top = all.slice(0, 20); const s = all.find((x) => x.id === sel.task); if (s && !top.includes(s)) { top.pop(); top.push(s); } return top; };
// Keyed card patching (wiki paperclip-vs-us-perf #4, t_fe51eee9): instead of rebuilding the whole
// #columns innerHTML on every change — which repainted all 300 cards, dropped hover/focus and
// reset column scroll — each column diffs its card list by task id. A card whose HTML string is
// unchanged is not touched at all; only inserts, removals, content changes and reorders move DOM.
// The six board columns (t_c5db7bf0), in workflow order. Every task status the store knows
// (STATUSES in src/store.js) maps to exactly one column — this list is the board's contract with
// the store, so the two must stay in lockstep:
//   todo              — dispatchable work; a card with no open blockers earns the "Ready" tag
//   in_progress       — claimed by a worker; the live / working elsewhere / No worker tags
//                       disambiguate whether an agent is actually on this task
//   waiting_for_human — paused for user input; awaitingApproval adds the "needs approval" tag
//   review            — work landed; the auto-merge gate (store.js _mergeOnDone) runs from here
//   merge_conflict    — the gate refused (conflict or dirty main checkout); fix in the worktree,
//                       then flip done to retry the merge
//   done              — merged; folded by default to the 20 most recently updated (see doneCards)
const boardCols = ['todo', 'in_progress', 'waiting_for_human', 'review', 'merge_conflict', 'done'];
// A task whose status is not one of the six (the store gained a status without a matching column,
// or a task file lost its status) must neither crash the render nor silently vanish: colStOf
// buckets it into an "other" column rendered after done.
const colStOf = (t) => (boardCols.includes(t.status) ? t.status : 'other');
const cardSigs = new WeakMap(); // card element -> html it was built from
const tplEl = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const colHead = (st, total) => st === 'done'
  ? (doneOpen ? '▾ ' : '▸ ') + (showAllDone || total <= 20 ? `done (${total})` : `done 20/${total}`)
  : `${st.replaceAll('_', ' ')} (${total})`;
// One card's html — the exact markup the old full rebuild produced, as a string of the task and
// the worker/priority/blocker state it renders; diffing these strings is what skips DOM work.
function cardHtml(t) {
  const bl = openBlockers(t); const w = (S.orch.agents[t.assignee] || {});
  // Worker state must match reality: an agent with a live run is busy — on THIS task (or an
  // unattributed wake run for it) reads "live", on another task reads "working elsewhere",
  // and only an assignee with no live process at all earns "No worker".
  const running = t.assignee && runningIds().includes(t.assignee);
  const busy = w.status === 'working' || (!w.status && running);
  const ip = t.status === 'in_progress';
  const live = ip && busy && (w.taskId == null || w.taskId === t.id);
  const busyOther = ip && busy && !live;
  const noWorker = ip && t.assignee && !busy;
  const ready = !bl.length && ['todo', 'backlog'].includes(t.status);
  const cbt = sel.boardTeam ? nodeTeamOf(t.createdBy) : null; // cross-team: created by another team
  const tags = [cbt && cbt !== sel.boardTeam ? teamBadge(cbt) : '',
    live ? '<span class="tag live" title="live">live</span>' : '',
    busyOther ? `<span class="tag elsewhere" title="${esc(nodeName(t.assignee))} is working on ${esc(taskTitle(w.taskId))}">working elsewhere</span>` : '',
    noWorker ? `<span class="tag noworker" title="in_progress but no live agent process for ${esc(nodeName(t.assignee))}">No worker</span>` : '',
    stallTag(t),
    (upd.devMode !== false && rstGated(t)) ? `<span class="tag rstwait" title="held back by the restart gate${rst.scheduledAfter ? ` — starts after the core restart (after ${esc(shortTaskId(rst.scheduledAfter))})` : ' — starts after the core restarts'}">waits for restart</span>` : '',
    bl.length ? `<span class="tag blocked" title="waits for: ${esc(bl.map(taskTitle).join(', '))}">Blocked by ${esc(taskTitle(bl[0]).slice(0, 28))}${bl.length > 1 ? ` +${bl.length - 1}` : ''}</span>` : ready ? '<span class="tag ready" title="Ready">Ready</span>' : '',
    t.awaitingApproval ? '<span class="tag approval" title="needs approval">needs approval</span>' : ''].join('');
  const snippet = String(t.description || '').replace(/\s+/g, ' ').trim();
  const nCmts = (t.comments || []).length; // a task without a comments array must not kill the whole board render
  const cmtWord = nCmts === 1 ? 'comment' : 'comments';
  return `<div class="card ${sel.task === t.id ? 'sel' : ''}${t.awaitingApproval ? ' approval' : ''}" data-id="${t.id}"><b>${esc(t.title)}</b>${snippet && snippet !== t.title ? `<span class="cdesc" title="${esc(snippet)}">${esc(clipText(snippet, 100))}</span>` : ''}${tags ? `<span class="ctags">${tags}</span>` : ''}<small class="cmeta">${priorityBadge(t)}${t.assignee ? ((w) => `<span class="avatar sm" style="background:${avatarBg(w)}" title="${esc(w.name)}">${avatarBody(t.assignee, w)}</span><span class="cname">${esc(w.name)}</span>`)(who(t.assignee)) : '<span class="muted">unassigned</span>'}<span class="cago" title="last updated">${ago(t.updatedAt) || '—'}</span>${nCmts ? `<span class="ccount" title="${nCmts} ${cmtWord}">💬 ${nCmts}</span>` : ''}</small></div>`;
}
// Card-html memo (t_d6c2be24): every store write (any comment, any run push) bumps the board
// version, and the old path met that by re-running cardHtml for ALL cards — ~500 html strings on
// the grown board, rebuilt just to be diffed — even though only one card's inputs had moved. The
// memo keys each card's html on exactly what cardHtml reads: the task's own updatedAt (the store
// bumps it on every task mutation, comments included), the global env (agent states, running set,
// restart gate, dev mode, team scope, the board's status mix and size, agent names), the rendered
// age label (the only clock-driven part) and whether this card is the selected one.
const cardHtmlCache = new Map(); // task id -> { key, html }
const cardHtmlCached = (t, envKey) => {
  const key = `${envKey}|${t.updatedAt || ''}|${ago(t.updatedAt)}|${sel.task === t.id ? 1 : 0}`;
  let c = cardHtmlCache.get(t.id);
  if (!c || c.key !== key) cardHtmlCache.set(t.id, c = { key, html: cardHtml(t) });
  return c.html;
};
function patchBoardColumns(tasks) {
  const colsEl = $('#columns');
  const envKey = [agentStamp(), JSON.stringify(S.orch.running || null), rst.scheduledAfter || '', rst.gating.join(), upd.devMode !== false, sel.boardTeam || '', S.tasks.length, S.tasks.map((x) => colStOf(x)[0]).join(''), S.allNodes.map((n) => n.name).join()].join('|');
  const strays = tasks.filter((t) => !boardCols.includes(t.status)); // collected once; the "other" column reuses them
  (strays.length ? boardCols.concat('other') : boardCols).forEach((st, ci) => {
    const colTasks = st === 'other' ? strays : tasks.filter((t) => t.status === st); // one pass serves the header count and the card list
    const total = colTasks.length;
    const fold = st === 'done' && !doneOpen;
    let col = colsEl.querySelector(':scope > .col.' + st);
    if (!col) { col = tplEl(`<div class="col ${st}"></div>`); colsEl.appendChild(col); }
    if (colsEl.children[ci] !== col) colsEl.insertBefore(col, colsEl.children[ci] || null);
    const cls = `col ${st}${fold ? ' folded' : ''}`;
    if (col.className !== cls) col.className = cls;
    let h3 = col.__h3;
    if (!h3 || h3.parentElement !== col) {
      h3 = document.createElement('h3'); col.prepend(h3); col.__h3 = h3;
      if (st === 'done') { h3.id = 'done-h'; h3.style.cursor = 'pointer'; h3.title = 'Toggle done'; }
    }
    const head = colHead(st, total);
    if (h3.innerHTML !== head) h3.innerHTML = head;
    let hint = col.querySelector(':scope > .hint-first');
    if (st === 'todo' && !tasks.length) {
      const wantHint = sel.boardTeam && S.tasks.length ? 'No tasks for this team.' : 'Create a goal task, assign it to an agent (usually the PM), then press Run.';
      if (!hint) { hint = tplEl('<div class="hint-first" data-testid="board-empty-team"></div>'); h3.after(hint); }
      if (hint.textContent !== wantHint) hint.textContent = wantHint;
    } else if (hint) { hint.remove(); hint = null; } // detach from `prev` too: cards must not insert after a removed node
    const want = fold ? [] : st === 'done' ? doneCards(tasks) : colTasks.slice().sort(byPriorityThenTitle);
    const have = new Map(); // existing cards by task id (external duplicates are dropped, first wins)
    for (const el of [...col.children]) {
      if (!el.classList.contains('card')) continue;
      if (have.has(el.dataset.id)) el.remove(); else have.set(el.dataset.id, el);
    }
    const wantIds = new Set(want.map((t) => t.id));
    for (const [id, el] of have) if (!wantIds.has(id)) { el.remove(); have.delete(id); }
    let prev = hint || h3;
    for (let i = 0; i < want.length; i++) {
      const t = want[i]; const html = cardHtmlCached(t, envKey);
      let el = have.get(t.id);
      if (el && cardSigs.get(el) !== html) { const nu = tplEl(html); el.replaceWith(nu); have.set(t.id, el = nu); }
      if (!el) { el = tplEl(html); have.set(t.id, el); }
      cardSigs.set(el, html);
      if (prev.nextSibling !== el) prev.after(el); // no-op when already in place: the card keeps hover/focus
      prev = el;
    }
    let tb = col.querySelector(':scope > button#toggle-done');
    if (st === 'done' && !fold && total > 20) {
      const label = showAllDone ? 'Show recent only' : 'Show all done';
      if (!tb) { tb = tplEl('<button class="ghost" id="toggle-done"></button>'); col.appendChild(tb); }
      if (tb.textContent !== label) tb.textContent = label;
    } else if (tb) tb.remove();
  });
  if (cardHtmlCache.size > tasks.length) { const live = new Set(tasks.map((t) => t.id)); for (const id of cardHtmlCache.keys()) if (!live.has(id)) cardHtmlCache.delete(id); }
}
function renderBoard() {
  if (!$('#tab-board').classList.contains('active')) return;
  fillTeamSelect($('#boardteam'), sel.boardTeam, (S.project && S.project.teams) || []);
  const bkey = [S.v && S.v.board, sel.task, S.orch.running, Math.floor(Date.now() / 6e4), agentStamp(), sel.boardTeam || ''].join('|');
  if (bkey === boardSig) return; boardSig = bkey;
  const sa = $('#nt-assignee'); const cur = sa.value;
  sa.innerHTML = S.allNodes.map((n) => `<option value="${n.id}">${esc(n.name)} (${n.role})</option>`).join('') || '<option value="">(add agents first)</option>';
  if (cur) sa.value = cur;
  renderIdle();
  // Team scope (t_1158f757): a team view lists tasks whose assignee is in it (unassigned are
  // teamless and hide); All teams ('') lists everything. The detail panel stays global.
  const tasks = S.tasks.filter((t) => teamScoped(sel.boardTeam, t.assignee));
  patchBoardColumns(tasks);
  const d = $('#taskdetail'); const t = S.tasks.find((x) => x.id === sel.task);
  if (!t) { d.innerHTML = ''; d.classList.add('closed'); renderBoard.last = null; return; }
  d.classList.remove('closed');
  const keep = Object.fromEntries(['td-msg', 'td-note', 'td-comment'].map((k) => [k, $('#' + k) && $('#' + k).value])); const focused = document.activeElement && document.activeElement.id;
  const ag = S.orch.agents[t.assignee] || {}; const live = ag.status === 'working' && (ag.taskId == null || ag.taskId === t.id); const bl = openBlockers(t); const deps = new Set(t.blockedBy || []);
  const cmtCut = Math.max(0, t.comments.length - 200); const cmts = t.comments.slice(-200); // cap long comment threads
  d.innerHTML = `<div class="td-inner"><button id="td-close" class="td-close" title="Close (Esc)" aria-label="Close task details">✕</button><h3>${priorityBadge(t)} ${esc(t.title)}</h3><p class="muted">${t.id} · by ${esc(t.createdBy === 'human' ? 'human' : nodeName(t.createdBy))}</p>
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
    <label>Comments</label>${(cmtCut ? `<p class="muted">${cmtCut} earlier comments hidden</p>` : '') + cmts.map((c) => `<div class="comment"><b>${esc(c.author)}</b>: ${esc(c.text)}${Chat.attThumbs(c.attachments)}</div>`).join('') || '<p class="muted">none</p>'}
    <textarea id="td-comment" rows="2" placeholder="Add comment"></textarea>
    ${orphanedTasks().includes(t) ? `<div class="stuckbar">⚠ Stopped with a problem: no live worker.<span class="spacer"></span>${stuckBtn(t.id)}</div>` : ''}
    <p><button id="td-addc">Comment</button> <button id="td-del">Delete task</button>${t.worktreePath ? ` <button id="td-diff">Diff</button> <button id="td-merge">Merge</button> <button id="td-discard">Discard</button>` : ''}</p><div id="td-diffbox"></div></div>`;
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
  wireStuckBtns();
  if ($('#td-stopagent')) $('#td-stopagent').onclick = act(async () => { await call('stopAgent', t.assignee); refresh(); });
  if ($('#td-send')) { const send = act(async () => { const v = $('#td-msg').value.trim(); if (!v) return; await call('sendToAgent', t.assignee, v, t.id); $('#td-msg').value = ''; refresh(); }); $('#td-send').onclick = send; $('#td-msg').onkeydown = (e) => { if (e.key === 'Enter') send(); }; }
  if (renderBoard.last === t.id) for (const [k, v] of Object.entries(keep)) if (v && $('#' + k)) $('#' + k).value = v;
  if (renderBoard.last === t.id && focused && focused.startsWith('td-') && $('#' + focused)) $('#' + focused).focus();
  renderBoard.last = t.id; renderLive();
  $('#td-close').onclick = () => { sel.task = null; renderBoard(); };
  $('#td-del').onclick = async () => { if (confirm('Delete task?')) { await call('deleteTask', t.id); sel.task = null; refresh(); } };
}
// Card / done-head / toggle clicks bind once via delegation: keyed patching keeps card nodes
// alive, so the old rebind-every-render loops (and their lost handlers on replaced cards) are gone.
$('#columns').addEventListener('click', (e) => {
  if (e.target.closest('#toggle-done')) { showAllDone = !showAllDone; boardSig = ''; renderBoard(); return; }
  if (e.target.closest('#done-h')) { doneOpen = !doneOpen; boardSig = ''; renderBoard(); return; }
  const card = e.target.closest('.card');
  if (card && card.closest('#columns')) { sel.task = sel.task === card.dataset.id ? null : card.dataset.id; renderBoard(); }
});

// Board team scope (t_1158f757): one select at the start of the toolbar; index.html is out of
// scope for this task so the control is injected here.
document.querySelector('#tab-board .toolbar').insertAdjacentHTML('afterbegin', '<select id="boardteam" title="Scope the board to one team, or show all teams"></select>');
$('#boardteam').onchange = () => { sel.boardTeam = $('#boardteam').value; boardSig = ''; renderBoard(); };
$('#nt-add').onclick = async () => {
  const title = $('#nt-title').value.trim(); if (!title) return;
  const t = await call('createTask', { title, description: $('#nt-desc').value, assignee: $('#nt-assignee').value || null });
  $('#nt-title').value = ''; $('#nt-desc').value = ''; sel.task = t.id; refresh();
};

// Thread-linked bubble titles ride the shared taskById index (t_94b8df1f) instead of a private
// per-S.tasks memo.
const taskTitle = (id) => { const t = id ? taskById(id) : null; return (t && t.title) || id; };
function openBlockers(t) { return (Array.isArray(t.blockedBy) ? t.blockedBy : []).filter((id) => { const x = S.tasks.find((y) => y.id === id); return x && x.status !== 'done'; }); } // a non-array blockedBy (corrupted file) must not throw out of the card render (t_e25151db)
// Per-task live view: the last log lines of the agent working on the selected task.
function renderLive() {
  const box = $('#td-live'); const t = S.tasks.find((x) => x.id === sel.task); if (!box || !t) return;
  box.innerHTML = logs.filter((l) => l && l.projectId === ctx.p && l.nodeId === t.assignee && !l.saved).slice(-40).map((l) => `<span class="${l.kind}">${new Date(l.at).toLocaleTimeString()} ${l.kind}: ${esc(String(l.text ?? '').slice(0, 400))}</span>`).join('\n');
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
let wkSig = null;
// Wiki editor instrumentation (t_e5036ad3): state polls reach renderWiki on every tick, so the
// perf board needs to see how much the signature guard absorbs between real edits and what a
// rebuild/preview draw costs. Counters live on wkStats; a full rebuild >= 50 ms warns with the
// absorb count so list growth stays visible (same discipline as the ledger's slow-rebuild log).
const wkStats = { calls: 0, sigSkips: 0, renders: 0, shows: 0, lastMs: 0, maxMs: 0 };
function renderWiki() {
  wkStats.calls = (wkStats.calls || 0) + 1;
  // Signature like obsSig (see TAB_RESIG note): every state poll ran through here and rebuilt the
  // page list + re-wired its handlers even with nothing changed. updatedAt changes on any write, so
  // keying on titles+updatedAt+author+search+selection can't miss a real edit (including another
  // agent rewriting the page mid-session).
  const q = ($('#wk-search').value || '').trim().toLowerCase();
  // Remote delete (seed 475): another agent can delete the selected page through the board tools;
  // the stale selection used to keep a ghost editor alive and Save would silently recreate the
  // deleted page. View mode has no draft to lose, so drop the selection; an active edit keeps its
  // draft (same philosophy as the dirty guard) until the user saves or discards it.
  if (sel.page && !S.wiki[sel.page] && !wikiEdit) sel.page = null;
  const pages = Object.keys(S.wiki).sort().map((t) => `${t}|${S.wiki[t].updatedAt || ''}|${S.wiki[t].author || ''}`).join(';');
  const key = [ctx.p, pages, q, sel.page || '', wikiEdit].join('|');
  if (key === wkSig) { wkStats.sigSkips = (wkStats.sigSkips || 0) + 1; return; } wkSig = key;
  const t0 = performance.now();
  const titles = Object.keys(S.wiki).sort().filter((t) => !q || t.toLowerCase().includes(q) || (S.wiki[t].content || '').toLowerCase().includes(q));
  const all = Object.keys(S.wiki).length;
  $('#wikipages').innerHTML = titles.length
    ? titles.map((t) => `<div class="${t === sel.page ? 'sel' : ''}" data-t="${esc(t)}"><b>${esc(t)}</b><small class="wk-meta">${esc(S.wiki[t].author)}${agoTxt(S.wiki[t].updatedAt) ? ' · ' + agoTxt(S.wiki[t].updatedAt) : ''}</small></div>`).join('')
    : all ? '<p class="muted wk-empty-body">No pages match your search.</p>' : '<p class="muted wk-empty-body">No pages yet. Click + New page to write your first one — e.g. a runbook, a glossary, or notes for the team.</p>';
  document.querySelectorAll('#wikipages div[data-t]').forEach((d) => d.onclick = () => { if (!discardWikiEdit()) return; sel.page = d.dataset.t; wikiEdit = false; loadPage(); renderWiki(); });
  if (sel.page && S.wiki[sel.page] && !wikiEdit) loadPage();
  const empty = !sel.page && !wikiEdit;
  $('#wk-empty').classList.toggle('hidden', !empty); $('#wk-editor').classList.toggle('hidden', empty);
  $('#wk-empty h3').textContent = all ? 'No page selected' : 'No wiki pages yet';
  const ms = performance.now() - t0;
  wkStats.renders = (wkStats.renders || 0) + 1; wkStats.lastMs = ms;
  if (ms > wkStats.maxMs) wkStats.maxMs = ms;
  if (ms >= 50) console.warn(`wiki page list rebuilt in ${Math.round(ms)} ms over ${titles.length} page(s); ${wkStats.sigSkips} sig-skip(s) absorbed since boot`);
}
// Dirty-editor guard (t_2a87ef9a): leaving a modified editor used to silently wipe the draft.
function wikiDirty() {
  if (!wikiEdit) return false;
  const title = $('#wk-title').value.trim(), content = $('#wk-content').value;
  if (!sel.page) return !!(title || content);
  const p = S.wiki[sel.page];
  return title !== (p ? p.title : sel.page) || content !== (p ? p.content || '' : '');
}
const discardWikiEdit = () => !wikiDirty() || confirm('Discard unsaved changes to this page?');
// Concurrent-write guard (seed 471): agents write wiki pages through the board tools while a human
// edits. wkBaseUpdated remembers the page's updatedAt when this editing session began, so Save can
// detect "the page changed elsewhere since you started typing" instead of silently clobbering it.
let wkBaseUpdated = null;
const wikiNew = () => { if (!discardWikiEdit()) return; sel.page = null; wikiEdit = true; wkBaseUpdated = null; $('#wk-title').value = ''; $('#wk-content').value = ''; showWiki(); renderWiki(); };
$('#wk-new').onclick = wikiNew;
$('#wk-empty-new').onclick = wikiNew; // was rendered but never wired up — dead button
let wkSearchTimer = 0;
$('#wk-search').oninput = () => { clearTimeout(wkSearchTimer); wkSearchTimer = setTimeout(renderWiki, 150); }; // each keystroke re-filters and rebuilds the page list — render once per typing pause
function loadPage() { const p = S.wiki[sel.page]; if (!p) return; $('#wk-title').value = p.title; $('#wk-content').value = p.content; wkBaseUpdated = p.updatedAt || null; showWiki(); }
// Cheap backlinks: tasks whose title or description mention this page's title.
function wikiBacklinks(title) { const q = title.trim().toLowerCase(); if (!q) return []; return S.tasks.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)); }
function showWiki() {
  const t0 = performance.now();
  $('#wk-content').classList.toggle('hidden', !wikiEdit); $('#wk-view').classList.toggle('hidden', wikiEdit);
  const bl = wikiEdit ? [] : wikiBacklinks($('#wk-title').value);
  $('#wk-view').innerHTML = md($('#wk-content').value) + (bl.length ? `<div class="wk-backlinks"><b>Linked from tasks</b><ul>${bl.map((t) => `<li data-task="${esc(t.id)}">${esc(t.title)}</li>`).join('')}</ul></div>` : '');
  $('#wk-view').querySelectorAll('.wk-backlinks li').forEach((d) => d.onclick = () => { sel.task = d.dataset.task; showTab('board'); renderBoard(); });
  const ms = performance.now() - t0; // preview/backlink draw cost, same wkStats as the list rebuild
  wkStats.shows = (wkStats.shows || 0) + 1;
  if (ms > wkStats.maxMs) wkStats.maxMs = ms;
}
$('#wk-edit').onclick = () => { const on = !wikiEdit; if (on) wkBaseUpdated = (sel.page && S.wiki[sel.page]) ? (S.wiki[sel.page].updatedAt || null) : null; wikiEdit = on; showWiki(); };
$('#wk-save').onclick = async () => {
  const t = $('#wk-title').value.trim();
  if (!t) { alert('Give the page a title before saving.'); $('#wk-title').focus(); return; }
  if (t !== sel.page && S.wiki[t] && !confirm(`A page titled "${t}" already exists. Overwrite it?`)) return;
  const prev = sel.page && sel.page !== t && S.wiki[sel.page] ? sel.page : null; // title change would otherwise leave the old page behind as a stray duplicate
  if (prev && !confirm(`Rename page "${prev}" to "${t}"? The old page will be removed.`)) return;
  if (t === sel.page && S.wiki[t] && (S.wiki[t].updatedAt || null) !== wkBaseUpdated && !confirm('This page changed elsewhere since you started editing. Save over it?')) return;
  $('#wk-save').disabled = true;
  try {
    await call('writeWiki', t, $('#wk-content').value);
    if (prev) await call('deleteWiki', prev);
    sel.page = t; wikiEdit = false; wkBaseUpdated = null; refresh();
  } catch (e) { alert(String(e.message || e).replace(/^Error invoking remote method 'api': (Error: )?/, '')); }
  finally { $('#wk-save').disabled = false; }
};
$('#wk-del').onclick = async () => { $('#wk-more').open = false; if (sel.page && confirm(`Delete page "${sel.page}"? This can't be undone.`)) { try { await call('deleteWiki', sel.page); sel.page = null; wikiEdit = false; wkBaseUpdated = null; $('#wk-title').value = ''; $('#wk-content').value = ''; refresh(); } catch (e) { alert(String(e.message || e).replace(/^Error invoking remote method 'api': (Error: )?/, '')); } } };

// ---------- observability ----------
const logTeamNodes = () => S.allNodes.filter((n) => teamScoped(sel.logTeam, n.id));
const obsIdleOpen = new Set();
function renderObs() {
  if (!$('#tab-obs').classList.contains('active')) return;
  let cur = $('#logfilter').value; // clicking a row changes only this, so it must gate the rebuild (t_h0a1c2fa bug 1)
  const okey = [S.v && S.v.project, S.v && S.v.teams, S.v && S.v.settings, ctx.p, logs.length, (logs[logs.length - 1] || {}).at, S.tasks.length, sel.logTeam, S.orch.runCost, S.orch.runTokens, agentStamp(), cur].join('|');
  if (okey === obsSig) return; obsSig = okey;
  const teams = (S.project && S.project.teams) || [];
  const tf = $('#logteam'); tf.innerHTML = '<option value="">All teams</option>' + teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join(''); tf.value = sel.logTeam;
  const nodes = logTeamNodes();
  if (cur && !nodes.some((n) => n.id === cur)) cur = '';
  const counts = {}; let total = 0;
  const ids = new Set(nodes.map((n) => n.id));
  for (const l of logs) if (l.projectId === ctx.p && ids.has(l.nodeId)) { counts[l.nodeId] = (counts[l.nodeId] || 0) + 1; total++; }
  const idleKey = (n) => { const a = S.orch.agents[n.id] || {}; return (!a.status || a.status === 'idle') && !a.taskId && cur !== n.id ? `${runtimeLabel(n.runtime || 'claude')} · ${n.model || 'default'}` : null; };
  const idleGroups = {}; for (const n of nodes) { const k = idleKey(n); if (k) (idleGroups[k] = idleGroups[k] || []).push(n); }
  const collapsed = new Set(); let idleRows = '';
  for (const [k, g] of Object.entries(idleGroups)) if (g.length > 2 && !obsIdleOpen.has(k)) { g.forEach((n) => collapsed.add(n.id));
    idleRows += `<div class="logagent-row idlegroup" data-idle="${esc(k)}"><span class="avatar sm" style="background:#3a3f4b">${g.length}</span><span class="lameta"><b>${g.length} idle agents</b><small class="lastat">${esc(k)} · click to expand</small></span><span class="lacount">${g.reduce((x, n) => x + (counts[n.id] || 0), 0)}</span></div>`; }
  const rows = idleRows + nodes.filter((n) => !collapsed.has(n.id)).map((n) => { const a = S.orch.agents[n.id] || {}; const w = who(n.id);
    const ttl = a.task || (S.tasks.find((t) => t.id === a.taskId) || {}).title || '';
    // Status line reads "working · t_xxxx title"; the model is secondary muted text below (t_e503dd78).
    const stat = [`<span class="lst-${esc(a.status || 'idle')}">${esc(a.status || 'idle')}</span>`,
      a.taskId ? `<span class="ltid" title="${esc(ttl || a.taskId)}">${esc(shortTaskId(a.taskId))}</span>` : '',
      ttl ? `<span class="lttl">${esc(ttl)}</span>` : ''].filter(Boolean).join(' · ');
    const model = `${runtimeLabel(n.runtime || 'claude')} · ${n.model || 'default'}`;
    return `<div class="logagent-row ${cur === n.id ? 'sel' : ''}" data-id="${n.id}"><span class="avatar sm ${a.status === 'working' ? 'working' : ''}" style="background:${avatarBg(w)}" title="${esc(w.name)}">${avatarBody(n.id, w)}</span><span class="lameta"><b>${esc(n.name)}</b><small class="lastat">${stat}</small><small class="lamodel" title="${esc(model)}">${esc(model)}</small></span><span class="lacount" title="${counts[n.id] || 0} log lines">${counts[n.id] || 0}</span><span class="lactions">${orphanedTasks().filter((t) => t.assignee === n.id).slice(0, 1).map((t) => stuckBtn(t.id)).join('')}${a.status === 'working' ? `<button data-stopagent="${n.id}" title="Stop">⏹</button>` : ''}<button data-msgagent="${n.id}" title="Message">✉</button></span></div>`; }).join('');
  $('#logagents').innerHTML = `<div class="logagent-row ${!cur ? 'sel' : ''}" data-id=""><span class="avatar sm" style="background:#3a3f4b">∀</span><span class="lameta"><b>All agents</b><small class="lastat">every session</small></span><span class="lacount" title="${total} log lines">${total}</span></div>` +
    (rows || '<p class="muted logempty">No agents in this team.</p>');
  document.querySelectorAll('#logagents [data-idle]').forEach((d) => d.onclick = () => { obsIdleOpen.add(d.dataset.idle); obsSig = ''; renderObs(); });
  document.querySelectorAll('#logagents .logagent-row[data-id]').forEach((d) => d.onclick = (e) => { if (e.target.closest('.lactions')) return; $('#logfilter').value = d.dataset.id; renderLog(); renderObs(); });
  wireStuckBtns();
  document.querySelectorAll('[data-stopagent]').forEach((b) => b.onclick = act(async (e) => { e.stopPropagation(); await call('stopAgent', b.dataset.stopagent); refresh(); }));
  document.querySelectorAll('[data-msgagent]').forEach((b) => b.onclick = act(async (e) => { e.stopPropagation(); const v = await ask(`Message to ${nodeName(b.dataset.msgagent)} (a running agent is interrupted and resumed with it)`); if (v) { await call('sendToAgent', b.dataset.msgagent, v); refresh(); } }));
  const bs = S.orch.budgetStop ? esc(S.orch.budgetStop) : ''; const st = S.settings; const orphans = orphanedTasks();
  const orphanNote = orphans.length ? `${orphans.length} task${orphans.length > 1 ? 's' : ''} stuck in_progress with no live worker (${esc(orphans.slice(0, 3).map((t) => t.title).join(', '))}${orphans.length > 3 ? '…' : ''})` : '';
  const stopMsg = !S.orch.running ? [bs, orphanNote].filter(Boolean).join(' · ') : (bs ? [bs, orphanNote].filter(Boolean).join(' · ') : '');
  $('#budgetbar').innerHTML = (st.budgetUsd || st.budgetTokens ? `Run budget: ${st.budgetUsd ? `$${(S.orch.runCost || 0).toFixed(4)} / $${st.budgetUsd}` : ''}${st.budgetUsd && st.budgetTokens ? ' · ' : ''}${st.budgetTokens ? `token budget ${fmtTok(st.budgetTokens)} tok per run (enforced — per-key split in Usage; token totals are no longer summed)` : ''}` : '') + (stopMsg ? ` <span class="warn">Stopped: ${stopMsg}</span>` : '');
  const f = $('#logfilter'); f.innerHTML = '<option value="">All agents</option>' + nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join(''); f.value = cur;
}
const LOG_LEVEL = { error: 'error', stderr: 'error', tool_error: 'error', system: 'info', tool: 'tool', tool_result: 'tool', result: 'ok', raw: 'muted', compacted: 'compact', event: 'info', monitor: 'monitor', watch: 'watch' };
// Monitor line (plan t_a4ceb629/C, watchdog decision): prefer the structured {reason, taskIds, action}
// fields Dev A sends with the event; fall back to the raw text for lines persisted without them.
function monitorText(l) {
  const ids = Array.isArray(l.taskIds) && l.taskIds.length ? ` (${l.taskIds.join(', ')})` : '';
  return esc((([l.action, l.reason].filter(Boolean).join(' — ') || l.text) || '') + ids);
}
// "Read {"file_path":"/a/b.js"}" -> summary "Read b.js"; the raw JSON only shows on expand.
function humanLog(t) {
  const m = /^\s*([\w.:-]+)?\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/.exec(t || ''); if (!m) return null;
  let o; try { o = JSON.parse(m[2]); } catch { return null; }
  const pick = o && !Array.isArray(o) && (o.file_path || o.path || o.command || o.pattern || o.url || o.description || o.query);
  const arg = pick ? String(pick).split('\n')[0] : '';
  const head = [m[1] || 'Event', arg].filter(Boolean).join(' ');
  return { head: head.length > 140 ? head.slice(0, 139) + '…' : head, json: JSON.stringify(o, null, 2) };
}
// logRow re-formats every visible row's clock with toLocaleTimeString on each full rebuild —
// ~6.5 ms per 200-row window (93% of the row-build compute, measured at profile sizes). The
// string is a pure function of the raw timestamp (the locale options are fixed), so cache it
// keyed on the value the line carries; the map is capped and simply resets when full.
const logTimeCache = new Map();
function logTime(at) {
  let tm = logTimeCache.get(at);
  if (tm === undefined) {
    const d = new Date(at);
    tm = isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (logTimeCache.size >= 20000) logTimeCache.clear();
    logTimeCache.set(at, tm);
  }
  return tm;
}
function logRow(l) {
  l = l || {}; // a null/primitive line renders as a system row instead of killing the whole build
  const w = who(l.nodeId); const lvl = LOG_LEVEL[l.kind] || 'text';
  const task = l.taskId ? `<span class="logtask" data-tasklink="${esc(l.taskId)}" title="${esc(l.task || l.taskId)} — open in task thread">${esc(shortTaskId(l.taskId))}</span>` : '';
  const badge = l.kind === 'monitor' ? 'Monitor' : l.kind === 'watch' ? 'Watch' : esc(l.kind);
  let text = l.kind === 'monitor' ? monitorText(l) : esc(l.text);
  const hum = humanLog(l.text);
  if (hum && l.kind !== 'monitor') text = `<details class="logjson"><summary>${esc(hum.head)}</summary><pre>${esc(hum.json)}</pre></details>`;
  const tm = logTime(l.at);
  return `<div class="logrow lv-${lvl}"><span class="logtime">${tm}</span><span class="avatar sm" style="background:${avatarBg(w)}" title="${esc(w.name)}">${avatarBody(l.nodeId, w)}</span><span class="logagent" title="${esc(w.name)}">${esc(w.name)}</span>${task}<span class="loglevel lv-${lvl}">${badge}</span><span class="logtext">${text}</span></div>`;
}
// ---------- subagents (contract: t_c33656ba) ----------
// Records live on the owning agent (S.orch.agents[id].subagents) for the current run and persist per
// run in RUNS[i].subagents; a child log row carries subagentId. Unknown ids render a minimal block.
function subRecOf(sid) {
  // Per-draw index (t_1fb02462): renderers reset CH.subIndex before walking bubbles. Lookups used
  // to scan every agent's subagents and then every run — several times per subagent bubble — which
  // is O(runs) per call once records persist. Priority is unchanged: live agent records beat runs.
  let m = CH.subIndex;
  if (!m) { m = new Map();
    for (const a of Object.values(S.orch.agents || {})) for (const x of (a.subagents || [])) if (x && x.id && !m.has(x.id)) m.set(x.id, x);
    for (const r of RUNS || []) for (const x of (r.subagents || [])) if (x && x.id && !m.has(x.id)) m.set(x.id, x);
    CH.subIndex = m; }
  return m.get(sid) || null;
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
const severityOf = (l) => (l && (l.level || LOG_SEVERITY[l.kind])) || 'info'; // malformed/null line degrades to info, never throws the filter
function renderLogLevelChips() {
  $('#loglevels').innerHTML = ['info', 'warn', 'error'].map((lv) => `<button class="lvchip lv-${lv}${logLevels.has(lv) ? ' on' : ''}" data-lv="${lv}" aria-pressed="${logLevels.has(lv)}" title="${logLevels.has(lv) ? 'Hide' : 'Show'} ${lv} lines"><span class="dot" aria-hidden="true"></span>${lv}</button>`).join('');
  document.querySelectorAll('#loglevels [data-lv]').forEach((b) => b.onclick = () => { const lv = b.dataset.lv; logLevels.has(lv) ? logLevels.delete(lv) : logLevels.add(lv); renderLogLevelChips(); renderLog(); });
}
renderLogLevelChips();
// Windowing (t_fb193107): like the chat room, the log list renders only the last LOG_PAGE matching
// lines; scroll-up (or the older-bar) prepends the next page, anchored. Returning to the bottom
// (the live tail) shrinks the window again so streaming keeps the DOM bounded.
const LOG_PAGE = 200;
let logWin = LOG_PAGE;
// Bottom re-pin (t_fe51eee9): content-visibility resolves a row's real size only when it paints,
// so a scrollTop = scrollHeight assignment made during a draw pins to estimate-based heights and
// drifts off the tail as real sizes land (measured: 321px in the chat room). One frame after
// paint the visible rows have real sizes — re-pin then, unless the user scrolled away in between.
const repinBottom = (box) => { const top = box.scrollTop; requestAnimationFrame(() => requestAnimationFrame(() => { if (box.scrollTop >= top - 50) box.scrollTop = box.scrollHeight; })); };
// Monotonic sequence for streamed lines + cursor of what the log DOM already shows: appendLogTail
// (below) fast-appends lines with _seq past the cursor instead of rebuilding the window.
let logSeq = 0, logTailSeq = 0, logTailAt = 0;
$('#log').addEventListener('scroll', () => { const box = $('#log');
  if (box.scrollTop < 80 && renderLog.total > logWin) { logWin += LOG_PAGE; renderLog(); }
  else if (box.scrollTop + box.clientHeight >= box.scrollHeight - 20 && logWin > LOG_PAGE) { logWin = LOG_PAGE; renderLog(); }
  else if (logTailDirty && box.scrollTop + box.clientHeight >= box.scrollHeight - 20) renderLog(); });
// Signature of exactly what the log DOM shows — shared by the full render and the fast-append
// path, so a redundant renderLog after an append early-returns.
const logKey = () => [ctx.p, logs.length, (logs[logs.length - 1] || {}).at, logWin, $('#logfilter').value, $('#logsearch').value, [...logLevels].join(), sel.logTeam, logsLoaded.has(ctx.p)].join('|');
function renderLog() {
  CH.subIndex = null; // per-draw subagent record index (see subRecOf)
  if (!$('#tab-obs').classList.contains('active')) return;
  const lkey = logKey();
  if (lkey === logSig) return;
  const t0 = performance.now();
  const f = $('#logfilter').value; const q = ($('#logsearch').value || '').trim().toLowerCase();
  const teamIds = sel.logTeam ? new Set(logTeamNodes().map((n) => n.id)) : null;
  const box = $('#log'); const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  const prevH = box.scrollHeight, prevTop = box.scrollTop;
  // Malformed stored lines (null entry, non-string text from a bad push) must be skipped or
  // stringified here — a throw mid-build leaves logSig unstamped, so every later render throws
  // again and the pane freezes (logRow's own guard would never be reached).
  const all = logs.filter((l) => l && l.projectId === ctx.p && (!teamIds || teamIds.has(l.nodeId)));
  const base = all.filter((l) => (!f || l.nodeId === f) && (!q || String(l.text ?? '').toLowerCase().includes(q)));
  base.sort((a, b) => (a.at || 0) - (b.at || 0));
  let rows = base.filter((l) => logLevels.has(severityOf(l)));
  let hiddenInfo = 0;
  if (!rows.length && base.length) {
    hiddenInfo = base.filter((l) => !logLevels.has(severityOf(l))).length;
    if (hiddenInfo) rows = base;
  }
  renderLog.total = rows.length;
  const page = Chat.pageOf(rows, logWin);
  renderLog.winItems = page.items.length;
  // The tail cursor is captured but stamped only after the DOM actually built: a throw mid-build
  // (malformed line, bad subagent record) must not mark lines as rendered — appendLogTail would
  // then treat them as already shown and hide them for good.
  const tailAt = rows.length ? rows[rows.length - 1].at : 0;
  const tailSeq = logSeq;
  const empty = teamIds && !all.length ? 'No messages for this team.' : (all.length ? 'No log lines match your filter.' : 'No activity yet — run the team to see agent logs here.');
  const older = page.hidden ? `<button id="log-older" class="olderbar linklike">↑ ${page.hidden} earlier line${page.hidden === 1 ? '' : 's'} — scroll up or click to load</button>` : '';
  box.innerHTML = rows.length ? (hiddenInfo ? `<p class="muted logempty">${hiddenInfo} info line(s) hidden by the level filter — showing all. <button id="log-showall" class="linklike">Show all</button></p>` : '') + older +
    Subagents.nestRows(page.items, subRecOf, null).map((x) => x.kind === 'sub' ? subBlockHtml(x) : logRow(x.l)).join('') : `<p class="muted logempty">${empty}</p>`;
  logTailAt = tailAt; logTailSeq = tailSeq; logSig = lkey; logTailDirty = false; // stamped only after the DOM actually built: a throw mid-build (malformed line, bad subagent record) must not mark the pane as rendered — renderLog would then early-return forever and freeze it
  const sa = document.getElementById('log-showall'); if (sa) sa.onclick = () => { logLevels.add('info'); logLevels.add('warn'); logLevels.add('error'); renderLogLevelChips(); renderLog(); };
  const ob = document.getElementById('log-older'); if (ob) ob.onclick = () => { logWin += LOG_PAGE; renderLog(); };
  bindSubToggles(renderLog);
  document.querySelectorAll('#log [data-tasklink]').forEach((d) => d.onclick = () => { sel.task = d.dataset.tasklink; showTab('board'); renderBoard(); });
  if (atBottom && $('#logauto').checked) { box.scrollTop = box.scrollHeight; repinBottom(box); }
  else box.scrollTop = Chat.anchorScroll(prevTop, prevH, box.scrollHeight);
  const ms = performance.now() - t0;
  const p = PERF.logPane;
  p.samples.push(ms); if (p.samples.length > 120) p.samples.shift();
  if (ms > p.SLOW_MS) { p.slow++; console.debug('log pane render slow', ms.toFixed(2), 'ms'); }
}
$('#logteam').onchange = () => { sel.logTeam = $('#logteam').value; $('#logfilter').value = ''; renderObs(); renderLog(); };
$('#logfilter').onchange = renderLog;
let logSearchTimer = 0;
$('#logsearch').oninput = () => { clearTimeout(logSearchTimer); logSearchTimer = setTimeout(renderLog, 150); }; // each keystroke re-filters and rebuilds the whole window (~56ms at profile sizes) — render once per typing pause
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
// t_6cbe12ed: a run landing bumps S.v.runs, so under stream churn every delta-pump frame rebuilt
// the ledger (~4.2 ms at 471 runs, t_0bd4680f — ~25% main thread at frame rate). Leading+trailing
// debounce: activation and filter changes still draw at once when the view is quiet, a streaming
// burst coalesces into at most one rebuild per window, and the trailing call guarantees the last
// state lands.
const USAGE_DEBOUNCE_MS = 300;
let usageLastDraw = 0, usageTimer = 0;
function renderUsage() {
  if (!$('#tab-usage').classList.contains('active')) return;
  const now = Date.now();
  if (now - usageLastDraw >= USAGE_DEBOUNCE_MS) {
    if (usageTimer) { clearTimeout(usageTimer); usageTimer = 0; }
    usageLastDraw = now;
    renderUsageNow();
  } else if (!usageTimer) {
    usageTimer = setTimeout(() => { usageTimer = 0; if (!$('#tab-usage').classList.contains('active')) return; usageLastDraw = Date.now(); renderUsageNow(); }, USAGE_DEBOUNCE_MS - (now - usageLastDraw));
  }
}
function renderUsageNow() {
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
  if (!RUNS.length) { $('#us-summary').innerHTML = '<div class="us-empty"><svg class="us-empty-ico" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 20V10M11 20V4M18 20v-7"/></svg><b>No runs yet</b><p>Cost, token and model breakdowns appear here after an agent finishes its first run.</p><button type="button" class="primary" id="us-run-goal">Run a goal</button></div>'; $('#us-runs').innerHTML = ''; { const b = $('#us-run-goal'); if (b) b.onclick = () => showTab('chat'); } renderDiscovery(); renderUsageLimits(); return; }
  $('#us-summary').innerHTML = usageHero(rs, led, { global: globalCost, filtered }) + `
  <div class="us-vendor"><small>One row per account — where the money actually goes (billing source + its detail: which login, API key or endpoint) — with each account's model keys nested beneath. Token columns stay strictly per key (never summed across models); cost is the only grand total. "—" marks keys whose cost is unknown, "est" marks list-price estimates.</small><h4>By account</h4>${accounts.length ? accountTable(accounts) : '<p class="muted">No usage recorded yet.</p>'}</div>
  <div class="cards">
    <div class="stat" id="us-cost"><small>API-eq — the only grand total</small><b>$${led.costUsd.toFixed(4)}</b><small>$${s.billed.toFixed(4)} billed per token (API key / proxy / cloud) · $${s.sub.toFixed(4)} on ${rs.filter((r) => r.billingSource === 'subscription').length} subscription run(s), covered${led.costPartial ? '<br><span class="warn">Partial: some model keys report no cost — their $ is missing, not zero</span>' : ''}</small></div>
    <div class="stat"><small>Runs</small><b>${s.runs}</b><small>${['agent', 'check', 'preflight'].map((k) => `${rs.filter((r) => (r.kind || 'agent') === k).length} ${k}`).join(' · ')} · ${s.numTurns} turns</small></div>
    <div class="stat"><small>Cost sources</small><b>${cs.reported} reported${cs.estimated ? ` · ${cs.estimated} est` : ''}</b><small>${cs.unknown ? `${cs.unknown} key${cs.unknown === 1 ? '' : 's'} with unknown cost render as —` : cs.estimated ? 'est = list-price estimate for keys that report no cost themselves' : 'every key reports its own cost'}</small></div>
    <div class="stat"><small>Tracking</small><b>${led.rows.length} model key${led.rows.length === 1 ? '' : 's'}</b><small>${S.orch.usageSince ? `since ${new Date(S.orch.usageSince).toLocaleDateString()} · ` : ''}tokens are never summed across models</small></div>
  </div>${mism ? `<p class="warn">${mism} run(s) did not run on the billing mode set for the agent (see Billing column).</p>` : ''}
  <div class="us-breakdowns">${modelBars(led.rows)}${costBars('By runtime', rtBars)}${costBars('By agent', agBars)}</div>
  <details><summary>Detailed tables</summary><div class="seg" id="us-seg">${['Model', 'Agent', 'Billing', 'Task'].map((g, i) => `<button data-g="${i}" class="${i === usageGroup ? 'on' : ''}" aria-pressed="${i === usageGroup}">${g}</button>`).join('')}</div><div class="us-groups" data-g="${usageGroup}">${modelTableBlock(led.rows)}${keyTableBlock('By agent', Object.entries(led.byAgent).flatMap(([name, rows2]) => rows2.map((row) => ({ name, row }))))}${billingTable(rs)}${keyTableBlock('By task', Object.entries(led.byTask).flatMap(([tid, g2]) => (g2.rows || g2).map((row) => ({ name: taskName(tid), row }))))}</div></details>`;
  $('#us-seg').onclick = (ev) => { const b = ev.target.closest('button[data-g]'); if (!b) return; usageGroup = +b.dataset.g; $('#us-seg').querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); $('#us-summary .us-groups').dataset.g = usageGroup; };
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
  const st = await usageStatusOnce();
  const cnt = (n) => n > 0 ? String(n) : '—';
  const reason = (!st || (!st.fiveHour.limit && !st.weekly.limit)) ? await noLimitDataReason() : null;
  const limPart = (label, u) => {
    if (!u || !u.limit) return `<span class="lm-part lm-pending" title="${esc(label)}: ${reason ? `no limit data — ${esc(reason)}` : 'no limit set or reported yet'}"><b>${esc(label)}</b> <small>— ${reason ? 'no data' : 'not set'}</small></span>`;
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
  if (!u || !u.limit) return `<div class="stat"><small>${esc(label)}</small><b>${u && u.used ? fmt(u.used) : '—'}</b><small class="muted">no limit set</small></div>`;
  const pct = Math.min(100, Math.round((u.pct != null ? u.pct : (u.used / u.limit)) * 100));
  const cls = u.pause ? 'danger' : u.warn ? 'warn' : 'ok';
  return `<div class="stat"><small>${esc(label)}</small><b>${fmt(u.used)} <span class="muted">/ ${fmt(u.limit)}</span></b>
    <div class="meter"><div class="meter-fill ${cls}" style="width:${pct}%"></div></div>
    <small class="${cls === 'ok' ? 'muted' : 'warn'}">${pct}% used${u.pause ? ' — limit reached' : u.warn ? ' — approaching limit' : ''}</small></div>`;
}
async function renderUsageLimits() {
  const lim = S.settings.usageLimits || {}; const st = await usageStatusOnce();
  const money = (v) => '$' + (v || 0).toFixed(2);
  // The top bar names only the worst provider; this tab lists every provider's windows (same chips).
  const provs = limitProviders(st);
  $('#us-limits').innerHTML = `<h3>Usage limits</h3><p class="muted">The top bar shows one warning chip only when a limit is at 80% or more; every provider's limit windows are always listed here (5h/weekly budgets settable below).</p>${st && st.warn ? `<p class="warn">Approaching a usage limit.</p>` : ''}${st && st.pause ? `<p class="warn">A usage limit has been reached; new runs may be paused.</p>` : ''}
    ${provs.length ? `<div class="limitmeter us-list">${provs.map((p) => providerChipHtml(p, false)).join('')}</div>` : ''}
    <div class="lim-wrap">
    <div class="cards">
      ${usageLimitBar('API key/proxy, reported cost', st && st.cost, money)}
      ${usageLimitBar('API key/proxy, tokens', st && st.tokens, fmtTok)}
    </div>
    <form id="lim-form" class="lim-grid">
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
function usageSub(name) {
  const ids = { summary: ['#us-summary'], discovery: ['#us-discovery'], limits: ['#us-limits'], runs: ['#us-runs-wrap'] };
  for (const k in ids) $(ids[k][0]).hidden = k !== name;
  $('#us-anchors').querySelectorAll('button').forEach((b) => { const on = b.dataset.sub === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
}
$('#us-anchors').onclick = (ev) => { const b = ev.target.closest('button[data-sub]'); if (b) usageSub(b.dataset.sub); };
usageSub('summary');
$('#us-agent').onchange = renderUsage; $('#us-billing').onchange = renderUsage;
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
$('#us-export').onclick = act(async () => download(`usage-${(S.project.name || 'project').replace(/[^\w-]+/g, '_')}.csv`, await call('usageCSV', false), 'text/csv'));
$('#us-exportall').onclick = act(async () => download('usage-all-projects.csv', await call('usageCSV', true), 'text/csv'));
$('#us-clear').onclick = act(async () => { if (!confirm('Clear the usage history of this project?')) return; await call('clearRuns'); refresh(); });

// ---------- settings ----------
// The settings tab has no render signature, so while agents stream every renderAll tick (~200ms
// apart, renderSched) rebuilt the whole form via innerHTML — and each rebuild wiped focus and any
// unsaved input mid-keystroke. Debounce the rebuild around editing instead: skip while a form
// field holds focus or a keystroke landed within the grace window; the next idle tick (or the
// save button's own refresh) re-renders with the stored values.
const SET_EDIT_GRACE_MS = 800;
let setEditAt = 0;
const setField = (el) => !!el && !!el.matches && el.matches('#settingsform input, #settingsform textarea, #settingsform select');
document.addEventListener('focusin', (e) => { if (setField(e.target)) setEditAt = Date.now(); });
document.addEventListener('input', (e) => { if (setField(e.target)) setEditAt = Date.now(); });
function renderSettings(force) {
  if (!force && (setField(document.activeElement) || Date.now() - setEditAt < SET_EDIT_GRACE_MS)) return;
  const s = S.settings;
  const tplCur = $('#tpl-select') ? $('#tpl-select').value : '';
  $('#settingsform').innerHTML = `<h3 class="set-pagetitle">Settings</h3>
    <div class="set-path"><span>Project data</span><code title="${esc(S.dir)}">${esc(S.dir)}</code><button id="st-copydir" title="Copy path">Copy</button></div>
    <section class="set-sec"><h3>Runtime</h3><div class="set-rows">
    <div class="set-row stack"><div class="set-lab"><label for="st-claude">Claude CLI path</label><p class="set-hint">Binary used to launch agents. Leave as-is unless your CLI lives outside PATH.</p></div><input id="st-claude" value="${esc(s.claudePath)}"></div>
    <div class="set-row"><div class="set-lab"><label for="tpl-select">Template for new project / team</label></div><div class="set-ctl"><select id="tpl-select">${Object.entries(P.templates).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-perm">Default permission mode</label><p class="set-hint">Agents can override this per node.</p></div><div class="set-ctl"><select id="st-perm">${['bypassPermissions', 'acceptEdits', 'default', 'plan'].map((m) => `<option ${m === s.permissionMode ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
    </div></section>
    <section class="set-sec"><h3>Limits &amp; budgets</h3><div class="set-rows">
    <div class="set-row"><div class="set-lab"><label for="st-conc">Max concurrent agents</label><p class="set-hint">How many agents may run at the same time.</p></div><div class="set-num"><input id="st-conc" type="number" min="1" max="8" value="${s.maxConcurrency ?? 2}"><span class="set-unit">agents</span></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-maxagents">Max agents per team</label><p class="set-hint">Core agent recruit limit.</p></div><div class="set-num"><input id="st-maxagents" type="number" min="1" value="${s.maxAgents ?? 6}"><span class="set-unit">agents</span></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-runs">Max agent runs per Run</label><p class="set-hint">Safety cap for the scheduler.</p></div><div class="set-num"><input id="st-runs" type="number" min="1" value="${s.maxRuns ?? 30}"><span class="set-unit">runs</span></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-budgetusd">Project budget per Run</label><p class="set-hint">Stops all agents when reached. 0 = no limit.</p></div><div class="set-num"><span class="set-unit">$</span><input id="st-budgetusd" type="number" min="0" step="0.01" value="${s.budgetUsd || 0}"></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-budgettok">Project token budget per Run</label><p class="set-hint">Input + output. 0 = no limit.</p></div><div class="set-num"><input id="st-budgettok" type="number" min="0" step="1000" value="${s.budgetTokens || 0}"><span class="set-unit">tokens</span></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-autocompactpct">Auto-compact at</label><p class="set-hint">Context usage that triggers /compact. 0 = off.</p></div><div class="set-num"><input id="st-autocompactpct" type="number" min="0" max="95" value="${s.autoCompactPct ?? 40}"><span class="set-unit">%</span></div></div>
    </div></section>
    <section class="set-sec"><h3>Recovery</h3><div class="set-rows">
    <div class="set-row"><div class="set-lab"><label for="st-stuck">Stuck warning after</label><p class="set-hint">Flag a run that has been silent this long.</p></div><div class="set-num"><input id="st-stuck" type="number" min="1" value="${s.stuckMinutes || 5}"><span class="set-unit">min</span></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-stall">Stall timeout</label><p class="set-hint">Stop + auto-resume a silent run. Max 2 recoveries, then the task is marked recovery failed.</p></div><div class="set-num"><input id="st-stall" type="number" min="1" value="${s.stallTimeoutMin ?? 10}"><span class="set-unit">min</span></div></div>
    </div></section>
    <section class="set-sec"><h3>Approvals</h3><div class="set-rows">
    <div class="set-row"><div class="set-lab"><label>Require approval for every agent's "done"</label><p class="set-hint">A human confirms before a task counts as done.</p></div><div class="set-ctl"><input type="checkbox" id="st-approval" ${s.requireApproval ? 'checked' : ''}></div></div>
    <div class="set-row"><div class="set-lab"><label for="st-tcappr">Core team changes</label><p class="set-hint">Recruit / retire / update — ask the human first, or apply automatically.</p></div><div class="set-ctl"><select id="st-tcappr">${['ask', 'auto'].map((m) => `<option ${m === (s.teamChangeApproval ?? 'ask') ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
    <div class="set-row"><div class="set-lab"><label>Desktop notifications</label><p class="set-hint">Approval needed, budget reached, run finished.</p></div><div class="set-ctl"><input type="checkbox" id="st-notify" ${s.notifications === false ? '' : 'checked'}></div></div>
    </div></section>
    <p class="set-actions"><button id="st-save" class="primary">Save settings</button></p>
    ${upd.devMode === false ? '' : `<hr><section class="set-sec"><h3>App updates</h3>
    <label class="inline"><input type="checkbox" id="st-autorestart" ${upd.enabled ? 'checked' : ''}> Auto-restart on new merged code</label>
    <p class="muted">When new commits land on this app's base branch: pause the scheduler, wait for running agents to finish, test the new code, then relaunch and resume the run. Failed tests cancel the restart.</p>
    <div id="upd-history"></div></section>`}
    <h3>Role presets (this project)</h3><p class="muted">Presets appear as role suggestions. A new agent whose role matches a preset gets its prompt, tools and permission mode.</p>
    <table id="presettable"><tr><th>Name</th><th>Permission</th><th>Allowed</th><th>Disallowed</th><th></th></tr>${(s.rolePresets || []).filter((p) => p && p.name).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.permissionMode || 'default')}</td><td>${esc((p.allowedTools || []).join(', '))}</td><td>${esc((p.disallowedTools || []).join(', '))}</td><td><button data-editp="${esc(p.name)}">Edit</button><button data-delp="${esc(p.name)}">Delete</button></td></tr>`).join('')}</table>
    <div id="presetform"><label>Name</label><input id="pr-name"><label>Default system prompt</label><textarea id="pr-prompt" rows="3"></textarea>
    <label>Default allowed tools</label><input id="pr-allowed" placeholder="Read, Grep"><label>Default disallowed tools</label><input id="pr-disallowed">
    <label>Permission mode</label><select id="pr-perm"><option value="">project default</option>${(S.config.permissionModes || []).map((m) => `<option>${m}</option>`).join('')}</select>
    <p><button id="pr-save">Save preset</button></p></div>
    <hr>${renderRuntimesSection()}`;
  const ts = $('#tpl-select'); if (ts && tplCur) ts.value = tplCur;
  $('#st-copydir').onclick = async () => {
    try { await navigator.clipboard.writeText(S.dir); } catch { const t = document.createElement('textarea'); t.value = S.dir; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    $('#st-copydir').textContent = 'Copied'; setTimeout(() => { const b = $('#st-copydir'); if (b) b.textContent = 'Copy'; }, 1200);
  };
  wireRuntimesSection(); wireDraftForm();
  document.querySelectorAll('[data-delp]').forEach((b) => b.onclick = act(async () => { await call('deletePreset', b.dataset.delp); refresh(); }));
  document.querySelectorAll('[data-editp]').forEach((b) => b.onclick = () => { const p = (s.rolePresets || []).find((x) => x.name === b.dataset.editp); if (!p) return; $('#pr-name').value = p.name; $('#pr-prompt').value = p.systemPrompt || ''; $('#pr-allowed').value = (p.allowedTools || []).join(', '); $('#pr-disallowed').value = (p.disallowedTools || []).join(', '); $('#pr-perm').value = p.permissionMode || ''; });
  $('#pr-save').onclick = act(async () => { const name = $('#pr-name').value.trim(); if (!name) return; await call('savePreset', { name, systemPrompt: $('#pr-prompt').value, allowedTools: $('#pr-allowed').value, disallowedTools: $('#pr-disallowed').value, permissionMode: $('#pr-perm').value }); refresh(); });
  // Clamp every number to its declared min/max: the HTML attrs only constrain spinner clicks, and
  // `+x || fallback` lets a hand-typed negative through (e.g. -5 concurrency, a negative budget
  // that disables the limit it was meant to enforce). Typed numbers clamp; only empty/garbage
  // input takes the default — `+0 || fb` misread a hand-typed 0 as "empty" and saved the default
  // instead of the min (0 max-runs meant "no cap" to the user but stored 30, 0 concurrency 2).
  const numv = (id, fb, lo, hi) => { const v = $('#' + id).value.trim(); if (v === '' || !Number.isFinite(+v)) return fb; return Math.max(lo, hi === undefined ? +v : Math.min(hi, +v)); };
  $('#st-save').onclick = act(async () => { await call('saveSettings', { claudePath: $('#st-claude').value.trim() || 'claude', maxConcurrency: numv('st-conc', 2, 1, 8), maxRuns: numv('st-runs', 30, 1), permissionMode: $('#st-perm').value,
    budgetUsd: Math.max(0, +$('#st-budgetusd').value || 0), budgetTokens: Math.max(0, +$('#st-budgettok').value || 0), requireApproval: $('#st-approval').checked, notifications: $('#st-notify').checked, stuckMinutes: numv('st-stuck', 5, 1),
    stallTimeoutMin: numv('st-stall', 10, 1),
    maxAgents: numv('st-maxagents', 6, 1), teamChangeApproval: $('#st-tcappr').value === 'auto' ? 'auto' : 'ask',
    autoCompactPct: numv('st-autocompactpct', 40, 0, 95) }); refresh(); });
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
    deferredTo: shortSha(d.deferredTo ?? ''),
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
  // A guard-deferred restart (t_f6976152) keeps phase 'idle' — no veil, dispatch keeps running — but
  // the queued update must stay visible or the waiting commits look ignored (t_139bd3eb).
  const deferred = !live && upd.state === 'idle' && !!upd.deferredTo && upd.devMode !== false;
  c.classList.toggle('hidden', !live && !deferred);
  if (!live) {
    renderUpdVeil(false);
    if (!deferred) return;
    c.className = 'pill upd-deferred';
    c.textContent = 'update waiting';
    c.title = `Restart deferred — ${upd.deferredTo} queued; retries once the restart guard clears (min spacing / hourly cap). Dispatch keeps running meanwhile.`;
    return;
  }
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

// ---------- shared helpers (used by several views) ----------
const projLogs = () => logs.filter((l) => l.projectId === ctx.p);
// ---------- chat: #company room, task threads, working indicator, composer ----------
const CH = { thread: null, key: '', mi: 0, asks: [], openChips: new Set() };
// Chat team scope (t_1158f757): an event belongs to the selected team when its sender or
// receiver does, or (one lookup) its task's assignee does — that covers human/orchestrator
// authored comments and questions on this team's tasks. An event with no team node and no
// task context is system-level and stays visible in every team view (Critic call).
const chatInScope = (e) => { const st = sel.chatTeam; if (!st) return true;
  const sides = [nodeTeamOf(e.who), nodeTeamOf(e.to)];
  if (sides.includes(st)) return true;
  if (e.taskId) { const tt = taskTeamOf(e.taskId); if (tt) return tt === st; }
  return !sides.some(Boolean); };
// Badge team for a cross-team event: the party NOT in the selected team (sender, then
// receiver, then the task's assignee team); null when everything involved is in-team.
const crossTeamOf = (e) => { const st = sel.chatTeam; if (!st) return null;
  const a = nodeTeamOf(e.who); if (a && a !== st) return a;
  const b = nodeTeamOf(e.to); if (b && b !== st) return b;
  const tt = e.taskId ? taskTeamOf(e.taskId) : null; return tt && tt !== st ? tt : null; };
const who = (id) => { const n = nodeById(id); return n ? { name: n.name, role: n.role, color: agentVar(n.id), bg: agentVar(n.id), ini: Chat.initials(n.name), lead: isLeadRole(n.role) } : id === 'human' ? { name: 'You', role: '', color: 'transparent', ini: '', human: true } : { name: id || 'system', role: '', color: 'var(--bg-hover)', ini: '⚙', sys: true }; };
function bubble(e) {
  const link = e.taskId && !CH.thread ? ` data-thread="${e.taskId}"` : ''; const tt = link ? taskTitle(e.taskId) : ''; const tl = link && !e._sameTask ? `<span class="tlink" title="${esc(tt)}">↳ ${esc(tt)}</span>` : '';
  const rep = e.count > 1 ? `<span class="repeat" title="repeated ${e.count} times">×${e.count}</span>` : '';
  if (e.type === 'tool') return `<details class="cchip" data-chip="t:${e.at}:${esc(e.label)}"><summary>🔧 ${esc(e.label)}</summary><pre>${esc(e.text)}${e.result != null ? '\n→ ' + esc(String(e.result).slice(0, 2000)) : ''}</pre></details>${tl ? `<span class="bubble linked"${link}>${tl}</span>` : ''}<br>`;
  // One collapsible bubble per subagent (children folded in roomEvents, sub-subagents nested inside):
  // summary header carries description/status/duration/tokens; expanded shows compact child lines.
  if (e.type === 'subagent') {
    const rec = subRecOf(e.subagentId) || {};
    const dur = Subagents.fmtDuration(Subagents.durationMs(rec));
    const meta = [dur, `tok: ${Subagents.tokensLabel(rec.tokens)}`].filter(Boolean).join(' · ');
    const line = (x) => x.kind === 'tool' ? `<span class="sev-tool">🔧 ${esc(Chat.toolLabel(x.text))}</span>` : x.kind === 'tool_result' ? `<span class="sev-res">→ ${esc(String(x.text).slice(0, 160))}</span>` : esc(String(x.text).slice(0, 160));
    const sevHtml = (ev2) => ev2.events.map((x) => `<div class="sev">${line(x)}</div>`).join('') + (ev2.total > ev2.events.length ? `<div class="sev muted">+ ${ev2.total - ev2.events.length} more event(s)</div>` : '');
    const childHtml = (e2) => `<details class="cchip subagent child" data-chip="s:${esc(e2.subagentId)}"><summary>↳ 🤖 ${esc((subRecOf(e2.subagentId) || e2).description || 'Subagent')} <span class="substatus ss-${esc((subRecOf(e2.subagentId) || {}).status || 'unknown')}">${esc((subRecOf(e2.subagentId) || {}).status || 'unknown')}</span> <span class="submeta">${esc([Subagents.fmtDuration(Subagents.durationMs(subRecOf(e2.subagentId) || {})), `tok: ${Subagents.tokensLabel((subRecOf(e2.subagentId) || {}).tokens)}`].filter(Boolean).join(' · '))}</span> <span class="subcount">${e2.total}</span></summary><div class="subevents">${sevHtml(e2)}${(e2.children || []).map(childHtml).join('')}</div></details>`;
    return `<details class="cchip subagent" data-chip="s:${esc(e.subagentId)}"><summary>🤖 ${esc(rec.description || 'Subagent')} <span class="substatus ss-${esc(rec.status || 'unknown')}">${esc(rec.status || 'unknown')}</span> <span class="submeta">${esc(meta)}</span> <span class="subcount">${e.total}</span></summary><div class="subevents">${sevHtml(e)}${(e.children || []).map(childHtml).join('')}</div></details>${tl ? `<span class="bubble linked"${link}>${tl}</span>` : ''}<br>`;
  }
  if (e.type === 'question') return `<div class="bubble question" data-iid="${e.inboxId}">❓ <b>Question for you</b>${tl}<br>${esc(e.text)}<br>${e.choices.map((c) => `<button class="primary ch-choice" data-v="${esc(c)}">${esc(c)}</button>`).join('')}<textarea class="ch-ans" rows="1" placeholder="Or type an answer"></textarea><button class="ch-send">Answer</button></div>`;
  const ico = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
  const IC = { handoff: '<path d="M5 12h14M13 6l6 6-6 6"/>', message: '<path d="M4 6h16v12H4zM4 7l8 6 8-6"/>', comment: '<path d="M4 5h16v11H8l-4 4z"/>' };
  if (IC[e.type]) { const t = e.type === 'handoff' ? `assigned “${e.text}” to @${who(e.to).name}` : e.type === 'message' ? `@${who(e.to).name} ${e.text}` : e.text;
    // attThumbs rides the span: the evrow branch took over message/comment bubbles after the
    // attachments feature and silently dropped their thumbs (t_6628894d) — '' when none, so
    // plain rows are unchanged.
    const toHuman = e.type === 'message' && e.to === 'human';
    return `<div class="bubble evrow ${e.type}${link ? ' linked' : ''}"${link}>${ico(IC[e.type])}<span>${esc(t)}</span>${e._tb ? teamBadge(e._tb) : ''}${tl}${rep}</div>${toHuman ? Chat.attBlock(e.atts) : Chat.attThumbs(e.atts)}`; }
  const text = e.text;
  const attsHtml = Chat.attThumbs(e.atts);
  return `<div class="bubble ${e.type}${link ? ' linked' : ''}"${link}>${chatMd(text)}${attsHtml}${tl}${e._tb ? teamBadge(e._tb) : ''}${rep}</div>`;
}
// Agent messages are markdown: render the light subset (fences, inline code, bold, links, bullets,
// headings) inside the pre-wrap bubble so real messages don't show raw ** and ` (t_h0a1c2e3).
// SVG (```svg fence or a raw <svg>…</svg>) shows as the picture via <img src=data:> — an <img> SVG
// cannot run scripts, so it is never injected into the DOM (t_ddb6c29e).
const svgImg = (s) => s.length > 200000 ? `<pre class="cmd-pre">${esc(s)}</pre>` : `<img class="chat-svg" src="data:image/svg+xml;utf8,${encodeURIComponent(s.trim())}" alt="SVG image">`;
const mdLine = (b) => esc(b)
  .replace(/^(\s*)[-*] /gm, '$1• ').replace(/^#{1,4} (.*)$/gm, '<b>$1</b>')
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
function chatMd(src) {
  return String(src ?? '').split(/```/).map((b, i) => { if (i % 2) { const body = b.replace(/^\w*\n/, '').replace(/\n$/, '');
    return /^\s*<svg[\s>]/i.test(body) && /<\/svg>\s*$/i.test(body) ? svgImg(body) : `<pre class="cmd-pre">${esc(body)}</pre>`; }
    return b.split(/(<svg[\s>][\s\S]*?<\/svg>)/i).map((t, j) => j % 2 ? svgImg(t) : Chat.mdTables(t, mdLine, mdLine)).join(''); }).join('');
}
// Collapse repeats moved to Chat.collapseRepeats (pure, unit-tested); merge adjacent same-author groups (no repeated "You" headers); questions stay separate.
const mergeGroups = (gs) => gs.reduce((out, g) => { const p = out[out.length - 1]; if (p && p.who === g.who && g.items[0].type !== 'question' && p.items[0].type !== 'question') p.items.push(...g.items); else out.push({ ...g, items: [...g.items] }); return out; }, []).map((g) => ({ ...g, items: Chat.collapseRepeats(g.items) }));
const needsYou = () => new Set([...(S.inbox || []).map((i) => i.nodeId), ...CH.asks]);
// Agents wear a DiceBear face (wiki decision-dicebear-avatars) over their role colour; human/system keep initials/glyph.
// avatarUri.faceSvg drops DiceBear's coloured background rect so the role token shows behind the face.
const faceCache = new Map();
const faceUri = (id, seed) => { seed = seed || ((nodeById(id) || {}).avatarSeed || id); let u = faceCache.get(seed);
  if (!u) { u = 'data:image/svg+xml;utf8,' + encodeURIComponent(avatarUri.faceSvg(seed));
    faceCache.set(seed, u); }
  return u; };
const avatarBg = (w) => (w.human || w.sys) ? w.color : (w.bg || w.color);
const avatarBody = (id, w) => (w.human || w.sys) ? esc(w.ini) : `<img class="avface" src="${faceUri(id)}" alt="" draggable="false">`;
const avatarHtml = (id, working, ask) => { const w = who(id); return `<div class="avatar${w.lead ? ' is-lead' : ''}${w.human ? ' human' : ''}${w.sys ? ' sys' : ''}${working.has(id) ? ' working' : ''}${ask.has(id) ? ' ask' : ''}" style="background:${avatarBg(w)}" title="${esc(w.name)}${working.has(id) ? ' · working' : ask.has(id) ? ' · needs you' : ''}">${avatarBody(id, w)}</div>`; };
// ≥3 consecutive handoffs from one actor fold into one expandable "assigned N tasks" row.
const bubbleRuns = (items) => { const out = []; items.forEach((it, k) => { it._sameTask = k > 0 && !!it.taskId && items[k - 1].taskId === it.taskId; }); for (let i = 0; i < items.length;) { let j = i; while (j < items.length && items[j].type === 'handoff') j++;
  if (j - i >= 3) { const run = items.slice(i, j); out.push(`<details class="evrun"><summary class="evrow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg><span>assigned ${run.length} tasks</span></summary>${run.map(bubble).join('')}</details>`); i = j; } else { j = Math.max(j, i + 1); out.push(...items.slice(i, j).map(bubble)); i = j; } } return out.join(''); };
// One group's name/time header (shared by the full render and the append path, which rebuilds a
// group's body in place without touching its avatar).
const groupHeadHtml = (g) => { const w = who(g.who);
  return `<div class="cname">${esc(w.name)}${w.role ? `<span class="role">${esc(w.role)}</span>` : ''}${w.human ? '' : vbadge(nodeById(g.who))}<time>${new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>`; };
// data-cnt = event count of the group (repeat-collapsed bubbles carry it in .count) — the append
// path slides the window from the front in whole groups and needs the count to keep the books.
const renderGroups = (events, working) => { const ask = needsYou(); return mergeGroups(Chat.group(events)).map((g) => { const w = who(g.who); const cnt = g.items.reduce((a, it) => a + (it.count || 1), 0);
  return `<div class="cgroup${w.human ? ' self' : ''}" data-cnt="${cnt}" data-who="${esc(g.who)}">${avatarHtml(g.who, working, ask)}<div class="cbody">${groupHeadHtml(g)}${bubbleRuns(g.items)}</div></div>`; }).join(''); };
// Sticky "Your turn" bar above the composer: pending ask_human questions/approvals that are NOT
// already shown as an inline question card in the rendered chat page (t_aa42e7f3 — no duplicates).
function renderYourTurn(ev) {
  const inline = new Set(Chat.pageOf(ev, CH.win || Chat.PAGE).items.filter((e) => e.type === 'question').map((e) => e.inboxId)); const items = (S.inbox || []).filter((i) => !inline.has(i.id)); const bar = $('#chat-yourturn'); bar.classList.toggle('hidden', !items.length);
  const key = items.map((i) => `${i.id}:${i.question}:${(i.choices || []).join()}`).join('|');
  if (key === CH.ytKey) return; // unchanged: keep the bound DOM (t_1fb02462 — this rebuilt every draw)
  CH.ytKey = key;
  bar.innerHTML = items.length ? `<div class="yt-head"><span class="yt-badge">!</span><b>Your turn</b><span class="muted">${items.length} pending</span></div>` + items.map((i) => `<div class="yt-item" data-iid="${i.id}"><b>${esc(nodeName(i.nodeId))}</b> <span>${esc(i.question)}</span><span class="spacer"></span>${(i.kind === 'approval' ? ['approve'] : i.change ? ['approve', 'reject'] : i.choices || []).map((c) => `<button class="primary yt-choice" data-v="${esc(c)}">${esc(c)}</button>`).join('')}<input class="yt-ans" placeholder="${i.kind === 'approval' ? 'Request changes…' : 'Answer…'}"><button class="yt-send">Send</button></div>`).join('') : '';
  bar.querySelectorAll('.yt-item').forEach((d) => { const answer = (v) => act(async () => { if (!v) return; await call('answerInbox', d.dataset.iid, v); refresh(); })();
    d.querySelectorAll('.yt-choice').forEach((b) => b.onclick = () => answer(b.dataset.v)); d.querySelector('.yt-send').onclick = () => answer(d.querySelector('.yt-ans').value.trim());
    d.querySelector('.yt-ans').onkeydown = (e) => { if (e.key === 'Enter') answer(e.target.value.trim()); }; });
}
// "↓ N new" pill: only shown when the user has scrolled up and new messages arrived below the fold.
function updateNewPill() { const btn = $('#chat-newpill'); const n = CH.pendingNew || 0; btn.classList.toggle('hidden', n <= 0); if (n > 0) btn.querySelector('span').textContent = n; }
$('#chat-newpill').onclick = () => { const room = $('#chat-room'); room.scrollTop = room.scrollHeight; CH.pendingNew = 0; updateNewPill(); };
// Windowing (t_fb193107): only the last Chat.PAGE events are in the DOM; scrolling near the top
// prepends the next older page (anchored, no jump), and returning to the bottom shrinks again.
const chatGrow = () => { CH.win = (CH.win || Chat.PAGE) + Chat.PAGE; chatSched.force(); };
$('#chat-room').addEventListener('scroll', () => { const room = $('#chat-room');
  if (room.scrollHeight - room.scrollTop - room.clientHeight < 40) { CH.pendingNew = 0; if ((CH.win || Chat.PAGE) > Chat.PAGE) { CH.win = Chat.PAGE; chatSched.force(); } updateNewPill(); }
  else if (room.scrollTop < 80 && CH.ev && CH.ev.length > (CH.win || Chat.PAGE)) chatGrow(); });
// toggle does not bubble; capture on the tab (room + thread panel) so expanded tool/subagent
// chips keep their state across the streaming redraws (restoreChips re-applies the Set).
$('#tab-chat').addEventListener('toggle', (e) => { const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.dataset.chip) return; if (d.open) CH.openChips.add(d.dataset.chip); else CH.openChips.delete(d.dataset.chip); }, true);
// Skip-no-op renders (t_9d92c3d3), counters since t_e116438b: the room redraws only when a
// chat-relevant event moved the epoch — an O(1) integer check in place of the old per-call
// Chat.feedKey signature (a JSON.stringify over every log/task/message/inbox/node/agent/run,
// O(feed), which the old fixed 1s tick rebuilt even when nothing changed). Sources that bump:
// chat-relevant delta sections (task/messages/inbox/orch/runs), same-project log pushes, any
// refresh() that applied changes (covers the team/nodes data the delta sections do not carry),
// and the view-state changes below (thread, window, team scope) which force an immediate draw.
// While events burst, draws coalesce to one room rebuild per 400ms (interleaved agent events
// used to re-render the whole innerHTML room per delta batch at ~4/s — the #2 streaming CPU
// cost after the sweep ring, Quinn t_09b11191).
const chatSched = RenderSched.create({
  minMs: 400,
  hidden: () => document.hidden,
  gate: () => !!$('#tab-chat.active'),
  draw: () => renderChatBody(), // late-binding: e2e/perf harnesses wrap the global by name
});
const chatBump = () => chatSched.bump(); // event-source shorthand (log pushes, deltas, refresh)
function renderChat() {
  if (!$('#tab-chat.active')) return;
  chatSched.drawIfCurrent();
}
function renderChatBody() {
  fillTeamSelect($('#chatteam'), sel.chatTeam, (S.project && S.project.teams) || []);
  const working = new Set(Object.keys(S.orch.agents || {}).filter((id) => S.orch.agents[id].status === 'working'));
  const L = projLogs();
  CH.subIndex = null; // per-draw subagent record index (see subRecOf)
  let ev = Chat.roomEvents(L, S.tasks, S.messages, S.inbox, Chat.MAX, subRecOf); // capped to the last Chat.MAX (500) events
  if (sel.chatTeam) { ev = ev.filter(chatInScope); for (const e of ev) e._tb = crossTeamOf(e); } // team scope + cross-team badges (t_1158f757)
  CH.ev = ev;
  CH.asks = ev.filter((e) => e.type === 'question').map((e) => e.who);
  const workingT = sel.chatTeam ? new Set([...working].filter((id) => teamScoped(sel.chatTeam, id))) : working;
  // Same-string rewrites still destroy + recreate the strip's nodes every draw (a repaint of the
  // header each streaming tick) — write only when the content actually changed.
  const typingHtml = [...workingT].map((id) => { const wk = wakeLabel(id); return `<span class="typing"><span class="spin"></span>${esc(clipText(wk || `${who(id).name} is working`, 64))}<span class="dots"></span></span>`; }).join(' · ');
  if (CH.typingKey !== typingHtml) { CH.typingKey = typingHtml; $('#chat-typing').innerHTML = typingHtml; }
  renderYourTurn(ev);
  const room = $('#chat-room'); const atBottom = room.scrollHeight - room.scrollTop - room.clientHeight < 40;
  const prevH = room.scrollHeight, prevTop = room.scrollTop;
  const page = Chat.pageOf(ev, CH.win || Chat.PAGE);
  // The event list is a sliding window (capped at MAX), so ev.length alone can't count new arrivals —
  // count events newer than the previous tail instead.
  const delta = ev.filter((e) => e.at > (CH.evTailAt ?? -Infinity)).length;
  if (ev.length) CH.evTailAt = ev[ev.length - 1].at;
  // Hard stamp: everything whose change must rebuild the room from scratch — scope, thread, and
  // node identity (names/roles/badges/faces are baked into every bubble). The working/needs-you
  // rings deliberately live OUTSIDE it now (t_1fb02462): with them in, every run start/finish
  // force-rebuilt all ~100 groups — the top streaming cost in Quinn's real-agent trace
  // (t_f4f6d15e) — where a class toggle on the drifted avatars is enough.
  const stamp = [sel.chatTeam || '', CH.thread || '',
    S.allNodes.map((n) => n.id + n.name + n.role + (n.runtime || '') + (n.model || '') + (n.avatarSeed || '')).join(),
    sel.chatTeam ? S.allNodes.map((n) => n.id + (n.teamId || '')).join() : ''].join('|'); // team moves change chatInScope's filter output
  const workKey = [...workingT].sort().join() + '|' + [...needsYou()].sort().join();
  if (CH.stamp === stamp && CH.evFp && CH.evFp.length) {
    // Scroll-up window growth (chatGrow): prepend the next older page instead of rebuilding.
    if (!atBottom && (CH.win || Chat.PAGE) > (CH.domWin || 0) && applyChatPrepend(ev, workingT, prevTop, prevH)) { CH.workKey = workKey; return; }
    if (atBottom) {
      const plan = Chat.tailPlan(CH.evFp, ev, CH.win || Chat.PAGE, subRecOf);
      if (plan && applyChatAppend(ev, plan, workingT)) { CH.workKey = workKey; return; }
      if (!plan && (CH.domWin || 0) === (CH.win || Chat.PAGE)) {
        // Nothing in the feed the DOM can absorb and the window didn't move: at most the chrome
        // drifted. Patch the rings and skip the rebuild (a no-op draw used to fall through to a
        // full innerHTML of every group).
        if (CH.workKey !== workKey) { patchChatAvatars(room, workingT); CH.workKey = workKey; }
        return;
      }
    }
  }
  CH.stamp = stamp; CH.workKey = workKey;
  // Progressive first paint (t_7e53747c): the cold render of a full page (100 events, fat board)
  // measured 87ms under load — over the 50ms bar. Split at a GROUP boundary (Chat.group is what
  // renderGroups applies anyway, so two half-renders group exactly like one) and prepend the
  // older half on the next frame: the newest groups — what the user came to read — paint first.
  const split = Chat.splitPage(page.items);
  const headItems = split && split.head, tailItems = split ? split.tail : page.items;
  const headFps = split ? split.head.map((e) => Chat.eventFp(e, subRecOf)) : null;
  const tailFps = tailItems.map((e) => Chat.eventFp(e, subRecOf));
  CH.evFp = tailFps;
  CH.renderGen = (CH.renderGen || 0) + 1;
  const myGen = CH.renderGen;
  room.innerHTML = page.items.length ? (page.hidden ? `<button id="chat-older" class="olderbar linklike">↑ ${page.hidden} earlier message${page.hidden === 1 ? '' : 's'} — scroll up or click to load</button>` : '') + renderGroups(tailItems, workingT)
    : sel.chatTeam ? '<p class="muted logempty" data-testid="chat-empty-team">No messages for this team.</p>'
    : S.team.nodes.length ? `<div class="cempty"><svg class="brandmark big" viewBox="0 0 32 32" aria-hidden="true"><path d="M23 9A10 10 0 1 0 23 23" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><g fill="currentColor"><circle cx="23" cy="9" r="3.6"/><circle cx="6" cy="16" r="3.6"/><circle cx="23" cy="23" r="3.6"/></g></svg><b>#company is quiet</b>Type a goal below, or @mention an agent (e.g. <code>@${esc(S.team.nodes[0].name)} write hello.txt</code>).</div>` : '<div class="cempty"><svg class="brandmark big" viewBox="0 0 32 32" aria-hidden="true"><path d="M23 9A10 10 0 1 0 23 23" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><g fill="currentColor"><circle cx="23" cy="9" r="3.6"/><circle cx="6" cy="16" r="3.6"/><circle cx="23" cy="23" r="3.6"/></g></svg><b>No team yet</b>Create your team in the Team tab (or use the first-run guide), then chat with it here.</div>';
  if (atBottom) { CH.win = Chat.PAGE; room.scrollTop = room.scrollHeight; repinBottom(room); CH.pendingNew = 0; }
  else { room.scrollTop = Chat.anchorScroll(prevTop, prevH, room.scrollHeight); CH.pendingNew = (CH.pendingNew || 0) + delta; }
  CH.domWin = CH.win || Chat.PAGE; // the window the DOM now shows (after the at-bottom reset)
  const ob = $('#chat-older'); if (ob) ob.onclick = chatGrow;
  updateNewPill();
  syncThreadPanel(ev, workingT);
  bindChatBubbles($('#tab-chat'));
  if (headItems) {
    // The older half goes in across frames, adaptively chunked: one big rAF still measured 60ms
    // (a long task wherever it runs). Each frame builds+inserts as many groups as fit ~24ms,
    // grows the books by exactly what it inserted, and re-anchors; a superseded generation stops
    // early — the next draw heals the remaining books (a short books list plans a rebuild).
    const endTop = room.scrollTop, endH = room.scrollHeight; // phase-A end state for the re-anchor
    const groups2 = split.headGroups; const perGroupFps = groups2.map((grp) => grp.items.map((e) => Chat.eventFp(e, subRecOf)));
    let gi = 0, chunk = 6;
    const step = () => {
      if (CH.renderGen !== myGen || gi >= groups2.length) return; // a newer draw owns the room; it heals the books itself
      const t0 = performance.now();
      const take = groups2.slice(gi, gi + chunk);
      const t = document.createElement('template');
      t.innerHTML = renderGroups(take.flatMap((grp) => grp.items), workingT);
      const ob2 = $('#chat-older'); const anchor = ob2 ? ob2.nextSibling : room.firstChild;
      room.insertBefore(t.content, anchor);
      let fps = CH.evFp;
      for (let k = take.length - 1; k >= 0; k--) fps = perGroupFps[gi + k].concat(fps);
      CH.evFp = fps;
      bindChatBubbles(t);
      if (room.scrollHeight - room.scrollTop - room.clientHeight < 40) { room.scrollTop = room.scrollHeight; repinBottom(room); }
      else room.scrollTop = Chat.anchorScroll(endTop, endH, room.scrollHeight);
      gi += take.length;
      if (gi < groups2.length) {
        chunk = Math.max(2, Math.min(24, Math.round(chunk * 24 / Math.max(1, performance.now() - t0))));
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }
}
// Thread links and ask-human answer forms ride the bubbles; both paths (full render and tail
// append) wire them through here — property assignment, so re-binding over old nodes is a no-op.
// The patch paths must pass a LIVE scope (the fragment before its nodes move into the room, or an
// in-place rebuilt group): a template drained by appendChild/insertBefore matches nothing and
// silently leaves the fresh bubbles dead (t_c69c2170).
// Open chip state (t_h0a1c2f9): a tool/subagent chip the user expanded must survive the room
// redraws a streaming feed causes — a rebuild used to collapse it every draw, visibly moving the
// conversation each time. Chips carry a stable data-chip key; the Set is maintained by the
// delegated toggle listener below and re-applied here.
function restoreChips(scope) {
  scope.querySelectorAll('details[data-chip]').forEach((d) => { const on = CH.openChips.has(d.dataset.chip); if (d.open !== on) d.open = on; });
}
function bindChatBubbles(scope) {
  restoreChips(scope);
  scope.querySelectorAll('[data-thread]').forEach((b) => b.onclick = () => { CH.thread = b.dataset.thread; chatSched.force(); });
  scope.querySelectorAll('.bubble.question').forEach((d) => {
    const answer = (v) => act(async () => { if (!v) return; await call('answerInbox', d.dataset.iid, v); refresh(); })();
    d.querySelectorAll('.ch-choice').forEach((b) => b.onclick = () => answer(b.dataset.v)); d.querySelector('.ch-send').onclick = () => answer(d.querySelector('.ch-ans').value.trim());
  });
}
// Turn the drawn room into plan.target with the least DOM work (t_1fb02462, extending t_fe51eee9):
// whole-group eviction of what fits before the slide, keep every group fully fp-confirmed, remove
// and re-render from the first group that isn't (a late tool result or subagent update patches its
// own group only), and patch the working/needs-you rings that full renders used to rebuild the
// room for. Books stay exact: CH.evFp mirrors the DOM after every step, front drift included.
// Returns false when the DOM shape doesn't match the plan — the caller falls back to the full
// render, which overwrites whatever was touched here.
function applyChatAppend(ev, plan, workingT) {
  const room = $('#chat-room');
  const win = CH.win || Chat.PAGE;
  const ob = $('#chat-older');
  if ((ev.length > win) !== !!ob) return false; // the window boundary moved: draw it in a full render
  const { target, slide, alignFrom, alignLen } = plan;
  const confFrom = slide + alignFrom, confTo = slide + alignFrom + alignLen; // confirmed DOM range
  // Walk the groups in DOM order, tracking each group's event range: fully pre-slide groups are
  // evicted, a group straddling the slide survives as front drift (bounded by one group, books
  // stay exact), confirmed groups stay untouched, and `cut` marks the first group to re-render.
  const groups = [...room.querySelectorAll('.cgroup')];
  let off = 0, evicted = 0, keptLen = 0, cut = -1;
  for (const g of groups) {
    const cnt = +g.dataset.cnt || 1; const end = off + cnt;
    if (end <= slide) { evicted += cnt; g.remove(); off = end; continue; }
    if (off < slide) { keptLen += cnt; off = end; continue; } // drift straddler: keep
    if (cut < 0 && off >= confFrom && end <= confTo) { keptLen += cnt; off = end; continue; } // past `cut` everything re-renders
    if (cut < 0) cut = off - slide;
    off = end;
  }
  if (cut < 0 && alignFrom + alignLen < target.length) cut = alignFrom + alignLen; // fresh events past the drawn stretch
  if (cut < 0) { // nothing to re-render: books unchanged (a no-op or eviction-only draw)
    if (evicted) CH.evFp = CH.evFp.slice(evicted);
    CH.renderGen = (CH.renderGen || 0) + 1; // owns the room: pending split chunks must stop
    patchChatAvatars(room, workingT);
    finishAppend(room, ev, win, ob, workingT);
    return true;
  }
  const rebuild = target.slice(cut);
  if (!rebuild.length) return false; // bookkeeping lost the thread of the feed: rebuild
  const keptFps = CH.evFp.slice(evicted, evicted + keptLen);
  // Remove the stale tail groups (from `cut` on) — everything after the last kept group.
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]; const cnt = +g.dataset.cnt || 1;
    off -= cnt;
    if (off >= evicted + keptLen) g.remove(); else break;
  }
  const t = document.createElement('template');
  t.innerHTML = renderGroups(rebuild, workingT);
  bindChatBubbles(t.content); // bind BEFORE the insert moves the nodes out — a drained template matches nothing
  room.appendChild(t.content);
  CH.evFp = keptFps.concat(rebuild.map((e) => Chat.eventFp(e, subRecOf)));
  CH.renderGen = (CH.renderGen || 0) + 1; // owns the room: pending split chunks must stop
  patchChatAvatars(room, workingT);
  finishAppend(room, ev, win, ob, workingT);
  return true;
}
// Shared tail of the append path: older-bar label, scroll pin, new pill. The thread panel is
// synced separately (syncThreadPanel) so append-only draws keep it current without a full render.
function finishAppend(room, ev, win, ob, workingT) {
  if (ob) { const hidden = ev.length - win; const label = `↑ ${hidden} earlier message${hidden === 1 ? '' : 's'} — scroll up or click to load`;
    if (hidden > 0) { if (ob.textContent !== label) ob.textContent = label; }
    else ob.remove(); }
  CH.pendingNew = 0;
  room.scrollTop = room.scrollHeight;
  repinBottom(room);
  updateNewPill();
  syncThreadPanel(ev, workingT);
}
// Prepend the next older page (chatGrow) without rebuilding the room (t_1fb02462 — the scroll-up
// prepend was a whole-room innerHTML at fat feeds, the 1.3s worst frame in Quinn's trace). The
// fp-verified older slice renders into a fragment inserted under the older bar; a slice ending in
// the same author/minute as the room's first group merges into it (rebuilding just that group's
// body), exactly what one full render's Chat.group would have produced. The viewport is anchored
// twice: immediately (placeholder heights from content-visibility) and again after paint.
function applyChatPrepend(ev, workingT, prevTop, prevH) {
  const room = $('#chat-room');
  const win = CH.win || Chat.PAGE;
  const plan = Chat.prependPlan(CH.evFp, ev, win, subRecOf);
  if (!plan) return false;
  const ob = $('#chat-older');
  const { target, slice } = plan;
  const groupsNew = mergeGroups(Chat.group(slice));
  let fragItems = slice;
  if (groupsNew.length) {
    const lastNew = groupsNew[groupsNew.length - 1];
    const first = room.querySelector('.cgroup');
    const firstCnt = first ? +first.dataset.cnt || 1 : 0;
    const firstItems = target.slice(slice.length, slice.length + firstCnt); // the room's first group's events
    if (first && firstItems.length && firstCnt <= firstItems.length && lastNew.who === firstItems[0].who
      && firstItems[0].type !== 'question' && lastNew.items[0].type !== 'question'
      && firstItems[0].at - lastNew.items[lastNew.items.length - 1].at < Chat.GROUP_MS) {
      // merge: the boundary group re-collapses over both halves
      const merged = [...lastNew.items, ...firstItems];
      fragItems = slice.slice(0, slice.length - lastNew.items.length);
      const body = first.querySelector('.cbody');
      if (!body) return false;
      body.innerHTML = groupHeadHtml({ who: merged[0].who, at: merged[0].at }) + bubbleRuns(Chat.collapseRepeats(merged));
      first.dataset.cnt = String(merged.reduce((a, it) => a + (it.count || 1), 0));
      bindChatBubbles(first);
    }
  }
  if (fragItems.length) {
    const t = document.createElement('template');
    t.innerHTML = renderGroups(fragItems, workingT);
    bindChatBubbles(t.content); // bind BEFORE the insert moves the nodes out — a drained template matches nothing
    const anchor = ob ? ob.nextSibling : room.firstChild;
    room.insertBefore(t.content, anchor);
  }
  CH.evFp = target.map((e) => Chat.eventFp(e, subRecOf));
  CH.renderGen = (CH.renderGen || 0) + 1; // owns the room: pending split chunks must stop
  CH.domWin = win;
  if (ob) { const hidden = ev.length - win; const label = `↑ ${hidden} earlier message${hidden === 1 ? '' : 's'} — scroll up or click to load`;
    if (hidden > 0) { if (ob.textContent !== label) ob.textContent = label; }
    else ob.remove(); }
  // Anchor: the fresh content adds (new - prev) px above the viewport; content-visibility
  // resolves the prepended rows' real heights on paint, so re-anchor once the frame settles.
  room.scrollTop = Chat.anchorScroll(prevTop, prevH, room.scrollHeight);
  const want = room.scrollTop;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (Math.abs(room.scrollTop - want) < 2) room.scrollTop = Chat.anchorScroll(prevTop, prevH, room.scrollHeight);
  }));
  syncThreadPanel(ev, workingT);
  return true;
}
// Working/needs-you rings live in the group avatars; append/prepend/no-op draws don't touch their
// HTML, so ring changes (a run starting or stopping) patch class-wise here. Group authorship comes
// from the books (CH.evFp mirrors the DOM), so legacy groups without data-who are covered too.
// Off-screen groups are skipped: a DOM write inside a content-visibility:auto group drops its
// remembered intrinsic size, and the skip pass then collapses the group to the 72px placeholder —
// the whole conversation below jumps (measured -410px layout shifts seconds after a run flip,
// t_h0a1c2f9). Off-screen rings can't be seen anyway; the next draw that finds them on screen
// patches them.
function patchChatAvatars(room, workingT) {
  const ask = needsYou(); const fps = CH.evFp || [];
  const vr = typeof room.getBoundingClientRect === 'function' ? room.getBoundingClientRect() : null; // one forced layout; the per-group reads after it are clean
  let i = 0;
  room.querySelectorAll('.cgroup').forEach((g) => {
    const cnt = +g.dataset.cnt || 1;
    const id = i < fps.length ? fps[i].slice(0, fps[i].indexOf('|')) : g.dataset.who || null;
    i += cnt;
    if (!id) return;
    if (vr && typeof g.getBoundingClientRect === 'function') {
      const r = g.getBoundingClientRect();
      if (r.bottom < vr.top - 200 || r.top > vr.bottom + 200) return;
    }
    const av = g.querySelector('.avatar'); if (!av) return;
    const w = workingT.has(id), a = ask.has(id);
    if (av.classList.contains('working') !== w) av.classList.toggle('working', w);
    if (av.classList.contains('ask') !== a) av.classList.toggle('ask', a);
    const nm = who(id); const title = nm.name + (w ? ' · working' : a ? ' · needs you' : '');
    if (av.getAttribute('title') !== title) av.setAttribute('title', title);
  });
}
// Thread panel: kept current on every draw path, but only rebuilt when its events actually moved
// (a full rebuild per draw would reintroduce the per-draw innerHTML cost for open threads).
function syncThreadPanel(ev, workingT) {
  const th = $('#chat-thread'); const t = S.tasks.find((x) => x.id === CH.thread);
  th.classList.toggle('hidden', !t);
  if (!t) return;
  const wt = workingT || new Set(Object.keys(S.orch.agents || {}).filter((id) => S.orch.agents[id].status === 'working'));
  const tev = ev.filter((e) => e.taskId === t.id);
  const key = tev.map((e) => Chat.eventFp(e, subRecOf)).join();
  if (key === CH.thKey) return;
  CH.thKey = key;
  th.innerHTML = `<div class="chat-head"><b>🧵 ${esc(t.title)}</b><span class="role">${esc(t.status)}</span><span class="spacer"></span><button id="ch-close" title="Close thread">✕</button></div><div id="chat-threadroom">${tev.length ? renderGroups(tev, wt) : '<p class="muted" style="padding:16px">Nothing in this thread yet.</p>'}</div>`;
  restoreChips(th); // the panel rebuilds as its thread streams: keep the user's expanded chips open
  $('#ch-close').onclick = () => { CH.thread = null; CH.thKey = null; chatSched.force(); };
}
// IME state of the composer (Vietnamese Telex and friends compose straight into the textarea):
// while a composition is live, Enter/Tab/arrows belong to the IME, and acting on them sends
// unfinalized text and clears the field out from under the IME — the IME's restored fragment then
// goes out as a stray second message (t_h0a1c2fa: "đang làm gì v" followed by a lone "v" 52ms
// later, straight from the real store). The wiring sits with the other input listeners below.
let chatComposing = false;
function chatPreview() {
  const i = $('#chat-input'); const v = i.value; const p = Chat.parseComposer(v, S.team.nodes); const pv = $('#chat-preview');
  // Guarded writes: chatPreview runs on every keystroke AND mid-composition — same-value
  // textContent/className assignments still dirty the composer's layout each keystroke, and a
  // mentions-box rebuild the user can't see is churn on top (same finding as the header pills).
  const ptxt = Chat.preview(p); if (pv.textContent !== ptxt) pv.textContent = ptxt;
  const pcls = p ? p.kind : 'muted'; if (pv.className !== pcls) pv.className = pcls;
  const ms = Chat.mentionMatches(v, S.team.nodes); const box = $('#chat-mentions'); const open = !!(ms && ms.length);
  box.classList.toggle('hidden', !open);
  if (open) {
    CH.mi = Math.min(CH.mi, Math.max(0, ms.length - 1));
    const html = ms.map((n, i) => `<div data-name="${esc(n.name)}" class="${i === CH.mi ? 'sel' : ''}"><span class="avatar${isLeadRole(n.role) ? ' is-lead' : ''}" style="background:${agentVar(n.id)}">${avatarBody(n.id, who(n.id))}</span>${esc(n.name)} <span class="role">${esc(n.role)}</span></div>`).join('');
    if (box.innerHTML !== html) {
      box.innerHTML = html;
      box.querySelectorAll('div').forEach((d) => d.onmousedown = (e) => { e.preventDefault(); pickMention(d.dataset.name); });
    }
  }
}
function pickMention(name) { const i = $('#chat-input'); i.value = i.value.replace(/@(\w*)$/, '@' + name + ' '); i.focus(); CH.mi = 0; chatPreview(); }
async function chatSend() {
  const i = $('#chat-input'); if (chatComposing) return; // the Send button can click mid-composition too — same stray-message risk as Enter
  const p = Chat.parseComposer(i.value, S.team.nodes); if (!p) return;
  if (p.kind === 'error') return chatPreview();
  if (chatAtts.some((a) => !a.path)) return; // blocked until every chip saved (a failed chip must be removed first)
  const atts = chatAtts.length ? chatAtts.map(({ path, name, mime, size }) => ({ path, name, mime, size })) : null;
  const head = () => (S.team.nodes.find((n) => isLeadRole(n.role)) || S.team.nodes[0] || {}).id; // composer's core agent
  const draft = i.value; i.value = ''; chatPreview(); // clear on press, not after the bridge answers (t_ada3fae8)
  try {
    if (p.kind === 'task') { await call('createTask', { title: p.text.slice(0, 80), description: p.text, assignee: p.nodeId || head(), ...(atts ? { attachments: atts } : {}) }); if (!S.orch.running) await call('run'); }
    else if (p.kind === 'message') await call('sendToAgent', p.nodeId || head(), p.text, ...(atts ? [null, { attachments: atts }] : []));
  } catch (err) { i.value = draft; chatPreview(); throw err; } // send failed: hand the draft back
  for (const a of chatAtts) if (a.url) URL.revokeObjectURL(a.url);
  chatAtts.length = 0; renderChatAtts();
  refresh();
}
$('#chat-input').addEventListener('input', chatPreview);
$('#chat-input').addEventListener('compositionstart', () => { chatComposing = true; });
$('#chat-input').addEventListener('compositionend', () => { chatComposing = false; chatPreview(); });
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME composition: Enter commits the text, it must not also send it (t_h0a1c2fa)
  const box = $('#chat-mentions'); const open = !box.classList.contains('hidden'); const items = box.querySelectorAll('div');
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); CH.mi = (CH.mi + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; chatPreview(); }
  else if (open && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pickMention(items[CH.mi].dataset.name); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); act(chatSend)(); }
});
$('#chat-send').onclick = act(chatSend);
// Chat activation goes through the shared tab-click handler: the scheduler's gate keeps the tab
// check, so a revisit of an unchanged room (epoch unmoved) is a no-op — the DOM from the last
// visit is still correct — and a revisit after events drew while hidden draws once, immediately.
// Chat team scope (t_1158f757): one select in the header, left of the typing indicator; index.html
// is out of scope for this task so the control is injected here.
document.querySelector('#tab-chat .chat-head .spacer').insertAdjacentHTML('beforebegin', '<select id="chatteam" title="Scope #company to one team, or show all teams"></select>');
$('#chatteam').onchange = () => { sel.chatTeam = $('#chatteam').value; chatSched.force(); };

// Message image lightbox (t_604b5c1a): click a bubble thumb → full size overlay; click or Esc closes.
document.addEventListener('click', (ev) => {
  const img = ev.target.closest && ev.target.closest('.att-row .att-thumb'); if (!img || img.closest('.att-chip')) return;
  const box = document.createElement('div'); box.className = 'att-lightbox'; box.innerHTML = `<img src="${esc(img.src)}" alt="${esc(img.alt)}">`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.onclick = close; document.addEventListener('keydown', onKey, true); document.body.appendChild(box);
});
// ---------- composer attachments (t_993822cf): paste / drop / attach button, chips, lazy thumbs ----------
// A chip is added optimistically (local object-URL preview for images), saved in the background via
// squad.saveAttachment, then swaps to the saved file:// thumbnail (object URL revoked on swap, remove, send).
const chatAtts = []; // {name, mime, size, url?, path?, error?} — path set only after a successful save
const attChipHtml = (a, i) => `<div class="att-chip${a.error ? ' err' : ''}" data-i="${i}">` +
  (a.path ? `<img class="att-thumb" src="${esc(Chat.fileUrl(a.path))}" loading="lazy" alt="" title="${esc(a.name)} · ${Chat.fmtSize(a.size)}">`
    : a.url ? `<img class="att-thumb" src="${a.url}" alt="" title="${esc(a.name)}">` : a.error ? '<span class="att-nopic">⚠</span>' : '<span class="att-spin" title="saving…"></span>') +
  `<span class="att-name">${esc(a.name)}</span><span class="muted">${Chat.fmtSize(a.size)}</span>` +
  (a.error ? `<span class="att-err" title="${esc(a.error)}">⚠ ${esc(a.error)}</span>` : '') +
  `<button class="att-x" title="Remove attachment">×</button></div>`;
function renderChatAtts() {
  const box = $('#chat-att');
  box.classList.toggle('hidden', !chatAtts.length);
  box.innerHTML = chatAtts.map(attChipHtml).join('');
  box.querySelectorAll('.att-chip').forEach((d) => d.querySelector('.att-x').onclick = () => {
    const a = chatAtts[+d.dataset.i]; if (a.url) URL.revokeObjectURL(a.url); // revoke even before the save finished
    chatAtts.splice(+d.dataset.i, 1); renderChatAtts();
  });
  const blocked = chatAtts.some((a) => !a.path);
  $('#chat-send').disabled = blocked;
  $('#chat-send').title = blocked ? 'Waiting for attachments to finish saving (remove failed ones first)' : '';
}
async function addChatFiles(files) {
  if (!files.length) return;
  if (chatAtts.length + files.length > 12) return alert('Too many attachments (max 12 per message).');
  for (const f of files) {
    const a = { name: f.name || (String(f.type).startsWith('image/') ? 'pasted-image.png' : 'pasted-file'), mime: f.type || 'application/octet-stream', size: f.size, url: null, path: null, error: null };
    if (String(a.mime).startsWith('image/') && f.type) a.url = URL.createObjectURL(f);
    chatAtts.push(a); renderChatAtts();
    let bytes; try { bytes = new Uint8Array(await f.arrayBuffer()); } catch { a.error = 'cannot read file'; if (a.url) { URL.revokeObjectURL(a.url); a.url = null; } renderChatAtts(); continue; }
    a.size = bytes.length;
    let r; try { r = await squad.saveAttachment(ctx, { name: a.name, mime: a.mime, bytes }); }
    catch (e) { r = { error: String(e.message || e).replace(/^Error invoking remote method 'api': (Error: )?/, '') }; }
    if (!chatAtts.includes(a)) continue; // removed while saving (its URL is already revoked)
    if (!r || r.error) { a.error = (r && r.error) || 'save failed'; } // keep the preview; its URL is revoked on remove/send
    else { Object.assign(a, { path: r.path, name: r.name, size: r.size }); if (a.url) { URL.revokeObjectURL(a.url); a.url = null; } }
    renderChatAtts();
  }
}
$('#chat-input').addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (!files.length) return; e.preventDefault(); act(addChatFiles)(files); });
$('#chat-attach').onclick = () => $('#chat-file').click();
$('#chat-file').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; act(addChatFiles)(files); };
const composerEl = document.querySelector('.composer');
composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('dragover'); });
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('dragover'));
composerEl.addEventListener('drop', (e) => { e.preventDefault(); composerEl.classList.remove('dragover'); const files = [...(e.dataTransfer?.files || [])]; if (files.length) act(addChatFiles)(files); });

// ---------- human inbox (ask_human questions + approvals) ----------
const ibOpen = new Map();
function renderInbox() {
  const items = [...(S.inbox || [])].sort((a, b) => (b.createdAt || b.at || 0) - (a.createdAt || a.at || 0)); // the badge itself rides renderChrome (renderInboxBadge)
  const taskTitle = (id) => (S.tasks.find((t) => t.id === id) || {}).title || '';
  $('#inboxlist').innerHTML = items.length ? items.map((i) => `<div class="inboxitem" data-iid="${i.id}">
    <div class="ib-head" role="button" tabindex="0" aria-expanded="false">${S.allNodes.some((x) => x.id === i.nodeId) ? avatarHtml(i.nodeId, new Set(), new Set([i.nodeId])) : '<div class="avatar" style="background:#3a3f4b" title="System">⚙</div>'}<div class="ib-main"><div class="ib-q">${esc(i.question)}</div><small class="ib-meta">${i.kind === 'approval' ? 'Approval' : 'Question'} · ${S.allNodes.some((x) => x.id === i.nodeId) ? esc(nodeName(i.nodeId)) : 'System'}${i.taskId ? ' · ' + esc(taskTitle(i.taskId)) : ''}</small></div><small class="ib-time" title="${esc(new Date(i.at).toLocaleString())}">${esc(agoTxt(i.at) || 'just now')}</small></div>
    <div class="ib-body hidden"><p>${(i.kind === 'approval' ? ['approve'] : i.choices).map((c) => `<button class="ib-choice primary" data-v="${esc(c)}">${esc(c)}</button>`).join(' ')}</p>
    <textarea class="ib-text" rows="2" placeholder="${i.kind === 'approval' ? 'Or describe the changes you want' : 'Your answer'}"></textarea>
    <p><button class="ib-send">${i.kind === 'approval' ? 'Request changes' : 'Send answer'}</button></p></div></div>`).join('') : `<div class="ib-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 6.5 5h11L20 12v6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-6ZM4 12h5.5l1 2h3l1-2H20"/></svg><h3>You're all caught up</h3><p>Agent questions, approvals and merge conflicts that need your call land here.</p><button class="ib-board">Go to Board</button></div>`;
  const ibb = document.querySelector('.ib-board'); if (ibb) ibb.onclick = () => showTab('board');
  document.querySelectorAll('.inboxitem .ib-head').forEach((h) => { const t = () => { const o = h.nextElementSibling.classList.toggle('hidden'); h.setAttribute('aria-expanded', String(!o)); ibOpen.set(h.parentElement.dataset.iid, !o); }; h.onclick = t; h.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t(); } }; });
  // Newest "your turn" item starts expanded so its choices show without a click; user toggles are remembered across re-renders.
  const newest = items.reduce((m, i) => (!m || (i.createdAt || i.at || 0) >= (m.createdAt || m.at || 0) ? i : m), null);
  document.querySelectorAll('.inboxitem').forEach((d) => { const id = d.dataset.iid; if (ibOpen.get(id) ?? (newest && newest.id === id)) { d.querySelector('.ib-body').classList.remove('hidden'); d.querySelector('.ib-head').setAttribute('aria-expanded', 'true'); } });
  document.querySelectorAll('.inboxitem').forEach((d) => {
    const answer = (v) => act(async () => { if (!v) return; await call('answerInbox', d.dataset.iid, v); refresh(); })();
    d.querySelectorAll('.ib-choice').forEach((b) => b.onclick = () => answer(b.dataset.v));
    d.querySelector('.ib-send').onclick = () => answer(d.querySelector('.ib-text').value.trim());
  });
}

// ---------- live updates ----------
let pending = null, pendingP = null;
// Self-update status push: prefer the dedicated bridge method, fall back to either plausible channel name.
const onUpdPush = (d) => { upd = { ...normUpd(d), stub: false }; trackUpd(); if (upd.state !== 'idle') clearRstToast(); renderSelfUpdate(); renderUpdSettings(); renderAlerts(); }; // flow visible via veil/pill — the "Restarting…" toast retires
if (squad.onSelfUpdateStatus) squad.onSelfUpdateStatus(onUpdPush);
else { squad.on('selfUpdateStatus', onUpdPush); squad.on('self-update-status', onUpdPush); }
// Restart/watch pushes: prefer dedicated bridge helpers, fall back to plausible channel names
// (Devon adds the preload helpers when the backend lands — see contract on t_20d5a23c).
const onRestartPush = (d) => { rst = { ...normRestart(d), stub: false }; rstSeen = true; if (!rstArmed() && rst.pendingCount === 0) clearRstToast(); renderHeader(); renderAlerts(); boardSig = null; renderBoard(); };
const onWatchPush = (d) => { watch = { ...normWatch(d), stub: false }; renderHeader(); };
if (squad.onRestartState) squad.onRestartState(onRestartPush);
else { squad.on('restart-state', onRestartPush); squad.on('restartStatus', onRestartPush); }
if (squad.onWatchStatus) squad.onWatchStatus(onWatchPush);
else { squad.on('watch-status', onWatchPush); squad.on('watchStatus', onWatchPush); }
// Runtime unavailable/resumed pushes (contract on t_d33685f3); dash channels are primary.
const onRtuPush = (d) => { if (d && d.projectId && d.projectId !== ctx.p) return; setRtu(d); };
const onRtaPush = (d) => { if (d && d.projectId && d.projectId !== ctx.p) return; clearRtu(d && d.runtime); };
squad.on('runtime-unavailable', onRtuPush); squad.on('runtimeUnavailable', onRtuPush);
squad.on('runtime-available', onRtaPush); squad.on('runtimeAvailable', onRtaPush);
// Streamed log lines (t_8d586961): pushes arrive one per tool event; a full renderLog per line
// rebuilt the whole window each time (~56ms at profile sizes). Coalesce to one flush per frame
// and, while the view is pinned to the live tail with trivial filters, append only the new rows.
let logFlushQueued = false, logTailDirty = false;
function scheduleLogRender() {
  if (document.hidden) return; // hidden window: rAF is stalled and the fallback would only build DOM nobody sees; the catch-up refresh on visible redraws the tail
  if (logFlushQueued) return; logFlushQueued = true;
  let fired = false; const flush = () => { if (fired) return; fired = true; logFlushQueued = false; flushLogTail(); };
  requestAnimationFrame(flush);
  setTimeout(flush, 150); // rAF can starve in occluded windows; never let the tail stall
}
// Full-rebuild rate limit (t_232704bb): when the fast append bails (search or level filter on,
// subagent lines), every streamed flush used to run the full renderLog (~56ms at profile sizes)
// — up to 60 rebuilds/s on an already busy main thread. Coalesce the fallback to one rebuild per
// window; the trailing edge always lands the latest state. User-driven renders (filter, search,
// scroll) still call renderLog directly — the signature gate dedupes either way.
const LOG_REBUILD_MS = 150;
let logRebuildTimer = 0;
function scheduleLogRebuild() {
  if (logRebuildTimer) return;
  logRebuildTimer = setTimeout(() => { logRebuildTimer = 0;
    const box = $('#log');
    // Scrolled away between schedule and fire: the scroll handler rebuilds once on return, same
    // as the deferred path above — don't anchor-jump the pane under the reader.
    if (box && renderLog.winItems && box.scrollTop + box.clientHeight < box.scrollHeight - 20) { logTailDirty = true; return; }
    renderLog();
  }, LOG_REBUILD_MS);
}
function flushLogTail() {
  // One malformed streamed line must not kill the scheduler: the throw would otherwise recur on
  // every queued flush, taking renderLive's task-detail refresh down with it.
  try {
    if ($('#tab-obs').classList.contains('active') && !appendLogTail()) {
      const box = $('#log');
      // Reading history while the stream runs: the user is scrolled away from the tail, so every
      // flush would rebuild the whole window (~56ms at profile sizes) only to anchor-scroll back
      // to the same rows. Defer the rebuild — the scroll handler rebuilds once when the tail
      // comes back into view (any explicit renderLog also clears it via its stamp).
      if (box && renderLog.winItems && box.scrollTop + box.clientHeight < box.scrollHeight - 20) logTailDirty = true;
      else if (renderLog.winItems) scheduleLogRebuild(); // pane already drawn: rate-limit the rebuild
      else renderLog(); // empty pane (first draw / tab activation): paint now
    }
  }
  catch (e) { console.warn('log pane flush failed', e); }
  try { renderLive(); } catch (e) { console.warn('task-detail live tail render failed', e); } // board task-detail pane follows the stream even while Obs is hidden — a throw here must not escape the scheduler the way a throwing append used to
}
// Fast append path: only when the DOM is the plain live tail (no search, all levels on, no subagent
// blocks, pinned to bottom with auto-scroll) do the new rows equal what a full render would draw —
// append them and refresh the signature. The windowed tail (older-bar) qualifies too: the append
// trims from the front to keep the page identical. Anything else returns false (full render).
function appendLogTail() {
  const box = $('#log');
  if (!box || !renderLog.winItems) return false;
  if ($('#logsearch').value || !['info', 'warn', 'error'].every((l) => logLevels.has(l))) return false;
  if (box.querySelector('.logempty, .subblock, #log-showall')) return false;
  if (box.scrollTop + box.clientHeight < box.scrollHeight - 20 || !$('#logauto').checked) return false;
  const f = $('#logfilter').value;
  const teamIds = sel.logTeam ? new Set(logTeamNodes().map((n) => n.id)) : null;
  const fresh = logs.filter((l) => l && l.projectId === ctx.p && (!teamIds || teamIds.has(l.nodeId)) && (!f || l.nodeId === f) && (l._seq === undefined || l._seq > logTailSeq));
  // logTailSeq is NOT advanced here: a throw inside the row build below would otherwise stamp the
  // cursor past lines the DOM never received, hiding them for good. It moves only after the append
  // succeeded (or when nothing new needed drawing); a bail just falls back to a full render.
  // Lines injected out-of-band (no _seq — tests, restored sessions) were never counted by the
  // cursor; claiming them here would stamp a signature the DOM never rendered and hide them for
  // good. Same for subagent lines: they nest into blocks only a full render can build.
  if (fresh.some((l) => l._seq === undefined || l.subagentId)) return false;
  if (!fresh.length) { logTailSeq = logSeq; logSig = logKey(); return true; } // only already-rendered or filtered-out lines arrived
  const added = fresh;
  added.sort((a, b) => (a.at || 0) - (b.at || 0));
  if (added[0].at < logTailAt) return false; // straggler older than the tail: let renderLog re-sort
  const olderBar = box.querySelector('#log-older');
  if (!olderBar && renderLog.winItems + added.length > logWin) return false; // the page window would slide
  box.insertAdjacentHTML('beforeend', added.map((l) => logRow(l)).join(''));
  if (olderBar) {
    // Windowed live tail (t_fb193107): a full render keeps the LAST logWin rows on screen, so drop
    // the same number from the front and move the earlier-count — the fast append stays
    // pixel-identical to what renderLog would have drawn.
    for (let i = 0; i < added.length; i++) { const r = box.querySelector('.logrow'); if (!r) break; r.remove(); }
    renderLog.winItems = logWin;
    const hidden = renderLog.total + added.length - logWin;
    olderBar.textContent = `↑ ${hidden} earlier line${hidden === 1 ? '' : 's'} — scroll up or click to load`;
  } else renderLog.winItems += added.length;
  renderLog.total += added.length;
  logTailSeq = logSeq;
  logTailAt = added[added.length - 1].at;
  logSig = logKey();
  box.scrollTop = box.scrollHeight;
  repinBottom(box);
  return true;
}
// Direct 'log' pushes now carry only the low-volume paths (self-update watcher); orchestrator log
// lines arrive batched on the 'delta' channel above (t_d22a6cf2).
squad.on('log', (l) => { if (!l || typeof l !== 'object') return; l._seq = ++logSeq; logs.push(l); if (logs.length > 8000) logs.splice(0, 1000); if (l.projectId === ctx.p) chatBump(); scheduleLogRender(); });
// In-app toast for orchestrator notifications (desktop notifications are shown by the main process).
squad.on('notify', (n) => {
  if (n.projectId && n.projectId !== ctx.p) return;
  const d = document.createElement('div'); d.className = 'toast'; d.innerHTML = `<b>${esc(n.title)}</b><br>${esc(n.body)}`;
  if (n.inbox) refresh();
  // In Chat the "Your turn" bar already carries the question; a toast there would cover the composer's Send.
  if (n.inbox && document.querySelector('button[data-tab="chat"].active')) return;
  d.onclick = () => { if (n.inbox) { showTab('inbox'); d.remove(); return; } if (n.taskId) { sel.task = n.taskId; showTab('board'); renderBoard(); } d.remove(); };
  $('#toasts').appendChild(d); setTimeout(() => d.remove(), 8000);
});
// Keyboard shortcuts: Ctrl/Cmd+1..7 tabs, ⌘, settings, ⌘I inbox, Ctrl/Cmd+Enter Run, Ctrl/Cmd+. Stop,
// / goal composer, Esc clear selection / close, ? help.
const TABS = ['chat', 'team', 'board', 'wiki', 'obs', 'usage'];
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey; const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (mod && e.key >= '1' && e.key <= '9') { e.preventDefault(); const t = TABS[+e.key - 1]; if (t) showTab(t); }
  else if (mod && e.key === ',') { e.preventDefault(); showTab('settings'); }
  else if (mod && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); showTab('inbox'); }
  else if (mod && e.key === 'Enter') { e.preventDefault(); $('#run').click(); }
  else if (mod && e.key === '.') { e.preventDefault(); $('#stop').click(); }
  else if (e.key === 'Escape' && !$('#askdlg').open) { if ($('#helpdlg').open) return; if (alertsOpen) return closeAlerts(); if (!$('#goalpop').classList.contains('hidden')) return $('#goalpop').classList.add('hidden'); if (typing) return document.activeElement.blur(); sel = { ...sel, node: null, edge: null, task: null }; connectMode = false; connectFrom = null; $('#connect').classList.remove('on'); renderGraph(); renderNodeForm(); renderBoard(); }
  else if (!typing && !mod && e.key === '?') $('#helpdlg').showModal();
  else if (!typing && !mod && e.key === 'n' && document.querySelector('#tab-board.active')) { e.preventDefault(); $('#nt-title').focus(); }
  else if (!typing && !mod && (e.key === 'e' || e.key === 'E') && document.querySelector('#tab-team.active')) { e.preventDefault(); setTeamMode(teamMode() === 'edit' ? 'watch' : 'edit'); }
  else if (!typing && !mod && e.key === '/') { e.preventDefault(); openGoalPop(); }
});
// IPC deltas (t_39bf39ac, track 2): the main process pushes {type,id,patch} batches — one send per
// tick, seq-chained — covering tasks/wiki (board-cache change events), the orch snapshot (state
// events), batched log lines (t_d22a6cf2) and messages/inbox/runs (sig-checked per flush). The
// renderer patches its local store and re-renders the visible views; a seq gap or resync marker
// falls back to a full getAll pull (wiki rule 5). The 2s tick below stays as the backstop for the
// sections deltas do not cover.
let lastDeltaSeq = null, lastDeltaProject = null;
// Log-line ingest shared by both paths (t_d22a6cf2): batched deltas for the active project and the
// cross-project batches below keep the old 'log'-channel semantics — lines from every project
// accumulate (tagged with projectId), only the active project's redraw the views.
function ingestLogs(lines) {
  for (const l of lines) { l._seq = ++logSeq; logs.push(l); }
  if (logs.length > 8000) logs.splice(0, 1000);
  // A batch comes from one pump/project: bump chat only for the active project's lines (the old
  // 'log' handler skipped them too); the log tail renders itself only when Obs is open anyway.
  if (!lines[0] || !lines[0].projectId || lines[0].projectId === ctx.p) chatBump();
  scheduleLogRender();
}
// Main render path (t_d0a816d9): every same-project delta batch used to end in a renderAll one
// rAF later — while agents stream, batches arrive several per frame and the whole chrome + active
// view rebuild at up to 60/s. The same event-driven scheduler the chat room uses coalesces the
// burst to one draw per minMs with a guaranteed trailing edge, so the last patch always lands.
const renderSched = RenderSched.create({
  minMs: 200,
  hidden: () => document.hidden,
  gate: () => true, // the chrome renderSched draws is on screen on every tab
  draw: () => renderAll(), // late-binding: e2e/perf harnesses wrap the global by name
});
squad.on('delta', (b) => {
  if (!b || !Array.isArray(b.deltas)) return;
  if (b.projectId && b.projectId !== ctx.p) {
    // Inactive project's batch: not applied to S (its seq chain is tracked on switch), but its log
    // lines still accumulate so a later switch has the same history the direct pushes delivered.
    for (const d of b.deltas) if (d.type === 'logs') ingestLogs(d.set);
    return;
  }
  if (lastDeltaProject !== ctx.p) { lastDeltaProject = ctx.p; lastDeltaSeq = null; } // fresh chain after a project switch
  if (DeltaClient.plan(lastDeltaSeq, b).op === 'resync') { lastDeltaSeq = null; lastV = null; refresh(); return; }
  lastDeltaSeq = b.seq;
  for (const d of b.deltas) {
    if (d.type === 'runs') { RUNS = d.set; chatBump(); continue; } // module binding, not an S section
    if (d.type === 'logs') { ingestLogs(d.set); continue; } // batched log lines: one IPC per tick instead of one per line
    if (d.type === 'resync') { lastDeltaSeq = null; lastV = null; refresh(); return; }
    DeltaClient.patch(S, d);
    // Chat reads task/messages/inbox/orch/runs: bump its epoch so the event-driven redraw
    // (chatSched) picks the change up; wiki/board-only deltas leave the room alone.
    if (d.type === 'task' || d.type === 'messages' || d.type === 'inbox' || d.type === 'orch') chatBump();
  }
  if (b.v && lastV) Object.assign(lastV, b.v); // keep the version poll quiet about what we already applied
  renderSched.bump(); // coalesced full draw: the state is patched, the pixels follow on the scheduler's trailing edge
});
squad.on('state', (st) => { if (st.projectId && st.projectId !== ctx.p) { clearTimeout(pendingP); pendingP = setTimeout(async () => { P = await call('listProjects'); renderSidebar(); }, 200); return; } clearTimeout(pending); }); // same-project state arrives as deltas now; cancel a pending pull instead of scheduling one
// Pause-when-hidden (t_e116438b): while the window is hidden the schedulers arm nothing (rAF is
// stalled anyway, and DOM built in the dark is wasted work) and the backstop poll sleeps; on show,
// one catch-up pull plus a chat bump redraw whatever moved while dark. Deltas keep patching S and
// bump the schedulers, so every view (not just chat) is current again by the frame after show.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { chatSched.hide(); renderSched.hide(); return; }
  chatBump(); renderSched.bump(); refresh();
});
setInterval(() => { if (S.orch.running && !document.hidden) refresh(); }, 2000); // backstop for the sections deltas do not carry (team/nodes/nstat); version-gated inside refresh, paused while hidden
refresh().then(() => syncRecovery()); // recovery banner needs a settled ctx.p (t_6911ba60)
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
{ const mq = matchMedia('(prefers-color-scheme: dark)'); const override = () => { try { const o = localStorage.getItem('themeOverride'); if (o === 'light' || o === 'dark') return o; } catch {} return null; };
  const apply = () => document.documentElement.dataset.theme = override() || (mq.matches ? 'dark' : 'light');
  apply(); mq.addEventListener('change', apply);
  squad.on('theme', (t) => { if (!override()) document.documentElement.dataset.theme = t.dark ? 'dark' : 'light'; });
  $('#themebtn').onclick = () => { const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('themeOverride', cur); } catch {} document.documentElement.dataset.theme = cur; }; }
// macOS draws the hiddenInset traffic lights over the page's top-left; flag the platform so the
// header can inset its content (brand first) clear of the window controls.
if (/Mac/i.test(navigator.userAgent)) document.documentElement.dataset.platform = 'mac';
// Add-task form: description row stays collapsed until the title is focused.
$('#nt-title').addEventListener('focus', () => { $('#nt-desc').style.display = ''; });
