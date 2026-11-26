// Purpose: the plain lines `board tick` prints from its facts (tick.mjs tickFacts): main, the side findings to tidy, the pool's
//   folders, one line per lane, the test branches not landed, overlaps, strays, the plan's lines and the suggested `next:` step.
// Exports: tickLines(tick) -> string[], clean(text), short(sha).
// Invariants: pure apart from reading the clock for the snapshot age. Every branch name, path and agent name goes through
//   cells.mjs cleanText, so no control character reaches the terminal, and through shellWord too inside a printed command. `next:` only suggests: the boss decides; it reads main's own
//   findings only, so a side finding (on the `tidy` line) never stops a land or a claim.
import { SNAPSHOT_LABEL } from '../../git-tidy/lib/lane-slots.mjs';
import { shellWord } from '../../git-tidy/lib/shell-word.mjs';
import { cleanText } from './cells.mjs';
import { commitsLines, featuresLine } from './tick-features.mjs';

const MAX_DEV = 3;
const MAX_TESS = 3;
const SHORT_SHA = 8;
const AGENT_ID_CHARS = 7;
const SHOWN_FILES = 3;
const SHOWN_TESTS = 5; // test branches on the `tests not landed` line
const NAMED_TESTS = 3; // test branches the `next:` step names
const MS_PER_HOUR = 60 * 60 * 1000;
const BUSY = 'busy';
const SNAPSHOT_WHY = `${SNAPSHOT_LABEL} `; // lane-slots.mjs: a snapshot claim's busy why is `snapshot <8 of its sha>`
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

/** `running`, `done`, or `quiet N min`, as `board show` prints an agent's state. */
function agentStateText(agent) {
  if (agent.state === 'run') return 'running';
  if (agent.state === 'quiet') return `quiet ${agent.quietMin} min`;
  return 'done';
}

function mainLine({ main, plan }) {
  const kinds = kindsOf(main.findings).map((kind) => `${main.findings.filter((finding) => finding.kind === kind).length} ${kind}`);
  const isDirty = main.findings.some(({ kind }) => kind === 'dirty-base');
  const isOneLine = !main.findings.some(({ kind }) => kind === 'merge-commit');
  const check = kinds.length === 0 ? 'git-tidy check 0' : `git-tidy check 1: ${kinds.join(', ')}`;
  const tess = plan === null ? '' : `, ${plan.landedSince} landed ${plan.lastTessSha === null ? 'and no tess round yet' : `since tess round at ${short(plan.lastTessSha)}`}`;
  return `main ${short(main.sha)} ${isDirty ? 'dirty' : 'clean'}, ${isOneLine ? 'one line' : 'not one line'} (${check})${tess}`;
}

/**
 * The side findings (other refs and folders, not main) by kind with one subject each, and the prune command that lists what it
 * would remove: `prune` without `--apply` changes nothing, and `--base` keeps it from refusing a repository with two base names.
 * Null when there is none.
 */
function tidyLine({ tidy, repo, main }) {
  if (tidy.length === 0) return null;
  const kinds = kindsOf(tidy).map((kind) => {
    const subjects = tidy.filter((finding) => finding.kind === kind).map(({ subject }) => subject);
    const more = subjects.length > 1 ? `, +${subjects.length - 1} more` : '';
    return `${subjects.length} ${kind} (${clean(subjects[0])}${more})`;
  });
  return `tidy ${kinds.join(', ')} -> node ~/.claude/tools/git-tidy/git-tidy.mjs prune ${clean(repo)} --base ${clean(main.branch)}`;
}

/** A folder's state as the folders line counts it: a snapshot claim is `snapshot`, not just `busy`. */
const folderState = (slot) => (slot.state === BUSY && slot.why.startsWith(SNAPSHOT_WHY) ? SNAPSHOT_LABEL : slot.state);

function foldersLine(slots) {
  if (slots.length === 0) return 'folders none';
  const states = slots.map(folderState);
  const counts = [...new Set(states)].map((state) => `${states.filter((entry) => entry === state).length} ${clean(state)}`);
  const lockTimes = slots.filter((slot) => folderState(slot) === SNAPSHOT_LABEL && slot.lockedAtMs !== null).map((slot) => slot.lockedAtMs);
  const oldest = lockTimes.length === 0 ? '' : ` (oldest ${Math.floor((Date.now() - Math.min(...lockTimes)) / MS_PER_HOUR)} h)`;
  return `folders ${counts.join(', ')}${oldest}`;
}

/** A lane's verdict: a ready lane behind main still lands (land rebases it); a lane not ready only says it is behind. */
function laneVerdict(lane) {
  if (lane.isReady) return lane.mainMoved ? 'ready to land (behind main; land rebases it)' : 'ready to land';
  return lane.mainMoved ? 'behind main' : '';
}

