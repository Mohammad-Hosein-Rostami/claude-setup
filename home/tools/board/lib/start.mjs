// Purpose: `board start` (plan-core-best cb-start-1): claims the pool lane of a startable plan piece, or a snapshot for tess, and
//   prints the brief to send whole, so the boss never writes a claim, a tess mark or a brief by hand.
// Exports: START_USAGE, runStart(args, session) -> exit code, startPiece({ repo, tick, pieceId, job }) and startTess({ repo, tick,
//   featureId, job, qa }) -> { lines, exit }.
// Facts: the tick's own: `board tick --json` runs as a child process, so the queue, the holds, the lanes and their agents are the
//   ones the tick prints, from the one tick code; the pieces and features of the job's plan from tick-plan.mjs readPlan. The claim
//   is git-tidy's (lane-cli.mjs claimPrepared: claimLane under the pool lock, then the deps prep), at the base's tip: the base is
//   the branch checked out in the main checkout, so no `--base` is given.
// Invariants: a piece is claimed only when the tick calls it startable (after, waits, overlap, held, clash), the base has no finding
//   of its own and the ledger reads (an unread ledger hides every hold); the pool lock lets two starts of one piece make one claim.
//   A piece whose branch a pool lane holds gets no second claim: its brief prints again when no live agent is on it and no hold is
//   on its files, its `BASE:` the commit the lane's branch is on (its fork point), not the base's tip now. `--tess` claims the
//   snapshot first, then writes the mark, so a crash between leaves a spare snapshot (released by its printed command), never a
//   mark with no folder. Two `--tess` starts of one feature at once may both claim and mark (TODO(F3): the due check is not under
//   the marks lock). Every name and path printed goes through cleanText, and every path through
//   shellWord. Exit 0 started or brief again, 1 refused (`start refused: <why>` on stderr), 2 usage (a bad flag, an unknown or
//   ambiguous id, no remembered plan, a tick that failed) and any unexpected failure.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageError, gitText } from '../../git-tidy/lib/git.mjs';
import { claimPrepared, laneExit } from '../../git-tidy/lib/lane-cli.mjs';
import { openRepo } from '../../git-tidy/lib/repo.mjs';
import { shellWord } from '../../git-tidy/lib/shell-word.mjs';
import { pieceBranch } from './tick-features.mjs';
import { clean, short } from './tick-lines.mjs';
import { readMarks, readPlan, writeMark } from './tick-plan.mjs';
import { queueLine } from './tick-queue.mjs';

export const START_USAGE = 'usage: board.mjs start --repo <abs main checkout> --piece <id> [--job <slug>] [--session <id>]\n'
  + '       board.mjs start --repo <abs main checkout> --tess <feature> [--job <slug>] [--qa <level>] [--session <id>]';
const EXIT = Object.freeze({ started: 0, refused: 1, usage: 2 });
// `--session` is the board the tick loads; board.mjs resolves it (the flag, else CLAUDE_CODE_SESSION_ID)
const VALUE_FLAGS = Object.freeze({ '--repo': 'repo', '--piece': 'piece', '--tess': 'tess', '--job': 'job', '--qa': 'qa', '--session': 'session' });
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;
const BOARD_SCRIPT = fileURLToPath(new URL('../board.mjs', import.meta.url));
const TICK_SHOWN = new Set([0, 1]); // tick.mjs: 0 shown, 1 findings (still the whole tick); 2 usage or a failure
const TICK_TIMEOUT_MS = 10 * 60 * 1000; // a tick takes seconds; the risk tool may take up to a minute on each unchecked land
const TICK_MAX_BYTES = 64 * 1024 * 1024;
// tess's qa levels (tess.md Brief, qa-plan's smoke row); quick is the quick look, the default
const QA_LEVELS = new Set(['quick', 'smoke', 'checks', 'full', 'review', 'tests', 'edge', 'deps', 'ui', 'repro', 'e2e']);
const QUICK = 'quick';
const FULL = 'full';
const DONE = 'done'; // an agent state of the board: every other state (run, quiet) is a live agent
const AGENT_ID_CHARS = 7;
const NO_SPEC = 'none in the plan';
// the owner's no-test rule and dev.md's report, so a dev started from this brief needs no other words
const DEV_RULES = Object.freeze([
  'tests: none (owner rule): write and run no tests; where your change alters text a test pins, update only that expectation, by reading, and name it as a stale pin',
  'report: starts with `verdict:` (dev.md, Report)',
]);

