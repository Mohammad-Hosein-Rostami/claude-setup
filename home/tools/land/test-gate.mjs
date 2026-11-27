// Purpose: the test step of `land --test`: the test run on a rebased copy of the lane, which lands only when it passed.
// Exports: testRebasedTip.
// Invariants:
// - The lane's branch moves only after its rebased tip passed the test and the checks after it: the rebase and the test run on a
//   detached HEAD in the lane's worktree. Every refusal here puts the worktree back on the unchanged branch.
// - The sha that lands is the sha that was tested: a lane, worktree or base checkout that changed during the test is refused,
//   and so is a test that edited tracked files in the worktree (what it tested would not be the commit).
import { runGit } from '../git-tidy/lib/git.mjs';
import { shellWord } from '../git-tidy/lib/shell-word.mjs';
import { LandRefusal, firstLine, refuseUnclean } from './refusal.mjs';
import { runTestCommand } from './run-test.mjs';

const HEADS = 'refs/heads/';
// The advised folder is a pool folder, not `git worktree add`: land detaches a landed pool folder and keeps it for the next lane,
// where a plain worktree is removed. No `--base`: claim keeps an existing branch at its own tip.
const CLAIM_COMMAND = 'node ~/.claude/tools/git-tidy/git-tidy.mjs lane claim'; // ~ unquoted: the shell expands it

/** The full sha `ref` names in `dir`, or '' when it names nothing. */
const shaOf = (dir, ref) => runGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).stdout.trim();

/**
 * Rebases the lane's commits onto `baseSha` in its worktree on a detached HEAD; the branch itself stays where it was. A rebase
 * that stops is aborted and the worktree switched back to the branch. Returns the rebased tip's full sha.
 */
function rebaseDetached({ base }, branch, worktree, baseSha) {
  const where = worktree.path;
  const detach = runGit(where, ['switch', '-q', '--detach']);
  if (detach.status !== 0) throw new LandRefusal(`cannot detach the worktree of ${branch} (${where}) to rebase it (${firstLine(detach.stderr)}); nothing changed`);
  // --reapply-cherry-picks: keep a commit whose patch id pairs with a base commit but whose change is not there (land.mjs rebaseLane)
  const result = runGit(where, ['rebase', '-q', '--reapply-cherry-picks', baseSha]);
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
 * Rebases the lane onto `baseSha`, runs the --test command on the rebased tip in the lane's worktree, and only when it passed
 * moves the branch to that tip.
 * Why: a failed test must leave the lane where it was, so what failed never becomes the branch.
 * @param {{dir: string, base: string}} checkout the base checkout
 * @param {string} branch the lane
 * @param {{path: string} | null} worktree the lane's worktree (clean), or null when it has none
 * @param {{baseSha: string, command: string, timeoutSeconds: number}} run what to rebase onto, the --test command and the
 *   test's deadline
 * @returns {Promise<string>} the tested full sha, which the branch now points at
 * @throws {LandRefusal} with no worktree, on a rebase conflict, a test that did not pass, or a change during the test; the
 *   branch has not moved
 */
export async function testRebasedTip(checkout, branch, worktree, { baseSha, command, timeoutSeconds }) {
  const laneTip = shaOf(checkout.dir, `${HEADS}${branch}`);
  if (worktree === null) {
    const claim = `${CLAIM_COMMAND} --repo ${shellWord(checkout.dir)} --branch ${shellWord(branch)}`;
    throw new LandRefusal(`the test must run on the rebased tip, in the lane's worktree, and ${branch} has none; nothing changed. Claim a pool folder for it: ${claim}, then land again`);
  }
  const tip = rebaseDetached(checkout, branch, worktree, baseSha);
  try {
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
