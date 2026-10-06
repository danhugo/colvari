// Generic CLI introspector: derives a RuntimeProfile from any agent CLI in layers, cheapest and most
// trustworthy first — (1) tolerant --help parsing (prompt/model/output/json flags), (2) `models`
// discovery, (3) one sandboxed probe run, (4) an opt-in fallback that asks the CLI's own agent to
// emit its profile as JSON (strictly validated — never trusted as-is). No CLI-specific code paths:
// every CLI (helpycode, claude, codex, ...) goes through the same layers. Returns the profile plus a
// per-field {source, confidence} map so callers (and the UI) can show where every value came from;
// fields filled by the ask-agent layer are low-confidence and never applied silently (opt-in).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRuntimeProfile } = require('./runtime-profile');

// Per-layer provenance. help/models/probe are deterministic observations of the CLI itself (high
// confidence); agent output is model-generated (low confidence, opt-in only).
const SRC = {
  help: { source: 'help', confidence: 'high' },
  models: { source: 'models', confidence: 'high' },
  probe: { source: 'probe', confidence: 'high' },
  agent: { source: 'agent', confidence: 'low' },
};

// "  run           Run a task and print JSON events" -> { name: 'run', desc: '...' }
// Some CLIs (e.g. helpycode/yargs) prefix every command with the binary name instead of indenting
// bare names: "  helpycode run [message..]     run HelpyCode with a message". Detect that prefix by
// noticing the same first token repeats across every command row, and strip it before extracting
// the actual command name (dropping bracketed/positional-only rows like "helpycode [project]").
function parseCommands(help) {
  const rows = [];
  const lines = String(help || '').split('\n');
  let inCommands = false;
  for (const line of lines) {
    if (/^\s*(Commands|Sub[- ]?commands):?\s*$/i.test(line)) { inCommands = true; continue; }
    if (inCommands) {
      if (!line.trim()) { inCommands = false; continue; }
      if (!/^\s{2,}\S/.test(line)) { inCommands = false; continue; }
      const m = line.match(/^\s{2,}(\S.*?)\s{2,}(.*)$/);
      if (m) rows.push({ cmd: m[1], desc: m[2].trim() });
    }
  }
  if (!rows.length) return [];
  const firstTokens = rows.map((r) => r.cmd.split(/\s+/)[0]);
  const hasPrefix = firstTokens.length > 1 && firstTokens.every((t) => t === firstTokens[0]);
  const out = [];
  for (const r of rows) {
    const cmd = hasPrefix ? r.cmd.slice(firstTokens[0].length).trim() : r.cmd;
    const name = (cmd.split(/\s+/)[0] || '');
    if (!name || /^[\[<]/.test(name)) continue;
    out.push({ name, desc: r.desc });
  }
  return out;
}

// Prefer an exec/run command by name; else one whose description advertises non-interactive/JSON
// output (name check first: plenty of unrelated commands mention JSON in their description, e.g.
// helpycode's "export ... export session data as JSON"); else first.
function pickRunCommand(commands) {
  const byName = commands.find((c) => /^(exec|run)$/i.test(c.name));
  if (byName) return byName.name;
  const byHint = commands.find((c) => /json|non-interactiv/i.test(c.desc));
  if (byHint) return byHint.name;
  return commands[0] ? commands[0].name : '';
}

// "--effort <level>   Reasoning effort (low, medium, high)" -> { flag: '--effort', values: [...] }
// Also matches CLIs that call the flag "--variant" and describe it with an "e.g., a, b, c" list
// wrapped across multiple help lines (e.g. real helpycode's "--variant ... (provider-specific
// reasoning effort, e.g., high, max, minimal)"); flatten whitespace first so wrapping can't hide it.
// An "e.g." list is explicitly NON-exhaustive, so it yields the flag but no values: a partial
// vocabulary would make the runner reject effort levels the CLI actually accepts (its default
// "low", for one). The ask-agent layer or a user edit completes the list.
function findEffort(text) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const m = flat.match(/(--effort|--variant|--reasoning-effort)\b[^()]*\(([^)]*)\)/i);
  if (!m) return { flag: '', values: [] };
  if (/e\.g\.,?/i.test(m[2])) return { flag: m[1], values: [] };
  return { flag: m[1], values: m[2].split(',').map((s) => s.trim()).filter(Boolean) };
}

