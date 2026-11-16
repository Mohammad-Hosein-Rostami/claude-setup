#!/usr/bin/env node
// Backtest of the finish estimator on handed-over jobs: replays each job at 20-minute steps with the tool's own functions and checks
// the numbers against the thresholds the estimator design set (section 8.3). Also writes the repo seed.
// Usage: backtest.mjs --job <STATUS.md>=<session-id> ... [--now <iso>] [--write-seed <file>] [--projects <dir>] [--state-dir <dir>]
//        --job         a table and the session whose transcripts give its working time (repeat for every table)
//        --now         the cut: activity after it is ignored (default: the clock)
//        --write-seed  also write the finished rows and jobs of every table (table hash, size, kind, done, cost; no ids, no text)
//        --projects    Claude Code's projects folder (default ~/.claude/projects)
//        --state-dir   the estimate state root whose activity index is used and updated (default ~/.claude/state/estimate)
// Replay (design 8.2): for every handed-over job, from 10 minutes after its start (not before the previous hand-over) in 20-minute
// steps until the hand-over, the rows listed are the job's rows added by then (a `close:` row at its start, any other row at the
// job's start) and not done; the pool is the other tables' rows and jobs plus this table's rows done by then (costs split among
// rows done by then) and its jobs handed over by then; no seed, no store, widening 1. The hold rule runs along each job. A table
// with open rows at --now also gets its state and work left from the same pool. Leave-one-table-out, not a walk through time.
// Exit codes: 0 every threshold passes (or there is no handed-over job); 1 a threshold fails; 2 usage or table problem.
// Invariants: writes nothing but the activity index and, when asked, the seed file; prints no row text or transcript content.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { activeRuns } from './lib/activity.mjs';
import { nextCommitment } from './lib/commitment.mjs';
import { forecastWork, nearestRank, referencePool, refusalOf } from './lib/forecast.mjs';
import { UsageError } from './lib/from-files.mjs';
import { parseInstant, parseWorkItems } from './lib/items.mjs';
import { stateDir, tableId } from './lib/table-store.mjs';
import { elapsedShares, handedOverJobs, rowCosts, workedMinutes, workingIntervals } from './lib/worked.mjs';

const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const MS_PER_MIN = 60_000;
const MIN_PER_HOUR = 60;
const FIRST_INSTANT_MIN = 10; // the first forecast of a job is 10 minutes after its start
const STEP_MIN = 20; // then one every 20 minutes until the hand-over
const SLOW_ROW_SHARE = 0.85; // a running row past its class p85 is a move's cause
const NO_SEED = { rows: [], jobs: [] };
const DROPPED = /^dropped:/i;
// Design 8.3: measured on the four frozen tables (3 seeds) and the threshold each number must meet. One threshold differs from the
// design: instants with a time is >= 58, not >= 60. The design's checker had no 5-row minimum per size (MIN_CLASS_ROWS) and gave a
// time at 63 of 64; this code keeps the minimum, so with auth left out its open L rows (4 finished L rows elsewhere) get the honest
// "only 4 finished L rows" refusal at 5 instants. The lead chose the refusal over a guess and set the threshold to the measured 58.
const THRESHOLDS = [
  ['instants with a time', (s) => s.timed, (s) => `${s.timed} of ${s.instants}`, (v) => v >= 58, '>= 58'],
  ['hand-over within p85', (s) => s.within.p85 / s.timed, (s) => share(s.within.p85, s.timed), (v) => v >= 0.8 && v <= 0.95, '80-95 %'],
  ['within p95', (s) => s.within.p95 / s.timed, (s) => share(s.within.p95, s.timed), (v) => v >= 0.85, '>= 85 %'],
  ['within p50', (s) => s.within.p50 / s.timed, (s) => share(s.within.p50, s.timed), (v) => v >= 0.3 && v <= 0.65, '30-65 %'],
  ['median abs(actual - p50)', (s) => s.medianErrorMin, (s) => `${Math.round(s.medianErrorMin)} min`, (v) => v <= 45, '<= 45 min'],
  ['median p85 / actual', (s) => s.medianP85Ratio, (s) => s.medianP85Ratio.toFixed(2), (v) => v <= 1.8, '<= 1.8'],
  ['jobs with at least half their forecasts within p85', (s) => s.jobsMostlyWithin, (s) => `${s.jobsMostlyWithin} of ${s.jobs}`, (v) => v >= 9, '>= 9'],
  ['commitments', (s) => s.commitments, (s) => `${s.commitments} for ${s.jobs} jobs`, (v) => v <= 15, '<= 15'],
  ['jobs that kept their first commitment', (s) => s.jobsKeptFirst, (s) => String(s.jobsKeptFirst), (v) => v >= 7, '>= 7'],
  ['first commitments kept', (s) => s.firstKept, (s) => `${s.firstKept} of ${s.firsts}`, (v) => v >= 8, '>= 8'],
  ['horizon refusals', (s) => s.horizon, (s) => String(s.horizon), (v) => v === 0, '0'],
  ['pooled growth of the jobs', (s) => s.growth, (s) => s.growth.toFixed(3), (v) => v >= 0.39 && v <= 0.44, '0.39-0.44'],
];

