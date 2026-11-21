// The one estimate function: reads a STATUS.md, measures working time from the transcripts, builds the
// reference pool, forecasts the work left and keeps the job's one committed time. Used by estimate.mjs (the CLI) and by
// statusline-cache.mjs (the status line), so both show the same time for the same table state.
// Exports: UsageError, estimateFile(path, options) -> { result, inputs } (finish, refused and all-done results carry `progress`, see
// progress.mjs, and `numbers` for the status line cache, see job-rows.mjs); referenceRows(items, costs), storedJob(job),
// forecastSeedText(id, openRows), slowRowOf(openRows, pool) (shared with backtest.mjs, so the replay uses the tool's own steps).
// Invariants: the table file's lock is taken only for the quick read-change-write of the commitment (estimator design 3.8), never
// around the scan or the simulation; a busy lock means this run shows what it computed from the state it read and records nothing.
// A run never links a session to the table (table.sessions and the session link are written by status.mjs edits only); the given
// session's transcripts count for this run alone.
// Without a stateDir nothing is read from or written to the store. Transcripts are never printed. Work is in minutes; `now` is
// floored to the minute so that the CLI and the status line, run in the same minute, agree. Rows carried over the last hand-over
// (job-rows.mjs) are left out of every count and named in a Check line.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isSessionId } from '../../../hooks/lib/session-store.mjs';
import { activeRuns } from './activity.mjs';
import { band, nextCommitment, scoreLog, trackRecord, widening } from './commitment.mjs';
import { forecastWork, nearestRank, referencePool, refusalOf } from './forecast.mjs';
import { INSTANT_FORMAT, parseInstant, parseWorkItems } from './items.mjs';
import { carriedIds, jobNumbers } from './job-rows.mjs';
import { classMedians, progressOf } from './progress.mjs';
import { noteTable, readAllTables, readSeed, tableId, updateTable } from './table-store.mjs';
import { elapsedShares, handedOverJobs, rowCosts, workedMinutes, workingIntervals } from './worked.mjs';

const MS_PER_MIN = 60_000;
/** A running row whose elapsed share is above this share of its class is a move's cause (design 3.8). */
const SLOW_ROW_SHARE = 0.85;
/** Log entries kept per table: the old calibration log's cap, enough for 200 jobs' first commitments. */
const MAX_LOG_ENTRIES = 200;
/** Working minutes of the current job with no started row before a Check line asks for starts: 2-3 % of the measured working time was untracked (design 3.2, 3.10). */
const UNTRACKED_CHECK_MIN = 30;
const DROPPED = /^dropped:/i;
/** A wrong input (file, cell, flag or folder): the CLI prints its message and exits 2. `problems` = the table problems ({line, reason, id?}), empty for other inputs. */
export class UsageError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.problems = problems;
  }
}

const isWorkRow = (item) => item.kind !== 'deliver';
const iso = (ms) => new Date(ms).toISOString();
const minuteOf = (isoText) => Date.parse(isoText) / MS_PER_MIN;

/** Done work rows with a cost, as the pool stores them; a row closed as dropped is no observation (design 3.2). */
export const referenceRows = (items, costs) => items
  .filter((item) => isWorkRow(item) && item.done !== null && (costs.get(item.id) ?? 0) > 0 && !DROPPED.test(item.evidence ?? ''))
  .map((item) => ({ size: item.size, kind: item.kind, done: iso(item.done), cost: costs.get(item.id) }));

/** A handed-over job as the table file and the seed store it (no ids). */
export const storedJob = (job) => ({ at: iso(job.at), minutes: job.minutes, growthNum: job.growthNum, growthDen: job.growthDen });

/** The forecast's seed text: the table and its open ids, so the same table state draws the same runs everywhere (design 3.6). */
export const forecastSeedText = (id, openRows) => `${id}|${openRows.map((row) => row.id).sort().join(',')}`;

/** A running row whose elapsed share is above its class p85, for a move's cause; null when none is. */
export const slowRowOf = (openRows, pool) => openRows.find((row) => row.elapsed > 0 && row.elapsed > nearestRank(pool.costs[row.size], SLOW_ROW_SHARE))?.id ?? null;

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
const capped = (log) => log.slice(-MAX_LOG_ENTRIES);

