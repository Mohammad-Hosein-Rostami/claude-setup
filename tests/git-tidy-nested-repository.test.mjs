// Tests that a git repository inside an ignored folder is found by its raw path (home/tools/git-tidy/lib/nested-repository.mjs): a name
// like `pké` or `p"k` is no longer C-quoted by git clean's text, so land's clean-up and prune keep the worktree and name the folder as
// it is on disk, and git failing to list the files is never read as "no repository". Every repository is a throw-away one in the OS temp
// folder (git-tidy-helpers.mjs); every child gets its own temp HOME, USERPROFILE and TMPDIR, so nothing reads or writes the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nestedRepositoryPaths, nestedRepositoryWhy } from '../home/tools/git-tidy/lib/nested-repository.mjs';
import { CLEAN_ENV, addWorktree, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'lane/n';
const IGNORED_FOLDER = 'scratch';
const REBUILDABLE_FOLDER = 'node_modules'; // prune's ignored-files rule skips it, so only the nested-repository rule can keep the worktree
const ACCENTED_NAME = 'pké'; // git clean prints it C-quoted as "pk\303\251/"
const QUOTED_NAME = 'p"k'; // git clean prints it C-quoted as "p\"k/"
const NO_QUOTE_IN_NAMES = { skip: process.platform === 'win32' && 'Windows does not allow a double quote in a file name' };
const NOT_LISTED_WHY = 'git cannot list its untracked and ignored files';

/** An environment of one test: its own HOME, USERPROFILE and TMPDIR (nothing of the real ~/.claude). */
function privateEnv() {
  const home = realpathSync(makeTempDir('nested-repository-home-'));
  const tmp = realpathSync(makeTempDir('nested-repository-tmp-'));
  return { HOME: home, USERPROFILE: home, TMPDIR: tmp };
}

/** A repo whose `.gitignore` ignores `ignoredFolder`, so a repository inside it is invisible to `git status`. */
function repoIgnoring(ignoredFolder = IGNORED_FOLDER) {
  const repo = makeRepo();
  commit(repo, '.gitignore', `${ignoredFolder}/\n`);
  return repo;
}

/** Makes a git repository with one commit at `<folder>/<ignoredFolder>/<name>`; returns its folder and that commit. */
function addNestedRepo(folder, name, ignoredFolder = IGNORED_FOLDER) {
  const nested = join(folder, ignoredFolder, name);
  mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q', '-b', 'main');
  return { nested, nestedCommit: commit(nested, 'patch.txt', 'my patch to the dependency\n') };
}

test('nestedRepositoryPaths gives the repositories in ignored folders as they are on disk, with a trailing slash, and the why names them', () => {
  const repo = repoIgnoring();
  const names = [ACCENTED_NAME, ...(NO_QUOTE_IN_NAMES.skip ? [] : [QUOTED_NAME])];
  for (const name of names) addNestedRepo(repo, name);

  const paths = nestedRepositoryPaths(repo);

  assert.deepEqual(paths?.toSorted(), names.map((name) => `${IGNORED_FOLDER}/${name}/`).toSorted());
  assert.equal(nestedRepositoryWhy(repo), `a git repository inside an ignored folder (${paths.join(', ')})`);
});

test('nestedRepositoryPaths gives no path and nestedRepositoryWhy no reason for a repository without a nested repository', () => {
  const repo = repoIgnoring();
  mkdirSync(join(repo, IGNORED_FOLDER));
  commit(repo, 'plain.txt');

  assert.deepEqual(nestedRepositoryPaths(repo), []);
  assert.equal(nestedRepositoryWhy(repo), null);
});

test('a folder git cannot list is no "no repository": nestedRepositoryPaths gives null and nestedRepositoryWhy says git cannot list', () => {
  const notRepository = realpathSync(makeTempDir('nested-repository-plain-'));

  assert.equal(nestedRepositoryPaths(notRepository), null);
  assert.equal(nestedRepositoryWhy(notRepository), NOT_LISTED_WHY);
});

test('land lands a lane, then refuses to remove its plain worktree that holds nested repositories named pké and p"k, naming both paths as they are on disk', NO_QUOTE_IN_NAMES, () => {
  const repo = repoIgnoring();
  const folder = addWorktree(repo, 'plain-lane', LANE);
  const laneTip = commit(folder, 'lane.txt');
  const nestedRepos = [ACCENTED_NAME, QUOTED_NAME].map((name) => addNestedRepo(folder, name));
  assert.equal(git(folder, 'status', '--porcelain'), '', 'precondition: the nested repositories are invisible to the lane');
  const env = privateEnv();

  const result = spawnSync(process.execPath, [LAND, LANE, '--repo', repo], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(git(repo, 'rev-parse', 'main'), laneTip, 'the lane landed on main');
  for (const name of [ACCENTED_NAME, QUOTED_NAME]) {
    const raw = join(folder, IGNORED_FOLDER, `${name}/`);
    assert.ok(result.stderr.includes(raw), `the message names ${raw}: ${result.stderr}`);
  }
  assert.ok(!result.stderr.includes('\\303\\251'), `no C-quoted name: ${result.stderr}`);
  assert.ok(existsSync(folder), 'the lane worktree is kept');
  assert.equal(git(repo, 'rev-parse', `refs/heads/${LANE}`), laneTip, 'the lane branch is kept');
  for (const { nested, nestedCommit } of nestedRepos) {
    assert.ok(existsSync(join(nested, '.git')), `the nested repository ${nested} is still there`);
    assert.equal(git(nested, 'rev-parse', 'HEAD'), nestedCommit, 'its commit is still readable');
  }
});

test('prune --apply keeps a merged worktree that holds a nested repository named pké in node_modules, naming its path as it is on disk', () => {
  const repo = repoIgnoring(REBUILDABLE_FOLDER);
  const folder = addWorktree(repo, 'wt-nested', 'nested-done');
  const { nested, nestedCommit } = addNestedRepo(folder, ACCENTED_NAME, REBUILDABLE_FOLDER);
  assert.equal(git(folder, 'status', '--porcelain'), '', 'precondition: the nested repository is invisible to the worktree');

  const result = tidy(['prune', repo, '--include-recent', '--apply'], { cwd: repo, env: privateEnv() });

  assert.equal(result.status, 1, `prune exits 1 when it keeps something: ${result.stdout}${result.stderr}`);
  const kept = lines(result).find((line) => line.startsWith(`kept merged-worktree ${folder} `));
  assert.ok(kept?.includes(`${REBUILDABLE_FOLDER}/${ACCENTED_NAME}/`), `the kept line names the path as it is: ${lines(result).join('\n')}`);
  assert.ok(existsSync(folder), 'the worktree is kept');
  assert.equal(git(nested, 'rev-parse', 'HEAD'), nestedCommit, 'the nested commit is still readable');
  assert.equal(git(repo, 'rev-parse', '--verify', 'refs/heads/nested-done'), git(repo, 'rev-parse', 'main'), 'its branch is kept');
});
