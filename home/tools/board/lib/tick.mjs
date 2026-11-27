// Purpose: `board tick`, the boss's sync after every agent report and every land (boss-integrator design, section 3): the base's
//   state, the side findings to tidy, one line per lane in flight, the test branches not landed (tick-tests.mjs), the overlaps and
//   strays among their files, each open job's queue and features waiting for tess, and a suggested next step (the lines:
//   tick-lines.mjs). The jobs are every plan the repository's ticks remember (tick-jobs.mjs): each `--plan` is added to that list,
//   `--forget-plan` removes one, and a job whose pieces all landed and whose features are all checked leaves it. `--mark-tess`
//   records that tess was started on a feature.
// Exports: TICK_USAGE, runTick(args, loadBoard) -> exit code.
// Facts: the base is git-tidy's (openRepo: the branch checked out in the main checkout, by its own name; the `main` key holds it);
//   its findings from git-tidy check (runCheck), split by kind: the base's own findings block new work, the side ones (other refs and
//   folders, SIDE_KINDS) only go on the `tidy` line; the lanes are the lane pool's folders that hold a branch (poolSlots), each with
//   its commits and files against the base (git), the base it was claimed on (base-record.mjs readLaneBase; a lane of another base
//   is never ready: land refuses it here) and its agent from the session's board (matched by branch); landed pieces from the
//   land ledger (a land of the piece's branch made after the plan's base, tick-jobs.mjs landsOfPlan; an unreadable ledger is one
//   line, never exit 2); tess marks from tick-plan.mjs; features and tess status judged in tick-features.mjs (a mark covers the
//   lands its sha holds). Nothing comes from an agent's words.
// Invariants: writes only the remembered plans list (an add, a forget, a done job; under its lock) and, with `--mark-tess`, the
//   job's marks file (under its lock) and nothing else. Every branch name, path and agent name is printed through cells.mjs
//   cleanText, so no control character reaches the terminal. `next:` only suggests: the boss decides. A remembered plan that
//   cannot be read, or a list that cannot be read, is a line and the rest still prints; a `--plan` given now is checked first.
//   Exit 0 shown, 1 findings (an overlap, a stray, a clash, a git-tidy check finding on the base or on the side, a plan or the
//   list that cannot be read, a done job that could not be forgotten), 2 usage (a bad flag, no repository, a bad `--plan` or marks file) and any unexpected failure (1
//   must only ever mean findings).
import { readLaneBase } from '../../git-tidy/lib/base-record.mjs';
import { runCheck } from '../../git-tidy/lib/check.mjs';
import { UsageError, gitText, runGit } from '../../git-tidy/lib/git.mjs';
import { poolSlots } from '../../git-tidy/lib/lane-pool.mjs';
import { slotKey } from '../../git-tidy/lib/lane-slots.mjs';
import { listWorktrees, openRepo } from '../../git-tidy/lib/repo.mjs';
import { readLandEntries } from '../../land/ledger.mjs';
import { jsonText } from './cells.mjs';
import { pieceBranch, planState } from './tick-features.mjs';
import { clashesOf, forgetPlan, landsOfPlan, readJobs, rememberPlans } from './tick-jobs.mjs';
import { clean, short, tickLines } from './tick-lines.mjs';
import { readMarks, readPlan, writeMark } from './tick-plan.mjs';
import { testBranches } from './tick-tests.mjs';

export const TICK_USAGE = 'usage: board.mjs tick --repo <abs main checkout> [--plan <abs pieces.json>]... [--session <id>] [--json]\n'
  + '       board.mjs tick --repo <abs> --plan <abs> --mark-tess <feature> --sha <40-hex>\n'
  + '       board.mjs tick --repo <abs> --forget-plan <abs pieces.json>';
