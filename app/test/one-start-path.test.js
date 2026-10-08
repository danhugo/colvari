const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

test('no New goal button or popover: chat is the only way to start work (t_1efad5d8)', () => {
  for (const id of ['newgoal', 'goalpop', 'goal', 'run']) assert.ok(!html.includes(`id="${id}"`), `#${id} removed`);
  assert.ok(!/\$\('#(goal|run|newgoal|goalpop)'\)/.test(js), 'nothing reads the old popover');
});

test('Run with no todo focuses the chat composer; chat start runs the preflight confirm (t_1efad5d8)', () => {
  const start = js.slice(js.indexOf('async function startRun'), js.indexOf('\n}', js.indexOf('async function startRun')));
  assert.match(start, /todo[^]*focusComposer\(\)/, 'no todo -> focus composer');
  const send = js.slice(js.indexOf('async function chatSend'), js.indexOf('\n}', js.indexOf('async function chatSend')));
  assert.match(send, /!S\.orch\.running && !preflightOk\(\)/, 'chat start asks when preflight failed');
  assert.match(js, /\$\('#g-start'\)\.onclick[^\n]*chatSend/, 'onboarding goes through chat');
});

test('Run mode sits under Advanced; Goal disabled only without resume (t_1efad5d8)', () => {
  assert.match(js, /<details id="nf-adv"><summary>Advanced<\/summary>\s*<fieldset id="nf-modebox">/);
  assert.match(js, /option\[value=goal\]'\)\.disabled = !r\.capabilities\.resume/);
});
