// The one estimate function, model s1 (estimate-spec sections 4-7, R15): reads a STATUS.md, measures working time from the
// transcripts, keeps the current job's rows (R15), forecasts them as runs on slots (slots.mjs), takes the pick for the current step
// (throughput.mjs), the pauses with their reasons (pauses.mjs) and the job's one promise (commitment.mjs promiseOf). Used by
// estimate.mjs (the CLI) and statusline-cache.mjs (the status line), so both show the same numbers for the same table state.
// Exports: UsageError, estimateFile(path, options) -> { result, inputs }; for backtest.mjs's c3 replay referenceRows(items, costs),
// storedJob(job), forecastSeedText(id, openRows), slowRowOf(openRows, pool).
// The finish result keeps the fields report.mjs and segment-text.mjs read (finish, commit, work, covers, road, progress, numbers),
// filled from s1: the shown clock is the job's likely time, its 80% time stands in the 85% and 95% places until the text is
// rewritten for s1; `numbers.v2` holds the s1 numbers (job-rows.mjs jobNumbers). The c3 forecast (forecast.mjs forecastWork)
// is no longer run here: backtest.mjs alone replays it.
// Invariants: the table file's lock is taken only for the quick read-change-write (store rows, step records, promise, log), never
// around the scan or the simulation; a busy lock means this run shows what it computed from the state it read and records nothing.
// A run never links a session to the table (status.mjs edits do); a scratch STATUS.md (table-store.mjs) is not stored. Without a
// stateDir nothing is read from or written to the store. Only a recorded CLI run at the real clock makes the promise (R9).
// Transcripts are never printed. Work is in minutes; `now` is floored to the minute so the CLI and the status line agree.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isSessionId } from '../../../hooks/lib/session-store.mjs';
import { activeRuns } from './activity.mjs';
import { finishResult, forecastSeedText, runMinOf, settle } from './finish-result.mjs';
import { nearestRank, referencePool } from './forecast.mjs';
import { INSTANT_FORMAT, parseInstant, parseWorkItems } from './items.mjs';
import { jobInputs } from './job-inputs.mjs';
import { jobScope } from './job-rows.mjs';
import { AGENT_KINDS, MAX_RUN_MIN, MIN_RUN_MIN, kindOf, kindPools, rowState } from './kinds.mjs';
import { progressOf } from './progress.mjs';
import { poolRuns, promiseRecord, scoredSteps } from './store-pools.mjs';
import { isScratchTable, noteTable, readAllTables, readSeed, readSeedRuns, tableId } from './table-store.mjs';
import { handedOverJobs, rowCosts, workingIntervals } from './worked.mjs';

export { forecastSeedText };

const MS_PER_MIN = 60_000;
const DROPPED = /^\s*dropped:/i;
/** A wrong input (file, cell, flag or folder): the CLI prints its message and exits 2. `problems` = the table problems ({line, reason, id?}), empty for other inputs. */
export class UsageError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.problems = problems;
  }
}

const isWorkRow = (item) => item.kind !== 'deliver';
const iso = (ms) => new Date(ms).toISOString();

/** Done work rows with a c3 cost, as backtest.mjs's c3 pool stores them; a row closed as dropped is no observation. */
export const referenceRows = (items, costs) => items
  .filter((item) => isWorkRow(item) && item.done !== null && (costs.get(item.id) ?? 0) > 0 && !DROPPED.test(item.evidence ?? ''))
  .map((item) => ({ size: item.size, kind: item.kind, done: iso(item.done), cost: costs.get(item.id) }));

/** A handed-over job as the table file and the seed store it (no ids). */
export const storedJob = (job) => ({ at: iso(job.at), minutes: job.minutes, growthNum: job.growthNum, growthDen: job.growthDen });

/** A running row is slow above this share of its class (c3, design 3.8). */
const SLOW_ROW_SHARE = 0.85;
/** c3 (backtest.mjs): a running row whose elapsed share is above its class p85, for a move's cause; null when none is. */
export const slowRowOf = (openRows, pool) => openRows.find((row) => row.elapsed > 0 && row.elapsed > nearestRank(pool.costs[row.size], SLOW_ROW_SHARE))?.id ?? null;

