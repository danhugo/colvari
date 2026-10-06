const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const IN = require('../src/introspector');

const helpycodeHelp = fs.readFileSync(path.join(__dirname, 'fixtures/help-helpycode.txt'), 'utf8');
const claudeHelp = fs.readFileSync(path.join(__dirname, 'fixtures/help-claude.txt'), 'utf8');
const codexHelp = fs.readFileSync(path.join(__dirname, 'fixtures/help-codex.txt'), 'utf8');
// Captured from a real installed `helpycode` binary (`helpycode --help` / `helpycode run --help`,
// merging stdout+stderr — this CLI prints help to stderr even on exit 0). Unlike the fictional
// help-helpycode.txt fixture above, real helpycode prefixes every command with the binary name
// ("  helpycode run [message..]     run ...") and uses "--variant"/"-s, --session" instead of
// "--effort"/"resume" — this is the shape that broke the original parser (docs/helpycode-smoke.md).
const realHelpycodeTop = fs.readFileSync(path.join(__dirname, 'fixtures/help-helpycode-real-top.txt'), 'utf8');
const realHelpycodeRun = fs.readFileSync(path.join(__dirname, 'fixtures/help-helpycode-real-run.txt'), 'utf8');
// Recorded from the real installed `helpycode models` (0.3.5): plain model-id lines, no JSON.
const realHelpycodeModels = fs.readFileSync(path.join(__dirname, 'fixtures/models-helpycode.txt'), 'utf8');
// Captured live from the installed `helpycode run --format json` (helpycode 0.3.5, 2026-09-27):
// fields nest under part.*, run totals arrive on `step_finish` events (part.tokens.*, part.cost).
const realHelpycodeProbe = fs.readFileSync(path.join(__dirname, 'fixtures/probe-helpycode-real.jsonl'), 'utf8');

test('parseCommands / pickRunCommand work on a fictional CLI (no CLI-specific code)', () => {
  const cmds = IN.parseCommands(helpycodeHelp);
  assert.deepStrictEqual(cmds.map((c) => c.name), ['run', 'models', 'resume']);
  assert.strictEqual(IN.pickRunCommand(cmds), 'run');
  assert.strictEqual(IN.pickRunCommand(IN.parseCommands(codexHelp)), 'exec');
});

