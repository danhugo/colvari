// Guards against a recurring bug class: e2e/orchestrator runs writing state
// (projects/, e2e-shots/, etc.) into the tracked repo instead of an isolated dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { ProjectManager } = require('../src/projects');
const { Orchestrator } = require('../src/orchestrator');

const repoRoot = path.join(__dirname, '..', '..');

function gitStatus() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString();
}

test('default project root stays outside the repo checkout', () => {
  delete process.env.AGENTS_SQUAD_HOME; delete process.env.AGENTS_SQUAD_PROJECT;
  const pm = new ProjectManager();
  assert.ok(!pm.root.startsWith(repoRoot), `project root ${pm.root} must not be inside the repo`);
});

test('running an orchestrator job from the repo cwd leaves git status clean', async () => {
  const before = gitStatus();
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-repoclean-'));
  const fake = path.join(r, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"type":"result","subtype":"success","total_cost_usd":0.01,"num_turns":1,"usage":{}}\'\n');
  fs.chmodSync(fake, 0o755);
  const pm = new ProjectManager(r);
  const pid = pm.list()[0].id;
  const s = pm.store(pid);
  s.saveSettings({ claudePath: fake });
  const node = s.getTeam().nodes[0] || s.addNode({ name: 'D', role: 'Dev', workdir: r });
  s.createTask({ title: 'repo-clean job', assignee: node.id });
  const orch = new Orchestrator(s);
  const cwdBefore = process.cwd();
  process.chdir(repoRoot);
  try {
    await new Promise((res) => { orch.on('done', res); orch.start(); });
  } finally {
    process.chdir(cwdBefore);
  }
  assert.equal(gitStatus(), before, 'orchestrator run must not modify the tracked repo checkout');
});