const firstLine = (text) => clean(text.split('\n')[0]);
const refused = (why) => ({ lines: [`start refused: ${why}`], exit: EXIT.refused });
const releaseCommand = (repo, folder) => `node ~/.claude/tools/git-tidy/git-tidy.mjs lane release --repo ${shellWord(clean(repo.dir))} --folder ${shellWord(clean(folder))}`;

/** `--qa`'s words (spaces or commas between them) as one space-joined level; `quick` when it is not given. */
function qaLevel(value) {
  if (value === null) return QUICK;
  const words = value.split(/[\s,]+/).filter((word) => word !== '');
  if (words.length === 0 || !words.every((word) => QA_LEVELS.has(word))) throw new UsageError(`--qa takes tess's levels (${[...QA_LEVELS].join(' ')}), got ${JSON.stringify(value)}`);
  return words.join(' ');
}

function parseStartArgs(args) {
  const options = { repo: null, piece: null, tess: null, job: null, qa: null, session: null };
  for (let at = 0; at < args.length; at++) {
    const name = VALUE_FLAGS[args[at]];
    if (name === undefined) throw new UsageError(`unknown argument ${JSON.stringify(args[at])} for start. ${START_USAGE}`);
    if (args[at + 1] === undefined || args[at + 1].startsWith('--')) throw new UsageError(`${args[at]} needs a value. ${START_USAGE}`);
    options[name] = args[++at];
  }
  if (!ABSOLUTE_PATH.test(options.repo ?? '')) throw new UsageError(`start needs --repo <absolute path of the main checkout>. ${START_USAGE}`);
  if ((options.piece === null) === (options.tess === null)) throw new UsageError(`start needs one of --piece <id> and --tess <feature>. ${START_USAGE}`);
  if (options.qa !== null && options.tess === null) throw new UsageError(`--qa goes with --tess. ${START_USAGE}`);
  return { ...options, qa: qaLevel(options.qa) };
}

/** The tick's facts as `board tick --json` prints them (exit 0 or 1); a tick that fails is a UsageError with its first line. */
function readTick(repoDir, session) {
  const sessionArgs = typeof session === 'string' ? ['--session', session] : [];
  const run = spawnSync(process.execPath, [BOARD_SCRIPT, 'tick', '--repo', repoDir, '--json', ...sessionArgs], { encoding: 'utf8', timeout: TICK_TIMEOUT_MS, maxBuffer: TICK_MAX_BYTES });
  if (run.error !== undefined) throw new Error(`the tick did not finish: ${run.error.message}`, { cause: run.error });
  if (!TICK_SHOWN.has(run.status)) throw new UsageError(`the tick failed: ${firstLine(run.stderr)}`);
  return JSON.parse(run.stdout);
}

/**
 * The job of the tick whose plan has the piece or feature `id` (`--job` picks one when two plans have it), with its plan and that
 * piece or feature.
 * @throws {UsageError} no remembered plan, no plan with `id`, or two plans with it and no `--job`
 */
function jobWith(repo, tick, { id, job, kind }) {
  if (tick.jobs.length === 0) throw new UsageError('no plan is remembered for this repository: tick once with --plan <abs pieces.json>');
  const listOf = (plan) => (kind === 'piece' ? plan.pieces : plan.features);
  const found = tick.jobs.filter((entry) => job === null || entry.job === job)
    .map((entry) => ({ entry, plan: readPlan(entry.path, repo) }))
    .filter(({ plan }) => listOf(plan).some((item) => item.id === id));
  const where = job === null ? `the remembered plans (jobs ${tick.jobs.map((entry) => entry.job).join(', ')})` : `job ${clean(job)}`;
  if (found.length === 0) throw new UsageError(`no ${kind} ${clean(id)} in ${where}`);
  if (found.length > 1) throw new UsageError(`${kind} ${clean(id)} is in jobs ${found.map(({ entry }) => entry.job).join(' and ')}: add --job <slug>`);
  const [{ entry, plan }] = found;
  return { entry, plan, item: listOf(plan).find((item) => item.id === id) };
}

