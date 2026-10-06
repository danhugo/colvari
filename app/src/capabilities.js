// Capability discovery: probe a runtime's own CLI (no hard-coded per-runtime lists) to find what it actually
// supports on this machine right now — slash commands, skills, modes — so the UI never has to guess or drift
// from what the installed CLI version really offers. Results are cached on the node (capabilities /
// capabilitiesProbedAt) by the caller and refreshed on demand.
const { spawn } = require('child_process'); // probeInitEvent streams via spawn (already async)
const fs = require('fs');
const path = require('path');

// Pull plausible "slash commands" (/foo) and bare subcommand-looking tokens out of free-form --help text.
function parseHelpText(text) {
  const s = String(text || '');
  const slashCommands = [...new Set((s.match(/\/[a-zA-Z][\w-]*/g) || []))];
  const commands = [...new Set([...s.matchAll(/^\s{0,4}([a-z][\w-]{1,30})\s{2,}\S/gm)].map((m) => m[1]))];
  return { slashCommands, commands };
}

// Modes are derived only from what the CLI actually reports (slash commands / --help text), not a constant
// injected list — a runtime that never mentions goal/loop/workflow shows no such modes.
function detectAppModes(helpText = '', slashCommands = []) {
  const cmds = (slashCommands || []).map((c) => String(c).toLowerCase());
  const found = new Set();
  if (cmds.includes('/goal')) found.add('goal');
  if (cmds.includes('/loop')) found.add('loop');
  // Workflow mode runs any user-chosen slash command / skill as the first prompt, so it's exposed whenever the
  // runtime has a workflow-flavored slash command of its own (e.g. this repo's /workflow, or plugins like
  // "beads:workflow") — not gated on one exact literal the way goal/loop's own dedicated commands are.
  if (cmds.some((c) => c.includes('workflow'))) found.add('workflow');
  return [...found];
}

// One level of skill/command definitions from a single "<root>/.claude"-style directory
// (skills/<name>/SKILL.md dirs, commands/<name>.md files). Never throws; missing dirs just yield [].
function scanClaudeDir(root) {
  const skills = [], commands = [];
  try {
    const skillsDir = path.join(root, 'skills');
    for (const name of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (name.isDirectory()) skills.push(name.name);
    }
  } catch {}
  try {
    const cmdDir = path.join(root, 'commands');
    for (const name of fs.readdirSync(cmdDir, { withFileTypes: true })) {
      if (name.isFile() && name.name.endsWith('.md')) commands.push('/' + name.name.replace(/\.md$/, ''));
    }
  } catch {}
  return { skills, commands };
}

// Installed-plugin install paths (each its own "<installPath>/skills", "<installPath>/commands" tree):
// marketplace-installed plugins from ~/.claude/plugins/installed_plugins.json, plus org/team plugins synced
// straight into ~/.claude/plugins/synced/<sync-id>/<plugin-name> (no manifest entry of their own). Never throws.
function installedPluginRoots(home) {
  const roots = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const entries of Object.values(manifest.plugins || {})) {
      for (const e of (Array.isArray(entries) ? entries : [])) if (e && e.installPath) roots.push(e.installPath);
    }
  } catch {}
  try {
    const syncedDir = path.join(home, '.claude', 'plugins', 'synced');
    for (const syncId of fs.readdirSync(syncedDir, { withFileTypes: true })) {
      if (!syncId.isDirectory()) continue;
      const syncRoot = path.join(syncedDir, syncId.name);
      for (const plugin of fs.readdirSync(syncRoot, { withFileTypes: true })) {
        if (plugin.isDirectory()) roots.push(path.join(syncRoot, plugin.name));
      }
    }
  } catch {}
  return roots;
}

