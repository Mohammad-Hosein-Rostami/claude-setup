// Purpose: `board tick`, the boss's read-only sync after every agent report and every land (boss-integrator design, section 3):
//   main's state, the side findings to tidy, one line per lane in flight, the overlaps and strays among their files, the plan's
//   queue, the features waiting for tess and a suggested next step (the lines: tick-lines.mjs). `--mark-tess` records that tess
//   was started on a feature.
// Exports: TICK_USAGE, runTick(args, loadBoard) -> exit code.
// Facts: main from git-tidy check (runCheck), split by kind: main's own findings block new work, the side ones (other refs and
//   folders, SIDE_KINDS) only go on the `tidy` line; the lanes are the lane pool's folders that hold a branch (poolSlots), each with
//   its commits and files against main (git) and its agent from the session's board (matched by branch); landed pieces from the
//   land ledger (a land of the piece's branch, tick-features.mjs pieceBranch; an unreadable ledger is one line, never exit 2); tess marks from tick-plan.mjs;
//   features and tess status judged in tick-features.mjs (a mark covers the lands its sha holds). Nothing comes from an agent's words.
// Invariants: reads only; `--mark-tess` writes the job's marks file (under its lock file) and nothing else. Every branch name, path and agent name is
//   printed through cells.mjs cleanText, so no control character reaches the terminal. `next:` only suggests: the boss decides.
//   Exit 0 shown, 1 findings (an overlap, a stray, a git-tidy check finding on main or on the side), 2 usage (a bad flag, no
//   repository, a bad plan or marks file) and any unexpected failure (1 must only ever mean findings).
import { runCheck } from '../../git-tidy/lib/check.mjs';
import { UsageError, gitText, runGit } from '../../git-tidy/lib/git.mjs';
import { poolSlots } from '../../git-tidy/lib/lane-pool.mjs';
import { slotKey } from '../../git-tidy/lib/lane-slots.mjs';
import { listWorktrees, openRepo } from '../../git-tidy/lib/repo.mjs';
import { readLandEntries } from '../../land/ledger.mjs';
import { jsonText } from './cells.mjs';
import { pieceBranch, planState } from './tick-features.mjs';
import { clean, short, tickLines } from './tick-lines.mjs';
import { readMarks, readPlan, writeMark } from './tick-plan.mjs';

export const TICK_USAGE = 'usage: board.mjs tick --repo <abs main checkout> [--plan <abs pieces.json>] [--session <id>] [--json]\n'
  + '       board.mjs tick --repo <abs> --plan <abs> --mark-tess <feature> --sha <40-hex>';
const EXIT = Object.freeze({ shown: 0, findings: 1, usage: 2 });
// `--session` is board.mjs's (the board it loads); taken here only so it is no unknown argument
const VALUE_FLAGS = Object.freeze({ '--repo': 'repo', '--plan': 'plan', '--mark-tess': 'markTess', '--sha': 'sha', '--session': 'session' });
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MISSING_FOLDER = 'missing'; // lane-slots.mjs: the folder is gone, so git cannot run in it
const STATUS_CODE_CHARS = 3; // `XY ` before each path in `git status --porcelain -z`
const RENAMED = /^(?:[RC]|.[RC])/; // a rename or copy (staged or in the folder): -z puts its old path in the next field
// git-tidy check kinds about other refs and folders, not main: a leftover there must not stop the round, so they go on the `tidy`
// line. Every other kind (dirty-base, merge-commit, stale-checkout, and any kind check.mjs adds later) counts as main: fail safe.
const SIDE_KINDS = new Set(['tangled-ref', 'merged-branch', 'merged-tag', 'merged-worktree', 'stale-worktree', 'superseded-copy', 'agent-leftover']);

const nulList = (text) => text.split('\0').filter((path) => path !== '');
const sharedFiles = (first, second) => first.filter((path) => second.includes(path));

function parseTickArgs(args) {
  const options = { repo: null, plan: null, markTess: null, sha: null, session: null, json: false };
  for (let at = 0; at < args.length; at++) {
    const name = VALUE_FLAGS[args[at]];
    if (args[at] === '--json') options.json = true;
    else if (name === undefined) throw new UsageError(`unknown argument ${JSON.stringify(args[at])} for tick. ${TICK_USAGE}`);
    else if (args[at + 1] === undefined || args[at + 1].startsWith('--')) throw new UsageError(`${args[at]} needs a value. ${TICK_USAGE}`);
    else options[name] = args[++at];
  }
  checkTickOptions(options);
  return options;
}

