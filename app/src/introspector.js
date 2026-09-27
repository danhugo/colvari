// Generic CLI introspector: runs `<cli> --help` (+ subcommand help, `models`, one JSON probe run) and
// derives a draft RuntimeProfile heuristically. No CLI-specific code paths — every CLI (helpycode,
// claude, codex, ...) goes through the same parsing.
const { normalizeRuntimeProfile } = require('./runtime-profile');

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
function findEffort(text) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const m = flat.match(/(--effort|--variant|--reasoning-effort)\b[^()]*\(([^)]*)\)/i);
  if (!m) return { flag: '', values: [] };
  let inner = m[2];
  const eg = inner.match(/e\.g\.,?\s*(.*)$/i);
  if (eg) inner = eg[1];
  return { flag: m[1], values: inner.split(',').map((s) => s.trim()).filter(Boolean) };
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

// Default exec: some CLIs (e.g. real helpycode, a yargs app) print --help to stderr even though they
// exit 0, so stdout alone can come back empty; merge both streams and never throw.
function defaultExec(bin, args) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000 });
  return String((r.stdout || '') + (r.stderr || ''));
}

// exec(bin, args) -> stdout string; must not throw for --help calls that exit non-zero (caller should catch).
// exec is optional; when omitted (or when the second arg is an opts object instead of a function),
// falls back to defaultExec above.
function introspectRuntime(bin, execOrOpts, maybeOpts) {
  const exec = typeof execOrOpts === 'function' ? execOrOpts : defaultExec;
  const opts = (typeof execOrOpts === 'function' ? maybeOpts : execOrOpts) || {};
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
