// The words of a done-check run: the one status line the owner sees and the reason text an agent gets when its stop is blocked (design 3.4, 3.5).
// Exports: lineOf(row, options) -> string, reasonOf(summaries, options) -> string, KindSummary (type).
// Invariants: the line is a function of the ledger row (plus optional extra notes), so `done-check last` prints exactly what the run
//   printed, minus the notes (details a row does not hold: which package did not run). A kind that did not run is never shown as ok; a
//   kind with new failures says FAIL; `tests-weakened` is shown only when it fails. The reason lists at most MAX_REASON_LINES_PER_CHECK
//   failure lines per check and counts the rest; it holds tool text only after the parsers cut it to one line.
import { CHECK_KINDS, MAX_REASON_LINES_PER_CHECK } from './contract.mjs';

const MS_PER_SECOND = 1000;
const WHOLE_SECONDS_FROM_MS = 10 * MS_PER_SECOND; // under this a time shows one decimal (`0.4 s`), from it whole seconds
const WEAKENED = 'tests-weakened';

/**
 * What one check kind found, merged over its packages.
 * @typedef {object} KindSummary
 * @property {import('./contract.mjs').CheckKind} kind
 * @property {import('./contract.mjs').Result} result
 * @property {import('./contract.mjs').Failure[]} fresh failures the change caused (the base does not have them)
 * @property {import('./contract.mjs').Failure[]} old failures the base has too
 * @property {number} ms
 * @property {import('./contract.mjs').NotRunWhy} [why] set when the whole kind did not run
 */

const seconds = (ms) => `${(ms / MS_PER_SECOND).toFixed(ms < WHOLE_SECONDS_FROM_MS ? 1 : 0)} s`;
const oldNote = (check) => `${check.old > 0 ? `, ${check.old} old fail` : ''}${check.flaky > 0 ? `, ${check.flaky} flaky` : ''}`;

/** The part of the line for one kind, or null when the kind says nothing worth a part (the weakened-test scan, unless it fails). */
function partOf(kind, check, files) {
  if (kind === WEAKENED) return check.result === 'fail' ? `${kind} FAIL ${check.new}` : null;
  if (check.result === 'fail') return `${kind} FAIL ${check.new} new${oldNote(check)}`;
  if (check.result === 'none') return `${kind} none related (${files} files)`;
  if (check.result === 'not-run') return `${kind} not run (${check.why ?? 'error'})`;
  return `${kind} ok${oldNote(check)}`;
}

const kindParts = (row) => CHECK_KINDS.map((kind) => (row.checks[kind] ? partOf(kind, row.checks[kind], row.files) : null)).filter((part) => part !== null);
/** True when at least one check really ran and passed: only then is a reused run called ok. */
const somethingRan = (row) => Object.values(row.checks).some((check) => check.result === 'ok');

const failingKinds = (row) => CHECK_KINDS.filter((kind) => row.checks[kind]?.result === 'fail').map((kind) => `${kind} ${row.checks[kind].new}`);

/**
 * The one line for a run: `checks: types ok · tests ok, 1 old fail · 12 s · review: needed (security)`.
 * @param {import('./contract.mjs').RunRow} row the run row
 * @param {{ notes?: string[], tries?: number }} [options] `notes` are extra parts the row cannot hold (a package that did not run, a
 *   base that could not be compared); `tries` is the number of blocked stops that ended in `left open` (it adds the change-approach advice)
 * @returns {string} the line, without a line feed
 */
export function lineOf(row, { notes = [], tries = 0 } = {}) {
  const review = row.risk.length > 0 ? [`review: needed (${row.risk.join(', ')})`] : [];
  if (row.verdict === 'skipped') return [row.files === 0 ? 'checks: no code change' : 'checks: skipped by DONE_CHECK_SKIP=all', ...review].join(' · ');
  if (row.verdict === 'reused') return [`checks: reused (same change) ${somethingRan(row) ? 'ok' : kindParts(row).join(' · ')}`.trim(), ...notes, ...review].join(' · ');
  if (row.verdict === 'left-open') {
    const advice = tries > 0 ? ` after ${tries} tries: change approach` : '';
    return [`checks: FAIL left open (${failingKinds(row).join(', ')})${advice}`, ...notes, ...review].join(' · ');
  }
  const parts = kindParts(row);
  const base = row.base === null ? ['base: none'] : [];
  return `checks: ${[...parts, ...notes, ...base, seconds(row.ms), ...review].join(' · ')}`;
}

/** `file: text` unless the text already starts with the file (tsc and eslint texts do). */
const failureLine = (failure) => (failure.text.startsWith(failure.file) ? failure.text : `${failure.file}: ${failure.text}`);

/**
 * The text an agent reads when its stop is blocked: per failing check the new failures (at most MAX_REASON_LINES_PER_CHECK, the rest
 * counted) and the number of old failures that are not blamed.
 * @param {KindSummary[]} summaries every kind of the run
 * @param {{ baseWhy?: string }} [options] `baseWhy`: why the base could not be compared; the failures then may be older than the change
 * @returns {string} lines joined with line feeds; empty when no kind failed
 */
export function reasonOf(summaries, { baseWhy } = {}) {
  const failing = summaries.filter((summary) => summary.result === 'fail');
  if (failing.length === 0) return '';
  const lines = [`done-check: your change has failures${baseWhy ? '' : ' the base does not have'}. Fix them (or say why one is not yours), then stop again.`];
  for (const summary of failing) {
    lines.push(`${summary.kind}: ${summary.fresh.length} new`);
    for (const failure of summary.fresh.slice(0, MAX_REASON_LINES_PER_CHECK)) lines.push(`  ${failureLine(failure)}`);
    if (summary.fresh.length > MAX_REASON_LINES_PER_CHECK) lines.push(`  ... and ${summary.fresh.length - MAX_REASON_LINES_PER_CHECK} more`);
    if (summary.old.length > 0) lines.push(`  ${summary.old.length} old failures (also at the base, not yours)`);
  }
  if (baseWhy) lines.push(`The base was not compared (${baseWhy}): these failures may be older than your change.`);
  return lines.join('\n');
}
