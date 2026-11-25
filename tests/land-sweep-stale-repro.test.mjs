// Repros and gap tests for two things land (home/tools/land/land.mjs, its sweep sweep.mjs) and git-tidy (prune-stale.mjs, land.mjs)
// do with work that may exist nowhere else: a stale worktree entry (its folder is gone or moved) and a git repository inside an
// ignored folder of the landed lane's worktree.
// Repros (fail on the sources they were written for): a stale entry's staged content is lost when the entry is removed (the
// index of the entry is the only holder of a blob that is in no commit), and land's advice for a kept nested repository
// ends "remove the rest by hand", which invites deleting the repository it just kept.
// Gap tests (pass today): each pins one line of the fix that keeps such work, so a change that drops the line fails a test.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME); every
// test asserts only what a person sees afterwards (exit code, output lines, folders, entries, reachable objects).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { land, outputLines, tipOf } from './land-sweep-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const IGNORED_FOLDER = 'node_modules';
const NESTED_REPO = `${IGNORED_FOLDER}/dep`; // as git prints it, also on Windows
const STAGED_FILE = 'w';
const STAGED_TEXT = 'staged\n';
const WORKTREE_TEXT = 'other\n';
const STALE_FILE = 'detached-work.txt';
const LEFT_HEADER = 'left:';
const KEPT_REFLOG_REASON = 'kept: its HEAD reflog holds';

/** Adds lane/L in its own worktree with one commit of a file nothing else touches, so land has something to land. */
function laneWithUnrelatedCommit(repo) {
  const laneTree = addWorktree(repo, 'lane', 'lane/L');
  commit(laneTree, 'l.txt', 'l\n');
  return laneTree;
}