function findResume(text, commands) {
  if (/--resume\b/.test(text)) return '--resume';
  if (commands.some((c) => c.name === 'resume')) return 'resume';
  const flat = String(text || '').replace(/\s+/g, ' ');
  const short = flat.match(/(-\w),\s*--session\b/i);
  if (short) return short[1];
  if (/--session\b/.test(flat)) return '--session';
  return '';
}

function findModelFlag(text) {
  if (/--model\b/.test(text)) return '--model';
  if (/\B-m\b,?\s*--model\b|--model\b,?\s*-m\b/.test(text)) return '--model';
  if (/\s-m\s*<[^>]*>/.test(text)) return '-m';
  return '--model';
}

function findFormatFlag(text) {
  if (/--format\b/.test(text)) return { flag: '--format', value: 'json' };
  if (/--json\b/.test(text)) return { flag: '--json', value: '' };
  return { flag: '', value: '' };
}

function findMcp(text) {
  if (/--mcp-config\b/.test(text)) return { method: 'json-flag', flag: '--mcp-config' };
  if (/mcp_servers\.|mcp[- ]servers?\b/i.test(text)) return { method: 'toml-override', flag: '-c' };
  // CLI with its own `<bin> mcp` management subcommand (opencode-style): servers live in a config file,
  // passed per run via <BIN>_CONFIG (see runtimes.js buildArgs).
  const sub = text.match(/^\s*(\S+)\s+mcp\b.*\bmcp\b/im);
  if (sub) return { method: 'file', flag: sub[1].split('/').pop() + '.json' };
  return { method: 'none', flag: '' };
}

// "--dangerously-skip-permissions   auto-approve permissions that are not explicitly denied" ->
// '--dangerously-skip-permissions'. Only bypass-shaped flags are claimed, and only advertised by the
// CLI's own help. The flag is never sent during introspection itself (assertSafeArgs); the runner
// applies it at real-run time, only when the node's effective permission mode is bypassPermissions —
// without it, non-interactive runs auto-reject permission asks (external_directory) and the agent
// cannot reach the paths it needs (t_2cd0112e).
function findBypassFlag(text) {
  const m = String(text || '').match(/\s(--[\w-]*(?:skip-permissions|bypass|yolo|auto-approve)[\w-]*)\b/);
  return m ? m[1] : '';
}

// Recursively flatten a JSON value into { 'a.b.c': value } for scalar leaves.
function flatten(obj, prefix = '', out = {}) {
  if (obj != null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = obj;
  }
  return out;
}

const KEY_SYNONYMS = {
  inputPath: /^(input_tokens|inputTokens|prompt_tokens|input)$/i,
  outputPath: /^(output_tokens|outputTokens|completion_tokens|output)$/i,
  reasoningPath: /^(reasoning_tokens|reasoning_output_tokens|reasoningTokens|reasoning)$/i,
  cachePath: /^(cache_read_tokens|cached_input_tokens|cache_read_input_tokens|cacheReadTokens)$/i,
  costPath: /^(total_cost_usd|cost_usd|cost|totalCostUsd)$/i,
  sessionIdPath: /^(session_id|thread_id|sessionId|threadId)$/i,
  textPath: /^(text|message|content)$/i,
};

