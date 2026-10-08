// Logs boot team (t_78d98406): on boot refresh() copied the sidebar team into the Chat and Board
// filters but not Logs, so Logs opened on "All teams" and listed other teams' agents until the
// team was clicked again. Extract the real boot line from renderer/app.js and run it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const line = src.split('\n').find((l) => l.trim().startsWith('if (bootTeam && ctx.t)'));
assert.ok(line, 'boot team line found in renderer/app.js');

test('boot syncs the Logs team filter to the sidebar team, like Chat and Board', () => {
  const run = new Function('ctx', 'sel', `let bootTeam = true; const $ = () => ({ value: 'x' }); ${line}\nreturn sel;`);
  const sel = run({ p: 'p1', t: 'core' }, { logTeam: '', chatTeam: '', boardTeam: '' });
  assert.deepStrictEqual([sel.logTeam, sel.chatTeam, sel.boardTeam], ['core', 'core', 'core']);
});