/** The facts every state needs: rows, working time, costs, jobs, the pool and the stored table (null without one). */
function measure(statusPath, items, options) {
  const { nowMin, stateDir, projectsDir, sessionId } = options;
  const id = tableId(statusPath);
  const tables = stateDir === null ? [] : readAllTables(stateDir);
  const stored = tables.find((table) => table.id === id) ?? null;
  const sessions = [...new Set([...(stored?.sessions ?? []), ...(isSessionId(sessionId) ? [sessionId] : [])])];
  const intervals = workingIntervals(activeRuns(sessions, { projectsDir, stateDir }), nowMin);
  const costs = rowCosts(items, intervals);
  const jobs = handedOverJobs(items, costs, intervals, addedTimes(stored?.added));
  const own = { id, rows: referenceRows(items, costs), jobs: jobs.map(storedJob) };
  const pool = referencePool([...tables.filter((table) => table.id !== id), own], readSeed(options.seedFile));
  const handOvers = items.filter((item) => item.kind === 'deliver' && item.done !== null).map((item) => item.done).sort((a, b) => a - b);
  return { id, stored, sessions, intervals, jobs, own, pool, lastHandOver: handOvers.at(-1) ?? null };
}

/**
 * The stored commitment when it belongs to the current job, else null. Both times are whole minutes, so a commitment in the hand-over's
 * minute is ambiguous: it is the new job's when it lists a row the hand-over did not close (the old job's rows were all done by then).
 */
function currentCommit(commit, lastHandOver, items) {
  if (!commit || lastHandOver === null) return commit ?? null;
  const atMs = Date.parse(commit.at);
  if (atMs !== lastHandOver) return atMs > lastHandOver ? commit : null;
  const doneOf = new Map(items.map((item) => [item.id, item.done]));
  return commit.ids.some((id) => doneOf.has(id) && (doneOf.get(id) === null || doneOf.get(id) > lastHandOver)) ? commit : null;
}

/** True when a work row of the current job (open, or done after the last hand-over) has a started stamp. */
const jobHasStarted = (items, lastHandOver) => items.some((item) => isWorkRow(item) && item.started !== null
  && (item.done === null || lastHandOver === null || item.done > lastHandOver));

/** The log with the entry of the replaced commitment (same time, a commitment entry) taken out. */
const withoutEntryOf = (log, commit) => log.filter((entry) => !(typeof entry.first === 'boolean' && entry.at === commit.at));

/** The current job (the work rows open or done after the last hand-over): its rows for progressOf, when it began (ISO, null before any start) and its working minutes, and now. */
function currentJob(items, facts, openRows, nowMin) {
  const elapsedOf = new Map(openRows.map((row) => [row.id, row.elapsed]));
  const rows = items.filter((item) => isWorkRow(item) && (item.done === null || facts.lastHandOver === null || item.done > facts.lastHandOver));
  const starts = rows.filter((item) => item.started !== null).map((item) => item.started);
  const startMs = starts.length > 0 ? Math.min(...starts) : null;
  return {
    rows: rows.map((item) => ({ id: item.id, size: item.size, done: item.done !== null, elapsedMin: elapsedOf.get(item.id) ?? 0, startedMs: item.started })),
    start: startMs === null ? null : iso(startMs),
    workedMin: startMs === null ? 0 : workedMinutes(facts.intervals, startMs / MS_PER_MIN, nowMin),
    nowMin,
  };
}

const NO_POOL = { medians: {} };
/**
 * This run's progress of the job. `commit` is the commitment shown (null on a refusal: it has no clock), `p50LeftMin` the forecast's
 * median (null: weights path).
 */
function progressStep(job, facts, { p50LeftMin, commit }) {
  const rowsAdded = commit !== null && (commit.moved?.cause === 'rows-added' || job.rows.some((row) => !row.done && !commit.ids.includes(row.id)));
  return progressOf({
    workedMin: job.workedMin,
    p50LeftMin,
    committedLeftMin: commit === null ? null : commit.budgetMin - workedMinutes(facts.intervals, minuteOf(commit.at), job.nowMin),
    rows: job.rows,
    pool: { medians: classMedians(facts.pool.costs) },
    moved: commit !== null && commit.moved !== null,
    rowsAdded,
  });
}

