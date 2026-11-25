// Purpose: a timeout knob, a wait read from the environment so a test can make it short. Used by driver.mjs, process-tree.mjs
//   and scripts/doctor-accounts.mjs.
// Exports: msFromEnv.
// Invariants: a knob is named `CLAUDE_<TOOL>_<CONSTANT>` (CLAUDE_LONG_RUN_CONTROL_POLL_MS for driver.mjs CONTROL_POLL_MS);
//   only digits, a whole number of milliseconds from 1 to MAX_TIMER_MS, are taken; anything else gives the default, so an
//   unset knob changes nothing.

// Node's longest timer, 2^31-1 ms (about 24.8 days): setTimeout and setInterval run a longer one after 1 ms
// (TimeoutOverflowWarning), so a huge knob would make the driver read its control files every millisecond.
const MAX_TIMER_MS = 2 ** 31 - 1;
// Digits only: Number() would also take '1e3', '0x10', '+5' and ' 250 ', which the docs promise keep the default.
const DIGITS_ONLY = /^\d+$/;

/**
 * The environment variable `name` as a whole number of milliseconds from 1 to MAX_TIMER_MS, else `fallback`.
 * Why: the tests' waits are the production waits; a knob lets them run on a shorter one without a code path of their own.
 * @param {string} name the variable, `CLAUDE_<TOOL>_<CONSTANT>`.
 * @param {number} fallback the production value.
 * @returns {number} the knob's value, or `fallback` when it is unset, empty, not digits only (text, a sign, a space, a
 *   fraction, an exponent, hex), 0 or over MAX_TIMER_MS.
 */
export function msFromEnv(name, fallback) {
  const text = process.env[name] ?? '';
  if (!DIGITS_ONLY.test(text)) return fallback;
  const value = Number(text);
  return value > 0 && value <= MAX_TIMER_MS ? value : fallback;
}
