// Purpose: how `batch` schedules its states: --jobs parsing, the split into states that may run in parallel and states that must run alone
// (a `figma` part: pixel captures are load-sensitive), a small worker pool, the one-line progress text, and which states --resume skips.
// Exports: DEFAULT_JOBS, parseJobs, partitionStates, runPool, progressLine, resumeFilter, stateKey. Invariants: pure (no browser, no disk);
// a skipped state is reused only when every one of its previous records passed and covers all of its widths.
import { UsageError } from './errors.mjs';

export const DEFAULT_JOBS = 4;
const MS_PER_SECOND = 1000;
const NONE = '-';

/** Identity of a state in results.json (the same triple `ui-coverage check` matches on). */
export const stateKey = ({ surface, state, locale }) => JSON.stringify([surface, state, locale ?? null]);

/**
 * Parse --jobs.
 * @param {string|undefined} text flag value; undefined gives DEFAULT_JOBS
 * @returns {number} a positive integer
 * @throws {UsageError} naming --jobs
 */
export function parseJobs(text) {
  if (text === undefined) return DEFAULT_JOBS;
  const jobs = Number(text);
  if (text.trim() === '' || !Number.isInteger(jobs) || jobs < 1) throw new UsageError(`--jobs must be a whole number >= 1, got ${JSON.stringify(text)}`);
  return jobs;
}

/** Split states: those without a `figma` part may share the browser in parallel, those with one run alone afterwards. File order is kept in both lists. */
export function partitionStates(states) {
  return { parallel: states.filter((s) => !s.figma), serial: states.filter((s) => s.figma) };
}

/**
 * Run `worker(item)` for every item with at most `jobs` running at once.
 * @param {unknown[]} items
 * @param {number} jobs concurrency, >= 1
 * @param {(item: unknown) => Promise<void>} worker
 * @returns {Promise<void>} rejects with the first worker error
 */
export async function runPool(items, jobs, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, lane));
}

/**
 * The stderr line for a finished state, e.g. `[12/201] signup role:open fa 320 fail 1.4s`.
 * @param {{done: number, total: number, state: object, records: {width: number|null, status: string}[], ms: number}} input done = states finished so far (completion order)
 */
export function progressLine({ done, total, state, records, ms }) {
  const widths = [...new Set(records.map((r) => r.width).filter((w) => w !== null))];
  const status = records.every((r) => r.status === 'pass') ? 'pass' : 'fail';
  return `[${done}/${total}] ${state.surface} ${state.state} ${state.locale ?? NONE} ${widths.length > 0 ? widths.join(',') : NONE} ${status} ${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

const passesAll = (state, records) => records.length > 0 && records.every((r) => r.status === 'pass') && (state.widths ?? []).every((w) => records.some((r) => r.width === w));

/**
 * Decide which states --resume re-runs.
 * @param {object[]} states selected, normalised states
 * @param {object[]} prior records from an earlier run in the same --out
 * @returns {{todo: object[], reused: Map<number, object[]>}} reused maps a state index to the old records that stay
 */
export function resumeFilter(states, prior) {
  const byKey = Map.groupBy(prior, stateKey);
  const todo = [];
  const reused = new Map();
  for (const state of states) {
    const records = byKey.get(stateKey(state)) ?? [];
    if (passesAll(state, records)) reused.set(state.index, records);
    else todo.push(state);
  }
  return { todo, reused };
}
