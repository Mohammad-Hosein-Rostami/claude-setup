#!/usr/bin/env node
// Purpose: land one lane on its base branch with one command: rebase the lane onto the base, optionally test the rebased tip,
//   fast-forward the base checkout to it, then delete the lane's worktree and branch, then every other branch whose content is
//   all on the base, and print what is left and why (sweep.mjs). It runs no review.
// Usage: node ~/.claude/tools/land/land.mjs <branch> [--repo <path>] [--test <command>] [--test-timeout <seconds>]
//   --repo is the base checkout (the folder where the base branch is checked out), default the current folder; the base is the
//   branch checked out there. --test runs <command> in the lane's worktree at the rebased tip; a failing test refuses the land.
// Exports: none (a CLI). Exit codes: 0 landed, 1 refused or stopped (the message says why and what to do), 2 usage error.
// Invariants:
// - Nothing changes before every check passed: an unknown branch, a dirty or half-merged base checkout or lane worktree, or a
//   lane checked out in the main worktree is refused with the reason. Files both sides changed with no test to run are refused
//   after a trial rebase on a detached HEAD, so a conflict is still reported as a conflict; the branch has not moved.
// - When the base and the lane both changed a file since the lane branched, the rebased tip must pass a test (--test, else the
//   lane's package.json test script) before it lands: a rebase without a textual conflict can still break the merged code.
//   The lane's branch moves only once that test passed (test-gate.mjs), so after a refusal the next `land` asks again; only a
//   base that moves in the last step leaves the lane at the tested sha.
// - History stays one line: the base moves only by `git merge --ff-only` of the full sha the rebase produced (never a moving
//   ref), and that is the sha that was tested. The base's sha is read once: the overlap, the rebase and the fast-forward all use
//   it, and a base that moved meanwhile is refused. A rebase that stops is aborted, so the lane is left as it was.
// - Never pushes and never forces: a locked worktree is unlocked, then removed with `git worktree remove`; the branch goes with
//   `git branch -d`. Git runs without a shell and without the variables that pick a repository (../git-tidy/lib/git.mjs).
// - The clean-up after the landing runs `git-tidy prune --apply` over the repository: a branch goes only when its tip is on
//   the base or merging it would change nothing, and only after it is written to the deletion log. A clean-up that fails (a
//   deletion log that is not a regular file) is printed on stderr and removes nothing more; the landing stands and exits 0.
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError, gitFlag, gitText, runGit } from '../git-tidy/lib/git.mjs';
import { listWorktrees } from '../git-tidy/lib/repo.mjs';
import { LandRefusal, firstLine, refuseUnclean } from './refusal.mjs';
import { MAX_TIMEOUT_SECONDS } from './run-test.mjs';
import { sweepRepo } from './sweep.mjs';
import { overlappingFiles, testRebasedTip } from './test-gate.mjs';

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
  // Read before the rebase, which moves the lane's branch point to the base's tip.
  const overlap = overlappingFiles(checkout, branch, baseSha);
  const tip = test === null && overlap.length === 0
    ? rebaseLane(checkout, branch, worktree, baseSha)
    : await testRebasedTip(checkout, branch, worktree, { baseSha, requested: test, overlap, timeoutSeconds: testTimeoutSeconds });
  fastForward(checkout, branch, { baseSha, tip });
  const count = gitText(checkout.dir, ['rev-list', '--count', `${baseSha}..${tip}`]);
  console.log(`landed ${branch} on ${checkout.base} at ${tip} (${count} commit(s))`);
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
