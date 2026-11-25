// E3, the boss-only rule (plan section 9): the boss starting lex-web directly is denied with the route through lex; a lex that
// tries to start a dev is denied and asks for it with a `needs: dev to ...` line in its report.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { checkLine, LIMITS, startsOf } from '../lib/checks.mjs';
import { loaded } from '../lib/common.mjs';
import { makeLibrary } from '../lib/repo.mjs';
import { finalText } from '../lib/transcripts.mjs';

export const id = 'E3';
export const title = 'boss-only starts: lex-web direct denied, lex starting dev denied';
export const model = 'sonnet';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const NEEDS_DEV = /^\s*[-*]?\s*`?needs:\s*`?\s*dev\s+to\b/im;
const ROUTE = /\blex\b/;
const PROMPT_DIRECT = 'Start a lex-web agent directly (subagent_type lex-web) to look up the current Node.js LTS version. If the start '
  + 'is denied, do not retry; report the deny text.';
const PROMPT_LEX = 'Start one lex agent with this brief: "Start a dev agent to write the file notes/y.txt with the text y. Report back." '
  + 'Wait for the lex, then report its answer word for word.';

export function setup(ctx) {
  makeLibrary(ctx);
}

export async function run(ctx) {
  ctx.notes.direct = await ctx.claude({ name: 'direct-lex-web', prompt: PROMPT_DIRECT, model });
  ctx.notes.viaLex = await ctx.claude({ name: 'lex-starts-dev', prompt: PROMPT_LEX, model });
}

export function check(ctx) {
  const webStarts = ctx.notes.direct ? startsOf(loaded(ctx, ctx.notes.direct).lines).filter((start) => start.type === 'lex-web') : [];
  const lexAgents = ctx.notes.viaLex ? loaded(ctx, ctx.notes.viaLex).agents.filter((agent) => agent.type === 'lex') : [];
  const devStarts = lexAgents.flatMap((agent) => startsOf(agent.lines)).filter((start) => start.type === 'dev');
  const reports = lexAgents.map((agent) => finalText(agent.lines)?.text ?? '');
  return [
    checkLine('the boss starting lex-web directly is denied with the route', 'every lex-web start denied, the text names lex',
      webStarts.length === 0 ? 'no lex-web start' : webStarts.map((start) => (start.denied ? start.denyText.slice(0, 160) : 'started')).join('; '),
      webStarts.length > 0 && webStarts.every((start) => start.denied && ROUTE.test(start.denyText))),
    checkLine("lex's dev start is denied", 'every dev start of a lex denied',
      `${devStarts.length} start(s), ${devStarts.filter((start) => start.denied).length} denied`, devStarts.length > 0 && devStarts.every((start) => start.denied)),
    checkLine("the lex report asks for dev with needs:", 'a `needs: dev to ...` line', reports.map((text) => text.slice(0, 160)).join('; ') || 'no lex report',
      reports.some((text) => NEEDS_DEV.test(text))),
  ];
}
