// The no-Fable gate's reasons, one per place the model of an agent comes from (agent-model-gates.mjs fableReason decides which
// place counts): the Agent call's `model`, the agent file's pin, and CLAUDE_CODE_SUBAGENT_MODEL for a file that pins none.
// Owner rule: Fable is chosen by hand only, never for an agent, so each reason denies a Fable model and any model this hook cannot
// see: `inherit` (the lead's model, which may be Fable) and the aliases Claude Code resolves only at run time (RUN_TIME_ALIAS).
// CLAUDE_CODE_SUBAGENT_MODEL_FORCE: when it is on, Claude Code ignores the call's `model` (all but `inherit`) and the agent file's
// pin, and runs every agent on CLAUDE_CODE_SUBAGENT_MODEL, else on the lead's model (read in the 2.1.330 bundle: cht() and aJo(),
// the subagent model resolution; the Agent tool then has no `model` field at all). So with it on, only that env value counts.
// Exports: FABLE_RULE, NAME_A_MODEL, callModelReason(model), foundPinReason(type, pin, env, isPlainModelName), isModelForced(env),
// forcedModelReason(callModel, env).
// Invariants: pure (reads only its arguments); each reason is one line of fixed text plus quoted values.
import { quotedValue } from './agent-brief.mjs';

const FABLE_MODEL = /fable/i; // the alias `fable` and every Fable model id
const INHERIT_MODEL = /^inherit$/i; // the agent runs on the lead's model, which the hook cannot see
// Aliases Claude Code resolves at run time to a model the hook cannot see (2.1.330 bundle, yW() and Xd()): `best` is the account's
// most capable model, which may be Fable; `default` is the account's default model; `opusplan` is Opus in plan mode and Sonnet
// otherwise. An agent names a concrete model instead. `[1m]` asks for the 1M context window of the same model.
const RUN_TIME_ALIAS = /^(best|default|opusplan)(\[1m\])?$/i;
const ALIAS_NOTE = 'an alias Claude Code resolves only at run time (`best` may be Fable; `default` and `opusplan` depend on the account and mode)';
const FORCE_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';
// Values that leave the force off. Anything else counts as on: a wrong guess then only asks for a non-Fable
// CLAUDE_CODE_SUBAGENT_MODEL, which the shipped settings set.
const FORCE_OFF = /^(|0|false|no|off)$/i;
const isRunTimeAlias = (model) => RUN_TIME_ALIAS.test(model.trim());
export const FABLE_RULE = 'Not started: Fable is never used for an agent (the owner chooses it by hand only)';
// Names the model the agent should run on, never a lower one: the shipped pins are opus for lex and dev, sonnet for tess
export const NAME_A_MODEL = 'name the model its agent file should pin in the Agent call, never Fable (`model: "opus"` for lex and dev, `"sonnet"` for tess)';

/** The reason for a call that names its model, or '' when that model is neither Fable, a run-time alias nor `inherit`. */
export function callModelReason(model) {
  if (typeof model !== 'string') return `${FABLE_RULE}: the call's \`model\` is not text, so the model is unknown; ${NAME_A_MODEL}.`;
  if (FABLE_MODEL.test(model)) return `${FABLE_RULE}: leave \`model\` out of the Agent call (it was \`${quotedValue(model)}\`).`;
  if (isRunTimeAlias(model)) return `${FABLE_RULE}: the call's \`model\` \`${quotedValue(model)}\` is ${ALIAS_NOTE}; ${NAME_A_MODEL}.`;
  if (INHERIT_MODEL.test(model)) return `${FABLE_RULE}: \`model: inherit\` runs the agent on the lead's model, which may be Fable; ${NAME_A_MODEL}.`;
  return '';
}

/** The reason for the pin of an agent file found for `type`, or '' when it runs on a known model other than Fable. */
export function foundPinReason(type, pin, env, isPlainModelName) {
  const shown = quotedValue(type);
  if (typeof pin.model === 'string' && FABLE_MODEL.test(pin.model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent file pins \`${quotedValue(pin.model)}\`; change its \`model\` line, and leave \`model\` out of the Agent call.`;
  }
  if (typeof pin.model === 'string' && isRunTimeAlias(pin.model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent file pins \`${quotedValue(pin.model)}\`, ${ALIAS_NOTE}; pin a concrete model in its \`model\` line, or ${NAME_A_MODEL}.`;
  }
  const fallback = env.CLAUDE_CODE_SUBAGENT_MODEL; // what Claude Code uses for a file with no model line (lib/agent-pins.mjs header)
  const model = pin.model ?? (typeof fallback === 'string' && fallback !== '' ? fallback : null);
  if (model !== null && !isPlainModelName(model)) { // quoted with escapes, a block scalar, a value below its line: not read as written
    return `${FABLE_RULE}: the \`${shown}\` agent's model \`${quotedValue(model)}\` is not a plain model name, so what it runs on is unknown; ${NAME_A_MODEL}.`;
  }
  if (pin.model === null && model !== null && (FABLE_MODEL.test(model) || isRunTimeAlias(model))) {
    return `${FABLE_RULE}: the \`${shown}\` agent file pins no model and CLAUDE_CODE_SUBAGENT_MODEL is \`${quotedValue(model)}\`; ${NAME_A_MODEL}.`;
  }
  if (model === null || INHERIT_MODEL.test(model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent would run on the lead's model (no model pinned, or \`inherit\`), which may be Fable; ${NAME_A_MODEL}, or pin one in its file.`;
  }
  return '';
}

/**
 * Whether CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on (see the header): then only CLAUDE_CODE_SUBAGENT_MODEL decides the agent's model.
 * @param {Record<string, string | undefined>} env the hook's environment (Claude Code passes the settings `env` to it)
 * @returns {boolean} true unless the variable is unset, empty, `0`, `false`, `no` or `off`
 */
export function isModelForced(env) {
  const value = env[FORCE_ENV];
  return typeof value === 'string' && !FORCE_OFF.test(value.trim());
}

/**
 * The no-Fable reason while CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on: the agent runs on CLAUDE_CODE_SUBAGENT_MODEL, or on the lead's
 * model when that is unset or `inherit`, or when the call asks for `model: inherit` (the one call value Claude Code still honours).
 * @param {unknown} callModel the Agent call's `model`
 * @param {Record<string, string | undefined>} env CLAUDE_CODE_SUBAGENT_MODEL
 * @returns {string} the one-line deny reason, or '' when the forced model is a concrete model other than Fable
 */
export function forcedModelReason(callModel, env) {
  const turnOff = `set CLAUDE_CODE_SUBAGENT_MODEL to a concrete model other than Fable, or turn ${FORCE_ENV} off`;
  if (typeof callModel === 'string' && INHERIT_MODEL.test(callModel.trim())) return callModelReason(callModel);
  const model = typeof env.CLAUDE_CODE_SUBAGENT_MODEL === 'string' ? env.CLAUDE_CODE_SUBAGENT_MODEL.trim() : '';
  if (model === '' || INHERIT_MODEL.test(model)) {
    return `${FABLE_RULE}: ${FORCE_ENV} is on and CLAUDE_CODE_SUBAGENT_MODEL names no model, so every agent runs on the lead's model, which may be Fable; ${turnOff}.`;
  }
  if (FABLE_MODEL.test(model) || isRunTimeAlias(model)) {
    return `${FABLE_RULE}: ${FORCE_ENV} is on, so every agent runs on CLAUDE_CODE_SUBAGENT_MODEL \`${quotedValue(model)}\`, which is Fable or ${ALIAS_NOTE}; ${turnOff}.`;
  }
  return '';
}