// Scan parsed probe events for keys matching known synonyms; first match per field wins.
// Token/cost fields must claim a numeric leaf: an opencode-derived probe stream also contains
// tool events whose `output` leaf is the tool's string result, and claiming that as outputPath
// would silently zero the token totals (t_9d30cabe).
const NUMERIC_FIELDS = new Set(['inputPath', 'outputPath', 'reasoningPath', 'cachePath', 'costPath']);
function deriveEventMapping(events) {
  const mapping = { textPath: '', sessionIdPath: '', costPath: '', inputPath: '', outputPath: '', reasoningPath: '', cachePath: '' };
  for (const ev of events) {
    const flat = flatten(ev);
    for (const [path, value] of Object.entries(flat)) {
      const leaf = path.split('.').pop();
      for (const [field, re] of Object.entries(KEY_SYNONYMS)) {
        if (!mapping[field] && re.test(leaf) && (field === 'textPath' ? typeof value === 'string' : true) && (!NUMERIC_FIELDS.has(field) || typeof value === 'number')) mapping[field] = path;
      }
    }
  }
  return mapping;
}

// Parse newline-delimited JSON, ignoring non-JSON lines (banners, warnings).
function parseJsonLines(out) {
  const events = [];
  for (const line of String(out || '').split('\n')) {
    const t = line.trim(); if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* not a JSON line */ }
  }
  return events;
}

// `models` output -> model names, tolerantly. Accepts a bare JSON array, an object wrapping one
// ({models:[...]} / {data:[...]}), NDJSON rows, or a plain list; entries may be strings or objects
// with a name/id/model key. Unparseable junk is skipped, never thrown.
function parseModelsOutput(out) {
  const text = String(out || '').trim();
  if (!text) return [];
  const nameOf = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' ? String(v.name || v.id || v.model || '') : ''));
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j && typeof j === 'object' && Array.isArray(j.models || j.data) ? (j.models || j.data) : null);
    if (arr) return [...new Set(arr.map(nameOf).filter(Boolean))];
  } catch { /* not one big JSON value */ }
  const names = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const n = nameOf(JSON.parse(t)); if (n) { names.push(n); continue; } } catch { /* plain line */ }
    const m = t.match(/^[-*\s|]*([A-Za-z0-9][A-Za-z0-9._/:${}@-]*)(?:\s|$)/); // first column of a line (plain list or table row)
    // model ids carry a digit or a separator; bare lowercase words are banners/noise
    if (m && !/^[A-Z0-9._/:${}@-]+$/.test(m[1]) && /(\d|[./:-])/.test(m[1])) names.push(m[1]);
  }
  return [...new Set(names)];
}

// ---------- sandboxed execution (every probe/help/version call goes through here) ----------

// Only well-known, non-secret env vars reach introspected CLIs: never leak API keys or tokens from
// the user's environment into an unknown binary.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'OS', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE'];
function sandboxEnv(env = process.env) {
  const out = {};
  for (const k of ENV_ALLOWLIST) if (env[k] != null) out[k] = env[k];
  return out;
}
let sandboxDir = null;
function getSandboxDir() {
  if (!sandboxDir) {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-squad-introspect-'));
    // The sandbox lives as long as the process (probe cwd), so removal rides the exit hook
    // (t_8170a988) — probes are synchronous, so nothing can be using it when exit runs.
    process.on('exit', () => { try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {} });
  }
  return sandboxDir;
}

// Introspection never sends approval-bypass flags to an unknown binary, even if its own help or the
// ask-agent fallback suggested them. The ban applies to flag-shaped tokens only: the ask-agent
// prompt is prose that legitimately names the bypassFlag schema key.
const BANNED_ARG = /(^--?(y|yes)$)|dangerous|bypass|auto.?approve/i;
const BARE_YES = /^(y|yes)$/i;
function assertSafeArgs(args) {
  for (const a of args) {
    if ((a.startsWith('-') && BANNED_ARG.test(a)) || BARE_YES.test(a)) throw new Error(`introspection refuses to run arg "${a}" (auto-approve/bypass flags are never sent to an unknown CLI)`);
  }
  return args;
}