/** The checks across flags (S6): --repo always and absolute, --plan absolute, --sha only with --mark-tess, a mark with --plan and a full sha. */
function checkTickOptions(options) {
  if (!ABSOLUTE_PATH.test(options.repo ?? '')) throw new UsageError(`tick needs --repo <absolute path of the main checkout>. ${TICK_USAGE}`);
  if (options.plan !== null && !ABSOLUTE_PATH.test(options.plan)) throw new UsageError(`--plan must be an absolute path, got ${JSON.stringify(options.plan)}`);
  if (options.markTess === null && options.sha !== null) throw new UsageError(`--sha goes with --mark-tess. ${TICK_USAGE}`);
  const isMarkComplete = options.plan !== null && FULL_SHA.test(options.sha ?? '');
  if (options.markTess !== null && !isMarkComplete) throw new UsageError(`--mark-tess needs --plan <abs pieces.json> and --sha <full 40-character main sha>. ${TICK_USAGE}`);
}

/** The changed and untracked paths in a lane's folder (renames give both paths), or null when git cannot say. */
function changedPaths(folder) {
  const { status, stdout } = runGit(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  if (status !== 0) return null;
  const fields = nulList(stdout);
  const paths = [];
  for (let at = 0; at < fields.length; at++) {
    paths.push(fields[at].slice(STATUS_CODE_CHARS));
    if (RENAMED.test(fields[at])) paths.push(fields[++at]);
  }
  return paths;
}

/** The board agent on `branch`: a live one first, else the first done one in the board's order; null when none is there. */
function agentOn(agents, branch) {
  const own = agents.filter((agent) => agent.branch === branch);
  const agent = own.find((entry) => entry.state !== 'done') ?? own[0];
  return agent === undefined ? null : { id: agent.id, type: agent.type, state: agent.state, quietMin: agent.quietMin };
}

/** One lane in flight: a pool folder holding a branch, with its commits and files against main and its agent. */
function laneOf(repo, mainSha, slot, agents) {
  const ref = `refs/heads/${slot.branch}`;
  const forkPoint = gitText(repo.dir, ['merge-base', mainSha, ref]);
  // plumbing (diff-tree), not `diff`: plumbing never runs a textconv or external diff program the repository names
  const committed = runGit(repo.dir, ['diff-tree', '-r', '--name-only', '-z', forkPoint, ref]); // runGit: gitText's trim would cut a path's spaces
  if (committed.status !== 0) throw new Error(`git diff-tree failed for ${clean(slot.branch)}: ${committed.stderr}`);
  const changed = slot.state === MISSING_FOLDER ? null : changedPaths(slot.folder);
  const agent = agentOn(agents, slot.branch);
  const commits = Number(gitText(repo.dir, ['rev-list', '--count', `${mainSha}..${ref}`]));
  return {
    branch: slot.branch, slot: slot.slot, folder: slot.folder, folderState: slot.state, agent, commits, changed,
    files: [...new Set([...nulList(committed.stdout), ...(changed ?? [])])],
    mainMoved: forkPoint !== mainSha,
    isReady: (agent === null || agent.state === 'done') && commits > 0 && changed?.length === 0,
  };
}

/** `overlap` pairs: two lanes sharing a file, or a waiting piece (after-steps landed) whose declared files touch a lane (isPiece). */
function overlapsOf(lanes, candidates) {
  const pairs = lanes.flatMap((lane, at) => lanes.slice(at + 1).map((other) => ({ first: lane.branch, second: other.branch, files: sharedFiles(lane.files, other.files), isPiece: false })));
  const touches = candidates.flatMap((piece) => lanes.map((lane) => ({ first: piece.id, second: lane.branch, files: sharedFiles(piece.files, lane.files), isPiece: true })));
  return [...pairs, ...touches].filter((pair) => pair.files.length > 0);
}

/**
 * The queue: each waiting piece with the branch it names (null for `lane/<id>`), the pieces it is after, the lanes its files
 * touch, and whether it can start now.
 */
function queueOf(waiting, overlaps) {
  return waiting.map(({ id, branch, after }) => {
    const touched = overlaps.filter((pair) => pair.isPiece && pair.first === id).map((pair) => pair.second);
    return { id, branch, after, overlaps: touched, isStartable: after.length === 0 && touched.length === 0 };
  });
}

/** `stray` lanes: a lane of a plan piece that changed files the piece does not declare. */
function straysOf(lanes, plan) {
  return lanes.flatMap((lane) => {
    const piece = plan.pieces.find((entry) => pieceBranch(entry) === lane.branch);
    const files = piece === undefined ? [] : lane.files.filter((path) => !piece.files.includes(path));
    return files.length === 0 ? [] : [{ branch: lane.branch, files }];
  });
}

/** The land ledger, or no entries and why when it cannot be read: a broken ledger must not hide main and the lanes. */
function landLedger(repoDir) {
  try {
    return { ...readLandEntries(repoDir), unreadable: null };
  } catch (error) {
    return { entries: [], skipped: 0, unreadable: error.message.split('\n')[0] };
  }
}

/** The pool's folders, each with the time its lock was taken (`lockedAtMs`, null when unlocked or unknown) for the snapshot age. */
function foldersOf(repo) {
  const lockTimes = new Map(listWorktrees(repo).map((tree) => [slotKey(tree.path), tree.lockedAtMs ?? null]));
  return poolSlots(repo).map((slot) => ({ ...slot, lockedAtMs: lockTimes.get(slotKey(slot.folder)) ?? null }));
}

/** Every fact of one tick, as the `--json` output. */
function tickFacts(repo, plan, board) {
  const findings = runCheck(repo).findings.map(({ kind, subject }) => ({ kind, subject }));
  const main = { branch: repo.base, sha: gitText(repo.dir, ['rev-parse', repo.baseRef]), findings: findings.filter(({ kind }) => !SIDE_KINDS.has(kind)) };
  const tidy = findings.filter(({ kind }) => SIDE_KINDS.has(kind));
  const slots = foldersOf(repo);
  const agents = board?.agents ?? [];
  const lanes = slots.filter((slot) => slot.branch !== null).map((slot) => laneOf(repo, main.sha, slot, agents));
  const ledger = landLedger(repo.dir);
  const work = plan === null ? null : planState(repo, plan, lanes, ledger.entries, readMarks(plan.job));
  const overlaps = overlapsOf(lanes, work?.waiting.filter((piece) => piece.after.length === 0) ?? []);
  const tessRunning = agents.filter((agent) => agent.type === 'tess' && agent.state !== 'done').length;
  return {
    repo: repo.dir, main, tidy, folders: slots, lanes, overlaps, strays: plan === null ? [] : straysOf(lanes, plan), queue: queueOf(work?.waiting ?? [], overlaps),
    plan: work === null ? null : { job: plan.job, features: work.features, tess: work.tess, lastTessSha: work.lastTessSha, landedSince: work.landedSince },
    ledgerSkipped: ledger.skipped, ledgerUnreadable: ledger.unreadable, tessRunning,
  };
}

/**
 * Runs `board tick <args>` and prints its result.
 * @param {string[]} args the arguments after `tick`
 * @param {() => object | null} loadBoard the session's board (refreshed), null with no session; called only for a tick, after the
 *   arguments are checked
 * @returns {number} the exit code (see the header)
 */
export function runTick(args, loadBoard) {
  try {
    const options = parseTickArgs(args);
    const repo = openRepo(options.repo, null);
    const plan = options.plan === null ? null : readPlan(options.plan, repo);
    if (options.markTess !== null) {
      const file = writeMark({ repo, plan, feature: options.markTess, sha: options.sha });
      console.log(`marked ${options.markTess} for tess at ${short(options.sha)} (${clean(file)})`);
      return EXIT.shown;
    }
    const tick = tickFacts(repo, plan, loadBoard());
    console.log(options.json ? jsonText(tick) : tickLines(tick).join('\n'));
    return tick.main.findings.length + tick.tidy.length + tick.overlaps.length + tick.strays.length > 0 ? EXIT.findings : EXIT.shown;
  } catch (error) {
    // a git message may quote a branch name: clean each line, keep the usage's line breaks
    console.error(`board tick: ${error instanceof UsageError ? '' : 'unexpected failure: '}${error.message.split('\n').map(clean).join('\n')}`);
    return EXIT.usage;
  }
}
