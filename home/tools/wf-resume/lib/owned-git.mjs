// The git worktrees and local branches a workflow run owns, so the resume notice can say what a stopped run left behind.
// Exports: ownedGit(record) -> { worktrees: [{ path, branch }], branches: string[] }, empty when nothing matches or git cannot answer.
// How: the run's stored args name its repo, base, branches and worktree paths in plain string fields (`repo`, `branch`, `worktree`,
// `lanes[].branch`...). Every string in the args is a candidate; a local branch or a worktree (other than the repo's own folder) whose
// name or path equals a candidate is the run's. The base branch is never listed.
// Invariants: read-only git (`worktree list --porcelain`, `for-each-ref`), run with the repository hooks and fsmonitor off through
// git-tidy's runGit (explicit cwd, no GIT_DIR from the caller); never throws; at most MAX_LISTED of each; only the git answers reach the
// output, never args text.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runGit } from '../../git-tidy/lib/git.mjs';

const MAX_LISTED = 3;
const MAX_CANDIDATES = 300;
const MAX_DEPTH = 4;
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.bareRepository=explicit', '-c', 'core.pager=cat'];
const BRANCH_PREFIX = 'refs/heads/';

/** Every string value inside the args (objects and arrays to MAX_DEPTH, at most MAX_CANDIDATES strings). */
function stringsOf(value, found = new Set(), depth = 0) {
  if (found.size >= MAX_CANDIDATES || depth > MAX_DEPTH) return found;
  if (typeof value === 'string') found.add(value);
  else if (value !== null && typeof value === 'object') for (const inner of Object.values(value)) stringsOf(inner, found, depth + 1);
  return found;
}

const isFolder = (path) => typeof path === 'string' && isAbsolute(path) && existsSync(path) && statSync(path).isDirectory();
const git = (dir, args) => runGit(dir, [...HARDENED, ...args]);

/** The worktrees of the repo as { path, branch | null }, main checkout first. */
function worktreesOf(dir) {
  const { status, stdout } = git(dir, ['worktree', 'list', '--porcelain']);
  if (status !== 0) return [];
  return stdout.split('\n\n').flatMap((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch (.+)$/m.exec(block)?.[1];
    return path === undefined ? [] : [{ path, branch: branch?.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : null }];
  });
}

/**
 * @param {{ args?: unknown, cwd: string }} record the registry record: stored args and the cwd of the launch
 * @returns {{ worktrees: { path: string, branch: string | null }[], branches: string[] }}
 */
export function ownedGit(record) {
  const empty = { worktrees: [], branches: [] };
  try {
    const named = record.args !== null && typeof record.args === 'object' ? record.args : {};
    const candidates = stringsOf(record.args);
    const repo = isFolder(named.repo) ? named.repo : record.cwd;
    if (candidates.size === 0 || !isFolder(repo)) return empty;
    const refs = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (refs.status !== 0) return empty;
    const branches = refs.stdout.split('\n').filter((name) => name !== '' && name !== named.base && candidates.has(name));
    const [, ...others] = worktreesOf(repo); // the first entry is the repo's own checkout, never a lane's
    const worktrees = others.filter((tree) => (candidates.has(tree.path) || (tree.branch !== null && branches.includes(tree.branch))));
    return { worktrees: worktrees.slice(0, MAX_LISTED), branches: branches.slice(0, MAX_LISTED) };
  } catch {
    return empty;
  }
}