const EXIT = Object.freeze({ shown: 0, findings: 1, usage: 2 });
// `--session` is board.mjs's (the board it loads); taken here only so it is no unknown argument. `--plan` may repeat (a list).
const VALUE_FLAGS = Object.freeze({
  '--repo': 'repo', '--plan': 'plans', '--forget-plan': 'forgetPlan', '--mark-tess': 'markTess', '--sha': 'sha', '--session': 'session',
});
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
  const options = { repo: null, plans: [], forgetPlan: null, markTess: null, sha: null, session: null, json: false };
  for (let at = 0; at < args.length; at++) {
    const name = VALUE_FLAGS[args[at]];
    if (args[at] === '--json') options.json = true;
    else if (name === undefined) throw new UsageError(`unknown argument ${JSON.stringify(args[at])} for tick. ${TICK_USAGE}`);
    else if (args[at + 1] === undefined || args[at + 1].startsWith('--')) throw new UsageError(`${args[at]} needs a value. ${TICK_USAGE}`);
    else if (Array.isArray(options[name])) options[name].push(args[++at]);
    else options[name] = args[++at];
  }
  checkTickOptions(options);
  return options;
}

/**
 * The checks across flags (S6): --repo always and absolute, each plan path absolute, --sha only with --mark-tess, a mark with
 * exactly one --plan and a full sha, --forget-plan with --repo alone.
 */