// Read skill/command definitions (Claude Code style: .claude/skills/<name>/SKILL.md, .claude/commands/<name>.md)
// from every source Claude Code itself resolves them from, so Refresh (no live CLI session) reports the same
// skills/commands the initial scan saw from a live session: the project's own .claude, the user's ~/.claude,
// and every installed plugin's own skills/commands tree (from ~/.claude/plugins/installed_plugins.json).
function scanLocalPlugins(cwd, { home } = {}) {
  const skills = [], commands = [];
  home = home || require('os').homedir();
  const roots = [cwd].filter(Boolean).map((d) => path.join(d, '.claude'));
  roots.push(path.join(home, '.claude'));
  roots.push(...installedPluginRoots(home));
  for (const root of roots) {
    const found = scanClaudeDir(root);
    skills.push(...found.skills); commands.push(...found.commands);
  }
  return { skills: [...new Set(skills)], commands: [...new Set(commands)] };
}

// Group discovered names into the four categories the UI shows: mode (run modes like goal/loop/workflow),
// skill (Claude Code skills / Codex-style plugins), command (slash commands), mcp (configured MCP servers).
function categorize({ modes = [], skills = [], slashCommands = [], commands = [], mcpServers = [] } = {}) {
  const cat = [];
  for (const m of modes) cat.push({ name: m, category: 'mode' });
  for (const s of skills) cat.push({ name: s, category: 'skill' });
  for (const s of slashCommands) cat.push({ name: s, category: 'command' });
  for (const c of commands) cat.push({ name: c, category: 'command' });
  for (const m of mcpServers) cat.push({ name: m, category: 'mcp' });
  return cat;
}

// One runtime binary --help probe. exec is injectable for tests; both exec and probeHelp are async
// since t_5a78aa95 (the old execFileSync blocked the main process up to 10s per probe).
async function probeHelp(bin, args = ['--help'], exec = async (b, a) => { const CP = require('./cp'); return CP.runThrow(b, a, { encoding: 'utf8', timeoutMs: 10000 }); }) {
  const probedAt = new Date().toISOString();
  try {
    const out = await exec(bin, args);
    return { ok: true, probedAt, helpText: String(out || ''), ...parseHelpText(out) };
  } catch (e) {
    try { const out = e.stdout ? String(e.stdout) : ''; if (out) return { ok: true, probedAt, helpText: out, ...parseHelpText(out) }; } catch {}
    return { ok: false, probedAt, error: e.code === 'ENOENT' ? 'not installed' : e.message, slashCommands: [], commands: [] };
  }
}

// Fold an init event (claude/codex --output-format json "system"/"init" style) into the same shape, when a live
// run already gave us one — richer than --help since it can list the session's actual available slash commands.
function fromInitEvent(ev = {}) {
  const slashCommands = Array.isArray(ev.slash_commands) ? ev.slash_commands.map((c) => (String(c).startsWith('/') ? String(c) : '/' + c)) : [];
  const skills = Array.isArray(ev.skills) ? ev.skills.map(String) : (Array.isArray(ev.agents) ? ev.agents.map(String) : []);
  const modes = Array.isArray(ev.permission_modes) ? ev.permission_modes.map(String) : [];
  return { ok: true, probedAt: new Date().toISOString(), source: 'init-event', slashCommands, skills, modes };
}

// Probe one runtime adapter (from ./runtimes RUNTIMES[id]) for this project's settings. Merges a live init
// event's data over the --help probe when available (init events are more accurate but only exist after a run).
async function discoverCapabilities(rt, settings = {}, { exec, initEvent, cwd, home, prevSlashCommands } = {}) {
  const help = await probeHelp(rt.bin(settings), ['--help'], exec);
  const local = scanLocalPlugins(cwd || settings.workdir || process.cwd(), { home });
  const skills = [...new Set(local.skills)];
  const mcpServers = Object.keys((settings.mcpServers && typeof settings.mcpServers === 'object') ? settings.mcpServers : {});
  // A --help-only probe (manual Refresh) can miss slash commands a prior real probe already saw (transient CLI
  // hiccup, --help omitting them, etc). Union in the runtime's previously observed real slash-command list so a
  // weaker probe this time doesn't blank out modes (goal/loop) it already knows are real. Ignored once an
  // initEvent is present below — that's the CLI's own authoritative report and replaces this as-is.
  let base = {
    runtime: rt.id,
    slashCommands: [...new Set([...(help.slashCommands || []), ...local.commands, ...(prevSlashCommands || [])])],
    commands: help.commands || [],
    skills, modes: [], ok: help.ok, error: help.error, probedAt: help.probedAt,
  };
  if (initEvent) {
    // A live init event is the CLI's own authoritative report of what this session actually has — use its
    // slash_commands/skills as-is rather than unioning with the (possibly stale/unrelated) --help/local scan.
    const fromInit = fromInitEvent(initEvent);
    base = { ...base, ...fromInit };
  }
  // Modes shown in the categorized view are the slash commands that actually look like goal/loop run modes,
  // plus any permission_modes the CLI reported — never a constant injected app-modes list.
  const appModes = [...new Set([...detectAppModes(help.helpText, base.slashCommands), ...base.modes])];
  base.categorized = categorize({ modes: appModes, skills: base.skills, slashCommands: base.slashCommands, mcpServers });
  return base;
}

