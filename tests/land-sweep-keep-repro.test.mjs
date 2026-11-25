// Repros for ways land's sweep (home/tools/land/sweep.mjs, through git-tidy's prune, home/tools/git-tidy/lib/prune.mjs) could
// lose work that exists nowhere else: a merged worktree whose ignored folder holds a repository of its own (contentReason needs a
// nested-repository check, like lane-slots.mjs nestedRepositoryWhy), and a stale worktree entry (its folder is gone) whose HEAD
// holds a commit no branch has. The contract for stale entries: land's sweep never removes one and makes no `stale-head/*`
// branch, it lists each under `left:`; only `git-tidy prune --apply` removes a stale entry, and only one that holds nothing.
// Land also refuses a clean sparse checkout (refusal.mjs counts every skip-worktree file as a hidden edit).
// Each test fails on the sources it was written for and passes once the bug is fixed; it asserts only what a person sees
// afterwards (the worktree folder, the stale entry, the `left:` rows, the nested commit, the commit being reachable). The
// stale-entry test that holds nothing is a guard of the contract and passes today.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { LAND, outputLines, tipOf, usedAgo } from './land-sweep-helpers.mjs';

const MS_PER_HOUR = 60 * 60 * 1000;
const UNUSED_FOR = 3 * MS_PER_HOUR; // past prune's recent-use window, so only the content rules decide
const IGNORED_FOLDER = 'node_modules';
const NESTED_FILE = 'patch.txt';
const NESTED_TEXT = 'my patch to the dependency\n';
const STALE_FILE = 'detached-work.txt';
const LEFT_HEADER = 'left:';
const RESCUE_BRANCHES = 'refs/heads/stale-head/'; // where prune's rescue branches would go; land must make none

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

/** The `left:` block of land's stdout: the lines after `left:`, [] when there is no `left:` line. */
function leftRows(stdout) {
  const all = outputLines(stdout);
  const at = all.indexOf(LEFT_HEADER);
  return at === -1 ? [] : all.slice(at + 1);
}

/** The entry of a linked worktree `name` inside the common git dir of `repo`. */
const entryOf = (repo, name) => join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'worktrees', name);

/** True when `commitId` is reachable from a ref or from the HEAD of a worktree entry (`git rev-list --all`). */
const isReachable = (repo, commitId) => git(repo, 'rev-list', '--all').split('\n').includes(commitId);

/**
 * A repo whose worktree entry `st` is stale: its detached worktree was made at main, the folder is deleted, and the entry in
 * .git/worktrees/st is all that is left. With `ownCommit` a commit was made on its detached HEAD first. Returns
 * `{ repo, staleTree, headOfEntry }`: the path the entry registered and the commit its HEAD points at.
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
  return { repo, staleTree, headOfEntry };
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

// Repro: removing the entry whose folder is gone (as `git worktree prune` does) leaves the commit only its HEAD held on no ref;
// land's sweep must keep the entry.
test('land keeps the commit that only a stale worktree entry held', () => {
  const { repo, headOfEntry } = repoWithStaleEntry({ ownCommit: true });
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(isReachable(repo, headOfEntry), true, `the commit only the stale worktree entry held became unreachable:\n${said}`);
});

// Guard of the contract (passes today): even an entry that holds nothing (its HEAD is already on main) is never removed by land;
// it is listed under left: with the way out, and no rescue branch is made.
test('land keeps and lists a stale worktree entry that holds no commit of its own', () => {
  const { repo, staleTree, headOfEntry } = repoWithStaleEntry({ ownCommit: false });
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(entryOf(repo, 'st')), true, `land removed the empty stale entry:\n${said}`);
  const rows = leftRows(result.stdout).filter((line) => line.includes(staleTree));
  assert.equal(rows.length, 1, `left: does not list the one stale entry:\n${said}`);
  assert.ok(rows[0].includes('(stale worktree entry): kept:'), `the left: row does not say the entry is kept:\n${said}`);
  assert.ok(rows[0].includes('land never removes'), `the left: row does not say land never removes it:\n${said}`);
  assert.equal(git(repo, 'for-each-ref', RESCUE_BRANCHES), '', `land made a stale-head branch:\n${said}`);
  assert.equal(isReachable(repo, headOfEntry), true, 'the commit it pointed at is still reachable');
});

// Repro: the same loss through git-tidy's own `prune --apply`, which keeps the commit as a rescue branch.
test('git-tidy prune --apply keeps the commit that only a stale worktree entry held', () => {
  const { repo, headOfEntry } = repoWithStaleEntry({ ownCommit: true });
  const { result, said } = pruneRepo(repo);
  assert.equal(result.status, 0, said);
  assert.equal(isReachable(repo, headOfEntry), true, `the commit only the stale worktree entry held became unreachable:\n${said}`);
});

const SPARSE_KEPT_FOLDER = 'a';
const SPARSE_LEFT_OUT_FILE = 'b/b.txt'; // as git prints it, also on Windows
const LANE_FILE_IN_KEPT_FOLDER = 'a/new.txt';
const HIDDEN_EDIT = 'an edit git status does not show\n';

/** The files `git ls-files -v` of `dir` marks `S` (skip-worktree). */
const skipWorktreeFiles = (dir) =>
  git(dir, 'ls-files', '-v').split('\n').filter((line) => line.startsWith('S ')).map((line) => line.slice(2));

