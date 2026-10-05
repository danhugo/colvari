// Runtime adapters: which agent CLI runs a node. Claude keeps its tuned buildArgs; every other CLI
// runs through the generic profile path: the introspector derives a RuntimeProfile from the binary
// itself (no hand-built per-CLI profiles, no CLI-specific parsing), and this module spawns/parses
// purely from that profile data.
const { buildClaudeArgs, normalizeNode, splitArgs } = require('./agent-config');
const { buildProfileArgs, writePerRunMcpConfig, binConfigEnvKey, getPath } = require('./profile-runner');
const { introspectRuntime, defaultExec, makeExec } = require('./introspector');
const { isSubagentTool } = require('./subagents');

// Derived-profile cache, stamped with the CLI's --version: a binary is introspected once per
// version and reused until it changes (re-derived automatically after an upgrade). Two entries per
// binary: the full one (probe included — needs one real run) for actual runs, and a cheap help-only
// one (key "|help") for capability detection, which must not cost a model call.
// Async since t_5a78aa95: derivation spawns (--version/--help/models/probe) and used to block the
// main process for seconds at dispatch time. Sync fakes injected by tests keep working under await.
const derivedProfiles = new Map(); // cacheKey -> { version, profile }
async function deriveRuntimeProfile(bin, { exec, label, probe = true, askAgent = false, env } = {}) {
  const key = probe ? bin : `${bin}|help`;
  const run = exec || (env ? makeExec(env) : defaultExec);
  let version = '';
  try { version = String((await run(bin, ['--version'])) || '').trim(); } catch { /* binary missing; still try to derive */ }
  const hit = derivedProfiles.get(key);
  if (hit && hit.version === version) return hit.profile;
  const id = String(bin).split(/[\\/]/).pop().replace(/\.(exe|sh)$/i, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  const { profile } = await introspectRuntime(bin, run, { id, label: label || id, probe, askAgent });
  // Binary not found (e.g. packaged app launched from Finder with a minimal PATH): do not cache the
  // empty profile, or it would stick for the whole session. Re-derives next call (cheap: no run).
  if (version) derivedProfiles.set(key, { version, profile });
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
  const profileFor = async (settings, opts = {}) => deriveRuntimeProfile(binFromSettings(settings || {}), { label, exec: opts.exec, probe: opts.probe !== false, askAgent: !!opts.askAgent, env: opts.env });
  return {
    id, label, bin: binFromSettings,
    // help-only derivation: cheap, no probe/model call (used by detectRuntimes)
    async capabilities(settings, exec) {
      try { return capabilitiesFromProfile(await deriveRuntimeProfile(binFromSettings(settings || {}), { label, exec, probe: false })); }
      catch { return { tokens: false, cost: false, mcp: false, resume: false }; }
    },
    async buildArgs(node, prompt, settings, mcp, opts = {}) {
      const n = normalizeNode(node);
      const profile = await profileFor(settings, opts);
      if (mcp && mcp.mcpServers && Object.keys(mcp.mcpServers).length && profile.mcp.method === 'file') {
        // One config per run in a fresh temp dir, delivered via <BIN>_CONFIG (opencode-style). Writing
        // it into a shared cwd made concurrent agents overwrite each other's board identity ("task not
        // visible"); without an env to carry the per-run path there is no safe way to inject it at all.
        const bin = binFromSettings(settings || {});
        if (!opts.env) throw new Error(`${label}: file-method MCP needs opts.env (per-run config via ${binConfigEnvKey(bin)})`);
        writePerRunMcpConfig(bin, profile.mcp.flag, mcp, opts.env);
      }
      // Same effective-mode rule as buildClaudeArgs: unset falls through to bypassPermissions.
      // Without the derived bypass flag, non-interactive profile-runtime runs auto-reject permission
      // asks (e.g. helpycode's external_directory) and the agent cannot reach the paths it needs.
      const bypass = (n.permissionMode || (settings || {}).permissionMode || 'bypassPermissions') === 'bypassPermissions';
      const args = buildProfileArgs(profile, { model: n.model, prompt, variant: n.effort, session: opts.resume, bypass });
      args.push(...splitArgs(n.extraArgs));
      // opencode-style CLIs realpath() positional messages: a prompt longer than a path segment dies
      // with ENAMETOOLONG. Long prompts go over stdin instead (they read it when it is not a TTY);
      // spawnRun pipes args.stdin into the child.
      const at = args.lastIndexOf(prompt);
      if (typeof prompt === 'string' && prompt.length > 200 && at > 0) { args.splice(at, 1); args.stdin = prompt; }
      return args;
    },
    // Generic JSON-event parsing driven by the profile's eventMapping; wired into the orchestrator
    // via rt.parseEvent (no per-CLI branch there). Must stay sync (hot per-event path): it reads the
    // profile derived and cached by the buildArgs run that spawned this stream — events never arrive
    // before their run's buildArgs. No cached profile (parse without a derived run): a loud error
    // event instead of a blocking derive on the stream path.
    parseEvent(ev, settings, opts = {}) {
      const bin = binFromSettings(settings || {});
      const hit = derivedProfiles.get(bin);
      if (!hit || !hit.profile) return { logs: [['error', `${label}: runtime profile not derived yet (run buildArgs first) — event dropped`]] };
      return parseProfileEvent(ev, hit.profile);
    },
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
    // cached_input_tokens -> cacheReadTokens (absent -> null downstream: unknown, not 0; no CLI reports cache writes here)
    out.tokens = { inputTokens: u.input_tokens || 0, outputTokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0), ...(u.cached_input_tokens != null ? { cacheReadTokens: u.cached_input_tokens } : {}) };
    out.done = true; out.logs.push(['result', `codex turn completed: ${out.tokens.inputTokens} in / ${out.tokens.outputTokens} out`]);
  } else if (ev.type === 'turn.failed') { out.failed = true; out.logs.push(['error', (ev.error && ev.error.message) || 'turn failed']); }
  else if (ev.type === 'error') out.logs.push(['error', ev.message || '']);
  return out;
}

