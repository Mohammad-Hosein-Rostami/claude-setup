// Purpose: the data of the `long-run view` browser screen: each run's view (as `status` and `live` read it), its job's routes for
//   drawing and its last events.
// Exports: EVENTS_SHOWN, flowOf, runsData.
// Invariants: reads only, through runView() and the run's job.json and events.jsonl: no write, no lock, no folder made, and
//   checkpoints.sqlite is never opened; at most STATUS_RUNS runs, newest first; a run whose files cannot be read is one
//   `{ runId, error }` entry and the others still show; every string in the result is cleaned with clean() (control characters,
//   token-shaped text), because reasons, questions and event details are model-written.
import { clean } from './live.mjs';
import { listRunIds, readJsonLines, readRunJob, runPaths } from './run-store.mjs';
import { STATUS_RUNS, runView } from './view.mjs';

/** How many of a run's newest events the screen shows. */
export const EVENTS_SHOWN = 15;
// The run states the screen hides until "Show finished runs" is on (the rule `live` uses).
const FINISHED = new Set(['done', 'abandoned']);

/**
 * The job's routes for drawing: one entry per job step, in job order. A missing `next.done` goes to the following entry and any
 * other outcome without a route holds the run (graph.mjs outcomeRoute), so `next` holds only the routes the job names.
 * @param {object} job a normalized job (readRunJob()).
 * @returns {Array<{id: string, kind: 'step' | 'group', items: string[], next: Record<string, string>}>} `items`: a group's item
 *   ids, empty for a step.
 */
export function flowOf(job) {
  return job.steps.map((entry) => ({ id: entry.id, kind: entry.kind, items: (entry.items ?? []).map((item) => item.id), next: entry.next }));
}

/** One run as the screen shows it, or `{ runId, error }` when its files cannot be read. */
function runData(root, runId, now) {
  try {
    const paths = runPaths(root, runId);
    const view = runView(paths, now);
    const events = readJsonLines(paths.events).slice(-EVENTS_SHOWN).map(({ t, event, step, detail }) => ({ t, event, step, detail }));
    return { runId, finished: FINISHED.has(view.state), view, flow: flowOf(readRunJob(paths)), events };
  } catch (error) {
    // A broken run folder (an unreadable file, or a value in it that cannot be shown) must not hide the other runs.
    return { runId, error: error.message };
  }
}

/**
 * Every run the screen shows.
 * @param {string} root the state folder (stateRoot()); a missing folder gives no runs.
 * @param {{now?: Date}} options the current time.
 * @returns {{now: string, runs: object[]}} `now` as UTC ISO; `runs` newest first, at most STATUS_RUNS, each
 *   `{ runId, finished, view, flow, events }` (`view`: runView(); `flow`: flowOf(); `events`: the last EVENTS_SHOWN lines of
 *   events.jsonl as `{ t, event, step, detail }`) or `{ runId, error }`; every string cleaned with clean().
 */
export function runsData(root, { now = new Date() } = {}) {
  const runs = listRunIds(root).slice(0, STATUS_RUNS).map((runId) => runData(root, runId, now));
  const cleanStrings = (key, value) => (typeof value === 'string' ? clean(value) : value);
  return JSON.parse(JSON.stringify({ now: now.toISOString(), runs }, cleanStrings));
}
