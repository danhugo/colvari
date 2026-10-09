const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { noMcpCommitComment } = require('../src/orchestrator');
const RT = require('../src/runtimes');

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomcp-')); const wt = root + '-wt';
  g(root, 'init', '-q', '-b', 'main'); g(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  g(root, 'worktree', 'add', '-q', '-b', 'squad/t1', wt);
  return { root, wt };
}
const fakeStore = () => { const c = []; return { c, commentTask: (id, who, text) => c.push({ id, who, text }) }; };

test('no-MCP runtime exit 0 with commits: comment lists them oneline', async () => {
  const { root, wt } = repo(); const st = fakeStore();
  g(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'did the thing');
  assert.strictEqual(await noMcpCommitComment(st, 't1', RT.getRuntime('pi'), {}, root, wt), true);
  assert.match(st.c[0].text, /New commits:\n[0-9a-f]+ did the thing/);
});

test('no-MCP runtime exit 0 without commits: says so', async () => {
  const { root, wt } = repo(); const st = fakeStore();
  await noMcpCommitComment(st, 't1', RT.getRuntime('pi'), {}, root, wt);
  assert.match(st.c[0].text, /No new commits/);
});

test('MCP runtimes get no auto comment', async () => {
  const { root, wt } = repo(); const st = fakeStore();
  assert.strictEqual(await noMcpCommitComment(st, 't1', RT.getRuntime('claude'), {}, root, wt), false);
  assert.strictEqual(st.c.length, 0);
});
