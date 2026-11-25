// The one place the e2e harness builds a `claude` argv, so no run can start without a named subscription model.
// Exports: ALLOWED_MODELS, PRINT_FLAGS, assertModel(model), claudeArgs({prompt, model, resume}), modelOfArgs(args).
// Why: the owner's rule (subscription only, never Fable, never usage credits): every `claude -p` names `--model opus`, `--model
// sonnet` or the full `claude-sonnet-5-5` / `claude-opus-5-5` id. An alias Claude Code resolves at run time (`best`, `default`,
// `opusplan`) or any other name could land on a model the owner did not pick, so only the allowlist passes; everything else throws.
// Invariants: the argv always holds exactly one `--model <allowed>`; the prompt is one argument (never split, never a shell string);
// the permission mode and output flags are the plan's (section 9) and the same for every scenario.

/** The only models a scenario may name: the plan's two aliases and the full ids section 9 uses (E9's long-run job). */
export const ALLOWED_MODELS = Object.freeze(['opus', 'sonnet', 'claude-opus-5-5', 'claude-sonnet-5-5']);

/** Flags of every run: the stream the checkers read and the owner's usual permission mode (plan U5). */
export const PRINT_FLAGS = Object.freeze(['--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']);

const MODEL_FLAG = '--model';

/**
 * @param {unknown} model the model a scenario names
 * @returns {string} the model, when it is on ALLOWED_MODELS
 * @throws {Error} for a missing model or any name off the allowlist (run-time aliases included)
 */
export function assertModel(model) {
  if (typeof model !== 'string' || model.trim() === '') throw new Error('e2e: every claude run must name --model (opus or sonnet); none was given');
  if (!ALLOWED_MODELS.includes(model)) {
    throw new Error(`e2e: model "${model}" is not allowed; use one of ${ALLOWED_MODELS.join(', ')} (subscription only, no run-time alias)`);
  }
  return model;
}

/**
 * @param {{prompt: string, model: string, resume?: string | null}} run the owner words, the model, and a session id to continue
 * @returns {string[]} `-p <prompt> --model <model> <PRINT_FLAGS> [--resume <id>]`
 * @throws {Error} when the model is missing or not allowed, or the prompt is empty
 */
export function claudeArgs({ prompt, model, resume = null }) {
  assertModel(model);
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('e2e: a claude run needs the owner words (prompt)');
  const args = ['-p', prompt, MODEL_FLAG, model, ...PRINT_FLAGS];
  if (resume !== null) args.push('--resume', resume);
  return args;
}

/**
 * @param {string[]} args a claude argv
 * @returns {string | null} the value of its one `--model` flag, or null when there is none or more than one
 */
export function modelOfArgs(args) {
  const at = args.flatMap((arg, index) => (arg === MODEL_FLAG ? [index] : []));
  return at.length === 1 ? (args[at[0] + 1] ?? null) : null;
}
