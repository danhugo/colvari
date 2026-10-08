const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
const bar = html.slice(html.indexOf('<footer id="statusbar">'), html.indexOf('</footer>'));

test('passive status lives in the bottom status bar, not the top bar (t_13fabf5a)', () => {
  for (const id of ['limitmeter', 'watchst', 'updst', 'wtdisk', 'totalcost']) {
    assert.ok(!header.includes(`id="${id}"`), `${id} left the header`);
    assert.ok(bar.includes(`id="${id}"`), `${id} is in the status bar`);
  }
  assert.ok(bar.includes('id="sbpop"'), 'status bar has the popover');
  assert.match(bar, /Not what you pay on a Pro\/Max/, 'API-eq tooltip kept');
});

test('top bar keeps run control, New goal, bell, settings, help; theme moved to Settings', () => {
  for (const id of ['runstate', 'runbtn', 'stop', 'newgoal', 'alertbell', 'settingsbtn', 'help']) assert.ok(header.includes(`id="${id}"`), id);
  assert.match(header, /class="runctl"><span id="runstate"[^]*id="stop"/, 'run state + Run/Stop are one control');
  assert.ok(!html.includes('id="themebtn"'), 'theme toggle no longer in the static header');
  assert.ok(fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8').includes('id="themebtn"'), 'theme toggle rendered in Settings');
});

test('run control: Stop only while Running, Run only while Stopped; one size for the cluster (t_53cd3fd7)', () => {
  const js = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  assert.ok(js.includes(`$('#stop').classList.toggle('hidden', rs.state !== 'running')`), 'Idle hides Stop');
  assert.ok(js.includes(`$('#runbtn').classList.toggle('hidden', rs.state !== 'stopped')`), 'Run only when stopped');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  assert.match(css, /--topbar-h:\s*28px/, 'one control height');
  assert.match(header, /id="newgoal" class="primary topbtn"/, 'New goal is the compact primary');
});
