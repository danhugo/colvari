// Per-agent configuration: node normalisation, role presets and claude CLI argument building.
// Pure functions, shared by the store, orchestrator, projects and tests.

const { MODE_DEFAULTS, normalizeMode } = require('./agent-modes');
const { normalizeBilling } = require('./usage');
const SUGGESTED_ROLES = ['PM', 'Planner', 'Dev', 'Reviewer', 'QA'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
const EDGE_TYPES = ['assign', 'message', 'review'];
const BOARD_TOOLS = ['list_team', 'list_tasks', 'create_task', 'update_task_status', 'comment_task', 'send_message', 'read_messages', 'ask_human', 'read_wiki', 'write_wiki', 'recruit_agent', 'retire_agent', 'update_agent', 'request_self_update', 'schedule_restart'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Fields every node carries. '' / 0 / [] / {} mean "not set" (use the project default or the CLI default).
const NODE_DEFAULTS = {
  name: 'Agent', role: 'Dev', runtime: 'claude', systemPrompt: '', model: '', workdir: '',
  permissionMode: '', allowedTools: [], disallowedTools: [], extraArgs: '', env: {},
  maxTurns: 0, appendSystemPrompt: '', addDirs: [], disabledBoardTools: [],
  billingMode: 'auto', billingBaseUrl: '',
  requireApproval: false, budgetUsd: 0, budgetTokens: 0,
  effort: 'low', autoCompact: '', // autoCompact: '' = CLI default; 'auto', or a token window 100000-1000000
  autoCompactPct: '', // auto-compact threshold (% of the window); '' = use the project default (settings.autoCompactPct)
  enabledCapabilities: [], // names from node.capabilities.categorized (mode/skill/command/mcp) this agent should use
  core: false, createdBy: '', recruitedAt: '', protected: false, // team management: core on the one core; recruits carry who/when created them. protected blocks retirement only (canRetire); when the field is absent normalizeNode derives it from createdBy (human-made true, recruits false)
  ...MODE_DEFAULTS,
};
const NODE_FIELDS = Object.keys(NODE_DEFAULTS);

// "a, b\nc" or ["a","b"] -> ["a","b","c"]. Commas and newlines separate entries (tool specs like "Bash(git log:*)" contain spaces).
function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v == null || v === '') return [];
  return String(v).split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}
// "K=V\nK2=V2" or {K:V} -> {K:V}
function toEnv(v) {
  if (!v) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, x]) => [k, String(x)]));
  const out = {};
  for (const line of String(v).split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/); if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const envToText = (env) => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');

// Shell-like split: whitespace separates, single/double quotes group, backslash escapes.
function splitArgs(s) {
  const out = []; let cur = ''; let q = null; let has = false;
  s = String(s || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; } else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; } else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; } else { cur += c; has = true; }
  }
  if (q) throw new Error('unbalanced quote in extra args');
  if (has || cur) out.push(cur);
  return out;
}

// Strip a hand-added "--effort <level>" out of extraArgs, returning the level found (if any) and the rest.
function migrateEffortArg(extraArgs) {
  const tokens = splitArgs(extraArgs);
  const i = tokens.indexOf('--effort');
  if (i === -1) return { effort: null, extraArgs };
  const effort = tokens[i + 1] || null;
  const rest = [...tokens.slice(0, i), ...tokens.slice(i + 2)];
  return { effort, extraArgs: rest.map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t)).join(' ') };
}

function normalizeNode(n = {}, base = NODE_DEFAULTS) {
  const r = {};
  for (const k of NODE_FIELDS) r[k] = n[k] !== undefined ? n[k] : (Array.isArray(base[k]) ? [...base[k]] : typeof base[k] === 'object' ? { ...base[k] } : base[k]);
  r.runtime = r.runtime ? String(r.runtime) : 'claude'; // unknown ids are kept so the run errors instead of silently using claude
  r.name = String(r.name || 'Agent'); r.role = String(r.role || '').trim() || 'Dev';
  r.core = !!r.core; r.createdBy = String(r.createdBy || ''); r.recruitedAt = String(r.recruitedAt || '');
  // Absent flag derives from recruitment: nodes the human made (editor, presets, templates) are
  // protected from retirement, recruits are not. Explicit values always win (the human's toggle).
  r.protected = n.protected !== undefined ? !!n.protected : !r.createdBy;
  if (r.permissionMode && !PERMISSION_MODES.includes(r.permissionMode)) throw new Error('bad permission mode ' + r.permissionMode);
  r.allowedTools = toList(r.allowedTools); r.disallowedTools = toList(r.disallowedTools); r.addDirs = toList(r.addDirs);
  r.enabledCapabilities = toList(r.enabledCapabilities);
  r.disabledBoardTools = toList(r.disabledBoardTools).filter((t) => BOARD_TOOLS.includes(t));
  r.env = toEnv(r.env); r.maxTurns = Math.max(0, parseInt(r.maxTurns, 10) || 0);
  r.extraArgs = String(r.extraArgs || ''); splitArgs(r.extraArgs); // validate
  r.requireApproval = !!r.requireApproval; r.budgetUsd = Math.max(0, Number(r.budgetUsd) || 0); r.budgetTokens = Math.max(0, parseInt(r.budgetTokens, 10) || 0);
  // Migration: extraArgs used to carry "--effort <level>" by hand; fold it into the effort field and drop it
  // from extraArgs so it isn't duplicated on the CLI invocation.
  const migrated = migrateEffortArg(r.extraArgs);
  r.extraArgs = migrated.extraArgs;
  r.effort = EFFORT_LEVELS.includes(n.effort) ? n.effort : (migrated.effort && EFFORT_LEVELS.includes(migrated.effort) ? migrated.effort : 'low');
  if (String(r.autoCompact).trim().toLowerCase() === 'auto') r.autoCompact = 'auto';
  else {
    const tokens = parseInt(r.autoCompact, 10);
    // Legacy autoCompact values <=100 were percentages; migrate them to the CLI default instead of clamping.
    r.autoCompact = (tokens && tokens > 100) ? String(Math.min(1000000, Math.max(100000, tokens))) : '';
  }
  // '' / 0 / invalid -> '' (project default). 0 as "off" is handled at project level (settings.autoCompactPct = 0).
  const pct = parseInt(r.autoCompactPct, 10);
  r.autoCompactPct = pct >= 1 ? Math.min(100, pct) : '';
  Object.assign(r, normalizeMode(r), normalizeBilling(r));
  return r;
}
// Only the fields present in patch, normalised (for updateNode).
function normalizePatch(patch) {
  const full = normalizeNode({ ...NODE_DEFAULTS, ...patch });
  const r = {};
  for (const k of Object.keys(patch)) r[k] = k in full ? full[k] : patch[k];
  return r;
}

