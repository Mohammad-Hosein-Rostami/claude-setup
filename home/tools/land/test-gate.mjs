// Purpose: the test gate of `land`: which files the base and the lane both changed, which test (if any) the rebased tip must
//   pass, and the test run itself on a rebased copy of the lane.
// Exports: overlappingFiles, testRebasedTip.
// Invariants:
// - The overlap is read from the lane's own branch point, before anything moves.
// - The lane's branch moves only after its rebased tip passed the test and the checks after it: the rebase and the test run on a
//   detached HEAD in the lane's worktree. Every refusal here puts the worktree back on the unchanged branch, so the next `land`
//   sees the same overlap and asks for the test again.
// - A rebase conflict is reported first, before any question about which test to run.
// - The sha that lands is the sha that was tested: a lane, worktree or base checkout that changed during the test is refused,
//   and so is a test that edited tracked files in the worktree (what it tested would not be the commit).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from '../git-tidy/lib/git.mjs';
import { LandRefusal, firstLine, refuseUnclean } from './refusal.mjs';
import { runTestCommand } from './run-test.mjs';

const HEADS = 'refs/heads/';
// The test run when files overlap and no --test is given, if the lane's package.json defines a test script.
const PACKAGE_TEST_COMMAND = 'npm test';
// How many overlapping files a message lists; the rest are counted.
const LISTED_FILES = 20;

/** The full sha `ref` names in `dir`, or '' when it names nothing. */
const shaOf = (dir, ref) => runGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).stdout.trim();

/** The paths that differ between commits `from` and `to` (a rename counts as both its old and its new path). */
function changedPaths(dir, from, to) {
  // -z keeps every path exactly as stored (spaces, quotes, newlines); --no-renames reports a rename as a delete and an add.
  const result = runGit(dir, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to]);
  if (result.status !== 0) throw new LandRefusal(`git cannot compare ${from} with ${to} (${firstLine(result.stderr)})`);
  return result.stdout.split('\0').filter((path) => path !== '');
}

/**
 * The files both the base (at `baseSha`) and the lane changed since the lane branched from the base, sorted; empty when the
 * base has not moved since.
 * @throws {LandRefusal} for a lane with no commit in common with the base: there is no branch point to compare from
 */
export function overlappingFiles({ dir, base }, branch, baseSha) {
  const laneRef = `${HEADS}${branch}`;
  const branchPoint = runGit(dir, ['merge-base', baseSha, laneRef]);
  if (branchPoint.status !== 0) {
    throw new LandRefusal(`${branch} has no commit in common with ${base}, so land cannot tell which files both changed; rebase it onto ${base} by hand, then land again`);
  }
  const branchSha = branchPoint.stdout.trim();
  const laneChanged = new Set(changedPaths(dir, branchSha, laneRef));
  return changedPaths(dir, branchSha, baseSha).filter((path) => laneChanged.has(path)).sort();
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
    throw new LandRefusal(`cannot read ${path} (${error.message}); nothing changed. Name the test with --test "<command>"`);
  }
  const script = manifest?.scripts?.test;
  return typeof script === 'string' && script.trim() !== '' ? PACKAGE_TEST_COMMAND : null;
}

/** The overlap, as the first lines of a refusal; empty when no file overlaps. */
const overlapNote = ({ base }, branch, overlap) => (overlap.length > 0 ? `${describeOverlap(base, branch, overlap)}\n` : '');

/**
 * The command the rebased tip must pass: --test, else the lane's package.json test script (read from the rebased worktree).
 * Only called when a test is needed. Throws LandRefusal when there is none.
 */
function chooseTest(checkout, branch, worktree, { requested, overlap }) {
  const command = requested ?? packageTest(worktree.path);
  if (command !== null) return command;
  throw new LandRefusal(`${overlapNote(checkout, branch, overlap)}so the rebased tip must pass a test before it lands, and the lane has no package.json test script; nothing changed. Name the test: node ~/.claude/tools/land/land.mjs ${branch} --repo ${checkout.dir} --test "<test command>"`);
}

/**
 * Rebases the lane's commits onto `baseSha` in its worktree on a detached HEAD; the branch itself stays where it was. A rebase
 * that stops is aborted and the worktree switched back to the branch. Returns the rebased tip's full sha.
 */
function rebaseDetached({ base }, branch, worktree, baseSha) {
  const where = worktree.path;
  const detach = runGit(where, ['switch', '-q', '--detach']);
  if (detach.status !== 0) throw new LandRefusal(`cannot detach the worktree of ${branch} (${where}) to rebase it (${firstLine(detach.stderr)}); nothing changed`);
  const result = runGit(where, ['rebase', '-q', baseSha]);
  if (result.status !== 0) {
    const aborted = runGit(where, ['rebase', '--abort']).status === 0;
    const back = runGit(where, ['switch', '-q', branch]).status === 0;
    const state = aborted && back ? `it was aborted, so ${branch} is as it was` : `finish or abort it by hand in ${where}, then run git switch ${branch} there`;
    throw new LandRefusal(`the rebase of ${branch} onto ${base} stopped (${firstLine(result.stderr || result.stdout)}); ${state}. Rebase it by hand (git rebase ${base} in ${where}), then land again`);
  }
  return shaOf(where, 'HEAD');
}

