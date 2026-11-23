// The words of a done-check run: the one status line the owner sees and the reason text an agent gets when its stop is blocked (design 3.4, 3.5).
// Exports: lineOf(row, options) -> string, reasonOf(summaries, options) -> string, KindSummary (type).
// Invariants: the line is a function of the ledger row (plus optional extra notes), so `done-check last` prints exactly what the run
//   printed, minus the notes (details a row does not hold: which package did not run). A kind that did not run is never shown as ok; a
//   kind with new or unknown failures says FAIL (a failing test is never shown as ok); `tests-weakened` is shown only when it fails or a
//   false-alarm label let a find through (`n labelled`, never silent). A change of only unsupported code (`.py`, ...) is never `no code
//   change`: it says `not run (no python support: 3 files)`, and beside a checked change each such language is a `python not run` part. The
//   reason lists at most MAX_REASON_LINES_PER_CHECK failure lines per check and counts the rest; it holds tool text only after the parsers
//   cut it to one line.
import { CHECK_KINDS, MAX_REASON_LINES_PER_CHECK } from './contract.mjs';

const MS_PER_SECOND = 1000;
const WHOLE_SECONDS_FROM_MS = 10 * MS_PER_SECOND; // under this a time shows one decimal (`0.4 s`), from it whole seconds
const WEAKENED = 'tests-weakened';
// A reason the owner reads better in words than as its code; any other reason is shown as its code (`time`, `error`, ...).
const WHY_WORDS = Object.freeze({ 'go-not-installed': 'go: not installed', 'gofmt-not-installed': 'gofmt: not installed', 'no-support': 'no support' });
const whyWords = (why) => (Object.hasOwn(WHY_WORDS, why) ? WHY_WORDS[why] : why);

/**
 * What one check kind found, merged over its packages.
 * @typedef {object} KindSummary
 * @property {import('./contract.mjs').CheckKind} kind
 * @property {import('./contract.mjs').Result} result
 * @property {import('./contract.mjs').Failure[]} fresh failures the change caused (the base does not have them)
 * @property {import('./contract.mjs').Failure[]} old failures the base has too
 * @property {import('./contract.mjs').Failure[]} [unknown] with no base: test failures in files the change does not hold (never blamed)
 * @property {number} ms
 * @property {import('./contract.mjs').NotRunWhy} [why] set when the whole kind did not run
 */

const seconds = (ms) => `${(ms / MS_PER_SECOND).toFixed(ms < WHOLE_SECONDS_FROM_MS ? 1 : 0)} s`;
const oldNote = (check) => `${check.old > 0 ? `, ${check.old} old fail` : ''}${check.unknown > 0 ? `, ${check.unknown} unknown` : ''}${check.flaky > 0 ? `, ${check.flaky} flaky` : ''}${check.labelled > 0 ? `, ${check.labelled} labelled` : ''}`;

/** The weakened-test scan's part: shown when it fails or when a false-alarm label let one of its finds through, else null. */
function weakenedPart(check) {
  if (check.result === 'fail') return `${WEAKENED} FAIL ${check.new}${check.labelled > 0 ? `, ${check.labelled} labelled` : ''}`;
  return check.labelled > 0 ? `${WEAKENED} ok, ${check.labelled} labelled` : null;
}

/** The part of the line for one kind, or null when the kind says nothing worth a part (the weakened-test scan, unless it fails or a label passed a find). */
function partOf(kind, check, files) {
  if (kind === WEAKENED) return weakenedPart(check);
  if (check.result === 'fail') return `${kind} FAIL ${check.new} new${oldNote(check)}`;
  if (check.result === 'none') return `${kind} none related (${files} files)`;
  if (check.result === 'not-run') return `${kind} not run (${whyWords(check.why ?? 'error')})`;
  return `${kind} ok${oldNote(check)}`;
}

const kindParts = (row) => CHECK_KINDS.map((kind) => (row.checks[kind] ? partOf(kind, row.checks[kind], row.files) : null)).filter((part) => part !== null);
/** True when at least one check really ran and passed: only then is a reused run called ok. */
const somethingRan = (row) => Object.values(row.checks).some((check) => check.result === 'ok');

const unknownPart = (check) => (check.unknown > 0 ? ` new, ${check.unknown} unknown` : '');
const failingKinds = (row) => CHECK_KINDS.filter((kind) => row.checks[kind]?.result === 'fail').map((kind) => `${kind} ${row.checks[kind].new}${unknownPart(row.checks[kind])}`);

const fileCount = (files) => `${files} ${files === 1 ? 'file' : 'files'}`;
/** True for the row of a change that held only code of languages done-check has no checks for (check-change.mjs `noSupport`). */
const onlyUnsupported = (row) => Object.values(row.checks).some((check) => check.why === 'no-support');

/** `no python support: 3 files; no rust support: 1 file`; from the row alone (`done-check last`) `no support: 4 files`. */
function noSupportText(row, unsupported) {
  if (unsupported.length === 0) return `no support: ${fileCount(row.files)}`;
  return unsupported.map(({ language, files }) => `no ${language} support: ${fileCount(files)}`).join('; ');
}

/**
 * The one line for a run: `checks: types ok · tests ok, 1 old fail · python not run · 12 s · review: needed (security)`.
 * @param {import('./contract.mjs').RunRow} row the run row
 * @param {{ notes?: string[], tries?: number, unsupported?: { language: string, files: number }[] }} [options] `notes` are extra parts
 *   the row cannot hold (a package that did not run, a base that could not be compared); `tries` is the number of blocked stops that
 *   ended in `left open` (it adds the change-approach advice); `unsupported`: the changed files of languages done-check has no checks for
 *   (lib/scope.mjs unsupportedLanguages), each a `<language> not run` part, or the whole line when nothing else changed
 * @returns {string} the line, without a line feed
 */
export function lineOf(row, { notes = [], tries = 0, unsupported = [] } = {}) {
  const review = row.risk.length > 0 ? [`review: needed (${row.risk.join(', ')})`] : [];
  const languages = unsupported.map(({ language }) => `${language} not run`);
  if (row.verdict === 'skipped' && row.files > 0 && onlyUnsupported(row)) return [`checks: not run (${noSupportText(row, unsupported)})`, ...review].join(' · ');
  if (row.verdict === 'skipped') return [row.files === 0 ? 'checks: no code change' : 'checks: skipped by DONE_CHECK_SKIP=all', ...(row.files === 0 ? [] : languages), ...review].join(' · ');
  if (row.verdict === 'reused') return [`checks: reused (same change) ${somethingRan(row) ? 'ok' : kindParts(row).join(' · ')}`.trim(), ...languages, ...notes, ...review].join(' · ');
  if (row.verdict === 'left-open') {
    const advice = tries > 0 ? ` after ${tries} tries: change approach` : '';
    return [`checks: FAIL left open (${failingKinds(row).join(', ')})${advice}`, ...languages, ...notes, ...review].join(' · ');
  }
  const parts = kindParts(row);
  const base = row.base === null ? ['base: none'] : [];
  return `checks: ${[...parts, ...languages, ...notes, ...base, seconds(row.ms), ...review].join(' · ')}`;
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
    const unknown = summary.unknown?.length ?? 0;
    if (unknown > 0) lines.push(`  ${unknown} unknown failures (off your change, no base to compare: not blamed)`);
  }
  if (baseWhy) lines.push(`The base was not compared (${baseWhy}): these failures may be older than your change (failures off your change are not blamed).`);
  return lines.join('\n');
}
