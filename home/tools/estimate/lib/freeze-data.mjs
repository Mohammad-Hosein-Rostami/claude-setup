// The anonymized frozen copy of real tables for the backtest of model s1 (estimate-spec sections 12-13), and the seed runs that
// boot its kind pools (R2) before the store holds any run.
// Exports: FROZEN_VERSION, SEED_RUNS_VERSION, MAX_FROZEN_BYTES, freezeTables(tables) -> { tables, sources, seedRows },
//   seedRunsWithout(seedRows, table), frozenTableText(table), seedRunsText(seedRows).
// A frozen table is { v, table: 't<n>', rows, active }: every row as { id, road, step, kind, c3Kind, size, state, firstSeenMin,
// startedMin, doneMin }, and the table's active minutes as [startMin, endMin) runs. Minutes count from the table's own first
// minute (the first time it saw a row), so no file holds a date, a time of day or a time zone (the repo is shared: wall-clock
// minutes would let a row be matched to a session transcript). The tables keep their order in time only by their index: t1 is
// the table that saw its first row first. `kind` is s1's (kinds.mjs kindOf), `c3Kind` the parser's (items.mjs: build, close,
// rework, deliver; the c3 replay reads it), `state` kinds.mjs rowState or `dropped` (a done row whose evidence starts
// `dropped:`: no run, no pool).
// Seed runs: one { t, k, runMin, doneMin } per done agent-kind row (not dropped) whose working minutes from start to done,
// clipped to the table's working intervals (worked.mjs, silences up to 10 min bridged), are 1..240 (R2, R14). `t` is its frozen
// table and `doneMin` its done offset in that table, so a pool can leave out a held-out table (seedRunsWithout) or a table the
// store already holds (the key in ../README.md "Backtest and seed"). Sorted by table, then done offset, kind and minutes.
// Invariants (share-safe, contract F1/F2): pure; no item, evidence or id text, no path, no session id and no clock time reaches
// the output. Ids are rewritten `r<i>.s<N>.<kind><n>` (roads numbered in table order) or `<kind><n>`, so a road named `s1` or
// `r22`, or an id holding `|`, never shows; every string the output holds is one of those ids, a table name, a kind, a size or
// a state. Same input, same bytes: the lead re-freezes fresh copies and compares sha256.
import { AGENT_KINDS, MAX_RUN_MIN, MIN_RUN_MIN, kindOf, rowState } from './kinds.mjs';
import { parseInstant } from './items.mjs';
import { roadStepOf } from './road-steps.mjs';
import { workedMinutes, workingIntervals } from './worked.mjs';

export const FROZEN_VERSION = 2;
export const SEED_RUNS_VERSION = 2;
/** 8 MiB per frozen file, for the writer here and the replay's reader: the largest real table (711 rows) freezes to about 125 KB. */
export const MAX_FROZEN_BYTES = 8 << 20;
const MS_PER_MIN = 60_000;
const DROPPED = /^\s*dropped:/i;

const floorMin = (ms) => Math.floor(ms / MS_PER_MIN);
const floorToMinuteMs = (ms) => floorMin(ms) * MS_PER_MIN;

/** The row's first-seen time (ms): the store's first sighting, else its first stamp; null when it has neither. */
function firstSeenMs(item, added) {
  const seenAt = Object.hasOwn(added, item.id) ? parseInstant(added[item.id]) : null;
  const seen = seenAt === null ? null : floorToMinuteMs(seenAt); // to its minute, as the tool reads it (job-rows.mjs carriedIds)
  const times = [seen, item.started, item.done].filter((ms) => ms !== null);
  return times.length === 0 ? null : Math.min(...times);
}

/** Every time a table holds (first-seen, started, done), in ms. */
const timesOf = (table) => table.items.flatMap((item) => [firstSeenMs(item, table.added), item.started, item.done]).filter((ms) => ms !== null);

/** The table's first minute (epoch), or null when it holds no time. */
function firstMinuteOf(table) {
  const times = timesOf(table);
  return times.length === 0 ? null : floorMin(Math.min(...times));
}

