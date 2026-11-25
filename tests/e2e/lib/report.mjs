// How the runner prints its check lines and writes results.json. Exports: OBSERVED_MAX_CHARS, EXIT, statusOf(line),
// notRunLine(check, reason), formatLine(scenarioId, line), exitCodeOf({lines, limit, login}), writeResults(outDir, results).
// Line format (plan Lane C): `<scenario> <check> | <expected> | <observed> | PASS|FAIL|NOT RUN`, one per check, redacted.
// NOT RUN (a scenario that cannot run here: Windows, E9 without --real-home, the E0(e) gate) is never a pass: it counts like a
// FAIL for the exit code (plan section 10: empty is not clean), and the line says why.
// Invariants: every printed or written text goes through the redactor first; results.json is owner-only (0600).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, redactJson } from './redact.mjs';

export const OBSERVED_MAX_CHARS = 400;
/** The runner's exit codes (plan Lane C). */
export const EXIT = Object.freeze({ pass: 0, fail: 1, usage: 2, limit: 3 });

/** @returns {'PASS' | 'FAIL' | 'NOT RUN'} */
export const statusOf = (line) => (line.notRun === true ? 'NOT RUN' : line.pass === true ? 'PASS' : 'FAIL');

/** @returns {object} a line for a check that could not run, with the reason as its observed value */
export const notRunLine = (check, reason) => ({ check, expected: 'the scenario runs', observed: `not run: ${reason}`, pass: false, notRun: true });

const cut = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > OBSERVED_MAX_CHARS ? `${flat.slice(0, OBSERVED_MAX_CHARS)}...` : flat;
};

/** @returns {string} one printed line */
export const formatLine = (scenarioId, line) => redact(`${scenarioId} ${line.check} | ${cut(line.expected)} | ${cut(line.observed)} | ${statusOf(line)}`);

/**
 * @param {{lines: object[], limit: object | null, login?: object | null}} run every check line of the run, the usage limit it
 *   stopped at and the login refusal it stopped at (the preflight's or a claude run's)
 * @returns {number} 2 at a login stop (the owner must log in first, like a usage error), else 3 at a limit, else 1 when any
 *   line is not PASS (or there is none), else 0
 */
export function exitCodeOf({ lines, limit, login = null }) {
  if (login) return EXIT.usage;
  if (limit) return EXIT.limit;
  return lines.length > 0 && lines.every((line) => statusOf(line) === 'PASS') ? EXIT.pass : EXIT.fail;
}

/** Writes `<outDir>/results.json` (redacted). @returns {string} its path */
export function writeResults(outDir, results) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = join(outDir, 'results.json');
  writeFileSync(file, `${redactJson(results)}\n`, { mode: 0o600 });
  return file;
}
