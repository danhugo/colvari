// Generic profile-driven runner: spawns a node process from a RuntimeProfile (no CLI-specific code),
// parses newline-delimited JSON stdout via the profile's eventMapping, and feeds usage into a
// usage.js-shaped run record. Supports resume, effort ("variant"), and board MCP injection.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRuntimeProfile, fillArgsTemplate } = require('./runtime-profile');
const { newRun } = require('./usage');

const getPath = (obj, path) => {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
};

// Event-mapping paths may pin an event type: "message_end:message.usage.input" reads that path only
// off events whose own `type` is message_end — a CLI that repeats the same usage on turn_end /
// agent_end (pi 0.73.1) would otherwise double-count every total. A bare path reads every event, as
// before. applyProfileEvent and parseProfileEvent both go through here, so hand-written profiles
// get the same filter as derived ones.
function getPathTyped(obj, spec) {
  const s = String(spec || '');
  const c = s.indexOf(':');
  if (c === -1) return getPath(obj, s);
  if (!obj || obj.type !== s.slice(0, c)) return undefined;
  return getPath(obj, s.slice(c + 1));
}

// board MCP server -> `<flag> mcp_servers.<name>.<key>=<json-value>` style overrides (codex-compatible).
function tomlMcpArgs(flag, mcpConfig) {
  const out = [];
  for (const [name, sv] of Object.entries((mcpConfig && mcpConfig.mcpServers) || {})) {
    const base = 'mcp_servers.' + name;
    out.push(flag, `${base}.command=${JSON.stringify(sv.command)}`, flag, `${base}.args=${JSON.stringify(sv.args || [])}`);
    for (const [ek, ev] of Object.entries(sv.env || {})) out.push(flag, `${base}.env.${ek}=${JSON.stringify(String(ev))}`);
  }
  return out;
}

function mcpArgs(profile, mcpConfig) {
  if (!mcpConfig || profile.mcp.method === 'none') return [];
  if (profile.mcp.method === 'json-flag') return [profile.mcp.flag, JSON.stringify(mcpConfig)];
  if (profile.mcp.method === 'toml-override') return tomlMcpArgs(profile.mcp.flag, mcpConfig);
  return []; // 'file': written to cwd by writeFileMcpConfig, not passed as an arg
}

// board MCP server -> a project-local config file (e.g. helpycode's <cwd>/helpycode.json), the shape
// an opencode-derived CLI expects: { mcp: { <name>: { type: 'local', command: [bin, ...args], enabled } } }.
// extra (optional) merges additional top-level config sections into the same file — e.g. a provider
// profile (runtimes.js perRunProviderConfig). Its values carry env NAMES only ({env:KEY}), never keys.
function writeFileMcpConfig(cwd, filename, mcpConfig, extra) {
  const mcp = {};
  for (const [name, sv] of Object.entries((mcpConfig && mcpConfig.mcpServers) || {})) {
    mcp[name] = { type: 'local', command: [sv.command, ...(sv.args || [])], enabled: true };
    if (sv.env && Object.keys(sv.env).length) mcp[name].environment = sv.env;
  }
  const cfg = { $schema: 'https://opencode.ai/config.json', mcp };
  if (extra && typeof extra === 'object') Object.assign(cfg, extra);
  fs.writeFileSync(path.join(cwd, filename), JSON.stringify(cfg, null, 2));
}

// <BIN>_CONFIG env var (opencode-style, e.g. HELPYCODE_CONFIG) that points the CLI at a config file.
function binConfigEnvKey(bin) {
  return String(bin).split('/').pop().toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_CONFIG';
}

