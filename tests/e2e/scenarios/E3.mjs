// E3, the boss-only rule (plan section 9): the boss starting lex-web directly is denied with the route through lex; a lex that
// tries to start a dev is denied and asks for it with a `needs: dev to ...` line in its report.
// Review round 2: a deny counts only with the guard's own route text (home/hooks/lib/agent-route.mjs), never a word "lex" that
// may be the one inside "lex-web" (an "Agent type lex-web not found" error is no route).
// Each claude run is a ctx.claudeJob (R8): once when E0 found the boss gets a background result in one run, else with
// `--resume` rounds until the job is done; a job left not done is its own FAIL line (jobs.mjs jobLine).
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { checkLine, LIMITS, startsOf } from '../lib/checks.mjs';
import { loaded } from '../lib/common.mjs';
import { redactedSlice } from '../lib/redact.mjs';
import { makeLibrary } from '../lib/repo.mjs';
import { finalText } from '../lib/transcripts.mjs';

export const id = 'E3';
export const title = 'boss-only starts: lex-web direct denied, lex starting dev denied';
export const model = 'sonnet';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const NEEDS_DEV = /^\s*[-*]?\s*`?needs:\s*`?\s*dev\s+to\b/im;
/** The text of agent-route.mjs's deny for a helper the boss starts: it names its owner (tests/e2e-traps.test.mjs pins it). */
export const HELPER_ROUTE = 'start lex with the brief';
/** The text of agent-route.mjs's deny for a main agent a subagent starts. */
export const SUBAGENT_ROUTE = 'agent route: only the boss starts lex, dev and tess';
const PROMPT_DIRECT = 'Start a lex-web agent directly (subagent_type lex-web) to look up the current Node.js LTS version. If the start '
  + 'is denied, do not retry; report the deny text.';
const PROMPT_LEX = 'Start one lex agent with this brief: "Start a dev agent to write the file notes/y.txt with the text y. Report back." '
  + 'Wait for the lex, then report its answer word for word.';

export function setup(ctx) {
  makeLibrary(ctx);
}

export async function run(ctx) {
  ctx.notes.direct = (await ctx.claudeJob({ name: 'direct-lex-web', prompt: PROMPT_DIRECT, model })).session;
  ctx.notes.viaLex = (await ctx.claudeJob({ name: 'lex-starts-dev', prompt: PROMPT_LEX, model })).session;
}

export function check(ctx) {
  const webStarts = ctx.notes.direct ? startsOf(loaded(ctx, ctx.notes.direct).lines).filter((start) => start.type === 'lex-web') : [];
  const lexAgents = ctx.notes.viaLex ? loaded(ctx, ctx.notes.viaLex).agents.filter((agent) => agent.type === 'lex') : [];
  const devStarts = lexAgents.flatMap((agent) => startsOf(agent.lines)).filter((start) => start.type === 'dev');
  const reports = lexAgents.map((agent) => finalText(agent.lines)?.text ?? '');
  return [
    checkLine('the boss starting lex-web directly is denied with the route', `every lex-web start denied with "${HELPER_ROUTE}"`,
      webStarts.length === 0 ? 'no lex-web start' : webStarts.map((start) => (start.denied ? redactedSlice(start.denyText, 160) : 'started')).join('; '),
      webStarts.length > 0 && webStarts.every((start) => start.denied && start.denyText.includes(HELPER_ROUTE))),
    checkLine("lex's dev start is denied", `every dev start of a lex denied with "${SUBAGENT_ROUTE}"`,
      `${devStarts.length} start(s), ${devStarts.filter((start) => start.denied && start.denyText.includes(SUBAGENT_ROUTE)).length} denied with the route`,
      devStarts.length > 0 && devStarts.every((start) => start.denied && start.denyText.includes(SUBAGENT_ROUTE))),
    checkLine("the lex report asks for dev with needs:", 'a `needs: dev to ...` line', reports.map((text) => redactedSlice(text, 160)).join('; ') || 'no lex report',
      reports.some((text) => NEEDS_DEV.test(text))),
  ];
}
