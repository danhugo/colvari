// Optional per-task git worktree: branch squad/<taskId>, dir <repo>/.squad/worktrees/<taskId>.
const { execFileSync, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function git(cwd, args) { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }

// True when a local branch exists in repoDir — the same check ensureWorktree uses, but side-effect
// free (ensureWorktree would CREATE a missing branch).
function branchExists(repoDir, branch) { try { git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } }

// node_modules is shared with the main checkout, not copied: a relative symlink (created lazily;
// an existing dir or symlink is never touched, so a deliberate local copy survives). Keeps new
// worktrees hundreds of MB smaller, and the merge gate's ensureDeps already tolerates a symlink
// (lstat). Falls back to a copy only when the symlink cannot be created (e.g. cross-device).
function linkNodeModules(repoDir, root, dir) {
  const rel = path.relative(root, repoDir);
  const pkgDir = rel ? path.join(dir, rel) : dir;
  const link = path.join(pkgDir, 'node_modules');
  let st; try { st = fs.lstatSync(link); if (st) return; } catch {}
  const src = path.join(repoDir, 'node_modules');
  let dst; try { dst = fs.realpathSync(src); } catch { return; } // main checkout has none: nothing to share
  try { fs.symlinkSync(path.relative(pkgDir, dst), link, 'dir'); }
  catch (e) { if (e.code === 'EXDEV') { try { fs.cpSync(src, link, { recursive: true }); } catch {} } }
}

// Returns { cwd, worktreePath, worktreeBranch } or { cwd, warning } on fallback to the shared repo.
function ensureWorktree(repoDir, taskId) {
  let root;
  try { root = git(repoDir, ['rev-parse', '--show-toplevel']); } catch { return { cwd: repoDir, warning: `not a git repo: ${repoDir}, using shared dir` }; }
  const branch = `squad/${taskId}`;
  const dir = path.join(root, '.squad', 'worktrees', taskId);
  try {
    if (fs.existsSync(path.join(dir, '.git'))) { linkNodeModules(repoDir, root, dir); return { cwd: dir, worktreePath: dir, worktreeBranch: branch }; }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const exists = branchExists(root, branch);
    git(root, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir]);
    linkNodeModules(repoDir, root, dir);
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

// Uncommitted changes in the main checkout (the root repo), ignoring .squad/ — the
// worktree/board files this app manages live there; that is not user work. The raw
// (untrimmed) status is sliced per line: porcelain paths start at column 3, and the
// shared git() helper's blob trim() would eat a first line's leading status space.
function dirtyMainFiles(root) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return out.split('\n').filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => p !== '.squad' && !p.startsWith('.squad/'));
}

const DIRTY_LIST_CAP = 10;
function dirtyMergeMessage(dirty) {
  const shown = dirty.slice(0, DIRTY_LIST_CAP).join(', ');
  const more = dirty.length > DIRTY_LIST_CAP ? ` (+${dirty.length - DIRTY_LIST_CAP} more)` : '';
  return `merge refused: main checkout has uncommitted changes: ${shown}${more}. Commit or clean main, then retry.`;
}