/** The Check line fact of the rows carried over the last hand-over, as a list (empty when none is). */
const carriedChecks = (facts) => (facts.carried.length === 0 ? [] : [{ kind: 'carried', ids: facts.carried }]);

/** Stale rows (run longer than every finished row of their size), longest first, as Check facts. */
function staleChecks(stale, openRows, pool) {
  return openRows.filter((row) => stale.includes(row.id))
    .map((row) => ({ kind: 'stale', id: row.id, size: row.size, elapsedMin: row.elapsed, longestMin: pool.costs[row.size].at(-1) }))
    .sort((a, b) => b.elapsedMin - a.elapsedMin);
}

/** The forecast of the open rows, widened by the stored log's kappa, with its refusal (null when a time can be given). */
function forecastOpen(items, facts, nowMin) {
  const { elapsed, untrackedMin } = elapsedShares(items, facts.intervals, nowMin);
  const openRows = items.filter((item) => isWorkRow(item) && item.done === null).map((item) => ({ id: item.id, size: item.size, elapsed: elapsed.get(item.id) ?? 0 }));
  const raw = forecastWork(openRows, facts.pool, forecastSeedText(facts.id, openRows));
  const kappa = widening(scoreLog(facts.stored?.log ?? [], items, facts.intervals));
  const work = raw === null ? null : { p50: raw.p50, raw85: raw.p85, p85: raw.p85 * kappa, p95: raw.p95 * kappa, g: facts.pool.growth, kappa };
  const checks = [...(raw === null ? [] : staleChecks(raw.stale, openRows, facts.pool)), ...(untrackedMin >= UNTRACKED_CHECK_MIN ? [{ kind: 'untracked', minutes: untrackedMin }] : []), ...carriedChecks(facts)];
  return { openRows, work, checks, refusal: refusalOf(openRows, facts.pool, work), job: currentJob(items, facts, openRows, nowMin) };
}

/** The table file after this run: fresh rows and jobs, the log scored, then the state's own change of the commitment and log. */
function changedTable(table, items, facts, change) {
  const base = { ...table, rows: facts.own.rows, jobs: facts.own.jobs, log: scoreLog(table.log, items, facts.intervals) };
  return change(base);
}

/** Runs change on the stored table under its lock when recording; else (or when the lock is busy) on the table as read. */
function settle(statusPath, items, facts, options, change) {
  const empty = { commit: null, log: [] };
  if (options.record) {
    const stored = updateTable(options.stateDir, statusPath, (table) => changedTable(table, items, facts, change));
    if (stored !== undefined) return { table: stored, recorded: true };
  }
  return { table: changedTable(facts.stored ?? empty, items, facts, change), recorded: false };
}

/** A refusal entry is logged only when its reason differs from the last entry's (design 3.9). */
function withRefusal(log, refusal, work, nowMin) {
  if (log.at(-1)?.refusal === refusal.reason) return log;
  return capped([...log, { at: iso(nowMin * MS_PER_MIN), refusal: refusal.reason, p50: work?.p50 ?? null, p85: work?.p85 ?? null }]);
}

/** The finish facts of a committed budget at now: the shown (median) clock, the 85% and 95% clocks and the pauses since it was made. */
function finishOf(commit, work, facts, nowMin) {
  const atMin = minuteOf(commit.at);
  const workedSince = workedMinutes(facts.intervals, atMin, nowMin);
  const leftMin = commit.budgetMin - workedSince;
  const clockMs = (nowMin + leftMin) * MS_PER_MIN;
  // The 85% and 95% clocks keep the committed median's offset, so they never read earlier than the shown clock.
  const p85Ms = clockMs + Math.max(0, work.p85 - work.p50) * MS_PER_MIN;
  const lateMs = clockMs + Math.max(0, work.p95 - work.p50) * MS_PER_MIN;
  const moved = commit.moved === null ? null : { atMs: Date.parse(commit.moved.at), wasClockMs: Date.parse(commit.moved.wasClock), cause: commit.moved.cause, ids: commit.moved.ids };
  return {
    finish: { clockMs, p85Ms, lateMs },
    commit: { atMs: Date.parse(commit.at), budgetMin: commit.budgetMin, leftMin, pausedMin: Math.max(0, nowMin - atMin - workedSince), moved },
  };
}