// Exec factory bound to an env. With no env, uses the filtered sandbox env (safe default for
// --help/--version/models of an unknown binary). Callers may bind the real run env for the
// probe/ask layers of an authenticated CLI — the same env it gets on every real run anyway.
// Async since t_5a78aa95: the old spawnSync blocked the main process up to 15s per probe.
// The result is stdout+stderr combined; failures resolve to '' like spawnSync's error result.
function makeExec(env) {
  const CP = require('./cp');
  return async (bin, args) => {
    const r = await CP.run(bin, args, { encoding: 'utf8', timeoutMs: 15000, cwd: getSandboxDir(), env: env || sandboxEnv() });
    return String((r.stdout || '') + (r.stderr || ''));
  };
}
const defaultExec = makeExec();

// ---------- layer 4: ask the agent for its own profile (opt-in, strictly validated) ----------

const AGENT_PROFILE_PROMPT = [
  'Print ONLY a single JSON object (no prose, no markdown fences) describing how to run yourself non-interactively from a script:',
  '{"argsTemplate": ["..."], "resumeFlag": "", "effortFlag": "", "effortValues": [],',
  ' "mcp": {"method": "none|json-flag|toml-override|file", "flag": ""}, "bypassFlag": "",',
  ' "eventMapping": {"textPath": "", "sessionIdPath": "", "costPath": "", "inputPath": "", "outputPath": "", "reasoningPath": "", "cachePath": ""}}.',
  'argsTemplate is the argv after the binary, with the placeholders {model}, {variant} and {prompt} where those belong;',
  'eventMapping entries are dotted paths into each JSON event you print on stdout (empty string = field unsupported).',
].join(' ');

