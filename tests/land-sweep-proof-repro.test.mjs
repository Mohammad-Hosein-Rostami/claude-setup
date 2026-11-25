// Repros for three ways land's sweep (home/tools/land/sweep.mjs, through git-tidy's prune) removes work that is not on the
// base: a merge driver or merge attribute that makes the content proof (branches.mjs contentOnBase) pass for a branch whose
// change was dropped by the merge, a base that moves back during the sweep while the proof compares against the base tree it
// read first, and a worktree edit hidden from `git status` by assume-unchanged or skip-worktree (prune.mjs contentReason).
// Each test fails on the sources it was written for and passes once the bug is fixed; it asserts only what a person sees
// afterwards (the branch, the worktree folder, the edited file).
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, backdate, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { LAND, branchExists, datedEnv, gitWith, logRecords, outputLines, tipOf } from './land-sweep-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the stand-in git is a shell script' };
const MS_PER_HOUR = 60 * 60 * 1000;
const SHARED_FILE = 'f.txt';
const SHARED_TEXT = 'one\ntwo\nthree\nfour\nfive\n';
const MAIN_TEXT = 'one\ntwo\nMAIN-CHANGED\nfour\nfive\n';
const BRANCH_TEXT = 'one\ntwo\nBRANCH-CHANGED\nfour\nfive\n';
// work/Y drops a line that main changes: the union driver keeps main's line and loses the deletion.
const UNION_BASE_TEXT = 'a\nb\nc\n';
const UNION_MAIN_TEXT = 'a\nB2\nc\n';
const UNION_BRANCH_TEXT = 'a\nc\n';
const HIDDEN_EDIT = 'an edit git status does not show\n';

/** Commits `text` as `file` on `branch` (no worktree of its own) from the base checkout `repo`, then goes back to main. */
function commitOnBranch(repo, branch, file, text) {
  git(repo, 'switch', '-q', branch);
  commit(repo, file, text, `${branch}: change ${file}`);
  git(repo, 'switch', '-q', 'main');
}

/** Adds lane/L in its own worktree with one commit of a file nothing else touches; returns its worktree path. */
function laneWithUnrelatedCommit(repo) {
  const laneTree = addWorktree(repo, 'lane', 'lane/L');
  commit(laneTree, 'l.txt', 'l\n');
  return laneTree;
}

/** Lands lane/L from `repo`; returns the spawn result and its stdout and stderr in one text for failure messages. */
function landLane(repo, env = CLEAN_ENV) {
  const result = spawnSync(process.execPath, [LAND, 'lane/L', '--repo', repo], { cwd: repo, encoding: 'utf8', env });
  return { result, said: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

/** Asserts `branch` survived the land at its old tip and has no deletion record. */
function assertBranchKept(repo, branch, tip, said) {
  assert.equal(branchExists(repo, branch), true, `${branch} was deleted although its change is not on main:\n${said}`);
  assert.equal(tipOf(repo, branch), tip);
  assert.deepEqual(logRecords(repo).filter(({ deleted }) => deleted.branch === branch), [], 'no deletion record for it');
}

// Repro: with `f.txt merge=ours` the merge keeps main's f.txt, so merging work/Y gives main's own tree and the proof passes,
// although work/Y's change of f.txt is on no other branch.
test('a merge=ours driver in .git/info/attributes does not let the sweep delete a branch whose change is not on main', () => {
  const repo = makeRepo();
  commit(repo, SHARED_FILE, SHARED_TEXT);
  git(repo, 'branch', 'work/Y', 'main');
  commitOnBranch(repo, 'work/Y', SHARED_FILE, BRANCH_TEXT);
  commit(repo, SHARED_FILE, MAIN_TEXT);
  writeFileSync(join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'attributes'), `${SHARED_FILE} merge=ours\n`);
  git(repo, 'config', 'merge.ours.driver', 'true');
  laneWithUnrelatedCommit(repo);
  const branchTip = tipOf(repo, 'work/Y');
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assertBranchKept(repo, 'work/Y', branchTip, said);
  assert.equal(outputLines(result.stdout).some((line) => line.startsWith('deleted work/Y ')), false, `land says it deleted work/Y:\n${said}`);
});

// Repro: a committed `merge=union` keeps both sides of a conflict, so a line work/Y deletes where main changed it comes back
// in the merge, the merge gives main's own tree, and the proof passes although the deletion is on no other branch.
test('a committed merge=union attribute does not let the sweep delete a branch whose line deletion is not on main', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.gitattributes'), `${SHARED_FILE} merge=union\n`);
  commit(repo, SHARED_FILE, UNION_BASE_TEXT);
  git(repo, 'add', '--', '.gitattributes');
  git(repo, 'commit', '-q', '-m', 'merge f.txt by union');
  git(repo, 'branch', 'work/Y', 'main');
  commitOnBranch(repo, 'work/Y', SHARED_FILE, UNION_BRANCH_TEXT);
  commit(repo, SHARED_FILE, UNION_MAIN_TEXT);
  laneWithUnrelatedCommit(repo);
  const branchTip = tipOf(repo, 'work/Y');
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assertBranchKept(repo, 'work/Y', branchTip, said);
  assert.equal(outputLines(result.stdout).some((line) => line.startsWith('deleted work/Y ')), false, `land says it deleted work/Y:\n${said}`);
});

