// Agent run modes (pure logic, shared by the orchestrator, renderer defaults and tests).
//   single   : one `claude -p` per task (default).
//   goal     : run, then ask a cheap judge run (--json-schema) whether the user's completion condition is met;
//              if not, `--resume <session_id>` with a "continue" prompt. Stops when met or at maxIterations.
//   loop     : run the task prompt exactly loopCount times (resuming the same session). Only the last pass is told to
//              mark the task done; a "done" set by the agent in an earlier pass is ignored (the task is reopened).
//   workflow : the prompt starts with a user-chosen slash command / skill string (e.g. "/review"), followed by the task prompt.
// Session: every run's session_id is recorded on the task; continueSession resumes the agent's previous session for its next task.

const U = require('./usage');
const RUN_MODES = ['single', 'goal', 'loop', 'workflow'];
const MODE_DEFAULTS = { mode: 'single', goalCondition: '', maxIterations: 5, loopCount: 3, slashCommand: '', checkModel: 'haiku', continueSession: false };
const MAX_ITER_CAP = 50;

function normalizeMode(n = {}) {
  const r = {};
  r.mode = RUN_MODES.includes(n.mode) ? n.mode : 'single';
  r.goalCondition = String(n.goalCondition || '');
  const int = (v, d) => { const x = parseInt(v, 10); return Math.min(MAX_ITER_CAP, Math.max(1, Number.isFinite(x) ? x : d)); };
  r.maxIterations = int(n.maxIterations, MODE_DEFAULTS.maxIterations);
  r.loopCount = int(n.loopCount, MODE_DEFAULTS.loopCount);
  r.slashCommand = String(n.slashCommand || '').trim();
  r.checkModel = String(n.checkModel == null ? MODE_DEFAULTS.checkModel : n.checkModel).trim();
  r.continueSession = n.continueSession === true || n.continueSession === 'true';
  return r;
}

// "/review" or "review" -> "/review"; free text that does not look like a command name is kept verbatim.
function slashPrefix(cmd) {
  cmd = String(cmd || '').trim(); if (!cmd) return '';
  if (cmd.startsWith('/')) return cmd;
  return /^[\w:.-]+(\s|$)/.test(cmd) ? '/' + cmd : cmd;
}

// The task text alone (title + description), used as the slash command's $ARGUMENTS in workflow mode.
function taskText(task = {}) {
  const t = String(task.title || '').trim(); const d = String(task.description || '').trim();
  if (!d) return t; if (!t || d.startsWith(t)) return d;
  return `${t}\n\n${d}`;
}
// Workflow mode: the slash command followed by only the task text (team context goes in --append-system-prompt).
const workflowPrompt = (m, task) => `${slashPrefix(m.slashCommand)} ${taskText(task)}`.trim();
const isLastLoop = (m, i) => m.mode === 'loop' && i >= m.loopCount - 1;

// Prompt for iteration i (0-based). basePrompt is the full task prompt from buildPrompt
// (for loop mode, the caller passes a base that defers "done" on every pass but the last).
// info.task: the task (workflow mode puts only its text after the slash command).
function iterationPrompt(m, basePrompt, i, info = {}) {
  if (i === 0 && m.mode === 'workflow' && m.slashCommand) return info.task ? workflowPrompt(m, info.task) : `${slashPrefix(m.slashCommand)} ${basePrompt}`;
  if (i === 0) return basePrompt;
  if (m.mode === 'goal') {
    return [`Continue working on the same task (iteration ${i + 1} of ${m.maxIterations}).`,
      `The completion condition is NOT met yet: ${m.goalCondition}`,
      info.reason ? `Checker said: ${info.reason}` : '',
      'Keep going until the condition is met, then update the task status as instructed before.'].filter(Boolean).join('\n');
  }
  if (m.mode === 'loop') return `Repeat pass ${i + 1} of ${m.loopCount}${isLastLoop(m, i) ? ' (the final pass)' : ''}. Re-run the task below, building on what you did before.\n\n${basePrompt}`;
  return basePrompt;
}

