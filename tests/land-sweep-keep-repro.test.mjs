// Repros for two ways land's sweep (home/tools/land/sweep.mjs, through git-tidy's prune, home/tools/git-tidy/lib/prune.mjs)
// loses work that exists nowhere else: a merged worktree whose ignored folder holds a repository of its own (contentReason has no
// nested-repository check, unlike lane-slots.mjs nestedRepositoryWhy), and a stale worktree entry (its folder is gone) whose
// HEAD holds a commit no branch has (pruneStale runs `git worktree prune`).
// Each test fails on the sources it was written for and passes once the bug is fixed; it asserts only what a person sees
// afterwards (the worktree folder, the nested commit, the commit being reachable). The control passes today.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { LAND, usedAgo } from './land-sweep-helpers.mjs';

const MS_PER_HOUR = 60 * 60 * 1000;
const UNUSED_FOR = 3 * MS_PER_HOUR; // past prune's recent-use window, so only the content rules decide
const IGNORED_FOLDER = 'node_modules';
const NESTED_FILE = 'patch.txt';
const NESTED_TEXT = 'my patch to the dependency\n';
const STALE_FILE = 'detached-work.txt';

/** Adds lane/L in its own worktree with one commit of a file nothing else touches, so land has something to land. */
function laneWithUnrelatedCommit(repo) {
  const laneTree = addWorktree(repo, 'lane', 'lane/L');
  commit(laneTree, 'l.txt', 'l\n');
}

/** Lands lane/L from `repo`; returns the spawn result and its stdout and stderr in one text for failure messages. */
function landLane(repo) {
  const result = spawnSync(process.execPath, [LAND, 'lane/L', '--repo', repo], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV });
  return { result, said: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

/** Prunes `repo` through git-tidy itself; returns the spawn result and its output in one text for failure messages. */
function pruneRepo(repo) {
  const result = tidy(['prune', repo, '--apply', '--base', 'main'], { cwd: repo });
  return { result, said: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

/** The entry of a linked worktree `name` inside the common git dir of `repo`. */
const entryOf = (repo, name) => join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'worktrees', name);

/** True when `commitId` is reachable from a ref or from the HEAD of a worktree entry (`git rev-list --all`). */
const isReachable = (repo, commitId) => git(repo, 'rev-list', '--all').split('\n').includes(commitId);

/**
 * A repo whose worktree entry `st` is stale: its detached worktree was made at main, the folder is deleted, and the entry in
 * .git/worktrees/st is all that is left. With `ownCommit` a commit was made on its detached HEAD first. Returns
 * `{ repo, headOfEntry }`, the commit the entry's HEAD points at.
 */
function repoWithStaleEntry({ ownCommit }) {
  const repo = makeRepo();
  const staleTree = join(repo, '..', 'st');
  git(repo, 'worktree', 'add', '-q', '--detach', staleTree, 'main');
  if (ownCommit) commit(staleTree, STALE_FILE, 'work on a detached HEAD\n');
  const headOfEntry = git(staleTree, 'rev-parse', 'HEAD');
  rmSync(staleTree, { recursive: true, force: true });
  assert.equal(existsSync(entryOf(repo, 'st')), true, 'precondition: the entry outlives its folder');
  assert.equal(isReachable(repo, headOfEntry), true, 'precondition: the entry holds its HEAD reachable');
  return { repo, headOfEntry };
}

// Repro: contentReason checks status, branch and recent use but not a repository nested in an ignored folder, so the merged
// worktree (t/T is at main) is removed and the nested repository with its only commit goes with it.
test('a merged worktree whose ignored folder holds a repository of its own is kept with that repository', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.gitignore'), `${IGNORED_FOLDER}/\n`);
  git(repo, 'add', '--', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore the dependency folder');
  const mergedTree = addWorktree(repo, 'tt', 't/T');
  const nestedRepo = join(mergedTree, IGNORED_FOLDER, 'dep');
  mkdirSync(nestedRepo, { recursive: true });
  git(nestedRepo, 'init', '-q', '-b', 'main');
  const nestedCommit = commit(nestedRepo, NESTED_FILE, NESTED_TEXT);
  assert.equal(git(mergedTree, 'status', '--porcelain'), '', 'precondition: git status of the worktree shows nothing');
  usedAgo(mergedTree, UNUSED_FOR);
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(mergedTree), true, `the worktree with a nested repository was removed:\n${said}`);
  assert.equal(existsSync(join(nestedRepo, '.git')), true, `the nested repository was removed:\n${said}`);
  assert.equal(git(nestedRepo, 'rev-parse', 'HEAD'), nestedCommit, 'the nested commit is still readable');
});

// Repro: pruneStale runs `git worktree prune`, which drops the entry whose folder is gone, and the commit only its HEAD held
// is then on no ref.
test('land keeps the commit that only a stale worktree entry held', () => {
  const { repo, headOfEntry } = repoWithStaleEntry({ ownCommit: true });
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(isReachable(repo, headOfEntry), true, `the commit only the stale worktree entry held became unreachable:\n${said}`);
});

// Control (passes today): an entry whose HEAD is already on main loses nothing when it is pruned, so it is cleaned up.
test('land prunes a stale worktree entry that holds no commit of its own', () => {
  const { repo, headOfEntry } = repoWithStaleEntry({ ownCommit: false });
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(entryOf(repo, 'st')), false, `the empty stale entry was not pruned:\n${said}`);
  assert.equal(isReachable(repo, headOfEntry), true, 'the commit it pointed at is still on main');
});

// Repro: the same loss through git-tidy's own `prune --apply`.
test('git-tidy prune --apply keeps the commit that only a stale worktree entry held', () => {
  const { repo, headOfEntry } = repoWithStaleEntry({ ownCommit: true });
  const { result, said } = pruneRepo(repo);
  assert.equal(result.status, 0, said);
  assert.equal(isReachable(repo, headOfEntry), true, `the commit only the stale worktree entry held became unreachable:\n${said}`);
});
