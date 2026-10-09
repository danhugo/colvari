// Built-in pi runtime (t_3aa2d01e): args, event parsing, usage counted exactly once, and the
// introspector's root-flag fix. Everything runs against REAL pi 0.73.1 output recorded from the
// installed binary (Cato's bar: recorded output, not hand-made fixtures).
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const RT = require('../src/runtimes');
const IN = require('../src/introspector');
const PR = require('../src/profile-runner');
const { normalizeRuntimeProfile } = require('../src/runtime-profile');

const piHelp = fs.readFileSync(path.join(__dirname, 'fixtures/help-pi-real.txt'), 'utf8');
const piEvents = fs.readFileSync(path.join(__dirname, 'fixtures/probe-pi-live.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('pi args: -p --mode json, model, thinking, --session — never the interactive --resume', () => {
  const rt = RT.getRuntime('pi');
  assert.deepStrictEqual(rt.capabilities, { tokens: true, cost: true, mcp: false, resume: true }); // honest: no MCP, no board tools
  const a = rt.buildArgs({ model: '~google/gemini-flash-latest', effort: 'high' }, 'hi', {}, {}, { resume: '01a11fe1' });
  assert.deepStrictEqual(a, ['-p', '--mode', 'json', '--model', '~google/gemini-flash-latest', '--thinking', 'high', '--session', '01a11fe1', 'hi']);
  const b = rt.buildArgs({ effort: 'max' }, 'hi', {}, {}); // max clamps to pi's xhigh ceiling
  assert.deepStrictEqual(b, ['-p', '--mode', 'json', '--thinking', 'xhigh', 'hi']);
  assert.ok(!RT.getRuntime('pi').buildArgs({ effort: 'low' }, 'hi', {}, {}, { resume: 'S1' }).includes('--resume'));
});

test('pi has no board tools: an mcp config builds nothing (no fallback config)', () => {
  const mcp = { mcpServers: { board: { command: '/bin/node', args: ['srv.js', '--node', 'n1'] } } };
  const a = RT.getRuntime('pi').buildArgs({ effort: 'low' }, 'hi', {}, mcp, {});
  assert.deepStrictEqual(a, ['-p', '--mode', 'json', '--thinking', 'low', 'hi']);
});

// The orchestrator's onEvent sums tokens/cost across parsed events — fold the whole recorded stream
// that way: the result must equal the single assistant message_end's usage (turn_end repeats it and
// agent_end repeats the messages; counting either would double every total).
test('pi parsing on the recorded live stream: usage counted exactly once', () => {
  let sessionId, result, input = 0, output = 0, cacheRead = 0, cost = 0, textDeltas = 0;
  for (const ev of piEvents) {
    const o = RT.parsePiEvent(ev);
    if (o.sessionId) sessionId = o.sessionId;
    if (o.result !== undefined) result = o.result;
    if (o.tokens) { input += o.tokens.inputTokens; output += o.tokens.outputTokens; if (o.tokens.cacheReadTokens != null) cacheRead += o.tokens.cacheReadTokens; }
    cost += o.cost || 0;
    for (const [k, t] of o.logs) { if (k === 'text') { textDeltas++; assert.strictEqual(t, 'pong'); } assert.notStrictEqual(k, 'error'); }
  }
  assert.strictEqual(sessionId, '01a11fe1-9b68-7294-bcdc-c5a0a6ae4770');
  assert.strictEqual(result, 'pong'); // final assistant text from message_end, not the last delta
  assert.deepStrictEqual([input, output, cacheRead, cost], [1431, 16, 0, 0.0007635]);
  assert.strictEqual(textDeltas, 1);
  // the user echo (message_end role user) and turn_end carry usage-looking payloads: neither may claim tokens
  const userEcho = RT.parsePiEvent(piEvents.find((e) => e.type === 'message_end' && e.message.role === 'user'));
  assert.strictEqual(userEcho.tokens, undefined);
  const turnEnd = RT.parsePiEvent(piEvents.find((e) => e.type === 'turn_end'));
  assert.strictEqual(turnEnd.tokens, undefined);
});

// Item 3: applyProfileEvent/parseProfileEvent filter by event type, so a HAND-WRITTEN profile can't
// double-count either — the path may pin the event type it reads from.
test('applyProfileEvent honors type-prefixed mapping paths (no double count)', () => {
  const mapping = { inputPath: 'message_end:message.usage.input', outputPath: 'message_end:message.usage.output' };
  const run = PR.applyProfileEvent({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, reportedCostUsd: 0 }, { type: 'message_end', message: { usage: { input: 1431, output: 16 } } }, mapping);
  PR.applyProfileEvent(run, { type: 'turn_end', message: { usage: { input: 1431, output: 16 } } }, mapping); // repeated usage: not read
  assert.strictEqual(run.inputTokens, 1431);
  assert.strictEqual(run.outputTokens, 16);
  const bare = PR.applyProfileEvent({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, reportedCostUsd: 0 }, { type: 'turn_end', message: { usage: { input: 5, output: 1 } } }, { inputPath: 'message.usage.input', outputPath: 'message.usage.output' });
  assert.strictEqual(bare.inputTokens, 5); // bare paths keep reading every event, as before
});