// Decide whether to run another iteration. i = iterations done so far (>=1).
// state: { taskStatus, code, stopped, judge: {met, reason} | null }
function nextStep(m, i, state) {
  if (state.stopped) return { again: false, why: 'stopped' };
  if (state.code !== 0) return { again: false, why: 'exit ' + state.code };
  if (m.mode === 'goal') {
    if (state.judge && state.judge.inconclusive) return { again: false, why: 'checker inconclusive' };
    if (state.judge && state.judge.met) return { again: false, why: 'condition met' };
    if (i >= m.maxIterations) return { again: false, why: 'max iterations' };
    return { again: true, why: 'condition not met' };
  }
  if (m.mode === 'loop') {
    if (i >= m.loopCount) return { again: false, why: 'loop count reached' };
    return { again: true, why: 'repeat' };
  }
  return { again: false, why: 'single run' };
}

const JUDGE_SCHEMA = { type: 'object', properties: { met: { type: 'boolean' }, reason: { type: 'string' } }, required: ['met', 'reason'] };

// Args for the cheap check run. Read-only tools only; no board MCP.
function judgeArgs(m, task, lastResult) {
  const prompt = [
    'You are a strict completion checker. Decide whether this completion condition is met right now.',
    `Condition: ${m.goalCondition}`,
    `Task: ${task.title}${task.description ? '\n' + task.description : ''}`,
    lastResult ? `The agent's last reply:\n${String(lastResult).slice(0, 4000)}` : '',
    'You may inspect files in the current directory with read-only tools. Answer with met=true only if clearly satisfied.',
  ].filter(Boolean).join('\n\n');
  const args = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(JUDGE_SCHEMA),
    '--allowedTools', 'Read,Glob,Grep,Bash(ls:*),Bash(cat:*)', '--permission-mode', 'default', '--no-session-persistence', '--max-turns', '6'];
  if (m.checkModel) args.push('--model', m.checkModel);
  return args;
}

// Parse the judge's `--output-format json` stdout -> {met, reason, cost}.
// raw result event kept (non-enumerable) for usage accounting
const withRaw = (o, ev) => Object.defineProperty(o, 'raw', { value: ev, enumerable: false });
// First {...} object in a text reply (plain JSON, or fenced / surrounded by prose).
function jsonIn(text) {
  const s = String(text || '');
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function parseJudge(stdout, ctx = {}) {
  let ev = null;
  const s = String(stdout || '').trim();
  try { ev = JSON.parse(s); } catch { const line = s.split('\n').reverse().find((l) => l.trim().startsWith('{')); try { ev = line && JSON.parse(line); } catch {} }
  if (!ev) return { met: false, unreadable: true, reason: 'checker produced no JSON', cost: 0 };
  const rc = U.reportedCostOf(ev, ctx); // absent ≠ $0; a $0 behind a proxy is 'model unpriced there'
  const cost = rc.costUsd ?? 0;
  const flags = { costKnown: rc.reported, proxyUnpriced: rc.proxyUnpriced };
  let so = ev.structured_output;
  if (!so && typeof ev.result === 'string') so = jsonIn(ev.result);
  if (so && typeof so.met === 'string' && /^(true|false)$/i.test(so.met)) so = { ...so, met: /^true$/i.test(so.met) };
  if (!so || typeof so.met !== 'boolean') return withRaw({ met: false, unreadable: true, reason: ev.is_error ? `checker error: ${String(ev.result || ev.subtype || '').slice(0, 200)}` : 'checker answer unreadable', cost, ...flags }, ev);
  return withRaw({ met: so.met, reason: String(so.reason || ''), cost, ...flags }, ev);
}

module.exports = { taskText, workflowPrompt, isLastLoop, RUN_MODES, MODE_DEFAULTS, normalizeMode, slashPrefix, iterationPrompt, nextStep, judgeArgs, parseJudge, JUDGE_SCHEMA };