// Role presets live in project settings: [{ name, systemPrompt, allowedTools, disallowedTools, permissionMode }]
function normalizePreset(p) {
  if (!p || !String(p.name || '').trim()) throw new Error('preset name required');
  const pm = p.permissionMode || '';
  if (pm && !PERMISSION_MODES.includes(pm)) throw new Error('bad permission mode ' + pm);
  return { name: String(p.name).trim(), systemPrompt: String(p.systemPrompt || ''), allowedTools: toList(p.allowedTools), disallowedTools: toList(p.disallowedTools), permissionMode: pm };
}
const findPreset = (presets, role) => (presets || []).find((p) => p.name.toLowerCase() === String(role || '').toLowerCase());
// Fill empty node fields from the preset matching its role (explicit values win).
function applyPreset(node, presets) {
  const p = findPreset(presets, node.role); if (!p) return node;
  const r = { ...node };
  if (!r.systemPrompt) r.systemPrompt = p.systemPrompt;
  if (!toList(r.allowedTools).length) r.allowedTools = [...p.allowedTools];
  if (!toList(r.disallowedTools).length) r.disallowedTools = [...p.disallowedTools];
  if (!r.permissionMode) r.permissionMode = p.permissionMode;
  return r;
}
const roleSuggestions = (presets, nodes = []) => [...new Set([...SUGGESTED_ROLES, ...(presets || []).map((p) => p.name), ...nodes.map((n) => n.role).filter(Boolean)])];

// claude CLI args for one run (everything after the binary). mcpConfig is an object.
// opts.resume: session id to continue (--resume).
function buildClaudeArgs(node, prompt, settings, mcpConfig, opts = {}) {
  const n = normalizeNode(node);
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', JSON.stringify(mcpConfig), '--strict-mcp-config',
    '--permission-mode', n.permissionMode || settings.permissionMode || 'bypassPermissions'];
  if (opts.resume) args.push('--resume', String(opts.resume));
  if (n.model) args.push('--model', n.model);
  args.push('--effort', n.effort);
  if (n.autoCompact) args.push('--autocompact', n.autoCompact);
  if (n.allowedTools.length) {
    const tools = n.allowedTools.some((t) => t.startsWith('mcp__board')) ? n.allowedTools : [...n.allowedTools, 'mcp__board']; // keep the board usable
    args.push('--allowedTools', tools.join(','));
  }
  if (n.disallowedTools.length) args.push('--disallowedTools', n.disallowedTools.join(','));
  if (n.maxTurns) args.push('--max-turns', String(n.maxTurns));
  const capNote = n.enabledCapabilities.length ? `Enabled capabilities for this agent: ${n.enabledCapabilities.join(', ')}. Use them when relevant.` : '';
  const sysPrompt = [n.appendSystemPrompt, capNote].filter(Boolean).join('\n\n');
  if (sysPrompt) args.push('--append-system-prompt', sysPrompt);
  // opts.attachDir (the project's attachments dir, set only for runs that carry attachments) rides
  // the same --add-dir loop as the node's own addDirs.
  for (const d of (opts.attachDir ? [...n.addDirs, opts.attachDir] : n.addDirs)) args.push('--add-dir', d);
  args.push(...splitArgs(n.extraArgs));
  return args;
}

module.exports = { SUGGESTED_ROLES, PERMISSION_MODES, EDGE_TYPES, BOARD_TOOLS, EFFORT_LEVELS, NODE_DEFAULTS, NODE_FIELDS, toList, toEnv, envToText, splitArgs, normalizeNode, normalizePatch, normalizePreset, findPreset, applyPreset, roleSuggestions, buildClaudeArgs, migrateEffortArg };
