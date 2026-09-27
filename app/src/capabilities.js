// Capability discovery: probe a runtime's own CLI (no hard-coded per-runtime lists) to find what it actually
// supports on this machine right now — slash commands, skills, modes — so the UI never has to guess or drift
// from what the installed CLI version really offers. Results are cached on the node (capabilities /
// capabilitiesProbedAt) by the caller and refreshed on demand.
const { execFileSync } = require('child_process');

// Pull plausible "slash commands" (/foo) and bare subcommand-looking tokens out of free-form --help text.
function parseHelpText(text) {
  const s = String(text || '');
  const slashCommands = [...new Set((s.match(/\/[a-zA-Z][\w-]*/g) || []))];
  const commands = [...new Set([...s.matchAll(/^\s{0,4}([a-z][\w-]{1,30})\s{2,}\S/gm)].map((m) => m[1]))];
  return { slashCommands, commands };
}

// One runtime binary --help probe. exec is injectable for tests. Returns { ok, probedAt, ... } — never throws.
function probeHelp(bin, args = ['--help'], exec = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })) {
  const probedAt = new Date().toISOString();
  try {
    const out = exec(bin, args);
    return { ok: true, probedAt, ...parseHelpText(out) };
  } catch (e) {
    try { const out = e.stdout ? String(e.stdout) : ''; if (out) return { ok: true, probedAt, ...parseHelpText(out) }; } catch {}
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
function discoverCapabilities(rt, settings = {}, { exec, initEvent } = {}) {
  const help = probeHelp(rt.bin(settings), ['--help'], exec);
  const base = { runtime: rt.id, slashCommands: help.slashCommands || [], commands: help.commands || [], skills: [], modes: [], ok: help.ok, error: help.error, probedAt: help.probedAt };
  if (initEvent) {
    const fromInit = fromInitEvent(initEvent);
    return { ...base, ...fromInit, slashCommands: [...new Set([...base.slashCommands, ...fromInit.slashCommands])], probedAt: fromInit.probedAt };
  }
  return base;
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

module.exports = { parseHelpText, probeHelp, fromInitEvent, discoverCapabilities, capabilitySignature, needsReprobe, TTL_MS };
