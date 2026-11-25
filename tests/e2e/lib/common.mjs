// Check lines every scenario gets, and small readers the scenarios share. Exports: loaded(ctx, session), loadedAll(ctx),
// agentsOf(ctx, type), gitOut(ctx, args, cwd), sessionLines(ctx), noFableLine(ctx), timeLine(ctx, minutes), commonLines(ctx, minutes),
// textOf(session).
// Why: plan section 10 (empty is not clean): a `claude` that exits early, a run with no result, a missing transcript or a
// scenario past its wall-clock budget is a FAIL line of its own, so a scenario's specific checks can never pass on nothing; and
// no scenario may run a Fable model anywhere (owner rule), so every scenario with a claude run gets that line.
// Invariants: reads only; a session is loaded once (by its stream's session id, from the HOME the children used).
import { checkLine, fableModels } from './checks.mjs';
import { loadSession } from './transcripts.mjs';

/** @returns {ReturnType<typeof loadSession>} the transcripts of one claude run (cached on the session) */
export function loaded(ctx, session) {
  session.loaded ??= session.sessionId ? loadSession(ctx.paths.projectsDir, session.sessionId) : { id: null, key: null, lines: [], agents: [] };
  return session.loaded;
}

/** @returns {ReturnType<typeof loadSession>[]} the transcripts of every claude run of the scenario, once per session id (a
 * `--resume` round may continue the same session) */
export function loadedAll(ctx) {
  const byId = new Map();
  for (const session of ctx.sessions) if (session.sessionId && !byId.has(session.sessionId)) byId.set(session.sessionId, loaded(ctx, session));
  return [...byId.values()];
}

/** @returns {object[]} every subagent of the given type in the scenario's sessions */
export const agentsOf = (ctx, type) => loadedAll(ctx).flatMap((session) => session.agents.filter((agent) => agent.type === type));

/** @returns {string} a git command's trimmed stdout ('' when it failed) */
export function gitOut(ctx, args, cwd = ctx.repo) {
  const out = ctx.git(args, { cwd });
  return out.code === 0 ? out.stdout.trim() : '';
}

/** @returns {string} the run's final result text */
export const textOf = (session) => String(session?.result?.result ?? '');

const exitText = (session) => {
  const { exit, result } = session;
  const parts = [`exit ${exit.code ?? exit.signal ?? 'none'}`];
  if (exit.timedOut) parts.push('timed out');
  if (exit.stopped) parts.push('stopped');
  if (exit.startError) parts.push(exit.startError);
  parts.push(result === null ? 'no result event' : result.is_error ? `error result: ${String(result.result ?? result.subtype).slice(0, 120)}` : 'result ok');
  return parts.join(', ');
};

/** @returns {object[]} two lines per claude run: it ended with a result, and its transcript exists */
export function sessionLines(ctx) {
  return ctx.sessions.filter((session) => !session.dry).flatMap((session) => {
    const transcript = loaded(ctx, session);
    return [
      checkLine(`${session.name}: claude ran to its result`, 'exit 0, a result event, not an error', exitText(session),
        session.exit.code === 0 && session.result !== null && session.result.is_error !== true),
      checkLine(`${session.name}: transcript found`, `session ${session.sessionId ?? '?'} under the HOME's projects`,
        transcript.lines.length > 0 ? `${transcript.lines.length} lines, ${transcript.agents.length} subagent(s)` : 'none', transcript.lines.length > 0),
    ];
  });
}

/** @returns {object | null} one line: no transcript or result of the scenario names a Fable model (null without a claude run) */
export function noFableLine(ctx) {
  const live = ctx.sessions.filter((session) => !session.dry);
  if (live.length === 0) return null;
  const found = [...new Set(live.flatMap((session) => fableModels(loaded(ctx, session), session.result)))];
  return checkLine('no Fable model in any transcript or result', 'none', found.length === 0 ? 'none' : found.join(', '), found.length === 0);
}

/** @returns {object} one line: the scenario ended within its wall-clock budget */
export const timeLine = (ctx, minutes) => checkLine(`finished within ${minutes} min`, 'no child timed out', ctx.timedOut ? 'a child timed out' : 'in time', !ctx.timedOut);

/** @returns {object[]} the lines every live scenario gets after its own */
export const commonLines = (ctx, minutes) => [...sessionLines(ctx), noFableLine(ctx), timeLine(ctx, minutes)].filter(Boolean);