/** A repo whose main holds a/a.txt, b/b.txt and top.txt, with per-worktree config so a sparse checkout stays in one checkout. */
function repoWithTwoFolders() {
  const repo = makeRepo();
  for (const file of ['a/a.txt', SPARSE_LEFT_OUT_FILE]) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), `${file}\n`);
  }
  writeFileSync(join(repo, 'top.txt'), 'top\n');
  git(repo, 'add', '--', 'a', 'b', 'top.txt');
  git(repo, 'commit', '-q', '-m', 'add two folders');
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  return repo;
}

/** Makes `dir` a cone sparse checkout of the kept folder only; its other folder is then skip-worktree and gone from disk. */
function makeSparse(dir) {
  git(dir, 'sparse-checkout', 'set', '--cone', SPARSE_KEPT_FOLDER);
  assert.deepEqual(skipWorktreeFiles(dir), [SPARSE_LEFT_OUT_FILE], 'precondition: the other folder is skip-worktree');
  assert.equal(existsSync(join(dir, SPARSE_LEFT_OUT_FILE)), false, 'precondition: the other folder is absent on disk');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'precondition: the sparse checkout is clean');
}

/** Commits a file in the kept folder on `laneTree`; returns the lane's tip. */
function commitInKeptFolder(laneTree) {
  return commit(laneTree, LANE_FILE_IN_KEPT_FOLDER, 'new\n');
}

/** Lands lane/L and asserts land exited 0 and main is now at the lane's tip. */
function assertLanded(repo, laneTip) {
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, `land refused a clean sparse checkout:\n${said}`);
  assert.equal(tipOf(repo, 'main'), laneTip, `main did not move to the lane's tip:\n${said}`);
}

// Repro: refusal.mjs refuses any checkout with a skip-worktree file, and a sparse checkout marks every file outside its cone so.
test('land lands a lane when the base checkout is a clean cone sparse checkout', () => {
  const repo = repoWithTwoFolders();
  makeSparse(repo);
  const laneTree = addWorktree(repo, 'lane', 'lane/L');
  git(laneTree, 'sparse-checkout', 'disable'); // a new worktree starts sparse like its base; only the base is meant to be
  assert.deepEqual(skipWorktreeFiles(laneTree), [], 'precondition: the lane checkout is not sparse');
  assert.deepEqual(skipWorktreeFiles(repo), [SPARSE_LEFT_OUT_FILE], 'precondition: the base checkout is still sparse');
  assertLanded(repo, commitInKeptFolder(laneTree));
});

// Repro: the same with the lane's worktree sparse and the base checkout not.
test('land lands a lane whose worktree is a clean cone sparse checkout', () => {
  const repo = repoWithTwoFolders();
  const laneTree = addWorktree(repo, 'lane', 'lane/L');
  makeSparse(laneTree);
  assert.deepEqual(skipWorktreeFiles(repo), [], 'precondition: the base checkout is not sparse');
  assertLanded(repo, commitInKeptFolder(laneTree));
});

// Guard (passes today, must stay): a skip-worktree file that is on disk with an edit hides work from `git status`, so land
// refuses and the edit stays.
test('land still refuses a lane with an edited skip-worktree file on disk and leaves the edit', () => {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', 'lane/L');
  commit(laneTree, 'l.txt', 'l\n');
  const editedFile = join(laneTree, 'base.txt');
  writeFileSync(editedFile, HIDDEN_EDIT);
  git(laneTree, 'update-index', '--skip-worktree', 'base.txt');
  assert.equal(git(laneTree, 'status', '--porcelain'), '', 'precondition: git status does not show the edit');
  const mainTip = tipOf(repo, 'main');
  const { result, said } = landLane(repo);
  assert.equal(result.status, 1, said);
  assert.equal(tipOf(repo, 'main'), mainTip, `main moved although land refused:\n${said}`);
  assert.equal(readFileSync(editedFile, 'utf8'), HIDDEN_EDIT);
});