/** The rewritten id of each item, in table order: `r<i>.s<N>.<kind><n>` for a road row, `<kind><n>` for any other. */
function rewrittenIds(items) {
  const roads = new Map();
  const counts = new Map();
  return items.map((item) => {
    const at = roadStepOf(item.id);
    if (at !== null && !roads.has(at.road)) roads.set(at.road, `r${roads.size + 1}`);
    const head = at === null ? '' : `${roads.get(at.road)}.s${at.step}.`;
    const key = `${head}${kindOf(item)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { id: `${key}${counts.get(key)}`, road: at === null ? null : roads.get(at.road), step: at?.step ?? null };
  });
}

const stateOf = (item) => (item.done !== null && DROPPED.test(item.evidence ?? '') ? 'dropped' : rowState(item));

/** Active runs (epoch minutes) clipped to [fromMin, toMin) and moved to minutes from fromMin. */
const clippedRuns = (runs, fromMin, toMin) => runs
  .map(([start, end]) => [Math.max(start, fromMin), Math.min(end, toMin)])
  .filter(([start, end]) => start < end)
  .map(([start, end]) => [start - fromMin, end - fromMin]);

/** One frozen table named `name` (t<n>), every time an offset from its own first minute. */
function frozenTable(table, name) {
  const firstMin = firstMinuteOf(table);
  const offset = (ms) => (ms === null ? null : (ms - firstMin * MS_PER_MIN) / MS_PER_MIN);
  const ids = rewrittenIds(table.items);
  const rows = table.items.map((item, at) => ({
    ...ids[at],
    kind: kindOf(item),
    c3Kind: item.kind,
    size: item.size,
    state: stateOf(item),
    firstSeenMin: offset(firstSeenMs(item, table.added)),
    startedMin: offset(item.started),
    doneMin: offset(item.done),
  }));
  const active = firstMin === null ? [] : clippedRuns(table.runs, firstMin, Math.ceil(Math.max(...timesOf(table)) / MS_PER_MIN));
  return { v: FROZEN_VERSION, table: name, rows, active };
}

/** The table's seed runs (see the header): working minutes of each finished agent run, 1..240, with its table and done offset. */
function runsOf(frozen) {
  const endMin = Math.max(0, ...frozen.rows.flatMap((row) => [row.startedMin ?? 0, row.doneMin ?? 0]));
  const intervals = workingIntervals(frozen.active, endMin);
  return frozen.rows
    .filter((row) => row.state === 'done' && AGENT_KINDS.includes(row.kind) && row.startedMin !== null)
    .map((row) => ({ t: frozen.table, k: row.kind, runMin: workedMinutes(intervals, row.startedMin, row.doneMin), doneMin: row.doneMin }))
    .filter((run) => run.runMin >= MIN_RUN_MIN && run.runMin <= MAX_RUN_MIN);
}

const tableIndex = (name) => Number(name.slice(1));
const bySeedOrder = (a, b) => tableIndex(a.t) - tableIndex(b.t) || a.doneMin - b.doneMin
  || AGENT_KINDS.indexOf(a.k) - AGENT_KINDS.indexOf(b.k) || a.runMin - b.runMin;
/** Earlier first minute first; a table with no time last; ties keep the given order (sort is stable). */
const byFirstMinute = (a, b) => (a.first ?? Infinity) - (b.first ?? Infinity);

/**
 * Freezes parsed tables into their share-safe form and their seed runs.
 * @param {{ items: object[], runs: [number, number][], added: Record<string, string> }[]} tables parser items (items.mjs), the
 *   active runs of the table's sessions (activity.mjs activeRuns, epoch minutes) and the store's first-seen times ({} without one)
 * @returns {{ tables: object[], sources: number[], seedRows: { t: string, k: string, runMin: number, doneMin: number }[] }}
 *   tables named t1.. by first minute (sources[n]: the index in `tables` of t<n+1>); seedRows of all of them, empty when no
 *   agent row finished with a 1-240 minute run (never a made-up pool)
 */
export function freezeTables(tables) {
  const sources = tables.map((table, at) => ({ at, first: firstMinuteOf(table) })).sort(byFirstMinute).map((entry) => entry.at);
  const frozen = sources.map((at, n) => frozenTable(tables[at], `t${n + 1}`));
  return { tables: frozen, sources, seedRows: frozen.flatMap(runsOf).sort(bySeedOrder) };
}

/**
 * The seed runs a replay scored on `table` may pool: every run of another table (the held-out table's own runs would be the truth).
 * @param {{ t: string }[]} seedRows seed-runs.json rows
 * @param {string} table the held-out frozen table, e.g. 't4'
 * @returns {object[]} the rows whose `t` is not `table`, in order
 * @throws {TypeError} when seedRows is not an array or a row has no table tag (an untagged run could be the held-out table's)
 */
export function seedRunsWithout(seedRows, table) {
  if (!Array.isArray(seedRows) || !seedRows.every((row) => typeof row?.t === 'string')) throw new TypeError('seedRunsWithout: every seed row needs its table tag `t`');
  return seedRows.filter((row) => row.t !== table);
}

/** A JSON array with one entry per line (a diff shows the rows that changed), `[]` when empty. */
const listed = (entries, indent) => (entries.length === 0
  ? '[]'
  : `[\n${entries.map((entry) => `${indent}  ${JSON.stringify(entry)}`).join(',\n')}\n${indent}]`);

/** @returns {string} the frozen table file's text, stable for the same table */
export const frozenTableText = (table) => `{\n  "v": ${table.v},\n  "table": ${JSON.stringify(table.table)},\n  "rows": ${listed(table.rows, '  ')},\n  "active": ${listed(table.active, '  ')}\n}\n`;

/** @returns {string} seed-runs.json's text: `{ v, rows: [{ t, k, runMin, doneMin }] }` */
export const seedRunsText = (seedRows) => `{\n  "v": ${SEED_RUNS_VERSION},\n  "rows": ${listed(seedRows, '  ')}\n}\n`;
