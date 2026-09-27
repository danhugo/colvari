// Runtime adapters: which agent CLI runs a node. Each adapter builds args, parses one stdout JSON line into
// normalized log entries, and declares honest capabilities (true only for what was tested live on this machine).
const { execFileSync } = require('child_process');
const { buildClaudeArgs, normalizeNode, splitArgs } = require('./agent-config');

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
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', bin: (s) => (s && s.opencodePath) || 'opencode',
    capabilities: { tokens: false, cost: false, mcp: false, resume: false }, // stub: not installed here, nothing tested
    buildArgs(node, prompt) { const n = normalizeNode(node); return ['run', ...(n.model ? ['-m', n.model] : []), prompt]; },
  },
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
const getRuntime = (id) => RUNTIMES[id] || RUNTIMES.claude;

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

const parseVersion = (s) => { const m = String(s || '').match(/\d+\.\d+(\.\d+)?/); return m ? m[0] : null; };
// Detect each runtime binary + version. exec is injectable for tests.
function detectRuntimes(settings = {}, env = process.env, exec = (b, a) => execFileSync(b, a, { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })) {
  const r = {};
  for (const id of RUNTIME_IDS) {
    const rt = RUNTIMES[id];
    try { const v = exec(rt.bin(settings), ['--version']); r[id] = { installed: true, version: parseVersion(v) || String(v).trim(), label: rt.label, capabilities: rt.capabilities }; }
    catch (e) { r[id] = { installed: false, version: null, label: rt.label, capabilities: rt.capabilities, error: e.code === 'ENOENT' ? 'not installed' : e.message }; }
  }
  return r;
}

module.exports = { RUNTIMES, codexMcpArgs, RUNTIME_IDS, getRuntime, parseCodexEvent, parseVersion, detectRuntimes };
