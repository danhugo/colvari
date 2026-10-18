// Per-project pushes (t_edfe3aeb): main.js sends restart-state / watch-status / self-update-status
// for every open project, tagged with projectId. The renderer handlers must ignore pushes for
// other projects, or another project's restartPending leaks into the current view.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const line = (name) => { const m = src.match(new RegExp(`^const ${name} = .*$`, 'm')); assert.ok(m, name + ' found'); return m[0]; };

for (const [name, varName] of [['onUpdPush', 'upd'], ['onRestartPush', 'rst'], ['onWatchPush', 'watch']]) {
  test(`${name} ignores pushes from another project`, () => {
    const fn = new Function('ctx', `let upd = 'old', rst = 'old', watch = 'old', rstSeen, boardSig;
      const noop = () => {}; const normUpd = (d) => d, normRestart = (d) => d, normWatch = (d) => d;
      const trackUpd = noop, clearRstToast = noop, renderSelfUpdate = noop, renderUpdSettings = noop,
        renderAlerts = noop, renderHeader = noop, renderBoard = noop, rstArmed = () => false;
      ${line(name)}
      ${name}({ projectId: 'p_other', state: 'x', pendingCount: 8 }); const a = ${varName};
      ${name}({ projectId: 'p_me', state: 'x', pendingCount: 0 }); return [a, ${varName}];`);
    const [afterOther, afterMine] = fn({ p: 'p_me' });
    assert.strictEqual(afterOther, 'old');
    assert.notStrictEqual(afterMine, 'old');
  });
}