const sizeCounts = (openRows) => Object.fromEntries(['S', 'M', 'L'].map((size) => [size, openRows.filter((row) => row.size === size).length]));

function finishResult(items, facts, forecast, options) {
  const { nowMin } = options;
  const context = { nowMin, openIds: forecast.openRows.map((row) => row.id), slowRowId: slowRowOf(forecast.openRows, facts.pool) };
  const started = jobHasStarted(items, facts.lastHandOver);
  let progress = null; // set by change, which runs inside the lock when recording and may run again on the table as read
  const change = (table) => {
    const current = currentCommit(table.commit, facts.lastHandOver, items);
    // Before any row of the job has started, rows are still being listed: the first commitment is made again, not moved.
    const commit = started ? current : null;
    const log = current !== null && !started ? withoutEntryOf(table.log, current) : table.log;
    const leftMin = commit === null ? null : commit.budgetMin - workedMinutes(facts.intervals, minuteOf(commit.at), nowMin);
    const next = nextCommitment(commit, forecast.work, leftMin, context);
    progress = progressStep(forecast.job, facts, { p50LeftMin: forecast.work.p50, commit: next.commit });
    return { ...table, commit: next.commit, log: next.entry === null ? log : capped([...log, next.entry]) };
  };
  const { table, recorded } = settle(options.statusPath, items, facts, options, change);
  const sizeOf = new Map(items.map((item) => [item.id, item.size]));
  const shown = finishOf(table.commit, forecast.work, facts, nowMin);
  if (shown.commit.moved !== null) shown.commit.moved.size = sizeOf.get(shown.commit.moved.ids[0]) ?? null;
  const running = forecast.openRows.filter((row) => items.find((item) => item.id === row.id).started !== null).length;
  return {
    result: {
      state: 'finish', nowMs: nowMin * MS_PER_MIN, ...shown,
      covers: { open: forecast.openRows.length, running, sizes: sizeCounts(forecast.openRows), growth: facts.pool.growth },
      work: { p50: forecast.work.p50, p85: forecast.work.p85, p95: forecast.work.p95 }, progress,
      numbers: jobNumbers(forecast.job, classMedians(facts.pool.costs), { finishMs: shown.finish.clockMs, p85Ms: shown.finish.p85Ms, leftMin: shown.commit.leftMin }),
      band: band(table.log), record: trackRecord(table.log), pool: { rows: facts.pool.rowCount, jobs: facts.pool.jobCount }, checks: forecast.checks,
    },
    recorded,
  };
}

function refusedResult(items, facts, refusal, options, extra = {}) {
  let progress = null;
  const { table, recorded } = settle(options.statusPath, items, facts, options, (base) => {
    if (extra.job !== undefined) progress = progressStep(extra.job, facts, { p50LeftMin: null, commit: null });
    return { ...base, log: withRefusal(base.log, refusal, extra.work ?? null, options.nowMin) };
  });
  const numbers = extra.job === undefined ? null : jobNumbers(extra.job, classMedians(facts.pool.costs), { finishMs: null, leftMin: null });
  return { result: { state: 'refused', nowMs: options.nowMin * MS_PER_MIN, refusal, checks: extra.checks ?? carriedChecks(facts), progress, numbers, record: trackRecord(table.log) }, recorded };
}

