// The no-Fable gate's reasons, one per place the model of an agent comes from (agent-model-gates.mjs fableReason decides which
// place counts): the Agent call's `model`, the agent file's pin, and CLAUDE_CODE_SUBAGENT_MODEL for a file that pins none.
// Owner rule: Fable is chosen by hand only, never for an agent, so each reason denies a Fable model and any model this hook cannot
// see (`inherit`: the lead's model, which may be Fable).
// Exports: FABLE_RULE, NAME_A_MODEL, callModelReason(model), foundPinReason(type, pin, env, isPlainModelName).
// Invariants: pure (reads only its arguments); each reason is one line of fixed text plus quoted values.
import { quotedValue } from './agent-brief.mjs';

const FABLE_MODEL = /fable/i; // the alias `fable` and every Fable model id
const INHERIT_MODEL = /^inherit$/i; // the agent runs on the lead's model, which the hook cannot see
export const FABLE_RULE = 'Not started: Fable is never used for an agent (the owner chooses it by hand only)';
// Names the model the agent should run on, never a lower one: the shipped pins are opus for lex and dev, sonnet for tess
export const NAME_A_MODEL = 'name the model its agent file should pin in the Agent call, never Fable (`model: "opus"` for lex and dev, `"sonnet"` for tess)';

/** The reason for a call that names its model, or '' when that model is neither Fable nor `inherit`. */
export function callModelReason(model) {
  if (typeof model !== 'string') return `${FABLE_RULE}: the call's \`model\` is not text, so the model is unknown; ${NAME_A_MODEL}.`;
  if (FABLE_MODEL.test(model)) return `${FABLE_RULE}: leave \`model\` out of the Agent call (it was \`${quotedValue(model)}\`).`;
  if (INHERIT_MODEL.test(model)) return `${FABLE_RULE}: \`model: inherit\` runs the agent on the lead's model, which may be Fable; ${NAME_A_MODEL}.`;
  return '';
}

/** The reason for the pin of an agent file found for `type`, or '' when it runs on a known model other than Fable. */
export function foundPinReason(type, pin, env, isPlainModelName) {
  const shown = quotedValue(type);
  if (typeof pin.model === 'string' && FABLE_MODEL.test(pin.model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent file pins \`${quotedValue(pin.model)}\`; change its \`model\` line, and leave \`model\` out of the Agent call.`;
  }
  const fallback = env.CLAUDE_CODE_SUBAGENT_MODEL; // what Claude Code uses for a file with no model line (lib/agent-pins.mjs header)
  const model = pin.model ?? (typeof fallback === 'string' && fallback !== '' ? fallback : null);
  if (model !== null && !isPlainModelName(model)) { // quoted with escapes, a block scalar, a value below its line: not read as written
    return `${FABLE_RULE}: the \`${shown}\` agent's model \`${quotedValue(model)}\` is not a plain model name, so what it runs on is unknown; ${NAME_A_MODEL}.`;
  }
  if (pin.model === null && model !== null && FABLE_MODEL.test(model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent file pins no model and CLAUDE_CODE_SUBAGENT_MODEL is \`${quotedValue(model)}\`; ${NAME_A_MODEL}.`;
  }
  if (model === null || INHERIT_MODEL.test(model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent would run on the lead's model (no model pinned, or \`inherit\`), which may be Fable; ${NAME_A_MODEL}, or pin one in its file.`;
  }
  return '';
}
