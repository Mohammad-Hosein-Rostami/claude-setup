// The `proof <sha>` check of test-pass: does the proof record of a commit back a hand-over, or must verify-done refuse it?
// Exports: checkProof({ sha, rows, isAncestor, handover, realTarget }) -> { ok, refusals, verdictLine }.
// Refuses (each a line in refusals): no record for exactly this sha (a record of another sha, the parent's included, never counts);
//   a record with 0 tests selected or unreadable counts; a stored verdict that its own exit code or counts contradict (PASS with
//   exit 1); a skipped test written as a pass; a repro whose same command was not red at an earlier commit; a hand-over that says
//   "all pass" over a failing record, types a test or mutant count the records do not hold, or types `mutants: k/n` with no mutant
//   run; a flow that needs the real target (two clients, device, deployed URL) with no passing `target` run at this sha.
// Invariants: pure; reads only the rows and the hand-over text it is given; the verdict line is built from the record, never from the
//   hand-over, so a runner agent can copy it as it is.
import { verdictOf } from './proof-store.mjs';

const SHORT = 8;
const ALL_PASS_CLAIM = /\ball\s+(?:tests?\s+)?(?:pass(?:ed|ing)?|green)\b|\btests?\s+(?:all\s+)?pass(?:ed)?\b/i;
const TYPED_MUTANTS = /\bmutants:\s*(\d+)\s*\/\s*(\d+)/gi;
const TYPED_PASSED = /\b(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b|\bpass(?:ed)?:\s*(\d+)/gi;
const TYPED_FAILED = /\b(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?\b|\bfail(?:ed)?:\s*(\d+)/gi;
const REAL_TARGET_LINE = /^\s*(?:[-*]\s*)?real target:\s*(?:needed|yes)\b/im;

/** The numbers a pattern finds in the text (first non-empty group of each match). */
const typedNumbers = (text, pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1] ?? match[2]));

/** Why one record cannot stand as proof, as lines. */
function recordProblems(row) {
  const name = `${row.role ?? 'run'} \`${row.cmd}\``;
  const problems = [];
  const counts = typeof row.selected === 'number' ? row : null;
  if (counts === null) problems.push(`${name}: no test counts could be read (give the runner's report file with --report)`);
  else if (counts.selected === 0) problems.push(`${name}: 0 tests selected (an empty filter proves nothing)`);
  if (row.verdict !== verdictOf(counts, row.exit)) problems.push(`${name}: the stored verdict ${row.verdict} does not match its exit code ${row.exit} and counts`);
  if (row.verdict === 'PASS' && counts !== null && counts.passed === 0 && counts.skipped > 0) problems.push(`${name}: only skipped tests: a skip is not a pass`);
  const skippedNamed = (row.tests ?? []).filter((id) => (row.skippedNames ?? []).some((skipped) => skipped.includes(id)));
  if (skippedNamed.length > 0) problems.push(`${name}: named tests were skipped, not passed: ${skippedNamed.join(', ')}`);
  return problems;
}

/** A repro counts only when the same command was red (exit not 0) at an earlier commit than the fix. */
function reproProblems(rows, records, isAncestor) {
  return records.filter((row) => row.role === 'repro').flatMap((repro) => {
    const redBefore = rows.some((row) => row.cmd === repro.cmd && row.sha !== repro.sha && row.exit !== 0 && isAncestor(row.sha, repro.sha));
    return redBefore ? [] : [`repro \`${repro.cmd}\`: no record shows it red at an earlier commit (record it with --role repro before the fix)`];
  });
}

/** What the hand-over text claims that the records do not hold. */
function handoverProblems(text, records) {
  const problems = [];
  if (ALL_PASS_CLAIM.test(text) && records.some((row) => row.verdict !== 'PASS')) problems.push('the hand-over says all pass, but a record at this sha failed');
  const mutantRuns = records.filter((row) => row.mutants);
  for (const [killed, n] of [...text.matchAll(TYPED_MUTANTS)].map((match) => [Number(match[1]), Number(match[2])])) {
    if (!mutantRuns.some((row) => row.mutants.killed === killed && row.mutants.n === n)) problems.push(`the hand-over types mutants: ${killed}/${n}, which no mutant run at this sha recorded`);
  }
  for (const passed of typedNumbers(text, TYPED_PASSED)) if (!records.some((row) => row.passed === passed)) problems.push(`the hand-over types ${passed} passed, which no record at this sha holds`);
  for (const failed of typedNumbers(text, TYPED_FAILED)) if (!records.some((row) => row.failed === failed)) problems.push(`the hand-over types ${failed} failed, which no record at this sha holds`);
  return problems;
}

/** The line a runner copies: counts of every record at the sha, from the records alone. */
function verdictLine(sha, records, ok) {
  const parts = records.map((row) => `${row.role ?? 'run'} \`${row.cmd}\`: ${row.verdict}, ${row.passed ?? '?'} passed, ${row.failed ?? '?'} failed, exit ${row.exit}${row.mutants ? `, mutants: ${row.mutants.killed}/${row.mutants.n}` : ''}`);
  return `verdict: ${ok ? 'PASS' : 'REFUSED'} (proof record ${sha.slice(0, SHORT)}${parts.length > 0 ? `; ${parts.join('; ')}` : ''})`;
}

/**
 * @param {{sha: string, rows: object[], isAncestor: (older: string, newer: string) => boolean, handover?: string, realTarget?: boolean}} input
 *   sha: the full commit sha handed over; rows: every proof row of the clone; handover: the hand-over text, when there is one;
 *   realTarget: the flow needs a run on the real target (also set by a `real target: needed` line in the hand-over)
 * @returns {{ok: boolean, refusals: string[], verdictLine: string}}
 */
export function checkProof({ sha, rows, isAncestor, handover = '', realTarget = false }) {
  const records = rows.filter((row) => row.sha === sha);
  const refusals = records.length === 0 ? [`no proof record for ${sha.slice(0, SHORT)} (a record of another sha, the parent's included, does not count)`] : [];
  for (const row of records.filter((entry) => !entry.mutants)) refusals.push(...recordProblems(row));
  refusals.push(...reproProblems(rows, records, isAncestor), ...handoverProblems(handover, records));
  const needsTarget = realTarget || REAL_TARGET_LINE.test(handover);
  if (needsTarget && !records.some((row) => row.role === 'target' && row.verdict === 'PASS')) refusals.push('the flow needs the real target (two clients, device, deployed URL) and no passing --role target run is recorded at this sha');
  return { ok: refusals.length === 0, refusals, verdictLine: verdictLine(sha, records, refusals.length === 0) };
}
