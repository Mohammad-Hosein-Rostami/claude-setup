// Purpose: the plain lines `board tick` prints from its facts (tick.mjs tickFacts): the base (the branch checked out in the main
//   checkout, by its own name), the side findings to tidy, the pool's folders, one line per lane, the test branches not landed,
//   overlaps, strays, clashes, the plans that cannot be read, each job's lines (queue, features, commits, holds), the `agents`
//   line and one `job` line per job (tick-pace.mjs), the `sync` line in the setup's own repository, and last the `next:` header
//   with its numbered `do` lines (tick-do.mjs). With two or more jobs each job's own lines (queue, features, commits, holds, its
//   part of the base line) start with `<job>: `; a `job` line names its job itself.
// Exports: tickLines(tick) -> string[], clean(text), short(sha).
// Invariants: pure apart from reading the clock for the snapshot age and the agents' ages (and tick-do.mjs's). Every branch
//   name, path and agent name goes through cells.mjs cleanText, so no control character reaches the terminal, and through
//   shellWord too inside a printed command. The `do` lines only suggest: the boss decides (tick-do.mjs says which steps print when).
import { SNAPSHOT_LABEL } from '../../git-tidy/lib/lane-slots.mjs';
import { shellWord } from '../../git-tidy/lib/shell-word.mjs';
import { cleanText } from './cells.mjs';
import { doSteps, isSnapshot, syncLine } from './tick-do.mjs';
import { commitsLines, featuresLine } from './tick-features.mjs';
import { agentsLine, jobLine } from './tick-pace.mjs';
import { queueLine } from './tick-queue.mjs';

const SHORT_SHA = 8;
const AGENT_ID_CHARS = 7;
const SHOWN_FILES = 3;
const SHOWN_TESTS = 5; // test branches on the `tests not landed` line
const MS_PER_HOUR = 60 * 60 * 1000;
const BUSY = 'busy';
// cleanText reads only `ascii` from a look: these lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };

/** `text` with every control character removed (cells.mjs cleanText), non-ASCII kept. */
export const clean = (text) => cleanText(text, PLAIN_LOOK);
/** The first 8 characters of a commit hash. */
export const short = (sha) => sha.slice(0, SHORT_SHA);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The first `count` of `items`, then `+<m> more` for the rest, comma-separated. */
const firstOf = (items, count) => [...items.slice(0, count), ...(items.length > count ? [`+${items.length - count} more`] : [])].join(', ');
const filesText = (files) => firstOf(files.map(clean), SHOWN_FILES);

/** Each distinct kind of `findings` once, in first-seen order. */
const kindsOf = (findings) => [...new Set(findings.map(({ kind }) => kind))];
/** `<job>: ` before a job's own text when the tick shows two or more jobs, else nothing (one job reads as before). */
const jobPrefix = (tick, job) => (tick.jobs.length > 1 ? `${job.job}: ` : '');
const TICK_COMMAND = 'node ~/.claude/tools/board/board.mjs tick';

/** `running`, `done`, or `quiet N min`, as `board show` prints an agent's state. */
function agentStateText(agent) {
  if (agent.state === 'run') return 'running';
  if (agent.state === 'quiet') return `quiet ${agent.quietMin} min`;
  return 'done';
}

/** A job's tess part of the base line: its pieces landed since its newest tess mark. */
const tessSince = (job) => `${job.landedSince} landed ${job.lastTessSha === null ? 'and no tess round yet' : `since tess round at ${short(job.lastTessSha)}`}`;

function mainLine(tick) {
  const { main } = tick;
  const kinds = kindsOf(main.findings).map((kind) => `${main.findings.filter((finding) => finding.kind === kind).length} ${kind}`);
  const isDirty = main.findings.some(({ kind }) => kind === 'dirty-base');
  const isOneLine = !main.findings.some(({ kind }) => kind === 'merge-commit');
  const check = kinds.length === 0 ? 'git-tidy check 0' : `git-tidy check 1: ${kinds.join(', ')}`;
  const tess = tick.jobs.map((job) => `, ${jobPrefix(tick, job)}${tessSince(job)}`).join('');
  return `base ${clean(main.branch)} ${short(main.sha)} ${isDirty ? 'dirty' : 'clean'}, ${isOneLine ? 'one line' : 'not one line'} (${check})${tess}`;
}

/**
 * The side findings (other refs and folders, not main) by kind with one subject each, and the prune command that lists what it
 * would remove: `prune` without `--apply` changes nothing and takes the same base as the tick (the branch checked out in the main
 * checkout). Null when there is none.
 */
function tidyLine({ tidy, repo }) {
  if (tidy.length === 0) return null;
  const kinds = kindsOf(tidy).map((kind) => {
    const subjects = tidy.filter((finding) => finding.kind === kind).map(({ subject }) => subject);
    const more = subjects.length > 1 ? `, +${subjects.length - 1} more` : '';
    return `${subjects.length} ${kind} (${clean(subjects[0])}${more})`;
  });
  return `tidy ${kinds.join(', ')} -> node ~/.claude/tools/git-tidy/git-tidy.mjs prune ${clean(repo)}`;
}

/** A folder's state as the folders line counts it: a snapshot claim is `snapshot`, not just `busy`. */
const folderState = (slot) => (isSnapshot(slot) ? SNAPSHOT_LABEL : slot.state);

function foldersLine(slots) {
  if (slots.length === 0) return 'folders none';
  const states = slots.map(folderState);
  const counts = [...new Set(states)].map((state) => `${states.filter((entry) => entry === state).length} ${clean(state)}`);
  const lockTimes = slots.filter((slot) => folderState(slot) === SNAPSHOT_LABEL && slot.lockedAtMs !== null).map((slot) => slot.lockedAtMs);
  const oldest = lockTimes.length === 0 ? '' : ` (oldest ${Math.floor((Date.now() - Math.min(...lockTimes)) / MS_PER_HOUR)} h)`;
  return `folders ${counts.join(', ')}${oldest}`;
}

