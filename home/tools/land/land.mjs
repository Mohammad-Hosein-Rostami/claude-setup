#!/usr/bin/env node
// Purpose: land one lane on its base branch with one command: rebase the lane onto the base, optionally test the rebased tip,
//   fast-forward the base checkout to it, then delete the lane's worktree and branch. It runs no review.
// Usage: node ~/.claude/tools/land/land.mjs <branch> [--repo <path>] [--test <command>] [--test-timeout <seconds>]
//   --repo is the base checkout (the folder where the base branch is checked out), default the current folder; the base is the
//   branch checked out there. --test runs <command> in the lane's worktree at the rebased tip; a failing test refuses the land.
// Exports: none (a CLI). Exit codes: 0 landed, 1 refused or stopped (the message says why and what to do), 2 usage error.
// Invariants:
// - Nothing changes before every check passed: an unknown branch, a dirty or half-merged base checkout or lane worktree, or a
//   lane checked out in the main worktree is refused with the reason.
// - When the base and the lane both changed a file since the lane branched, the rebased tip must pass a test (--test, else the
//   lane's package.json test script) before it lands: a rebase without a textual conflict can still break the merged code.
//   A textual conflict stops the rebase first, as it always did; with no test to run the lane is left rebased, base unmoved.
// - History stays one line: the base moves only by `git merge --ff-only` of the full sha the rebase produced (never a moving
//   ref), and that is the sha that was tested; a lane that moved during the test is refused. A rebase that stops is aborted, so
//   the lane is left as it was; a test that fails leaves the base where it was and the lane rebased.
// - Never pushes and never forces: a locked worktree is unlocked, then removed with `git worktree remove`; the branch goes with
//   `git branch -d`. Git runs without a shell and without the variables that pick a repository (../git-tidy/lib/git.mjs).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, gitFlag, gitText, runGit } from '../git-tidy/lib/git.mjs';
import { changedFileCount, inProgressOperation, listWorktrees } from '../git-tidy/lib/repo.mjs';
import { runTestCommand } from './run-test.mjs';

const USAGE = 'usage: node ~/.claude/tools/land/land.mjs <branch> [--repo <path>] [--test <command>] [--test-timeout <seconds>]';
const HEADS = 'refs/heads/';
const EXIT_LANDED = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
// A whole test suite may take a while; past this a test counts as hung, and its processes are killed.
const DEFAULT_TEST_TIMEOUT_SECONDS = 30 * 60;
// The test run when files overlap and no --test is given, if the lane's package.json defines a test script.
const PACKAGE_TEST_COMMAND = 'npm test';
// How many overlapping files a message lists; the rest are counted.
const LISTED_FILES = 20;
// The options that take a value, and what each value is (for the usage error when it is missing).
const OPTION_VALUES = { '--repo': 'a folder', '--test': 'a command', '--test-timeout': 'a number of seconds' };

/** A check that failed, or a step that stopped; the message says why and what to do. The CLI prints it and exits 1. */
class LandRefusal extends Error {}

// git's first message line; a progress line ends in a carriage return, so CR counts as a line end too.
const firstLine = (text) => text.split(/[\r\n]+/).find((line) => line.trim() !== '')?.trim() ?? '';

/** The --test-timeout value as whole seconds; anything but a positive whole number is a UsageError. */
function parseSeconds(text) {
  if (!/^[1-9][0-9]*$/.test(text)) throw new UsageError(`--test-timeout needs a whole number of seconds above 0, not "${text}"\n${USAGE}`);
  return Number(text);
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

/** The paths that differ between commits `from` and `to` (a rename counts as both its old and its new path). */
function changedPaths(dir, from, to) {
  // -z keeps every path exactly as stored (spaces, quotes, newlines); --no-renames reports a rename as a delete and an add.
  const result = runGit(dir, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to]);
  if (result.status !== 0) throw new LandRefusal(`git cannot compare ${from} with ${to} (${firstLine(result.stderr)})`);
  return result.stdout.split('\0').filter((path) => path !== '');
}

/**
 * The files both the base and the lane changed since the lane branched from the base, sorted; empty when the base has not
 * moved since. A lane with no commit in common with the base is refused, since there is no branch point to compare from.
 */
function overlappingFiles({ dir, base }, branch) {
  const [baseRef, laneRef] = [`${HEADS}${base}`, `${HEADS}${branch}`];
  const branchPoint = runGit(dir, ['merge-base', baseRef, laneRef]);
  if (branchPoint.status !== 0) {
    throw new LandRefusal(`${branch} has no commit in common with ${base}, so land cannot tell which files both changed; rebase it onto ${base} by hand, then land again`);
  }
  const branchSha = branchPoint.stdout.trim();
  const laneChanged = new Set(changedPaths(dir, branchSha, laneRef));
  return changedPaths(dir, branchSha, baseRef).filter((path) => laneChanged.has(path)).sort();
}

