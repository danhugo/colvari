// Runtime adapters: which agent CLI runs a node. Claude keeps its tuned buildArgs; every other CLI
// runs through the generic profile path: the introspector derives a RuntimeProfile from the binary
// itself (no hand-built per-CLI profiles, no CLI-specific parsing), and this module spawns/parses
// purely from that profile data.
const { execFileSync } = require('child_process');
const { buildClaudeArgs, normalizeNode, splitArgs } = require('./agent-config');
const { buildProfileArgs, getPath, writeFileMcpConfig } = require('./profile-runner');
const { introspectRuntime, defaultExec, makeExec } = require('./introspector');

// Derived-profile cache, stamped with the CLI's --version: a binary is introspected once per
// version and reused until it changes (re-derived automatically after an upgrade). Two entries per
// binary: the full one (probe included — needs one real run) for actual runs, and a cheap help-only
// one (key "|help") for capability detection, which must not cost a model call.
const derivedProfiles = new Map(); // cacheKey -> { version, profile }
function deriveRuntimeProfile(bin, { exec, label, probe = true, askAgent = false, env } = {}) {
  const key = probe ? bin : `${bin}|help`;
  const run = exec || (env ? makeExec(env) : defaultExec);
  let version = '';
  try { version = String(run(bin, ['--version']) || '').trim(); } catch { /* binary missing; still try to derive */ }
  const hit = derivedProfiles.get(key);
  if (hit && hit.version === version) return hit.profile;
  const id = String(bin).split(/[\\/]/).pop().replace(/\.(exe|sh)$/i, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  const { profile } = introspectRuntime(bin, run, { id, label: label || id, probe, askAgent });
  derivedProfiles.set(key, { version, profile });
  return profile;
}

// Capabilities claimed straight from the derived profile — honest by construction: true only for
// what the profile actually carries (usage paths, cost path, mcp method, resume flag).
function capabilitiesFromProfile(profile) {
  const em = profile.eventMapping || {};
  return {
    tokens: !!(em.inputPath && em.outputPath),
    cost: !!em.costPath,
    mcp: profile.mcp.method !== 'none',
    resume: !!profile.resumeFlag,
  };
}

// Generic adapter for an introspected CLI: args and event parsing come purely from the derived
// RuntimeProfile. The old hand-built helpycode profile was deleted — helpycode is just the first
// user of this factory. exec/askAgent injectable via opts for tests (askAgent opts into the
// expensive ask-the-agent introspection layer; never on by default).
function profileRuntime(id, label, binFromSettings) {
  const profileFor = (settings, opts = {}) => deriveRuntimeProfile(binFromSettings(settings || {}), { label, exec: opts.exec, probe: opts.probe !== false, askAgent: !!opts.askAgent, env: opts.env });
  return {
    id, label, bin: binFromSettings,
    // help-only derivation: cheap, no probe/model call (used by detectRuntimes)
    capabilities(settings, exec) {
      try { return capabilitiesFromProfile(deriveRuntimeProfile(binFromSettings(settings || {}), { label, exec, probe: false })); }
      catch { return { tokens: false, cost: false, mcp: false, resume: false }; }
    },
    buildArgs(node, prompt, settings, mcp, opts = {}) {
      const n = normalizeNode(node);
      const profile = profileFor(settings, opts);
      if (mcp && profile.mcp.method === 'file' && opts.cwd) writeFileMcpConfig(opts.cwd, profile.mcp.flag, mcp);
      const args = buildProfileArgs(profile, { model: n.model, prompt, variant: n.effort, session: opts.resume });
      args.push(...splitArgs(n.extraArgs));
      return args;
    },
    // Generic JSON-event parsing driven by the profile's eventMapping; wired into the orchestrator
    // via rt.parseEvent (no per-CLI branch there).
    parseEvent(ev, settings, opts = {}) { return parseProfileEvent(ev, profileFor(settings, opts)); },
  };
}

const RUNTIMES = {
  claude: {
    id: 'claude', label: 'Claude Code', bin: (s) => (s && s.claudePath) || 'claude',
    capabilities: { tokens: true, cost: true, mcp: true, resume: true },
    buildArgs: buildClaudeArgs, // parsing stays in the orchestrator (stream-json, unchanged)
  },
  codex: {
    id: 'codex', label: 'Codex', bin: (s) => (s && s.codexPath) || 'codex',
    capabilities: { tokens: true, cost: false, mcp: true, resume: true }, // mcp: board comment_task tested live (codex-cli 0.144)
    buildArgs(node, prompt, settings, mcp, opts = {}) {
      const n = normalizeNode(node);
      const args = ['exec', '--json', '--skip-git-repo-check', ...codexMcpArgs(mcp)];
      if ((n.permissionMode || settings.permissionMode) === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox');
      if (n.model) args.push('-m', n.model);
      args.push(...splitArgs(n.extraArgs));
      if (opts.resume) args.push('resume', String(opts.resume));
      args.push(prompt);
      return args;
    },
    parseEvent: (ev) => parseCodexEvent(ev),
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', bin: (s) => (s && s.opencodePath) || 'opencode',
    capabilities: { tokens: false, cost: false, mcp: false, resume: false }, // stub: not installed here, nothing tested
    buildArgs(node, prompt) { const n = normalizeNode(node); return ['run', ...(n.model ? ['-m', n.model] : []), prompt]; },
  },
  helpycode: profileRuntime('helpycode', 'HelpyCode', (s) => (s && s.helpycodePath) || 'helpycode'),
};
// board MCP server -> codex `-c mcp_servers.<name>.*` overrides (TOML values; JSON strings/arrays are valid TOML)
function codexMcpArgs(mcp) {
  const out = [];
  for (const [name, sv] of Object.entries((mcp && mcp.mcpServers) || {})) {
    const k = 'mcp_servers.' + name;
    out.push('-c', `${k}.command=${JSON.stringify(sv.command)}`, '-c', `${k}.args=${JSON.stringify(sv.args || [])}`);
    for (const [ek, ev] of Object.entries(sv.env || {})) out.push('-c', `${k}.env.${ek}=${JSON.stringify(String(ev))}`);
  }
  return out;
}
const RUNTIME_IDS = Object.keys(RUNTIMES);
// empty -> claude (the default); unknown/typo'd id throws (no silent fallback)
const getRuntime = (id) => { if (!id) return RUNTIMES.claude; if (!RUNTIMES[id]) throw new Error(`unknown runtime "${id}" (expected ${RUNTIME_IDS.join('/')})`); return RUNTIMES[id]; };

// codex exec --json line -> { logs: [[kind, text]], sessionId?, result?, tokens?, done?, failed? }
function parseCodexEvent(ev) {
  const out = { logs: [] };
  if (ev.type === 'thread.started') { out.sessionId = ev.thread_id; out.logs.push(['system', 'codex thread ' + ev.thread_id]); }
  else if (ev.type === 'item.completed' || ev.type === 'item.started') {
    const it = ev.item || {};
    if (it.type === 'mcp_tool_call') out.logs.push(ev.type === 'item.started' ? ['tool', `mcp__${it.server}__${it.tool} ${JSON.stringify(it.arguments || {}).slice(0, 300)}`] : [it.error ? 'tool_error' : 'tool_result', JSON.stringify(it.error || it.result || '').slice(0, 400)]);
    else if (ev.type === 'item.started') { if (it.type === 'command_execution') out.logs.push(['tool', 'shell ' + String(it.command || '').slice(0, 300)]); }
    else if (it.type === 'agent_message') { out.logs.push(['text', it.text || '']); out.result = it.text || ''; }
    else if (it.type === 'reasoning') out.logs.push(['text', it.text || '']);
    else if (it.type === 'command_execution') out.logs.push([it.exit_code ? 'tool_error' : 'tool_result', String(it.aggregated_output || '').slice(0, 400)]);
    else if (it.type === 'error') out.logs.push(['error', it.message || '']);
    else out.logs.push(['tool', `${it.type} ${JSON.stringify(it).slice(0, 300)}`]);
  } else if (ev.type === 'turn.completed') {
    const u = ev.usage || {};
    out.tokens = { inputTokens: u.input_tokens || 0, outputTokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0), cachedInputTokens: u.cached_input_tokens || 0 };
    out.done = true; out.logs.push(['result', `codex turn completed: ${out.tokens.inputTokens} in / ${out.tokens.outputTokens} out`]);
  } else if (ev.type === 'turn.failed') { out.failed = true; out.logs.push(['error', (ev.error && ev.error.message) || 'turn failed']); }
  else if (ev.type === 'error') out.logs.push(['error', ev.message || '']);
  return out;
}

// Generic JSON-event line -> same shape as parseCodexEvent, driven only by the profile's
// eventMapping. Run totals are claimed when a usage-bearing event is seen: either an explicit
// `result`-typed event (claude/helpycode convention) or any event whose mapped input/output/cost
// paths carry numbers (e.g. helpycode's current `step_finish` events). `done` only on such events.
function parseProfileEvent(ev, profile) {
  const out = { logs: [] };
  const em = profile.eventMapping || {};
  const text = getPath(ev, em.textPath);
  if (typeof text === 'string' && text) { out.logs.push(['text', text]); out.result = text; }
  const sessionId = getPath(ev, em.sessionIdPath);
  if (sessionId != null) { out.sessionId = String(sessionId); out.logs.push(['system', `${profile.label} session ${sessionId}`]); }
  if (ev.type === 'error') { out.failed = true; out.logs.push(['error', String(ev.message || 'error')]); }
  const input = Number(getPath(ev, em.inputPath)) || 0;
  const output = Number(getPath(ev, em.outputPath)) || 0;
  const cost = getPath(ev, em.costPath);
  if (ev.type === 'result' || input || output || typeof cost === 'number') {
    const reasoning = Number(getPath(ev, em.reasoningPath)) || 0;
    out.tokens = { inputTokens: input, outputTokens: output + reasoning };
    out.cost = Number(cost) || 0;
    out.done = true;
    out.logs.push(['result', `${profile.label} result: ${input} in / ${output + reasoning} out`]);
  }
  return out;
}

const parseVersion = (s) => { const m = String(s || '').match(/\d+\.\d+(\.\d+)?/); return m ? m[0] : null; };
// Detect each runtime binary + version. exec is injectable for tests.
function detectRuntimes(settings = {}, env = process.env, exec = (b, a) => execFileSync(b, a, { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })) {
  const r = {};
  for (const id of RUNTIME_IDS) {
    const rt = RUNTIMES[id];
    try {
      const v = exec(rt.bin(settings), ['--version']);
      let caps;
      try { caps = typeof rt.capabilities === 'function' ? rt.capabilities(settings, exec) : rt.capabilities; }
      catch { caps = { tokens: false, cost: false, mcp: false, resume: false }; }
      r[id] = { installed: true, version: parseVersion(v) || String(v).trim(), label: rt.label, capabilities: caps };
    } catch (e) {
      const caps = { tokens: false, cost: false, mcp: false, resume: false };
      r[id] = { installed: false, version: null, label: rt.label, capabilities: caps, error: e.code === 'ENOENT' ? 'not installed' : e.message };
    }
  }
  return r;
}

module.exports = { RUNTIMES, codexMcpArgs, RUNTIME_IDS, getRuntime, parseCodexEvent, parseProfileEvent, parseVersion, detectRuntimes, deriveRuntimeProfile, capabilitiesFromProfile, profileRuntime };
