// Guards for the 2026-09-29 13:32 incident: a helpycode agent ran `pkill -f "Electron.app"` and
// killed the live app's renderer helpers; main survived but the window never came back. Two
// guards: rate-limited auto-reload of a crashed renderer, and a never-pkill rule in the shared
// agent prompt that every runtime receives.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { allowReload } = require('../src/renderer-reload');
const { buildPrompt } = require('../src/orchestrator');
const { Store } = require('../src/store');

test('renderer reload: allows 3 crashes per minute, refuses the 4th, works again after 60s', () => {
  const hist = []; const t0 = 1_000_000;
  assert.equal(allowReload(hist, t0), true);
  assert.equal(allowReload(hist, t0 + 1000), true);
  assert.equal(allowReload(hist, t0 + 2000), true);
  assert.equal(allowReload(hist, t0 + 3000), false, '4th reload within 60s must be refused');
  assert.equal(allowReload(hist, t0 + 60_001), true, 'after the window passes it works again');
});

test('renderer reload: old crashes are pruned so it stays 3 per sliding minute, not 3 ever', () => {
  const hist = []; const t0 = 1_000_000;
  allowReload(hist, t0);
  allowReload(hist, t0 + 30_000);
  allowReload(hist, t0 + 45_000);
  assert.equal(allowReload(hist, t0 + 61_000), true, 'first crash pruned from the window');
  assert.equal(allowReload(hist, t0 + 62_000), false, 'sliding window is full again');
});

test('agent prompt forbids pkill/killall by name and says how to stop an own job', () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-reload-')));
  const node = s.addNode({ name: 'A', role: 'Dev' });
  const p = buildPrompt(s.getTeam(), s.getTeam().nodes.find((n) => n.id === node.id), { id: 't1', title: 'T', comments: [] });
  assert.match(p, /Never pkill\/killall\/pgrep-kill by name/);
  assert.match(p, /kill the PID you started/);
  assert.match(p, /job[- ]stop/);
});