/** A piece's spec: its feature's `spec`, with `#<piece id>` added when the spec names no section. */
function pieceSpec(feature, piece) {
  if (feature.spec === undefined) return NO_SPEC;
  return clean(feature.spec.includes('#') ? feature.spec : `${feature.spec}#${piece.id}`);
}

/** dev's brief: dev.md's own fields (`worktree:`, `BRANCH:`, `BASE:`, `spec:`), the piece's facts and the rules it works under. */
function devBrief(repo, { plan, piece, folder, base }) {
  const feature = plan.features.find((entry) => entry.id === piece.feature);
  return [
    `start dev with description "dev ${piece.id}" and this brief, whole:`,
    `worktree: ${shellWord(clean(folder))}`,
    `BRANCH: ${clean(pieceBranch(piece))}`,
    `BASE: ${base}`,
    `repo: ${shellWord(clean(repo.dir))}`,
    `piece: ${piece.id} (feature ${feature.id}, risk ${clean(feature.risk)}, job ${plan.job})`,
    `spec: ${pieceSpec(feature, piece)}`,
    `files: ${piece.files.map((file) => shellWord(clean(file))).join(', ')}`,
    ...DEV_RULES,
  ];
}

/** A claim that failed: claimPrepared's exit code and first line, or its `lane not ready` lines (an install failed). */
function claimRefusal({ error, notReady }) {
  if (error !== undefined) return refused(`lane claim exit ${laneExit(error)}: ${firstLine(error.message)}`);
  const [first, ...rest] = notReady.map(clean);
  return { lines: [`start refused: lane claim exit 1: ${first}`, ...rest], exit: EXIT.refused };
}

/** claimPrepared's result, or `{ error }` with what it threw. */
function tryClaim(repo, lane) {
  try {
    return claimPrepared(repo, { repo: repo.dir, snapshot: false, branch: null, base: null, ...lane });
  } catch (error) {
    return { error };
  }
}

/** Why a piece not in a lane cannot start now, or null: landed, the base's own finding, an unread ledger, its queue state. */
function pieceBlock(tick, entry, piece) {
  const queued = entry.queue.find((each) => each.id === piece.id);
  // planState's queue holds every piece not landed and not in a lane: one missing from it has landed
  if (queued === undefined) return `${piece.id} has landed (job ${entry.job})`;
  if (tick.main.findings.length > 0) return `fix ${clean(tick.main.branch)} first (node ~/.claude/tools/git-tidy/git-tidy.mjs check ${shellWord(clean(tick.repo))}): start no new piece`;
  if (tick.ledgerUnreadable !== null) return `the land ledger cannot be read (${clean(tick.ledgerUnreadable)}): it hides every land, so every hold; start no new piece`;
  return queued.isStartable ? null : queueLine([queued]).slice('queue '.length);
}

/** A piece whose branch a pool lane holds: refused while a live agent or a hold is on it, else its brief again (no second claim). */
function briefAgain(repo, tick, { plan, piece, lane }) {
  if (lane.agent !== null && lane.agent.state !== DONE) return refused(`${clean(lane.agent.type)} ${clean(lane.agent.id).slice(0, AGENT_ID_CHARS)} is on it (${lane.slot})`);
  if (lane.held.length > 0) return refused(`${piece.id} is in ${lane.slot} and held by ${lane.held.join(', ')}: it starts again once tess returns`);
  // the pool records only the base branch a lane was claimed on (cs-lane-base), not its sha: the fork point is the claim's sha
  // until dev rebases, then the sha dev rebased onto, so BASE is the commit the branch is on, not the base's tip now
  const base = gitText(repo.dir, ['merge-base', tick.main.sha, `refs/heads/${lane.branch}`]);
  return { lines: [`already claimed in ${lane.slot}; brief again:`, ...devBrief(repo, { plan, piece, folder: lane.folder, base })], exit: EXIT.started };
}

