// Purpose: read the review reports of the round before a fix round (`--prior`, one per report): each one's sha256, how many blocking
//   and should-fix findings it holds and their ids, so a file changed after the review is refused (its hash is not the one the lead
//   recorded, `--prior-sha256`), a reviewer can tell it reads that file, and a lead can tell no finding was taken out.
// Exports: MAX_PRIOR_BYTES, countFindings(text), readPrior(path, recordedSha256), readPriors(reports).
// Invariants: the file's text never leaves this module: only its path, hash, counts and finding ids do. Only a regular file is opened (a FIFO,
//   a device or a folder is refused before any read), and none over MAX_PRIOR_BYTES.
//   A finding is one line: a table row whose severity cell starts with the word (`| blocking |`, `| **should-fix** (not run on Linux) |`), or
//   a line with a severity tag (`[should-fix]`), the two forms the setup's reports use (review reports are tables, the review workflow
//   lists `- [severity] id file:line`). A row is read by its severity cell alone: the column the table's header names `severity` (a
//   table whose header names none holds no finding); in a table with no header, the row's first cell that starts with the word. A line counts once. Quoted lines (`>`), fenced blocks and code spans are skipped: they cite a
//   finding or the contract, they are none. Of a finding only its id leaves this module: a short plain word, or the line number.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { UsageError } from '../../git-tidy/lib/git.mjs';

export const MAX_PRIOR_BYTES = 4 << 20;
// The first word of a severity cell, after the bold, underscore or backtick marks around it; any text may follow in the cell.
const SEVERITY_WORD = /^[\s*_`]*(blocking|should[- ]fix)(?![a-z0-9-])/i;
const SEVERITY_TAG = /\[(blocking|should-fix)\]\s*(\S*)/i;
const SEVERITY_HEADER = /^[\s*_`]*severity[\s*_`]*$/i;
const SEPARATOR_ROW = /^\s*\|[\s|:-]+$/; // `|---|---|`: the row above it is the table's header
// Where a row's severity stands: the header's `severity` column, no column at all (a header without one: -1, the table holds no
// finding), or, in a table with no header, the first cell that starts with the word.
const ANY_CELL = null;
const CELL_BREAK = /(?<!\\)\|/; // `\|` is a pipe inside a cell
const FENCE = /^\s*(```|~~~)/;
const QUOTED_LINE = /^\s*>/;
const CODE_SPAN = /`[^`]*`/g;
// An id as it may be printed: a short word of letters, digits, `_`, `.` and `-` (B1, R2-1, sec.B3), so no text of the file reaches a brief.
const PLAIN_ID = /^[\s*_`]*([\w.-]{1,32})/;

// The word after a tag is the id only when the whole word is one (`B1`, `B1:`): `src/a.mjs:3` is a place, not an id.
const ID_AFTER_TAG = /^[\w.-]{1,32}[:,]?$/;

const severityOf = (word) => (word.toLowerCase() === 'blocking' ? 'blocking' : 'shouldFix');

/** The cells of a table row (a line that starts with `|`), without the empty ones outside the outer pipes; null for any other line. */
function cellsOf(line) {
  const row = line.trim();
  return row.startsWith('|') ? row.split(CELL_BREAK).slice(1, row.endsWith('|') ? -1 : undefined) : null;
}

/** The finding of a table row: `{severity, idText}` (the id is the row's first other cell), or null when its severity cell names none. */
function rowFinding(cells, severityColumn) {
  const at = severityColumn === ANY_CELL ? cells.findIndex((cell) => SEVERITY_WORD.test(cell)) : severityColumn;
  const word = SEVERITY_WORD.exec(cells[at] ?? '')?.[1];
  return word === undefined ? null : { severity: severityOf(word), idText: cells.find((_, index) => index !== at) ?? '' };
}

/** The finding of a line outside a table: `{severity, idText}` (the id is the word after the tag), or null without a tag outside code spans. */
function tagFinding(line) {
  const tag = SEVERITY_TAG.exec(line.replace(CODE_SPAN, ''));
  return tag === null ? null : { severity: severityOf(tag[1]), idText: ID_AFTER_TAG.test(tag[2]) ? tag[2] : '' };
}

/**
 * Counts the findings of a review report by severity and lists their ids.
 * @param {string} text the report
 * @returns {{blocking: number, shouldFix: number, findings: number, ids: string[]}} `findings` is the sum; `ids` has one entry per
 *   finding, in file order: its plain id, or `(line <n>)` when the line names none
 */
export function countFindings(text) {
  const counts = { blocking: 0, shouldFix: 0 };
  const ids = [];
  const lines = text.split('\n');
  let inFence = false;
  let inTable = false;
  let severityColumn = ANY_CELL;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) inFence = !inFence;
    const skipped = inFence || QUOTED_LINE.test(line);
    const cells = skipped ? null : cellsOf(line);
    const isHeader = cells !== null && !inTable && SEPARATOR_ROW.test(lines[index + 1] ?? '');
    if (cells !== null && !inTable) severityColumn = isHeader ? cells.findIndex((cell) => SEVERITY_HEADER.test(cell)) : ANY_CELL;
    inTable = cells !== null;
    if (skipped || isHeader) return;
    const finding = cells === null ? tagFinding(line) : rowFinding(cells, severityColumn);
    if (finding === null) return;
    counts[finding.severity] += 1;
    ids.push(PLAIN_ID.exec(finding.idText)?.[1] ?? `(line ${index + 1})`);
  });
  return { ...counts, findings: counts.blocking + counts.shouldFix, ids };
}

/**
 * Reads one review report of the round before a fix round and checks it is the file the lead recorded.
 * @param {string} path a plain absolute path (the CLI checks that before it calls)
 * @param {string} recordedSha256 the hash the lead recorded when the reviewer returned the report (lower-case hex)
 * @returns {{file: string, sha256: string, blocking: number, shouldFix: number, findings: number, ids: string[]}}
 * @throws {UsageError} when the path is no regular file, is over MAX_PRIOR_BYTES or cannot be read (the cause is in the message), and
 *   when its sha256 is not the recorded one: the file changed after the review
 */
export function readPrior(path, recordedSha256) {
  let bytes;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error('not a regular file');
    if (stats.size > MAX_PRIOR_BYTES) throw new Error(`over ${MAX_PRIOR_BYTES} bytes`);
    bytes = readFileSync(path);
  } catch (error) {
    throw new UsageError(`cannot read --prior ${path}: ${error.message}`);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== recordedSha256) throw new UsageError(`--prior ${path} is not the report that was recorded: its sha256 is ${sha256}, --prior-sha256 says ${recordedSha256}. The file changed after the review: take the report from its reviewer again, never from the fix's writer`);
  return { file: path, sha256, ...countFindings(bytes.toString('utf8')) };
}

/**
 * Reads every report of the round before (a landing set writes two: the reviewer's and the security auditor's).
 * @param {{path: string, sha256: string}[]} reports each path with its recorded hash, in the caller's order
 * @returns {{files: object[], blocking: number, shouldFix: number, findings: number}} `files`: readPrior of each; the counts are sums
 * @throws {UsageError} as readPrior, for the first report that fails
 */
export function readPriors(reports) {
  const files = reports.map(({ path, sha256 }) => readPrior(path, sha256));
  const sum = (key) => files.reduce((total, file) => total + file[key], 0);
  return { files, blocking: sum('blocking'), shouldFix: sum('shouldFix'), findings: sum('findings') };
}
