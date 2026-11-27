// Purpose: the steps `board tick` ends with (plan-core-best cb-do-1): a `next:` header and numbered `do` lines, each one exact step
//   in the order to run it (land, resume, release, start dev, start tess, test branches, sync), worked out from the tick's facts
//   (tick.mjs tickFacts), so the boss runs printed steps and writes no claim, release or sync command by hand. Also the `sync`
//   status line, so all of the sync's words live here.
// Exports: doSteps(tick) -> { header, steps: { kind, text, command }[] }, syncLine(tick) -> string | null, isSnapshot(slot).
// Invariants: pure apart from reading the clock (a snapshot lock's age, the clock time a sync began to fail). Only suggests: the
//   boss runs each line and keeps every judgement (a land only on its report's verdict). Every name printed goes through
//   cells.mjs cleanText, and every word of a command through shellWord. While the base has a finding of its own, or the land
//   ledger cannot be read (it hides every land, so every hold), only resume, release and sync lines print. A snapshot is offered
//   for release only when its lock is at least an hour old, every live tess names its own folder (`lane-<n>`) and none names
//   this one (plan section 5.7), and the release carries `--expect` with its lock reason, so a folder claimed again since is
//   never freed. Start lines are the tick's startable pieces (tick-queue.mjs: file-disjoint, never held or clashing).
import { SNAPSHOT_LABEL } from '../../git-tidy/lib/lane-slots.mjs';
import { shellWord } from '../../git-tidy/lib/shell-word.mjs';
import { cleanText } from './cells.mjs';
import { clockText, systemTimeZone } from './local-clock.mjs';

const MAX_DEV = 3;
const MAX_TESS = 3;
const SHORT_SHA = 8;
const AGENT_ID_CHARS = 7;
const NAMED_TESTS = 3; // test branches offered per tick: each land prints the next tick, which offers the next ones
const MS_PER_HOUR = 60 * 60 * 1000;
// plan section 5.7: a younger snapshot may be one whose tess the boss is starting now, or another session's tess (not on this board)
const MIN_RELEASE_AGE_MS = MS_PER_HOUR;
const TEST_PREFIX = 'test/'; // tess-write's branches (home/agents/tess.md): they land as test branches, never as a dev lane
const DONE = 'done'; // a board agent's state when its turn ended
const BUSY = 'busy';
const SNAPSHOT_WHY = `${SNAPSHOT_LABEL} `; // lane-slots.mjs: a snapshot claim's busy why is `snapshot <8 of its sha>`
const LAND = 'node ~/.claude/tools/land/land.mjs';
const RELEASE = 'node ~/.claude/tools/git-tidy/git-tidy.mjs lane release';
const START = 'node ~/.claude/tools/board/board.mjs start';
const CHECK = 'node ~/.claude/tools/git-tidy/git-tidy.mjs check';
// home/CLAUDE.md and plan section 18 N7: what the boss lands; the line names it, so the rule is in front of the boss at the land
const LAND_IF = 'if its report says done, or partial with safe to land: yes (re-queue its open lines as a piece); never a blocked one';
// the tick does not know a repository's test command: copied as printed, land runs `<suite>`, which fails, so it lands nothing
const SUITE_PLACEHOLDER = "'<suite>'";
// sync-record.mjs: a target ssh did not reach has the problem `unreachable: ...`, or `<machine>: unreachable: ...`
const UNREACHABLE = 'unreachable:';
// cleanText reads only `ascii` from a look: these lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };

const clean = (text) => cleanText(text, PLAIN_LOOK);
const short = (sha) => sha.slice(0, SHORT_SHA);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const step = (kind, text, command = null) => ({ kind, text, command });
const word = (text) => shellWord(clean(text));
const isTestBranch = (branch) => branch.startsWith(TEST_PREFIX);
const devLanes = (tick) => tick.lanes.filter((lane) => !isTestBranch(lane.branch));
const agentId = (agent) => clean(agent.id).slice(0, AGENT_ID_CHARS);
const landCommand = (tick, branch) => `${LAND} ${word(branch)} --repo ${word(tick.repo)}`;
/** `--job <slug>` when the tick reads two or more jobs: `board start` needs it for an id two plans share. */
const jobFlag = (tick, job) => (tick.jobs.length > 1 ? ` --job ${job.job}` : '');

