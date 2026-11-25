// E0, the probes every later scenario relies on (plan section 9, U2-U6): (a) a boss answers with a background lex's result in
// the same run, else `--resume` rounds are needed (the mode is recorded); (b) a Bash ask leaves a guard log line with the
// session id; (c) that ask reaches the scripted dialog; (d) the wait ceiling holds a background agent for 12 minutes; (e) the
// nested `claude` runs logged in on the subscription. (e) is a gate: when it fails the runner runs no later scenario.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { checkLine, LIMITS } from '../lib/checks.mjs';
import { agentsOf, loaded, textOf } from '../lib/common.mjs';
import { guardLines, guardOutcomes } from '../lib/logs.mjs';
import { makeLibrary } from '../lib/repo.mjs';

export const id = 'E0';
export const title = 'probes: background answer, guard log, dialog, wait ceiling, login';
export const model = 'sonnet';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const FOUR = /(^|\D)4(\D|$)/;
const DONE_12 = 'done-12';
const WAIT_RUNS = 6; // six waits of 125 s: 750 s, past the 12 minutes (720 s) the probe needs
const WAIT_MS = 125_000;
const WAIT_TIMEOUT_MS = 180_000; // under the 3-minute line, so the agent keeps each wait in the foreground
const LOGIN_ERROR = /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired|credit balance/i;
const MS_PER_MINUTE = 60_000;

const PROMPT_A = 'This is a probe of the setup. Start one lex agent in the background (run_in_background: true) with this brief: '
  + '"Reply with the digit 4 and nothing else." Wait for its result, then reply with only the digit it returned.';
const PROMPT_BC = 'This is a probe of the guard. Run this exact Bash command once in the current folder, then reply with its exit '
  + 'code only: git commit --no-verify --allow-empty -m e0-probe';
const PROMPT_D = `This is a probe of how long a background agent may run. Start one lex agent in the background with this brief: "Run this Bash command ${WAIT_RUNS} times, one after the other, each in the foreground with the Bash timeout ${WAIT_TIMEOUT_MS}: node -e 'setTimeout(() => {}, ${WAIT_MS})'. Then reply ${DONE_12}." Wait for its result, then reply with its answer only.`;

export function setup(ctx) {
  makeLibrary(ctx);
}

export async function run(ctx) {
  const a = await ctx.claudeUntil({ name: 'a-background-lex', prompt: PROMPT_A, model }, (session) => FOUR.test(textOf(session)));
  ctx.notes.a = { mode: a.mode, rounds: a.rounds, done: a.done, text: textOf(a.session).slice(0, 80) };
  ctx.dialog('allow');
  ctx.notes.dialogsBefore = ctx.dialogCount();
  ctx.notes.bc = await ctx.claude({ name: 'bc-guard-ask', prompt: PROMPT_BC, model });
  ctx.notes.dialogsAfter = ctx.dialogCount();
  ctx.notes.d = await ctx.claude({ name: 'd-wait-ceiling', prompt: PROMPT_D, model });
}

/** @returns {number} the minutes from an agent's first to its last transcript line */
const spanMinutes = (lines) => {
  const times = lines.map((line) => Date.parse(line.timestamp ?? '')).filter(Number.isFinite);
  return times.length < 2 ? 0 : (Math.max(...times) - Math.min(...times)) / MS_PER_MINUTE;
};

export function check(ctx) {
  const { a, bc, d, dialogsBefore, dialogsAfter } = ctx.notes;
  const guard = bc?.sessionId ? guardOutcomes(guardLines(ctx.paths.guardLog), [bc.sessionId]) : [];
  const dialogs = (dialogsAfter ?? 0) - (dialogsBefore ?? 0);
  const waitLex = d ? loaded(ctx, d).agents.filter((agent) => agent.type === 'lex') : [];
  const longest = Math.max(0, ...waitLex.map((agent) => spanMinutes(agent.lines)));
  const loginTrouble = ctx.sessions.filter((session) => session.init?.apiKeySource !== 'none' || session.result === null
    || session.result.is_error === true || LOGIN_ERROR.test(`${textOf(session)} ${session.stderrTail}`))
    .map((session) => `${session.name}: apiKeySource ${session.init?.apiKeySource ?? 'none seen'}, ${session.result ? (session.result.is_error ? 'error result' : 'result ok') : 'no result'}`);
  return [
    checkLine('(a) the boss answered with the background lex result', `the result names 4 (one run, else at most ${LIMITS.maxResumeRounds} resume rounds)`,
      `${a?.mode ?? 'not run'}: ${JSON.stringify(a?.text ?? '')}`, a?.done === true),
    checkLine('(b) a guard ask left a guard log line with the session id', `at least 1 line of session ${bc?.sessionId ?? '?'}`,
      `${guard.length} line(s): ${guard.map((line) => line.outcome).join(', ') || 'none'}`, guard.length > 0),
    checkLine('(c) the guard ask reached the scripted dialog', 'at least 1 dialog call', `${dialogs} call(s)`, dialogs >= 1),
    checkLine(`(d) the wait ceiling held a background lex for ${LIMITS.e0dMinAgentMinutes} min`,
      `the reply ${DONE_12} in the same run, a lex transcript spanning at least ${LIMITS.e0dMinAgentMinutes} min`,
      `reply ${JSON.stringify(textOf(d).slice(0, 60))}, longest lex ${longest.toFixed(1)} min, agents ${agentsOf(ctx, 'lex').length}`,
      textOf(d).includes(DONE_12) && longest >= LIMITS.e0dMinAgentMinutes),
    { ...checkLine('(e) every nested claude ran logged in on the subscription', 'apiKeySource none, a result, no login error, in every run',
      loginTrouble.length === 0 ? `${ctx.sessions.length} run(s) logged in` : loginTrouble.join('; '), loginTrouble.length === 0 && ctx.sessions.length > 0), gate: true },
  ];
}
