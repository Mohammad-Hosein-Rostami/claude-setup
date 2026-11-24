#!/usr/bin/env node
// Purpose: land one lane on its base branch with one command: rebase the lane onto the base, fast-forward the base checkout to it,
//   then delete the lane's worktree and branch. It runs no tests and no review: run those before landing.
// Usage: node ~/.claude/tools/land/land.mjs <branch> [--repo <path>]
//   --repo is the base checkout (the folder where the base branch is checked out), default the current folder; the base is the
//   branch checked out there.
// Exports: none (a CLI). Exit codes: 0 landed, 1 refused or stopped (the message says why and what to do), 2 usage error.
// Invariants:
// - Nothing changes before every check passed: an unknown branch, a dirty or half-merged base checkout or lane worktree, or a lane
//   checked out in the main worktree is refused with the reason.
// - History stays one line: the base moves only by `git merge --ff-only` of the full sha the rebase produced (never a moving
//   ref); a rebase that stops is aborted, so the lane is left as it was.
// - Never pushes and never forces: a locked worktree is unlocked, then removed with `git worktree remove`; the branch goes with
//   `git branch -d`. Git runs without a shell and without the variables that pick a repository (../git-tidy/lib/git.mjs).
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError, gitFlag, gitText, runGit } from '../git-tidy/lib/git.mjs';
import { changedFileCount, inProgressOperation, listWorktrees } from '../git-tidy/lib/repo.mjs';

const USAGE = 'usage: node ~/.claude/tools/land/land.mjs <branch> [--repo <path>]';
const HEADS = 'refs/heads/';
const EXIT_LANDED = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

/** A check that failed, or a step that stopped; the message says why and what to do. The CLI prints it and exits 1. */
class LandRefusal extends Error {}

// git's first message line; a progress line ends in a carriage return, so CR counts as a line end too.
const firstLine = (text) => text.split(/[\r\n]+/).find((line) => line.trim() !== '')?.trim() ?? '';

/** `{ branch, repo }` from the arguments (`repo` defaults to the current folder); anything else is a UsageError. */
function parseArgs(argv) {
  const positional = [];
  let repo = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') {
      if (argv[i + 1] === undefined) throw new UsageError(`--repo needs a folder\n${USAGE}`);
      repo = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i].startsWith('-')) {
      throw new UsageError(`unknown option ${argv[i]}\n${USAGE}`);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) throw new UsageError(USAGE);
  return { branch: positional[0], repo };
}

