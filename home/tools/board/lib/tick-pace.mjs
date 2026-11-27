// Purpose: the tick's `agents` and `job` lines (plan-core-best section 9, cb-pace-1), which answer "where are we, how long":
//   the session's agents that run, by type, each with its name and age when known (or `quiet N min`), and one line per job with its
//   progress and its measured pace: the median gap between the job's consecutive lands in the land ledger (the last MAX_GAPS)
//   times the pieces not landed yet. The pace is never a guess: under MIN_LANDS lands it says it is unknown.
// Exports: agentsLine(agents, nowMs) -> string, jobLine(job) -> string.
// Invariants: pure (the clock is passed in); every agent name, type and plan path goes through cells.mjs cleanText, so no
//   control character reaches the terminal; at most MAX_NAMES agent names, so 100 agents still make one short line.
import { cleanText } from './cells.mjs';

const MAX_NAMES = 6;
const MAX_GAPS = 6; // the newest gaps the pace is the median of: recent lands say more about the rest of the job
const MIN_LANDS = 2; // one gap needs two lands
const MS_PER_MIN = 60_000;
const MIN_PER_HOUR = 60;
const DONE = 'done'; // agents.mjs: an agent's state is `run`, `quiet` or `done`
const QUIET = 'quiet';
// cleanText reads only `ascii` from a look: these lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };

const clean = (text) => cleanText(text, PLAIN_LOOK);
const sum = (numbers) => numbers.reduce((total, number) => total + number, 0);
const wholeMinutes = (ms) => Math.max(0, Math.floor(ms / MS_PER_MIN)); // as agents.mjs counts them: a clock skew is 0, never negative

/**
 * One agent as the line names it: `<name> quiet N min` while quiet, else `<name> N min` since it started, or `<name>` alone when
 * its start time is unknown (repos.mjs placeAgents leaves `startMs` out of the board's agents), never `NaN min`.
 */
function agentText(agent, nowMs) {
  const name = clean(agent.name);
  if (agent.state === QUIET) return `${name} quiet ${agent.quietMin} min`;
  return Number.isFinite(agent.startMs) ? `${name} ${wholeMinutes(nowMs - agent.startMs)} min` : name;
}

/**
 * The `agents` line: how many of the session's agents run (quiet ones included), by type in the board's order, each type with
 * its count and the names of its agents, at most MAX_NAMES names in all and then `; +<n> more`.
 * @param {{ type: string, name: string, state: string, quietMin: number, startMs?: number }[]} agents the board's agents
 *   (agents.mjs sessionAgents: running first, then newest), done ones included; `startMs` absent when the start is unknown
 * @param {number} nowMs the time the ages are counted to
 * @returns {string} `agents <n> running: <type> <n> (<name>[ <n> min], ...), ...[; +<n> more]`, or `agents none running`
 */
export function agentsLine(agents, nowMs) {
  const live = agents.filter((agent) => agent.state !== DONE);
  if (live.length === 0) return 'agents none running';
  const groups = [...new Set(live.map((agent) => agent.type))].map((type) => live.filter((agent) => agent.type === type));
  const named = new Set(groups.flat().slice(0, MAX_NAMES)); // the first names in the order the line prints them
  const groupText = (group) => {
    const names = group.filter((agent) => named.has(agent)).map((agent) => agentText(agent, nowMs));
    return `${clean(group[0].type)} ${group.length}${names.length === 0 ? '' : ` (${names.join(', ')})`}`;
  };
  const more = live.length - named.size;
  return `agents ${live.length} running: ${groups.map(groupText).join(', ')}${more > 0 ? `; +${more} more` : ''}`;
}

/** A length of time as the job line says it: `under 1 min`, `about <n> min`, or from an hour on `about <n> h`. */
function durationText(ms) {
  const minutes = Math.round(ms / MS_PER_MIN);
  if (minutes < 1) return 'under 1 min';
  if (minutes < MIN_PER_HOUR) return `about ${minutes} min`;
  return `about ${Math.round(minutes / MIN_PER_HOUR)} h`;
}

/** The middle of `numbers` (not empty) in sorted order, the mean of the two middle ones for an even count. */
function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The pace part of the job line: the median of the newest MAX_GAPS gaps between the job's lands, and that times the pieces
 * `left`; `pace unknown (fewer than 2 lands)` under MIN_LANDS lands.
 */
function paceText(lands, left) {
  if (lands.length < MIN_LANDS) return 'pace unknown (fewer than 2 lands)';
  const times = lands.map(({ at }) => Date.parse(at)).sort((a, b) => a - b).slice(-(MAX_GAPS + 1));
  const gaps = times.slice(1).map((time, at) => time - times[at]);
  const perLand = median(gaps);
  const rest = left === 0 ? 'none left' : `${durationText(perLand * left)} for ${left} left`;
  return `${durationText(perLand)} per land (last ${gaps.length}) -> ${rest}`;
}

/**
 * One job's `job` line: its plan file, its pieces landed, in lanes and waiting, its features checked by tess, and its pace.
 * A piece is in a lane when it is neither landed nor waiting (tick-features.mjs planState); the pieces left are all the pieces
 * not landed, the ones in lanes included: each of them still needs a land.
 * @param {{ job: string, path: string, features: { landed: number, pieces: number, isChecked: boolean }[], queue: object[],
 *   lands: { at: string }[] }} job one of the tick's jobs (tick.mjs jobOf): `queue` holds one entry per waiting piece, `lands`
 *   the plan's lands in the land ledger (tick-jobs.mjs landsOfPlan), each with its ISO time
 * @returns {string} `job <slug> (<pieces.json>): <n>/<n> landed, <n> in lanes, <n> waiting; <n>/<n> features checked; <pace>`
 */
export function jobLine(job) {
  const total = sum(job.features.map((feature) => feature.pieces));
  const landed = sum(job.features.map((feature) => feature.landed));
  const waiting = job.queue.length;
  const checked = job.features.filter((feature) => feature.isChecked).length;
  const progress = `${landed}/${total} landed, ${total - landed - waiting} in lanes, ${waiting} waiting`;
  return `job ${job.job} (${clean(job.path)}): ${progress}; ${checked}/${job.features.length} features checked; ${paceText(job.lands, total - landed)}`;
}
