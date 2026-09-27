// Optional per-task git worktree: branch squad/<taskId>, dir <repo>/.squad/worktrees/<taskId>.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function git(cwd, args) { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }

// Returns { cwd, worktreePath, worktreeBranch } or { cwd, warning } on fallback to the shared repo.
function ensureWorktree(repoDir, taskId) {
  let root;
  try { root = git(repoDir, ['rev-parse', '--show-toplevel']); } catch { return { cwd: repoDir, warning: `not a git repo: ${repoDir}, using shared dir` }; }
  const branch = `squad/${taskId}`;
  const dir = path.join(root, '.squad', 'worktrees', taskId);
  try {
    if (fs.existsSync(path.join(dir, '.git'))) return { cwd: dir, worktreePath: dir, worktreeBranch: branch };
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    let exists = true; try { git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); } catch { exists = false; }
    git(root, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir]);
    return { cwd: dir, worktreePath: dir, worktreeBranch: branch };
  } catch (e) { return { cwd: repoDir, warning: `worktree creation failed (${String(e.stderr || e.message).trim()}), using shared dir` }; }
}

module.exports = { ensureWorktree };