/** Lands lane/L from `repo`; returns the spawn result and its stdout and stderr in one text for failure messages. */
function landLane(repo) {
  const result = land(['lane/L', '--repo', repo], repo);
  return { result, said: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

/** Prunes `repo` through git-tidy itself; returns the spawn result and its output in one text for failure messages. */
function pruneRepo(repo) {
  const result = tidy(['prune', repo, '--apply', '--base', 'main'], { cwd: repo });
  return { result, said: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

/** Runs git-tidy with a private temp folder, where `git-tidy land` makes its temporary rebase worktree. */
const tidyOwnTemp = (args, cwd) => {
  const ownTemp = makeTempDir('git-tidy-tmp-');
  return tidy(args, { cwd, env: { TMPDIR: ownTemp, TEMP: ownTemp, TMP: ownTemp } });
};

/** The entry of a linked worktree `name` inside the common git dir of `repo`. */
const entryOf = (repo, name) => join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'worktrees', name);

/** The objects `git fsck --unreachable --no-reflogs` lists, as one text. */
const unreachableObjects = (repo) => git(repo, 'fsck', '--unreachable', '--no-reflogs');

/** The `left:` block of land's stdout: the lines after `left:`, [] when there is no `left:` line. */
function leftRows(stdout) {
  const all = outputLines(stdout);
  const at = all.indexOf(LEFT_HEADER);
  return at === -1 ? [] : all.slice(at + 1);
}

/**
 * A stale entry whose index is the only holder of a blob: a detached worktree `st` made at main, `w` staged as STAGED_TEXT and
 * then changed on disk again, and the folder moved to `moved` (so the entry points at a folder that is gone). Returns
 * `{ repo, stagedBlob, movedTree }`.
 */
function repoWithStagedStaleEntry() {
  const repo = makeRepo();
  const staleTree = join(repo, '..', 'st');
  git(repo, 'worktree', 'add', '-q', '--detach', staleTree, 'main');
  writeFileSync(join(staleTree, STAGED_FILE), STAGED_TEXT);
  git(staleTree, 'add', '--', STAGED_FILE);
  const stagedBlob = git(staleTree, 'rev-parse', `:${STAGED_FILE}`);
  writeFileSync(join(staleTree, STAGED_FILE), WORKTREE_TEXT);
  const movedTree = join(repo, '..', 'moved');
  renameSync(staleTree, movedTree);
  assert.equal(existsSync(entryOf(repo, 'st')), true, 'precondition: the entry outlives its folder');
  assert.equal(unreachableObjects(repo).includes(stagedBlob), false, 'precondition: the entry holds the staged blob');
  return { repo, stagedBlob, movedTree };
}

/**
 * Makes a stale entry `name` whose detached HEAD reflog holds a commit found nowhere else: a detached worktree at main, one commit
 * on it, HEAD back on main, then the folder removed. Returns `{ staleTree, lostCommit }`.
 */
function addReflogOnlyStaleEntry(repo, name) {
  const staleTree = join(repo, '..', name);
  git(repo, 'worktree', 'add', '-q', '--detach', staleTree, 'main');
  const lostCommit = commit(staleTree, STALE_FILE, 'work on a detached HEAD\n');
  git(staleTree, 'checkout', '-q', '--detach', 'main');
  rmSync(staleTree, { recursive: true, force: true });
  assert.equal(existsSync(entryOf(repo, name)), true, 'precondition: the entry outlives its folder');
  assert.equal(git(repo, 'for-each-ref', '--contains', lostCommit), '', 'precondition: no ref holds the commit');
  assert.equal(readFileSync(join(entryOf(repo, name), 'logs', 'HEAD'), 'utf8').includes(lostCommit), true, 'precondition: the entry reflog holds it');
  return { staleTree, lostCommit };
}

/** Makes a stale entry `name` that holds nothing of its own: a detached worktree at main whose folder is removed. */
function addEmptyStaleEntry(repo, name) {
  const staleTree = join(repo, '..', name);
  git(repo, 'worktree', 'add', '-q', '--detach', staleTree, 'main');
  rmSync(staleTree, { recursive: true, force: true });
  assert.equal(existsSync(entryOf(repo, name)), true, 'precondition: the entry outlives its folder');
  return staleTree;
}

/**
 * A repo whose .gitignore names the ignored folder, with lane/L in its own worktree: one commit, and a git repository of its own
 * (one commit) at NESTED_REPO. Returns `{ repo, laneTree, nestedRepo, nestedCommit }`.
 */
function repoWithLaneHoldingNestedRepo() {
  const repo = makeRepo();
  commit(repo, '.gitignore', `${IGNORED_FOLDER}/\n`);
  const laneTree = laneWithUnrelatedCommit(repo);
  const nestedRepo = join(laneTree, NESTED_REPO);
  mkdirSync(nestedRepo, { recursive: true });
  git(nestedRepo, 'init', '-q', '-b', 'main');
  const nestedCommit = commit(nestedRepo, 'patch.txt', 'my patch to the dependency\n');
  assert.equal(git(laneTree, 'status', '--porcelain'), '', 'precondition: git status of the lane worktree shows nothing');
  return { repo, laneTree, nestedRepo, nestedCommit };
}

/** `git status` in `folder`, as a spawn result (a folder whose entry is gone makes it fail). */
const statusIn = (folder) => spawnSync('git', ['status', '--porcelain'], { cwd: folder, encoding: 'utf8', env: CLEAN_ENV });

// Repro: pruneStale removes an entry whose HEAD is on a branch and whose reflog holds nothing, and never looks at its index, so
// a blob that was staged there and exists in no commit goes with the entry (the moved folder is then not a worktree any more).
test('land keeps a stale worktree entry whose index holds staged content that is in no commit', () => {
  const { repo, stagedBlob, movedTree } = repoWithStagedStaleEntry();
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(entryOf(repo, 'st')), true, `the stale entry's staged content was lost: the entry was removed:\n${said}`);
  assert.equal(unreachableObjects(repo).includes(stagedBlob), false, `the stale entry's staged content was lost: its blob is unreachable:\n${said}`);
  assert.equal(statusIn(movedTree).status, 0, `the stale entry's staged content was lost: the moved folder is no worktree any more:\n${said}`);
});

// Repro: the same loss through git-tidy's own `prune --apply`.
test('git-tidy prune --apply keeps a stale worktree entry whose index holds staged content that is in no commit', () => {
  const { repo, stagedBlob, movedTree } = repoWithStagedStaleEntry();
  const { result, said } = pruneRepo(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(entryOf(repo, 'st')), true, `the stale entry's staged content was lost: the entry was removed:\n${said}`);
  assert.equal(unreachableObjects(repo).includes(stagedBlob), false, `the stale entry's staged content was lost: its blob is unreachable:\n${said}`);
  assert.equal(statusIn(movedTree).status, 0, `the stale entry's staged content was lost: the moved folder is no worktree any more:\n${said}`);
});

// Repro: removeLane's stop says "remove the rest by hand" and names only the ignored folder, so a person who follows it deletes
// the repository that land has just kept.
test("land's advice for a kept nested repository names the repository and does not invite deleting it", () => {
  const { repo, nestedRepo } = repoWithLaneHoldingNestedRepo();
  const { result, said } = landLane(repo);
  assert.equal(result.status, 1, said);
  assert.match(result.stdout, /landed lane\/L on main/, said);
  assert.match(result.stderr, /landed on main/, said);
  assert.equal(result.stderr.includes('remove the rest by hand'), false, `land's advice for a kept nested repository invites deleting it:\n${said}`);
  assert.equal(result.stderr.includes(NESTED_REPO), true, `land's advice for a kept nested repository does not name ${NESTED_REPO}:\n${said}`);
  assert.equal(existsSync(join(nestedRepo, '.git')), true, `the nested repository was removed:\n${said}`);
});

// Gap: removeLane's nestedRepositoryWhy stop; without it `git worktree remove` deletes the worktree with the repository.
test('land keeps the landed lane worktree, its branch and the repository nested in its ignored folder, and skips the sweep', () => {
  const { repo, laneTree, nestedRepo, nestedCommit } = repoWithLaneHoldingNestedRepo();
  const laneTip = tipOf(repo, 'lane/L');
  const { result, said } = landLane(repo);
  assert.equal(result.status, 1, said);
  assert.equal(tipOf(repo, 'main'), laneTip, `main did not move to the lane's tip:\n${said}`);
  assert.equal(existsSync(laneTree), true, `the worktree with a nested repository was removed:\n${said}`);
  assert.equal(tipOf(repo, 'lane/L'), laneTip, `the lane branch was deleted or moved:\n${said}`);
  assert.equal(existsSync(join(nestedRepo, '.git')), true, `the nested repository was removed:\n${said}`);
  assert.equal(git(nestedRepo, 'rev-parse', 'HEAD'), nestedCommit, 'the nested commit is still readable');
  assert.equal(outputLines(result.stdout).some((line) => line.startsWith(LEFT_HEADER)), false, `the sweep ran after the stop:\n${said}`);
});

// Gap: prune-stale's reflog count; without it the entry (its HEAD is on main) is removed and its reflog-only commit is lost.
test('land keeps a stale entry whose HEAD reflog holds a commit found nowhere else, and says why under left:', () => {
  const repo = makeRepo();
  const { staleTree, lostCommit } = addReflogOnlyStaleEntry(repo, 'st');
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(entryOf(repo, 'st')), true, `the stale entry holding a reflog-only commit was removed:\n${said}`);
  assert.equal(readFileSync(join(entryOf(repo, 'st'), 'logs', 'HEAD'), 'utf8').includes(lostCommit), true, `the entry's HEAD reflog lost the commit:\n${said}`);
  const row = leftRows(result.stdout).find((line) => line.includes(`${staleTree} (stale worktree entry)`));
  assert.ok(row?.includes(KEPT_REFLOG_REASON), `left: does not say the entry is kept for its reflog:\n${said}`);
});

// Gap: prune-stale removes one entry with `git worktree remove`; `git worktree prune` would drop the entry that must stay too.
test('land removes a stale entry that holds nothing and keeps the one beside it that holds a reflog-only commit', () => {
  const repo = makeRepo();
  addReflogOnlyStaleEntry(repo, 'st-lost');
  addEmptyStaleEntry(repo, 'st-empty');
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(entryOf(repo, 'st-lost')), true, `the entry holding a reflog-only commit was removed with the empty one:\n${said}`);
  assert.equal(existsSync(entryOf(repo, 'st-empty')), false, `the empty stale entry was not removed:\n${said}`);
});

