// What a table row is to the estimate (model s1, estimate-spec R1, R2, R3, R4, R14): its kind, its state, and the pools of
// working minutes per kind that finished rows took.
// Exports: AGENT_KINDS, LEAD_KINDS, HOLD_KINDS, MIN_RUN_MIN, MAX_RUN_MIN, kindOf(item), splitHolds(evidence), holdsOf(evidence),
// startsWithHold(text), rowState(item), kindPools(rows). The hold grammar here is the one copy: status.mjs (status-table.mjs) writes
// and clears holds with it, and the estimate reads them with it.
// Why kind and not size: on the held-out Desap day a per-size pool missed the step by 39 min and the job by 578, a per-kind pool
// by 21 and 254 (spec section 3). Lead kinds (gate, land, deliver) are the lead's own bookkeeping: they take no agent slot and
// draw no build minutes (the 11 old-form `-land` M rows of the PC job drew about 3 h under the size model, spec section 14).
// Invariants: pure (no I/O, no clock); kindOf takes the first matching rule of R1 in order; a done row is always 'done', whatever
// its evidence says, so a `parked:` text cannot hide a finished row; every pool is sorted ascending and holds only 1..240.
import { ROAD_ROW, roadStepOf } from './road-steps.mjs';

/** Kinds whose rows are one agent run each: they take a slot and draw from a pool. */
export const AGENT_KINDS = ['lane', 'review', 'fix', 'followup', 'plan', 'task'];
/** Kinds the lead does itself: no slot, no pool (a step gate costs a few lead minutes, see slots.mjs). */
export const LEAD_KINDS = ['gate', 'land', 'deliver'];
/** A run feeds a pool only from 1 working minute (a row started and done in the same minute is bookkeeping, R14)... */
export const MIN_RUN_MIN = 1;
/** ...up to 240 working minutes (4 h): longer rows were left open, not worked (wall tails of 1,776-3,712 min, spec section 3). */
export const MAX_RUN_MIN = 240;
/** A kind with fewer finished runs than this draws from all agent kinds pooled (R2). */
const MIN_KIND_RUNS = 10;
/** The pool when no run of any agent kind is known (no store, no seed-runs): the median and 80th percentile of the 359 measured
 *  agent rows (22 and 46 min, spec section 3), so a first job still gets a time instead of an error (contract F1). */
const FALLBACK_AGENT_POOL = [22, 46];

const PREFIX = /^\s*([a-z-]+):/i;
// Road row names (home/tools/road/README.md "Rows"): road.mjs writes the step's check row as exactly `<road>.s<N>.check`; a lane
// may be named `check-age`, `review-times` or `fix-cv-find-job-skill`, so only these exact names make a gate or a review. An audit
// fix row is `<road>.s<N>.fix-<name>` with item `rework: <name>`, and a lane may also be named `fix-...`, so the fix is told by its
// item prefix (FIX_PREFIXES), never by the name alone.
const CHECK_REST = /^check$/i;
const LAND_REST = /-land$/i;
const REVIEW_REST = /^review$/i;
const FOLLOWUP_ID = /^(?:F\d+|[A-Za-z0-9][\w-]*\.f\d+\..+|fu\..+)$/i;
const PLAN_ID = /^P\d+$/i;
const FIX_PREFIXES = ['fix', 'close', 'rework'];
/** The two holds, as the evidence prefix names them: `status.mjs park` writes `parked:`, `status.mjs wait` writes `waiting:`. */
export const HOLD_KINDS = Object.freeze(['parked', 'waiting']);
// A hold (status.mjs park/wait, the writer): `parked: <why>` or `waiting: <question>`, any case, at the head of an open row's
// evidence, each ended by `;` and the spaces after it; several may follow one another.
const HOLD_AT_HEAD = new RegExp(`^\\s*(${HOLD_KINDS.join('|')}):([^;]*)(?:;\\s*|$)`, 'i');

/** The lowercase `word:` prefix of the item cell, else of the id cell (the parser reads `close:5` the same way), or ''. */
function prefixOf(item) {
  const fromItem = PREFIX.exec(String(item.item ?? ''));
  const fromId = PREFIX.exec(String(item.id ?? ''));
  return (fromItem ?? fromId)?.[1].toLowerCase() ?? '';
}

/** The kind of a row of road `<road>.s<N>.<rest>`: gate, land, review, fix or lane (R1 rules 2-6). */
function roadRowKind(rest, prefix) {
  if (CHECK_REST.test(rest)) return 'gate';
  if (LAND_REST.test(rest)) return 'land';
  if (REVIEW_REST.test(rest) || prefix === 'review') return 'review';
  if (FIX_PREFIXES.includes(prefix)) return 'fix';
  return 'lane';
}

/** The text after `<road>.s<N>.` of a road row id (road-steps.mjs ROAD_ROW, step 1 or more), or null for any other id. */
const roadRest = (id) => (roadStepOf(id) === null ? null : ROAD_ROW.exec(id)[3]);