const share = (count, of) => (of === 0 ? `${count} of 0` : `${count} of ${of} (${Math.round((100 * count) / of)} %)`);
const hours = (minutes) => (minutes / MIN_PER_HOUR).toFixed(2);
const iso = (ms) => new Date(ms).toISOString();
const median = (values) => (values.length === 0 ? Number.NaN : nearestRank([...values].sort((a, b) => a - b), 0.5)); // NaN fails every threshold
const isWorkRow = (item) => item.kind !== 'deliver';
const storedJob = (job) => ({ at: iso(job.at), minutes: job.minutes, growthNum: job.growthNum, growthDen: job.growthDen });

function readOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { job: { type: 'string', multiple: true }, now: { type: 'string' }, 'write-seed': { type: 'string' }, projects: { type: 'string' }, 'state-dir': { type: 'string' } } });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values } = parsed;
  if (!values.job?.length) throw new UsageError('usage: backtest.mjs --job <STATUS.md>=<session-id> ... [--now <iso>] [--write-seed <file>] [--projects <dir>] [--state-dir <dir>]');
  const nowMs = values.now === undefined ? Date.now() : parseInstant(values.now);
  if (nowMs === null) throw new UsageError(`--now "${values.now}" is not an ISO 8601 instant`);
  const jobs = values.job.map((spec) => {
    const at = spec.lastIndexOf('=');
    const sessionId = spec.slice(at + 1);
    if (at < 1 || !isSessionId(sessionId)) throw new UsageError(`--job "${spec}" is not <STATUS.md>=<session-id>`);
    return { statusPath: resolve(spec.slice(0, at)), sessionId };
  });
  return { jobs, nowMs, seedFile: values['write-seed'], projectsDir: values.projects ?? join(homedir(), '.claude', 'projects'), stateDir: values['state-dir'] ?? stateDir() };
}

/** Done work rows with a cost, as the pool stores them; a row closed as dropped is no observation. */
const referenceRows = (items, costs) => items
  .filter((item) => isWorkRow(item) && item.done !== null && (costs.get(item.id) ?? 0) > 0 && !DROPPED.test(item.evidence ?? ''))
  .map((item) => ({ size: item.size, kind: item.kind, done: iso(item.done), cost: costs.get(item.id) }));