/**
 * `board start --piece`: claims the piece's lane (its `branch`, else `lane/<id>`) and gives dev's brief.
 * @param {{ repo: object, tick: object, pieceId: string, job: string | null }} start openRepo's result, the tick's facts
 *   (`board tick --json`), the piece and `--job`
 * @returns {{ lines: string[], exit: number }} what to print and the exit code (EXIT)
 * @throws {UsageError} an unknown or ambiguous piece, or a plan that no longer reads
 */
export function startPiece({ repo, tick, pieceId, job }) {
  const { entry, plan, item: piece } = jobWith(repo, tick, { id: pieceId, job, kind: 'piece' });
  const branch = pieceBranch(piece);
  const lane = tick.lanes.find((each) => each.branch === branch);
  if (lane !== undefined) return briefAgain(repo, tick, { plan, piece, lane });
  const why = pieceBlock(tick, entry, piece);
  if (why !== null) return refused(why);
  const claim = tryClaim(repo, { branch });
  if (claim.error !== undefined || claim.notReady !== null) return claimRefusal(claim);
  const { claimed } = claim;
  return { lines: [`started ${clean(branch)} in ${claimed.slot} at ${short(claimed.base)} (job ${entry.job})`, ...devBrief(repo, { plan, piece, folder: claimed.folder, base: claimed.base })], exit: EXIT.started };
}

/** Why a feature gets no tess now, or null: it has no land; with the quick look, it is not listed for tess (checked, fixing, under tess, not due yet). */
function notDueWhy(entry, feature, marks, qa) {
  if (feature.landed === 0) return `${feature.id} has no land yet: tess checks landed work`;
  if (qa !== QUICK || entry.tess.features.some((each) => each.id === feature.id)) return null;
  // a verdict comes only from a mark holding every land (tick-features.mjs), so the feature has a mark here
  if (feature.isChecked) return `${feature.id} is checked at ${short(marks[feature.id].sha)}`;
  // tick-features.mjs drops a must-fix once a commit on the feature's files lands after it, a plan piece or not
  if (feature.verdict !== null) return `${feature.id} waits for its fix (${clean(feature.verdict)} at ${short(marks[feature.id].sha)}): it is due again once a commit on its files lands on the base`;
  if (feature.tessOn !== null) return `tess is on ${feature.id} at ${short(feature.tessOn)}`;
  return `${feature.id} is not due yet (${feature.landed}/${feature.pieces} pieces landed, risk none): tess comes once it has fully landed`;
}

/** Whether this is the first `full` tess at the base's tip: only that one runs the full suite (tess.md `suite: yes`). */
function isFirstFull(repo, tick, qa) {
  if (!qa.split(' ').includes(FULL)) return false;
  const marks = tick.jobs.flatMap((entry) => Object.values(readMarks(repo, entry.job)));
  return !marks.some((mark) => mark.sha === tick.main.sha && (mark.qa ?? '').split(' ').includes(FULL));
}

/**
 * The `acceptance:` of tess's brief: the feature's own `acceptance` when the plan gives one, else each landed piece's own
 * `acceptance`, and the spec's lines of the landed pieces that give none (only when the feature has a spec).
 */
function tessAcceptance(plan, feature, state) {
  if (feature.acceptance !== undefined) return clean(feature.acceptance);
  const landedIds = new Set(state.lands.map(({ piece }) => piece));
  const landed = plan.pieces.filter((piece) => landedIds.has(piece.id));
  const own = landed.filter((piece) => piece.acceptance !== undefined).map((piece) => `${piece.id}: ${clean(piece.acceptance)}`);
  const fromSpec = landed.filter((piece) => piece.acceptance === undefined).map((piece) => piece.id);
  const specPart = fromSpec.length > 0 && feature.spec !== undefined ? [`the spec's lines of pieces ${fromSpec.join(', ')}`] : [];
  const parts = [...own, ...specPart];
  return parts.length === 0 ? NO_SPEC : parts.join('; ');
}

