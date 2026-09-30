#!/usr/bin/env node
'use strict';
// Synthetic "claude"-shaped CLI for perf baselines (t_f02c2572): speaks just enough of the
// stream-json protocol (--help/--version/models/run, init/assistant/user/result events) for the
// orchestrator to run it end-to-end, then streams events at a steady, env-tunable rate so the
// app is measured under sustained agent load without any real model calls. Paired tool_use /
// tool_result turns plus per-message context updates mimic a working agent's event mix.
//
// Knobs (env): STREAM_SECONDS total stream duration (default 45),
//              STREAM_EPS events per second (default 6),
//              STREAM_TOOL_EVERY one tool_use+result pair every N events (default 2),
//              STREAM_TEXT_BYTES text chunk size (default 260).

const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stdout.on('error', (e) => process.exit(e.code === 'EPIPE' ? 0 : 1)); // reader gone: stop quietly

if (args.includes('--version')) { process.stdout.write('1.0.0 (perf stream-cli)\n'); process.exit(0); }
if (args[0] === 'models') { process.stdout.write('perf-1\nperf-2\n'); process.exit(0); }
if (args.includes('--help') || args.length === 0) {
  process.stdout.write(`Usage: stream-cli [options] [command]

stream-cli - synthetic streaming agent CLI used by test/perf/click-latency.js

Commands:
  run           Run a task non-interactively and print JSON events (--format json)
  models        List available models

Options:
  --format <fmt>       Output format (json)
  --model <model>      Model to use
  --effort <level>     Reasoning effort (low, medium, high)
  --mcp-config <json>  Inline MCP server configuration
  --resume <id>        Resume a previous session by id
`);
  process.exit(0);
}
// buildClaudeArgs invokes `stream-cli -p "prompt" --output-format stream-json ...` (flags first,
// no subcommand) while the fixture-style shape is `run ...` — accept both as a run.
const isRun = args[0] === 'run' || (args.length > 0 && args[0].startsWith('-'));
if (!isRun) { process.stderr.write(`stream-cli: unknown command ${JSON.stringify(args[0])}\n`); process.exit(1); }

const seconds = Number(process.env.STREAM_SECONDS || 45);
const eps = Math.max(0.5, Number(process.env.STREAM_EPS || 6));
const toolEvery = Math.max(2, Number(process.env.STREAM_TOOL_EVERY || 2));
const textBytes = Number(process.env.STREAM_TEXT_BYTES || 260);

const sessionId = 'perf-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
const TOOLS = ['Bash', 'Read', 'Edit', 'Grep'];
const textChunk = (n) => `Step ${n}: tracing the refresh path, the state delta looks right and the render cost dominates. `.repeat(Math.ceil(textBytes / 70)).slice(0, textBytes);

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'perf-1', cwd: process.cwd(), version: '1.0.0', apiKeySource: 'none', permissionMode: 'bypassPermissions', mcp_servers: [], slash_commands: [], agents: [] });

let i = 0;
const total = Math.max(2, Math.round(seconds * eps));
const iv = setInterval(() => {
  i++;
  if (i % toolEvery === 0) {
    // usage on every assistant message (real CLIs report it per turn): each new message id is a
    // renderer context update, so this rate IS the app's state-push cadence under load.
    emit({ type: 'assistant', session_id: sessionId, message: { id: 'msg_' + sessionId + '_' + i, model: 'perf-1', usage: { input_tokens: 1400 + i, output_tokens: 60 + i, cache_read_input_tokens: 40000, cache_creation_input_tokens: 300 }, content: [{ type: 'tool_use', id: 'toolu_' + i, name: TOOLS[i % TOOLS.length], input: { command: 'node --version', file_path: 'src/module' + (i % 7) + '.js', pattern: 'renderAll', description: 'perf synthetic step ' + i } }] } });
  } else if (i % toolEvery === 1 && i > 1) {
    emit({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_' + (i - 1), content: 'ok — 42 matches in 3 files (synthetic)' }] } });
  } else {
    emit({ type: 'assistant', session_id: sessionId, message: { id: 'msg_' + sessionId + '_' + i, model: 'perf-1', usage: { input_tokens: 1200 + i, output_tokens: 90 + i, cache_read_input_tokens: 40000, cache_creation_input_tokens: 500 }, content: [{ type: 'text', text: textChunk(i) }] } });
  }
  if (i >= total) {
    clearInterval(iv);
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: seconds * 1000, num_turns: Math.max(1, Math.round(i / toolEvery)), result: 'perf run complete', session_id: sessionId, total_cost_usd: 0.02, usage: { input_tokens: 5000, output_tokens: 900, cache_read_input_tokens: 80000, cache_creation_input_tokens: 1200 } });
    process.exit(0);
  }
}, Math.round(1000 / eps));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
