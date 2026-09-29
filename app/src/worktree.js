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

// Repo root owning a worktree at <root>/.squad/worktrees/<taskId>; base = the root's current branch.
const rootOf = (t) => path.resolve(t.worktreePath, '..', '..', '..');
const baseOf = (root) => git(root, ['symbolic-ref', '--short', 'HEAD']);
const errOf = (e) => String(e.stderr || e.message).trim();

function worktreeDiff(t) {
  const root = rootOf(t); const base = baseOf(root); const range = `${base}...${t.worktreeBranch}`;
  const files = git(root, ['diff', '--name-status', range]).split('\n').filter(Boolean).map((l) => { const [status, ...f] = l.split('\t'); return { status, file: f.join(' -> ') }; });
  return { base, branch: t.worktreeBranch, files, diff: git(root, ['diff', range]) };
}

// Merge branch into base; on conflict abort so nothing is left half-merged. A branch with no
// commits ahead of base (work landed on a differently-named branch, or a verify-only task) is
// reported as merged:false instead of running a merge that would be a no-op.
function worktreeMerge(t) {
  const root = rootOf(t); const base = baseOf(root);
  let ahead;
  try { ahead = Number(git(root, ['rev-list', '--count', `${base}..${t.worktreeBranch}`])); } catch { ahead = 1; }
  if (ahead === 0) return { base, branch: t.worktreeBranch, merged: false };
  try { git(root, ['merge', '--no-ff', '--no-edit', t.worktreeBranch]); }
  catch (e) { try { git(root, ['merge', '--abort']); } catch {} throw new Error(`merge of ${t.worktreeBranch} into ${base} failed, aborted: ${errOf(e)}`); }
  return { base, branch: t.worktreeBranch, merged: true };
}

function worktreeDiscard(t) {
  const root = rootOf(t);
  try { git(root, ['worktree', 'remove', '--force', t.worktreePath]); } catch (e) { if (fs.existsSync(t.worktreePath)) throw new Error(errOf(e)); }
  try { git(root, ['branch', '-D', t.worktreeBranch]); } catch {}
  return { ok: true };
}

// squad/<taskId> branches in `root` not yet merged (as an ancestor) into the repo's base branch.
function unmergedSquadBranches(root) {
  const base = baseOf(root);
  let branches;
  try { branches = git(root, ['branch', '--list', 'squad/*', '--format=%(refname:short)']).split('\n').filter(Boolean); } catch { return []; }
  return branches
    .filter((b) => { try { git(root, ['merge-base', '--is-ancestor', b, base]); return false; } catch { return true; } })
    .map((branch) => ({ root, base, branch }));
}

module.exports = { ensureWorktree, worktreeDiff, worktreeMerge, worktreeDiscard, unmergedSquadBranches };