/**
 * A lane's verdict: a lane claimed on another base lands only there (land refuses it here); a held lane waits for tess on the
 * held features; a ready lane behind the base still lands (land rebases it); a lane not ready only says it is behind.
 */
function laneVerdict(lane, base) {
  if (lane.claimedOn !== null && lane.claimedOn !== base) return `claimed on ${clean(lane.claimedOn)}: lands only there`;
  if (lane.held.length > 0) return `held by ${lane.held.join(', ')}`;
  if (lane.isReady) return lane.mainMoved ? `ready to land (behind ${clean(base)}; land rebases it)` : 'ready to land';
  return lane.mainMoved ? `behind ${clean(base)}` : '';
}

function laneLine(lane, base) {
  const agent = lane.agent === null ? 'no agent' : `${clean(lane.agent.type)} ${clean(lane.agent.id).slice(0, AGENT_ID_CHARS)} ${agentStateText(lane.agent)}`;
  const changes = lane.changed === null ? 'changes ?' : lane.changed.length === 0 ? 'clean' : `~${lane.changed.length} changed`;
  const folder = lane.folderState === BUSY ? '' : `folder ${clean(lane.folderState)}`;
  return ['lane', clean(lane.branch), agent, `+${plural(lane.commits, 'commit')}`, changes, laneVerdict(lane, base), folder].filter((part) => part !== '').join(' ');
}

/** A test branch: its commits, plan piece and agent, or the folder that holds it when it has no commit of its own yet. */
function testText(test) {
  if (test.commits === 0) return `${clean(test.branch)} no commit (in ${clean(test.folder)})`;
  const piece = test.piece === null ? '' : ` (piece ${test.piece})`;
  const agent = test.agent === null ? '' : ` (${clean(test.agent.type)} ${agentStateText(test.agent)})`;
  return `${clean(test.branch)} +${test.commits}${piece}${agent}`;
}

function testsLine(tests) {
  return tests.length === 0 ? null : `tests not landed: ${firstOf(tests.map(testText), SHOWN_TESTS)}`;
}

/** `hold <feature> until tess returns (<why>[ at <sha8>]): <files>`: no piece or lane on those files starts or lands until then. */
const holdLine = (hold) => `hold ${hold.feature} until tess returns (${hold.why}${hold.sha === null ? '' : ` at ${short(hold.sha)}`}): ${filesText(hold.files)}`;

/** One job's lines: its queue, its features line, its commits lines and its holds. */
const jobLines = (tick, job) => [queueLine(job.queue), featuresLine(job), ...commitsLines(job), ...job.holds.map(holdLine)].map((line) => `${jobPrefix(tick, job)}${line}`);

/** `clash <branch>: piece <a> of <job1>, piece <b> of <job2>`: two plans name one branch. */
const clashLine = ({ branch, owners }) => `clash ${clean(branch)}: ${owners.map(({ job, piece }) => `piece ${piece} of ${job}`).join(', ')}`;

/** A remembered plan that cannot be read: why, and the command that forgets it. */
function planProblemLine({ repo }, { path, problem }) {
  return `${clean(problem)} (forget it: ${TICK_COMMAND} --repo ${shellWord(clean(repo))} --forget-plan ${shellWord(clean(path))})`;
}

/** A done job's line: forgotten by this tick, or why it could not be. */
const forgottenLine = ({ job, problem }) => `job ${job} done (${problem === null ? 'forgotten' : `not forgotten: ${clean(problem)}`})`;

/** The `next:` header, then one `do <n>: <what and why>[: <command>]` line per step, in the order to run them. */
function doLines(tick) {
  const { header, steps } = doSteps(tick);
  return [header, ...steps.map(({ text, command }, at) => `do ${at + 1}: ${text}${command === null ? '' : `: ${command}`}`)];
}

/**
 * The tick as plain lines (about 20 for 3 lanes and one job of 12 pieces).
 * @param {object} tick tick.mjs tickFacts's result
 * @returns {string[]} the lines in print order, the `next:` header and its `do` lines last
 */
export function tickLines(tick) {
  return [
    mainLine(tick),
    ...[tidyLine(tick)].filter((line) => line !== null),
    foldersLine(tick.folders),
    ...tick.lanes.map((lane) => laneLine(lane, tick.main.branch)),
    ...[testsLine(tick.tests)].filter((line) => line !== null),
    ...tick.overlaps.map((pair) => `overlap ${clean(pair.first)} x ${clean(pair.second)}: ${filesText(pair.files)}`),
    ...tick.strays.map((stray) => `stray ${clean(stray.branch)}: ${filesText(stray.files)} (not in its files)`),
    ...tick.clashes.map(clashLine),
    ...tick.planProblems.map((problem) => planProblemLine(tick, problem)),
    ...(tick.listProblem === null ? [] : [`plans list: ${clean(tick.listProblem)}`]),
    ...tick.jobs.flatMap((job) => jobLines(tick, job)),
    ...tick.forgotten.map(forgottenLine),
    ...(tick.ledgerSkipped > 0 ? [`ledger ${plural(tick.ledgerSkipped, 'bad line')} skipped`] : []),
    ...(tick.ledgerUnreadable === null ? [] : [`ledger unreadable (${clean(tick.ledgerUnreadable)}): no piece counts as landed`]),
    agentsLine(tick.agents, Date.now()),
    ...tick.jobs.map(jobLine),
    ...[syncLine(tick)].filter((line) => line !== null),
    ...doLines(tick),
  ];
}