// Board MCP config for ONE run: written to a fresh temp dir — never the shared cwd, where concurrent
// dispatches overwrite each other's --node binding and sessions lazily bind to the wrong node — and
// passed to the CLI via <BIN>_CONFIG in env (mutated in place when provided). The dir is removed
// when the run's child exits (removePerRunMcpDirs from the run's close path); the exit hook only
// backstops dirs whose owning process died first (t_8170a988). The CLI reads the config at startup,
// so removal after exit is safe.
const perRunMcpDirs = new Map(); // env object -> dir written for it
process.on('exit', () => { for (const d of perRunMcpDirs.values()) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function removePerRunMcpDirs(env) {
  const dir = perRunMcpDirs.get(env);
  if (!dir) return;
  perRunMcpDirs.delete(env);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function writePerRunMcpConfig(bin, filename, mcpConfig, env, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-squad-mcp-'));
  writeFileMcpConfig(dir, filename, mcpConfig, extra);
  const cfgPath = path.join(dir, filename);
  if (env) { env[binConfigEnvKey(bin)] = cfgPath; perRunMcpDirs.set(env, dir); }
  return cfgPath;
}

// Build the full argv (after the binary) for one run.
function buildProfileArgs(profile, { model, prompt, variant, session, bypass, mcpConfig } = {}) {
  const p = normalizeRuntimeProfile(profile);
  if (variant && p.effortValues.length && !p.effortValues.includes(variant)) throw new Error(`unknown effort "${variant}" for ${p.label} (expected ${p.effortValues.join('/')})`);
  const args = fillArgsTemplate(p.argsTemplate, { model, prompt, variant, session });
  // Only on an explicit opt-in (the node's effective permission mode): never during introspection.
  if (bypass && p.bypassFlag) args.splice(1, 0, p.bypassFlag); // right after the run subcommand
  if (session && p.resumeFlag) {
    const resumeTokens = p.resumeFlag.startsWith('-') ? [p.resumeFlag, session] : [p.resumeFlag, session];
    args.splice(1, 0, ...resumeTokens); // right after the run subcommand (args[0])
  }
  args.push(...mcpArgs(p, mcpConfig));
  return args;
}

// Apply one parsed JSON event to a run accumulator using the profile's eventMapping. Paths may pin
// an event type ("message_end:...") — see getPathTyped.
function applyProfileEvent(run, ev, mapping) {
  const text = getPathTyped(ev, mapping.textPath);
  if (typeof text === 'string' && text) { run.result = (run.result || '') + text; }
  const sessionId = getPathTyped(ev, mapping.sessionIdPath);
  if (sessionId != null) run.sessionId = String(sessionId);
  const cost = getPathTyped(ev, mapping.costPath);
  if (typeof cost === 'number') run.reportedCostUsd += cost;
  const input = getPathTyped(ev, mapping.inputPath); if (typeof input === 'number') run.inputTokens += input;
  const output = getPathTyped(ev, mapping.outputPath); if (typeof output === 'number') run.outputTokens += output;
  const reasoning = getPathTyped(ev, mapping.reasoningPath); if (typeof reasoning === 'number') run.reasoningTokens += reasoning;
  const cache = getPathTyped(ev, mapping.cachePath); if (typeof cache === 'number') run.cacheReadTokens += cache;
  return run;
}

// spawnFn is injectable for tests; defaults to child_process.spawn.
function runProfile(profile, opts = {}, spawnFn = spawn) {
  const p = normalizeRuntimeProfile(profile);
  const childEnv = { ...(opts.env || process.env) }; // private copy: never mutate process.env
  if (opts.mcpConfig && p.mcp.method === 'file') writePerRunMcpConfig(p.binary, p.mcp.flag, opts.mcpConfig, childEnv);
  const args = buildProfileArgs(p, opts);
  const run = { ...newRun({ model: opts.model || '' }), reasoningTokens: 0 };
  const startedMs = Date.now();
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn(p.binary, args, { cwd: opts.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { removePerRunMcpDirs(childEnv); reject(e); return; }
    let buf = ''; let stderr = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        applyProfileEvent(run, ev, p.eventMapping);
        if (opts.onEvent) opts.onEvent(ev, run);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      removePerRunMcpDirs(childEnv); // config was read at child startup; the run's temp dir is done
      if (buf.trim()) { try { const ev = JSON.parse(buf.trim()); applyProfileEvent(run, ev, p.eventMapping); if (opts.onEvent) opts.onEvent(ev, run); } catch { /* trailing partial line */ } }
      run.exitCode = code; run.endedAt = new Date().toISOString(); run.durationMs = Date.now() - startedMs;
      run.isError = code !== 0; run.stderr = stderr;
      resolve(run);
    });
  });
}

module.exports = { buildProfileArgs, applyProfileEvent, runProfile, mcpArgs, writeFileMcpConfig, writePerRunMcpConfig, removePerRunMcpDirs, binConfigEnvKey, getPath, getPathTyped };
