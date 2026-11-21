// Proof records of test-pass: what a test command run at a commit really did (counts and exit code read by the tool, never typed).
// Exports: PROOF_SUFFIX, ROLES, countsOf(text), verdictOf(counts, exit), writeProof(repoDir, row, env), proofsOf(repoDir, env).
// Why (R30): a model's "all pass" is not evidence; the record is. PASS or FAIL comes from the exit code and the test runner's own
//   summary (node --test TAP or spec reporter lines, or a JUnit XML report file), never from an agent's words.
// Invariants: one JSON row per run in ~/.claude/state/test-pass/<clone id>.proof.jsonl (the PASS store's folder and file rules,
//   lib/store.mjs); a failed run is recorded too; counts that cannot be read are null, and a null count never makes a PASS.
import { appendRecord, readRecords } from './store.mjs';

export const PROOF_SUFFIX = '.proof';
/** repro: the bug's failing-first test; acceptance: the spec's tests; keep-green: the lane's affected tests; suite: the full suite;
 *  target: a run on the real target (two clients, device, deployed URL); mutants: a mutant run (written by lib/mutants.mjs). */
export const ROLES = ['repro', 'acceptance', 'keep-green', 'suite', 'target', 'mutants'];

// node --test summary lines: `# pass 3` (tap) or `ℹ pass 3` (spec); the same names in both reporters.
const SUMMARY_LINE = /^(?:#|ℹ)\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/;
const JUNIT_SUITES = /<testsuites?\b[^>]*>/;
const XML_ATTRIBUTE = (name) => new RegExp(`\\b${name}="(\\d+)"`);
const TAP_SKIPPED = /^\s*ok \d+ - (.+?)\s+#\s*(?:SKIP|TODO)\b/i;

/** Counts from node --test output: { selected, passed, failed, skipped, skippedNames } or null when no summary is in the text. */
function countsFromSummary(text) {
  const seen = {};
  const skippedNames = [];
  for (const line of text.split('\n')) {
    const match = SUMMARY_LINE.exec(line.trim());
    if (match) seen[match[1]] = Number(match[2]);
    const skipped = TAP_SKIPPED.exec(line);
    if (skipped) skippedNames.push(skipped[1]);
  }
  if (seen.tests === undefined || seen.pass === undefined || seen.fail === undefined) return null;
  const skipped = (seen.skipped ?? 0) + (seen.todo ?? 0);
  return { selected: seen.tests, passed: seen.pass, failed: seen.fail + (seen.cancelled ?? 0), skipped, skippedNames };
}

/** Counts from a JUnit XML report (the first <testsuites> or <testsuite> element's attributes), or null. */
function countsFromJunit(text) {
  const element = JUNIT_SUITES.exec(text)?.[0];
  if (element === undefined) return null;
  const number = (name) => Number(XML_ATTRIBUTE(name).exec(element)?.[1] ?? 0);
  const selected = number('tests');
  const failed = number('failures') + number('errors');
  const skipped = number('skipped') + number('disabled');
  return { selected, passed: Math.max(0, selected - failed - skipped), failed, skipped, skippedNames: [] };
}

/**
 * The test counts in a runner's output or report file.
 * @param {string} text the captured output, or the report file's text
 * @returns {{selected: number, passed: number, failed: number, skipped: number, skippedNames: string[]} | null} null when unreadable
 */
export const countsOf = (text) => countsFromSummary(text) ?? countsFromJunit(text);

/** PASS only with exit 0, readable counts, at least one test run and passed, and none failed. */
export const verdictOf = (counts, exit) => (exit === 0 && counts !== null && counts.selected > 0 && counts.passed > 0 && counts.failed === 0 ? 'PASS' : 'FAIL');

/**
 * Appends one proof row for the clone of `repoDir`.
 * @param {string} repoDir a folder of the working tree
 * @param {object} row { sha, tree, cmd, role, tests, selected, passed, failed, skipped, skippedNames, exit, verdict, target?, mutants?, at }
 * @param {object} env decides the state folder (HOME)
 * @returns {boolean} false when the store is not usable
 */
export const writeProof = (repoDir, row, env = process.env) => appendRecord(repoDir, { kind: 'proof', ...row }, env, PROOF_SUFFIX);

/** Every proof row of the clone, oldest first ([] when none or the store is unusable). */
export const proofsOf = (repoDir, env = process.env) => readRecords(repoDir, env, PROOF_SUFFIX).filter((row) => row.kind === 'proof' && typeof row.sha === 'string');