function checkTickOptions(options) {
  if (!ABSOLUTE_PATH.test(options.repo ?? '')) throw new UsageError(`tick needs --repo <absolute path of the main checkout>. ${TICK_USAGE}`);
  const relative = [...options.plans, options.forgetPlan ?? '/'].find((path) => !ABSOLUTE_PATH.test(path));
  if (relative !== undefined) throw new UsageError(`a plan path must be absolute, got ${JSON.stringify(relative)}`);
  if (options.markTess === null && options.sha !== null) throw new UsageError(`--sha goes with --mark-tess. ${TICK_USAGE}`);
  const isMarkComplete = options.plans.length === 1 && FULL_SHA.test(options.sha ?? '');
  if (options.markTess !== null && !isMarkComplete) throw new UsageError(`--mark-tess needs one --plan <abs pieces.json> and --sha <full 40-character main sha>. ${TICK_USAGE}`);
  const isForgetAlone = options.plans.length === 0 && options.markTess === null && !options.json;
  if (options.forgetPlan !== null && !isForgetAlone) throw new UsageError(`--forget-plan goes with --repo alone. ${TICK_USAGE}`);
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

/**
 * One lane in flight: a pool folder holding a branch, with its commits and files against the base, the base it was claimed on
 * (`claimedOn`, null for a lane with no record) and its agent.
 */
function laneOf(repo, mainSha, slot, agents) {
  const ref = `refs/heads/${slot.branch}`;
  const forkPoint = gitText(repo.dir, ['merge-base', mainSha, ref]);
  // plumbing (diff-tree), not `diff`: plumbing never runs a textconv or external diff program the repository names
  const committed = runGit(repo.dir, ['diff-tree', '-r', '--name-only', '-z', forkPoint, ref]); // runGit: gitText's trim would cut a path's spaces
  if (committed.status !== 0) throw new Error(`git diff-tree failed for ${clean(slot.branch)}: ${committed.stderr}`);
  const changed = slot.state === MISSING_FOLDER ? null : changedPaths(slot.folder);
  const agent = agentOn(agents, slot.branch);
  const commits = Number(gitText(repo.dir, ['rev-list', '--count', `${mainSha}..${ref}`]));
  const claimedOn = readLaneBase(repo.dir, slot.branch);
  const isOnBase = claimedOn === null || claimedOn === repo.base; // land refuses a lane claimed on another base
  return {
    branch: slot.branch, slot: slot.slot, folder: slot.folder, folderState: slot.state, agent, commits, changed, claimedOn,
    files: [...new Set([...nulList(committed.stdout), ...(changed ?? [])])],
    mainMoved: forkPoint !== mainSha,
    isReady: (agent === null || agent.state === 'done') && commits > 0 && changed?.length === 0 && isOnBase,
  };
}

/**
 * `overlap` pairs: two lanes sharing a file, or a waiting piece (after-steps landed) whose declared files touch a lane (isPiece,
 * with the piece's `job`: two plans may reuse a piece id).
 */
function overlapsOf(lanes, candidates) {
  const pairs = lanes.flatMap((lane, at) => lanes.slice(at + 1).map((other) => ({ first: lane.branch, second: other.branch, files: sharedFiles(lane.files, other.files), isPiece: false })));
  const touches = candidates.flatMap((piece) => lanes.map((lane) => ({ first: piece.id, job: piece.job, second: lane.branch, files: sharedFiles(piece.files, lane.files), isPiece: true })));
  return [...pairs, ...touches].filter((pair) => pair.files.length > 0);
}

/**
 * One job's queue: each waiting piece with the branch it names (null for `lane/<id>`), the pieces it is after, the lanes its files
 * touch, whether another plan names its branch too (isClash), and whether it can start now.
 */
function queueOf(job, waiting, overlaps, clashed) {
  return waiting.map((piece) => {
    const touched = overlaps.filter((pair) => pair.isPiece && pair.job === job && pair.first === piece.id).map((pair) => pair.second);
    const isClash = clashed.has(pieceBranch(piece));
    return { id: piece.id, branch: piece.branch, after: piece.after, overlaps: touched, isClash, isStartable: piece.after.length === 0 && touched.length === 0 && !isClash };
  });
}

/** `stray` lanes: a lane of a plan piece (of any job) that changed files the piece does not declare. */
function straysOf(lanes, pieces) {
  return lanes.flatMap((lane) => {
    const piece = pieces.find((entry) => pieceBranch(entry) === lane.branch);
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

/** The remembered list, after adding the plans given now: on a list that cannot be changed, those plans alone and why. */
function rememberedPlans(repo, givenPaths) {
  if (givenPaths.length === 0) return readJobs(repo.dir);
  try {
    return { plans: rememberPlans(repo.dir, givenPaths), problem: null };
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return { plans: givenPaths, problem: error.message };
  }
}

/**
 * The plans this tick reads, in the list's order: the ones given now (already read) and every other remembered one that reads;
 * each remembered one that does not is a problem `{ path, problem }`, and so is a list that cannot be read (`listProblem`).
 */
function openPlans(repo, given) {
  const remembered = rememberedPlans(repo, given.map(({ path }) => path));
  const plans = [];
  const problems = [];
  for (const path of remembered.plans) {
    const known = given.find((entry) => entry.path === path);
    try {
      plans.push(known ?? { path, plan: readPlan(path, repo) });
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      problems.push({ path, problem: error.message });
    }
  }
  return { plans, problems, listProblem: remembered.problem };
}

/** One job's facts: its queue, features and tess status, and whether it is done (every piece landed, every feature checked). */
function jobOf({ path, plan, work }, overlaps, clashed) {
  return {
    job: plan.job, path, queue: queueOf(plan.job, work.waiting, overlaps, clashed), features: work.features, tess: work.tess,
    lastTessSha: work.lastTessSha, landedSince: work.landedSince,
    isDone: work.features.every((feature) => feature.landed === feature.pieces && feature.isChecked),
  };
}

/** Forgets each done job's plan; `{ job, problem }` for each one this tick forgot (problem null) or could not (why). */
function forgetDoneJobs(repo, jobs) {
  return jobs.filter((job) => job.isDone).flatMap((job) => {
    try {
      return forgetPlan(repo.dir, job.path) ? [{ job: job.job, problem: null }] : []; // another tick forgot it first
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      return [{ job: job.job, problem: error.message }];
    }
  });
}

/** Every fact of one tick, as the `--json` output (`forgotten` is added by runTick). */
function tickFacts(repo, { plans, problems, listProblem }, board) {
  const findings = runCheck(repo).findings.map(({ kind, subject }) => ({ kind, subject }));
  const main = { branch: repo.base, sha: gitText(repo.dir, ['rev-parse', repo.baseRef]), findings: findings.filter(({ kind }) => !SIDE_KINDS.has(kind)) };
  const tidy = findings.filter(({ kind }) => SIDE_KINDS.has(kind));
  const slots = foldersOf(repo);
  const agents = board?.agents ?? [];
  const lanes = slots.filter((slot) => slot.branch !== null).map((slot) => laneOf(repo, main.sha, slot, agents));
  const pieces = plans.flatMap(({ plan }) => plan.pieces);
  const tests = testBranches(repo, main.sha, { lanes, tidy, plan: plans.length === 0 ? null : { pieces } }).map((test) => ({ ...test, agent: agentOn(agents, test.branch) }));
  const ledger = landLedger(repo.dir);
  const works = plans.map(({ path, plan }) => ({ path, plan, work: planState(repo, plan, lanes, landsOfPlan(repo, plan, ledger.entries), readMarks(repo, plan.job)) }));
  const candidates = works.flatMap(({ plan, work }) => work.waiting.filter((piece) => piece.after.length === 0).map((piece) => ({ ...piece, job: plan.job })));
  const overlaps = overlapsOf(lanes, candidates);
  const clashes = clashesOf(plans.map(({ plan }) => plan));
  const clashed = new Set(clashes.map(({ branch }) => branch));
  const tessRunning = agents.filter((agent) => agent.type === 'tess' && agent.state !== 'done').length;
  return {
    repo: repo.dir, main, tidy, folders: slots, lanes, tests, overlaps, strays: straysOf(lanes, pieces), clashes,
    jobs: works.map((entry) => jobOf(entry, overlaps, clashed)), planProblems: problems, listProblem,
    ledgerSkipped: ledger.skipped, ledgerUnreadable: ledger.unreadable, tessRunning,
  };
}

/** How many findings make exit 1: the base's and the side ones, overlaps, strays, clashes, plans and lists that cannot be read. */
function findingsOf(tick) {
  const notForgotten = tick.forgotten.filter(({ problem }) => problem !== null);
  return tick.main.findings.length + tick.tidy.length + tick.overlaps.length + tick.strays.length + tick.clashes.length
    + tick.planProblems.length + (tick.listProblem === null ? 0 : 1) + notForgotten.length;
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
    if (options.forgetPlan !== null) {
      const isForgotten = forgetPlan(repo.dir, options.forgetPlan);
      console.log(isForgotten ? `forgot ${clean(options.forgetPlan)}` : `${clean(options.forgetPlan)} was not remembered`);
      return EXIT.shown;
    }
    // a plan given now is read before anything is written: a bad one is exit 2, never remembered
    const given = [...new Set(options.plans)].map((path) => ({ path, plan: readPlan(path, repo) }));
    if (options.markTess !== null) {
      const file = writeMark({ repo, plan: given[0].plan, feature: options.markTess, sha: options.sha });
      console.log(`marked ${options.markTess} for tess at ${short(options.sha)} (${clean(file)})`);
      return EXIT.shown;
    }
    const facts = tickFacts(repo, openPlans(repo, given), loadBoard());
    const tick = { ...facts, forgotten: forgetDoneJobs(repo, facts.jobs) };
    console.log(options.json ? jsonText(tick) : tickLines(tick).join('\n'));
    return findingsOf(tick) > 0 ? EXIT.findings : EXIT.shown;
  } catch (error) {
    // a git message may quote a branch name: clean each line, keep the usage's line breaks
    console.error(`board tick: ${error instanceof UsageError ? '' : 'unexpected failure: '}${error.message.split('\n').map(clean).join('\n')}`);
    return EXIT.usage;
  }
}
