// Purpose: the steps of `land` after the fast-forward (land.mjs): mark the base as a base, write the land ledger line, clear the
//   lane's worktree away and delete its branch, then sweep the other branches (sweep.mjs).
// Exports: finishLanding(landing).
// Invariants: the lane has landed when these run, so every message says the landing stands. A ledger line that cannot be
//   written stops before the clean-up (the lane is kept for a re-run that records it); a kept pool folder, a nested repository
//   or a failed git step stops the clean-up with the step to take; a failed sweep is one stderr line and keeps the rest.
import { join } from 'node:path';
import { markBase } from '../git-tidy/lib/base-record.mjs';
import { gitFlag, gitText } from '../git-tidy/lib/git.mjs';
import { detachLandedSlot } from '../git-tidy/lib/lane-pool.mjs';
import { nestedRepositoryPaths, nestedRepositoryWhy } from '../git-tidy/lib/nested-repository.mjs';
import { openRepo } from '../git-tidy/lib/repo.mjs';
import { appendLandEntry, readLandEntries } from './ledger.mjs';
import { LandRefusal, firstLine } from './refusal.mjs';
import { sweepRepo } from './sweep.mjs';

const HEADS = 'refs/heads/';

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
 * Clears the landed lane's worktree away and returns the line to print, or null when no worktree holds the branch. A pool folder
 * is detached at `tip` and unlocked for the next lane by git-tidy's detachLandedSlot (given the repository the way git-tidy's own
 * land opens it), which reads the worktrees under the pool lock. A worktree outside the pool from that read is unlocked when
 * locked and removed, after refuseNestedRepository. Throws LandRefusal for a pool folder the detach could not free (kept,
 * locked; the message ends with the `lane release` step), and Error when the detach could not run or a git step fails.
 */
function clearWorktree({ dir, base }, branch, tip) {
  const { folder, kept, other, why } = detachLandedSlot(openRepo(dir, base), branch, tip);
  if (folder !== null) return `lane folder ${folder} detached at ${tip} (kept for the next lane)`;
  if (kept !== null) throw new LandRefusal(`${branch} landed on ${base} at ${tip}; lane folder ${kept} not freed: ${why}`);
  if (why !== undefined) throw new Error(why);
  if (other === null) return null;
  refuseNestedRepository({ base }, branch, other, tip);
  if (other.locked) gitText(dir, ['worktree', 'unlock', other.path]);
  gitText(dir, ['worktree', 'remove', other.path]);
  return `removed worktree ${other.path}`;
}

/**
 * Clears the lane's worktree away (clearWorktree) and deletes its branch; returns one line per step. A branch already gone (a
 * `lane release` ran during the land) is a line. A kept pool folder or a git repository inside an ignored folder of a worktree to
 * remove stops it first with its own message (LandRefusal); any other failure says the landing stands and to run land again.
 */
function removeLane({ dir, base }, branch, tip) {
  const done = [];
  try {
    const cleared = clearWorktree({ dir, base }, branch, tip);
    if (cleared !== null) done.push(cleared);
    if (gitFlag(dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${branch}`])) {
      gitText(dir, ['branch', '-d', branch]);
      done.push(`deleted branch ${branch}`);
    } else {
      done.push(`branch ${branch} already deleted`);
    }
  } catch (error) {
    if (error instanceof LandRefusal) throw error; // a kept pool folder and refuseNestedRepository say themselves what to do
    throw new LandRefusal(`${branch} landed on ${base} at ${tip}, but the clean-up stopped: ${error.message}; deal with that, then run land ${branch} again`);
  }
  return done;
}

/**
 * Whether the ledger already holds this landing, so its line would count it twice: the base did not move (`baseSha` is `tip`)
 * and a line for `branch` has the lane's tip from before this run (`laneTip`) as its landed sha: a re-run after a clean-up stop,
 * also when other lanes moved the base in between (the rebase then moves the lane to the base, so `tip` is not that sha). Why
 * not any landed sha the base holds: an older job's land of the same branch name would match that, and a re-run after a ledger
 * line that was not written would then go unrecorded without a word. A base that moved is a new landing and is never skipped,
 * even on a second base checkout of the same repository (the ledger is one file per repository). A ledger that cannot be read
 * counts as no line, with a warning on stderr: the lane has landed by then, so the line is written.
 */
function isLandedBefore(dir, branch, { baseSha, tip, laneTip }) {
  if (baseSha !== tip) return false;
  try {
    return readLandEntries(dir).entries.some((entry) => entry.branch === branch && entry.to === laneTip);
  } catch (error) {
    console.error(`land: the ledger could not be checked (${firstLine(error.message)}); the line of ${branch} is written without checking for an earlier one`);
    return false;
  }
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

/**
 * After the fast-forward: marks the base, writes the ledger line, clears the lane away and sweeps the other branches, printing
 * one line per step. A ledger line that cannot be written throws LandRefusal before the clean-up: with the lane kept, a re-run
 * records it (the tick counts a piece as landed only by its ledger line).
 * @param {{checkout: {dir: string, base: string}, branch: string, baseSha: string, laneTip: string, tip: string, count: string}}
 *   landing what land.mjs fastForwardLane landed: the base's sha before, the lane's tip before the rebase, the landed sha and
 *   the commit count
 * @throws {LandRefusal} for a ledger line not written, or a clean-up that stopped (removeLane); the landing stands
 */
export function finishLanding({ checkout, branch, baseSha, laneTip, tip, count }) {
  const markWarning = markBase(checkout.dir, checkout.base);
  if (markWarning !== null) console.error(`land: ${markWarning}`);
  const entry = { at: new Date().toISOString(), repo: checkout.dir, branch, from: baseSha, to: tip, commits: Number(count) };
  const ledgerWarning = isLandedBefore(checkout.dir, branch, { baseSha, tip, laneTip }) ? null : appendLandEntry(checkout.dir, entry);
  if (ledgerWarning !== null) {
    console.error(ledgerWarning);
    throw new LandRefusal(`landed but not recorded: the ledger line of ${branch} at ${tip} was not written (above), so its branch and folder are kept; run land again to record it`);
  }
  for (const line of removeLane(checkout, branch, tip)) console.log(line);
  for (const line of sweepAfter(checkout, branch, tip)) console.log(line);
}
