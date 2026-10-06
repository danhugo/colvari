// Async child-process helpers (t_5a78aa95): nothing on the Electron main path may block on a
// child. Promisified execFile with a hard timeout — results mirror the legacy sync-API
// result shape ({status, stdout, stderr, error, signal}) so sync call sites convert
// mechanically; a non-zero exit is a RESULT (status), not a rejection, like its sync
// counterpart. runThrow restores the sync-exec contract (throw on failure; the error
// carries .stderr for the errOf-style callers).
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60_000;

function run(cmd, args, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = opts;
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, ...rest }, (err, stdout, stderr) => {
        resolve({
          status: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          signal: err ? (err.signal || (err.killed ? 'SIGKILL' : null)) : null,
          error: err || null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      });
    } catch (e) {
      resolve({ status: 1, signal: null, error: e, stdout: '', stderr: String((e && e.message) || e) });
    }
  });
}

// Sync-exec twin: trim stdout, throw on spawn/exit failure. The error carries
// {status, stdout, stderr} so String(e.stderr || e.message) call sites keep working.
async function runThrow(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.error || r.status !== 0) {
    const detail = (r.stderr || (r.error && r.error.message) || '').trim() || `exit ${r.status}`;
    const e = new Error(`${cmd} ${args.join(' ')} failed: ${detail}`);
    e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr;
    if (r.error && r.error.code) e.code = r.error.code;
    throw e;
  }
  return r.stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { run, runThrow, sleep, DEFAULT_TIMEOUT_MS };