test('findEffort / findResume / findMcp / findBypassFlag heuristics', () => {
  assert.deepStrictEqual(IN.findEffort(helpycodeHelp), { flag: '--effort', values: ['low', 'medium', 'high'] });
  assert.strictEqual(IN.findResume(helpycodeHelp, IN.parseCommands(helpycodeHelp)), 'resume');
  assert.strictEqual(IN.findResume(codexHelp, IN.parseCommands(codexHelp)), '');
  assert.deepStrictEqual(IN.findMcp(helpycodeHelp), { method: 'json-flag', flag: '--mcp-config' });
  // only bypass-shaped flags are claimed, and only whole tokens
  assert.strictEqual(IN.findBypassFlag('  --dangerously-skip-permissions  auto-approve permissions'), '--dangerously-skip-permissions');
  assert.strictEqual(IN.findBypassFlag('  --dangerously-bypass-approvals-and-sandbox  (dangerous!)'), '--dangerously-bypass-approvals-and-sandbox');
  assert.strictEqual(IN.findBypassFlag('  --permissions  set permissions'), ''); // not a bypass flag
  assert.strictEqual(IN.findBypassFlag('no flags here'), '');
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

test('introspectRuntime derives a full draft profile for the fictional "helpycode" CLI', async () => {
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
  const { profile, sources, models } = await IN.introspectRuntime('helpycode', exec, { id: 'helpycode', label: 'HelpyCode' });
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
  // per-field provenance: every derived field names the layer that produced it
  assert.strictEqual(sources.argsTemplate.source, 'help');
  assert.strictEqual(sources.eventMapping.source, 'probe');
  assert.strictEqual(sources.argsTemplate.confidence, 'high');
  assert.strictEqual(sources.resumeFlag.source, 'help');
  assert.strictEqual(sources.mcp.source, 'help');
  assert.strictEqual(sources.models, undefined); // no models command in this help
});

test('introspectRuntime runs the models subcommand and parses names (layer 2)', async () => {
  const exec = (bin, args) => {
    if (args.includes('--help')) return helpycodeHelp;
    if (args[0] === 'models') return ['elice/z-ai/glm-5.3-flash', 'elice/z-ai/glm-5.3', '', 'PROVIDER'].join('\n');
    throw new Error('unexpected exec ' + JSON.stringify(args));
  };
  const { models, sources } = await IN.introspectRuntime('helpycode', exec, { id: 'helpycode', probe: false });
  assert.deepStrictEqual(models, ['elice/z-ai/glm-5.3-flash', 'elice/z-ai/glm-5.3']); // header rows skipped
  assert.deepStrictEqual(sources.models, { source: 'models', confidence: 'high' });
});

test('parseModelsOutput tolerates JSON arrays, wrapped objects, NDJSON and table listings', () => {
  assert.deepStrictEqual(IN.parseModelsOutput('["m1","m2"]'), ['m1', 'm2']);
  assert.deepStrictEqual(IN.parseModelsOutput('{"models":[{"id":"a"},{"name":"b"}]}'), ['a', 'b']);
  assert.deepStrictEqual(IN.parseModelsOutput('{"id":"x"}\n{"id":"y"}'), ['x', 'y']);
  assert.deepStrictEqual(IN.parseModelsOutput('- m1\n* m2'), ['m1', 'm2']);
  assert.deepStrictEqual(IN.parseModelsOutput('banner text\nm1  details\n'), ['m1']);
  assert.deepStrictEqual(IN.parseModelsOutput(''), []);
});

test('parseCommands strips the repeated "helpycode <cmd>" prefix real helpycode --help uses', () => {
  const cmds = IN.parseCommands(realHelpycodeTop);
  assert.ok(cmds.some((c) => c.name === 'run'), 'expected a run command, got ' + JSON.stringify(cmds));
  assert.ok(cmds.some((c) => c.name === 'models'));
  assert.ok(!cmds.some((c) => c.name === 'helpycode'));
  assert.strictEqual(IN.pickRunCommand(cmds), 'run');
});

test('introspectRuntime derives a working profile against real installed-helpycode --help output', async () => {
  const exec = (bin, args) => {
    assert.strictEqual(bin, 'helpycode');
    if (args[0] === 'run' && args.includes('--help')) return realHelpycodeRun;
    if (args.includes('--help')) return realHelpycodeTop;
    throw new Error('unexpected exec ' + JSON.stringify(args));
  };
  const { profile } = await IN.introspectRuntime('helpycode', exec, { id: 'helpycode', label: 'HelpyCode', probe: false });
  assert.deepStrictEqual(profile.argsTemplate, ['run', '--format', 'json', '--model', '{model}', '--variant', '{variant}', '{prompt}']);
  assert.deepStrictEqual(profile.modelsCommand, ['models']);
  assert.strictEqual(profile.effortFlag, '--variant');
  // help only advertises examples ("e.g., high, max, minimal") — not a complete vocabulary, so no
  // values are claimed (the runner must not reject the CLI's default "low")
  assert.deepStrictEqual(profile.effortValues, []);
  assert.strictEqual(profile.resumeFlag, '-s');
  // t_2cd0112e: the CLI's own help advertises the bypass flag; claimed so runs can auto-approve
  // permission asks (external_directory) when the effective permission mode is bypassPermissions
  assert.strictEqual(profile.bypassFlag, '--dangerously-skip-permissions');
});

// Recorded from the real installed `helpycode models` (0.3.5): plain model-id lines, no JSON.
// The layered introspector runs the models subcommand and parses those bare ids into the draft.
test('recorded `helpycode models` output: bare model-id lines are parsed into the model list', async () => {
  const { profile, models, sources } = await IN.introspectRuntime('helpycode', (bin, args) => {
    assert.strictEqual(bin, 'helpycode');
    if (args[0] === 'run' && args.includes('--help')) return realHelpycodeRun;
    if (args.includes('--help')) return realHelpycodeTop;
    if (args[0] === 'models') return realHelpycodeModels;
    throw new Error('unexpected exec ' + JSON.stringify(args));
  }, { id: 'helpycode', label: 'HelpyCode', probe: false });
  assert.deepStrictEqual(profile.modelsCommand, ['models']);
  assert.deepStrictEqual(models, ['elice/qwen/qwen3.8-27b', 'elice/z-ai/glm-5.3-flash']);
  assert.deepStrictEqual(sources.models, { source: 'models', confidence: 'high' });
});

// Cato's acceptance bar (t_94eef7a1): the derived helpycode profile must be byte-equal to the old
// hand-built HELPYCODE_PROFILE, or the diff justified, with a test asserting it. The hand-built
// profile is restated here (it was deleted from runtimes.js) purely as the parity reference.
test('parity: derived helpycode profile vs the deleted hand-built HELPYCODE_PROFILE', async () => {
  const exec = (bin, args) => {
    if (args[0] === 'run' && args.includes('--help')) return realHelpycodeRun;
    if (args.includes('--help')) return realHelpycodeTop;
    if (args[0] === 'run') return realHelpycodeProbe;
    throw new Error('unexpected exec ' + JSON.stringify(args));
  };
  const { profile: derived } = await IN.introspectRuntime('helpycode', exec, { id: 'helpycode', label: 'HelpyCode' });
  const handBuilt = {
    argsTemplate: ['run', '--format', 'json', '--model', '{model}', '--variant', '{variant}', '{prompt}'],
    effortValues: ['low', 'medium', 'high', 'max', 'minimal'],
    effortFlag: '--variant', resumeFlag: '-s',
    mcp: { method: 'file', flag: 'helpycode.json' },
    eventMapping: { textPath: 'text', sessionIdPath: 'session_id', costPath: 'total_cost_usd', inputPath: 'usage.input_tokens', outputPath: 'usage.output_tokens', reasoningPath: 'usage.reasoning_tokens', cachePath: 'usage.cache_read_tokens' },
  };
  // byte-equal fields
  assert.deepStrictEqual(derived.argsTemplate, handBuilt.argsTemplate);
  assert.strictEqual(derived.effortFlag, handBuilt.effortFlag);
  assert.strictEqual(derived.resumeFlag, handBuilt.resumeFlag);
  assert.deepStrictEqual(derived.modelsCommand, ['models']);
  // justified diffs:
  // 1) effortValues: help only advertises examples ("e.g., high, max, minimal") — an explicitly
  //    non-exhaustive list is not claimed as a vocabulary; the ask-agent layer (or a user edit)
  //    completes it, since a partial list would make the runner reject the CLI's default "low".
  assert.deepStrictEqual(derived.effortValues, []);
  // 2) mcp: helpycode has no MCP config flag but lists its own `helpycode mcp` subcommand, so help
  //    parsing derives file-based config ({file, helpycode.json}, passed per run via HELPYCODE_CONFIG).
  assert.deepStrictEqual(derived.mcp, { method: 'file', flag: 'helpycode.json' });
  // 3) eventMapping: the CLI's current probe stream carries fields under part.* ("step_finish"
  //    events with part.tokens.*), while the hand-built mapping targeted the older documented
  //    shape — the introspector re-derives it from the actual stream instead of going stale.
  assert.strictEqual(derived.eventMapping.textPath, 'part.text');
  assert.strictEqual(derived.eventMapping.sessionIdPath, 'sessionID');
  assert.strictEqual(derived.eventMapping.inputPath, 'part.tokens.input');
  assert.strictEqual(derived.eventMapping.outputPath, 'part.tokens.output');
  assert.strictEqual(derived.eventMapping.reasoningPath, 'part.tokens.reasoning');
  assert.strictEqual(derived.eventMapping.costPath, 'part.cost');
  // cachePath stays empty: the stream's leaf is just "read", too generic to claim honestly
  assert.strictEqual(derived.eventMapping.cachePath, '');
});

test('ask-agent layer (opt-in) fills only gaps and marks fields low-confidence "agent"', async () => {
  const agentJson = JSON.stringify({
    argsTemplate: ['run', '--format', 'json', '--model', '{model}', '--variant', '{variant}', '{prompt}'],
    resumeFlag: '-s', effortFlag: '--variant', effortValues: ['low', 'medium', 'high', 'max', 'minimal'],
    mcp: { method: 'file', flag: 'helpycode.json' },
    eventMapping: { textPath: 'text', sessionIdPath: 'session_id', costPath: 'total_cost_usd', inputPath: 'usage.input_tokens', outputPath: 'usage.output_tokens', reasoningPath: 'usage.reasoning_tokens', cachePath: 'usage.cache_read_tokens' },
  });
  let asked = false;
  const exec = (bin, args) => {
    if (args[0] === 'run' && args.includes('--help')) return realHelpycodeRun;
    if (args.includes('--help')) return realHelpycodeTop;
    if (args.join(' ').includes('argsTemplate')) { asked = true; return agentJson; } // the profile request
    throw new Error('unexpected exec ' + JSON.stringify(args));
  };
  const { profile, sources } = await IN.introspectRuntime('helpycode', exec, { id: 'helpycode', label: 'HelpyCode', probe: false, askAgent: true });
  assert.ok(asked, 'ask-agent layer did not run');
  // observed fields are never overwritten; the effort vocabulary is unioned in, gaps filled from
  // the agent's own description
  assert.deepStrictEqual([...profile.effortValues].sort(), ['high', 'low', 'max', 'medium', 'minimal']);
  assert.deepStrictEqual(profile.mcp, { method: 'file', flag: 'helpycode.json' });
  assert.deepStrictEqual(sources.effortValues, { source: 'agent', confidence: 'low' });
  assert.strictEqual(sources.mcp.source, 'help'); // help already derives it — agent ignored
  assert.strictEqual(sources.argsTemplate.source, 'help'); // help already had it — agent ignored
  // without askAgent the same CLI still gets MCP from help (the `mcp` subcommand)
  const { profile: quiet } = await IN.introspectRuntime('helpycode', exec, { id: 'helpycode', probe: false });
  assert.deepStrictEqual(quiet.mcp, { method: 'file', flag: 'helpycode.json' });
});

test('validateAgentProfile rejects hallucinated/hostile JSON (Cato: never trust model output)', () => {
  const ok = { argsTemplate: ['run', '{prompt}'] };
  assert.strictEqual(IN.validateAgentProfile(ok, 'helpycode').binary, 'helpycode'); // binary allowlist is forced
  assert.throws(() => IN.validateAgentProfile(null, 'helpycode'), /not a JSON object/);
  assert.throws(() => IN.validateAgentProfile({ argsTemplate: ['sh', '-c', 'rm -rf /; {prompt}'] }, 'h'), /metacharacter/);
  assert.throws(() => IN.validateAgentProfile({ argsTemplate: ['run'] }, 'h'), /\{prompt\} placeholder/); // must know where the prompt goes
  assert.throws(() => IN.validateAgentProfile({ argsTemplate: ['run', '{prompt}'], mcp: { method: 'json-flag', flag: '/etc/passwd' } }, 'h'), /unsafe mcp flag/);
  assert.throws(() => IN.validateAgentProfile({ argsTemplate: ['run', '{prompt}'], eventMapping: { textPath: '..\\evil' } }, 'h'), /unsafe eventMapping/);
  assert.throws(() => IN.validateAgentProfile({ argsTemplate: ['run', '{prompt}'], effortFlag: 'not a flag' }, 'h'), /unsafe effort flag/);
  // unknown fields dropped, mcp method allowlisted by normalize
  const p = IN.validateAgentProfile({ ...ok, mcp: { method: 'deploy-arbitrary-code' }, extra: 'junk' }, 'helpycode');
  assert.deepStrictEqual(p.mcp, { method: 'none', flag: '' });
  assert.strictEqual(p.extra, undefined);
});

test('assertSafeArgs refuses auto-approve/bypass flags; sandboxEnv strips user secrets', () => {
  assert.throws(() => IN.assertSafeArgs(['run', '--yes', '{prompt}']), /auto-approve|refuses/);
  assert.throws(() => IN.assertSafeArgs(['--dangerously-bypass-approvals-and-sandbox']), /refuses/);
  assert.throws(() => IN.assertSafeArgs(['-y']), /refuses/);
  assert.throws(() => IN.assertSafeArgs(['yes']), /refuses/);
  assert.doesNotThrow(() => IN.assertSafeArgs(['run', IN.AGENT_PROFILE_PROMPT]), 'the ask-agent prompt is prose, not a bypass flag');
  assert.deepStrictEqual(IN.assertSafeArgs(['run', '--format', 'json', '{prompt}']), ['run', '--format', 'json', '{prompt}']);
  const env = IN.sandboxEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-secret', MY_APP_TOKEN: 'x', LANG: 'C' });
  assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/h', LANG: 'C' });
});
