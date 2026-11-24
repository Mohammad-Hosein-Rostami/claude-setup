// Shorter test and build output for the Bash guard (audit item I10): a test or build run in the foreground can print thousands of
// lines, and every line costs context. For such a command the guard hands Claude Code a rewritten command (PreToolUse `updatedInput`)
// that writes the full output to a temp log, prints the log's path first (so a run the Bash tool kills on its timeout still names
// it), then only the last TRIM_LINES lines once the runner ends, and exits with the runner's own exit code. The log stays in the
// temp folder for the OS to clean, so it can be read after the call. Exports: trimAnswer(input, env) -> hook stdout ('' or the updatedInput JSON), trimmedCommand(command), isTrimmedRunner(command),
// TRIM_LINES, TRIM_ENV.
// Only plain runner calls are rewritten: `node --test`, `npm|pnpm|yarn test`, `npm|pnpm|yarn run build`, vitest, jest, pytest, `go test`,
// `cargo test`, after optional `NAME=value` words. Anything with a pipe, redirect, `;`, `&`, a substitution or a line break keeps its own
// output handling, as does a call sent with run_in_background (its output goes to a file already) or by any tool but Bash
// (PowerShell has other syntax; Monitor streams lines).
// Opt-in: CLAUDE_GUARD_TRIM=1 (in the env of a person's settings/local.json) turns it on; it is off by default. Why: no permission
// decision is given with the rewrite, so the normal permission flow applies to the REWRITTEN command (Claude Code 2.1.330 applies
// updatedInput without one; docs: hooks "PreToolUse decision control"), and a project allow rule such as `Bash(pnpm test:*)` no
// longer matches it: everyone on by default would get prompts they do not get today.
// Invariants: pure apart from reading env; every other field of the tool input is kept (updatedInput replaces the whole input).

export const TRIM_LINES = 150; // enough for a failure summary and its stack, far less than a full run
export const TRIM_ENV = 'CLAUDE_GUARD_TRIM'; // '1' turns the rewrite on (see the header)
const BASH_TOOL = 'Bash';
const ASSIGNMENT = /^[A-Za-z_]\w*=\S*$/; // `CI=1 pnpm test`
const SHELL_SYNTAX = /[|&;<>`\n\r]|\$\(/; // pipes, lists, redirects, substitutions: the command handles its own output
const RUNNERS = [
  /^node\s+--test(?:\s|$)/,
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+build)(?:\s|$)/,
  /^(?:vitest|jest|pytest)(?:\s|$)/,
  /^(?:go|cargo)\s+test(?:\s|$)/,
];

/**
 * @param {string} command the Bash command text
 * @returns {boolean} true for a plain call of a test or build runner, which the guard rewrites
 */
export function isTrimmedRunner(command) {
  if (SHELL_SYNTAX.test(command)) return false;
  const words = command.trim().split(/\s+/);
  const firstCommandWord = words.findIndex((word) => !ASSIGNMENT.test(word));
  if (firstCommandWord === -1) return false;
  const runner = words.slice(firstCommandWord).join(' ');
  return RUNNERS.some((pattern) => pattern.test(runner));
}

/**
 * The runner command wrapped so its output goes to a temp log, named before the run, and only the end of it is printed. The line break before `}` keeps
 * the brace out of a trailing comment; `(exit N)` sets the exit status without leaving the shell the Bash tool runs in.
 * @param {string} command a command isTrimmedRunner accepts
 * @returns {string} the rewritten command
 */
export function trimmedCommand(command) {
  return `__guard_log=$(mktemp) && echo "[guard: full log: $__guard_log; its last ${TRIM_LINES} lines follow when the run ends]" && `
    + `{ ${command}\n} > "$__guard_log" 2>&1; __guard_status=$?; tail -n ${TRIM_LINES} "$__guard_log"; (exit $__guard_status)`;
}

/**
 * The hook's answer for a Bash call the guard lets run: the rewrite for a plain test or build runner, else nothing.
 * @param {{tool_name?: string, tool_input: {command: string, run_in_background?: boolean}}} input the hook input
 * @param {Record<string, string | undefined>} env process environment (TRIM_ENV)
 * @returns {string} hook stdout: '' (run as sent) or one PreToolUse JSON line with updatedInput
 */
export function trimAnswer(input, env = process.env) {
  const { tool_input: toolInput } = input;
  const trims = env[TRIM_ENV] === '1' && input.tool_name === BASH_TOOL && toolInput.run_in_background !== true && isTrimmedRunner(toolInput.command);
  if (!trims) return '';
  const updatedInput = { ...toolInput, command: trimmedCommand(toolInput.command) };
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } })}\n`;
}
