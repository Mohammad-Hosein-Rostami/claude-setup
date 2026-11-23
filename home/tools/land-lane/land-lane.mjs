#!/usr/bin/env node
// CLI of `land-lane`: put one lane on the base branch with one command: disk check, the tip check, the rebase check, the tip-object and union-row checks, the done-check of the
// rebased tip (run or reused, new failures refused, the one review of a risky lane asked for), `git-tidy land` (rebase, UI proof, ff-only,
// prune) and the STATUS.md close row. It replaces the land workflow. There is no test run or audit step of its own: the checks are done-check's.
// Usage: land-lane.mjs --repo <abs base folder> --branch <name> --tip <40-hex> --base <branch> --status-file <abs> --close-row <row id>
//        [--worktree <abs>] [--brief <file>] [--reviewed <40-hex> | --skip-review <reason>] [--accept-open <reason>]
//        [--owner-waive-ui <reason>] [--json]
//   `--reviewed` is the tip the one review read (the --tip or an ancestor of it, else exit 2); `--skip-review` is a reason of 1 to 200 characters;
//   `--accept-open` lands a lane whose only open failure is a weakened-test item, with a reason (1 to 200 characters). The answers go into the row.
//   `--owner-waive-ui <reason>` (same reason rules; --close-row a road row) skips only the UI proof of `git-tidy land`, and only when STATUS.md
//   holds the owner's line `ui-proof waiver for road <road>` (ui-proof/lib/owner-waiver.mjs); else exit 2 before anything runs. The output
//   prints `ui-proof: waived by owner decision (<reason>)` and the row evidence ends with ` (ui-proof waived: owner decision)`.
//   The removed flags `--audit-base` and `--checks` are refused with exit 2 and a plain message.
// Output: the first line is `land: <state>`; a landing prints `landed <to> on <base> from <from>` and the `checks:` line of done-check (and a
//   `review:` line for a risky lane). With --json one object `{ state, exit, to, from, lines }`.
// Exit: 0 landed clean, 1 landed with `git-tidy check` findings left, 2 usage, 3 conflict, 4 done-check found new failures or an open weakened
//   item, 5 the base kept moving, 6 ui-proof, 7 new-file-size, 8 upstream-moved, 9 tip-moved, 10 a risky lane without a review answer, 11 disk
//   below the floor, 12 a `merge=union` file holds a table row key twice after the rebase, 13 landed but the row was not closed (also a row
//   already done without this landing's `landed <to>` line: the exit names the `<row>.landed` correction row to record), 14 a tool failed
//   or the done-check could not run (nothing landed).
//   3-12 and 14 land nothing; after 4 and 10 the lane stays, rebased onto the base.
// Restart: a killed run is found again: a branch that is gone, with every patch of --tip already on the base, or a branch at the rebased tip
//   that `git-tidy range --landed` finds on the base, is a landing already made: the row is written (`already landed`).
// Exports: landLoop, Stop (for tests).
// Invariants: every step is a subprocess with no shell and a timeout (lib/tools.mjs); a tool that cannot run is exit 14, never a pass (P3).
//   The branch must be at --tip before anything runs, and git-tidy checks it again at every rebase and land (`--tip`).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseWorkItems } from '../estimate/lib/items.mjs';
import { readStatusFile } from '../status/status-file.mjs';
import { UI_WAIVER_EVIDENCE, ownerWaiverProblem, roadOfRow } from '../ui-proof/lib/owner-waiver.mjs';
import { UsageError, parseArgs } from './lib/args.mjs';
import { assertReviewedIsAncestor, checkRebasedTip } from './lib/checks-step.mjs';
import { Stop, stop } from './lib/stop.mjs';
import { git, parseJson, tool } from './lib/tools.mjs';
import { checkTipRows } from './lib/union-rows.mjs';