/** Whether a pool folder is a snapshot claim (tess's detached folder at a sha), not a lane on a branch. */
export const isSnapshot = (slot) => slot.state === BUSY && slot.why.startsWith(SNAPSHOT_WHY);

/**
 * One land line per ready dev lane: one on the base's tip first, then one land rebases, and last one in an overlap or a stray,
 * which lands with the repository's whole suite as `--test` (home/CLAUDE.md).
 */
function landSteps(tick) {
  const flagged = new Set([...tick.overlaps.flatMap((pair) => [pair.first, pair.second]), ...tick.strays.map((stray) => stray.branch)]);
  const rank = (lane) => (flagged.has(lane.branch) ? 2 : Number(lane.mainMoved));
  return devLanes(tick).filter((lane) => lane.isReady).sort((first, second) => rank(first) - rank(second)).map((lane) => {
    const agent = lane.agent === null ? 'no agent' : `${clean(lane.agent.type)} ${agentId(lane.agent)} done`;
    const facts = `${agent}, +${plural(lane.commits, 'commit')}`;
    if (!flagged.has(lane.branch)) return step('land', `land ${clean(lane.branch)} (${facts}) ${LAND_IF}`, landCommand(tick, lane.branch));
    const text = `land ${clean(lane.branch)} last (${facts}; in an overlap or a stray: put the repository's whole test command for <suite>) ${LAND_IF}`;
    return step('land', text, `${landCommand(tick, lane.branch)} --test ${SUITE_PLACEHOLDER}`);
  });
}

/** One resume line per dev lane whose agent is done but left changes uncommitted or made no commit. */
function resumeSteps(tick) {
  return devLanes(tick).filter((lane) => lane.agent?.state === DONE && (lane.changed?.length > 0 || lane.commits === 0)).map((lane) => {
    const left = lane.changed?.length > 0 ? `~${lane.changed.length} changed` : '+0 commits';
    return step('resume', `resume ${clean(lane.agent.type)} ${agentId(lane.agent)} (done; ${clean(lane.branch)} ${left}): SendMessage it to finish and report`);
  });
}

/** One release line per snapshot no tess may still use (see the header), with its lock reason as `--expect`. */
function releaseSteps(tick, nowMs) {
  // a live tess whose name names no folder may be on any snapshot
  if (tick.liveTess.some((tess) => tess.slots.length === 0)) return [];
  const named = new Set(tick.liveTess.flatMap((tess) => tess.slots));
  const isOld = (slot) => slot.lockedAtMs !== null && nowMs - slot.lockedAtMs >= MIN_RELEASE_AGE_MS;
  return tick.folders.filter((slot) => isSnapshot(slot) && isOld(slot) && !named.has(slot.slot)).map((slot) => {
    const hours = Math.floor((nowMs - slot.lockedAtMs) / MS_PER_HOUR);
    const command = `${RELEASE} --repo ${word(tick.repo)} --folder ${word(slot.folder)} --expect ${word(slot.lockReason)}`;
    return step('release', `release ${slot.slot} (${clean(slot.why)}, ${hours} h, no tess on it)`, command);
  });
}

/** One start line per startable piece, every job in plan order, while fewer than MAX_DEV dev lanes are in flight. */
function startDevSteps(tick) {
  const startable = tick.jobs.flatMap((job) => job.queue.filter((piece) => piece.isStartable).map((piece) => ({ job, piece })));
  return startable.slice(0, Math.max(0, MAX_DEV - devLanes(tick).length)).map(({ job, piece }) => {
    const branch = piece.branch === null ? '' : `, branch ${clean(piece.branch)}`;
    return step('start-dev', `start dev on ${piece.id} (job ${job.job}${branch})`, `${START} --repo ${word(tick.repo)} --piece ${piece.id}${jobFlag(tick, job)}`);
  });
}