/** The overlap as one line per file (at most LISTED_FILES, then a count of the rest), indented under a header line. */
function describeOverlap(base, branch, files) {
  const listed = files.slice(0, LISTED_FILES).map((path) => `  ${path}`);
  const rest = files.length > LISTED_FILES ? [`  ... and ${files.length - LISTED_FILES} more`] : [];
  return [`${base} and ${branch} both changed ${files.length} file(s) since ${branch} branched:`, ...listed, ...rest].join('\n');
}

/** PACKAGE_TEST_COMMAND when `folder` has a package.json with a non-empty test script, else null. */
function packageTest(folder) {
  const path = join(folder, 'package.json');
  if (!existsSync(path)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LandRefusal(`cannot read ${path} (${error.message}); name the test with --test "<command>"`);
  }
  const script = manifest?.scripts?.test;
  return typeof script === 'string' && script.trim() !== '' ? PACKAGE_TEST_COMMAND : null;
}

/**
 * The test command to run on the rebased tip, or null when none is needed: --test always runs; without it a test is needed only
 * when both sides changed the same files, and then the lane's package.json test script is used. Called after the rebase, so the
 * package.json read is the rebased one. Refuses when a test must run and there is no worktree to run it in, or no command.
 */
function chooseTest({ dir, base }, branch, worktree, { requested, overlap }) {
  if (requested === null && overlap.length === 0) return null;
  const overlapNote = overlap.length > 0 ? `${describeOverlap(base, branch, overlap)}\n` : '';
  const state = `nothing landed: ${base} did not move and ${branch} is rebased onto it`;
  if (worktree === null) {
    throw new LandRefusal(`${overlapNote}a test must run on the rebased tip, in the lane's worktree, and ${branch} has none; ${state}. Add one (git worktree add <folder> ${branch}), then land again`);
  }
  const command = requested ?? packageTest(worktree.path);
  if (command !== null) return command;
  throw new LandRefusal(`${overlapNote}so the rebased tip must pass a test before it lands, and the lane has no package.json test script; ${state}. Name the test: node ~/.claude/tools/land/land.mjs ${branch} --repo ${dir} --test "<test command>"`);
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

/**
 * Runs `command` in the lane's worktree at `tip` and refuses unless it passed and the lane is still at `tip` afterwards, so the
 * sha that lands is the sha that was tested. Returns the report line.
 */
async function testTip({ dir, base }, branch, worktree, { command, tip, timeoutSeconds }) {
  console.log(`testing ${tip} in ${worktree.path}: ${command}`);
  const outcome = await runTestCommand(command, worktree.path, timeoutSeconds);
  if (!outcome.passed) {
    const tail = outcome.tail.length > 0 ? `\nlast ${outcome.tail.length} line(s) of the test output:\n${outcome.tail.join('\n')}` : '\nthe test printed nothing';
    throw new LandRefusal(`the test of ${tip} failed (${outcome.reason}): ${command}. Nothing landed: ${base} did not move and ${branch} is left rebased in ${worktree.path}; fix it there, then land again${tail}`);
  }
  const now = runGit(dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${branch}^{commit}`]).stdout.trim();
  if (now !== tip) throw new LandRefusal(`${branch} moved during the test (from ${tip} to ${now || 'nothing'}), so the tested sha is not its tip; nothing landed, land again`);
  return `test passed on ${tip}`;
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

/** Lands `branch` on the base checked out at `repo`, printing one line per step. Throws LandRefusal when it refuses or stops. */
async function land({ branch, repo, test, testTimeoutSeconds }) {
  const checkout = openBase(repo);
  refuseUnclean('the base checkout', checkout.dir);
  const worktree = findLane(checkout, branch);
  if (worktree !== null) refuseUnclean(`the worktree of ${branch}`, worktree.path);
  // Read before the rebase, which moves the lane's branch point to the base's tip.
  const overlap = overlappingFiles(checkout, branch);
  const tip = rebaseLane(checkout, branch, worktree);
  const command = chooseTest(checkout, branch, worktree, { requested: test, overlap });
  if (overlap.length > 0) console.log(describeOverlap(checkout.base, branch, overlap));
  if (command !== null) {
    console.log(await testTip(checkout, branch, worktree, { command, tip, timeoutSeconds: testTimeoutSeconds }));
    // The test may have taken minutes; someone may have edited the base checkout meanwhile.
    refuseUnclean('the base checkout', checkout.dir);
  }
  const before = fastForward(checkout, branch, tip);
  const count = gitText(checkout.dir, ['rev-list', '--count', `${before}..${tip}`]);
  console.log(`landed ${branch} on ${checkout.base} at ${tip} (${count} commit(s))`);
  for (const line of removeLane(checkout, branch, worktree, tip)) console.log(line);
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