/** No open row: handed over when the last hand-over is at or after every done time, else all done and not handed over yet. */
function closedResult(items, facts, options) {
  const work = items.filter(isWorkRow);
  const lastDone = Math.max(...work.map((item) => item.done));
  const nowMs = options.nowMin * MS_PER_MIN;
  if (facts.lastHandOver !== null && facts.lastHandOver >= lastDone) {
    const { table, recorded } = settle(options.statusPath, items, facts, options, (base) => ({ ...base, commit: null }));
    const job = facts.jobs.at(-1);
    return { result: { state: 'handed-over', nowMs, handedOverMs: facts.lastHandOver, rows: job?.ids.length ?? 0, workedMin: job?.minutes ?? 0, progress: null, checks: carriedChecks(facts), record: trackRecord(table.log), pool: { rows: facts.pool.rowCount, jobs: facts.pool.jobCount } }, recorded };
  }
  const { recorded } = settle(options.statusPath, items, facts, options, (base) => base);
  const rows = work.filter((item) => facts.lastHandOver === null || item.done > facts.lastHandOver).length;
  const { rows: jobRows } = currentJob(items, facts, [], options.nowMin);
  const progress = progressOf({ workedMin: 0, p50LeftMin: null, committedLeftMin: null, rows: jobRows, pool: NO_POOL, moved: false, rowsAdded: false });
  return { result: { state: 'all-done', nowMs, rows, progress, checks: carriedChecks(facts) }, recorded };
}

/**
 * Estimates one STATUS.md (estimator design section 3): parse, activity, costs, pool, state, commitment inside the lock, write.
 * @param {string} path the STATUS.md
 * @param {{ now?: string, stateDir?: string | null, projectsDir?: string, sessionId?: string, record?: boolean, seedFile?: string }} [options]
 *   now: ISO instant (default the clock); stateDir: the store root (null: no store read or written); projectsDir: Claude Code's
 *   projects folder (default ~/.claude/projects); sessionId: a session whose transcripts count for this run (never linked); record:
 *   write first-seen times, rows, jobs, commitment and log; seedFile: the seed (default seed.json beside the tool, for tests)
 * @returns {{ result: object, inputs: { path: string, sessions: number, recorded: boolean, busy: boolean } }} result as in design
 *   section 15; busy: recording was asked but the table file stayed locked, so nothing was recorded
 * @throws {UsageError} when the file, a table cell or `now` cannot be used (problems carry the table's problem lines)
 */
export function estimateFile(path, { now, stateDir = null, projectsDir = join(homedir(), '.claude', 'projects'), sessionId, record = false, seedFile } = {}) {
  const nowMs = now === undefined ? Date.now() : parseInstant(now);
  if (nowMs === null) throw new UsageError(`--now "${now}" is not a real ISO 8601 instant; accepted: ${INSTANT_FORMAT}`);
  const statusPath = resolve(path);
  const items = parsedTable(statusPath, nowMs);
  const recording = record && stateDir !== null;
  // First-seen times only: a run never links a session (only status.mjs edits do), so a refresh from another session in the
  // folder neither counts its transcripts for this table for good nor points its Stop hook here (audit SF1, option a).
  if (recording) noteTable(stateDir, statusPath, { sessionId: undefined, ids: items.map((item) => item.id), nowMs });
  const options = { statusPath, nowMin: Math.floor(nowMs / MS_PER_MIN), stateDir, projectsDir, sessionId, record: recording, seedFile };
  const measured = measure(statusPath, items, options);
  const facts = { ...measured, carried: carriedIds(items, measured.stored?.added ?? {}, measured.lastHandOver) };
  // A carried row does not count anywhere (forecast, progress, open check, commitment ids); the parse above still checked it.
  const counted = items.filter((item) => !facts.carried.includes(item.id));
  const run = () => {
    if (!counted.some(isWorkRow)) return refusedResult(counted, facts, { reason: 'no-rows' }, options);
    if (!counted.some((item) => isWorkRow(item) && item.done === null)) return closedResult(counted, facts, options);
    const forecast = forecastOpen(counted, facts, options.nowMin);
    if (forecast.refusal !== null) return refusedResult(counted, facts, forecast.refusal, options, forecast);
    return finishResult(counted, facts, forecast, options);
  };
  const { result, recorded } = run();
  return { result, inputs: { path: statusPath, sessions: facts.sessions.length, recorded, busy: recording && !recorded } };
}
