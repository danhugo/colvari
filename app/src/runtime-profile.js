// RuntimeProfile: a persisted, declarative description of an agent CLI, generic enough to run any
// CLI (helpycode, claude, codex, ...) without CLI-specific code paths in the runner. Introspector
// derives a draft profile heuristically; the runner spawns processes purely from profile data.
const MCP_METHODS = ['none', 'json-flag', 'toml-override', 'file'];

// argsTemplate tokens are plain strings; placeholders are substituted verbatim inside a token
// (so "--model={model}" and "{prompt}" both work).
const PROFILE_DEFAULTS = {
  id: '', label: '', binary: '', // resolved binary name/path
  argsTemplate: ['{prompt}'], // e.g. ['run', '--format', 'json', '--model', '{model}', '{prompt}']
  modelsCommand: [], // args to list models, e.g. ['models'] ; [] = unsupported
  effortValues: [], // supported effort level names, in the CLI's own vocabulary
  effortFlag: '', // e.g. '--effort' ; '' = unsupported
  resumeFlag: '', // e.g. '--resume' or 'resume' (bare token before session id); '' = unsupported
  bypassFlag: '', // e.g. '--dangerously-skip-permissions' ; '' = unsupported. Applied at run time ONLY when the node's effective permission mode is bypassPermissions — never during introspection.
  mcp: { method: 'none', flag: '' }, // method: none | json-flag (flag takes JSON.stringify(mcpConfig)) | toml-override
  // eventMapping: dotted paths (relative to each parsed JSON event) used to pull fields out.
  // Missing paths are simply skipped for that event.
  eventMapping: {
    textPath: '', sessionIdPath: '', costPath: '',
    inputPath: '', outputPath: '', reasoningPath: '', cachePath: '',
  },
};

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const toStrArray = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);

function normalizeMcp(mcp) {
  const m = isPlainObject(mcp) ? mcp : {};
  const method = MCP_METHODS.includes(m.method) ? m.method : 'none';
  if (method === 'json-flag') return { method, flag: String(m.flag || '--mcp-config') };
  if (method === 'file') return { method, flag: String(m.flag || 'helpycode.json') }; // flag doubles as the config filename, written to cwd
  return { method, flag: String(m.flag || '') };
}

function normalizeEventMapping(em) {
  const m = isPlainObject(em) ? em : {};
  const out = {};
  for (const k of Object.keys(PROFILE_DEFAULTS.eventMapping)) out[k] = String(m[k] || '');
  return out;
}

// Fill in defaults, coerce types; unknown fields are dropped. Throws on an unusable profile (no binary).
function normalizeRuntimeProfile(p = {}) {
  const r = { ...PROFILE_DEFAULTS, ...p };
  r.id = String(p.id || '').trim();
  r.label = String(p.label || r.id || r.binary || 'Runtime');
  r.binary = String(p.binary || '').trim();
  if (!r.binary) throw new Error('runtime profile requires a binary');
  r.argsTemplate = toStrArray(p.argsTemplate ?? PROFILE_DEFAULTS.argsTemplate);
  r.modelsCommand = toStrArray(p.modelsCommand);
  r.effortValues = toStrArray(p.effortValues);
  r.effortFlag = String(p.effortFlag || '');
  r.resumeFlag = String(p.resumeFlag || '');
  r.bypassFlag = String(p.bypassFlag || '');
  r.mcp = normalizeMcp(p.mcp);
  r.eventMapping = normalizeEventMapping(p.eventMapping);
  return r;
}

// Substitute {model} {prompt} {variant} {session} inside every arg token.
function fillArgsTemplate(template, vars = {}) {
  const sub = (s) => s.replace(/\{(model|prompt|variant|session)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  return template.map(sub);
}

module.exports = { PROFILE_DEFAULTS, MCP_METHODS, normalizeRuntimeProfile, fillArgsTemplate };
