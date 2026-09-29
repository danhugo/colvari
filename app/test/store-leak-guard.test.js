// Guard against the "Red demo" leak class (p_733df3a8, 2026-09-29): a demo driver called
// createProject with no isolation env, so the project landed in the user's real ~/.agents-squad.
// Every run must point AGENTS_SQUAD_PROJECT at a temp store, and nothing may write the real one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultRoot } = require('../src/projects');

const REAL_ROOT = path.join(os.homedir(), '.agents-squad');
const REAL_PROJECTS = path.join(REAL_ROOT, 'projects');

// Snapshot the real store while this file loads: one entry per project dir with the exact bytes
// of its project.json (null when the file is unreadable — concurrent live-app churn, skipped later).
function snapshot() {
  if (!fs.existsSync(REAL_PROJECTS)) return { exists: false, files: {} };
  const files = {};
  for (const d of fs.readdirSync(REAL_PROJECTS)) {
    try { files[d] = fs.readFileSync(path.join(REAL_PROJECTS, d, 'project.json'), 'utf8'); } catch { files[d] = null; }
  }
  return { exists: true, files };
}
const before = snapshot();

test('test runs are isolated: the data root is a temp store, never the real one', () => {
  if (!process.env.AGENTS_SQUAD_TEST_ISOLATION) {
    assert.fail('tests are not isolated — run the suite via `npm test` (or `npm run e2e`), which sets AGENTS_SQUAD_PROJECT to a fresh temp dir; a bare `node --test` run can write the user\'s real ~/.agents-squad');
  }
  const root = defaultRoot();
  assert.ok(root.startsWith(os.tmpdir()), `data root ${root} must be a temp dir, not the real store`);
  assert.notEqual(root, REAL_ROOT);
});

test('no test wrote to the real store during this run', () => {
  const after = snapshot();
  if (!after.exists) return;
  const created = Object.keys(after.files).filter((id) => !(id in before.files));
  assert.deepStrictEqual(created, [],
    `new project(s) appeared in the REAL store during the run: ${created.join(', ')} — a test/demo bypassed the isolation env and wrote ~/.agents-squad`);
  for (const id of Object.keys(before.files)) {
    if (before.files[id] === null) continue; // unreadable at snapshot time (live app) — nothing to compare
    if (after.files[id] === undefined) continue; // removed mid-run — only the human does this
    assert.equal(after.files[id], before.files[id],
      `project.json of ${id} changed in the REAL store during the run — a test bypassed the isolation env and wrote ~/.agents-squad (a false positive here would mean the live app rewrote it while the suite ran; re-run to confirm)`);
  }
});