/** One start line per feature listed for tess in a job with tess due, while fewer than MAX_TESS tess run. */
function startTessSteps(tick) {
  const due = tick.jobs.filter((job) => job.tess.reason !== null).flatMap((job) => job.tess.features.map((feature) => ({ job, feature })));
  return due.slice(0, Math.max(0, MAX_TESS - tick.tessRunning)).map(({ job, feature }) => step(
    'start-tess',
    `start tess on ${feature.id} (job ${job.job}; ${clean(job.tess.reason)})`,
    `${START} --repo ${word(tick.repo)} --tess ${feature.id}${jobFlag(tick, job)}`,
  ));
}

/**
 * One land line per test branch tess left: a ready pool lane on `test/*`, then a `test/*` branch with commits and no plan piece
 * or live agent on it (a plan piece's branch lands as that piece); at most NAMED_TESTS.
 */
function testSteps(tick) {
  const lanes = tick.lanes.filter((lane) => isTestBranch(lane.branch) && lane.isReady).map((lane) => lane.branch);
  const left = tick.tests.filter((test) => test.commits > 0 && test.piece === null && (test.agent === null || test.agent.state === DONE)).map((test) => test.branch);
  return [...lanes, ...left].slice(0, NAMED_TESTS).map((branch) => step(
    'test-branch',
    `land ${clean(branch)} if tess passed it (a failing repro gets a Fix: piece on its branch)`,
    landCommand(tick, branch),
  ));
}

/** The sync record's first problem: why the run stopped, else the first machine not synced as `<machine>: <problem>`. */
function firstProblem(record) {
  if (record.problem !== '') return clean(record.problem);
  const machine = record.machines.find((entry) => !entry.ok);
  return machine === undefined ? 'no problem recorded' : `${clean(machine.machine)}: ${clean(machine.problem)}`;
}

/** The local clock time (HH:MM) the sync began to fail; the record is a file, so a time that does not parse says so. */
function failedSinceText(record) {
  const ms = Date.parse(record.failedSince);
  return Number.isNaN(ms) ? 'an unknown time' : clockText(ms, systemTimeZone());
}

const isReadable = (record) => record !== null && record.unreadable === undefined;
/** The machine entries a base run has not synced to `sha`, in the record's order. */
const behindAt = (record, sha) => record.machines.filter((entry) => !(entry.ok && entry.sha === sha));
const namesOf = (entries, state) => entries.map((entry) => `${clean(entry.machine)} ${state}`).join(', ');
const isUnreachable = (entry) => entry.problem.startsWith(UNREACHABLE) || entry.problem.startsWith(`${entry.machine}: ${UNREACHABLE}`);
/** Whether every behind machine was out of ssh's reach: a sync again cannot reach it until it is woken. */
const isOnlyUnreachable = (behind) => behind.length > 0 && behind.every(isUnreachable);

/**
 * The sync line: a failing sync with its count and retry, else a sync while a machine is not at the base's tip (or none was
 * recorded); nothing while a sync runs, its lock cannot be read, the repository's path is one sync refuses, or the last run was
 * at the base's tip and every machine it left behind was unreachable (the `sync` status line says to wake it).
 */
function syncSteps(tick) {
  const { sync, main } = tick;
  if (sync === null || !sync.isSyncable || sync.isRunning || sync.lockProblem !== null) return [];
  const command = `node ${word(sync.script)} --repo ${word(tick.repo)}`;
  const { record } = sync;
  if (isReadable(record) && record.failures > 0) {
    const text = `sync failed ${plural(record.failures, 'time')} since ${failedSinceText(record)} (${firstProblem(record)}): tell the owner once, then a Fix piece; retry`;
    return [step('sync-failed', text, command)];
  }
  if (isReadable(record) && record.ok && record.sha === main.sha) return [];
  const behind = isReadable(record) ? behindAt(record, main.sha) : [];
  // the sync line says to wake it first: a retry at the same sha would fail on it again after every tick
  if (isReadable(record) && record.sha === main.sha && isOnlyUnreachable(behind)) return [];
  let synced = 'never';
  if (record !== null) synced = isReadable(record) && record.sha !== '' ? short(record.sha) : 'unknown';
  return [step('sync', `sync in the background (base ${short(main.sha)}, synced ${synced}${behind.length === 0 ? '' : `; ${namesOf(behind, 'behind')}`})`, command)];
}