test('parseProfileEvent honors type-prefixed paths too', () => {
  const profile = normalizeRuntimeProfile({ id: 'pi-like', label: 'PiLike', binary: 'pi-like', eventMapping: { textPath: 'message_update:assistantMessageEvent.delta', sessionIdPath: 'session:id', inputPath: 'message_end:message.usage.input', outputPath: 'message_end:message.usage.output' } });
  const t = RT.parseProfileEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pong' } }, profile);
  assert.strictEqual(t.result, 'pong');
  assert.strictEqual(RT.parseProfileEvent({ type: 'session', id: 'S9' }, profile).sessionId, 'S9');
  const e = RT.parseProfileEvent({ type: 'message_end', message: { role: 'assistant', usage: { input: 7, output: 3 } } }, profile);
  assert.deepStrictEqual(e.tokens, { inputTokens: 7, outputTokens: 3 });
  assert.ok(e.done);
  assert.strictEqual(RT.parseProfileEvent({ type: 'turn_end', message: { role: 'assistant', usage: { input: 7, output: 3 } } }, profile).tokens, undefined);
});

test('validateAgentProfile accepts type-prefixed eventMapping paths, still rejects junk', () => {
  const p = IN.validateAgentProfile({ argsTemplate: ['{prompt}'], eventMapping: { inputPath: 'message_end:message.usage.input' } }, 'pi');
  assert.strictEqual(p.eventMapping.inputPath, 'message_end:message.usage.input');
  assert.throws(() => IN.validateAgentProfile({ argsTemplate: ['{prompt}'], eventMapping: { inputPath: 'a:b:c' } }, 'pi'), /unsafe eventMapping/);
});

// Item 2: the introspector on a root-flag CLI. pi's subcommands are management verbs — the old
// picker fell through to `pi install` and the probe would have RUN it (mutating).
test('introspection of a root-flag CLI: pi runs from the root, the probe never mutates', async () => {
  const calls = [];
  const exec = (bin, args) => {
    calls.push(args);
    if (args[0] === '--version') return '0.73.1\n';
    if (args.includes('--help')) return piHelp;
    throw new Error('unexpected exec ' + JSON.stringify(args));
  };
  const { profile } = await IN.introspectRuntime('pi', exec, { id: 'pi', label: 'Pi' });
  assert.strictEqual(profile.argsTemplate[0], '--print'); // the root flag IS the run mode
  assert.ok(profile.argsTemplate.includes('--mode') && profile.argsTemplate.includes('json'));
  assert.ok(!profile.argsTemplate.includes('install'));
  assert.strictEqual(profile.resumeFlag, '--session'); // never the interactive picker flag
  assert.deepStrictEqual(profile.mcp, { method: 'none', flag: '' }); // pi has no MCP
  const probe = calls.find((a) => a.includes('say pong'));
  assert.ok(probe, 'the probe layer ran');
  assert.strictEqual(probe[0], '--print');
  assert.ok(!probe.includes('install'));
  assert.ok(!calls.some((a) => a[0] === 'install'), 'no subcommand help/probe call at all');
});

test('pickRunCommand never returns a mutating management verb (regression: subcommand CLIs unchanged)', () => {
  const cmds = IN.parseCommands(piHelp);
  assert.deepStrictEqual(cmds.map((c) => c.name), ['install', 'remove', 'uninstall', 'update', 'list', 'config']);
  assert.strictEqual(IN.pickRunCommand(cmds), 'list'); // first safe row; install/remove/uninstall/update/config blocked
  // subcommand CLIs still pick their run command (no regression from the blocklist)
  assert.strictEqual(IN.pickRunCommand(IN.parseCommands(fs.readFileSync(path.join(__dirname, 'fixtures/help-helpycode.txt'), 'utf8'))), 'run');
  assert.strictEqual(IN.findRootRunFlag(piHelp), '--print');
  assert.strictEqual(IN.findRootRunFlag('  -p, --print                 Print response and exit (non-interactive mode)\n'), '--print');
  assert.strictEqual(IN.findRootRunFlag('  --verbose               verbose output\n'), '');
});