/**
 * The row's kind by estimate-spec R1, first match: a `deliver:` row; a road row (exactly `<road>.s<N>.check` gate, `.<x>-land`
 * land, exactly `.review` or item `review:` review, prefix `fix:`/`close:`/`rework:` fix, any other lane); a follow-up (`F<n>`,
 * `<road>.f<n>.*`, `fu.*` or prefix `follow-up:`); a plan (`P<n>` or prefix `plan:`); else a task. Outside a road, a `review:` item
 * is a review and a `fix:`/`close:`/`rework:` item a fix.
 * @param {{ id: string, item: string, kind: string }} item a parser item (items.mjs; kind 'deliver' marks a hand-over row)
 * @returns {'lane'|'review'|'fix'|'followup'|'plan'|'task'|'gate'|'land'|'deliver'}
 */
export function kindOf(item) {
  const id = String(item.id ?? '');
  const prefix = prefixOf(item);
  if (item.kind === 'deliver' || prefix === 'deliver') return 'deliver';
  const rest = roadRest(id);
  if (rest !== null) return roadRowKind(rest, prefix);
  if (prefix === 'review') return 'review';
  if (FIX_PREFIXES.includes(prefix)) return 'fix';
  if (FOLLOWUP_ID.test(id) || prefix === 'follow-up') return 'followup';
  if (PLAN_ID.test(id) || prefix === 'plan') return 'plan';
  return 'task';
}

/**
 * The holds at the head of an evidence cell, in order (the newest first, as status.mjs writes them), and the evidence after them.
 * @param {string} evidence the evidence cell
 * @returns {{ holds: { kind: 'parked'|'waiting', text: string, cell: string }[], rest: string }} text trimmed, without its mark;
 *   cell the hold as written (`Waiting: q1`, mark and text, ends trimmed); rest the evidence after the last hold
 */
export function splitHolds(evidence) {
  const holds = [];
  let rest = String(evidence ?? '');
  for (let match = HOLD_AT_HEAD.exec(rest); match !== null && match[0] !== ''; match = HOLD_AT_HEAD.exec(rest)) {
    holds.push({ kind: match[1].toLowerCase(), text: match[2].trim(), cell: `${match[1]}:${match[2]}`.trim() });
    rest = rest.slice(match[0].length);
  }
  return { holds, rest };
}

/**
 * The holds at the head of an evidence cell, in order (see splitHolds).
 * @param {string} evidence the evidence cell
 * @returns {{ kind: 'parked'|'waiting', text: string }[]} text trimmed, without its `parked:`/`waiting:` mark
 */
export const holdsOf = (evidence) => splitHolds(evidence).holds.map(({ kind, text }) => ({ kind, text }));

/** @returns {boolean} true when the text starts with a hold mark (`parked:` or `waiting:`, any case, after any spaces) */
export const startsWithHold = (text) => HOLD_AT_HEAD.test(String(text ?? ''));

/**
 * The row's state for the clock (R3, R4): a done row is done; an open row with a `parked:` hold at the head of its evidence is
 * parked (out of every number, whatever other hold it has), one with only `waiting:` holds waits for the owner (out of the work
 * clock); any other open row is open.
 * @param {{ done: number | null, evidence: string }} item a parser item
 * @returns {'done'|'open'|'parked'|'waiting'}
 */
export function rowState(item) {
  if (item.done !== null && item.done !== undefined) return 'done';
  const kinds = holdsOf(item.evidence).map((hold) => hold.kind);
  if (kinds.includes('parked')) return 'parked';
  if (kinds.includes('waiting')) return 'waiting';
  return 'open';
}

const isRun = (row) => AGENT_KINDS.includes(row?.k) && Number.isFinite(row.runMin) && row.runMin >= MIN_RUN_MIN && row.runMin <= MAX_RUN_MIN;
const ascending = (a, b) => a - b;

/**
 * The working-minute pools of the agent kinds (R2, R14). Store rows without `k`/`runMin` (written before model s1) and rows with a
 * run outside 1..240 feed nothing. A kind with fewer than MIN_KIND_RUNS runs gets the `agent` pool (all agent kinds together);
 * with no run at all, `agent` is FALLBACK_AGENT_POOL.
 * @param {{ k: string, runMin: number }[]} rows the store rows of every table plus the `seed-runs.json` rows
 * @returns {Record<string, number[]>} one sorted pool per AGENT_KINDS entry, plus `agent`
 * @throws {TypeError} when rows is not an array
 */
export function kindPools(rows) {
  if (!Array.isArray(rows)) throw new TypeError('kindPools: rows must be an array of { k, runMin }');
  const runs = rows.filter(isRun);
  const pooled = runs.map((row) => row.runMin).sort(ascending);
  const agent = pooled.length > 0 ? pooled : [...FALLBACK_AGENT_POOL];
  const pools = { agent };
  for (const kind of AGENT_KINDS) {
    const own = runs.filter((row) => row.k === kind).map((row) => row.runMin).sort(ascending);
    pools[kind] = own.length >= MIN_KIND_RUNS ? own : agent;
  }
  return pools;
}