/** The absolute path of the git that is first on CLEAN_ENV's PATH. */
function realGitPath() {
  const found = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
  assert.notEqual(found, '', 'precondition: git is on PATH');
  return found;
}

/**
 * A folder holding a stand-in `git` that passes every command to the real git and, right after the first
 * `rev-parse refs/heads/main^{tree}` (the base tree the content proof reads once per run), resets main of `repo` to `oldMain`
 * and creates `marker`.
 */
function baseBackGitFolder(repo, oldMain, marker) {
  const realGit = realGitPath();
  const folder = makeTempDir('base-back-git-');
  const script = join(folder, 'git');
  writeFileSync(script, [
    '#!/bin/sh',
    `if [ "$1" = rev-parse ] && [ "$2" = 'refs/heads/main^{tree}' ] && [ ! -e '${marker}' ]; then`,
    `  '${realGit}' "$@"; status=$?`,
    `  '${realGit}' -C '${repo}' update-ref refs/heads/main '${oldMain}' && : > '${marker}'`,
    '  exit $status',
    'fi',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return folder;
}

// Repro: the proof compares each merge with the base tree read once, while merge-tree reads the live base. Once main is reset
// back to before the landing, work/Y (a cherry-picked copy of the landed commit) merges into the old main as the landed tree,
// which equals the tree read first, so work/Y is deleted although l.txt is no longer on main.
test('main reset back during the sweep does not let it delete a branch whose content left main', POSIX_ONLY, () => {
  const repo = makeRepo();
  const laneTree = laneWithUnrelatedCommit(repo);
  const laneTip = tipOf(repo, 'lane/L');
  const oldMain = tipOf(repo, 'main');
  git(repo, 'branch', 'work/Y', 'main');
  git(repo, 'switch', '-q', 'work/Y');
  // Another committer date gives the copy its own hash, as a cherry-pick made later does.
  gitWith(repo, datedEnv(MS_PER_HOUR), 'cherry-pick', laneTip);
  git(repo, 'switch', '-q', 'main');
  const branchTip = tipOf(repo, 'work/Y');
  assert.notEqual(branchTip, laneTip, 'precondition: work/Y is a copy with its own hash');
  const marker = join(makeTempDir('base-back-marker-'), 'fired');
  const env = { ...CLEAN_ENV, PATH: `${baseBackGitFolder(repo, oldMain, marker)}${delimiter}${CLEAN_ENV.PATH ?? ''}` };
  const { said } = landLane(repo, env);
  assert.ok(existsSync(marker), `precondition: the stand-in git reset main during the sweep:\n${said}`);
  assert.equal(tipOf(repo, 'main'), oldMain, 'precondition: main is back at its commit before the landing');
  assert.equal(existsSync(laneTree), false, 'precondition: lane/L landed and its worktree is gone');
  assertBranchKept(repo, 'work/Y', branchTip, said);
});

/**
 * lane/z in its own worktree at main's tip (its content is all on main), whose tracked base.txt holds an edit hidden from
 * `git status` by `update-index <hideFlag>`, last used two hours ago; then lane/L lands. Asserts the worktree, its edit and
 * lane/z stay, and land says why it kept the worktree.
 */
function assertHiddenEditKept(hideFlag) {
  const repo = makeRepo();
  const hiddenTree = addWorktree(repo, 'z', 'lane/z');
  const editedFile = join(hiddenTree, 'base.txt');
  writeFileSync(editedFile, HIDDEN_EDIT);
  git(hiddenTree, 'update-index', hideFlag, 'base.txt');
  assert.equal(git(hiddenTree, 'status', '--porcelain'), '', 'precondition: git status does not show the edit');
  backdate(hiddenTree);
  laneWithUnrelatedCommit(repo);
  const { result, said } = landLane(repo);
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(hiddenTree), true, `the worktree with the hidden edit was removed:\n${said}`);
  assert.equal(readFileSync(editedFile, 'utf8'), HIDDEN_EDIT);
  assert.equal(branchExists(repo, 'lane/z'), true, said);
  assert.ok(outputLines(result.stdout).some((line) => line.startsWith(`kept ${hiddenTree}: `)), `land says why it kept it:\n${said}`);
}

// Repro: prune's dirty check is `git status`, which skips assume-unchanged files, so the worktree was removed with the edit.
test('a worktree edit hidden by assume-unchanged keeps the worktree, its edit and its branch', () => {
  assertHiddenEditKept('--assume-unchanged');
});

// Repro: the same with skip-worktree, which `git status` skips as well.
test('a worktree edit hidden by skip-worktree keeps the worktree, its edit and its branch', () => {
  assertHiddenEditKept('--skip-worktree');
});