const DISK_TIMEOUT_MS = 120_000;
const TIDY_TIMEOUT_MS = 10 * 60 * 1000; // a landing fetches the upstream, runs prune and `check`
const ROW_TIMEOUT_MS = 30_000;
const ALREADY_DONE = /is already done/;
const REFUSED_BY_TIDY = {
  3: [3, 'conflict', 'the rebase hit conflicts and was aborted, the lane is unchanged'],
  6: [6, 'ui-proof', 'the UI files changed and the rebased tip has no visual-qa PASS'],
  7: [7, 'new-file-size', 'the lane adds a file over the size limit that its brief does not name'],
  8: [8, 'upstream-moved', 'the base\'s upstream holds commits the base lacks: `git pull --rebase` first'],
  9: [9, 'tip-moved', 'the branch is not at the given tip'],
};

export { Stop };

const tidy = (args) => tool('git-tidy', 'git-tidy.mjs', args, { timeoutMs: TIDY_TIMEOUT_MS });
/** True when the lead asked to land under the owner's ui-proof waiver (--owner-waive-ui; checked against STATUS.md in land()). */
const waivesUi = (options) => typeof options.ownerWaiveUi === 'string';
const reason = (run) => (run.err || run.out).split('\n').find((line) => line.trim() !== '') ?? `exit ${run.status}`;

function checkDisk() {
  const disk = tool('disk-free', 'disk-free.mjs', ['check'], { timeoutMs: DISK_TIMEOUT_MS });
  if (!disk.ok) stop(11, 'disk-low', `disk space check refused the landing, nothing was landed: ${disk.out || reason(disk)}`);
}