function laneLine(lane) {
  const agent = lane.agent === null ? 'no agent' : `${clean(lane.agent.type)} ${clean(lane.agent.id).slice(0, AGENT_ID_CHARS)} ${agentStateText(lane.agent)}`;
  const changes = lane.changed === null ? 'changes ?' : lane.changed.length === 0 ? 'clean' : `~${lane.changed.length} changed`;
  const folder = lane.folderState === BUSY ? '' : `folder ${clean(lane.folderState)}`;
  return ['lane', clean(lane.branch), agent, `+${plural(lane.commits, 'commit')}`, changes, laneVerdict(lane), folder].filter((part) => part !== '').join(' ');
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

/**
 * The step for test branches tess left with commits and no plan piece or live agent on them: land the ones it passed, give a
 * failing repro a `Fix:` piece. Null when there is none.
 */
function testsStep({ tests, repo }) {
  const left = tests.filter((test) => test.commits > 0 && test.piece === null && (test.agent === null || test.agent.state === 'done'));
  if (left.length === 0) return null;
  const branch = left.length === 1 ? shellWord(clean(left[0].branch)) : '<branch>';
  const names = firstOf(left.map((test) => clean(test.branch)), NAMED_TESTS);
  return `test branches ${names}: land each one tess passed (land ${branch} --repo ${shellWord(clean(repo))}), a failing repro gets a Fix: piece on its branch`;
}

function queueLine(queue) {
  if (queue.length === 0) return 'queue empty';
  const state = (piece) => {
    if (piece.isStartable) return 'startable';
    return piece.after.length > 0 ? `after ${piece.after.join(', ')}` : `overlaps ${piece.overlaps.map(clean).join(', ')}`;
  };
  return `queue ${queue.map((piece) => `${piece.id} ${state(piece)}`).join(' | ')}`;
}

/**
 * The `next:` line: land one lane, claim pieces while fewer than MAX_DEV lanes run, land the test branches left, start tess when
 * due with the mark command at main's sha (gate R5); never main while it fails.
 */
function nextLine(tick) {
  const { main, lanes, overlaps, strays, queue, plan, tessRunning } = tick;
  const count = `dev ${lanes.length}/${MAX_DEV}, tess ${tessRunning}/${MAX_TESS}`;
  if (main.findings.length > 0) return `next: fix main first (node ~/.claude/tools/git-tidy/git-tidy.mjs check ${clean(tick.repo)}), start no new piece; ${count}`;
  const flagged = new Set([...overlaps.flatMap((pair) => [pair.first, pair.second]), ...strays.map((stray) => stray.branch)]);
  const ready = lanes.filter((lane) => lane.isReady);
  const land = ready.find((lane) => !flagged.has(lane.branch) && !lane.mainMoved) ?? ready.find((lane) => !flagged.has(lane.branch)) ?? ready[0];
  const steps = [];
  if (land !== undefined) steps.push(`land ${clean(land.branch)}${flagged.has(land.branch) ? ' --test "<suite>" (after the other one)' : ''}`);
  const claimText = (piece) => `claim ${piece.id}${piece.branch === null ? '' : ` (branch ${clean(piece.branch)})`}`;
  queue.filter((piece) => piece.isStartable).slice(0, Math.max(0, MAX_DEV - lanes.length)).forEach((piece) => steps.push(claimText(piece)));
  const testsNext = testsStep(tick);
  if (testsNext !== null) steps.push(testsNext);
  if (plan !== null && plan.tess.reason !== null && tessRunning < MAX_TESS) {
    const ids = plan.tess.features.slice(0, MAX_TESS - tessRunning).map((feature) => feature.id).join(', ');
    steps.push(`tess on ${ids} (mark each: --mark-tess <feature> --sha ${main.sha} with this --repo and --plan)`);
  }
  return `next: ${[...steps, count].join('; ')}`;
}

/**
 * The tick as plain lines (about 20 for 3 lanes and 12 pieces).
 * @param {object} tick tick.mjs tickFacts's result
 * @returns {string[]} the lines in print order, `next:` last
 */
export function tickLines(tick) {
  return [
    mainLine(tick),
    ...[tidyLine(tick)].filter((line) => line !== null),
    foldersLine(tick.folders),
    ...tick.lanes.map(laneLine),
    ...[testsLine(tick.tests)].filter((line) => line !== null),
    ...tick.overlaps.map((pair) => `overlap ${clean(pair.first)} x ${clean(pair.second)}: ${filesText(pair.files)}`),
    ...tick.strays.map((stray) => `stray ${clean(stray.branch)}: ${filesText(stray.files)} (not in its files)`),
    ...(tick.plan === null ? [] : [queueLine(tick.queue), featuresLine(tick.plan), ...commitsLines(tick.plan)]),
    ...(tick.ledgerSkipped > 0 ? [`ledger ${plural(tick.ledgerSkipped, 'bad line')} skipped`] : []),
    ...(tick.ledgerUnreadable === null ? [] : [`ledger unreadable (${clean(tick.ledgerUnreadable)}): no piece counts as landed`]),
    nextLine(tick),
  ];
}
