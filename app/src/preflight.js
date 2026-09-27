// Preflight test: run one agent with its exact config (model, permission mode, tools, env, board MCP)
// on a trivial prompt that must call the board list_team tool and reply OK. Cheap: --max-turns 3.
// Pure helpers (args, fingerprint, result parsing) plus runPreflight() which spawns the CLI.
const { spawn } = require('child_process');
const crypto = require('crypto');
const { buildClaudeArgs, normalizeNode } = require('./agent-config');
const U = require('./usage');

const PREFLIGHT_PROMPT = 'Preflight check. Call the board MCP tool list_team exactly once, then reply with just: OK';
const PREFLIGHT_MAX_TURNS = 3;
const TOOL = 'mcp__board__list_team';
// Node fields that change how a run behaves: a pass is only valid while these stay the same.
const CONFIG_KEYS = ['runtime', 'model', 'permissionMode', 'allowedTools', 'disallowedTools', 'disabledBoardTools', 'env', 'extraArgs', 'appendSystemPrompt', 'addDirs', 'workdir', 'billingMode', 'billingBaseUrl'];

function configHash(node, settings = {}) {
  const n = normalizeNode(node); const o = {};
  for (const k of CONFIG_KEYS) o[k] = n[k];
  o.defaultPermissionMode = settings.permissionMode || ''; o.claudePath = settings.claudePath || '';
  return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);
}

// Same args as a real run, but the preflight prompt and a hard turn cap (overrides the node's maxTurns / resume).
function preflightArgs(cfg, settings, mcp) {
  const args = buildClaudeArgs({ ...cfg, maxTurns: 0 }, PREFLIGHT_PROMPT, settings, mcp);
  args.push('--max-turns', String(PREFLIGHT_MAX_TURNS));
  return args;
}

// 'untested' | 'pass' | 'fail' | 'stale' (config changed since the last test)
function preflightStatus(node, settings) {
  const p = node && node.preflight;
  if (!p) return 'untested';
  try { if (p.configHash && p.configHash !== configHash(node, settings)) return 'stale'; } catch { return 'stale'; }
  return p.ok ? 'pass' : 'fail';
}

const parseVersion = (s) => { const m = String(s || '').match(/\d+\.\d+\.\d+\S*/); return m ? m[0] : ''; };

// Turn the collected stream-json events into checks. input: { version, versionError, events, code, stderr, latencyMs, spawnError }
function evaluate(input) {
  const { events = [], stderr = '', code = null, latencyMs = 0 } = input;
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = [...events].reverse().find((e) => e.type === 'result');
  const toolUses = []; const toolResults = {}; let text = '';
  for (const e of events) {
    const content = (e.message && Array.isArray(e.message.content)) ? e.message.content : [];
    for (const c of content) {
      if (e.type === 'assistant' && c.type === 'tool_use') toolUses.push(c);
      if (e.type === 'assistant' && c.type === 'text') text += c.text;
      if (e.type === 'user' && c.type === 'tool_result') toolResults[c.tool_use_id] = c;
    }
  }
  const errText = String((result && result.is_error && (result.result || (result.errors || []).join(' '))) || '') + ' ' + String(stderr);
  const board = init && (init.mcp_servers || []).find((s) => s.name === 'board');
  const assistantSeen = events.some((e) => e.type === 'assistant') || !!(result && !result.is_error);
  const authErr = /auth|log ?in|api key|credential|401|403|unauthori[sz]ed|forbidden|oauth/i.test(errText);
  const modelErr = /model/i.test(errText) && /(not[ _]?found|invalid|unknown|does not exist|not available|not supported|404|access)/i.test(errText);
  const call = toolUses.find((t) => t.name === TOOL);
  const res = call && toolResults[call.id];
  const tokens = result ? U.tokensFromResult(result) : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: detail || '' });
  add('binary', 'claude binary', !input.versionError && !input.spawnError, input.spawnError || input.versionError || ('claude ' + (input.version || '?')));
  if (!input.spawnError) {
    add('model', 'model valid', !modelErr && assistantSeen, modelErr ? errText.trim().slice(0, 300) : ((init && init.model) || 'default') + (assistantSeen ? '' : ' (no reply)'));
    add('auth', 'auth works', !!init && !authErr && assistantSeen, authErr ? errText.trim().slice(0, 300) : `apiKeySource=${init ? (init.apiKeySource ?? '?') : '?'}`);
    add('mcp', 'board MCP connected', board && board.status === 'connected', board ? `status=${board.status}` : 'board server missing from init');
    const toolOk = !!call && !!res && !res.is_error;
    const resText = res ? (Array.isArray(res.content) ? res.content.map((x) => x.text || '').join('') : String(res.content ?? '')) : '';
    add('tool', 'list_team call', toolOk, !call ? (toolUses.length ? 'called ' + toolUses.map((t) => t.name).join(', ') + ' instead' : 'tool was not called') : !res ? 'no tool result' : res.is_error ? resText.slice(0, 300) : 'ok');
    const reply = (result && typeof result.result === 'string' ? result.result : text).trim();
    add('reply', 'replied OK', result && !result.is_error && /\bOK\b/.test(reply), reply.slice(0, 120) || (result ? result.subtype : `exit ${code}`));
  }
  const ok = checks.every((c) => c.ok);
  const first = checks.find((c) => !c.ok);
  return {
    ok, checks, error: first ? `${first.label}: ${first.detail}` : '',
    version: input.version || '', model: (init && init.model) || '', apiKeySource: init ? (init.apiKeySource ?? null) : null,
    billing: U.detectBilling(input.env || {}, init ? init.apiKeySource : undefined).source,
    latencyMs, tokens, costUsd: result ? Number(result.total_cost_usd) || 0 : 0, turns: result ? result.num_turns || 0 : 0, exitCode: code,
    at: new Date().toISOString(),
  };
}

function runProc(cmd, args, opts, onLine, timeoutMs) {
  return new Promise((resolve) => {
    let child; let out = ''; let err = ''; let buf = ''; let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ out, stderr: err, ...r }); };
    try { child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return finish({ code: null, error: e.message }); }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ code: null, error: `timed out after ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (!onLine) return; buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => { if (onLine && buf.trim()) onLine(buf.trim()); finish({ code }); });
  });
}

// opts: { cfg (normalized node), settings, mcp, cwd, env, timeoutMs, onEvent }
async function runPreflight({ cfg, settings, mcp, cwd, env, timeoutMs = 120000, onEvent }) {
  const bin = settings.claudePath || 'claude';
  const v = await runProc(bin, ['--version'], { cwd, env }, null, 20000);
  const version = parseVersion(v.out);
  const versionError = v.error ? `not found (${bin}): ${v.error}` : v.code !== 0 ? `--version exited ${v.code}: ${(v.stderr || v.out).trim().slice(0, 200)}` : '';
  if (versionError && v.error) return evaluate({ spawnError: versionError, env });
  const events = []; const t0 = Date.now();
  const r = await runProc(bin, preflightArgs(cfg, settings, mcp), { cwd, env }, (l) => {
    let ev; try { ev = JSON.parse(l); } catch { return; }
    events.push(ev); if (onEvent) onEvent(ev);
  }, timeoutMs);
  const res = evaluate({ version, versionError, events, code: r.code, stderr: (r.error ? r.error + ' ' : '') + r.stderr, latencyMs: Date.now() - t0, env });
  res.events = events;
  return res;
}

module.exports = { PREFLIGHT_PROMPT, PREFLIGHT_MAX_TURNS, CONFIG_KEYS, configHash, preflightArgs, preflightStatus, evaluate, parseVersion, runPreflight };