// Gap: git-tidy land's temporary rebase worktree is cleaned by its own entry only; `git worktree prune` would drop every stale entry.
test('git-tidy land of a lane with no worktree leaves another stale entry that holds a reflog-only commit in place', () => {
  const repo = makeRepo();
  addReflogOnlyStaleEntry(repo, 'st');
  git(repo, 'checkout', '-q', '-b', 'lane/solo');
  commit(repo, 'solo.txt');
  git(repo, 'checkout', '-q', 'main');
  commit(repo, 'moved.txt');
  const rebased = tidyOwnTemp(['land', 'lane/solo', repo, '--rebase-only', '--tip', tipOf(repo, 'lane/solo')], repo);
  assert.equal(rebased.status, 0, `stdout:\n${rebased.stdout}\nstderr:\n${rebased.stderr}`);
  const rebasedTip = tipOf(repo, 'lane/solo');
  const landed = tidyOwnTemp(['land', 'lane/solo', repo, '--tip', rebasedTip], repo);
  // Exit 1 (landed with findings) is expected: `check` reports the kept stale entry itself.
  assert.equal(outputLines(landed.stdout)[0], `landed ${rebasedTip}`, `stdout:\n${landed.stdout}\nstderr:\n${landed.stderr}`);
  assert.equal(tipOf(repo, 'main'), rebasedTip, 'the lane landed');
  assert.equal(existsSync(entryOf(repo, 'st')), true, `the stale entry holding a reflog-only commit was dropped by the landing:\n${landed.stdout}`);
});

// Gap: sweep.mjs prints the stale rows prune kept; without them a kept entry is silent and nobody learns it is still there.
test('land lists a kept stale entry under left: as `<path> (stale worktree entry): kept: <reason>`', () => {
  const repo = makeRepo();
  const { staleTree } = addReflogOnlyStaleEntry(repo, 'st');
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  const rows = leftRows(result.stdout).filter((line) => line.includes('(stale worktree entry)'));
  assert.equal(rows.length, 1, `left: does not list the one kept stale entry:\n${said}`);
  assert.match(rows[0], new RegExp(`^ {2}${staleTree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(stale worktree entry\\): kept: \\S`), said);
});
