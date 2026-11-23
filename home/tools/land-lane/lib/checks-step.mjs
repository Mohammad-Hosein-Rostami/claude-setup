// Purpose: the done-check step of `land-lane` (design "Land check" and the risk review): after the rebase, run or reuse `done-check run --where land`
// on the lane at the rebased tip, refuse new failures (exit 4), refuse logic the UI check plan found that no test ran (exit 4: done-check
// `tests` none related or not run), and ask for the one review of a risky lane (exit 10).
// Exports: assertReviewedIsAncestor(options), checkRebasedTip(options, rebased, { testsNeeded }) -> { lines, evidence }.
// Invariants: the check runs on a folder whose HEAD is exactly the rebased tip and whose tree is clean (the lane's own worktree, the worktree git
//   lists for the branch, or a temporary detached one that is always removed), so what is checked is what lands. A done-check that cannot run,
//   times out or answers something unreadable is exit 14, never a pass (P3). `--accept-open` covers only the `tests-weakened` kind: a new type,
//   lint or test failure stays exit 4. The review answer (`--reviewed`, `--skip-review`) is only asked for when done-check names a risk class.
//   `--reviewed` must be the tip or an ancestor of it; it is checked before anything runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_DEADLINE_MS, LAND_DEADLINE_MS } from '../../done-check/lib/contract.mjs';
import { UsageError } from './args.mjs';
import { stop } from './stop.mjs';
import { firstLine, git, parseJson, tool } from './tools.mjs';

const CHECK_SLACK_MS = 60_000;
const CHECK_TIMEOUT_MS = LAND_DEADLINE_MS + BASE_DEADLINE_MS + CHECK_SLACK_MS; // done-check's own deadlines, plus time to start and write
const GIT_FAILED_USAGE = [1, 128]; // `merge-base --is-ancestor`: 1 = not an ancestor, 128 = not a commit
const PASSING = ['ok', 'reused', 'skipped'];
const WEAKENED = 'tests-weakened';
const PIPE = /\|/g; // a status.mjs table cell cannot hold one

/** Exit 2 when `--reviewed` is not the tip or an ancestor of it (it comes from the lead's record, so a wrong sha is a mistake, not a review). */
export function assertReviewedIsAncestor(options) {
  if (options.reviewed === null) return;
  const run = git(options.repo, ['merge-base', '--is-ancestor', options.reviewed, options.tip]);
  if (run.ok) return;
  if (GIT_FAILED_USAGE.includes(run.status)) throw new UsageError(`--reviewed ${options.reviewed} is not the tip ${options.tip} or an ancestor of it`);
  stop(14, 'tool-failed', `git could not check --reviewed ${options.reviewed}: ${firstLine(run)}`);
}