function loadTable({ statusPath, sessionId }, options) {
  let text;
  try {
    text = readFileSync(statusPath, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${statusPath}: ${error.message}`);
  }
  const { items, problems } = parseWorkItems(text);
  if (problems.length > 0) throw new UsageError(`${statusPath}: line ${problems[0].line}: ${problems[0].reason}`);
  const runs = activeRuns([sessionId], options);
  const intervals = workingIntervals(runs, Math.floor(options.nowMs / MS_PER_MIN));
  const costs = rowCosts(items, intervals);
  const jobs = handedOverJobs(items, costs, intervals, new Map());
  return { name: basename(statusPath), id: tableId(statusPath), items, runs, intervals, costs, jobs, rows: referenceRows(items, costs) };
}

/** The table as it stood at tMs: stamps after it blanked, hand-overs after it gone. */
const tableAt = (items, tMs) => items
  .filter((item) => isWorkRow(item) || (item.done !== null && item.done <= tMs))
  .map((item) => ({ ...item, started: item.started !== null && item.started <= tMs ? item.started : null, done: item.done !== null && item.done <= tMs ? item.done : null }));

const othersOf = (table, tables) => tables.filter((other) => other !== table).map((other) => ({ id: other.id, rows: other.rows, jobs: other.jobs.map(storedJob) }));
const seedText = (id, openRows) => `${id}|${openRows.map((row) => row.id).sort().join(',')}`;

/** A running row whose elapsed share is above its class p85, for a move's cause. */
const slowRowOf = (openRows, pool) => openRows.find((row) => row.elapsed > 0 && row.elapsed > nearestRank(pool.costs[row.size], SLOW_ROW_SHARE))?.id ?? null;

function forecastAt(table, others, job, tMs) {
  const tMin = tMs / MS_PER_MIN;
  const rows = table.items.filter((item) => job.ids.includes(item.id));
  const jobStart = Math.min(...rows.map((item) => item.started));
  const listed = rows.filter((item) => (item.kind === 'close' ? item.started : jobStart) <= tMs && !(item.done <= tMs));
  if (listed.length === 0) return null;
  const view = tableAt(table.items, tMs);
  const intervalsAt = workingIntervals(table.runs, tMin);
  const own = { id: table.id, rows: referenceRows(view, rowCosts(view, intervalsAt)), jobs: table.jobs.filter((done) => done.at <= tMs).map(storedJob) };
  const pool = referencePool([...others, own], NO_SEED);
  const { elapsed } = elapsedShares(view, intervalsAt, tMin);
  const openRows = listed.map((item) => ({ id: item.id, size: item.size, elapsed: elapsed.get(item.id) ?? 0 }));
  const work = forecastWork(openRows, pool, seedText(table.id, openRows));
  const actual = workedMinutes(table.intervals, tMin, job.at / MS_PER_MIN);
  return { tMin, intervalsAt, openRows, pool, work, refusal: refusalOf(openRows, pool, work), actual };
}

/** Applies the hold rule to one instant; returns the commitment and, when a time was committed, whether it held the hand-over. */
function commitAt(commit, forecast) {
  const { p50, p85, p95 } = forecast.work;
  const fresh = { p50, raw85: p85, p85, p95, g: forecast.pool.growth, kappa: 1 };
  const leftMin = commit === null ? null : commit.budgetMin - workedMinutes(forecast.intervalsAt, Date.parse(commit.at) / MS_PER_MIN, forecast.tMin);
  const context = { nowMin: forecast.tMin, openIds: forecast.openRows.map((row) => row.id), slowRowId: slowRowOf(forecast.openRows, forecast.pool) };
  const next = nextCommitment(commit, fresh, leftMin, context);
  return { commit: next.commit, made: next.entry === null ? null : { first: next.entry.first, met: forecast.actual <= p85 } };
}

function replayJob(table, others, job, previousAt) {
  const instants = [];
  const commitments = [];
  const jobStart = Math.min(...table.items.filter((item) => job.ids.includes(item.id)).map((item) => item.started));
  let commit = null;
  for (let tMs = Math.max(jobStart, previousAt) + FIRST_INSTANT_MIN * MS_PER_MIN; tMs < job.at; tMs += STEP_MIN * MS_PER_MIN) {
    const forecast = forecastAt(table, others, job, tMs);
    instants.push({ forecast, table: table.name });
    if (forecast === null || forecast.refusal !== null) continue;
    const step = commitAt(commit, forecast);
    commit = step.commit;
    if (step.made !== null) commitments.push(step.made);
  }
  return { instants, commitments };
}

function replayAll(tables) {
  return tables.flatMap((table) => {
    const others = othersOf(table, tables);
    return table.jobs.map((job, k) => ({ table: table.name, ...replayJob(table, others, job, k === 0 ? -Infinity : table.jobs[k - 1].at) }));
  });
}

function summarize(replays, tables) {
  const instants = replays.flatMap((replay) => replay.instants);
  const timed = instants.map((instant) => instant.forecast).filter((forecast) => forecast?.refusal === null && forecast.work !== null);
  const within = (forecasts, name) => forecasts.filter((forecast) => forecast.actual <= forecast.work[name]).length;
  const commitments = replays.flatMap((replay) => replay.commitments);
  const allJobs = tables.flatMap((table) => table.jobs);
  return {
    instants: instants.length,
    timed: timed.length,
    within: { p50: within(timed, 'p50'), p85: within(timed, 'p85'), p95: within(timed, 'p95') },
    medianErrorMin: median(timed.map((forecast) => Math.abs(forecast.actual - forecast.work.p50))),
    medianP85Ratio: median(timed.map((forecast) => forecast.work.p85 / forecast.actual)),
    jobs: replays.length,
    jobsMostlyWithin: replays.filter((replay) => {
      const own = replay.instants.map((instant) => instant.forecast).filter((forecast) => timed.includes(forecast));
      return own.length > 0 && within(own, 'p85') >= own.length / 2;
    }).length,
    commitments: commitments.length,
    jobsKeptFirst: replays.filter((replay) => replay.commitments.length === 1).length,
    firsts: commitments.filter((made) => made.first).length,
    firstKept: commitments.filter((made) => made.first && made.met).length,
    horizon: instants.filter((instant) => instant.forecast?.refusal?.reason === 'horizon').length,
    growth: allJobs.reduce((sum, job) => sum + job.growthNum, 0) / allJobs.reduce((sum, job) => sum + job.growthDen, 0),
    perTable: [...new Set(replays.map((replay) => replay.table))].map((name) => {
      const own = instants.filter((instant) => instant.table === name).map((instant) => instant.forecast).filter((forecast) => timed.includes(forecast));
      return `${name} ${within(own, 'p85')}/${own.length}`;
    }),
  };
}

function scannerLines(tables) {
  const lines = tables.map((table) => {
    const stamps = table.items.flatMap((item) => [item.started, item.done]).filter((stamp) => stamp !== null).map((stamp) => stamp / MS_PER_MIN);
    const span = stamps.length === 0 ? 0 : workedMinutes(table.intervals, Math.min(...stamps), Math.max(...stamps));
    const done = table.items.filter((item) => isWorkRow(item) && item.done !== null).length;
    const jobs = table.jobs.map((job) => `${job.ids.length}, ${hours(job.minutes)}`).join('; ') || 'none';
    return `  ${table.name}: working time first to last stamp ${hours(span)} h; ${done} done work rows, ${table.rows.length} with a cost; jobs (rows, hours): ${jobs}`;
  });
  return ['Scanner and costs:', ...lines, `  rows with a cost: ${tables.reduce((sum, table) => sum + table.rows.length, 0)}`];
}

function thresholdLines(summary) {
  const rows = THRESHOLDS.map(([name, valueOf, textOf, passes, threshold]) => ({ line: `| ${name} | ${textOf(summary)} | ${threshold} | ${passes(valueOf(summary)) ? 'PASS' : 'FAIL'} |`, failed: !passes(valueOf(summary)) }));
  const lines = ['| Number | Value | Threshold | Result |', '| ------ | ----- | --------- | ------ |', ...rows.map((row) => row.line), `p85 kept per table: ${summary.perTable.join(', ')}`];
  return { lines, failed: rows.some((row) => row.failed) };
}

/** State and work left of every table with open rows at now, from the same pool. */
function openTableLines(tables, nowMs) {
  return tables.filter((table) => table.items.some((item) => isWorkRow(item) && item.done === null)).map((table) => {
    const own = { id: table.id, rows: table.rows, jobs: table.jobs.map(storedJob) };
    const pool = referencePool([...othersOf(table, tables), own], NO_SEED);
    const { elapsed } = elapsedShares(table.items, table.intervals, Math.floor(nowMs / MS_PER_MIN));
    const openRows = table.items.filter((item) => isWorkRow(item) && item.done === null).map((item) => ({ id: item.id, size: item.size, elapsed: elapsed.get(item.id) }));
    const work = forecastWork(openRows, pool, seedText(table.id, openRows));
    const state = refusalOf(openRows, pool, work)?.reason ?? 'finish';
    const left = work === null ? '' : `; work left p50 ${hours(work.p50)} h, p85 ${hours(work.p85)} h, p95 ${hours(work.p95)} h`;
    return `  ${table.name}: ${state}; ${openRows.length} open rows; growth ${pool.growth.toFixed(3)}${left}`;
  });
}

function writeSeed(file, tables) {
  const rows = tables.flatMap((table) => table.rows.map((row) => ({ table: table.id, ...row })));
  const jobs = tables.flatMap((table) => table.jobs.map((job) => ({ table: table.id, ...storedJob(job) })));
  const listed = (entries) => entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n');
  writeFileSync(file, `{\n  "v": 2,\n  "rows": [\n${listed(rows)}\n  ],\n  "jobs": [\n${listed(jobs)}\n  ]\n}\n`);
}

function main(argv) {
  const options = readOptions(argv);
  const tables = options.jobs.map((job) => loadTable(job, options));
  if (options.seedFile !== undefined) writeSeed(options.seedFile, tables);
  const replays = replayAll(tables);
  const out = [...scannerLines(tables)];
  let failed = false;
  if (replays.length === 0) out.push('No handed-over job: nothing to replay.');
  else {
    const summary = summarize(replays, tables);
    const checked = thresholdLines(summary);
    failed = checked.failed;
    out.push(`Replay: ${summary.instants} instants over ${summary.jobs} handed-over jobs, as of ${iso(options.nowMs)}`, ...checked.lines);
  }
  const open = openTableLines(tables, options.nowMs);
  if (open.length > 0) out.push('Tables with open rows at now:', ...open);
  process.stdout.write(`${out.join('\n')}\n`);
  return failed ? EXIT_FAIL : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`backtest: ${error.message}\n`);
  process.exitCode = EXIT_USAGE;
}
