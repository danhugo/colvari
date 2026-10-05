'use strict';
// Sandbox guard (t_8f7605c4): harness instances (gui-e2e, smoke, the perf mains) spawn REAL
// agent CLIs, and a leaked run once had those agents wander out of the throwaway data root into
// the developer's real repo — seeded tasks were "fixed" there, squad/<id> worktrees appeared in
// the real .squad/worktrees and the auto-merge landed seed commits on the real master. Every
// boundary an agent can reach from harness state is therefore verified against one root:
//   - AGENTS_SQUAD_TEST_ROOT: set by src/main.js for every test instance (never in production),
//     inherited by the app's own merge/worktree/dispatch paths, which refuse to touch anything
//     outside it. Unit tests and production never set it, so the guards are inert there.
//   - assertSandboxed: harness-side startup check — hard-fails before any agent starts unless
//     every node workdir, the worktrees root and the merge target resolve inside the data root.
// Killing and git operations stay keyed on resolved paths/pids only; nothing is matched by name.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TEST_ROOT_ENV = 'AGENTS_SQUAD_TEST_ROOT';

const testRoot = () => process.env[TEST_ROOT_ENV] || null;

function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// True when p is root itself or lies under it (lexicographic on realpaths when they exist).
function inside(root, p) {
  if (!root || !p) return false;
  const rel = path.relative(safeReal(root), safeReal(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// The refusal message when root is outside the instance's test data root, or null when allowed
// (no test root set = production = always allowed).
function refusal(root, what) {
  const tr = testRoot();
  if (!tr || inside(tr, root)) return null;
  return `sandbox: refusing to ${what} in ${root} — outside the test data root ${tr} (t_8f7605c4)`;
}

// Throw when the resolved repo root is outside the test data root. Used at every app-side choke
// point that mutates a repo (worktree create/merge/discard).
function guardRepo(root, what) {
  const msg = refusal(root, what);
  if (msg) throw new Error(msg);
  return root;
}

// Harness startup gate: every entry must resolve inside dataRoot — one bad path fails the run
// before any agent is spawned. entries: [{ label, path }].
function assertSandboxed(dataRoot, entries) {
  for (const e of entries) {
    if (!inside(dataRoot, e.path)) throw new Error(`[sandbox] ${e.label} escapes the harness data root: ${e.path} (root ${dataRoot}, t_8f7605c4)`);
  }
}

// The throwaway git repo agents work in: <dataRoot>/agent-repo (master, one initial commit).
// Idempotent — a second call on the same root is a no-op.
function agentRepo(dataRoot) {
  const dir = path.join(dataRoot, 'agent-repo');
  const g = (...a) => execFileSync('git', ['-c', 'user.email=perf@harness', '-c', 'user.name=perf-harness', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    g('init', '-q', '-b', 'master');
    fs.writeFileSync(path.join(dir, 'README.md'), '# perf harness sandbox repo\n\nAgents seeded by the perf harness work here, never in a real repo.\n');
    g('add', '.');
    g('commit', '-q', '-m', 'sandbox init');
  }
  return dir;
}

// One private clone per agent so runs never share a workdir (the app only spawns task worktrees
// for shared cwds — clones keep useWorktrees:false meaningful). Idempotent.
function agentWorkspace(dataRoot, i) {
  const base = agentRepo(dataRoot);
  const dir = path.join(dataRoot, `agent-ws-${i}`);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['clone', '-q', base, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-c', 'user.email=perf@harness', '-c', 'user.name=perf-harness', 'commit', '-q', '--allow-empty', '-m', 'ws init', '--'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return dir;
}

// Harness startup gate: dir must be inside a git repo whose root resolves inside dataRoot —
// an agent's git work (worktrees, commits, merges) can then never touch a real repo.
function assertGitInside(dataRoot, dir, label) {
  let toplevel;
  try { toplevel = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error(`[sandbox] ${label} is not inside a git repo: ${dir} — agents would have nowhere contained to work (t_8f7605c4)`); }
  assertSandboxed(dataRoot, [{ label: `${label} git root`, path: toplevel }]);
  return toplevel;
}

module.exports = { TEST_ROOT_ENV, testRoot, inside, refusal, guardRepo, assertSandboxed, assertGitInside, agentRepo, agentWorkspace };