/** The worktree git lists as holding `branch`, or null. */
function worktreeOfBranch(options) {
  const listed = git(options.repo, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return stop(14, 'tool-failed', `git could not list the worktrees of ${options.repo}: ${firstLine(listed)}`);
  let folder = null;
  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) folder = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${options.branch}`) return folder;
  }
  return null;
}

/** Calls `use(folder)` with the folder that holds the lane: its own worktree, else a temporary detached one at `rebased` (removed afterwards). */
function withLaneFolder(options, rebased, use) {
  const own = options.worktree ?? worktreeOfBranch(options);
  if (own !== null) return use(own);
  const parent = mkdtempSync(join(tmpdir(), 'land-lane-check-'));
  const folder = join(parent, 'lane');
  try {
    const added = git(options.repo, ['worktree', 'add', '--quiet', '--detach', '--', folder, rebased]);
    if (!added.ok) stop(14, 'tool-failed', `git could not check out ${rebased} to run the checks: ${firstLine(added)}`);
    return use(folder);
  } finally {
    git(options.repo, ['worktree', 'remove', '--force', '--', folder]);
    rmSync(parent, { recursive: true, force: true });
    git(options.repo, ['worktree', 'prune']);
  }
}

/** Refuses (exit 14) a folder that is not exactly the rebased tip: another commit, or files changed or added that the landing would not carry. */
function assertFolderIsTip(folder, rebased) {
  const head = git(folder, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok || head.out !== rebased) stop(14, 'tool-failed', `${folder} is at ${head.out || 'no commit'}, not at the rebased tip ${rebased}: the checks would not be of what lands`);
  const dirty = git(folder, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!dirty.ok) stop(14, 'tool-failed', `git could not read the state of ${folder}: ${firstLine(dirty)}`);
  if (dirty.out !== '') stop(14, 'tool-failed', `${folder} has uncommitted or untracked files (${firstLine(dirty)}): commit or remove them, the checks would not be of what lands`);
}

/** The done-check verdict of the lane's range at `base`; exit 14 when it cannot be read as one. */
function runDoneCheck(folder, base) {
  const run = tool('done-check', 'done-check.mjs', ['run', '--worktree', folder, '--base', base, '--where', 'land', '--json'], { timeoutMs: CHECK_TIMEOUT_MS });
  const verdict = parseJson(run.out);
  const readable = verdict !== null && typeof verdict.line === 'string' && Array.isArray(verdict.risk) && typeof verdict.row?.checks === 'object'
    && (verdict.verdict === 'block' ? run.status === 1 : PASSING.includes(verdict.verdict) && run.status === 0);
  if (!readable) stop(14, 'tool-failed', `the done-check could not run, nothing was landed: ${typeof verdict?.error === 'string' ? verdict.error : firstLine(run)}`);
  return verdict;
}

/** The open failure left after `--accept-open`, or exit 4 for a red check the flag does not cover. */
function judgeFailures(options, verdict, base) {
  const failing = Object.entries(verdict.row.checks).filter(([, check]) => check?.result === 'fail').map(([kind]) => kind);
  const coveredByAccept = options.acceptOpen !== null && failing.length > 0 && failing.every((kind) => kind === WEAKENED);
  if (!coveredByAccept) {
    const advice = failing.includes(WEAKENED) ? 'fix it, or land a weakened-test item on purpose with --accept-open "<reason>" (new type, lint or test failures cannot be accepted)'
      : 'fix the failures and land again';
    stop(4, 'checks-red', verdict.line, ...(typeof verdict.reason === 'string' ? verdict.reason.split('\n') : []),
      `nothing was landed; the lane is rebased onto ${base}: ${advice}`);
  }
  return `accepted open (${WEAKENED}): ${options.acceptOpen}`;
}

/** The review answer for a risky lane: the line and the evidence part, or exit 10. */
function judgeReview(options, verdict) {
  const classes = verdict.risk.join(', ');
  if (options.reviewed !== null) return `review: reviewed at ${options.reviewed} (${classes})`;
  if (options.skipReview !== null) return `review: skipped (${classes}): ${options.skipReview}`;
  return stop(10, 'review-needed', verdict.line, `review: suggested (${classes})`,
    'nothing was landed: run the one review of the lane and give its tip with --reviewed <sha> (the --tip or an ancestor of it), or give --skip-review "<reason>"');
}

/** Exit 4 when the check plan has logic (`tests`) and the done-check's tests did not run and pass: none related, not run, or missing. */
function requireTests(verdict, base) {
  const result = verdict.row.checks.tests?.result;
  if (result === 'ok') return;
  stop(4, 'checks-red', verdict.line, `the change has logic: a test must run it (done-check tests: ${result ?? 'no result'})`,
    `nothing was landed; the lane is rebased onto ${base}: add a test that runs the changed logic (or relate one to it) and land again`);
}

/**
 * Runs or reuses the done-check on the rebased tip and applies its verdict.
 * @param {object} options the parsed arguments
 * @param {string} rebased the lane's tip after the rebase check
 * @param {{ testsNeeded?: boolean }} [plan] `testsNeeded`: the UI check plan found logic, so done-check `tests` must be ok
 * @returns {{ lines: string[], evidence: string[] }} what to print and what to add to the close row's evidence
 * @throws {import('./stop.mjs').Stop} exit 4 (new failures, an open weakened item, or logic no test ran), 10 (review needed), 14 (the
 *   check could not run)
 */
export function checkRebasedTip(options, rebased, { testsNeeded = false } = {}) {
  const base = git(options.repo, ['rev-parse', '--verify', `refs/heads/${options.base}`]);
  if (!base.ok) stop(14, 'tool-failed', `the base ${options.base} could not be read: ${firstLine(base)}`);
  const verdict = withLaneFolder(options, rebased, (folder) => {
    assertFolderIsTip(folder, rebased);
    return runDoneCheck(folder, base.out);
  });
  const lines = [verdict.line];
  if (verdict.verdict === 'block') lines.push(judgeFailures(options, verdict, options.base));
  if (testsNeeded) requireTests(verdict, options.base);
  if (verdict.risk.length > 0) lines.push(judgeReview(options, verdict));
  const evidence = lines.slice(1).map((line) => line.replace(PIPE, '/'));
  return { lines, evidence };
}
