// Scheduled task reminders (t_22fa32e9): task.remindAt (ISO) + optional task.remindEveryMin (>= 30).
const due = (t, now = Date.now()) => !!t.remindAt && Date.parse(t.remindAt) <= now;
// After a send: the first future repeat slot (missed slots skipped, so downtime sends once), or null.
function next(t, now = Date.now()) {
  const every = Number(t.remindEveryMin) * 60000;
  if (!every) return null;
  const at = Date.parse(t.remindAt);
  return new Date(at + (Math.floor((now - at) / every) + 1) * every).toISOString();
}
// ISO time or relative "+30m" / "+2h".
function parseAt(v, now = Date.now()) {
  const rel = /^\+(\d+)([mh])$/.exec(String(v).trim());
  const ms = rel ? now + Number(rel[1]) * (rel[2] === 'h' ? 3600000 : 60000) : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`bad remindAt "${v}": use ISO time or "+30m"/"+2h"`);
  return new Date(ms).toISOString();
}
function parseEvery(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 30) throw new Error('remindEveryMin must be a whole number >= 30');
  return n;
}
const text = (t) => `Scheduled check for task ${t.id} '${t.title}' (status ${t.status}): re-check it and your plan.`;
module.exports = { due, next, parseAt, parseEvery, text };
