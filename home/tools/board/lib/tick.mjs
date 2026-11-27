// Purpose: `board tick`, the boss's sync after every agent report and every land (boss-integrator design, section 3): the base's
//   state, the side findings to tidy, one line per lane in flight, the test branches not landed (tick-tests.mjs), the overlaps and
//   strays among their files, each open job's queue (tick-queue.mjs), features waiting for tess and holds (a risky landed
//   feature's files wait for tess, across every job: tick-features.mjs), and the steps to run next (tick-do.mjs; the lines:
//   tick-lines.mjs).
//   The jobs are every plan the repository's ticks remember (tick-jobs.mjs): each `--plan` is added to that list,
//   `--forget-plan` removes one, and a job whose pieces all landed and whose features are all checked leaves it. `--mark-tess`
//   records that tess was started on a feature.
// Exports: TICK_USAGE, runTick(args, loadBoard) -> exit code.
// Facts: the base is git-tidy's (openRepo: the branch checked out in the main checkout, by its own name; the `main` key holds it);
//   its findings from git-tidy check (runCheck), split by kind: the base's own findings block new work, the side ones (other refs and
//   folders, SIDE_KINDS) only go on the `tidy` line; the lanes are the lane pool's folders that hold a branch (poolSlots), each with
//   its commits and files against the base (git) plus the declared files of the plan piece on its branch, the base it was
//   claimed on (base-record.mjs readLaneBase; a lane of another base is never ready: land refuses it here, nor is a held one) and
//   its agent from the session's board (matched by branch); landed pieces from the
//   land ledger (a land of the piece's branch made after the plan's base, tick-jobs.mjs landsOfPlan; an unreadable ledger is one
//   line, never exit 2); tess marks from tick-plan.mjs; features and tess status judged in tick-features.mjs (a mark covers the
//   lands its sha holds) and holds; the live tess agents and the pool folders their names name (`lane-<n>`, as `board start`
//   names them), and the board's agents (how many run, and for the agents line), from the board; each job's ledger lands
//   (for its pace on the job line, tick-pace.mjs); in the setup's own repository (trusted-repos.mjs) with its sync
//   script, the sync record and whether a sync runs (sync-record.mjs). Nothing comes from an agent's words.
// Invariants: writes only the remembered plans list (an add, a forget, a done job; under its lock), with `--mark-tess` the job's
//   marks file (under its lock), and openRepo's one-time mark of the checked-out base (git config `branch.<base>.cs-base`,
//   repo.mjs), and nothing else. Every branch name, path and agent name is printed through cells.mjs cleanText, so no control
//   character reaches the terminal. `next:` only suggests: the boss decides. A remembered plan that
//   cannot be read, or a list that cannot be read, is a line and the rest still prints; a `--plan` given now is checked first.
//   Exit 0 shown, 1 findings (an overlap, a stray, a clash, a git-tidy check finding on the base or on the side, a plan or the
//   list that cannot be read, a done job that could not be forgotten), 2 usage (a bad flag, no repository, a bad `--plan` or marks file) and any unexpected failure (1
//   must only ever mean findings). A hold is no finding.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readLaneBase } from '../../git-tidy/lib/base-record.mjs';
import { runCheck } from '../../git-tidy/lib/check.mjs';
import { UsageError, gitText, runGit } from '../../git-tidy/lib/git.mjs';
import { poolSlots } from '../../git-tidy/lib/lane-pool.mjs';
import { commonDirOf, slotKey } from '../../git-tidy/lib/lane-slots.mjs';
import { listWorktrees, openRepo } from '../../git-tidy/lib/repo.mjs';
import { readLandEntries } from '../../land/ledger.mjs';
import { jsonText } from './cells.mjs';
import { isSyncablePath, readSyncRecord, syncRunning } from './sync-record.mjs';
import { heldBy, pieceBranch, planState } from './tick-features.mjs';
import { clashesOf, forgetPlan, landsOfPlan, readJobs, rememberPlans } from './tick-jobs.mjs';
import { clean, short, tickLines } from './tick-lines.mjs';
import { readMarks, readPlan, writeMark } from './tick-plan.mjs';
import { queuesOf, straysOf } from './tick-queue.mjs';
import { testBranches } from './tick-tests.mjs';
import { trustedRepos } from './trusted-repos.mjs';

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
const SYNC_SCRIPT = join('scripts', 'sync-machines.mjs'); // the setup's own sync: the tick shows its record only there
const LANE_NAME = /\blane-(\d+)\b/gi; // a pool folder in an agent's name, as a whole word (`tess lane-5 <feature>`: start.mjs)
// git-tidy check kinds about other refs and folders, not main: a leftover there must not stop the round, so they go on the `tidy`
// line. Every other kind (dirty-base, merge-commit, stale-checkout, and any kind check.mjs adds later) counts as main: fail safe.
const SIDE_KINDS = new Set(['tangled-ref', 'merged-branch', 'merged-tag', 'merged-worktree', 'stale-worktree', 'superseded-copy', 'agent-leftover']);

const nulList = (text) => text.split('\0').filter((path) => path !== '');

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
 * The lane with the declared files of the plan piece on its branch added (cb-hold-1 d): a lane with no commit yet already holds
 * the files its piece will change, for the overlaps and the holds.
 */
