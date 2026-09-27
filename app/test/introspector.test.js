const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const IN = require('../src/introspector');

const helpycodeHelp = fs.readFileSync(path.join(__dirname, 'fixtures/help-helpycode.txt'), 'utf8');
const claudeHelp = fs.readFileSync(path.join(__dirname, 'fixtures/help-claude.txt'), 'utf8');
const codexHelp = fs.readFileSync(path.join(__dirname, 'fixtures/help-codex.txt'), 'utf8');

test('parseCommands / pickRunCommand work on a fictional CLI (no CLI-specific code)', () => {
  const cmds = IN.parseCommands(helpycodeHelp);
  assert.deepStrictEqual(cmds.map((c) => c.name), ['run', 'models', 'resume']);
  assert.strictEqual(IN.pickRunCommand(cmds), 'run');
  assert.strictEqual(IN.pickRunCommand(IN.parseCommands(codexHelp)), 'exec');
});

test('findEffort / findResume / findMcp heuristics', () => {
  assert.deepStrictEqual(IN.findEffort(helpycodeHelp), { flag: '--effort', values: ['low', 'medium', 'high'] });
  assert.strictEqual(IN.findResume(helpycodeHelp, IN.parseCommands(helpycodeHelp)), 'resume');
  assert.strictEqual(IN.findResume(codexHelp, IN.parseCommands(codexHelp)), '');
  assert.deepStrictEqual(IN.findMcp(helpycodeHelp), { method: 'json-flag', flag: '--mcp-config' });
});

test('deriveEventMapping finds synonyms anywhere in nested probe events', () => {
  const events = [
    { type: 'session', session_id: 'S1' },
    { type: 'message', text: 'pong' },
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2, cache_read_tokens: 1 } },
    { type: 'result', total_cost_usd: 0.002 },
  ];
  const m = IN.deriveEventMapping(events);
  assert.strictEqual(m.sessionIdPath, 'session_id');
  assert.strictEqual(m.textPath, 'text');
  assert.strictEqual(m.inputPath, 'usage.input_tokens');
  assert.strictEqual(m.outputPath, 'usage.output_tokens');
  assert.strictEqual(m.reasoningPath, 'usage.reasoning_tokens');
  assert.strictEqual(m.cachePath, 'usage.cache_read_tokens');
  assert.strictEqual(m.costPath, 'total_cost_usd');
});

test('introspectRuntime derives a full draft profile for the fictional "helpycode" CLI', () => {
  const probeOut = [
    JSON.stringify({ type: 'session', session_id: 'S1' }),
    JSON.stringify({ type: 'message', text: 'pong' }),
    JSON.stringify({ type: 'result', usage: { input_tokens: 8, output_tokens: 3, reasoning_tokens: 1, cache_read_tokens: 0 }, total_cost_usd: 0.001 }),
  ].join('\n');
  const exec = (bin, args) => {
    assert.strictEqual(bin, 'helpycode');
    if (args.includes('--help') && args[0] === 'run') return 'Run a task and print JSON events\n  --format <fmt>\n';
    if (args.includes('--help')) return helpycodeHelp;
    if (args[0] === 'run') return probeOut;
    throw new Error('unexpected exec ' + JSON.stringify(args));
  };
  const profile = IN.introspectRuntime('helpycode', exec, { id: 'helpycode', label: 'HelpyCode' });
  assert.strictEqual(profile.binary, 'helpycode');
  assert.ok(profile.argsTemplate.includes('run'));
  assert.ok(profile.argsTemplate.includes('--format'));
  assert.ok(profile.argsTemplate.includes('{model}'));
  assert.ok(profile.argsTemplate.includes('{prompt}'));
  assert.deepStrictEqual(profile.modelsCommand, ['models']);
  assert.deepStrictEqual(profile.effortValues, ['low', 'medium', 'high']);
  assert.strictEqual(profile.resumeFlag, 'resume');
  assert.deepStrictEqual(profile.mcp, { method: 'json-flag', flag: '--mcp-config' });
  assert.strictEqual(profile.eventMapping.textPath, 'text');
  assert.strictEqual(profile.eventMapping.sessionIdPath, 'session_id');
  assert.strictEqual(profile.eventMapping.costPath, 'total_cost_usd');
  assert.strictEqual(profile.eventMapping.inputPath, 'usage.input_tokens');
});
