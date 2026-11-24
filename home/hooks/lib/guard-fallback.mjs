// The Bash guard's hook input, and its answers when it cannot judge a command: input that is not hook JSON, and a failure in its own
// code. Exports: readHookInput() -> the hook input | undefined, plainAsk(reason, input) -> hook stdout, failedAnswer(error, input) ->
// hook stdout, GUARD_ERROR_REASON, UNREADABLE_INPUT_REASON (pre-bash-guard.mjs re-exports both).
// Invariant: never silence. A hook that prints nothing or exits non-zero lets the command run, so each path here prints the CLI's own
// ask. It is built here, not through lib/timed-ask.mjs: this path must not depend on the code that may just have failed. The log gets
// the reason (with the error class) and no command text.
import { logDecision } from './guard-log.mjs';

export const GUARD_ERROR_REASON = 'guard error';
export const UNREADABLE_INPUT_REASON = 'the guard could not read its input (not hook JSON with a string command): read the command yourself before allowing';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @returns {Promise<{tool_input: {command: string}} | undefined>} the hook input from stdin, or undefined for anything that is not JSON
 *   with a string command (truncated or empty text, a BOM, an array, no tool_input); the caller then asks
 */
export async function readHookInput() {
  try {
    const input = JSON.parse(await readStdin());
    return typeof input?.tool_input?.command === 'string' ? input : undefined;
  } catch {
    return undefined; // the caller asks: exit 0 with no output would let the call run unchecked
  }
}

/**
 * @param {string} reason why the guard asks
 * @param {{cwd?: string, session_id?: string}} input the hook input ({} when it could not be read)
 * @returns {string} the hook stdout line of a plain CLI ask, logged as `guard-error`
 */
export function plainAsk(reason, input) {
  const entry = { hook: 'pre-bash-guard', tool: 'Bash', decision: 'ask', outcome: 'guard-error', reason, command: '', cwd: input.cwd };
  logDecision({ ...entry, session: input.session_id });
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })}\n`;
}

/**
 * @param {unknown} error what the guard threw after it read a command
 * @param {{cwd?: string, session_id?: string}} input the hook input
 * @returns {string} the plain ask naming the error class
 */
export const failedAnswer = (error, input) => plainAsk(`${GUARD_ERROR_REASON}: ${error instanceof Error ? error.name : typeof error}`, input);