/** The sha of refs/heads/<name>, or null when the branch does not exist; any other git failure stops the run. */
function refTip(options) {
  const read = git(options.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`]);
  if (read.ok) return read.out;
  if (read.status === 1) return null;
  return stop(14, 'tool-failed', `git could not read branch ${options.branch} in ${options.repo}: ${reason(read)}`);
}

const baseTip = (options) => {
  const read = git(options.repo, ['rev-parse', '--verify', `refs/heads/${options.base}`]);
  return read.ok ? read.out : stop(14, 'tool-failed', `the base ${options.base} could not be read: ${reason(read)}`);
};

/** The reflog step of the base that holds the given tip (`git-tidy range`), or null. */
function landedRange(options, extra) {
  const found = tidy(['range', options.tip, options.repo, '--base', options.base, ...extra, '--json']);
  const range = found.ok ? parseJson(found.out) : null;
  return typeof range?.to === 'string' ? { from: range.from ?? null, to: range.to } : null;
}

/** True when `git cherry` shows no patch of the reviewed tip missing from the base. */
function patchesAreOnBase(options) {
  const cherry = git(options.repo, ['cherry', options.base, options.tip]);
  return cherry.ok && !cherry.out.split('\n').some((line) => line.startsWith('+'));
}

/** The evidence of the row `id` in the STATUS.md, or null when it cannot be read or has no such row. */
function rowEvidence(statusFile, id) {
  try {
    const read = readStatusFile(statusFile);
    if (read.text === undefined) return null;
    return parseWorkItems(read.text).items.find((item) => item.id.toLowerCase() === id.toLowerCase())?.evidence ?? null;
  } catch {
    return null; // unreadable: the caller reports the landing as not recorded (exit 13), never as recorded
  }
}

/**
 * Closes the row with the landed line. A row already done counts only when it holds this landing's `landed <to>` line (a re-run after a
 * kill); one done without it (a lane row closed when its build ended) is exit 13 naming the `.landed` correction row the road gate reads.
 */
function closeRow(options, evidence, to) {
  const done = tool('status', 'status.mjs', ['--file', options.statusFile, 'done', options.closeRow, evidence], { timeoutMs: ROW_TIMEOUT_MS });
  if (done.ok) return { problem: null, note: null };
  if (!ALREADY_DONE.test(`${done.out}\n${done.err}`)) return { problem: `row ${options.closeRow} not closed: ${reason(done)}; close it by hand with: ${evidence}`, note: null };
  if (rowEvidence(options.statusFile, options.closeRow)?.includes(`landed ${to}`)) return { problem: null, note: `row ${options.closeRow} was already closed` };
  const correction = `${options.closeRow}.landed`;
  return { problem: `row ${options.closeRow} was already done without this landing's line: record it in a correction row: status.mjs add ${correction} "close: landing of ${options.closeRow}" S, then status.mjs done ${correction} "${evidence}"`, note: null };
}

/**
 * Steps after a landing: the close row, then the exit.
 * @param {object} options the parsed arguments
 * @param {{ to: string, from: string|null, restart: boolean, findings: string[], notes: string[], evidence?: string[] }} landing what landed;
 *   `evidence` is what the done-check step adds to the row (an accepted open failure, the review answer)
 */
function finishLanding(options, landing) {
  const { to, from, restart, findings, notes, evidence = [] } = landing;
  const where = `landed ${to} on ${options.base}${from ? ` from ${from}` : ''}`;
  const answers = evidence.length > 0 ? ` (${evidence.join('; ')})` : '';
  const waived = waivesUi(options) ? UI_WAIVER_EVIDENCE : ''; // last, so the road gate finds it at the end of the evidence
  const row = closeRow(options, `${restart ? `${where} (found already on ${options.base} after a restart)` : `${where}${answers}`}${waived}`, to);
  const waiverLine = waivesUi(options) ? [`ui-proof: waived by owner decision (${options.ownerWaiveUi})`] : [];
  const lines = [where, ...waiverLine, ...(from ? [] : ['warning: no `from` sha (the base reflog does not show the step): the road gate will refuse this row']), ...notes, ...findings, ...[row.note, row.problem].filter(Boolean)];
  if (row.problem !== null) return { code: 13, state: 'row-not-closed', lines, to, from };
  if (findings.length > 0) return { code: 1, state: 'landed, check findings left', lines, to, from };
  return { code: 0, state: restart ? 'already landed' : 'landed', lines, to, from };
}

/** The landing a killed run already made: the branch is gone, or it is at a commit the base's reflog holds. */
function resumeLanding(options, current) {
  const notes = [];
  if (current === null) {
    if (!patchesAreOnBase(options)) stop(14, 'tool-failed', `branch ${options.branch} not found in ${options.repo}, and the base ${options.base} lacks patches of ${options.tip}: nothing was landed`);
    const range = landedRange(options, []);
    if (range === null) stop(14, 'tool-failed', `branch ${options.branch} is gone and its patches are on ${options.base}, but the base reflog does not show the landing step: record the row by hand`);
    return finishLanding(options, { ...range, restart: true, findings: [], notes });
  }
  const range = landedRange(options, ['--landed', current]);
  if (range === null) stop(9, 'tip-moved', `branch ${options.branch} is at ${current}, not at ${options.tip}: nothing was landed`);
  const prune = tidy(['prune', options.repo, '--base', options.base, '--apply']);
  notes.push(prune.ok ? 'landed before a restart; the lane\'s leftovers are pruned' : `landed before a restart; prune did not finish: ${reason(prune)}`);
  return finishLanding(options, { ...range, restart: true, findings: [], notes });
}

/** Step 4: rebase onto the base without landing; returns the rebased tip. */
function rebaseStep(options, expected) {
  const run = tidy(['land', options.branch, options.repo, '--base', options.base, '--rebase-only', '--tip', expected, '--json']);
  const result = parseJson(run.out);
  if (run.status === 3) stop(3, 'conflict', 'the rebase hit conflicts and was aborted, the lane is unchanged', ...(result?.files ?? []).map((file) => `conflict ${file}`));
  if (run.status === 9) stop(9, 'tip-moved', result?.why ?? `branch ${options.branch} is not at ${expected}`);
  if (!run.ok || typeof result?.tip !== 'string') stop(14, 'tool-failed', `rebase check failed (git-tidy exit ${run.status}): ${reason(run)}`);
  return result.tip;
}

/** Step 5: `git-tidy land` at the rebased tip. `{ moved: true, tip }` when the base moved, else what landed. */
function landStep(options, rebased) {
  const waiver = waivesUi(options) ? ['--owner-waive-ui', options.ownerWaiveUi, '--status-file', options.statusFile, '--road', roadOfRow(options.closeRow)] : [];
  const optional = [...(options.brief === null ? [] : ['--brief', options.brief]), ...waiver];
  const run = tidy(['land', options.branch, options.repo, '--base', options.base, '--tip', rebased, ...optional, '--json']);
  const result = parseJson(run.out);
  if (run.status === 5) return { moved: true, tip: result?.tip ?? rebased };
  const refused = REFUSED_BY_TIDY[run.status];
  if (refused !== undefined) stop(...refused.slice(0, 2), result?.why ?? refused[2], ...(result?.files ?? []).map((file) => `file ${file}`));
  if (run.status !== 0 && run.status !== 1) stop(14, 'tool-failed', `git-tidy land failed (exit ${run.status}): ${reason(run)}`);
  const findings = (result?.findings ?? []).map(({ kind, subject, detail }) => `${kind} ${subject} ${detail}`);
  const notes = result?.cleanupRefused ? [`cleanup skipped: ${result.cleanupRefused}`] : [];
  return { moved: false, to: result?.tip ?? baseTip(options), from: result?.from ?? null, findings, notes };
}

/**
 * Step 5 with the tip and union-row checks and the done-check before it: the checks of the rebased tip, then `git-tidy land --tip` of that same
 * tip, which lands only that sha (a base that moved since rewrites it: exit 5, and the loop rebases and checks again).
 */
function checkedLandStep(options, rebased) {
  checkTipRows(options, rebased);
  const checked = checkRebasedTip(options, rebased);
  const landed = landStep(options, rebased);
  return landed.moved ? landed : { ...landed, notes: [...checked.lines, ...landed.notes], evidence: checked.evidence };
}

const REAL_STEPS = { rebase: rebaseStep, land: checkedLandStep, baseTip };

/**
 * Steps 4-5 as a loop: rebase check, `git-tidy land`; a base that moved during the landing goes back to the rebase check, and the same
 * base reported moved twice is exit 5 (the exit was misreported, or something else keeps moving it).
 * @param {object} options the parsed arguments
 * @param {{ rebase: Function, land: Function, baseTip: Function }} steps the three steps (a test passes doubles)
 * @returns {{ to: string, from: string|null, findings: string[], notes: string[] }} what landed
 * @throws {Stop} any refusal
 */
export function landLoop(options, steps) {
  let expected = options.tip;
  let baseAtLastMove = null;
  for (;;) {
    const rebased = steps.rebase(options, expected);
    const landed = steps.land(options, rebased);
    if (!landed.moved) return landed;
    const base = steps.baseTip(options);
    if (base === baseAtLastMove) stop(5, 'base-moved', `git-tidy land said the base moved twice but ${options.base} is still at ${base}`);
    baseAtLastMove = base;
    expected = landed.tip;
  }
}

/** Steps 1-6; the result is `{ code, state, lines, to, from }`; a refusal is a thrown Stop. */
function land(options) {
  assertReviewedIsAncestor(options);
  // The owner's waiver is checked before anything runs; git-tidy land checks the same line again right before it lands.
  const waiverProblem = waivesUi(options) ? ownerWaiverProblem(options.statusFile, roadOfRow(options.closeRow)) : null;
  if (waiverProblem !== null) throw new UsageError(waiverProblem);
  checkDisk();
  const current = refTip(options);
  if (current !== options.tip) return resumeLanding(options, current);
  return finishLanding(options, { ...landLoop(options, REAL_STEPS), restart: false });
}

function print(json, { code, state, lines, to = null, from = null }) {
  console.log(json ? JSON.stringify({ state, exit: code, to, from, lines }) : [`land: ${state}`, ...lines].join('\n'));
  return code;
}

function main(argv) {
  const json = argv.includes('--json');
  try {
    return print(json, land(parseArgs(argv)));
  } catch (error) {
    if (error instanceof UsageError) return print(json, { code: 2, state: 'usage', lines: [error.message] });
    if (error instanceof Stop) return print(json, { code: error.code, state: error.state, lines: error.lines });
    return print(json, { code: 14, state: 'tool-failed', lines: [`unexpected failure: ${error.message}`] });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
