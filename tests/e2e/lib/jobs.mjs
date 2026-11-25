// When a scenario's claude job is done, and how E0 decides the way later jobs run (review round 2, R8). Exports: ANSWER_MODES,
// answerModeOf(notesA), backgroundStarts(lines), jobDone(projectsDir, session), jobLine(jobs).
// Why: E0(a) probes whether a `claude -p` boss gets a background agent's result in the same run. When it did not (E0 needed
// `--resume` rounds), a later scenario whose boss starts background agents (E2, E3, E5, E6) would be judged on a run that
// ended before its agents did. So the run keeps E0's answer mode: `direct` (one run was enough) runs each job once; `resume`
// (E0 needed rounds, was not done or did not run) runs it with claudeUntil until jobDone. A job left not done is a FAIL line of
// its own, which names the mode, so a missing result is never read as the scenario's own failure.
// Invariants: reads the transcript fresh on each call (never the check's cached copy); a background start without an agent id
// never counts as ended; the task-notification id of an agent is taken to be its agentId (as completedAt reads it).
import { checkLine, completedAt } from './checks.mjs';
import { loadSession, toolCalls } from './transcripts.mjs';

export const ANSWER_MODES = Object.freeze({ direct: 'direct', resume: 'resume' });
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const ASYNC_STATUS = 'async_launched'; // the toolUseResult status of an agent started in the background

/** @returns {string} `direct` when E0(a) was done in one run, else `resume` (rounds were needed, or it was not done or not run) */
export const answerModeOf = (notesA) => (notesA?.done === true && notesA.rounds === 0 ? ANSWER_MODES.direct : ANSWER_MODES.resume);

/**
 * @param {object[]} lines the boss's transcript
 * @returns {(string | null)[]} the agent id of each agent the boss started in the background (null when the start named none)
 */
export const backgroundStarts = (lines) => toolCalls(lines)
  .filter((call) => AGENT_TOOLS.has(call.name) && call.result !== null && call.result.isError !== true
    && (call.input.run_in_background === true || call.result.meta.status === ASYNC_STATUS))
  .map((call) => (typeof call.result.meta.agentId === 'string' ? call.result.meta.agentId : null));

/**
 * @param {string} projectsDir `<home>/.claude/projects` of the HOME the child used
 * @param {{sessionId: string | null, result: object | null}} session one claude run (claude-run.mjs)
 * @returns {boolean} a good result, and a completed notice for every background agent the boss started
 */
export function jobDone(projectsDir, session) {
  if (session.result === null || session.result === undefined || session.result.is_error === true || !session.sessionId) return false;
  const { lines } = loadSession(projectsDir, session.sessionId);
  const ended = completedAt(lines);
  return backgroundStarts(lines).every((agentId) => agentId !== null && ended.has(agentId));
}

/**
 * @param {{name: string, answer: string, mode: string, done: boolean}[]} jobs the scenario's claudeJob runs (context.mjs)
 * @returns {object | null} one check line, or null when the scenario ran no job
 */
export function jobLine(jobs = []) {
  if (jobs.length === 0) return null;
  const open = jobs.filter((job) => !job.done);
  const observed = open.length === 0 ? jobs.map((job) => `${job.name}: ${job.mode}`).join('; ')
    : `not done: ${open.map((job) => `${job.name} (${job.mode})`).join('; ')}`;
  return checkLine('each claude job ended: a good result, a completed notice for every background agent',
    `done (E0 answer mode: ${jobs[0].answer})`, observed, open.length === 0);
}