/** Refuses when anything that decides what lands changed while the test ran: the worktree, the branch, the base checkout. */
function refuseChangedDuringTest({ dir, base }, branch, worktree, { laneTip, tip }) {
  const head = shaOf(worktree.path, 'HEAD');
  if (head !== tip) throw new LandRefusal(`the worktree of ${branch} moved during the test (from ${tip} to ${head || 'nothing'}), so the tested sha is not what would land; nothing landed, land again`);
  const edited = runGit(worktree.path, ['status', '--porcelain', '-z', '--untracked-files=no']);
  if (edited.status !== 0) throw new LandRefusal(`git cannot read the status of the worktree of ${branch} (${worktree.path}) after the test`);
  if (edited.stdout !== '') {
    throw new LandRefusal(`the test changed tracked files in the worktree of ${branch} (${worktree.path}), so what it tested is not the commit that would land; nothing landed. Undo the changes (git status there), make the test leave them alone, then land again`);
  }
  const now = shaOf(dir, `${HEADS}${branch}`);
  if (now !== laneTip) throw new LandRefusal(`${branch} moved during the test (from ${laneTip} to ${now || 'nothing'}); nothing landed, land again`);
  // The test may have taken minutes: the base checkout must still be clean and still on the base.
  refuseUnclean('the base checkout', dir);
  const baseHead = runGit(dir, ['symbolic-ref', '-q', 'HEAD']).stdout.trim();
  if (baseHead !== `${HEADS}${base}`) {
    throw new LandRefusal(`the base checkout (${dir}) left ${base} during the test (HEAD is now ${baseHead || 'detached'}); nothing landed: check out ${base} there, then land again`);
  }
}

/** Puts the worktree back on its unchanged branch after a refusal; returns `error`, with a note when that failed. */
function restoreLane(worktree, branch, tip, error) {
  if (runGit(worktree.path, ['switch', '-q', branch]).status === 0) return error;
  const note = `the worktree ${worktree.path} could not switch back to ${branch} and is left detached at ${tip}; clean it, then run git switch ${branch} there`;
  return error instanceof LandRefusal ? new LandRefusal(`${error.message}\n${note}`) : new Error(`${error.message}\n${note}`, { cause: error });
}

/** The refusal for a test that did not pass, with the last lines of its output. */
function testFailure({ base }, branch, worktree, { command, tip, outcome }) {
  const tail = outcome.tail.length > 0 ? `\nlast ${outcome.tail.length} line(s) of the test output:\n${outcome.tail.join('\n')}` : '\nthe test printed nothing';
  return new LandRefusal(`the test of ${tip} failed (${outcome.reason}): ${command}. Nothing landed: ${base} did not move and ${branch} is as it was. To see the failure, rebase it (git rebase ${base} in ${worktree.path}), fix it, then land again with --test${tail}`);
}

/**
 * Rebases the lane onto `baseSha`, runs the test on the rebased tip in the lane's worktree, and only when it passed moves the
 * branch to that tip. Called when --test is given or files overlap.
 * Why: a failed test must leave the lane where it was; a lane left rebased would show no overlap to the next `land`, which
 * would then fast-forward the untested merged code.
 * @param {{dir: string, base: string}} checkout the base checkout
 * @param {string} branch the lane
 * @param {{path: string} | null} worktree the lane's worktree (clean), or null when it has none
 * @param {{baseSha: string, requested: string | null, overlap: string[], timeoutSeconds: number}} run what to rebase onto,
 *   the --test command (null: the package.json test script), the overlapping files and the test's deadline
 * @returns {Promise<string>} the tested full sha, which the branch now points at
 * @throws {LandRefusal} with no worktree or no test to run, on a rebase conflict, a test that did not pass, or a change during
 *   the test; the branch has not moved
 */
export async function testRebasedTip(checkout, branch, worktree, { baseSha, requested, overlap, timeoutSeconds }) {
  if (worktree === null) {
    throw new LandRefusal(`${overlapNote(checkout, branch, overlap)}a test must run on the rebased tip, in the lane's worktree, and ${branch} has none; nothing changed. Add one (git worktree add <folder> ${branch}), then land again`);
  }
  const laneTip = shaOf(checkout.dir, `${HEADS}${branch}`);
  const tip = rebaseDetached(checkout, branch, worktree, baseSha);
  try {
    const command = chooseTest(checkout, branch, worktree, { requested, overlap });
    if (overlap.length > 0) console.log(describeOverlap(checkout.base, branch, overlap));
    console.log(`testing ${tip} in ${worktree.path}: ${command}`);
    const outcome = await runTestCommand(command, worktree.path, timeoutSeconds);
    if (!outcome.passed) throw testFailure(checkout, branch, worktree, { command, tip, outcome });
    console.log(`test passed on ${tip}`);
    refuseChangedDuringTest(checkout, branch, worktree, { laneTip, tip });
    // From here on the branch points at the tested sha.
    const adopt = runGit(worktree.path, ['switch', '-q', '-C', branch]);
    if (adopt.status !== 0) throw new LandRefusal(`cannot move ${branch} to the tested ${tip} (${firstLine(adopt.stderr)}); nothing landed, land again`);
  } catch (error) {
    throw restoreLane(worktree, branch, tip, error);
  }
  return tip;
}