/** tess's brief: tess.md's fields, the job, and the `done:` and `release:` commands tess runs last. */
function tessBrief(repo, { plan, feature, state, claimed, qa, suite }) {
  const { job } = plan;
  const repoWord = shellWord(clean(repo.dir));
  return [
    `start tess with description "tess ${claimed.slot} ${feature.id}" and this brief, whole:`,
    `qa: ${qa}`,
    `repo: ${repoWord}`,
    `main: ${claimed.base}`,
    `worktree: ${shellWord(clean(claimed.folder))}`,
    `feature: ${feature.id}`,
    `commits: ${state.lands.map(({ from, to }) => `${short(from)}..${short(to)}`).join(' ')}`,
    `suite: ${suite ? 'yes' : 'no'}`,
    `spec: ${feature.spec === undefined ? NO_SPEC : clean(feature.spec)}`,
    `acceptance: ${tessAcceptance(plan, feature, state)}`,
    `risk: ${clean(feature.risk)}${state.riskFound === null ? '' : ` -> ${clean(state.riskFound)}`}`,
    `job: ${job}`,
    `done: node ~/.claude/tools/board/board.mjs done --repo ${repoWord} --job ${job} --tess ${feature.id} --sha ${claimed.base} --verdict <ok|must-fix>`,
    `release: ${releaseCommand(repo, claimed.folder)}`,
  ];
}

/**
 * `board start --tess`: claims a snapshot at the base's tip, then marks the feature for tess there, and gives tess's brief.
 * @param {{ repo: object, tick: object, featureId: string, job: string | null, qa: string }} start openRepo's result, the tick's
 *   facts (`board tick --json`), the feature, `--job` and the qa level (`quick` unless the owner asked for more)
 * @returns {{ lines: string[], exit: number }} what to print and the exit code (EXIT)
 * @throws {UsageError} an unknown or ambiguous feature, a plan that no longer reads, marks that cannot be read
 */
export function startTess({ repo, tick, featureId, job, qa }) {
  const { entry, plan, item: feature } = jobWith(repo, tick, { id: featureId, job, kind: 'feature' });
  const state = entry.features.find((each) => each.id === feature.id);
  const why = notDueWhy(entry, state, readMarks(repo, entry.job), qa);
  if (why !== null) return refused(why);
  const suite = isFirstFull(repo, tick, qa); // read before this tess's own mark is written
  // at the tick's sha, so the snapshot, the mark and the `commits:` ranges are of one commit
  const claim = tryClaim(repo, { snapshot: true, base: tick.main.sha });
  if (claim.error !== undefined || claim.notReady !== null) return claimRefusal(claim);
  const { claimed } = claim;
  try {
    writeMark({ repo, plan, feature: feature.id, sha: claimed.base, qa });
  } catch (error) {
    return refused(`snapshot ${claimed.slot} is claimed, but the tess mark failed: ${firstLine(error.message)}; release it: ${releaseCommand(repo, claimed.folder)}`);
  }
  const lines = [`snapshot ${claimed.slot} at ${short(claimed.base)}; marked ${feature.id} for tess (job ${entry.job})`, ...tessBrief(repo, { plan, feature, state, claimed, qa, suite })];
  return { lines, exit: EXIT.started };
}

/**
 * Runs `board start <args>` and prints its result: the brief on stdout, a refusal or usage on stderr.
 * @param {string[]} args the arguments after `start`
 * @param {string | undefined} session the session whose board the tick reads (board.mjs: `--session`, else CLAUDE_CODE_SESSION_ID)
 * @returns {number} the exit code (see the header)
 */
export function runStart(args, session) {
  try {
    const options = parseStartArgs(args);
    const repo = openRepo(options.repo, null);
    const tick = readTick(repo.dir, session);
    const result = options.piece === null
      ? startTess({ repo, tick, featureId: options.tess, job: options.job, qa: options.qa })
      : startPiece({ repo, tick, pieceId: options.piece, job: options.job });
    (result.exit === EXIT.started ? console.log : console.error)(result.lines.join('\n'));
    return result.exit;
  } catch (error) {
    // a git message may quote a path: clean each line, as tick does
    console.error(`board start: ${error instanceof UsageError ? '' : 'unexpected failure: '}${error.message.split('\n').map(clean).join('\n')}`);
    return EXIT.usage;
  }
}
