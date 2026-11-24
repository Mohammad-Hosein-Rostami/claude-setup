// The no-Fable gate's reasons, one per place the model of an agent comes from (agent-model-gates.mjs fableReason decides which
// place counts): the Agent call's `model`, the agent file's pin, and CLAUDE_CODE_SUBAGENT_MODEL for a file that pins none.
// Owner rule: Fable is chosen by hand only, never for an agent, so each reason denies a Fable model and any model this hook cannot
// see: `inherit` (the lead's model, which may be Fable) and the aliases Claude Code resolves only at run time (RUN_TIME_ALIAS).
// CLAUDE_CODE_SUBAGENT_MODEL_FORCE: when it is on, Claude Code ignores the call's `model` (all but `inherit`) and the agent file's
// pin, and runs every agent on CLAUDE_CODE_SUBAGENT_MODEL, else on the lead's model (read in the 2.1.330 bundle: cht() and aJo(),
// the subagent model resolution; the Agent tool then has no `model` field at all). It is on exactly as Claude Code reads a boolean
// env value (the registry's `L.bool()`, Ne(): `1`, `true`, `yes` or `on`, any case, trimmed); any other value leaves it off, and
// then the call's model and the pin decide as usual. With it on, the call's model is still checked too (a Fable call is denied in
// every case), and CLAUDE_CODE_SUBAGENT_MODEL must be a concrete model other than Fable.
// ANTHROPIC_DEFAULT_OPUS_MODEL, _SONNET_, _HAIKU_ and ANTHROPIC_DEFAULT_MODEL re-point the aliases (`opus`, `sonnet`, `haiku`,
// `default`) to another model (2.1.330 names them in its model env list); one that names Fable turns every agent on that alias into
// a Fable agent, so while one does, every Agent call is denied (remappedAliasReason).
// Exports: FABLE_RULE, NAME_A_MODEL, callModelReason(model), foundPinReason(type, pin, env, isPlainModelName), isModelForced(env),
// forcedModelReason(callModel, env), remappedAliasReason(env), unreadableSettingsReason(file, cause).
// Invariants: pure (reads only its arguments); each reason is one line of fixed text plus quoted values.
import { quotedValue } from './agent-brief.mjs';

const FABLE_MODEL = /fable/i; // the alias `fable` and every Fable model id
const INHERIT_MODEL = /^\s*inherit\s*$/i; // the agent runs on the lead's model, which the hook cannot see
// Aliases Claude Code resolves at run time to a model the hook cannot see (2.1.330 bundle, yW() and Xd()): `best` is the account's
// most capable model, which may be Fable; `default` is the account's default model; `opusplan` is Opus in plan mode and Sonnet
// otherwise. An agent names a concrete model instead. `[1m]` asks for the 1M context window of the same model.
const RUN_TIME_ALIAS = /^(best|default|opusplan)(\[1m\])?$/i;
const ALIAS_NOTE = 'an alias Claude Code resolves only at run time (`best` may be Fable; `default` and `opusplan` depend on the account and mode)';
const FORCE_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';
const FORCE_ON_VALUES = ['1', 'true', 'yes', 'on']; // Claude Code's Ne(), after lower case and trim
// The env variables that re-point a model alias, with no Fable one (the `fable` alias is denied already)
const ALIAS_TARGET_ENV = /^ANTHROPIC_DEFAULT_(?:(?:OPUS|SONNET|HAIKU)_)?MODEL$/;
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
 * Whether CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, read as Claude Code reads it (see the header): then CLAUDE_CODE_SUBAGENT_MODEL
 * decides the agent's model.
 * @param {Record<string, string | undefined>} env one env the session may run with (lib/settings-env.mjs possibleEnvs)
 * @returns {boolean} true only for `1`, `true`, `yes` or `on` (any case, trimmed)
 */
export function isModelForced(env) {
  const value = env[FORCE_ENV];
  return typeof value === 'string' && FORCE_ON_VALUES.includes(value.toLowerCase().trim());
}

/**
 * The no-Fable reason while an alias env variable (see the header) names Fable, else ''.
 * @param {Record<string, string | undefined>} env the hook's environment
 * @returns {string} one line naming the variables and the first value
 */
export function remappedAliasReason(env) {
  const names = Object.keys(env).filter((name) => ALIAS_TARGET_ENV.test(name) && typeof env[name] === 'string' && FABLE_MODEL.test(env[name]));
  if (names.length === 0) return '';
  return `${FABLE_RULE}: ${names.join(', ')} points a model alias at \`${quotedValue(env[names[0]])}\`, so an agent on that alias would run on Fable; `
    + 'remove it from the environment or the settings `env`, then launch again.';
}

/**
 * The no-Fable reason while a settings file exists but cannot be read: its `env` may name Fable (lib/settings-env.mjs).
 * @param {string} file the settings file
 * @param {string} cause why it cannot be read (lib/settings-env.mjs unreadableCause; never a value from the file)
 * @returns {string} one line naming the file, the cause and what a readable file looks like
 */
export function unreadableSettingsReason(file, cause) {
  return `${FABLE_RULE}: the settings file \`${quotedValue(file)}\` cannot be read (${quotedValue(cause)}), so its \`env\` may point an agent at Fable; `
    + 'fix the file, then launch again: it must be empty or a JSON object whose `env` is an object of text, number or true/false values.';
}

/**
 * The no-Fable reason while CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on: the agent runs on CLAUDE_CODE_SUBAGENT_MODEL, or on the lead's
 * model when that is unset or `inherit`, or when the call asks for `model: inherit` (the one call value Claude Code still honours).
 * A Fable or alias call model is denied too, though Claude Code would ignore it: a Fable call is never let through.
 * @param {unknown} callModel the Agent call's `model` (undefined or '' when it names none)
 * @param {Record<string, string | undefined>} env CLAUDE_CODE_SUBAGENT_MODEL
 * @returns {string} the one-line deny reason, or '' when the forced model is a concrete model other than Fable
 */
export function forcedModelReason(callModel, env) {
  const turnOff = `set CLAUDE_CODE_SUBAGENT_MODEL to a concrete model other than Fable, or turn ${FORCE_ENV} off`;
  const callReason = callModel === undefined || callModel === '' ? '' : callModelReason(callModel);
  if (callReason !== '') return callReason;
  const model = typeof env.CLAUDE_CODE_SUBAGENT_MODEL === 'string' ? env.CLAUDE_CODE_SUBAGENT_MODEL.trim() : '';
  if (model === '' || INHERIT_MODEL.test(model)) {
    return `${FABLE_RULE}: ${FORCE_ENV} is on and CLAUDE_CODE_SUBAGENT_MODEL names no model, so every agent runs on the lead's model, which may be Fable; ${turnOff}.`;
  }
  if (FABLE_MODEL.test(model) || isRunTimeAlias(model)) {
    return `${FABLE_RULE}: ${FORCE_ENV} is on, so every agent runs on CLAUDE_CODE_SUBAGENT_MODEL \`${quotedValue(model)}\`, which is Fable or ${ALIAS_NOTE}; ${turnOff}.`;
  }
  return '';
}
