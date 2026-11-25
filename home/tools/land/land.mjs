#!/usr/bin/env node
// Purpose: land one lane on its base branch with one command: rebase the lane onto the base, optionally test the rebased tip,
//   fast-forward the base checkout to it and record that in the land ledger (ledger.mjs), then clear the lane away (a pool folder
//   of `git-tidy lane claim` is kept for the next lane, any other worktree is removed) and delete its branch, then every other
//   branch whose content is all on the base, and print what is left and why (sweep.mjs). It runs no review.
// Usage: node ~/.claude/tools/land/land.mjs <branch> [--repo <path>] [--test <command>] [--test-timeout <seconds>]
//   --repo is the base checkout (the folder where the base branch is checked out), default the current folder; the base is the
//   branch checked out there. --test runs <command> in the lane's worktree at the rebased tip; a failing test refuses the land.
// Exports: none (a CLI). Exit codes: 0 landed, 1 refused or stopped (the message says why and what to do), 2 usage error.
// Invariants:
// - Nothing changes before every check passed: an unknown branch, a dirty or half-merged base checkout or lane worktree, or a
//   lane checked out in the main worktree is refused with the reason; so is a lane with no commit in common with the base,
//   which a rebase would replay whole onto it.
// - With no --test the lane is rebased and lands, whatever files both sides changed. With --test the rebased tip must pass it
//   first, and the lane's branch moves only once it passed (test-gate.mjs); only a base that moves in the last step leaves the
//   lane at the tested sha.
// - History stays one line: the base moves only by `git merge --ff-only` of the full sha the rebase produced (never a moving
//   ref), and with --test that is the sha that was tested. The base's sha is read once: the rebase and the fast-forward both use
//   it, and a base that moved meanwhile is refused. A rebase that stops is aborted, so the lane is left as it was.
// - Never pushes and never forces: a pool folder (`<main>/.claude/worktrees/lane-<n>`) is detached at the landed sha and unlocked by
//   git-tidy's detachLandedSlot (../git-tidy/lib/lane-pool.mjs), never removed; any other worktree, or a pool folder that could not
//   be detached, is unlocked when locked, then removed with `git worktree remove`; the branch goes with `git branch -d`. Git runs
//   without a shell and without the variables that pick a repository (../git-tidy/lib/git.mjs).
// - The land ledger gets one line per landing, written only after the fast-forward. A base that moved always gets its line. A
//   base that did not move gets none when the ledger already has a line for the branch at a sha the base holds: that is a
//   re-run after a clean-up stop, also when other lanes moved the base before it. Otherwise (a lane with no new commit) it gets
//   a line with 0 commits, so a reader sees the lane as landed. A line that cannot be written, or a ledger that cannot be read
//   for that check, is one stderr warning each, and the landing goes on and exits 0.
// - The clean-up after the landing runs `git-tidy prune --apply` over the repository: a branch goes only when its tip is on
//   the base or merging it would change nothing, and only after it is written to the deletion log. A clean-up that fails (a
//   deletion log that is not a regular file) is printed on stderr and removes nothing more; the landing stands and exits 0.
import { realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, gitFlag, gitText, runGit } from '../git-tidy/lib/git.mjs';
import { detachLandedSlot } from '../git-tidy/lib/lane-pool.mjs';
import { nestedRepositoryPaths, nestedRepositoryWhy } from '../git-tidy/lib/nested-repository.mjs';
import { listWorktrees, openRepo } from '../git-tidy/lib/repo.mjs';
import { appendLandEntry, readLandEntries } from './ledger.mjs';
import { LandRefusal, firstLine, refuseUnclean } from './refusal.mjs';
import { MAX_TIMEOUT_SECONDS } from './run-test.mjs';
import { sweepRepo } from './sweep.mjs';
import { testRebasedTip } from './test-gate.mjs';

const USAGE = 'usage: node ~/.claude/tools/land/land.mjs <branch> [--repo <path>] [--test <command>] [--test-timeout <seconds>]';
const HEADS = 'refs/heads/';
const EXIT_LANDED = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
// A whole test suite may take a while; past this a test counts as hung, and its processes are killed.
const DEFAULT_TEST_TIMEOUT_SECONDS = 30 * 60;
// The options that take a value, and what each value is (for the usage error when it is missing).
const OPTION_VALUES = { '--repo': 'a folder', '--test': 'a command', '--test-timeout': 'a number of seconds' };

