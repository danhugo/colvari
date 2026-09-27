#!/usr/bin/env node
// Fictional agent CLI used to exercise the introspector + profile-runner against a *real* spawned
// process (not just fake exec/spawn stubs). Mirrors help-helpycode.txt's shape: run/models/resume
// commands, --format json, --model, --effort, --mcp-config, --resume.
'use strict';

const args = process.argv.slice(2);

const HELP = `Usage: fake-agent-cli [options] [command]

fake-agent-cli - a fictional agent CLI used to prove the introspector/runner are generic

Commands:
  run           Run a task non-interactively and print JSON events (--format json)
  models        List available models
  resume        Resume a previous session

Options:
  --format <fmt>    Output format (json, text)
  --model <model>   Model to use
  --effort <level>  Reasoning effort (low, medium, high)
  --mcp-config <json>  Inline MCP server configuration
  --resume <id>     Resume a previous session by id
`;

const RUN_HELP = `Run a task non-interactively and print JSON events
  --format <fmt>
  --model <model>
  --effort <level>
  --mcp-config <json>
  --resume <id>
`;

const MODELS = ['fake/small', 'fake/big'];

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

if (args[0] === 'run' && args.includes('--help')) { process.stdout.write(RUN_HELP); process.exit(0); }
if (args.includes('--help') || args.length === 0) { process.stdout.write(HELP); process.exit(0); }

if (args[0] === 'models') { process.stdout.write(MODELS.join('\n') + '\n'); process.exit(0); }

if (args[0] === 'run') {
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const resumeIdx = args.indexOf('--resume');
  const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : 'S-' + Date.now();
  const prompt = args[args.length - 1];
  const variant = get('--effort') || 'medium';

  emit({ type: 'session', session_id: sessionId });
  emit({ type: 'message', text: `fake reply to "${prompt}" (variant=${variant})` });
  emit({
    type: 'result',
    usage: { input_tokens: 12, output_tokens: 6, reasoning_tokens: 2, cache_read_tokens: 0 },
    total_cost_usd: 0.0003,
  });
  process.exit(0);
}

process.stderr.write(`fake-agent-cli: unknown args ${JSON.stringify(args)}\n`);
process.exit(1);