function withDeclaredFiles(lane, pieces) {
  const piece = pieces.find((entry) => pieceBranch(entry) === lane.branch);
  return piece === undefined ? lane : { ...lane, files: [...new Set([...lane.files, ...piece.files])] };
}

/** The lane with the holds on its files (`held`): a held lane is never ready, so `next:` never lands it before tess returns. */
function heldLane(lane, holds) {
  const held = heldBy(holds, lane.files);
  return { ...lane, held, isReady: lane.isReady && held.length === 0 };
}

/** The land ledger, or no entries and why when it cannot be read: a broken ledger must not hide main and the lanes. */
function landLedger(repoDir) {
  try {
    return { ...readLandEntries(repoDir), unreadable: null };
  } catch (error) {
    return { entries: [], skipped: 0, unreadable: error.message.split('\n')[0] };
  }
}

/**
 * The pool's folders, each with its lock: the time it was taken (`lockedAtMs`, null when unlocked or unknown) for the snapshot
 * age, and its reason (`lockReason`, null when unlocked), which a release line passes as `--expect`.
 */
function foldersOf(repo) {
  const trees = new Map(listWorktrees(repo).map((tree) => [slotKey(tree.path), tree]));
  return poolSlots(repo).map((slot) => {
    const tree = trees.get(slotKey(slot.folder));
    return { ...slot, lockedAtMs: tree?.lockedAtMs ?? null, lockReason: tree?.lockReason ?? null };
  });
}

/** The live tess agents of the board, each with the pool folders its name names: a snapshot one of them names stays claimed. */
const liveTessOf = (agents) => agents.filter((agent) => agent.type === 'tess' && agent.state !== 'done')
  .map((agent) => ({ id: agent.id, name: agent.name, slots: [...agent.name.matchAll(LANE_NAME)].map((match) => `lane-${Number(match[1])}`) }));

/** Whether `repo` is the setup's own repository: the one holding this running code (trusted-repos.mjs, by the file system). */
function isSetupRepo(repo) {
  const setup = trustedRepos({ sessionFolder: null }).repos[0];
  return setup !== undefined && realpathSync.native(setup.common) === realpathSync.native(commonDirOf(repo));
}

/**
 * The sync facts, null outside the setup's own repository or without its sync script: the script, whether sync takes the
 * repository's path, its last record (`{ unreadable }` when it cannot be read) and whether a sync runs; a run lock that cannot
 * be read (a link, a folder: sync refuses to run then too) is `lockProblem`, and the rest of the tick still prints.
 */
function syncFacts(repo) {
  const script = join(repo.dir, SYNC_SCRIPT);
  if (!existsSync(script) || !isSetupRepo(repo)) return null;
  const facts = { script, isSyncable: isSyncablePath(repo.dir), record: readSyncRecord(repo.dir) };
  try {
    return { ...facts, isRunning: syncRunning(), lockProblem: null };
  } catch (error) {
    return { ...facts, isRunning: false, lockProblem: error.message.split('\n')[0] };
  }
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

/**
 * One job's facts: its queue, features, tess status, holds and ledger lands (`lands`), and whether it is done (every piece
 * landed, every feature checked).
 */
function jobOf({ path, plan, work, entries }, queue) {
  return {
    job: plan.job, path, queue, features: work.features, tess: work.tess, holds: work.holds, lands: entries,
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
  const pieces = plans.flatMap(({ plan }) => plan.pieces);
  const lanes = slots.filter((slot) => slot.branch !== null).map((slot) => withDeclaredFiles(laneOf(repo, main.sha, slot, agents), pieces));
  const tests = testBranches(repo, main.sha, { lanes, tidy, plan: plans.length === 0 ? null : { pieces } }).map((test) => ({ ...test, agent: agentOn(agents, test.branch) }));
  const ledger = landLedger(repo.dir);
  const liveTess = liveTessOf(agents);
  const tessRunning = liveTess.length;
  const works = plans.map(({ path, plan }) => {
    const entries = landsOfPlan(repo, plan, ledger.entries);
    return { path, plan, entries, work: planState(repo, plan, { lanes, entries, marks: readMarks(repo, plan.job), isTessRunning: tessRunning > 0 }) };
  });
  const holds = works.flatMap(({ work }) => work.holds); // pooled: one job's risky land holds every job's pieces on its files
  const clashes = clashesOf(plans.map(({ plan }) => plan));
  const clashed = new Set(clashes.map(({ branch }) => branch));
  const { queues, overlaps } = queuesOf({ works, lanes, entries: ledger.entries, holds, clashed });
  return {
    repo: repo.dir, main, tidy, folders: slots, lanes: lanes.map((lane) => heldLane(lane, holds)), tests, overlaps,
    strays: straysOf(lanes, pieces), clashes, jobs: works.map((entry, at) => jobOf(entry, queues[at])), planProblems: problems, listProblem,
    ledgerSkipped: ledger.skipped, ledgerUnreadable: ledger.unreadable, tessRunning, liveTess, agents,
    agentsRunning: agents.filter((agent) => agent.state !== 'done').length, sync: syncFacts(repo),
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
