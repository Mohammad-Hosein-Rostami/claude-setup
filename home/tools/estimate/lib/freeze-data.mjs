// The anonymized frozen copy of real tables for the backtest of model s1 (estimate-spec sections 12-13), and the seed runs that
// boot its kind pools (R2) before the store holds any run.
// Exports: FROZEN_VERSION, SEED_RUNS_VERSION, MAX_FROZEN_BYTES, freezeTables(tables) -> { tables, seedRows },
//   frozenTableText(table), seedRunsText(seedRows).
// A frozen table is { v, table: 't<n>', origin, rows, active }: every row as { id, road, step, kind, c3Kind, size, state,
// firstSeenMin, startedMin, doneMin }, and the table's active minutes as [startMin, endMin) runs. Minutes count from `origin`, the
// first minute any frozen table saw a row, so the tables keep their order in time (a replay's train/test cut) and nothing else
// of the clock. `kind` is s1's (kinds.mjs kindOf), `c3Kind` the parser's (items.mjs: build, close, rework, deliver; the c3 replay
// reads it), `state` kinds.mjs rowState or `dropped` (a done row whose evidence starts `dropped:`: no run, no pool).
// Seed runs: one { k, runMin } per done agent-kind row (not dropped) whose working minutes from start to done, clipped to the
// table's working intervals (worked.mjs, silences up to 10 min bridged), are 1..240 (R2, R14); sorted by kind then minutes.
// Invariants (share-safe, contract F1/F2): pure; no item, evidence or id text, no path and no session id reaches the output.
// Ids are rewritten `r<i>.s<N>.<kind><n>` (roads numbered in table order) or `<kind><n>`, so a road named `s1` or an id holding
// `|` never shows; every string the output holds is one of those ids, a kind, a size, a state or the origin instant. Same input,
// same bytes: the lead re-freezes fresh copies and compares sha256.
import { AGENT_KINDS, MAX_RUN_MIN, MIN_RUN_MIN, kindOf, rowState } from './kinds.mjs';
import { parseInstant } from './items.mjs';
import { roadStepOf } from './road-steps.mjs';
import { workedMinutes, workingIntervals } from './worked.mjs';

export const FROZEN_VERSION = 1;
export const SEED_RUNS_VERSION = 1;
/** 8 MiB per frozen file, for the writer here and the replay's reader: the largest real table (711 rows) freezes to about 125 KB. */
export const MAX_FROZEN_BYTES = 8 << 20;
const MS_PER_MIN = 60_000;
const DROPPED = /^\s*dropped:/i;

const floorMin = (ms) => Math.floor(ms / MS_PER_MIN);
const floorToMinuteMs = (ms) => floorMin(ms) * MS_PER_MIN;
const isoMinute = (min) => new Date(min * MS_PER_MIN).toISOString().replace(':00.000Z', 'Z');

/** The row's first-seen time (ms): the store's first sighting, else its first stamp; null when it has neither. */
function firstSeenMs(item, added) {
  const seenAt = Object.hasOwn(added, item.id) ? parseInstant(added[item.id]) : null;
  const seen = seenAt === null ? null : floorToMinuteMs(seenAt); // to its minute, as the tool reads it (job-rows.mjs carriedIds)
  const times = [seen, item.started, item.done].filter((ms) => ms !== null);
  return times.length === 0 ? null : Math.min(...times);
}

/** Every time a table holds (first-seen, started, done), in ms. */
const timesOf = (table) => table.items.flatMap((item) => [firstSeenMs(item, table.added), item.started, item.done]).filter((ms) => ms !== null);

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

/** Active runs (epoch minutes) clipped to [fromMin, toMin) and moved to minutes from originMin. */
const clippedRuns = (runs, fromMin, toMin, originMin) => runs
  .map(([start, end]) => [Math.max(start, fromMin), Math.min(end, toMin)])
  .filter(([start, end]) => start < end)
  .map(([start, end]) => [start - originMin, end - originMin]);

/** One frozen table; `name` is its t<n>, originMin the shared first minute. */
function frozenTable(table, name, originMin) {
  const relative = (ms) => (ms === null ? null : (ms - originMin * MS_PER_MIN) / MS_PER_MIN);
  const ids = rewrittenIds(table.items);
  const rows = table.items.map((item, at) => ({
    ...ids[at],
    kind: kindOf(item),
    c3Kind: item.kind,
    size: item.size,
    state: stateOf(item),
    firstSeenMin: relative(firstSeenMs(item, table.added)),
    startedMin: relative(item.started),
    doneMin: relative(item.done),
  }));
  const times = timesOf(table);
  const active = times.length === 0 ? [] : clippedRuns(table.runs, floorMin(Math.min(...times)), Math.ceil(Math.max(...times) / MS_PER_MIN), originMin);
  return { v: FROZEN_VERSION, table: name, origin: originMin === null ? null : isoMinute(originMin), rows, active };
}

/** The table's seed runs (see the header): working minutes of each finished agent run, 1..240. */
function runsOf(frozen) {
  const endMin = Math.max(0, ...frozen.rows.flatMap((row) => [row.startedMin ?? 0, row.doneMin ?? 0]));
  const intervals = workingIntervals(frozen.active, endMin);
  return frozen.rows
    .filter((row) => row.state === 'done' && AGENT_KINDS.includes(row.kind) && row.startedMin !== null)
    .map((row) => ({ k: row.kind, runMin: workedMinutes(intervals, row.startedMin, row.doneMin) }))
    .filter((run) => run.runMin >= MIN_RUN_MIN && run.runMin <= MAX_RUN_MIN);
}

const byKindThenMinutes = (a, b) => AGENT_KINDS.indexOf(a.k) - AGENT_KINDS.indexOf(b.k) || a.runMin - b.runMin;

/**
 * Freezes parsed tables into their share-safe form and their seed runs.
 * @param {{ items: object[], runs: [number, number][], added: Record<string, string> }[]} tables parser items (items.mjs), the
 *   active runs of the table's sessions (activity.mjs activeRuns, epoch minutes) and the store's first-seen times ({} without one)
 * @returns {{ tables: object[], seedRows: { k: string, runMin: number }[] }} tables named t1.. in the given order; seedRows of
 *   all of them, empty when no agent row finished with a 1-240 minute run (never a made-up pool)
 */
export function freezeTables(tables) {
  const all = tables.flatMap(timesOf);
  const originMin = all.length === 0 ? null : floorMin(Math.min(...all)); // null: no table saw a row, so every time is null too
  const frozen = tables.map((table, at) => frozenTable(table, `t${at + 1}`, originMin));
  return { tables: frozen, seedRows: frozen.flatMap(runsOf).sort(byKindThenMinutes) };
}

/** A JSON array with one entry per line (a diff shows the rows that changed), `[]` when empty. */
const listed = (entries, indent) => (entries.length === 0
  ? '[]'
  : `[\n${entries.map((entry) => `${indent}  ${JSON.stringify(entry)}`).join(',\n')}\n${indent}]`);

/** @returns {string} the frozen table file's text, stable for the same table */
export const frozenTableText = (table) => `{\n  "v": ${table.v},\n  "table": ${JSON.stringify(table.table)},\n  "origin": ${JSON.stringify(table.origin)},\n  "rows": ${listed(table.rows, '  ')},\n  "active": ${listed(table.active, '  ')}\n}\n`;

/** @returns {string} seed-runs.json's text: `{ v, rows: [{ k, runMin }] }` */
export const seedRunsText = (seedRows) => `{\n  "v": ${SEED_RUNS_VERSION},\n  "rows": ${listed(seedRows, '  ')}\n}\n`;
