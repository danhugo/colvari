#!/usr/bin/env node
// "Unknown" agent CLI with a deliberately NON-standard interface, used to prove the introspector
// derives a usable RuntimeProfile for a CLI it has never seen with zero new code. Unlike
// fake-agent-cli.js (which mirrors the fictional helpycode shape) this one:
//   - prints --help to stderr and exits 1 (many real CLIs do; introspector must merge + not throw)
//   - uses a "Sub-commands:" section whose rows are prefixed with the binary name
//   - names its run command "ask" (hint picked up only via the word "json" in "ndjson" in its desc)
//   - has a boolean output flag (-j/--json), a short model flag (-m/--model)
//   - calls effort "--focus" (not recognized -> degrades to unsupported) and resume "-c/--continue"
//   - has no "models" command at all (modelsCommand degrades to [])
//   - emits events with a different envelope: {kind, content, meta.threadId, usage.*, cost_usd}
'use strict';

const args = process.argv.slice(2);

const HELP = `Usage: oddctl COMMAND [OPTIONS] PROMPT

oddctl - a deliberately unusual agent CLI

Sub-commands:
  oddctl ask PROMPT      send one prompt, print ndjson events
  oddctl ls-models       list model ids

Flags:
  -j, --json             print the ndjson event stream
  -m, --model ID         model id to use
  --focus LEVEL          thinking focus (e.g., low, high)
  -c, --continue ID      continue a previous session by id
`;

const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

// Positional args are the argv words that are not a flag and not a value of a value-taking flag;
// the prompt is the LAST one. Only -m/--model and -c/--continue consume a value — --json is boolean,
// so it can't swallow the prompt that follows it. The last-token rule is also what lets a run
// tolerate the introspector pushing a literal "json" value token after a boolean --json flag (a
// known wart for boolean output flags, see docs/onboarding-introspection.md): a real CLI in this
// shape would behave the same way.
const VALUE_FLAGS = new Set(['-m', '--model', '-c', '--continue']);
function positionals(all) {
  const out = [];
  for (let i = 0; i < all.length; i++) {
    if (VALUE_FLAGS.has(all[i])) { i++; continue; }
    if (/^-/.test(all[i])) continue;
    out.push(all[i]);
  }
  return out;
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

if (args.includes('--help') || args.length === 0) {
  process.stderr.write(HELP);
  process.exit(1); // non-zero help exit: the introspector must still parse the merged output
}

if (args[0] === 'ls-models') { process.stdout.write(['odd/mini', 'odd/max'].join('\n') + '\n'); process.exit(0); }

if (args[0] === 'ask') {
  const pos = positionals(args.slice(1));
  const prompt = pos[pos.length - 1] || '';
  const continueId = get('--continue');
  emit({ kind: 'meta', threadId: continueId || 'T-' + process.pid });
  emit({ kind: 'chunk', content: `odd reply to "${prompt}" (model=${get('--model') || 'unset'})` });
  emit({ kind: 'stats', usage: { prompt_tokens: 7, completion_tokens: 4, reasoning_output_tokens: 1 }, cost_usd: 0.0002 });
  process.exit(0);
}

process.stderr.write(`oddctl: unknown command ${JSON.stringify(args[0])}\n`);
process.exit(1);