// Refresh with no prior snapshot at all has nothing to merge over the --help probe, so it falls back to one
// cheap live probe of the CLI itself (`claude -p --output-format stream-json --verbose`): a trivial prompt just
// to capture a real system/init event (slash_commands, skills) and, if the CLI reports it before exiting, a
// rate_limit_event (rate_limit_info.unifiedWindows). Never throws; a spawn/parse failure just yields nulls.
function probeInitEvent(bin, { cwd, env, timeoutMs = 30000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let init = null, rateLimit = null, buf = '', done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGTERM'); } catch {} resolve({ init, rateLimit }); };
    let child;
    try { child = spawnFn(bin, ['-p', 'ok', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve({ init: null, rateLimit: null }); }
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') init = ev;
        else if (ev.type === 'rate_limit_event') rateLimit = ev;
        if (init && rateLimit) return finish();
      }
    });
    child.on('error', finish); child.on('close', finish);
  });
}

const TTL_MS = 24 * 60 * 60 * 1000; // re-probe at least once a day even with no signature change

// A stable signature of "what would change the probe result": runtime, CLI version, model, provider/billing mode.
// Recomputed by the caller (orchestrator) on every run so a version bump or model switch triggers a re-probe.
function capabilitySignature({ runtime, version, model, provider } = {}) {
  return [runtime || '', version || '', model || '', provider || ''].join('|');
}

// Whether a node's cached capabilities are stale: never probed, past TTL, or runtime/version/model/provider changed.
function needsReprobe(node = {}, signature, { ttlMs = TTL_MS, now = Date.now() } = {}) {
  if (!node.capabilities || !node.capabilitiesProbedAt) return true;
  if (node.capabilitiesSignature !== signature) return true;
  const age = now - new Date(node.capabilitiesProbedAt).getTime();
  return !(age >= 0 && age < ttlMs);
}

// Whether a node has never been probed at all ("Not probed yet" in the UI) — the narrower check used for the
// startup/agent-load sweep, as opposed to needsReprobe's broader staleness check (TTL, signature change) which
// only matters once a node already has a first probe on record.
const needsInitialProbe = (node = {}) => !node.capabilities;

// A manual Refresh only ever does a --help-only probe (discoverCapabilities without an initEvent), which is
// strictly narrower than a live init event's real slash_commands/skills (e.g. 123 commands / 58 skills vs a
// handful of --help-parsed ones). Never let that narrower probe overwrite an already-richer snapshot just
// because this particular refresh didn't see everything the CLI reported before.
function mergeCapabilities(prev, next) {
  if (!prev || !Array.isArray(prev.categorized)) return next;
  if (!next || !Array.isArray(next.categorized)) return prev;
  return next.categorized.length >= prev.categorized.length ? next : prev;
}

module.exports = { parseHelpText, probeHelp, fromInitEvent, discoverCapabilities, capabilitySignature, needsReprobe, needsInitialProbe, mergeCapabilities, detectAppModes, scanLocalPlugins, scanClaudeDir, installedPluginRoots, categorize, probeInitEvent, TTL_MS };
