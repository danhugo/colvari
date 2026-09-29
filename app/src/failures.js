// Runtime failure classification + redaction (t_419062e2). Pure functions, no I/O.
// classifyFailure FAILS OPEN: only matched auth or model-missing patterns return a kind —
// anything unknown or ambiguous returns null and never trips the breaker by itself.
const FAIL = {
  FAST_MS: 30 * 1000, // an exit faster than this is a "fast" failure (read at failure time)
  STREAK_MAX: 3,      // consecutive fast failures with the same signature trip the breaker
  TAIL_CAP: 2048,     // max chars of stderr tail kept on any surface
};

const AUTH_RE = /(not logged in|login required|please run [`"']?[a-z]* ?login|invalid[^\n]{0,30}(api[ -]?key|x-api-key)|\b401\b|unauthorized|authentication[^\n]{0,20}(error|failed))/i;
const MODEL_RE = /(model[._ -]?not[._ -]?found|no such model|unknown model|model[^\n]{0,40}(does not exist|is not available)|invalid model)/i;

function classifyFailure(text) {
  const s = String(text || '');
  if (AUTH_RE.test(s)) return 'auth';
  if (MODEL_RE.test(s)) return 'model';
  return null;
}

// Redact BEFORE anything surfaces (logs, comments, banner payload, inbox): bearer headers,
// api-key/token values, long hex blobs. Classification wording survives the masking.
function redactError(text) {
  let s = String(text || '');
  s = s.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b(sk|key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, '[REDACTED]');
  s = s.replace(/((?:api[ -]?key|x-api-key|token|password|secret)\s*[=:]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]');
  if (s.length > FAIL.TAIL_CAP) s = s.slice(-FAIL.TAIL_CAP); // keep the tail: the error summary lives at the end
  return s;
}

module.exports = { classifyFailure, redactError, FAIL };
