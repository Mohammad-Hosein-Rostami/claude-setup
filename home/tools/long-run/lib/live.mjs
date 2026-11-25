// Purpose: `long-run live`: one frame of the runs (each run's account and steps, limit and retry waits with their time, short
//   session ids), redrawn every 2 s until Ctrl-C.
// Exports: LIVE_REFRESH_MS, liveLines, liveLoop.
// Invariants: reads only, through runView() (the files the runs already write); each frame reads the runs again, so a run that
//   starts, ends or switches account between frames shows in the next one; every line is cleaned of control characters and
//   token-shaped text; a session id is cut to SESSION_ID_CHARS; a run whose files cannot be read is one `unreadable` line.
import { setTimeout as delay } from 'node:timers/promises';
import { scrub } from './claude-run.mjs';
import { listRunIds, runPaths } from './run-store.mjs';
import { STATUS_RUNS, formatWhen, runView } from './view.mjs';

/** How often `live` redraws. */
export const LIVE_REFRESH_MS = 2000;
const SESSION_ID_CHARS = 8;
const MS_PER_MINUTE = 60 * 1000;
const FINISHED = new Set(['done', 'abandoned']);
const WAIT_WORDS = { 'waiting-limit': 'resets', 'waiting-retry': 'retries' };
const STATE_WIDTH = 'waiting-limit'.length; // the longest state word, so the details line up
// Moves the cursor home and clears the screen, so each frame replaces the last one.
const CLEAR_SCREEN = '\x1b[H\x1b[2J';
// C0 and C1 control characters (ESC, newline, carriage return ...): a model-written reason must not move the cursor or add lines.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const clean = (line) => scrub(line.replace(CONTROL_CHARS, ' '), null);

/** `(in N min)`, `(in <1 min)` or `(due)` from `now` until `iso`. */
function countdown(iso, now) {
  const ms = Date.parse(iso) - now.getTime();
  if (ms <= 0) return '(due)';
  if (ms < MS_PER_MINUTE) return '(in <1 min)';
  return `(in ${Math.floor(ms / MS_PER_MINUTE)} min)`;
}

/** The parts of one step line after its label and state. */
function stepDetails(view, step, session, { state, now }) {
  const until = session?.until ?? step.waitUntil;
  return [
    WAIT_WORDS[state] && until ? `${WAIT_WORDS[state]} ${formatWhen(until)} ${countdown(until, now)}` : '',
    session ? `session ${session.sessionId.slice(0, SESSION_ID_CHARS)}` : '',
    session && session.account !== view.account ? `acct ${session.account}` : '', // a step still on the account before a switch
    session?.state === 'running' ? `since ${formatWhen(session.since)}` : '',
    step.question ? `(question waits: long-run status ${view.runId})` : step.reason ? `(${step.reason})` : '',
  ];
}

/** The run line, its warnings and one line per step, in job order. */
function runLines(view, now) {
  const labelOf = (step) => (step.group ? `${step.group}/${step.id}` : step.id);
  const labelWidth = Math.max(...view.steps.map((step) => labelOf(step).length));
  const done = view.steps.filter((step) => step.status === 'done').length;
  const stepLines = view.steps.map((step) => {
    const session = view.sessions.find((one) => one.step === step.id);
    const state = session?.state ?? step.status; // a limit wait shows only in the session; the step itself says `started`
    const parts = [`  ${labelOf(step).padEnd(labelWidth)}`, state.padEnd(STATE_WIDTH), ...stepDetails(view, step, session, { state, now })];
    return parts.filter(Boolean).join('  ').trimEnd();
  });
  return [`${view.runId}  ${view.state}  acct ${view.account}  ${done}/${view.steps.length} done`, ...view.warnings.map((line) => `  warning: ${line}`), ...stepLines];
}

/** The lines of one run, or its `unreadable` line; null when the run is finished and `all` is off. */
function linesOfRun(root, runId, { now, all }) {
  let view;
  try {
    view = runView(runPaths(root, runId), now);
  } catch (error) {
    return [`${runId}  unreadable (${error.message})`]; // a broken run folder must not hide the other runs
  }
  return all || !FINISHED.has(view.state) ? runLines(view, now) : null;
}

/**
 * The frame for `now`: a header, then per run its line, its warnings and its step lines.
 * @param {string} root the state folder (stateRoot()).
 * @param {{now?: Date, all?: boolean}} options `all`: also the done and abandoned runs.
 * @returns {string[]} the lines, each cleaned of control characters and token-shaped text.
 */
export function liveLines(root, { now = new Date(), all = false } = {}) {
  const runs = listRunIds(root).slice(0, STATUS_RUNS).map((runId) => linesOfRun(root, runId, { now, all })).filter(Boolean);
  const empty = all ? 'no runs' : 'no live runs (long-run live --all lists finished ones)';
  const lines = [`long-run live · ${formatWhen(now.toISOString())} · every 2 s · Ctrl-C quits`, ...(runs.length > 0 ? runs.flat() : [empty])];
  return lines.map(clean);
}

/**
 * Draws liveLines every LIVE_REFRESH_MS until `signal` aborts; Ctrl-C ends only the view, never a run.
 * @param {{root: string, write: (frame: string) => void, signal: AbortSignal, all?: boolean, isTTY?: boolean,
 *   columns?: () => number, now?: () => Date, sleep?: (ms: number) => Promise<void>}} options `write` takes a whole frame, so a
 *   redraw does not flicker; on a TTY each frame clears the screen first and each line is cut to `columns() - 1`, read per frame
 *   so a narrowed window does not wrap; off a TTY the frames scroll, a blank line apart. The default `sleep` ends at once when
 *   `signal` aborts, so Ctrl-C quits without waiting for the next frame.
 * @returns {Promise<void>}
 */
export async function liveLoop({ root, write, signal, all = false, isTTY = false, columns = () => 0, now = () => new Date(), sleep = (ms) => delay(ms, undefined, { signal }).catch(endsOnAbort) }) {
  while (!signal.aborted) {
    const lines = liveLines(root, { now: now(), all });
    const width = columns() - 1;
    write(isTTY ? `${CLEAR_SCREEN}${lines.map((line) => line.slice(0, width)).join('\n')}\n` : `${lines.join('\n')}\n\n`);
    await sleep(LIVE_REFRESH_MS);
  }
}

/** An aborted wait is the normal end of the view; any other error is not. */
function endsOnAbort(error) {
  if (error.name !== 'AbortError') throw error;
}
