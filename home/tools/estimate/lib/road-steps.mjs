// The roads and steps of a table (estimate-spec R6): the road and step a row id names (`<road>.s<N>.<rest>`, a `close:` or other
// `word:` prefix allowed), each road's steps and its current step by the one step rule, which slots.mjs (model s1) uses too.
// Exports: ROAD_ROW, roadStepOf(id) -> { road, step, check } | null, currentStepOf(rows) -> step | null, roadsOf(items, stateOf)
// -> Map, roadOf(items, stateOf) -> the first open road | null.
// Rules: each road keeps its own steps (a row of another road or with no step never counts in a step); a step is closed when
// its gate rows (`<road>.s<N>.check`, exactly: a lane may be named `check-age`) are done, or, with no gate row, when every row of
// it is done; the current step is the lowest step not closed. Parked rows neither close nor hold a step (the caller's stateOf
// says which rows are parked; without it every open row counts).
// Invariants: pure (no I/O, no clock); loops, never a spread into Math.min/max, so a table of any size fits.
export const ROAD_ROW = /^(?:[a-z]+:)?([A-Za-z0-9][\w-]{0,39})\.s(\d{1,3})\.(.+)$/i;
// The step's gate row, as road.mjs writes it and kinds.mjs reads it (CHECK_REST there): the whole rest is `check`.
const CHECK_REST = /^check$/i;

const isWorkRow = (item) => item.kind !== 'deliver';
const doneOrOpen = (item) => (item.done === null || item.done === undefined ? 'open' : 'done');

/** @returns {{ road: string, step: number, check: boolean } | null} the road and step a row id names (check: the step's gate row), or null */
export function roadStepOf(id) {
  const match = ROAD_ROW.exec(String(id ?? ''));
  if (!match) return null;
  const step = Number(match[2]);
  return step > 0 ? { road: match[1].toLowerCase(), step, check: CHECK_REST.test(match[3]) } : null;
}

/**
 * The current step of one road (R6).
 * @param {{ step: number, kind: string, state: string }[]} rows the road's rows that count (parked ones left out); kind 'gate'
 *   marks a gate row (kinds.mjs kindOf), state 'done' a finished row
 * @returns {number | null} the lowest step not closed; null when every step is closed or there is no row
 */
export function currentStepOf(rows) {
  const steps = new Map();
  for (const row of rows) {
    if (!steps.has(row.step)) steps.set(row.step, { gates: [], all: [] });
    const step = steps.get(row.step);
    step.all.push(row);
    if (row.kind === 'gate') step.gates.push(row);
  }
  let current = null;
  for (const [number, { gates, all }] of steps) {
    const closed = (gates.length > 0 ? gates : all).every((row) => row.state === 'done');
    if (!closed && (current === null || number < current)) current = number;
  }
  return current;
}

/**
 * Every road of the table with its steps (R6).
 * @param {object[]} items parser items (work rows and deliver rows)
 * @param {(item: object) => string} [stateOf] the row's state (kinds.mjs rowState: done, open, parked, waiting); default done or open
 * @returns {Map<string, { road: string, steps: number, current: number | null, rowsOf: Map<number, { id: string, done: boolean, item: object }[]> }>}
 *   in table order of each road's first row; steps the highest step number; rowsOf every non-parked row per step 1..steps
 */
export function roadsOf(items, stateOf = doneOrOpen) {
  const roads = new Map();
  for (const item of items.filter(isWorkRow)) {
    const at = roadStepOf(item.id);
    const state = at === null ? 'none' : stateOf(item);
    if (at === null || state === 'parked') continue;
    if (!roads.has(at.road)) roads.set(at.road, { road: at.road, rows: [] });
    roads.get(at.road).rows.push({ at, item, state });
  }
  const result = new Map();
  for (const [name, { rows }] of roads) {
    let steps = 0;
    for (const row of rows) steps = Math.max(steps, row.at.step);
    const rowsOf = new Map(Array.from({ length: steps }, (_, k) => [k + 1, []]));
    for (const row of rows) rowsOf.get(row.at.step).push({ id: row.item.id, done: row.state === 'done', item: row.item });
    const current = currentStepOf(rows.map((row) => ({ step: row.at.step, kind: row.at.check ? 'gate' : 'row', state: row.state })));
    result.set(name, { road: name, steps, current, rowsOf });
  }
  return result;
}

/**
 * The road of the first open road row in table order, with its steps (the estimate's step reading of one road).
 * @param {object[]} items parser items
 * @param {(item: object) => string} [stateOf] as for roadsOf
 * @returns {null | { road: string, steps: number, current: number, rowsOf: Map<number, { id: string, done: boolean }[]> }}
 *   null when no road row is open or every step of that road is closed
 */
export function roadOf(items, stateOf = doneOrOpen) {
  const first = items.find((item) => isWorkRow(item) && roadStepOf(item.id) !== null && stateOf(item) !== 'done' && stateOf(item) !== 'parked');
  if (first === undefined) return null;
  const road = roadsOf(items, stateOf).get(roadStepOf(first.id).road);
  if (road === undefined || road.current === null) return null;
  const rowsOf = new Map([...road.rowsOf].map(([step, rows]) => [step, rows.map(({ id, done }) => ({ id, done }))]));
  return { road: road.road, steps: road.steps, current: road.current, rowsOf };
}
