// E4, the Fable gate (plan section 9): a lex start that names the Fable model, then the run-time alias "best", and a second
// session whose opus alias is remapped to a Fable id are each denied; no subagent transcript names a Fable model.
// The deny cases below are the only places a scenario names that model (owner rule; the dry run marks their lines).
// Review round 2: a deny counts only when its text holds the gate's own rule (FABLE_RULE), so a crashed guard that denies
// everything is a FAIL here, not a pass.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { FABLE_RULE } from '../../../home/hooks/lib/fable-model-reasons.mjs';
import { checkLine, LIMITS, startsOf } from '../lib/checks.mjs';
import { loaded } from '../lib/common.mjs';
import { makeLibrary } from '../lib/repo.mjs';

export const id = 'E4';
export const title = 'Fable: every start that would run it is denied';
export const model = 'sonnet';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const NOTE = 'E4 deny case';
const DENY_MODELS = ['fable', 'best'];
const REMAP = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5-2' };
const PROMPT_MODELS = `Start a lex agent with model "${DENY_MODELS[0]}" and the brief "Reply ok.". Then start a lex agent with model `
  + `"${DENY_MODELS[1]}" and the same brief. Do not retry and do not change the model of either; report what happened to each start.`;
const PROMPT_REMAP = 'Start a lex agent with the brief "Reply ok." and report what happened to the start. Do not retry.';

export function setup(ctx) {
  makeLibrary(ctx);
}

export async function run(ctx) {
  ctx.notes.models = await ctx.claude({ name: 'model-names', prompt: PROMPT_MODELS, model, note: NOTE });
  ctx.notes.remap = await ctx.claude({ name: 'alias-remap', prompt: PROMPT_REMAP, model, extra: REMAP, note: NOTE });
}

const lexStarts = (ctx, session) => (session ? startsOf(loaded(ctx, session).lines).filter((start) => start.type === 'lex') : []);
const gated = (start) => start.denied && start.denyText.includes(FABLE_RULE);
const shown = (starts) => (starts.length === 0 ? 'no start'
  : starts.map((start) => `${start.model ?? 'pinned'}: ${gated(start) ? 'denied by the gate' : start.denied ? `denied: ${start.denyText.slice(0, 80)}` : 'started'}`).join(', '));

export function check(ctx) {
  const named = lexStarts(ctx, ctx.notes.models);
  const byModel = DENY_MODELS.map((name) => named.filter((start) => start.model === name));
  const remapped = lexStarts(ctx, ctx.notes.remap);
  return [
    ...DENY_MODELS.map((name, index) => checkLine(`a lex start with model "${name}" is denied`, 'at least 1 start, every one denied by the Fable gate',
      shown(byModel[index]), byModel[index].length > 0 && byModel[index].every(gated))),
    checkLine('a lex start with the opus alias remapped is denied', 'at least 1 start, every one denied by the Fable gate', shown(remapped),
      remapped.length > 0 && remapped.every(gated)),
  ];
}
