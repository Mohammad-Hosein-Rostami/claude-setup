// Purpose: a timeout knob, a wait read from the environment so a test can make it short (tests/long-run-control.test.mjs,
//   tests/account-keychain.test.mjs). Used by driver.mjs, process-tree.mjs and scripts/doctor-accounts.mjs.
// Exports: msFromEnv.
// Invariants: a knob is named `CLAUDE_<TOOL>_<CONSTANT>` (CLAUDE_LONG_RUN_CONTROL_POLL_MS for driver.mjs CONTROL_POLL_MS);
//   only a positive whole number of milliseconds is taken, anything else gives the default, so an unset knob changes nothing.

/**
 * The environment variable `name` as a positive whole number of milliseconds, else `fallback`.
 * Why: the tests' waits are the production waits; a knob lets them run on a shorter one without a code path of their own.
 * @param {string} name the variable, `CLAUDE_<TOOL>_<CONSTANT>`.
 * @param {number} fallback the production value.
 * @returns {number} the knob's value, or `fallback` when it is unset, empty, text, 0, negative or a fraction.
 */
export function msFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