// Merge branch into base; on conflict abort so nothing is left half-merged. A branch with no
// commits ahead of base (work landed on a differently-named branch, or a verify-only task) is
// reported as merged:false instead of running a merge that would be a no-op. A dirty main
// checkout refuses the merge (merged:false, refused:true, dirty file list) instead of letting
// git fail around uncommitted work.
function worktreeMerge(t) {
  const root = rootOf(t); const base = baseOf(root);
  let ahead;
  try { ahead = Number(git(root, ['rev-list', '--count', `${base}..${t.worktreeBranch}`])); } catch { ahead = 1; }
  if (ahead === 0) return { base, branch: t.worktreeBranch, merged: false };
  const dirty = dirtyMainFiles(root);
  if (dirty.length) return { base, branch: t.worktreeBranch, merged: false, refused: true, dirty };
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

// Merge state of `branch` against the repo's base: { base, merged } — merged=true when the branch
// is an ancestor of the base (fully merged), false when it carries unmerged commits. null when the
// repo or its base branch cannot be determined (the caller decides whether that is fatal).
function branchMergeState(root, branch) {
  let base;
  try { base = baseOf(root); } catch { return null; }
  try { git(root, ['merge-base', '--is-ancestor', branch, base]); return { base, merged: true }; } catch { return { base, merged: false }; }
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

// HEAD sha of `dir`'s repo, or null when git fails (not a repo, no git).
function headSha(dir) { try { return git(dir, ['rev-parse', 'HEAD']); } catch { return null; } }

// Commits on `to` that `from` lacks, or null when the range does not resolve.
function commitsBehind(root, from, to) { try { return Number(git(root, ['rev-list', '--count', `${from}..${to}`])); } catch { return null; } }

// ---- lifecycle (t_9b662983): remove on done/merge, orphan sweep, disk usage ----

// node_modules share-links we created (symlinked) among `status` lines: excused from the dirty
// check and unlinked before `git worktree remove` — git's own safety pass still counts the
// untracked link and would refuse without --force (t_1ff80eba). A real dir there never counts
// as ours.
function ourLinks(status, wtPath) {
  const links = new Set();
  for (const l of status.split('\n').filter(Boolean)) {
    if (!l.startsWith('?? ')) continue;
    const p = l.slice(3).replace(/\/$/, '');
    if (p !== 'node_modules' && !p.endsWith('/node_modules')) continue;
    try { if (fs.lstatSync(path.join(wtPath, p)).isSymbolicLink()) links.add(p); } catch {}
  }
  return links;
}

// Uncommitted/untracked changes INSIDE a worktree (ignored files don't count). The node_modules
// share-link we create doesn't count either: on branches cut before the `node_modules` ignore
// landed it shows as untracked (`?? app/node_modules`), so treating our own machinery as user
// work kept done worktrees alive forever (t_1ff80eba). An unreadable tree counts as dirty:
// removal is a courtesy, never a gamble.
function worktreeDirty(wtPath) {
  let out;
  try { out = git(wtPath, ['status', '--porcelain']); } catch { return true; }
  const ours = ourLinks(out, wtPath);
  return out.split('\n').filter(Boolean).some((l) => !l.startsWith('?? ') || !ours.has(l.slice(3).replace(/\/$/, '')));
}

// Remove a task's worktree, KEEP its branch (a reopened task recreates the dir from it via
// ensureWorktree). Safety per Cato's plan review: never --force; refuses a dirty tree and a
// branch that still carries unmerged commits, so a throw means "retain and flag".
// Returns { removed: true } or { removed: false, absent: true } when there is nothing to remove.
function removeWorktree(t) {
  const wp = t && t.worktreePath;
  if (!wp || !fs.existsSync(path.join(wp, '.git'))) return { removed: false, absent: true };
  if (worktreeDirty(wp)) throw new Error('worktree has uncommitted changes');
  // Drop our own share-links first: `git worktree remove` runs its own safety pass, which still
  // counts the untracked link and refuses without --force (t_1ff80eba). Only ever the link —
  // a real dir stays and keeps the refusal.
  let st; try { st = git(wp, ['status', '--porcelain']); } catch { st = ''; }
  for (const p of ourLinks(st, wp)) { try { fs.unlinkSync(path.join(wp, p)); } catch {} }
  const root = rootOf(t);
  if (t.worktreeBranch && branchExists(root, t.worktreeBranch)) {
    const st = branchMergeState(root, t.worktreeBranch);
    if (st && !st.merged) throw new Error(`branch ${t.worktreeBranch} still has unmerged commits`);
  }
  try { git(root, ['worktree', 'remove', wp]); } catch (e) { throw new Error(`git worktree remove refused: ${errOf(e)}`); }
  return { removed: true };
}

// Registered worktrees of `root`: [{ path, branch, detached, locked }] (the main tree included).
function listWorktrees(root) {
  const wts = [];
  for (const block of git(root, ['worktree', 'list', '--porcelain']).split('\n\n')) {
    const m = {};
    for (const l of block.split('\n')) {
      const i = l.indexOf(' ');
      if (i > 0) m[l.slice(0, i)] = l.slice(i + 1);
      else if (l === 'detached') m.detached = true;
      else if (l === 'locked') m.locked = true;
    }
    if (m.worktree) wts.push({ path: m.worktree, branch: m.branch ? m.branch.replace(/^refs\/heads\//, '') : null, detached: !!m.detached, locked: !!m.locked });
  }
  return wts;
}

// A registered worktree outside .squad/worktrees is not task machinery; when it matches a squad
// throwaway shape it is ours to reap (t_1ff80eba): merge-gate base sanity checkouts that died
// between add and remove (squad-gate-base-*, in os.tmpdir()), and scratch dirs (squad-*,
// tmp.*/wt). Only a CLEAN tree goes — a dirty one might be someone's checkout, so it is
// reported, not destroyed. Locked entries are never touched. Branches are always kept.
const STRAY_WT = /\/(squad-[^/]+|tmp\.[^/]+\/wt)$/;

function reapStrayWorktrees(root, report) {
  const managed = path.join(root, '.squad', 'worktrees') + path.sep;
  for (const w of listWorktrees(root)) {
    const p = w.path;
    if (w.locked || p === root || p.startsWith(managed) || !STRAY_WT.test(p)) continue;
    if (!fs.existsSync(path.join(p, '.git'))) { report.strays.push(p); continue; } // vanished: prune drops the entry
    if (worktreeDirty(p)) { report.retained.push({ dir: p, reason: 'stray worktree retained: dirty' }); continue; }
    try { git(root, ['worktree', 'remove', p]); report.strays.push(p); }
    catch (e) { report.retained.push({ dir: p, reason: `stray worktree retained: ${errOf(e) || 'remove failed'}` }); }
  }
}

function pruneWorktrees(root) { try { git(root, ['worktree', 'prune']); return true; } catch { return false; } }

const wtDirNames = (root) => {
  const wtRoot = path.join(root, '.squad', 'worktrees');
  try { return fs.readdirSync(wtRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(wtRoot, d.name, '.git'))).map((d) => d.name); } catch { return []; }
};

// Sweep a repo's .squad/worktrees: a dir is removed only when every task referencing it is done
// (a conflict task reuses its parent's dir) with a fully merged branch and a clean tree — or when
// NO task references it at all (orphan). Tasks still in flight — any non-done status, or one of
// busyTaskIds — always retain their worktree, and a board read error proves nothing about
// orphans (the sweep no-ops). Stray gate/tmp registrations outside .squad/worktrees are reaped
// independently of the board (t_1ff80eba). Ends with `git worktree prune`; never uses --force.
// Returns { removed: [ids], retained: [{dir, reason}], strays: [paths], pruned } for callers to
// log/assert.
function sweepWorktrees(opts = {}) {
  const { repoDir, store, busyTaskIds = [], log = () => {} } = opts;
  const report = { removed: [], retained: [], strays: [], pruned: false };
  let root;
  try { root = git(repoDir, ['rev-parse', '--show-toplevel']); } catch { report.skipped = `not a git repo: ${repoDir}`; return report; }
  reapStrayWorktrees(root, report);
  let tasks;
  try { tasks = store.listTasks(); } catch { report.skipped = 'board unreadable — not proof of orphans'; return report; }
  const busy = new Set(busyTaskIds);
  const refs = new Map(); // resolved worktree path -> tasks pointing at it
  for (const t of tasks) if (t.worktreePath) { const k = path.resolve(t.worktreePath); if (!refs.has(k)) refs.set(k, []); refs.get(k).push(t); }
  for (const name of wtDirNames(root)) {
    const dir = path.join(root, '.squad', 'worktrees', name);
    let owners = (refs.get(path.resolve(dir)) || []).slice();
    if (!owners.length) {
      let t; try { t = store.getTask(name); } catch { report.retained.push({ dir: name, reason: 'task lookup failed' }); continue; }
      if (t) owners = [t]; // no board entry at all -> orphan, removable below
    }
    let reason = null;
    for (const t of owners) {
      if (busy.has(t.id)) { reason = `task ${t.id} is dispatched`; break; }
      if (t.status !== 'done') { reason = `task ${t.id} is ${t.status}`; break; }
    }
    if (!reason) {
      try {
        removeWorktree({ worktreePath: dir, worktreeBranch: `squad/${name}` });
        report.removed.push(name);
        for (const t of owners) { try { store.updateTask(t.id, { worktreePath: null, worktreeBranch: null }); } catch {} }
      } catch (e) { reason = String(e.message).slice(0, 200); }
    }
    if (reason) {
      report.retained.push({ dir: name, reason });
      // Flag it on the task a human would look at; in-flight tasks get no comment spam.
      for (const t of owners) if (t.status === 'done') { try { store.commentTask(t.id, 'system', `worktree retained: ${reason}`); } catch {} }
    }
  }
  report.pruned = pruneWorktrees(root);
  if (report.removed.length || report.retained.length || report.strays.length) log(report);
  return report;
}

const DU = { TTL_MS: 30_000 };
const duCache = new Map(); // repo root -> { at, val }
// Disk use of a repo's .squad/worktrees: { count, bytes }. bytes via `du -sk` (never follows
// symlinks, so a linked node_modules costs only the link); cached for a TTL so a header poll
// cannot hammer the filesystem. Async — callers (IPC) must not block the main process.
async function diskUsage(repoDir, opts = {}) {
  const ttl = opts.ttlMs ?? DU.TTL_MS;
  let root;
  try { root = git(repoDir, ['rev-parse', '--show-toplevel']); } catch { return { count: 0, bytes: 0 }; }
  const cached = duCache.get(root);
  if (!opts.force && cached && Date.now() - cached.at < ttl) return cached.val;
  const names = wtDirNames(root);
  const bytes = names.length ? await new Promise((resolve) => {
    execFile('du', ['-sk', path.join(root, '.squad', 'worktrees')], (e, out) => resolve(e ? 0 : (Number(String(out).split('\t')[0]) * 1024 || 0)));
  }) : 0;
  const val = { count: names.length, bytes };
  duCache.set(root, { at: Date.now(), val });
  return val;
}

module.exports = { ensureWorktree, branchExists, worktreeDiff, worktreeMerge, worktreeDiscard, unmergedSquadBranches, branchMergeState, dirtyMergeMessage, dirtyMainFiles, headSha, commitsBehind, removeWorktree, sweepWorktrees, pruneWorktrees, diskUsage, worktreeDirty, listWorktrees };
