// Generic CLI introspector: runs `<cli> --help` (+ subcommand help, `models`, one JSON probe run) and
// derives a draft RuntimeProfile heuristically. No CLI-specific code paths — every CLI (helpycode,
// claude, codex, ...) goes through the same parsing.
const { normalizeRuntimeProfile } = require('./runtime-profile');

// "  run           Run a task and print JSON events" -> { name: 'run', desc: '...' }
function parseCommands(help) {
  const out = [];
  const lines = String(help || '').split('\n');
  let inCommands = false;
  for (const line of lines) {
    if (/^\s*(Commands|Sub[- ]?commands):?\s*$/i.test(line)) { inCommands = true; continue; }
    if (inCommands) {
      if (!line.trim()) { inCommands = false; continue; }
      const m = line.match(/^\s{2,}(\/?[\w:-]+)\s{2,}(.*)$/);
      if (m) out.push({ name: m[1], desc: m[2].trim() });
      else if (!/^\s{2,}\S/.test(line)) inCommands = false;
    }
  }
  return out;
}

// Prefer a command whose description advertises non-interactive/JSON output; else exec/run; else first.
function pickRunCommand(commands) {
  const byHint = commands.find((c) => /json|non-interactiv/i.test(c.desc));
  if (byHint) return byHint.name;
  const byName = commands.find((c) => /^(exec|run)$/i.test(c.name));
  if (byName) return byName.name;
  return commands[0] ? commands[0].name : '';
}

// "--effort <level>   Reasoning effort (low, medium, high)" -> { flag: '--effort', values: [...] }
function findEffort(text) {
  const m = String(text || '').match(/(--effort)\s*(?:<[^>]*>)?[^\n(]*\(([^)]+)\)/i);
  if (!m) return { flag: '', values: [] };
  return { flag: m[1], values: m[2].split(',').map((s) => s.trim()).filter(Boolean) };
}

function findResume(text, commands) {
  if (/--resume\b/.test(text)) return '--resume';
  if (commands.some((c) => c.name === 'resume')) return 'resume';
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
  return { method: 'none', flag: '' };
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
  inputPath: /^(input_tokens|inputTokens|prompt_tokens)$/i,
  outputPath: /^(output_tokens|outputTokens|completion_tokens)$/i,
  reasoningPath: /^(reasoning_tokens|reasoning_output_tokens|reasoningTokens)$/i,
  cachePath: /^(cache_read_tokens|cached_input_tokens|cache_read_input_tokens|cacheReadTokens)$/i,
  costPath: /^(total_cost_usd|cost_usd|cost|totalCostUsd)$/i,
  sessionIdPath: /^(session_id|thread_id|sessionId|threadId)$/i,
  textPath: /^(text|message|content)$/i,
};

// Scan parsed probe events for keys matching known synonyms; first match per field wins.
function deriveEventMapping(events) {
  const mapping = { textPath: '', sessionIdPath: '', costPath: '', inputPath: '', outputPath: '', reasoningPath: '', cachePath: '' };
  for (const ev of events) {
    const flat = flatten(ev);
    for (const [path, value] of Object.entries(flat)) {
      const leaf = path.split('.').pop();
      for (const [field, re] of Object.entries(KEY_SYNONYMS)) {
        if (!mapping[field] && re.test(leaf) && (field === 'textPath' ? typeof value === 'string' : true)) mapping[field] = path;
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

// exec(bin, args) -> stdout string; must not throw for --help calls that exit non-zero (caller should catch).
function introspectRuntime(bin, exec, opts = {}) {
  const safeExec = (args) => { try { return String(exec(bin, args) || ''); } catch (e) { return String((e && e.stdout) || ''); } };
  const help = safeExec(['--help']);
  const commands = parseCommands(help);
  const runCommand = pickRunCommand(commands);
  const subHelp = runCommand ? safeExec([runCommand, '--help']) : '';
  const text = help + '\n' + subHelp;

  const { flag: effortFlag, values: effortValues } = findEffort(text);
  const resumeFlag = findResume(text, commands);
  const modelFlag = findModelFlag(text);
  const { flag: formatFlag, value: formatValue } = findFormatFlag(text);
  const mcp = findMcp(text);
  const hasModelsCmd = commands.some((c) => c.name === 'models');

  const argsTemplate = [];
  if (runCommand) argsTemplate.push(runCommand);
  if (formatFlag) argsTemplate.push(formatFlag, formatValue || 'json');
  if (modelFlag) argsTemplate.push(modelFlag, '{model}');
  if (effortFlag) argsTemplate.push(effortFlag, '{variant}');
  argsTemplate.push('{prompt}');

  let eventMapping = { textPath: '', sessionIdPath: '', costPath: '', inputPath: '', outputPath: '', reasoningPath: '', cachePath: '' };
  if (opts.probe !== false && formatFlag) {
    const filled = argsTemplate.map((t) => t.replace('{model}', '\0').replace('{variant}', '\0').replace('{prompt}', opts.probePrompt || 'say pong'));
    const probeArgs = [];
    for (let i = 0; i < filled.length; i++) {
      if (filled[i] === '\0') { probeArgs.pop(); continue; } // drop the flag that took this unset placeholder
      probeArgs.push(filled[i]);
    }
    const probeOut = safeExec(probeArgs);
    eventMapping = deriveEventMapping(parseJsonLines(probeOut));
  }

  return normalizeRuntimeProfile({
    id: opts.id || bin, label: opts.label || bin, binary: bin,
    argsTemplate, modelsCommand: hasModelsCmd ? ['models'] : [],
    effortValues, effortFlag, resumeFlag, mcp, eventMapping,
  });
}

module.exports = { parseCommands, pickRunCommand, findEffort, findResume, findModelFlag, findFormatFlag, findMcp, flatten, deriveEventMapping, parseJsonLines, introspectRuntime };