/**
 * The table's rows as the store keeps them (section 9): every done work row not dropped, with its c3 cost (0 when it has none;
 * a rolled-back c3 pools only rows with a cost) and its s1 kind and run minutes; a run outside 1..240 feeds no pool (kindPools).
 */
const storeRows = (items, costs, intervals) => items
  .filter((item) => isWorkRow(item) && item.done !== null && !DROPPED.test(item.evidence ?? ''))
  .map((item) => ({ size: item.size, kind: item.kind, done: iso(item.done), cost: costs.get(item.id) ?? 0, k: kindOf(item), runMin: runMinOf(item, intervals) }));

function readStatus(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${error.message}`);
  }
}

function parsedTable(path, nowMs) {
  const { items, problems } = parseWorkItems(readStatus(path), nowMs);
  if (problems.length > 0) throw new UsageError(problems.map((problem) => `${path}:${problem.line}: ${problem.reason}`).join('\n'), problems);
  return items;
}

const addedTimes = (added = {}) => new Map(Object.entries(added).map(([id, at]) => [id, Date.parse(at)]));
const isRun = (run) => run >= MIN_RUN_MIN && run <= MAX_RUN_MIN;

/** The facts every state needs: working time, the store's rows and jobs, the kind pools, the margin and the last hand-over. */
function measure(statusPath, items, options) {
  const { nowMin, stateDir, projectsDir, sessionId } = options;
  const id = tableId(statusPath);
  const tables = stateDir === null ? [] : readAllTables(stateDir);
  const stored = tables.find((table) => table.id === id) ?? null;
  const sessions = [...new Set([...(stored?.sessions ?? []), ...(isSessionId(sessionId) ? [sessionId] : [])])];
  const runs = activeRuns(sessions, { projectsDir, stateDir });
  const intervals = workingIntervals(runs, nowMin);
  const costs = rowCosts(items, intervals);
  const jobs = handedOverJobs(items, costs, intervals, addedTimes(stored?.added));
  const own = { id, rows: storeRows(items, costs, intervals), jobs: jobs.map(storedJob) };
  const others = tables.filter((table) => table.id !== id);
  const pooled = poolRuns([...others, own], readSeedRuns(options.seedRunsFile));
  // The growth of past jobs (the `Not listed yet` line, H3) still comes from the size pool's jobs: s1 adds no growth model.
  const sizePool = referencePool([...others, { id, rows: own.rows.filter((row) => row.cost > 0), jobs: own.jobs }], readSeed(options.seedFile));
  const handOvers = items.filter((item) => item.kind === 'deliver' && item.done !== null).map((item) => item.done).sort((a, b) => a - b);
  return {
    id, stored, sessions, runs, intervals, jobs, own, pools: kindPools(pooled), runCount: pooled.filter((run) => AGENT_KINDS.includes(run.k) && isRun(run.runMin)).length,
    growth: sizePool.growth, jobCount: sizePool.jobCount, scored: scoredSteps(tables), lastHandOver: handOvers.at(-1) ?? null,
  };
}

const poolCounts = (facts) => ({ rows: facts.runCount, jobs: facts.jobCount });

/** No work row at all: the one refusal left in model s1 (the size minimum and the horizon are retired, spec section 9). */
function noTimeResult(items, facts, options) {
  const { table, recorded } = settle(options.statusPath, items, facts, options, (base) => base);
  return { result: { state: 'refused', nowMs: options.nowMin * MS_PER_MIN, refusal: { reason: 'no-rows' }, checks: [], progress: null, numbers: null, record: promiseRecord(table.log) }, recorded };
}

/** No open row in the job: handed over when the last hand-over is at or after every done time, else all done (queued roads named). */
function closedResult(items, scope, facts, options) {
  const done = scope.items.filter((item) => item.done !== null);
  let lastDone = null;
  for (const item of done) if (lastDone === null || item.done > lastDone) lastDone = item.done;
  const nowMs = options.nowMin * MS_PER_MIN;
  const checks = scope.queued.map(({ road, rows }) => ({ kind: 'queued', road, rows }));
  const { table, recorded } = settle(options.statusPath, items, facts, options, (base) => ({ ...base, promise: null }));
  if (facts.lastHandOver !== null && (lastDone === null || facts.lastHandOver >= lastDone)) {
    const job = facts.jobs.at(-1);
    return { result: { state: 'handed-over', nowMs, handedOverMs: facts.lastHandOver, rows: job?.ids.length ?? 0, workedMin: job?.minutes ?? 0, progress: null, checks, record: promiseRecord(table.log), pool: poolCounts(facts) }, recorded };
  }
  const rows = done.filter((item) => rowState(item) === 'done').map((item) => ({ size: item.size, done: true, elapsedMin: 0 }));
  const progress = progressOf({ workedMin: 0, p50LeftMin: null, committedLeftMin: null, rows, pool: { medians: {} }, moved: false, rowsAdded: false });
  return { result: { state: 'all-done', nowMs, rows: rows.length, progress, checks }, recorded };
}

/**
 * Estimates one STATUS.md with model s1 (see the header).
 * @param {string} path the STATUS.md
 * @param {{ now?: string, stateDir?: string | null, projectsDir?: string, sessionId?: string, record?: boolean, seedFile?: string,
 *   seedRunsFile?: string, cli?: boolean, account?: string, limitsDir?: string, env?: object }} [options]
 *   now: ISO instant (default the clock); stateDir: the store root (null: no store read or written); projectsDir: Claude Code's
 *   projects folder (default ~/.claude/projects); sessionId: a session whose transcripts count for this run (never linked) and
 *   whose subagents are matched to rows; record: write first-seen times, rows, step records, the promise and the log; seedFile
 *   and seedRunsFile: the seeds (defaults beside the tool, for tests); cli: this is the CLI's run (only a recorded CLI run at the
 *   real clock makes the promise); account: the job's account for usage-limit pauses (default CLAUDE_ACCOUNT); limitsDir: its
 *   limits folder (default ~/.claude/state/limits); env: for the asking marker and the writers' launch records (default process.env)
 * @returns {{ result: object, inputs: { path: string, sessions: number, recorded: boolean, busy: boolean } }} busy: recording was
 *   asked but the table file stayed locked, so nothing was recorded; recorded is also true for a scratch table
 * @throws {UsageError} when the file, a table cell or `now` cannot be used (problems carry the table's problem lines)
 */
export function estimateFile(path, { now, stateDir = null, projectsDir = join(homedir(), '.claude', 'projects'), sessionId, record = false, seedFile, seedRunsFile, cli = false, account = process.env.CLAUDE_ACCOUNT, limitsDir, env = process.env } = {}) {
  const nowMs = now === undefined ? Date.now() : parseInstant(now);
  if (nowMs === null) throw new UsageError(`--now "${now}" is not a real ISO 8601 instant; accepted: ${INSTANT_FORMAT}`);
  const statusPath = resolve(path);
  const items = parsedTable(statusPath, nowMs);
  const scratch = record && stateDir !== null && isScratchTable(stateDir, statusPath);
  const recording = record && stateDir !== null && !scratch;
  // First-seen times only: a run never links a session (only status.mjs edits do), so another session's refresh neither counts its
  // transcripts for this table for good nor points its Stop hook here (audit SF1, option a).
  if (recording) noteTable(stateDir, statusPath, { sessionId: undefined, ids: items.map((item) => item.id), nowMs });
  const nowMin = Math.floor(nowMs / MS_PER_MIN);
  const options = { statusPath, nowMin, stateDir, projectsDir, sessionId, record: recording, seedFile, seedRunsFile, cli, realClock: now === undefined, account, limitsDir, env };
  const facts = { ...measure(statusPath, items, options), nowMs: nowMin * MS_PER_MIN };
  const scope = jobScope(items, facts.lastHandOver);
  const run = () => {
    if (!items.some(isWorkRow)) return noTimeResult(items, facts, options);
    if (!scope.items.some((item) => ['open', 'waiting'].includes(rowState(item)))) return closedResult(items, scope, facts, options);
    // A scratch table keeps nothing in the owner's store: its transcript cursors are not kept either (every run reads whole).
    const inputs = jobInputs({ items: scope.items, sessions: facts.sessions, sessionId: isSessionId(sessionId) ? sessionId : undefined, projectsDir, stateDir: scratch ? null : stateDir, account, limitsDir, env, nowMs: facts.nowMs, realClock: options.realClock });
    return finishResult(items, scope, { ...facts, ...inputs }, options);
  };
  const { result, recorded } = run();
  return { result, inputs: { path: statusPath, sessions: facts.sessions.length, recorded: recorded || scratch, busy: recording && !recorded } };
}
