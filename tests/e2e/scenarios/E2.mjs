// E2, the main-agent cap (plan section 9): of four lex started at once three run and the fourth is denied with the running ids;
// once they ended a new lex starts; a dev's four dev-run helpers all start (helpers are not counted).
// Review round 2: the deny must name every running id, and "after they ended" needs a completed task-notification of each
// running lex before the later start (a start while they still run is a FAIL).
// Each claude run is a ctx.claudeJob (R8): once when E0 found the boss gets a background result in one run, else with
// `--resume` rounds until the job is done; a job left not done is its own FAIL line (jobs.mjs jobLine).
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { checkLine, completedAt, LIMITS, startsOf } from '../lib/checks.mjs';
import { loaded } from '../lib/common.mjs';
import { redactedSlice } from '../lib/redact.mjs';
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
  ctx.notes.cap = (await ctx.claudeJob({ name: 'cap-lex', prompt: PROMPT_CAP, model })).session;
  ctx.notes.helpers = (await ctx.claudeJob({ name: 'helpers-dev-run', prompt: PROMPT_HELPERS, model })).session;
}

export function check(ctx) {
  const capLines = ctx.notes.cap ? loaded(ctx, ctx.notes.cap).lines : [];
  const capStarts = startsOf(capLines).filter((start) => start.type === 'lex');
  const firstDenied = capStarts.findIndex((start) => start.denied);
  const before = firstDenied === -1 ? capStarts : capStarts.slice(0, firstDenied);
  const running = before.filter((start) => !start.denied);
  const deny = firstDenied === -1 ? null : capStarts[firstDenied];
  const namesRunning = deny !== null && running.length > 0 && running.every((start) => start.agentId
    && (deny.denyText.includes(start.agentId) || deny.denyText.includes(start.agentId.slice(0, ID_PREFIX_CHARS))));
  const ended = completedAt(capLines);
  const endedBefore = (start) => running.length > 0 && running.every((one) => one.agentId && ended.has(one.agentId)
    && ended.get(one.agentId) !== null && start.atMs !== null && ended.get(one.agentId) <= start.atMs);
  const laterStarts = firstDenied === -1 ? [] : capStarts.slice(firstDenied + 1).filter((start) => !start.denied);
  const later = laterStarts.filter(endedBefore);
  const helperSession = ctx.notes.helpers ? loaded(ctx, ctx.notes.helpers) : { agents: [] };
  const devRuns = helperSession.agents.filter((agent) => agent.type === 'dev').flatMap((agent) => startsOf(agent.lines)).filter((start) => start.type === 'dev-run');
  return [
    checkLine(`${LIMITS.mainAgentCap} lex start before the deny`, LIMITS.mainAgentCap, `${running.length} started, ${capStarts.length} lex call(s)`,
      running.length === LIMITS.mainAgentCap),
    checkLine('the 4th lex start is denied, naming the running ids', 'a deny that names every running lex', deny === null ? 'no deny' : redactedSlice(deny.denyText, 200),
      namesRunning),
    checkLine('after they ended a new lex starts', 'at least 1 lex start after a completed notice of each running lex',
      `${later.length} of ${laterStarts.length} later start(s); ${ended.size} completed notice(s)`, later.length >= 1),
    checkLine(`all ${AT_ONCE} dev-run helpers start (helpers not counted)`, `${AT_ONCE} started, none denied`,
      `${devRuns.filter((start) => !start.denied).length} started, ${devRuns.filter((start) => start.denied).length} denied`,
      devRuns.filter((start) => !start.denied).length === AT_ONCE && devRuns.every((start) => !start.denied)),
  ];
}