/** The --test-timeout value as whole seconds; anything but a whole number from 1 to MAX_TIMEOUT_SECONDS is a UsageError. */
function parseSeconds(text) {
  if (!/^[1-9][0-9]*$/.test(text)) throw new UsageError(`--test-timeout needs a whole number of seconds above 0, not "${text}"\n${USAGE}`);
  const seconds = Number(text);
  if (seconds > MAX_TIMEOUT_SECONDS) throw new UsageError(`--test-timeout can be at most ${MAX_TIMEOUT_SECONDS} seconds (about 24 days), not ${text}\n${USAGE}`);
  return seconds;
}

/**
 * The parsed command line: `{ branch, repo, test, testTimeoutSeconds }` (`repo` defaults to the current folder, `test` to null).
 * Anything else is a UsageError.
 */
function parseArgs(argv) {
  const positional = [];
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (Object.hasOwn(OPTION_VALUES, arg)) {
      if (argv[i + 1] === undefined) throw new UsageError(`${arg} needs ${OPTION_VALUES[arg]}\n${USAGE}`);
      values[arg] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new UsageError(USAGE);
  if (values['--test']?.trim() === '') throw new UsageError(`--test needs a command\n${USAGE}`);
  return {
    branch: positional[0],
    repo: resolve(values['--repo'] ?? process.cwd()),
    test: values['--test'] ?? null,
    testTimeoutSeconds: values['--test-timeout'] === undefined ? DEFAULT_TEST_TIMEOUT_SECONDS : parseSeconds(values['--test-timeout']),
  };
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

/** Refuses a lane with no commit in common with the base: a rebase would replay all its history onto the base. */
function refuseUnrelated({ dir, base }, branch, baseSha) {
  if (runGit(dir, ['merge-base', baseSha, `${HEADS}${branch}`]).status === 0) return;
  throw new LandRefusal(`${branch} has no commit in common with ${base}: a rebase would replay its whole history onto ${base}; rebase it onto ${base} by hand, then land again`);
}

/**
 * Rebases the lane onto `baseSha`, in its own worktree, or in the base checkout (switched back to the base after) when it has
 * none. Used when no test runs. A rebase that stops is aborted, so the lane is left as it was. Returns the lane's full tip sha.
 */
function rebaseLane({ dir, base }, branch, worktree, baseSha) {
  const laneRef = `${HEADS}${branch}`;
  if (!gitFlag(dir, ['merge-base', '--is-ancestor', baseSha, laneRef])) {
    const where = worktree?.path ?? dir;
    const result = runGit(where, worktree ? ['rebase', '-q', baseSha] : ['rebase', '-q', baseSha, branch]);
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

/** Fast-forwards the base checkout from `baseSha` to `tip`. A base that moved meanwhile refuses. */
function fastForward({ dir, base }, branch, { baseSha, tip }) {
  const now = gitText(dir, ['rev-parse', '--verify', `${HEADS}${base}^{commit}`]);
  if (now !== baseSha) throw new LandRefusal(`${base} moved while landing (from ${baseSha} to ${now}); nothing landed, land again`);
  const result = runGit(dir, ['merge', '--ff-only', '-q', tip]);
  if (result.status !== 0) throw new LandRefusal(`git merge --ff-only of ${branch} (${tip}) into ${base} failed (${firstLine(result.stderr)}); nothing landed, land again`);
}

// Refuses the clean-up of a landed lane whose worktree holds a git repository inside an ignored folder: `git worktree remove`
// would delete it with commits that may be its only copy. The advice names the repository and never says to delete anything.
function refuseNestedRepository({ base }, branch, worktree, tip) {
  const nested = nestedRepositoryWhy(worktree.path);
  if (nested === null) return;
  const repositories = (nestedRepositoryPaths(worktree.path) ?? []).map((path) => join(worktree.path, path));
  const named = repositories.length > 0 ? repositories.join(', ') : nested;
  throw new LandRefusal(`${branch} landed on ${base} at ${tip}; its worktree ${worktree.path} is kept because ${named} may hold the only copy of its commits (a git repository inside an ignored folder): move it out of the worktree, then run land ${branch} again`);
}

/**
 * Clears the landed lane's worktree away and returns the line to print. A pool folder is detached at `tip` and unlocked for the
 * next lane (git-tidy's detachLandedSlot, given the repository the way git-tidy's own land opens it). Any other worktree, or a pool
 * folder that could not be detached (the line says why), is unlocked when locked and removed, after refuseNestedRepository.
 * Throws when a git step fails.
 */
function clearWorktree({ dir, base }, branch, worktree, tip) {
  const { folder, why } = detachLandedSlot(openRepo(dir, base), branch, tip);
  if (folder !== null) return `lane folder ${folder} detached at ${tip} (kept for the next lane)`;
  refuseNestedRepository({ base }, branch, worktree, tip);
  if (worktree.locked) gitText(dir, ['worktree', 'unlock', worktree.path]);
  gitText(dir, ['worktree', 'remove', worktree.path]);
  return why === undefined ? `removed worktree ${worktree.path}` : `removed worktree ${worktree.path} (not kept as a lane folder: ${why})`;
}

/**
 * Clears the lane's worktree away (clearWorktree) and deletes its branch; returns one line per step. A git repository inside an
 * ignored folder of a worktree to remove stops it first (refuseNestedRepository).
 */
function removeLane({ dir, base }, branch, worktree, tip) {
  const done = [];
  try {
    if (worktree !== null) done.push(clearWorktree({ dir, base }, branch, worktree, tip));
    gitText(dir, ['branch', '-d', branch]);
    done.push(`deleted branch ${branch}`);
  } catch (error) {
    if (error instanceof LandRefusal) throw error; // refuseNestedRepository's message says itself what to do
    throw new LandRefusal(`${branch} landed on ${base} at ${tip}, but the clean-up stopped: ${error.message}; deal with that, then run land ${branch} again`);
  }
  return done;
}

/**
 * Whether the ledger already holds this landing, so its line would count it twice: the base did not move (`baseSha` is `tip`)
 * and a line for `branch` has a landed sha the base holds. A base that moved is a new landing and is never skipped, even on a
 * second base checkout of the same repository (the ledger is one file per repository). A ledger that cannot be read counts as
 * no line, with a warning on stderr, so the line is written (and appendLandEntry warns when that fails too).
 */
function isLandedBefore(dir, branch, { baseSha, tip }) {
  if (baseSha !== tip) return false;
  let entries;
  try {
    ({ entries } = readLandEntries(dir));
  } catch (error) {
    console.error(`land: the ledger could not be read (${firstLine(error.message)}); the line of ${branch} is written without checking for an earlier one`);
    return false;
  }
  // runGit, not gitFlag: a line whose sha this clone does not have is simply not held, never a failed land
  return entries.some((entry) => entry.branch === branch && runGit(dir, ['merge-base', '--is-ancestor', entry.to, tip]).status === 0);
}

/**
 * The clean-up of the other branches (sweep.mjs). The lane has landed by then, so a failure (a deletion log that is not a regular
 * file, git failing) does not fail the land: it is printed on stderr and the clean-up stops, which keeps the other branches.
 */
function sweepAfter(checkout, branch, tip) {
  try {
    return sweepRepo(checkout);
  } catch (error) {
    console.error(`land: ${branch} landed on ${checkout.base} at ${tip} and was removed; the clean-up of other branches was skipped: ${firstLine(error.message)}`);
    return [];
  }
}

/** Lands `branch` on the base checked out at `repo`, printing one line per step. Throws LandRefusal when it refuses or stops. */
async function land({ branch, repo, test, testTimeoutSeconds }) {
  const checkout = openBase(repo);
  refuseUnclean('the base checkout', checkout.dir);
  const worktree = findLane(checkout, branch);
  if (worktree !== null) refuseUnclean(`the worktree of ${branch}`, worktree.path);
  const baseSha = gitText(checkout.dir, ['rev-parse', '--verify', `${HEADS}${checkout.base}^{commit}`]);
  refuseUnrelated(checkout, branch, baseSha);
  const tip = test === null
    ? rebaseLane(checkout, branch, worktree, baseSha)
    : await testRebasedTip(checkout, branch, worktree, { baseSha, command: test, timeoutSeconds: testTimeoutSeconds });
  fastForward(checkout, branch, { baseSha, tip });
  const count = gitText(checkout.dir, ['rev-list', '--count', `${baseSha}..${tip}`]);
  console.log(`landed ${branch} on ${checkout.base} at ${tip} (${count} commit(s))`);
  const entry = { at: new Date().toISOString(), repo: checkout.dir, branch, from: baseSha, to: tip, commits: Number(count) };
  const ledgerWarning = isLandedBefore(checkout.dir, branch, { baseSha, tip }) ? null : appendLandEntry(checkout.dir, entry);
  if (ledgerWarning !== null) console.error(ledgerWarning);
  for (const line of removeLane(checkout, branch, worktree, tip)) console.log(line);
  for (const line of sweepAfter(checkout, branch, tip)) console.log(line);
}

async function main(argv) {
  try {
    await land(parseArgs(argv));
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

process.exitCode = await main(process.argv.slice(2));