/**
 * The `sync` status line, only in the setup's own repository (tick.mjs syncFacts): running, never, ok at a sha, failed with its
 * first problem and count, not every machine at the last run's sha (each `unreachable` with what to do when ssh reached none of
 * them, else each `behind`), or a record or lock that cannot be read.
 * @param {{ sync: object | null }} tick the tick's facts
 * @returns {string | null} the line, or null outside the setup's own repository
 */
export function syncLine({ sync }) {
  if (sync === null) return null;
  if (sync.lockProblem !== null) return `sync state unknown (${clean(sync.lockProblem)})`;
  if (sync.isRunning) return 'sync running';
  const { record } = sync;
  if (record === null) return 'sync never';
  if (!isReadable(record)) return `sync record unreadable (${clean(record.unreadable)})`;
  const at = record.sha === '' ? '' : ` at ${short(record.sha)}`;
  if (record.failures > 0) return `sync failed${at}: ${firstProblem(record)} (${plural(record.failures, 'time')} since ${failedSinceText(record)})`;
  if (record.ok) return `sync ok${at}`;
  const behind = behindAt(record, record.sha);
  if (isOnlyUnreachable(behind)) return `sync incomplete${at}: ${namesOf(behind, 'unreachable')} (wake ${behind.length === 1 ? 'it' : 'them'} and turn on Remote Login, then sync)`;
  return `sync incomplete${at}: ${namesOf(behind, 'behind')}`;
}

/** The `next:` header: what holds the steps back, or how many there are; `nothing to do now` only with none. */
function headerOf(tick, count) {
  const slots = `dev ${devLanes(tick).length}/${MAX_DEV}, tess ${tick.tessRunning}/${MAX_TESS}`;
  const replaces = count === 0 ? '' : `; ${plural(count, 'step')}, these replace every earlier do line`;
  if (tick.main.findings.length > 0) return `next: fix ${clean(tick.main.branch)} first (${CHECK} ${word(tick.repo)}), start no new piece; ${slots}${replaces}`;
  if (tick.ledgerUnreadable !== null) return `next: the land ledger cannot be read, so every hold is hidden: land nothing and start no new piece until it reads; ${slots}${replaces}`;
  if (count === 0) return `next: nothing to do now; ${plural(tick.agentsRunning, 'agent')} running (${slots})`;
  return `next: ${plural(count, 'step')} (${slots}; these replace every earlier do line)`;
}

/**
 * The steps to run now, in the order to run them.
 * @param {object} tick tick.mjs tickFacts's result
 * @returns {{ header: string, steps: { kind: 'land'|'resume'|'release'|'start-dev'|'start-tess'|'test-branch'|'sync'|'sync-failed',
 *   text: string, command: string|null }[] }} the `next:` line and each step: what it is and why, and the command to run as
 *   printed (null for a step with no command: resume)
 */
export function doSteps(tick) {
  const nowMs = Date.now();
  const isHeld = tick.main.findings.length > 0 || tick.ledgerUnreadable !== null;
  const steps = isHeld
    ? [...resumeSteps(tick), ...releaseSteps(tick, nowMs), ...syncSteps(tick)]
    : [...landSteps(tick), ...resumeSteps(tick), ...releaseSteps(tick, nowMs), ...startDevSteps(tick), ...startTessSteps(tick), ...testSteps(tick), ...syncSteps(tick)];
  return { header: headerOf(tick, steps.length), steps };
}