/** The base checkout `{ dir, base }`: the top folder of the checkout at `repo` and the branch checked out there. */
function openBase(repo) {
  if (!statSync(repo, { throwIfNoEntry: false })?.isDirectory()) throw new LandRefusal(`${repo} is not a folder; pass the base checkout with --repo <path>`);
  const top = runGit(repo, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new LandRefusal(`${repo} is not inside a git checkout; pass the base checkout with --repo <path>`);
  const dir = realpathSync(top.stdout.trim());
  const head = runGit(dir, ['symbolic-ref', '-q', 'HEAD']);
  if (head.status !== 0) throw new LandRefusal(`${dir} has no branch checked out (detached HEAD); check out the base branch there first`);
  return { dir, base: head.stdout.trim().slice(HEADS.length) };
}

/** Refuses when the checkout at `dir` has an unfinished operation or any changed or untracked file (`what` names it). */
function refuseUnclean(what, dir) {
  const operation = inProgressOperation(dir);
  if (operation !== null) throw new LandRefusal(`${what} (${dir}) has an unfinished ${operation}; finish or abort it first`);
  const changed = changedFileCount(dir);
  if (changed === null) throw new LandRefusal(`git cannot read the status of ${what} (${dir})`);
  if (changed > 0) throw new LandRefusal(`${what} (${dir}) has ${changed} changed or untracked file(s); commit or move them first`);
}

/** The lane's worktree entry (git-tidy listWorktrees), or null when the branch is not checked out anywhere. */
function findLane({ dir, base }, branch) {
  if (runGit(dir, ['check-ref-format', '--branch', branch]).status !== 0) throw new LandRefusal(`"${branch}" is not a valid branch name`);
  if (branch === base) throw new LandRefusal(`${branch} is the base checked out in ${dir}; name the lane branch to land`);
  if (runGit(dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${branch}`]).status !== 0) throw new LandRefusal(`there is no branch ${branch} in ${dir}`);
  const worktree = listWorktrees({ dir }).find((entry) => entry.branch === branch) ?? null;
  if (worktree?.main) throw new LandRefusal(`${branch} is checked out in the main worktree ${worktree.path}; switch that folder to another branch first`);
  if (worktree?.missing) throw new LandRefusal(`the worktree folder of ${branch} (${worktree.path}) is gone; run git worktree unlock and git worktree prune, then land again`);
  return worktree;
}

/**
 * Rebases the lane onto the base, in its own worktree, or in the base checkout (switched back to the base after) when it has none.
 * A rebase that stops is aborted, so the lane is left as it was. Returns the lane's full tip sha after the rebase.
 */
function rebaseLane({ dir, base }, branch, worktree) {
  const laneRef = `${HEADS}${branch}`;
  if (!gitFlag(dir, ['merge-base', '--is-ancestor', `${HEADS}${base}`, laneRef])) {
    const where = worktree?.path ?? dir;
    const result = runGit(where, worktree ? ['rebase', '-q', `${HEADS}${base}`] : ['rebase', '-q', `${HEADS}${base}`, branch]);
    if (result.status !== 0) {
      const aborted = runGit(where, ['rebase', '--abort']).status === 0;
      const back = worktree || runGit(dir, ['switch', '-q', base]).status === 0;
      const state = aborted && back ? `it was aborted, so ${branch} is as it was` : `finish or abort it by hand in ${where}, and check out ${base} in ${dir}`;
      throw new LandRefusal(`the rebase of ${branch} onto ${base} stopped (${firstLine(result.stderr || result.stdout)}); ${state}. Rebase it by hand (git rebase ${base} in ${where}), then land again`);
    }
    if (!worktree) gitText(dir, ['switch', '-q', base]);
  }
  return gitText(dir, ['rev-parse', '--verify', `${laneRef}^{commit}`]);
}

/** Fast-forwards the base checkout to `tip`; returns the base's sha before. A base that moved meanwhile refuses. */
function fastForward({ dir, base }, branch, tip) {
  const before = gitText(dir, ['rev-parse', '--verify', `${HEADS}${base}^{commit}`]);
  const result = runGit(dir, ['merge', '--ff-only', '-q', tip]);
  if (result.status !== 0) throw new LandRefusal(`git merge --ff-only of ${branch} (${tip}) into ${base} failed (${firstLine(result.stderr)}); nothing landed, land again`);
  return before;
}

/** Removes the lane's worktree (unlocked first) and deletes its branch; returns one line per step. */
function removeLane({ dir, base }, branch, worktree, tip) {
  const done = [];
  try {
    if (worktree !== null) {
      if (worktree.locked) gitText(dir, ['worktree', 'unlock', worktree.path]);
      gitText(dir, ['worktree', 'remove', worktree.path]);
      done.push(`removed worktree ${worktree.path}`);
    }
    gitText(dir, ['branch', '-d', branch]);
    done.push(`deleted branch ${branch}`);
  } catch (error) {
    throw new LandRefusal(`${branch} landed on ${base} at ${tip}, but the clean-up stopped: ${error.message}; remove the rest by hand`);
  }
  return done;
}

/** Lands `branch` on the base checked out at `repo`; returns the report lines. Throws LandRefusal when it refuses or stops. */
function land(branch, repo) {
  const checkout = openBase(repo);
  refuseUnclean('the base checkout', checkout.dir);
  const worktree = findLane(checkout, branch);
  if (worktree !== null) refuseUnclean(`the worktree of ${branch}`, worktree.path);
  const tip = rebaseLane(checkout, branch, worktree);
  const before = fastForward(checkout, branch, tip);
  const count = gitText(checkout.dir, ['rev-list', '--count', `${before}..${tip}`]);
  return [`landed ${branch} on ${checkout.base} at ${tip} (${count} commit(s))`, ...removeLane(checkout, branch, worktree, tip)];
}

function main(argv) {
  try {
    const { branch, repo } = parseArgs(argv);
    for (const line of land(branch, repo)) console.log(line);
    return EXIT_LANDED;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return EXIT_USAGE;
    }
    console.error(error instanceof LandRefusal ? `land: ${error.message}` : error);
    return EXIT_REFUSED;
  }
}

process.exitCode = main(process.argv.slice(2));
