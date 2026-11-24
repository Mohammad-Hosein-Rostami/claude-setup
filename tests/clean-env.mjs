// The one environment every spawned hook, tool or script gets in a test. Exports: OUR_SWITCH, cleanEnv(extra).
// Why: a test run from a Claude Code session inherits the owner's switches (CLAUDE_GUARD_ASK=allow, CLAUDE_GUARD_TRIM,
// CLAUDE_POST_EDIT_TRUST_FORMAT, CLAUDE_PERMISSION_TIMEOUT_S, ...) and the session's own markers (CLAUDE_CODE_SESSION_ID,
// CLAUDECODE, ...); a child that reads them answers differently there than in a plain terminal (allow where a test expects ask).
// A test that needs one passes it in `extra`. tests/hook-env.mjs builds hookEnv on it; tests/pin-home.mjs drops the same names from
// the test process itself, for modules a test imports.
// Invariants: process.env is read, never changed; `extra` wins over everything.

/** A name the setup or Claude Code reads as a switch or a session marker: every `CLAUDE_*` and `CLAUDECODE`. */
export const OUR_SWITCH = /^CLAUDE(?:_|CODE$)/;

/**
 * @param {Record<string, string | undefined>} extra variables added on top (they win, `CLAUDE_*` ones too)
 * @returns {Record<string, string | undefined>} a copy of process.env without OUR_SWITCH names, then `extra`
 */
export function cleanEnv(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !OUR_SWITCH.test(name))), ...extra };
}
