// Auto-reload guard for a crashed renderer: at most 3 reloads per 60s, so a crash loop cannot
// spin forever. Pure: `history` is a timestamps list this mutates; returns whether to reload now.
const MAX = 3, WINDOW_MS = 60_000;
function allowReload(history, now) {
  while (history.length && now - history[0] >= WINDOW_MS) history.shift();
  if (history.length >= MAX) return false;
  history.push(now);
  return true;
}
module.exports = { allowReload };
