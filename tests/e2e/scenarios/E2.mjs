// E2, the main-agent cap (plan section 9): of four lex started at once three run and the fourth is denied with the running ids;
// once they ended a new lex starts; a dev's four dev-run helpers all start (helpers are not counted).
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { checkLine, LIMITS, startsOf } from '../lib/checks.mjs';
import { loaded } from '../lib/common.mjs';
import { makeLibrary } from '../lib/repo.mjs';

export const id = 'E2';
export const title = 'cap: three lex at once, the fourth denied; helpers not counted';
export const model = 'sonnet';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const AT_ONCE = 4;
const ID_PREFIX_CHARS = 7; // a deny may name an agent by a short id
const PROMPT_CAP = `Start ${AT_ONCE} lex agents at once, in one message, each in the background with the brief "Reply only ok.". `
  + 'Do not retry a start that is denied. When every started lex has ended, start one more lex with the same brief and wait for it. '
  + 'Then report which starts were denied, with the deny text.';
const PROMPT_HELPERS = `Start one dev agent with this brief: "Start ${AT_ONCE} dev-run helpers at once, in one message, each to run the Bash `
  + 'command echo ok and report its output. Report the four outputs." Wait for the dev, then report what it said.';

export function setup(ctx) {
  makeLibrary(ctx);
}

export async function run(ctx) {
  ctx.notes.cap = await ctx.claude({ name: 'cap-lex', prompt: PROMPT_CAP, model });
  ctx.notes.helpers = await ctx.claude({ name: 'helpers-dev-run', prompt: PROMPT_HELPERS, model });
}

export function check(ctx) {
  const capStarts = ctx.notes.cap ? startsOf(loaded(ctx, ctx.notes.cap).lines).filter((start) => start.type === 'lex') : [];
  const firstDenied = capStarts.findIndex((start) => start.denied);
  const before = firstDenied === -1 ? capStarts : capStarts.slice(0, firstDenied);
  const running = before.filter((start) => !start.denied);
  const deny = firstDenied === -1 ? null : capStarts[firstDenied];
  const namesRunning = deny !== null && running.some((start) => start.agentId
    && (deny.denyText.includes(start.agentId) || deny.denyText.includes(start.agentId.slice(0, ID_PREFIX_CHARS))));
  const later = firstDenied === -1 ? [] : capStarts.slice(firstDenied + 1).filter((start) => !start.denied);
  const helperSession = ctx.notes.helpers ? loaded(ctx, ctx.notes.helpers) : { agents: [] };
  const devRuns = helperSession.agents.filter((agent) => agent.type === 'dev').flatMap((agent) => startsOf(agent.lines)).filter((start) => start.type === 'dev-run');
  return [
    checkLine(`${LIMITS.mainAgentCap} lex start before the deny`, LIMITS.mainAgentCap, `${running.length} started, ${capStarts.length} lex call(s)`,
      running.length === LIMITS.mainAgentCap),
    checkLine('the 4th lex start is denied, naming the running ids', 'a deny that names a running lex', deny === null ? 'no deny' : deny.denyText.slice(0, 200),
      namesRunning),
    checkLine('after they ended a new lex starts', 'at least 1 lex start after the deny', `${later.length}`, later.length >= 1),
    checkLine(`all ${AT_ONCE} dev-run helpers start (helpers not counted)`, `${AT_ONCE} started, none denied`,
      `${devRuns.filter((start) => !start.denied).length} started, ${devRuns.filter((start) => start.denied).length} denied`,
      devRuns.filter((start) => !start.denied).length === AT_ONCE && devRuns.every((start) => !start.denied)),
  ];
}
