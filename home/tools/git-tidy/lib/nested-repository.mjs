// Purpose: find the git repositories nested in a folder (inside node_modules, a scratch clone in an ignored folder), which a
//   folder removal, `git clean -ffdx` or an install would delete with commits that may be their only copy.
// Exports: nestedRepositoryPaths, nestedRepositoryWhy.
// Invariants: reads only, through runGit. A list git cannot give is never read as no repository: nestedRepositoryPaths returns
//   null and nestedRepositoryWhy a reason, so the caller keeps the folder.
import { runGit } from './git.mjs';

const SHOWN_PATHS = 5;

/**
 * The git repositories nested in `folder`, as `git ls-files -z --others` lists them (relative to it, with a trailing slash), or null
 * when git cannot list them (callers then keep what they guard). With no exclude option it lists every untracked path, ignored ones
 * too, and a nested repository as its folder; `-z` prints each name as it is, and nothing in the list is translated (git clean's
 * "Would skip repository" lines are, and C-quote a non-ASCII name, so a non-English git or a name like `pké` hid the repository).
 */
export function nestedRepositoryPaths(folder) {
  const listed = runGit(folder, ['ls-files', '-z', '--others']);
  if (listed.status !== 0) return null;
  return listed.stdout.split('\0').filter((path) => path.endsWith('/'));
}

/**
 * Why a git repository nested in `folder` forbids removing it (git worktree remove or `clean -ffdx` would delete it with its
 * commits), or null. lane-slots, prune and land guard their removals with it.
 */
export function nestedRepositoryWhy(folder) {
  const repositories = nestedRepositoryPaths(folder);
  if (repositories === null) return 'git cannot list its untracked and ignored files';
  return repositories.length === 0 ? null : `a git repository inside an ignored folder (${repositories.slice(0, SHOWN_PATHS).join(', ')})`;
}