// Pull the first balanced-looking JSON object out of possibly chatty output.
function extractJson(out) {
  const m = String(out || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const SAFE_TOKEN = /[;&|`<>\n\r]/; // args are spawned without a shell; metacharacters are still rejected
const SAFE_FLAG = /^--?[\w][\w=-]*$/; // one or two leading dashes, then flag characters
const SAFE_FILENAME = /^[\w][\w.-]*$/;
const EVENT_MAPPING_KEYS = Object.keys(KEY_SYNONYMS);

// Validate a model-emitted profile against the RuntimeProfile schema. The binary allowlist is the
// binary being introspected (forced, never taken from the model); unknown fields are dropped; shell
// metacharacters in argsTemplate and non-flag/unsafe mcp flags are rejected. Throws on unusable input.
function validateAgentProfile(raw, bin) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('agent profile: not a JSON object');
  const argsTemplate = (Array.isArray(raw.argsTemplate) ? raw.argsTemplate : []).map((t) => String(t));
  if (argsTemplate.some((t) => SAFE_TOKEN.test(t))) throw new Error('agent profile: shell metacharacter in argsTemplate');
  if (!argsTemplate.some((t) => /\{prompt\}/.test(t))) throw new Error('agent profile: argsTemplate must contain a {prompt} placeholder');
  const mcpRaw = raw.mcp && typeof raw.mcp === 'object' ? raw.mcp : {};
  const mcpMethod = String(mcpRaw.method || 'none');
  const mcpFlag = String(mcpRaw.flag || '');
  if (mcpFlag && !(mcpMethod === 'file' ? SAFE_FILENAME : SAFE_FLAG).test(mcpFlag)) throw new Error(`agent profile: unsafe mcp flag "${mcpFlag}"`);
  const effortFlag = String(raw.effortFlag || '');
  if (effortFlag && !SAFE_FLAG.test(effortFlag)) throw new Error(`agent profile: unsafe effort flag "${effortFlag}"`);
  const resumeFlag = String(raw.resumeFlag || '');
  if (resumeFlag && SAFE_TOKEN.test(resumeFlag)) throw new Error(`agent profile: unsafe resume flag "${resumeFlag}"`);
  const bypassFlag = String(raw.bypassFlag || '');
  if (bypassFlag && !SAFE_FLAG.test(bypassFlag)) throw new Error(`agent profile: unsafe bypass flag "${bypassFlag}"`);
  const emRaw = raw.eventMapping && typeof raw.eventMapping === 'object' ? raw.eventMapping : {};
  const eventMapping = {};
  for (const k of EVENT_MAPPING_KEYS) {
    const v = String(emRaw[k] || '');
    if (v && !/^[\w.]+$/.test(v)) throw new Error(`agent profile: unsafe eventMapping path "${v}"`);
    eventMapping[k] = v;
  }
  return normalizeRuntimeProfile({
    id: bin, label: bin, binary: bin, // binary allowlist: the profile can only ever describe this binary
    argsTemplate,
    effortFlag,
    effortValues: (Array.isArray(raw.effortValues) ? raw.effortValues : []).map((v) => String(v)),
    resumeFlag,
    bypassFlag,
    mcp: { method: mcpMethod, flag: mcpFlag },
    eventMapping,
  });
}

// Fill gaps left by layers 1-3; derived (observed) fields are never overwritten by model output.
// effortValues is the exception: help only advertises examples ("e.g., high, max, minimal"), so the
// agent's answer is UNIONED in — an incomplete vocabulary would make buildProfileArgs reject valid
// effort levels the CLI actually accepts.
function mergeAgentFields(profile, agentProfile, sources) {
  for (const k of ['argsTemplate', 'effortFlag', 'resumeFlag', 'bypassFlag']) {
    const empty = Array.isArray(profile[k])
      ? profile[k].length === 0 || (k === 'argsTemplate' && profile[k].length === 1 && profile[k][0] === '{prompt}')
      : !profile[k];
    const fill = Array.isArray(agentProfile[k]) ? agentProfile[k].length > 0 : !!agentProfile[k];
    if (empty && fill) { profile[k] = agentProfile[k]; sources[k] = SRC.agent; }
  }
  if (agentProfile.effortValues.length) {
    const merged = [...new Set([...profile.effortValues, ...agentProfile.effortValues])];
    if (merged.length > profile.effortValues.length) { profile.effortValues = merged; sources.effortValues = SRC.agent; }
  }
  if ((profile.mcp.method === 'none') && agentProfile.mcp.method !== 'none') { profile.mcp = agentProfile.mcp; sources.mcp = SRC.agent; }
  for (const k of EVENT_MAPPING_KEYS) {
    if (!profile.eventMapping[k] && agentProfile.eventMapping[k]) { profile.eventMapping[k] = agentProfile.eventMapping[k]; sources.eventMapping = SRC.agent; }
  }
  return profile;
}

// exec(bin, args) -> stdout string; must not throw for --help calls that exit non-zero (caller should catch).
// exec is optional; when omitted (or when the second arg is an opts object instead of a function),
// falls back to defaultExec above. Both exec and introspectRuntime are async since t_5a78aa95 —
// sync fakes injected by tests keep working under await.
async function introspectRuntime(bin, execOrOpts, maybeOpts) {
  const opts = (typeof execOrOpts === 'function' ? maybeOpts : execOrOpts) || {};
  const exec = typeof execOrOpts === 'function' ? execOrOpts : (opts.env ? makeExec(opts.env) : defaultExec);
  const safeExec = async (args) => { try { return String((await exec(bin, args)) || ''); } catch (e) { return String((e && e.stdout) || ''); } };
  const sources = {};

  // Layer 1: tolerant --help parsing (top level + the run subcommand).
  const help = await safeExec(['--help']);
  const commands = parseCommands(help);
  const runCommand = pickRunCommand(commands);
  const subHelp = runCommand ? await safeExec([runCommand, '--help']) : '';
  const text = help + '\n' + subHelp;

  const { flag: effortFlag, values: effortValues } = findEffort(text);
  const resumeFlag = findResume(text, commands);
  const modelFlag = findModelFlag(text);
  const { flag: formatFlag, value: formatValue } = findFormatFlag(text);
  const mcp = findMcp(text);
  const bypassFlag = findBypassFlag(text);
  const hasModelsCmd = commands.some((c) => c.name === 'models');

  const argsTemplate = [];
  if (runCommand) argsTemplate.push(runCommand);
  if (formatFlag) argsTemplate.push(formatFlag, formatValue || 'json');
  if (modelFlag) argsTemplate.push(modelFlag, '{model}');
  if (effortFlag) argsTemplate.push(effortFlag, '{variant}');
  argsTemplate.push('{prompt}');
  if (argsTemplate.length > 1) sources.argsTemplate = SRC.help;
  if (effortFlag) { sources.effortFlag = SRC.help; sources.effortValues = SRC.help; }
  if (resumeFlag) sources.resumeFlag = SRC.help;
  if (mcp.method !== 'none') sources.mcp = SRC.help;
  if (bypassFlag) sources.bypassFlag = SRC.help;

  // Layer 2: models discovery.
  let models = [];
  if (hasModelsCmd && opts.models !== false) {
    models = parseModelsOutput(await safeExec(['models']));
    if (models.length) sources.models = SRC.models;
  }

  // Layer 3: one probe run to learn the event stream shape.
  let eventMapping = { textPath: '', sessionIdPath: '', costPath: '', inputPath: '', outputPath: '', reasoningPath: '', cachePath: '' };
  if (opts.probe !== false && formatFlag) {
    const filled = argsTemplate.map((t) => t.replace('{model}', '\0').replace('{variant}', '\0').replace('{prompt}', opts.probePrompt || 'say pong'));
    const probeArgs = [];
    for (let i = 0; i < filled.length; i++) {
      if (filled[i] === '\0') { probeArgs.pop(); continue; } // drop the flag that took this unset placeholder
      probeArgs.push(filled[i]);
    }
    const probeOut = await safeExec(assertSafeArgs(probeArgs));
    const derived = deriveEventMapping(parseJsonLines(probeOut));
    if (Object.values(derived).some(Boolean)) { eventMapping = derived; sources.eventMapping = SRC.probe; }
  }

  const profile = normalizeRuntimeProfile({
    id: opts.id || bin, label: opts.label || bin, binary: bin,
    argsTemplate, modelsCommand: hasModelsCmd ? ['models'] : [],
    effortValues, effortFlag, resumeFlag, bypassFlag, mcp, eventMapping,
  });
  if (hasModelsCmd) sources.modelsCommand = SRC.help;

  // Layer 4 (opt-in, costs a real-model call): ask the agent to describe itself. Only fills what the
  // observed layers could not derive; every value it supplies stays low-confidence and flagged, so
  // callers/UI can show it and never apply it silently.
  if (opts.askAgent) {
    try {
      const agentProfile = validateAgentProfile(extractJson(await safeExec(assertSafeArgs(askAgentArgs(profile, opts)))) , bin);
      mergeAgentFields(profile, agentProfile, sources);
    } catch { /* the agent could not describe itself; keep the observed layers only */ }
  }

  return { profile, sources, models };
}

// Ask-agent argv: the run command plus the profile request as the prompt (never any approval flags).
function askAgentArgs(profile, opts = {}) {
  const args = [];
  if (profile.argsTemplate.length && !/^\{prompt\}$/.test(profile.argsTemplate[0])) args.push(profile.argsTemplate[0]);
  args.push(opts.askPrompt || AGENT_PROFILE_PROMPT);
  return args;
}

module.exports = { SRC, parseCommands, pickRunCommand, findEffort, findResume, findModelFlag, findFormatFlag, findMcp, findBypassFlag, flatten, deriveEventMapping, parseJsonLines, parseModelsOutput, extractJson, validateAgentProfile, mergeAgentFields, assertSafeArgs, sandboxEnv, makeExec, askAgentArgs, AGENT_PROFILE_PROMPT, introspectRuntime, defaultExec };