// Generic JSON-event line -> same shape as parseCodexEvent, driven only by the profile's
// eventMapping. Run totals are claimed when a usage-bearing event is seen: either an explicit
// `result`-typed event (claude/helpycode convention) or any event whose mapped input/output/cost
// paths carry numbers (e.g. helpycode's current `step_finish` events). `done` only on such events.
// opencode-derived CLIs (helpycode 0.3.5, captured live) also stream tool activity as
// {type:'tool_use', part:{type:'tool', tool, state:{status:'pending'|'running'|'completed'|'error',
// input, output, metadata:{exit}}}} — the part is re-emitted per state change, but a fast tool may
// only ever surface as 'completed'. Their step_finish carries that step's usage; only
// part.reason === 'stop' ends the turn, so intermediate steps log a `system` step line and stay
// not-done. This stdout stream is the only live feed used — helpycode's own log files rotate
// quickly, so they are not a readable fallback for activity.
function parseProfileEvent(ev, profile) {
  const out = { logs: [] };
  const em = profile.eventMapping || {};
  const part = ev.part || {};
  if (ev.type === 'tool_use' && part.type === 'tool') {
    const st = part.state || {};
    const name = part.tool || 'tool';
    if (st.status === 'pending' || st.status === 'running') out.logs.push(['tool', `${name} ${JSON.stringify(st.input || {}).slice(0, 300)}`]);
    else {
      const exit = st.metadata ? st.metadata.exit : undefined;
      const kind = st.status === 'error' || (Number.isFinite(exit) && exit !== 0) ? 'tool_error' : 'tool_result';
      out.logs.push([kind, `${name}: ${String(st.output ?? st.error ?? '').slice(0, 400)}`]);
    }
    // Task/Agent tool: a subagent spawn. helpycode 0.3.5 (captured live) surfaces the whole spawn as ONE
    // completed 'task' part — pending/running -> start, completed/error -> end; input carries
    // {description, prompt, subagent_type}, and the answer "<task id=\"ses_…\" state=…>" holds the child
    // session id (the child's own events never stream on this stdout, hence tokens stay null here).
    if (isSubagentTool(name)) {
      const done = st.status === 'completed' || st.status === 'error';
      out.subagent = {
        toolUseId: part.callID || part.id || name,
        phase: done ? 'end' : 'start',
        status: st.status === 'error' ? 'failed' : done ? 'completed' : 'running',
        toolName: name,
        type: String(name).toLowerCase(),
        description: (st.input && (st.input.description || st.input.subagent_type)) || '',
        prompt: (st.input && st.input.prompt) || '',
        startedAt: (st.time && st.time.start) || ev.timestamp,
        ...(done ? { endedAt: (st.time && st.time.end) || ev.timestamp } : {}),
        childSessionId: (String(st.output || '').match(/<task id="([^"]+)"/) || [])[1] || undefined,
      };
    }
    return out;
  }
  // opencode-style subtask part (unverified shape — start only; ends derive from a later part/event).
  if (part.type === 'subtask') {
    out.logs.push(['tool', `subtask ${String(part.description || part.prompt || '').slice(0, 280)}`]);
    out.subagent = {
      toolUseId: part.callID || part.id,
      phase: 'start',
      status: 'running',
      toolName: 'subtask',
      type: 'subtask',
      description: part.description || '',
      prompt: part.prompt || '',
      startedAt: ev.timestamp,
    };
    return out;
  }
  const text = getPath(ev, em.textPath);
  // Fail loud: a text event with no textPath means the profile derivation failed; never drop silently.
  if (!em.textPath && (ev.type === 'text' || part.type === 'text')) out.logs.push(['error', `${profile.label}: runtime profile has no textPath (introspection failed; is "${profile.binary}" on PATH?). Reply text dropped.`]);
  if (typeof text === 'string' && text) { out.logs.push(['text', text]); out.result = text; }
  const sessionId = getPath(ev, em.sessionIdPath);
  // opencode-derived CLIs put the session id on every event: capture it silently, log only a
  // dedicated session-type event (a line per event would flood the live log).
  if (sessionId != null) { out.sessionId = String(sessionId); if (ev.type === 'session') out.logs.push(['system', `${profile.label} session ${sessionId}`]); }
  if (ev.type === 'error') { out.failed = true; out.logs.push(['error', String(ev.message || 'error')]); }
  const input = Number(getPath(ev, em.inputPath)) || 0;
  const output = Number(getPath(ev, em.outputPath)) || 0;
  const cost = getPath(ev, em.costPath);
  if (ev.type === 'result' || input || output || typeof cost === 'number') {
    const reasoning = Number(getPath(ev, em.reasoningPath)) || 0;
    const cacheRaw = getPath(ev, em.cachePath); const cache = Number(cacheRaw);
    out.tokens = { inputTokens: input, outputTokens: output + reasoning, ...(cacheRaw != null && Number.isFinite(cache) ? { cacheReadTokens: cache } : {}) };
    out.cost = Number(cost) || 0;
    out.done = ev.type !== 'step_finish' || part.reason === 'stop';
    out.logs.push([out.done ? 'result' : 'system', `${profile.label} ${out.done ? 'result' : 'step'}: ${input} in / ${output + reasoning} out`]);
  }
  return out;
}

const parseVersion = (s) => { const m = String(s || '').match(/\d+\.\d+(\.\d+)?/); return m ? m[0] : null; };
// Detect each runtime binary + version. exec is injectable for tests; the default probe is async
// (t_5a78aa95 — the old default execFileSync froze the booting main process ~10s/runtime) and
// detectRuntimes itself is awaited through one shared promise per app start (main.js).
async function detectRuntimes(settings = {}, env = process.env, exec = async (b, a) => { const CP = require('./cp'); return CP.runThrow(b, a, { env, timeoutMs: 10000 }); }) {
  const r = {};
  for (const id of RUNTIME_IDS) {
    const rt = RUNTIMES[id];
    try {
      const v = await exec(rt.bin(settings), ['--version']);
      let caps;
      try { caps = typeof rt.capabilities === 'function' ? await rt.capabilities(settings, exec) : rt.capabilities; }
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
